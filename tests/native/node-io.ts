// Binary checks adapt the committed inline preflight in memory-loop checkpoint
// 0b2343c94f4313ed6e86440031e15ee8cc7d459c, backend/opencode-capabilities.test.ts
// (blob 73766ba70163e2f9c944a3943f264735232ddbda). The later untracked extracted
// helper is NOT the provenance for this copy. No executable is invoked here.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_BINARY, NATIVE_SHA256, WitnessGuardError, validateBinary, type BinaryFacts, type GuardIO } from "./plugin-isolation";

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(65_536);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}
export const nodeIO: GuardIO = {
  async inspect(path) {
    try {
      const stat = await lstat(path);
      return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "error";
    } catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "error"; }
  },
  canonical: realpath, text: (path) => readFile(path, "utf8"), hash: hashFile, entries: readdir,
  async private(path) {
    const stat = await lstat(path);
    return !stat.isSymbolicLink() && (!process.getuid || stat.uid === process.getuid()) &&
      (stat.mode & 0o777) === (stat.isDirectory() ? 0o700 : 0o600);
  },
};

function metadata(value: unknown, name: string) {
  if (typeof value !== "object" || value === null || !("name" in value) || value.name !== name || !("version" in value) || value.version !== "2.2.2") {
    throw new WitnessGuardError("binary_package_metadata_rejected");
  }
}
async function elf(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await file.read(signature, 0, 4, 0);
    return bytesRead === 4 && signature.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally { await file.close(); }
}
export async function inspectBinary(executable: string): Promise<BinaryFacts> {
  if (executable !== NATIVE_BINARY || process.platform !== "linux" || process.arch !== "x64") throw new WitnessGuardError("binary_selector_rejected");
  const suffix = "/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe";
  const install = executable.slice(0, -suffix.length);
  const cli = join(install, "@opencode+cli@2.2.2/node_modules/@opencode/cli");
  const platform = join(install, "@opencode+cli-linux-x64@2.2.2/node_modules/@opencode/cli-linux-x64");
  const sibling = join(platform, "bin/opencode");
  for (const path of [cli, platform, executable, sibling, join(cli, "package.json"), join(platform, "package.json")]) {
    if (await realpath(path) !== path) throw new WitnessGuardError("binary_link_rejected");
  }
  const [a, b] = await Promise.all([lstat(executable), lstat(sibling)]);
  metadata(JSON.parse(await readFile(join(cli, "package.json"), "utf8")), "@opencode/cli");
  metadata(JSON.parse(await readFile(join(platform, "package.json"), "utf8")), "@opencode/cli-linux-x64");
  const sha256 = await hashFile(executable);
  const siblingMatches = a.dev === b.dev && a.ino === b.ino ? true : await hashFile(sibling) === NATIVE_SHA256;
  const facts = { executable, canonical: true, regularExecutable: a.isFile() && b.isFile() && !!(a.mode & 0o111) && !!(b.mode & 0o111),
    elf: await elf(executable) && await elf(sibling), sha256, cliName: "@opencode/cli", cliVersion: "2.2.2",
    platformName: "@opencode/cli-linux-x64", platformVersion: "2.2.2", siblingMatches };
  validateBinary(facts);
  return facts;
}
