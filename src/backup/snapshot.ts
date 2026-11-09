import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { childDirectory, fingerprint, newFile, openDirectory, openFile, smallFile, verifyDirectory, verifyFile,
  type Directory, type Guard } from "./capture-files";
import { decodeManifest } from "./decode";
import type { BackupManifest } from "./format";

export class BackupSnapshotError extends Error {
  constructor(readonly code = "invalid-snapshot") { super(`Invalid backup snapshot: ${code}`); }
}
function check(condition: boolean, code = "invalid-snapshot"): asserts condition { if (!condition) throw new BackupSnapshotError(code); }
export interface PayloadFile { readonly path: string; readonly byteLength: string; readonly sha256: string; readonly blob: string }
export interface SnapshotTree {
  readonly root: Directory;
  readonly directories: ReadonlyMap<string, Directory>;
  readonly files: readonly PayloadFile[];
  readonly manifest: BackupManifest;
  readonly manifestSha256: string;
  close(): Promise<void>;
}
export interface SnapshotLimits { readonly manifestBytes: number; readonly tableBytes?: number; readonly totalJsonBytes?: number }
const defaultLimits: SnapshotLimits = { manifestBytes: 16777216 };
const encoder = new TextEncoder();
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function within(value: string, limit: number): boolean {
  const maximum = String(limit); return value.length < maximum.length || (value.length === maximum.length && value <= maximum);
}
export function manifestFiles(bytes: Uint8Array, expectedSha?: string, limit = defaultLimits.manifestBytes):
  { digest: string; manifest: BackupManifest; files: Omit<PayloadFile,"blob">[] } {
  check(bytes.length <= limit && (expectedSha === undefined || /^[0-9a-f]{64}$/.test(expectedSha)));
  const digest = hash(bytes); check(expectedSha === undefined || digest === expectedSha);
  let manifest: BackupManifest;
  try { manifest = decodeManifest(bytes); } catch { throw new BackupSnapshotError(); }
  const files = [{ path: "manifest.json", byteLength: String(bytes.length), sha256: digest }, ...manifest.tables,
    ...(manifest.mediaMarker === null ? [] : [manifest.mediaMarker]), ...manifest.originals]
    .map(({path,byteLength,sha256}) => ({path,byteLength,sha256}));
  return { digest, manifest, files: files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
function budgets(manifest: BackupManifest, manifestLength: number, limits: SnapshotLimits): void {
  let total = BigInt(manifestLength);
  for (const entry of manifest.tables) {
    // Avoid converting arbitrary-length payload decimals to BigInt before establishing a physical bound.
    check(within(entry.byteLength,limits.tableBytes ?? Number.MAX_SAFE_INTEGER));
    total += BigInt(entry.byteLength);
  }
  check(limits.totalJsonBytes === undefined || total <= BigInt(limits.totalJsonBytes));
}
function split(path: string): { directory: string; name: string } {
  const at = path.lastIndexOf("/"); return at < 0 ? { directory: "", name: path } : { directory: path.slice(0,at), name: path.slice(at+1) };
}
export function payloadParent(tree: SnapshotTree, path: string): { parent: Directory; name: string } {
  const parts = split(path), parent = tree.directories.get(parts.directory);
  check(parent !== undefined); return { parent, name: parts.name };
}
export async function verifySnapshotMembership(tree: SnapshotTree, guard: Guard): Promise<void> {
  for (const [path,directory] of tree.directories) {
    const expected = new Set<string>();
    for (const child of tree.directories.keys()) if (child && split(child).directory === path) expected.add(split(child).name);
    for (const file of tree.files) if (split(file.path).directory === path) expected.add(split(file.path).name);
    for await (const entry of await opendir(directory.anchor)) {
      guard(); check(expected.delete(entry.name) && (entry.isDirectory() || entry.isFile()));
    }
    check(expected.size === 0); verifyDirectory(directory,true);
  }
}
/** SHA-256 and the auxiliary Git blob hash cover exactly the same stable read. No Git process/configuration is involved. */
async function fileDigests(parent: Directory, name: string, expected: { byteLength: string }, guard: Guard): Promise<Omit<PayloadFile,"path">> {
  guard(); const file = await openFile(parent,name);
  try {
    check(file.identity.size <= BigInt(Number.MAX_SAFE_INTEGER) && file.identity.size.toString() === expected.byteLength);
    const git = createHash("sha1").update(encoder.encode(`blob ${file.identity.size}\0`)), digest = createHash("sha256"), buffer = new Uint8Array(65536);
    for (let offset = 0; offset < Number(file.identity.size);) {
      guard(); const result = await file.handle.read(buffer,0,Math.min(buffer.length,Number(file.identity.size)-offset),offset);
      check(result.bytesRead > 0); const bytes = buffer.subarray(0,result.bytesRead);
      digest.update(bytes); git.update(bytes); offset += result.bytesRead;
    }
    verifyFile(parent,name,file); guard(); return { byteLength: expected.byteLength, sha256: digest.digest("hex"), blob: git.digest("hex") };
  } finally { await file.handle.close(); }
}
export async function inspectSnapshot(path: string, expectedSha: string | undefined, guard: Guard, limits: SnapshotLimits = defaultLimits): Promise<SnapshotTree> {
  guard(); const root = await openDirectory(path), directories = new Map<string,Directory>([["",root]]);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    const results = await Promise.allSettled([...directories.values()].reverse().map(directory => directory.handle.close()));
    check(results.every(result => result.status === "fulfilled"),"storage-failed");
  };
  try {
    const bytes = await smallFile(root,"manifest.json",limits.manifestBytes), parsed = manifestFiles(bytes,expectedSha,limits.manifestBytes);
    budgets(parsed.manifest,bytes.length,limits); guard();
    directories.set("tables",await childDirectory(root,"tables"));
    if (parsed.manifest.mediaMarker !== null) directories.set("media",await childDirectory(root,"media"));
    if (parsed.manifest.originals.length) {
      const media = directories.get("media"); check(media !== undefined);
      directories.set("media/objects",await childDirectory(media,"objects"));
    }
    const tree: SnapshotTree = { root, directories, files: parsed.files.map(file => ({...file,blob:""})), manifest: parsed.manifest,
      manifestSha256: parsed.digest, close };
    await verifySnapshotMembership(tree,guard);
    const files: PayloadFile[] = [];
    for (const entry of parsed.files) {
      const from = payloadParent(tree,entry.path), actual = await fileDigests(from.parent,from.name,entry,guard);
      check(actual.sha256 === entry.sha256); files.push({path:entry.path,...actual});
    }
    const verified: SnapshotTree = {...tree,files};
    await verifySnapshotMembership(verified,guard); guard(); return verified;
  } catch (error) { await close(); throw error; }
}
/** Decode only bytes hashed on this read, not a previously inspected pathname. */
export async function readSnapshotFile(tree: SnapshotTree, entry: {path:string;byteLength:string;sha256:string}, limit: number, guard: Guard): Promise<Uint8Array> {
  check(within(entry.byteLength,limit)); guard(); const from = payloadParent(tree,entry.path), file = await openFile(from.parent,from.name);
  try {
    check(file.identity.size.toString() === entry.byteLength);
    const bytes = new Uint8Array(Number(entry.byteLength));
    for (let offset = 0; offset < bytes.length;) {
      guard(); const read = await file.handle.read(bytes,offset,Math.min(65536,bytes.length-offset),offset);
      check(read.bytesRead > 0); offset += read.bytesRead;
    }
    verifyFile(from.parent,from.name,file); check(hash(bytes) === entry.sha256); guard(); return bytes;
  } finally { await file.handle.close(); }
}
/** New destination only, with verified streaming copies rather than links/filter conversion. */
export async function copySnapshot(source: SnapshotTree, target: Directory, guard: Guard): Promise<void> {
  const directories = new Map<string,Directory>([["",target]]);
  try {
    for (const path of source.directories.keys()) if (path) {
      const parts = split(path), parent = directories.get(parts.directory); check(parent !== undefined);
      directories.set(path,await childDirectory(parent,parts.name,true));
    }
    for (const entry of source.files) {
      guard(); const from = payloadParent(source,entry.path), parts = split(entry.path), parent = directories.get(parts.directory); check(parent !== undefined);
      const file = await newFile(parent,parts.name);
      try {
        const actual = await fingerprint(from.parent,from.name,guard,file);
        check(actual.sha256 === entry.sha256 && actual.byteLength === entry.byteLength);
        verifyFile(parent,parts.name,file,false);
      } finally { await file.handle.close(); }
    }
    for (const directory of [...directories.values()].reverse()) await directory.handle.sync();
    for (const directory of source.directories.values()) verifyDirectory(directory,true);
  } finally { await Promise.allSettled([...directories.entries()].filter(([path]) => path !== "").map(([,directory]) => directory.handle.close())); }
}
