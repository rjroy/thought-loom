import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBackupCommand, type BackupCommandDependencies } from "../scripts/backup";
import { validateBackupConfig, type BackupConfig } from "../src/backup/config";
import type { GitInvocation, GitResult } from "../src/backup/git";
import { runBackupAttempt, type BackupAttemptResult } from "../src/backup/run";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger, type LogRecord } from "../src/logging";

export const remote = "https://backup.invalid/owned/identity-fixture.git";
export const privateText = "private restart identity thought sentinel";
const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };

type Pending = { readonly kind: "adopt"; readonly head: string; readonly manifest: string }
  | { readonly kind: "update"; readonly beforeHead: string | null; readonly beforeManifest: string | null; readonly afterManifest: string };
interface CheckoutCore {
  readonly repositoryUrl: string; readonly branch: string; readonly ino: string;
  readonly configSha256: string | null; readonly head: string | null; readonly manifest: string | null; readonly pending: Pending | null;
}
interface WorkspaceCore {
  readonly checkout: string; readonly repositoryUrl: string; readonly branch: string; readonly path: string; readonly ino: string;
  readonly databasePath: string; readonly databaseIno: string; readonly mediaDirectory: string;
}
// Test-owned disk contracts intentionally do not import a not-yet-implemented v2 type.
export type CheckoutRecord = CheckoutCore & ({ readonly version: 1; readonly dev: string } | { readonly version: 2 });
export type WorkspaceRecord = WorkspaceCore & ({ readonly version: 1; readonly dev: string; readonly databaseDev: string } | { readonly version: 2 });
export interface RecordPaths { readonly statePath: string; readonly workspacePath: string; readonly checkout: string; readonly captures: string; readonly databasePath: string }
export type Binding = "checkout" | "capture" | "source";
export interface ChildResult {
  readonly attempt?: BackupAttemptResult; readonly commandExit?: number; readonly reason?: string;
  readonly logs: LogRecord[]; readonly calls: readonly (readonly string[])[];
}

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

interface AttemptDependencies { readonly runGit?: (call: GitInvocation) => Promise<GitResult>; readonly logger?: ReturnType<typeof createLogger>; readonly signal?: AbortSignal }
export interface Fixture extends RecordPaths {
  readonly dir: string; readonly bare: string; readonly control: string; readonly mediaDirectory: string; readonly daemon: RunningDaemon; readonly config: BackupConfig;
  readonly env: Readonly<Record<string, string>>; readonly logs: LogRecord[]; readonly calls: GitInvocation[]; readonly logger: ReturnType<typeof createLogger>;
  readonly runGit: (call: GitInvocation) => Promise<GitResult>;
  attempt(deps?: AttemptDependencies): ReturnType<typeof runBackupAttempt>;
  command(args?: readonly string[], deps?: BackupCommandDependencies): Promise<number>;
  fresh(kind?: "attempt" | "command", config?: BackupConfig): Promise<ChildResult & { readonly exitCode: number }>;
  git(cwd: string, ...args: string[]): Promise<string>;
  addThought(text?: string): Promise<void>;
  clearObservations(): void;
}

