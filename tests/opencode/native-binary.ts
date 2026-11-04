import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

// Adapted from Memory Loop's tests/opencode/native-binary.ts (2.2.2 fixture).
const suffix = '/@opencode+cli@2.2.5/node_modules/@opencode/cli/bin/opencode.exe';
export function requireOptIn(env: Readonly<Record<string, string | undefined>>): string {
  if (env.OPENCODE_NATIVE_TEST !== '1') throw new Error('Set OPENCODE_NATIVE_TEST=1 and OPENCODE_TEST_BINARY to the verified direct 2.2.5 executable');
  const binary = env.OPENCODE_TEST_BINARY;
  if (!binary) throw new Error('OPENCODE_TEST_BINARY must name the absolute verified direct 2.2.5 executable');
  if (!isAbsolute(binary) || normalize(binary) !== binary || binary.includes('\0') || !binary.endsWith(suffix)) throw new Error('invalid native binary selector: select the direct 2.2.5 CLI executable, not a wrapper');
  return binary;
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function preflightExecutable(executable: string): Promise<string> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !isAbsolute(executable) || normalize(executable) !== executable || executable.includes('\0') || !executable.endsWith(suffix)) throw new Error('invalid native binary selector');
  const install = executable.slice(0, -suffix.length);
  const cli = join(install, '@opencode+cli@2.2.5/node_modules/@opencode/cli');
  const platform = join(install, '@opencode+cli-linux-x64@2.2.5/node_modules/@opencode/cli-linux-x64');
  const binary = join(platform, 'bin/opencode');
  for (const path of [cli, platform, executable, binary, join(cli, 'package.json'), join(platform, 'package.json')]) {
    if (await realpath(path) !== path) throw new Error('native installation contains a symlink');
  }
  const [cliStat, platformStat, cliRaw, platformRaw] = await Promise.all([lstat(executable), lstat(binary), readFile(join(cli, 'package.json'), 'utf8'), readFile(join(platform, 'package.json'), 'utf8')]);
  if (!cliStat.isFile() || !platformStat.isFile() || !(cliStat.mode & 0o111) || !(platformStat.mode & 0o111)) throw new Error('native executable is not an executable regular file');
  const file = await open(executable, 'r');
  try {
    const signature = Buffer.alloc(20);
    const { bytesRead } = await file.read(signature, 0, 20, 0);
    if (bytesRead !== 20 || !signature.subarray(0, 5).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2])) || signature[5] !== 1 || signature.readUInt16LE(18) !== 62) throw new Error('native executable is not x86_64 ELF');
  } finally { await file.close(); }
  const c: unknown = JSON.parse(cliRaw);
  const p: unknown = JSON.parse(platformRaw);
  if (typeof c !== 'object' || c === null || !('name' in c) || c.name !== '@opencode/cli' || !('version' in c) || c.version !== '2.2.5' ||
      typeof p !== 'object' || p === null || !('name' in p) || p.name !== '@opencode/cli-linux-x64' || !('version' in p) || p.version !== '2.2.5') throw new Error('native package metadata mismatch');
  const hash = await hashFile(executable);
  if ((cliStat.dev !== platformStat.dev || cliStat.ino !== platformStat.ino) && hash !== await hashFile(binary)) throw new Error('native binary does not match installed platform package');
  return hash;
}
