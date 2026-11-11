import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, type BigIntStats } from "node:fs";
import { open, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { dlopen } from "bun:ffi";
import { absent, canonical, fingerprint, openDirectory, openFile, owned, sameInode, smallFile, unchanged, verifyDirectory, verifyFile, writeFile, type Directory, type Guard } from "./capture-files";
import { BackupGitError, digestPattern, oidPattern, requireGit } from "./git-common";
import { object } from "./git-payload";
import type { BackupCheckoutLease } from "./git-lock";

export type PendingUpdate = { readonly kind: "update"; readonly beforeHead: string | null; readonly beforeManifest: string | null; readonly afterManifest: string }
  | { readonly kind: "adopt"; readonly head: string; readonly manifest: string };
export interface CheckoutState {
  readonly version: 1;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly dev: string;
  readonly ino: string;
  readonly configSha256: string | null;
  readonly head: string | null;
  readonly manifest: string | null;
  readonly pending: PendingUpdate | null;
}
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
export const attributes = encoder.encode("** -filter -text -ident -working-tree-encoding -crlf\n");
const stateKeys = ["version", "repositoryUrl", "branch", "dev", "ino", "configSha256", "head", "manifest", "pending"];
function nullable(value: unknown, pattern: RegExp): string | null {
  requireGit(value === null || (typeof value === "string" && pattern.test(value)), "invalid-checkout-record"); return value;
}
function parseState(bytes: Uint8Array): CheckoutState {
  const value: unknown = JSON.parse(decoder.decode(bytes)), raw = object(value, stateKeys);
  requireGit(raw.version === 1 && typeof raw.repositoryUrl === "string" && typeof raw.branch === "string" &&
    typeof raw.dev === "string" && /^[0-9]+$/.test(raw.dev) && typeof raw.ino === "string" && /^[0-9]+$/.test(raw.ino), "invalid-checkout-record");
  let pending: PendingUpdate | null = null;
  if (raw.pending !== null) {
    requireGit(typeof raw.pending === "object" && raw.pending !== null && "kind" in raw.pending, "invalid-checkout-record");
    if (raw.pending.kind === "update") {
      const update = object(raw.pending, ["kind", "beforeHead", "beforeManifest", "afterManifest"]);
      const afterManifest = nullable(update.afterManifest, digestPattern); requireGit(afterManifest !== null, "invalid-checkout-record");
      pending = { kind: "update", beforeHead: nullable(update.beforeHead, oidPattern), beforeManifest: nullable(update.beforeManifest, digestPattern), afterManifest };
      requireGit((pending.beforeHead === null) === (pending.beforeManifest === null), "invalid-checkout-record");
    } else {
      const adoption = object(raw.pending, ["kind", "head", "manifest"]);
      const head = nullable(adoption.head, oidPattern), manifest = nullable(adoption.manifest, digestPattern);
      requireGit(adoption.kind === "adopt" && head !== null && manifest !== null, "invalid-checkout-record"); pending = { kind: "adopt", head, manifest };
    }
  }
  const state: CheckoutState = { version: 1, repositoryUrl: raw.repositoryUrl, branch: raw.branch, dev: raw.dev, ino: raw.ino,
    configSha256: nullable(raw.configSha256, digestPattern), head: nullable(raw.head, oidPattern), manifest: nullable(raw.manifest, digestPattern), pending };
  requireGit((state.head === null) === (state.manifest === null) && (state.configSha256 !== null || (state.head === null && state.pending === null)), "invalid-checkout-record");
  if (pending?.kind === "update") requireGit(pending.beforeHead === state.head && pending.beforeManifest === state.manifest, "invalid-checkout-record");
  if (pending?.kind === "adopt") requireGit(state.head === null, "invalid-checkout-record");
  requireGit(Buffer.from(bytes).equals(Buffer.from(encoder.encode(`${JSON.stringify(state)}\n`))), "invalid-checkout-record"); return state;
}

/** Atomic bounded bookkeeping; no payload or host credential is written here. */
export class CheckoutRecord {
  private constructor(readonly lease: BackupCheckoutLease, public value: CheckoutState | null, private hash: string | null) {}
  static async load(lease: BackupCheckoutLease): Promise<CheckoutRecord> {
    try {
      const bytes = await smallFile(lease.control, "state.json", 32768);
      let value: CheckoutState;
      try { value = parseState(bytes); } catch { throw new BackupGitError("invalid-checkout-record"); }
      requireGit(value.repositoryUrl === lease.repositoryUrl && value.branch === lease.branch, "checkout-binding-conflict");
      return new CheckoutRecord(lease, value, createHash("sha256").update(bytes).digest("hex"));
    } catch (error) { if (absent(error)) return new CheckoutRecord(lease, null, null); throw error; }
  }
  async save(value: CheckoutState, guard: Guard): Promise<void> {
    guard(); verifyDirectory(this.lease.control);
    if (this.hash !== null) requireGit((await fingerprint(this.lease.control, "state.json", guard)).sha256 === this.hash, "checkout-record-changed");
    else { try { lstatSync(join(this.lease.control.anchor, "state.json")); throw new BackupGitError("checkout-record-changed"); } catch (error) { if (!absent(error)) throw error; } }
    const bytes = encoder.encode(`${JSON.stringify(value)}\n`), temporary = `.state-${randomUUID()}`;
    requireGit(bytes.length <= 32768, "invalid-checkout-record");
    await writeFile(this.lease.control, temporary, bytes, guard); guard();
    requireGit((await fingerprint(this.lease.control, temporary, guard)).sha256 === createHash("sha256").update(bytes).digest("hex"), "checkout-record-changed");
    if (this.hash !== null) requireGit((await fingerprint(this.lease.control, "state.json", guard)).sha256 === this.hash, "checkout-record-changed");
    guard();
    if (this.hash === null) moveEntry(this.lease.control, temporary, this.lease.control, "state.json");
    else await rename(join(this.lease.control.anchor, temporary), join(this.lease.control.anchor, "state.json"));
    await this.lease.control.handle.sync(); this.value = value; this.hash = createHash("sha256").update(bytes).digest("hex");
  }
}

export async function rootEntries(root: Directory, expected: readonly string[], guard: Guard): Promise<void> {
  verifyDirectory(root);
  const remaining = new Set(expected);
  for await (const entry of await opendir(root.anchor)) { guard(); requireGit(remaining.delete(entry.name) && entry.isDirectory(), "dirty-checkout"); }
  requireGit(remaining.size === 0, "dirty-checkout");
}
const forbiddenMetadata = new Set(["commondir", "gitdir", "worktrees", "shallow", "info/grafts", "info/exclude", "objects/info/alternates", "objects/info/http-alternates"]);
/** Git metadata may have normal 0644/0755 modes beneath the private checkout, but never links or shared objects. */
export async function auditMetadata(root: Directory, guard: Guard): Promise<void> {
  async function walk(path: string, relative: string): Promise<void> {
    guard(); await canonical(path);
    const before = lstatSync(path, { bigint: true }); owned(before, true, false);
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      requireGit(sameInode(before, await directory.stat({ bigint: true })));
      for await (const entry of await opendir(`/proc/self/fd/${directory.fd}`)) {
        guard(); const rel = relative ? `${relative}/${entry.name}` : entry.name, child = join(path, entry.name);
        requireGit(!forbiddenMetadata.has(rel) && !entry.name.endsWith(".lock"), "unsafe-git-metadata");
        const info = lstatSync(child, { bigint: true });
        if (info.isDirectory()) await walk(child, rel); else owned(info, false, false);
      }
      requireGit(sameInode(before, lstatSync(path, { bigint: true })));
    } finally { await directory.close(); }
  }
  verifyDirectory(root); await walk(join(root.path, ".git"), ""); verifyDirectory(root);
}
export async function verifyMetadata(root: Directory, state: CheckoutState, guard: Guard): Promise<void> {
  await auditMetadata(root, guard);
  const git = await openDirectory(join(root.path, ".git"), false);
  let info: Directory | undefined;
  try {
    requireGit(state.configSha256 !== null && (await fingerprint(git, "config", guard)).sha256 === state.configSha256, "checkout-config-changed");
    const head = await smallFile(git, "HEAD", 4096);
    requireGit(decoder.decode(head) === `ref: refs/heads/${state.branch}\n`, "checkout-branch-changed");
    info = await openDirectory(join(git.path, "info"), false);
    requireGit(Buffer.from(await smallFile(info, "attributes", 4096)).equals(Buffer.from(attributes)), "unsafe-git-metadata");
  } finally { await Promise.allSettled([info?.handle.close(), git.handle.close()]); }
}

