import { constants, lstatSync, readFileSync, statfsSync } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface ExecutionFileIdentity { readonly dev: bigint; readonly ino: bigint }
export interface ExecutionOwnerPaths {
  readonly databasePath: string;
  readonly sidecarPath: string;
  readonly database: ExecutionFileIdentity;
  readonly sidecar: ExecutionFileIdentity;
}
// Explicit local Linux VFS boundary: ext2/3/4, XFS, Btrfs, tmpfs, overlayfs, ZFS, F2FS.
const localFilesystems = new Set([0xef53,0x58465342,0x9123683e,0x01021994,0x794c7630,0x2fc12fc1,0xf2f52010]);
export class ExecutionOwnerPathError extends Error {
  constructor() { super("Unsupported execution ownership path"); }
}
function code(error: unknown, expected: string): boolean {
  return error instanceof Error && "code" in error && error.code === expected;
}
function file(path: string, privateSidecar: boolean): ExecutionFileIdentity {
  const stat = lstatSync(path,{ bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o022n) !== 0n ||
    (privateSidecar && (stat.mode & 0o777n) !== 0o600n)) throw new ExecutionOwnerPathError();
  return { dev: stat.dev, ino: stat.ino };
}
export function sameExecutionFile(path: string, identity: ExecutionFileIdentity, privateSidecar: boolean): boolean {
  const current = file(path,privateSidecar);
  return current.dev === identity.dev && current.ino === identity.ino;
}
function secureDirectory(path: string): void {
  const parent = lstatSync(path);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0) throw new ExecutionOwnerPathError();
}
function localPath(path: string): void {
  secureDirectory(dirname(path));
  if (!localFilesystems.has(statfsSync(path).type >>> 0)) throw new ExecutionOwnerPathError();
  // realpath does not collapse individual-file bind mounts. Directory aliases share the adjacent sidecar inode.
  const mounts = readFileSync("/proc/self/mountinfo","utf8").split("\n");
  for (const line of mounts) {
    const mount = line.split(" ")[4];
    if (mount?.replace(/\\([0-7]{3})/g,(_match,octal: string) => String.fromCharCode(Number.parseInt(octal,8))) === path) {
      throw new ExecutionOwnerPathError();
    }
  }
}
async function createFile(path: string): Promise<void> {
  try {
    const handle = await open(path,constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,0o600);
    await handle.close();
  } catch (error) { if (!code(error,"EEXIST")) throw error; }
}

/** Resolve/create identity only; never open the knowledge database or inspect its content. */
export async function prepareExecutionDatabase(input: string): Promise<Omit<ExecutionOwnerPaths,"sidecar">> {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || input.includes("\0") ||
    input === ":memory:" || /^(?:file:|:)/.test(input)) throw new ExecutionOwnerPathError();
  const requested = resolve(input);
  await mkdir(dirname(requested),{ recursive: true });
  const parent = await realpath(dirname(requested));
  const path = resolve(parent,basename(requested));
  let databasePath: string;
  try { databasePath = await realpath(path); }
  catch (error) {
    if (!code(error,"ENOENT")) throw error;
    secureDirectory(parent);
    await createFile(path);
    databasePath = await realpath(path);
  }
  const database = file(databasePath,false);
  localPath(databasePath);
  return { databasePath, database, sidecarPath: `${databasePath}.execution-owner.sqlite` };
}
/** Run after the same-process reservation, before bun:sqlite opens its one private sidecar handle. */
export async function prepareExecutionSidecar(paths: Omit<ExecutionOwnerPaths,"sidecar">): Promise<ExecutionOwnerPaths> {
  await createFile(paths.sidecarPath);
  const sidecar = file(paths.sidecarPath,true);
  localPath(paths.sidecarPath);
  return { ...paths, sidecar };
}
