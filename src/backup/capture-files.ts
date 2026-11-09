import { constants, fstatSync, lstatSync, type BigIntStats } from "node:fs";
import { mkdir, open, opendir, realpath, rm, rmdir, statfs, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { dlopen } from "bun:ffi";

export class BackupCaptureError extends Error {
  constructor(readonly code = "capture-failed") { super(`Backup capture failed: ${code}`); }
}
export const workerFailureCodes: ReadonlySet<string> = new Set(["wal-required", "restore-in-progress", "source-replaced", "unsupported-schema", "inconsistent-source",
  "invalid-storage-class", "original-unavailable", "store-identity-conflict", "unsafe-path", "unsupported-storage", "storage-failed", "capture-failed"]);
export type Guard = () => void;
export interface Directory {
  readonly path: string;
  readonly anchor: string;
  readonly handle: FileHandle;
  readonly identity: BigIntStats;
  readonly private: boolean;
}
export interface File { readonly handle: FileHandle; readonly identity: BigIntStats }
const localFilesystems = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1, 0xf2f52010]);
export const sameInode = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
export const unchanged = (a: BigIntStats, b: BigIntStats): boolean => sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export const absent = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export function check(condition: boolean, code = "invalid-source"): asserts condition {
  if (!condition) throw new BackupCaptureError(code);
}
export function name(value: string): string {
  check(typeof value === "string" && /^[a-zA-Z0-9_.-]+$/.test(value) && value !== "." && value !== "..", "unsafe-path");
  return value;
}
export function owned(info: BigIntStats, directory: boolean, privateMode = true): void {
  check(info.uid === BigInt(process.getuid?.() ?? -1) && (directory ? info.isDirectory() : info.isFile()) &&
    (privateMode ? (info.mode & 0o7777n) === (directory ? 0o700n : 0o600n) : (info.mode & 0o022n) === 0n) &&
    (directory || info.nlink === 1n), "unsafe-path");
}
export async function canonical(path: string): Promise<string> {
  check(process.platform === "linux" && typeof path === "string" && isAbsolute(path) && !path.includes("\0") && resolve(path) === path, "unsafe-path");
  check(await realpath(path) === path, "unsafe-path");
  return path;
}
export function outsideGit(path: string): void {
  for (let current = path;; current = dirname(current)) {
    try { lstatSync(join(current, ".git")); }
    catch (error) { if (absent(error)) { if (current === dirname(current)) return; continue; } throw error; }
    throw new BackupCaptureError("unsafe-output");
  }
}
async function directory(path: string, openedPath: string, privateMode: boolean): Promise<Directory> {
  const before = lstatSync(openedPath, { bigint: true }); owned(before, true, privateMode);
  const handle = await open(openedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat({ bigint: true }); owned(identity, true, privateMode);
    check(sameInode(before, identity), "unsafe-path");
    const anchor = `/proc/self/fd/${handle.fd}`;
    check(localFilesystems.has(Number((await statfs(anchor, { bigint: true })).type & 0xffffffffn)), "unsupported-storage");
    const result = { path, anchor, handle, identity, private: privateMode };
    verifyDirectory(result);
    return result;
  } catch (error) { await handle.close(); throw error; }
}
export async function openDirectory(path: string, privateMode = true): Promise<Directory> {
  await canonical(path);
  return directory(path, path, privateMode);
}
export async function childDirectory(parent: Directory, child: string, create = false): Promise<Directory> {
  verifyDirectory(parent); name(child);
  const path = `${parent.anchor}/${child}`;
  if (create) await mkdir(path, { mode: 0o700 });
  const created = create ? lstatSync(path, { bigint: true }) : undefined;
  try { return await directory(join(parent.path, child), path, true); }
  catch (error) {
    // Only remove our still-empty, same-inode creation. Never recursively clean an unacquired directory.
    if (created) try { verifyDirectory(parent); if (sameInode(created, lstatSync(path, { bigint: true }))) await rmdir(path); } catch { /* Ambiguous entries stay untouched. */ }
    throw error;
  }
}
export function verifyDirectory(value: Directory, stable = false): void {
  const held = fstatSync(value.handle.fd, { bigint: true }), current = lstatSync(value.path, { bigint: true });
  owned(held, true, value.private); owned(current, true, value.private);
  check(sameInode(held, value.identity) && sameInode(held, current) && (!stable || unchanged(held, value.identity)), "unsafe-path");
}
export function verifyFile(parent: Directory, child: string, file: File, stable = true, privateMode = true): BigIntStats {
  verifyDirectory(parent);
  const held = fstatSync(file.handle.fd, { bigint: true }), current = lstatSync(`${parent.anchor}/${name(child)}`, { bigint: true });
  owned(held, false, privateMode); owned(current, false, privateMode);
  check(sameInode(held, file.identity) && sameInode(held, current) && (!stable || unchanged(held, file.identity)), "unsafe-path");
  return held;
}
export async function openFile(parent: Directory, child: string, privateMode = true): Promise<File> {
  verifyDirectory(parent); name(child);
  const before = lstatSync(`${parent.anchor}/${child}`, { bigint: true }); owned(before, false, privateMode);
  const handle = await open(`${parent.anchor}/${child}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const identity = await handle.stat({ bigint: true }); owned(identity, false, privateMode);
    check(unchanged(before, identity), "unsafe-path");
    const file = { handle, identity }; verifyFile(parent, child, file, true, privateMode); return file;
  } catch (error) { await handle.close(); throw error; }
}
export async function newFile(parent: Directory, child: string): Promise<File> {
  verifyDirectory(parent); name(child);
  const handle = await open(`${parent.anchor}/${child}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { const file = { handle, identity: await handle.stat({ bigint: true }) }; verifyFile(parent, child, file); return file; }
  catch (error) { await handle.close(); throw error; }
}
export async function writeFile(parent: Directory, child: string, bytes: Uint8Array, guard: Guard): Promise<void> {
  guard(); const file = await newFile(parent, child);
  try {
    for (let offset = 0; offset < bytes.length;) {
      guard(); const result = await file.handle.write(bytes, offset, bytes.length - offset, offset);
      check(result.bytesWritten > 0, "storage-failed"); offset += result.bytesWritten;
    }
    await file.handle.sync(); verifyFile(parent, child, file, false); guard();
  } finally { await file.handle.close(); }
}
export async function smallFile(parent: Directory, child: string, limit: number): Promise<Uint8Array> {
  const file = await openFile(parent, child);
  try {
    check(file.identity.size > 0n && file.identity.size <= BigInt(limit), "invalid-control-file");
    const bytes = new Uint8Array(Number(file.identity.size));
    for (let offset = 0; offset < bytes.length;) {
      const result = await file.handle.read(bytes, offset, bytes.length - offset, offset);
      check(result.bytesRead > 0); offset += result.bytesRead;
    }
    verifyFile(parent, child, file); return bytes;
  } finally { await file.handle.close(); }
}
/** Streaming verification/copy uses one 64KiB buffer, independent of the current upload limit. */
export async function fingerprint(parent: Directory, child: string, guard: Guard, target?: File): Promise<{ byteLength: string; sha256: string }> {
  guard(); const file = await openFile(parent, child);
  try {
    check(file.identity.size <= BigInt(Number.MAX_SAFE_INTEGER));
    const hash = createHash("sha256"), bytes = new Uint8Array(65536), length = Number(file.identity.size);
    for (let position = 0; position < length;) {
      guard(); const result = await file.handle.read(bytes, 0, Math.min(bytes.length, length - position), position);
      check(result.bytesRead > 0, "original-unavailable");
      hash.update(bytes.subarray(0, result.bytesRead));
      if (target) for (let offset = 0; offset < result.bytesRead;) {
        const written = await target.handle.write(bytes, offset, result.bytesRead - offset, position + offset);
        check(written.bytesWritten > 0, "storage-failed"); offset += written.bytesWritten;
      }
      position += result.bytesRead;
    }
    verifyFile(parent, child, file); guard();
    if (target) await target.handle.sync();
    return { byteLength: file.identity.size.toString(), sha256: hash.digest("hex") };
  } finally { await file.handle.close(); }
}
export async function empty(parent: Directory): Promise<boolean> {
  verifyDirectory(parent); const reader = await opendir(parent.anchor);
  try { return await reader.read() === null; } finally { await reader.close(); }
}
export async function equalTrees(left: Directory, right: Directory, guard: Guard): Promise<void> {
  guard(); verifyDirectory(left, true); verifyDirectory(right, true);
  let count = 0;
  const reader = await opendir(left.anchor);
  try {
    for await (const entry of reader) {
      guard(); name(entry.name); count++;
      if (entry.isDirectory()) {
        const a = await childDirectory(left, entry.name); let b: Directory | undefined;
        try { b = await childDirectory(right, entry.name); await equalTrees(a, b, guard); }
        finally { await Promise.allSettled([a.handle.close(), b?.handle.close()]); }
      } else {
        check(entry.isFile(), "unsafe-path");
        const a = await fingerprint(left, entry.name, guard), b = await fingerprint(right, entry.name, guard);
        check(a.byteLength === b.byteLength && a.sha256 === b.sha256, "snapshot-conflict");
      }
    }
  } finally { /* for-await closes the directory, including on failure. */ }
  let other = 0;
  for await (const entry of await opendir(right.anchor)) { guard(); name(entry.name); other++; }
  check(count === other, "snapshot-conflict"); verifyDirectory(left, true); verifyDirectory(right, true);
}
/** Linux's no-replace rename is the commit point; plain rename could replace a caller-owned empty directory. */
export function publish(work: Directory, output: Directory, destination: string): boolean {
  verifyDirectory(work); verifyDirectory(output); name(destination);
  try {
    const library = dlopen("libc.so.6", { renameat2: { args: ["int", "cstring", "int", "cstring", "uint32_t"], returns: "int" } });
    try { return library.symbols.renameat2(work.handle.fd, Buffer.from("snapshot\0"), output.handle.fd, Buffer.from(`${destination}\0`), 1) === 0; }
    finally { library.close(); }
  } catch { throw new BackupCaptureError("unsupported-storage"); }
}
export async function removeWork(work: Directory): Promise<void> {
  verifyDirectory(work);
  check(/^\.capture-[0-9a-f-]{36}$/.test(basename(work.path)), "unsafe-path");
  await rm(work.path, { recursive: true, force: false });
}
export function sourceGuard(path: string, dev: string, ino: string, guard: Guard): Guard {
  return () => {
    guard(); const info = lstatSync(path, { bigint: true }); owned(info, false, false);
    check(info.dev.toString() === dev && info.ino.toString() === ino, "source-replaced");
    try { lstatSync(join(dirname(path), ".restore-in-progress")); }
    catch (error) { if (absent(error)) return; throw error; }
    throw new BackupCaptureError("restore-in-progress");
  };
}
