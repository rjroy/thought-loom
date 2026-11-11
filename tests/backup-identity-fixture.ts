import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runBackupCommand, type BackupCommandDependencies } from "../scripts/backup";
import { validateBackupConfig, type BackupConfig } from "../src/backup/config";
import type { CheckoutState } from "../src/backup/git-checkout";
import type { GitInvocation, GitResult } from "../src/backup/git";
import { runBackupAttempt } from "../src/backup/run";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger, type LogRecord } from "../src/logging";

export const remote = "https://backup.invalid/owned/identity-fixture.git";
export const privateText = "private identity recovery thought sentinel";
const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };

// The proposed backwards-compatible third argument makes the explicit CLI mode testable
// without a missing-export/module failure on the pre-implementation revision.
export const command: (env: Readonly<Record<string, string | undefined>>, deps?: BackupCommandDependencies,
  args?: readonly string[]) => Promise<number> = runBackupCommand;

/** Frozen existing on-disk v1 contract, not a new production record format. */
export interface CaptureWorkspaceV1 {
  readonly version: 1;
  readonly checkout: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly databasePath: string;
  readonly databaseDev: string;
  readonly databaseIno: string;
  readonly mediaDirectory: string;
}
export interface IdentityRecords { readonly state: CheckoutState; readonly workspace: CaptureWorkspaceV1 }
export type Binding = "checkout" | "capture" | "source";

