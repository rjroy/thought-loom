import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBackupCommand } from "../scripts/backup";
import type { GitInvocation, GitResult } from "../src/backup/git";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger, type LogRecord } from "../src/logging";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const remote = "https://backup.invalid/owned/fixture.git";
async function git(args: readonly string[], cwd: string, home: string, signal?: AbortSignal): Promise<GitResult> {
  const child = Bun.spawn({ cmd: ["git", ...args], cwd, signal, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
    PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid", GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid",
  } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test("manual entry refuses absent configuration without touching paths or loading an owned dotenv file", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-command-");
  try {
    const db = join(dir, "not-created.sqlite"), checkout = join(dir, "not-created-checkout"), logs: LogRecord[] = [];
    const logger = createLogger("verbose", record => logs.push(record)); let gitCalls = 0;
    const exit = await runBackupCommand({ THOUGHTLOOM_DB_PATH: db }, { logger, async runGit() { gitCalls++; throw new Error("unexpected Git"); } });
    expect(exit).not.toBe(0); expect(gitCalls).toBe(0);
    await expect(access(db)).rejects.toThrow(); await expect(access(checkout)).rejects.toThrow();
    await writeFile(join(dir, ".env"), `THOUGHTLOOM_DB_PATH=${db}\nTHOUGHTLOOM_BACKUP_CONFIG=private-dotenv-sentinel\n`, { mode: 0o600 });
    const script = fileURLToPath(new URL("../scripts/backup.ts", import.meta.url));
    const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script], cwd: dir,
      env: { PATH: "/usr/bin:/bin", HOME: dir, THOUGHTLOOM_DB_PATH: db }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).not.toBe(0); expect(stdout + stderr).not.toContain("private-dotenv-sentinel");
      await expect(access(db)).rejects.toThrow(); await expect(access(checkout)).rejects.toThrow();
    } finally { clearTimeout(timeout); }
    expect(JSON.stringify(logs)).not.toContain(db);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);

test("manual command uses only backup and database inputs, reports pending delivery nonzero and retains local recovery data", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-command-"), bare = join(dir, "remote.git"), db = join(dir, "knowledge.sqlite");
  const checkout = join(dir, "backup"), captureRoot = join(dir, ".backup.thoughtloom-captures");
  let daemon: RunningDaemon | undefined;
  try {
    expect((await git(["init", "--bare", bare], dir, dir)).exitCode).toBe(0);
    daemon = await startDaemon({ dbPath: db, port: 0, credentials }, () => {}, { logSink: () => {} });
    const settings = JSON.stringify({ repositoryUrl: remote, checkout, branch: "backups", intervalSeconds: null });
    // No role tokens, agent configuration, or media override: the default media path must match the daemon.
    const env = { THOUGHTLOOM_DB_PATH: db, THOUGHTLOOM_BACKUP_CONFIG: settings, THOUGHTLOOM_LOG_LEVEL: "verbose" };
    const logs: LogRecord[] = [], logger = createLogger("verbose", record => logs.push(record));
    const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remote}`;
    const runGit = (call: GitInvocation) => git(["-c", redirect, ...call.args], call.cwd, dir, call.signal);
    expect(await runBackupCommand(env, { logger, runGit })).toBe(0);
    const first = (await git(["rev-parse", "refs/heads/backups"], bare, dir)).stdout.trim();
    const previous = (await readdir(captureRoot)).filter(name => name.startsWith("snapshot-")); expect(previous).toHaveLength(1);
    const priorManifest = await readFile(join(captureRoot, previous[0], "manifest.json"));
    const response = await fetch(new URL("/thoughts", daemon.url), { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" }, body: JSON.stringify({ text: "private command thought" }) });
    expect(response.status).toBe(201);
    const offline = join(dir, "offline.git"); await rename(bare, offline);
    try {
      expect(await runBackupCommand(env, { logger, runGit })).not.toBe(0);
      const pending = (await git(["rev-parse", "HEAD"], checkout, dir)).stdout.trim();
      expect(pending).not.toBe(first);
      const snapshots = (await readdir(captureRoot)).filter(name => name.startsWith("snapshot-"));
      expect(snapshots).toHaveLength(2); expect(snapshots).toContain(previous[0]);
      expect(await readFile(join(captureRoot, previous[0], "manifest.json"))).toEqual(priorManifest);
      await rename(offline, bare);
      expect(await runBackupCommand(env, { logger, runGit })).toBe(0);
      expect((await git(["rev-parse", "refs/heads/backups"], bare, dir)).stdout.trim()).toBe(pending);
      expect((await git(["rev-list", "--count", pending], checkout, dir)).stdout.trim()).toBe("2");
    } finally {
      try { await rename(offline, bare); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    expect(logs.some(record => record.message === "[backup] local snapshot retained")).toBe(true);
    expect(logs.some(record => record.message === "[backup] attempt outcome" && record.context?.remoteConfirmed === false)).toBe(true);
    expect(logs.some(record => record.message === "[backup] attempt outcome" && record.context?.remoteConfirmed === true)).toBe(true);
    for (const secret of [remote, settings, "private command thought", credentials.user, credentials.ai]) expect(JSON.stringify(logs)).not.toContain(secret);
    const badPath = join(dir, "private-source-sentinel.sqlite");
    expect(await runBackupCommand({ ...env, THOUGHTLOOM_DB_PATH: badPath }, { logger, runGit })).not.toBe(0);
    const controller = new AbortController(); controller.abort();
    expect(await runBackupCommand(env, { logger, runGit, signal: controller.signal })).not.toBe(0);
    expect(JSON.stringify(logs)).not.toContain(badPath);
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 45000);
