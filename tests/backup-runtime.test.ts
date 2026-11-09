import { expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startDaemon, type DaemonEvent, type RunningDaemon } from "../src/daemon/runtime";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { runBackupAttempt } from "../src/backup/run";
import type { GitInvocation, GitResult } from "../src/backup/git";
import type { BackupTimer } from "../src/backup/scheduler";
import { createLogger } from "../src/logging";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const remote = "https://backup.invalid/owned/fixture.git";

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

test("unconfigured and manual-only daemons start no backup producer or backup timer", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-runtime-");
  try {
    for (const configured of [false, true]) {
      let timers = 0, calls = 0;
      const timer: BackupTimer = { now: () => 0n, schedule() { timers++; return () => {}; } };
      const backup = { repositoryUrl: remote, checkout: join(dir, "backup"), branch: "backups", intervalSeconds: null };
      const daemon = await startDaemon({ dbPath: join(dir, configured ? "manual.sqlite" : "none.sqlite"), port: 0, credentials,
        ...(configured ? { backup } : {}) }, () => {}, { logSink: () => {}, backupScheduler: { timer, async attempt() { calls++; } } });
      try { await Promise.resolve(); expect(calls).toBe(0); expect(timers).toBe(0); }
      finally { await daemon.stop(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("scheduled runtime begins after readiness and joins an aborted attempt before releasing its execution owner", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-runtime-"), dbPath = join(dir, "knowledge.sqlite");
  const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>();
  let ready = false, readyWhenAttempted = false, calls = 0, stopped = false, daemon: RunningDaemon | undefined;
  const timer: BackupTimer = { now: () => 0n, schedule() { return () => {}; } };
  try {
    daemon = await startDaemon({ dbPath, port: 0, credentials,
      backup: { repositoryUrl: remote, checkout: join(dir, "backup"), branch: "backups", intervalSeconds: 17 } },
    (event: DaemonEvent) => { if ("operation" in event && event.operation === "start" && event.phase === "outcome" && event.success) ready = true; }, {
      logSink: () => {}, backupScheduler: { timer, async attempt(signal) { calls++; readyWhenAttempted = ready; entered.resolve(signal); await release.promise; } },
    });
    const signal = await bounded(entered.promise, "scheduled backup attempt");
    expect(readyWhenAttempted).toBe(true); expect(calls).toBe(1);
    const stopping = daemon.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(stopped).toBe(false);
    await expect(ExecutionOwnerLease.acquire(dbPath)).rejects.toThrow("execution owner already held");
    release.resolve(); await stopping; daemon = undefined;
    const after = await ExecutionOwnerLease.acquire(dbPath);
    try { expect(stopped).toBe(true); } finally { after.release(); }
  } finally { release.resolve(); await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 15000);

test("scheduled runtime performs real capture and Git, then joins a held capture child on shutdown", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-runtime-real-"), dbPath = join(dir, "knowledge.sqlite"), bare = join(dir, "remote.git");
  const config = { repositoryUrl: remote, checkout: join(dir, "backup"), branch: "backups", intervalSeconds: 17 };
  let daemon: RunningDaemon | undefined, held: number | undefined;
  async function git(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
    const child = Bun.spawn({ cmd: ["git", ...args], cwd, signal, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
      PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid", GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid",
    } });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exitCode, stdout, stderr };
    } finally { clearTimeout(timeout); }
  }
  const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remote}`;
  const runGit = (call: GitInvocation) => git(["-c", redirect, ...call.args], call.cwd, call.signal);
  const timer: BackupTimer = { now: () => 0n, schedule() { return () => {}; } };
  try {
    expect((await git(["init", "--bare", bare], dir)).exitCode).toBe(0);
    const completed = Promise.withResolvers<Awaited<ReturnType<typeof runBackupAttempt>>>();
    void completed.promise.catch(() => {});
    daemon = await startDaemon({ dbPath, port: 0, credentials, backup: config }, () => {}, { logSink: () => {}, backupScheduler: { timer,
      async attempt(signal) {
        try { completed.resolve(await runBackupAttempt({ databasePath: dbPath, mediaDirectory: `${dbPath}.media`, config, signal, logger: createLogger("verbose", () => {}) }, { runGit })); }
        catch (error) { completed.reject(error); throw error; }
      },
    } });
    const first = await bounded(completed.promise, "real scheduled backup", 15000);
    expect(first.remoteConfirmed).toBe(true);
    expect((await git(["rev-parse", "refs/heads/backups"], bare)).stdout.trim()).toBe(first.localCommit);
    await daemon.stop(); daemon = undefined;
    const entered = Promise.withResolvers<number>();
    const logger = createLogger("verbose", record => {
      if (record.message !== "[backup] source snapshot established") return;
      const pid = record.context?.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Missing owned capture child");
      process.kill(pid, "SIGSTOP"); held = pid; entered.resolve(pid);
    });
    daemon = await startDaemon({ dbPath, port: 0, credentials, backup: config }, () => {}, { logSink: () => {}, backupScheduler: { timer,
      async attempt(signal) { await runBackupAttempt({ databasePath: dbPath, mediaDirectory: `${dbPath}.media`, config, signal, logger }, { runGit }); },
    } });
    const pid = await bounded(entered.promise, "held real source reader", 10000);
    await bounded(daemon.stop(), "real backup shutdown", 10000); daemon = undefined; held = undefined;
    await expect(lstat(`/proc/${pid}`)).rejects.toThrow();
    const after = await ExecutionOwnerLease.acquire(dbPath);
    try { expect((await git(["rev-parse", "refs/heads/backups"], bare)).stdout.trim()).toBe(first.localCommit); }
    finally { after.release(); }
  } finally {
    if (held !== undefined) process.kill(held, "SIGKILL");
    await daemon?.stop(); await rm(dir, { recursive: true, force: true });
  }
}, 45000);
