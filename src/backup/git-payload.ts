import { BackupSnapshotError, copySnapshot as copy, inspectSnapshot as inspect, manifestFiles as files,
  type SnapshotTree, type PayloadFile } from "./snapshot";
import type { Directory, Guard } from "./capture-files";
import { BackupGitError, gitBudgets, requireGit } from "./git-common";
export type { SnapshotTree, PayloadFile } from "./snapshot";

function failure(error: unknown): never {
  if (error instanceof BackupSnapshotError) throw new BackupGitError(error.code);
  throw error;
}
function isObject(value: unknown): value is Record<string,unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function object(value: unknown, keys: readonly string[]): Record<string,unknown> {
  requireGit(isObject(value),"invalid-snapshot");
  requireGit(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key)),"invalid-snapshot");
  return value;
}
export function manifestFiles(bytes: Uint8Array, expectedSha?: string): {digest:string;files:Omit<PayloadFile,"blob">[]} {
  try { const result = files(bytes,expectedSha,gitBudgets.manifestBytes); return {digest:result.digest,files:result.files}; }
  catch (error) { return failure(error); }
}
export async function inspectSnapshot(path: string, expectedSha: string | undefined, guard: Guard): Promise<SnapshotTree> {
  try { return await inspect(path,expectedSha,guard,{manifestBytes:gitBudgets.manifestBytes}); } catch (error) { return failure(error); }
}
export async function copySnapshot(source: SnapshotTree, target: Directory, guard: Guard): Promise<void> {
  try { await copy(source,target,guard); } catch (error) { failure(error); }
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