export async function processGit(args: readonly string[], cwd: string, home: string, signal?: AbortSignal): Promise<GitResult> {
  const child = Bun.spawn({ cmd: ["/usr/bin/git", ...args], cwd, signal, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
    PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid", GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid",
  } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

export interface Fixture {
  readonly dir: string; readonly bare: string; readonly checkout: string; readonly captures: string; readonly control: string;
  readonly databasePath: string; readonly mediaDirectory: string; readonly daemon: RunningDaemon; readonly config: BackupConfig;
  readonly statePath: string; readonly workspacePath: string; readonly env: Readonly<Record<string, string>>;
  readonly logs: LogRecord[]; readonly calls: GitInvocation[]; readonly logger: ReturnType<typeof createLogger>;
  readonly runGit: (call: GitInvocation) => Promise<GitResult>;
  attempt(): ReturnType<typeof runBackupAttempt>;
  recover(deps?: BackupCommandDependencies): Promise<number>;
  git(cwd: string, ...args: string[]): Promise<string>;
  addThought(text?: string): Promise<void>;
  clearObservations(): void;
}

export async function owned(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/backup-identity-"), bare = join(dir, "remote.git"), checkout = join(dir, "checkout");
  const databasePath = join(dir, "knowledge.sqlite"), mediaDirectory = `${databasePath}.media`;
  const captures = join(dir, ".checkout.thoughtloom-captures"), control = join(dir, ".checkout.thoughtloom-backup");
  let daemon: RunningDaemon | undefined;
  try {
    const git = async (cwd: string, ...args: string[]) => {
      const result = await processGit(args, cwd, dir);
      if (result.exitCode !== 0) throw new Error(`Owned identity fixture Git failed: ${args[0]}`);
      return result.stdout.trim();
    };
    await git(dir, "init", "--bare", bare);
    daemon = await startDaemon({ dbPath: databasePath, port: 0, credentials }, () => {}, { logSink: () => {} });
    const config = validateBackupConfig({ repositoryUrl: remote, checkout, branch: "backups", intervalSeconds: null }, databasePath, mediaDirectory);
    const env = { THOUGHTLOOM_DB_PATH: databasePath, THOUGHTLOOM_BACKUP_CONFIG: JSON.stringify(config), THOUGHTLOOM_LOG_LEVEL: "verbose" };
    const logs: LogRecord[] = [], calls: GitInvocation[] = [], logger = createLogger("verbose", record => logs.push(record));
    const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remote}`;
    const runGit = (call: GitInvocation) => {
      calls.push(call); return processGit(["-c", redirect, ...call.args], call.cwd, dir, call.signal);
    };
    const current = daemon;
    await action({ dir, bare, checkout, captures, control, databasePath, mediaDirectory, daemon: current, config, env, logs, calls, logger, runGit, git,
      statePath: join(control, "state.json"), workspacePath: join(control, "capture-workspace.json"),
      attempt: () => runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit }),
      recover: (deps = {}) => command(env, { logger, runGit, ...deps }, ["--recover-identity"]),
      async addThought(text = privateText) {
        const response = await fetch(new URL("/thoughts", current.url), { method: "POST", signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });
        expect(response.status).toBe(201);
      },
      clearObservations() { logs.length = 0; calls.length = 0; },
    });
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}

export async function records(f: Fixture): Promise<IdentityRecords> {
  const state = JSON.parse(await readFile(f.statePath, "utf8")) as CheckoutState;
  const workspace = JSON.parse(await readFile(f.workspacePath, "utf8")) as CaptureWorkspaceV1;
  expect(state.version).toBe(1); expect(workspace.version).toBe(1);
  return { state, workspace };
}
export async function writeRecord(path: string, value: CheckoutState | CaptureWorkspaceV1): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
export async function recordBytes(f: Fixture): Promise<readonly Buffer[]> {
  return Promise.all([readFile(f.statePath), readFile(f.workspacePath)]);
}

/** Deterministic cross-runtime device drift, without mount privileges or weakening stat(). */
export async function oldDevices(f: Fixture, bindings: readonly Binding[] = ["checkout", "capture", "source"]): Promise<void> {
  const { state, workspace } = await records(f), previous = (dev: string) => (BigInt(dev) + 1024n).toString();
  if (bindings.includes("checkout")) await writeRecord(f.statePath, { ...state, dev: previous(state.dev) });
  if (bindings.includes("capture") || bindings.includes("source")) await writeRecord(f.workspacePath, { ...workspace,
    dev: bindings.includes("capture") ? previous(workspace.dev) : workspace.dev,
    databaseDev: bindings.includes("source") ? previous(workspace.databaseDev) : workspace.databaseDev });
}

/** Read-only witness of bytes, types, modes and inode identities; never follows links. */
export async function witness(root: string, skip: ReadonlySet<string> = new Set()): Promise<readonly string[]> {
  const entries: string[] = [];
  async function walk(path: string, relative: string): Promise<void> {
    if (skip.has(relative)) return;
    const stat = await lstat(path, { bigint: true });
    const metadata = `${relative}:${stat.mode}:${stat.ino}:${stat.nlink}`;
    if (stat.isDirectory()) {
      entries.push(`${metadata}:directory`);
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isSymbolicLink()) entries.push(`${metadata}:link:${await readlink(path)}`);
    else {
      expect(stat.isFile()).toBe(true);
      entries.push(`${metadata}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
    }
  }
  await walk(root, ""); return entries;
}

export function assertRecoveryOnly(f: Fixture): void {
  expect(f.logs.some(record => record.message === "[backup] source snapshot established")).toBe(false);
  expect(f.logs.some(record => /remote (?:delivery|branch)|local (?:snapshot|commit) retained/.test(record.message))).toBe(false);
  // Recovery may run local verification commands, never initialize/adopt/update/deliver.
  for (const call of f.calls) for (const operation of ["init", "ls-remote", "fetch", "push", "add", "commit", "checkout", "reset", "clean", "update-ref", "gc", "repack"])
    expect(call.args.includes(operation)).toBe(false);
  assertSafeLogs(f);
}

function assertSafeLogs(f: Fixture): void {
  const text = JSON.stringify(f.logs);
  for (const secret of [f.dir, f.databasePath, f.mediaDirectory, remote, privateText, credentials.user, credentials.ai]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/https?:\/\/|git@/);
}

export function safeReasons(f: Fixture): string[] {
  const reasons = f.logs.flatMap(record => typeof record.context?.reason === "string" ? [record.context.reason] : []);
  expect(reasons.length).toBeGreaterThan(0);
  for (const reason of reasons) expect(reason).toMatch(/^[a-z][a-z0-9-]{0,95}$/);
  assertSafeLogs(f);
  return reasons;
}
