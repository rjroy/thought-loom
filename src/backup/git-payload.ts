import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { childDirectory, fingerprint, newFile, openDirectory, openFile, smallFile, verifyDirectory, verifyFile,
  type Directory, type Guard } from "./capture-files";
import { encodeManifest, type BackupManifest } from "./format";
import { backupTableShapes } from "./schema";
import { digestPattern, gitBudgets, requireGit } from "./git-common";

export interface PayloadFile { readonly path: string; readonly byteLength: string; readonly sha256: string; readonly blob: string }
export interface SnapshotTree {
  readonly root: Directory;
  readonly directories: ReadonlyMap<string, Directory>;
  readonly files: readonly PayloadFile[];
  readonly manifestSha256: string;
  close(): Promise<void>;
}
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireGit(isObject(value), "invalid-snapshot");
  requireGit(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "invalid-snapshot");
  return value;
}
function string(value: unknown): string { requireGit(typeof value === "string", "invalid-snapshot"); return value; }
function array(value: unknown): unknown[] { requireGit(Array.isArray(value), "invalid-snapshot"); return value; }
function fileMetadata(value: unknown): { path: string; byteLength: string; sha256: string } {
  const entry = object(value, ["path", "byteLength", "sha256"]);
  return { path: string(entry.path), byteLength: string(entry.byteLength), sha256: string(entry.sha256) };
}

/** Only the manifest is decoded here. Capture validates source records; offline loading has its own future boundary. */
export function manifestFiles(bytes: Uint8Array, expectedSha?: string): { digest: string; files: Omit<PayloadFile, "blob">[] } {
  const digest = createHash("sha256").update(bytes).digest("hex");
  requireGit(bytes.length <= gitBudgets.manifestBytes && (expectedSha === undefined || digest === expectedSha), "invalid-snapshot");
  const parsed: unknown = JSON.parse(decoder.decode(bytes));
  const root = object(parsed, ["appSchema", "format", "mediaMarker", "mediaStoreId", "originals", "sequences", "tables", "version"]);
  requireGit(root.appSchema === "thoughtloom-logical-1" && root.format === "thoughtloom-backup" && root.version === 1, "invalid-snapshot");
  const tables = array(root.tables).map(value => {
    const entry = object(value, ["name", "path", "rowCount", "byteLength", "sha256"]);
    return { name: string(entry.name), path: string(entry.path), rowCount: string(entry.rowCount), byteLength: string(entry.byteLength), sha256: string(entry.sha256) };
  });
  requireGit(tables.length === backupTableShapes.length && tables.every((table, index) => table.name === backupTableShapes[index].name), "invalid-snapshot");
  const originals = array(root.originals).map(value => {
    const entry = object(value, ["sourceId", "path", "byteLength", "sha256"]);
    return { sourceId: string(entry.sourceId), path: string(entry.path), byteLength: string(entry.byteLength), sha256: string(entry.sha256) };
  });
  const sequences = array(root.sequences).map(value => {
    const entry = object(value, ["name", "value"]), cell = object(entry.value, ["$integer"]), raw = string(cell.$integer);
    requireGit(/^(0|[1-9][0-9]*)$/.test(raw) && raw.length <= 19, "invalid-snapshot");
    return { name: string(entry.name), value: BigInt(raw) };
  });
  const manifest: BackupManifest = { tables, originals, sequences, mediaStoreId: root.mediaStoreId === null ? null : string(root.mediaStoreId),
    mediaMarker: root.mediaMarker === null ? null : fileMetadata(root.mediaMarker) };
  requireGit(Buffer.from(encodeManifest(manifest)).equals(Buffer.from(bytes)), "invalid-snapshot");
  const files = [{ path: "manifest.json", byteLength: String(bytes.length), sha256: digest }, ...tables,
    ...(manifest.mediaMarker === null ? [] : [manifest.mediaMarker]), ...originals].map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256 }));
  return { digest, files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}

/** Both hashes cover the same stable read: a later second pass must not authorize different Git bytes. */
async function fileDigests(parent: Directory, name: string, guard: Guard): Promise<Omit<PayloadFile, "path">> {
  guard(); const file = await openFile(parent, name);
  try {
    requireGit(file.identity.size <= BigInt(Number.MAX_SAFE_INTEGER), "invalid-snapshot");
    const git = createHash("sha1").update(encoder.encode(`blob ${file.identity.size}\0`)), hash = createHash("sha256"), buffer = new Uint8Array(65536);
    for (let offset = 0; offset < Number(file.identity.size);) {
      guard(); const result = await file.handle.read(buffer, 0, Math.min(buffer.length, Number(file.identity.size) - offset), offset);
      requireGit(result.bytesRead > 0, "invalid-snapshot"); const bytes = buffer.subarray(0, result.bytesRead);
      hash.update(bytes); git.update(bytes); offset += result.bytesRead;
    }
    verifyFile(parent, name, file); guard(); return { byteLength: file.identity.size.toString(), sha256: hash.digest("hex"), blob: git.digest("hex") };
  } finally { await file.handle.close(); }
}
function split(path: string): { directory: string; name: string } {
  const at = path.lastIndexOf("/"); return at < 0 ? { directory: "", name: path } : { directory: path.slice(0, at), name: path.slice(at + 1) };
}
export function payloadParent(tree: SnapshotTree, path: string): { parent: Directory; name: string } {
  const parts = split(path), parent = tree.directories.get(parts.directory);
  requireGit(parent !== undefined, "invalid-snapshot"); return { parent, name: parts.name };
}
async function membership(directories: ReadonlyMap<string, Directory>, files: readonly { path: string }[], guard: Guard): Promise<void> {
  for (const [path, directory] of directories) {
    const expected = new Set<string>();
    for (const child of directories.keys()) if (child && split(child).directory === path) expected.add(split(child).name);
    for (const file of files) if (split(file.path).directory === path) expected.add(split(file.path).name);
    for await (const entry of await opendir(directory.anchor)) {
      guard(); requireGit(expected.delete(entry.name) && (entry.isDirectory() || entry.isFile()), "invalid-snapshot");
    }
    requireGit(expected.size === 0, "invalid-snapshot"); verifyDirectory(directory, true);
  }
}