export async function owned(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/backup-restart-"), bare = join(dir, "remote.git"), checkout = join(dir, "checkout");
  const databasePath = join(dir, "knowledge.sqlite"), mediaDirectory = `${databasePath}.media`;
  const captures = join(dir, ".checkout.thoughtloom-captures"), control = join(dir, ".checkout.thoughtloom-backup");
  let daemon: RunningDaemon | undefined;
  try {
    const git = async (cwd: string, ...args: string[]) => {
      const result = await processGit(args, cwd, dir);
      if (result.exitCode !== 0) throw new Error(`Owned restart fixture Git failed: ${args[0]}`);
      return result.stdout.trim();
    };
    await git(dir, "init", "--bare", bare);
    daemon = await startDaemon({ dbPath: databasePath, port: 0, credentials }, () => {}, { logSink: () => {} });
    const config = validateBackupConfig({ repositoryUrl: remote, checkout, branch: "backups", intervalSeconds: null }, databasePath, mediaDirectory);
    const env = { THOUGHTLOOM_DB_PATH: databasePath, THOUGHTLOOM_BACKUP_CONFIG: JSON.stringify(config), THOUGHTLOOM_LOG_LEVEL: "verbose" };
    const logs: LogRecord[] = [], calls: GitInvocation[] = [], logger = createLogger("verbose", record => logs.push(record));
    const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remote}`;
    const runGit = (call: GitInvocation) => { calls.push(call); return processGit(["-c", redirect, ...call.args], call.cwd, dir, call.signal); };
    const current = daemon;
    await action({ dir, bare, checkout, captures, control, databasePath, mediaDirectory, daemon: current, config, env, logs, calls, logger, runGit, git,
      statePath: join(control, "state.json"), workspacePath: join(control, "capture-workspace.json"),
      attempt: (deps = {}) => runBackupAttempt({ databasePath, mediaDirectory, config, logger: deps.logger ?? logger, signal: deps.signal }, { runGit: deps.runGit ?? runGit }),
      command: (args = [], deps = {}) => runBackupCommand(env, { logger, runGit, ...deps }, args),
      async fresh(kind = "attempt", selectedConfig = config) {
        const script = fileURLToPath(new URL("./backup-restart-child.ts", import.meta.url));
        const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script, dir, bare, databasePath, mediaDirectory, JSON.stringify(selectedConfig), kind],
          cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: dir }, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* This owned process group may already have exited. */ } };
        const timer = setTimeout(kill, 20000);
        try {
          const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (stderr !== "") throw new Error("Owned restart child emitted unexpected stderr");
          const result = JSON.parse(stdout) as ChildResult;
          logs.push(...result.logs); calls.push(...result.calls.map(args => ({ args, cwd: selectedConfig.checkout })));
          return { ...result, exitCode };
        } finally { clearTimeout(timer); kill(); await child.exited; }
      },
      async addThought(text = privateText) {
        const response = await fetch(new URL("/thoughts", current.url), { method: "POST", signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });
        expect(response.status).toBe(201);
      },
      clearObservations() { logs.length = 0; calls.length = 0; },
    });
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}

export async function records(f: RecordPaths): Promise<{ state: CheckoutRecord; workspace: WorkspaceRecord }> {
  const state = JSON.parse(await readFile(f.statePath, "utf8")) as CheckoutRecord;
  const workspace = JSON.parse(await readFile(f.workspacePath, "utf8")) as WorkspaceRecord;
  expect(state.version === 1 || state.version === 2).toBe(true); expect(workspace.version === 1 || workspace.version === 2).toBe(true);
  return { state, workspace };
}
export async function writeRecord(path: string, value: CheckoutRecord | WorkspaceRecord): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
export async function recordBytes(f: RecordPaths): Promise<readonly Buffer[]> { return Promise.all([readFile(f.statePath), readFile(f.workspacePath)]); }

/** Exact independent legacy/new wire encodings; never repair or change a fixture's bound inode. */
export async function seedRecords(f: RecordPaths, stateVersion: 1 | 2, workspaceVersion: 1 | 2, epoch = 0,
  changed: readonly Binding[] = ["checkout", "capture", "source"]): Promise<void> {
  const { state: s, workspace: w } = await records(f);
  const device = async (path: string, binding: Binding) => ((await lstat(path, { bigint: true })).dev + BigInt(changed.includes(binding) ? epoch : 0)).toString();
  const state: CheckoutRecord = stateVersion === 1
    ? { version: 1, repositoryUrl: s.repositoryUrl, branch: s.branch, dev: await device(f.checkout, "checkout"), ino: s.ino,
        configSha256: s.configSha256, head: s.head, manifest: s.manifest, pending: s.pending }
    : { version: 2, repositoryUrl: s.repositoryUrl, branch: s.branch, ino: s.ino, configSha256: s.configSha256, head: s.head, manifest: s.manifest, pending: s.pending };
  const core = { checkout: w.checkout, repositoryUrl: w.repositoryUrl, branch: w.branch, path: w.path };
  const workspace: WorkspaceRecord = workspaceVersion === 1
    ? { version: 1, ...core, dev: await device(f.captures, "capture"), ino: w.ino, databasePath: w.databasePath,
        databaseDev: await device(f.databasePath, "source"), databaseIno: w.databaseIno, mediaDirectory: w.mediaDirectory }
    : { version: 2, ...core, ino: w.ino, databasePath: w.databasePath, databaseIno: w.databaseIno, mediaDirectory: w.mediaDirectory };
  await writeRecord(f.statePath, state); await writeRecord(f.workspacePath, workspace);
}

/** Read-only witness of bytes, types, modes and inode identities; never follows links. */
export async function witness(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  async function walk(path: string, relative: string): Promise<void> {
    const stat = await lstat(path, { bigint: true }), metadata = `${relative}:${stat.mode}:${stat.ino}:${stat.nlink}`;
    if (stat.isDirectory()) {
      entries.push(`${metadata}:directory`);
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isSymbolicLink()) entries.push(`${metadata}:link:${await readlink(path)}`);
    else { expect(stat.isFile()).toBe(true); entries.push(`${metadata}:${createHash("sha256").update(await readFile(path)).digest("hex")}`); }
  }
  await walk(root, ""); return entries;
}

/** Normal Git status may atomically refresh its index cache. Protect semantic
 * index/history plus immutable payload/ownership, not incidental index inodes. */
export async function checkoutWitness(f: Fixture) {
  const root = await lstat(f.checkout, { bigint: true });
  return { root: `${root.ino}:${root.mode}`, payload: await witness(join(f.checkout, "snapshot")), config: await witness(join(f.checkout, ".git", "config")),
    head: await f.git(f.checkout, "rev-parse", "HEAD"), refs: await f.git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    index: await f.git(f.checkout, "ls-files", "--stage", "-z") };
}

export function assertNoIdentityMaintenance(f: Fixture): void {
  expect(f.logs.some(record => /\bidentity (?:recovery|recovered|validated|binding recovered)\b/.test(record.message))).toBe(false);
  expect(f.calls.some(call => call.args.includes("fsck"))).toBe(false);
  assertSafeLogs(f);
}
export function assertSafeLogs(f: Fixture): void {
  const text = JSON.stringify(f.logs);
  for (const secret of [f.dir, f.databasePath, f.mediaDirectory, remote, privateText, credentials.user, credentials.ai]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/https?:\/\/|git@/);
}
export function safeReasons(f: Fixture): string[] {
  const reasons = f.logs.flatMap(record => typeof record.context?.reason === "string" ? [record.context.reason] : []);
  expect(reasons.length).toBeGreaterThan(0);
  for (const reason of reasons) expect(reason).toMatch(/^[a-z][a-z0-9-]{0,95}$/);
  assertSafeLogs(f); return reasons;
}

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned backup boundary timed out")), 20000); })]); }
  finally { clearTimeout(timer); }
}
