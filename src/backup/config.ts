import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../daemon/config-error";

export interface BackupConfig {
  readonly repositoryUrl: string;
  readonly checkout: string;
  readonly branch: string;
  readonly intervalSeconds: number | null;
}

const applicationRoot = fileURLToPath(new URL("../..", import.meta.url));
const invalid = (category: string): never => { throw new ConfigError(`THOUGHTLOOM_BACKUP_CONFIG ${category}`); };

function validRemote(remote: string): boolean {
  // Restrict to conventional remote syntax: no escaped credentials, shell syntax or Git helpers.
  if (!remote || /[\s\x00-\x1f\x7f\\%?#]/.test(remote)) return false;
  const scp = /^([a-zA-Z0-9_][a-zA-Z0-9_.-]*)@([a-zA-Z0-9][a-zA-Z0-9.-]*):([a-zA-Z0-9_][a-zA-Z0-9_./-]*)$/.exec(remote);
  if (scp) return !scp[3].split("/").some(part => part === ".." || part === "." || !part);
  let url: URL;
  try { url = new URL(remote); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") return false;
  if (!url.hostname || url.password || url.search || url.hash || (url.protocol === "https:" && url.username)) return false;
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[0-9a-fA-F:]+\])$/.test(url.hostname)) return false;
  if (url.protocol === "https:" && /^https:\/\/[^/]*@/.test(remote)) return false;
  if (url.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(url.username)) return false;
  // Validate the literal spelling, not URL's normalized path, which can hide traversal.
  const match = /^(?:https|ssh):\/\/[^/]+\/(.+)$/.exec(remote);
  return !!match && /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(match[1]) &&
    !match[1].split("/").some(part => part === ".." || part === "." || !part);
}

function validBranch(branch: string): boolean {
  return !!branch && branch !== "@" && branch !== "HEAD" && !branch.startsWith("-") && !branch.startsWith("/") &&
    !branch.endsWith("/") && !branch.endsWith(".") && !branch.includes("..") && !branch.includes("@{") &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
    !branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));
}

function overlaps(left: string, right: string): boolean {
  const rel = relative(resolve(left), resolve(right));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) ||
    (() => { const reverse = relative(resolve(right), resolve(left)); return reverse !== ".." && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse); })();
}

export function validateBackupConfig(input: unknown, dbPath: string, mediaDir?: string): BackupConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid("must be a JSON object");
  const keys = Object.keys(input);
  if (keys.length !== 4 || !["repositoryUrl", "checkout", "branch", "intervalSeconds"].every(key => Object.hasOwn(input, key))) return invalid("must contain exactly the required fields");
  if (!("repositoryUrl" in input) || typeof input.repositoryUrl !== "string" || !validRemote(input.repositoryUrl)) return invalid("has an invalid repository URL");
  if (!("checkout" in input) || typeof input.checkout !== "string" || !isAbsolute(input.checkout) || input.checkout.includes("\0")) return invalid("has an invalid checkout path");
  const checkout = input.checkout;
  if ([applicationRoot, dbPath, mediaDir ?? `${resolve(dbPath)}.media`].some(path => overlaps(checkout, path))) return invalid("has an invalid checkout path");
  if (!("branch" in input) || typeof input.branch !== "string" || !validBranch(input.branch)) return invalid("has an invalid branch");
  if (!("intervalSeconds" in input) || (input.intervalSeconds !== null && (typeof input.intervalSeconds !== "number" || !Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 1))) return invalid("has an invalid interval");
  return { repositoryUrl: input.repositoryUrl, checkout: input.checkout, branch: input.branch, intervalSeconds: input.intervalSeconds };
}

export function parseBackupConfig(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return invalid("must be valid JSON"); }
}