export function moveEntry(from: Directory, source: string, to: Directory, target: string): void {
  verifyDirectory(from); verifyDirectory(to);
  const library = dlopen("libc.so.6", { renameat2: { args: ["int", "cstring", "int", "cstring", "uint32_t"], returns: "int" } });
  try { requireGit(library.symbols.renameat2(from.handle.fd, Buffer.from(`${source}\0`), to.handle.fd, Buffer.from(`${target}\0`), 1) === 0, "workspace-conflict"); }
  finally { library.close(); }
}

/** Only used for a newly initialized repository's verified remote tree, never to tidy an existing dirty checkout. */
export async function privateMaterializedTree(root: string, paths: readonly { path: string; byteLength: string; sha256: string }[], guard: Guard): Promise<void> {
  const directories = new Map<string, Directory>(), identities = new Map<string, BigIntStats>();
  const split = (path: string) => { const at = path.lastIndexOf("/"); return { parent: at < 0 ? "" : path.slice(0, at), name: path.slice(at + 1) }; };
  try {
    directories.set("", await openDirectory(root, false));
    for (const entry of paths) {
      const parts = entry.path.split("/"); let relative = "";
      for (const part of parts.slice(0, -1)) {
        relative = relative ? `${relative}/${part}` : part;
        if (!directories.has(relative)) directories.set(relative, await openDirectory(join(root, relative), false));
      }
    }
    for (const [path, directory] of directories) {
      const expected = new Map<string, boolean>();
      for (const child of directories.keys()) if (child && split(child).parent === path) expected.set(split(child).name, true);
      for (const entry of paths) if (split(entry.path).parent === path) expected.set(split(entry.path).name, false);
      for await (const entry of await opendir(directory.anchor)) {
        guard(); const type = expected.get(entry.name);
        requireGit(type !== undefined && (type ? entry.isDirectory() : entry.isFile()), "dirty-checkout"); expected.delete(entry.name);
      }
      requireGit(expected.size === 0, "dirty-checkout");
    }
    for (const entry of paths) {
      const parts = split(entry.path), parent = directories.get(parts.parent); requireGit(parent !== undefined);
      const file = await openFile(parent, parts.name, false);
      try {
        requireGit(file.identity.size.toString() === entry.byteLength && file.identity.size <= BigInt(Number.MAX_SAFE_INTEGER), "dirty-checkout");
        const hash = createHash("sha256"), buffer = new Uint8Array(65536);
        for (let offset = 0; offset < Number(file.identity.size);) {
          guard(); const result = await file.handle.read(buffer, 0, Math.min(buffer.length, Number(file.identity.size) - offset), offset);
          requireGit(result.bytesRead > 0, "dirty-checkout"); hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
        }
        verifyFile(parent, parts.name, file, true, false); requireGit(hash.digest("hex") === entry.sha256, "dirty-checkout"); identities.set(entry.path, file.identity);
      } finally { await file.handle.close(); }
    }
    // No permission repair until every path and byte belongs to the recorded remote snapshot.
    for (const directory of directories.values()) verifyDirectory(directory, true);
    for (const directory of directories.values()) { guard(); await directory.handle.chmod(0o700); }
    for (const entry of paths) {
      const parts = split(entry.path), parent = directories.get(parts.parent), identity = identities.get(entry.path); requireGit(parent !== undefined && identity !== undefined);
      const file = await openFile(parent, parts.name, false);
      try { requireGit(unchanged(identity, file.identity), "dirty-checkout"); await file.handle.chmod(0o600); await file.handle.sync(); verifyFile(parent, parts.name, file, false, false); }
      finally { await file.handle.close(); }
    }
    for (const directory of [...directories.values()].reverse()) await directory.handle.sync();
  } finally { await Promise.allSettled([...directories.values()].map(directory => directory.handle.close())); }
}

export async function removeVerifiedDirectory(directory: Directory): Promise<void> {
  verifyDirectory(directory, true); await rm(directory.path, { recursive: true, force: false });
}

export async function makeGitConfigPrivate(root: Directory): Promise<void> {
  // The initialization operation owns these newly generated files, before any remote data is admitted.
  verifyDirectory(root); const git = await openDirectory(join(root.path, ".git"), false);
  try {
    await git.handle.chmod(0o700);
    for (const name of ["HEAD", "config"]) {
      const file = await openFile(git, name, false);
      try { verifyFile(git, name, file, true, false); await file.handle.chmod(0o600); await file.handle.sync(); verifyFile(git, name, file, false); }
      finally { await file.handle.close(); }
    }
    await git.handle.sync(); verifyDirectory(git); verifyDirectory(root);
  } finally { await git.handle.close(); }
}