export async function inspectSnapshot(path: string, expectedSha: string | undefined, guard: Guard): Promise<SnapshotTree> {
  if (expectedSha !== undefined) requireGit(digestPattern.test(expectedSha), "invalid-snapshot");
  guard(); const root = await openDirectory(path), directories = new Map<string, Directory>([["", root]]);
  const close = async () => { const results = await Promise.allSettled([...directories.values()].reverse().map(directory => directory.handle.close()));
    requireGit(results.every(result => result.status === "fulfilled"), "storage-failed"); };
  try {
    const bytes = await smallFile(root, "manifest.json", gitBudgets.manifestBytes), manifest = manifestFiles(bytes, expectedSha);
    directories.set("tables", await childDirectory(root, "tables"));
    if (manifest.files.some(file => file.path.startsWith("media/"))) directories.set("media", await childDirectory(root, "media"));
    if (manifest.files.some(file => file.path.startsWith("media/objects/"))) {
      const media = directories.get("media"); requireGit(media !== undefined, "invalid-snapshot");
      directories.set("media/objects", await childDirectory(media, "objects"));
    }
    const files: PayloadFile[] = [];
    const partial: SnapshotTree = { root, directories, files, manifestSha256: manifest.digest, close };
    await membership(directories, manifest.files, guard);
    for (const entry of manifest.files) {
      const { parent, name } = payloadParent(partial, entry.path), actual = await fileDigests(parent, name, guard);
      requireGit(actual.sha256 === entry.sha256 && actual.byteLength === entry.byteLength, "invalid-snapshot");
      files.push({ path: entry.path, ...actual });
    }
    await membership(directories, files, guard); guard(); return partial;
  } catch (error) { await close(); throw error; }
}

/** New destination only; no hard links, overwrite, filter conversion or source-store initialization. */
export async function copySnapshot(source: SnapshotTree, target: Directory, guard: Guard): Promise<void> {
  const directories = new Map<string, Directory>([["", target]]);
  try {
    for (const path of source.directories.keys()) if (path) {
      const { directory, name } = split(path), parent = directories.get(directory); requireGit(parent !== undefined);
      directories.set(path, await childDirectory(parent, name, true));
    }
    for (const entry of source.files) {
      guard(); const from = payloadParent(source, entry.path), parts = split(entry.path), parent = directories.get(parts.directory); requireGit(parent !== undefined);
      const file = await newFile(parent, parts.name);
      try {
        const actual = await fingerprint(from.parent, from.name, guard, file);
        requireGit(actual.sha256 === entry.sha256 && actual.byteLength === entry.byteLength, "invalid-snapshot");
        verifyFile(parent, parts.name, file, false);
      } finally { await file.handle.close(); }
    }
    for (const directory of [...directories.values()].reverse()) await directory.handle.sync();
    for (const directory of source.directories.values()) verifyDirectory(directory, true);
  } finally { await Promise.allSettled([...directories.entries()].filter(([path]) => path !== "").map(([, directory]) => directory.handle.close())); }
}

/** Validate closed Git trees before allowing Git to materialize their paths. */
export function checkTreeListing(raw: string, expected: readonly { path: string }[]): void {
  const lines = raw.split("\0"); requireGit(lines.pop() === "", "unsupported-remote");
  const paths = lines.map(line => {
    const match = /^100644 blob ([0-9a-f]{40})\t(snapshot\/[a-zA-Z0-9_./-]+)$/.exec(line);
    requireGit(match !== null, "unsupported-remote"); return match[2];
  }).sort();
  const wanted = expected.map(file => `snapshot/${file.path}`).sort();
  requireGit(paths.length === wanted.length && paths.every((path, index) => path === wanted[index]), "unsupported-remote");
}

export function checkGitFiles(raw: string, expected: readonly PayloadFile[], index = false): boolean {
  const lines = raw.split("\0"); if (lines.pop() !== "") return false;
  const entries: { path: string; blob: string }[] = [];
  for (const line of lines) {
    const match = (index ? /^100644 ([0-9a-f]{40}) 0\t(snapshot\/[^\0]+)$/ : /^100644 blob ([0-9a-f]{40})\t(snapshot\/[^\0]+)$/).exec(line);
    if (!match) return false; entries.push({ path: match[2].slice(9), blob: match[1] });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return entries.length === expected.length && entries.every((entry, index) => entry.path === expected[index].path && entry.blob === expected[index].blob);
}
