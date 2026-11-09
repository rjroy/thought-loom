import { relative, isAbsolute, sep } from "node:path";

export class BackupGitError extends Error {
  constructor(readonly code = "delivery-failed") { super(`Backup Git delivery failed: ${code}`); }
}
export function requireGit(condition: boolean, code = "unsafe-checkout"): asserts condition {
  if (!condition) throw new BackupGitError(code);
}
export const oidPattern = /^[0-9a-f]{40}$/;
export const digestPattern = /^[0-9a-f]{64}$/;
export function disjoint(left: string, right: string): boolean {
  const contains = (a: string, b: string): boolean => {
    const path = relative(a, b);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  return !contains(left, right) && !contains(right, left);
}
export const gitBudgets = Object.freeze({ lockMs: 10000, commandMs: 60000, deliveryMs: 300000, outputBytes: 8388608, manifestBytes: 16777216 });
