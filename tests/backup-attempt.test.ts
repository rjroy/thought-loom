import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateBackupConfig } from "../src/backup/config";
import { BackupCheckoutLease, type GitInvocation, type GitResult } from "../src/backup/git";
import { runBackupAttempt } from "../src/backup/run";
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

test("whole attempt waits for the real checkout lease before capture and retains snapshots across an offline retry", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-attempt-"), bare = join(dir, "remote.git"), checkout = join(dir, "checkout");
  const databasePath = join(dir, "knowledge.sqlite"), mediaDirectory = `${databasePath}.media`;
  let daemon: RunningDaemon | undefined;
  try {
    expect((await git(["init", "--bare", bare], dir, dir)).exitCode).toBe(0);
    daemon = await startDaemon({ dbPath: databasePath, port: 0, credentials }, () => {}, { logSink: () => {} });
    const config = validateBackupConfig({ repositoryUrl: remote, checkout, branch: "backups", intervalSeconds: null }, databasePath, mediaDirectory);
    const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remote}`;
    let gitCalls = 0;
    const runGit = (call: GitInvocation) => { gitCalls++; return git(["-c", redirect, ...call.args], call.cwd, dir, call.signal); };
    const logs: LogRecord[] = [], lockAttempt = Promise.withResolvers<void>();
    const logger = createLogger("verbose", record => {
      logs.push(record);
      if (record.message === "[backup] checkout lock acquisition attempt") lockAttempt.resolve();
    });
    const lease = await BackupCheckoutLease.acquire(config), controller = new AbortController();
    const blocked = runBackupAttempt({ databasePath, mediaDirectory, config, signal: controller.signal, logger }, { runGit });
    try {
      await Promise.race([lockAttempt.promise, Bun.sleep(5000).then(() => { throw new Error("Attempt never reached checkout lock"); })]);
      expect(logs.some(record => record.message === "[backup] source snapshot established")).toBe(false);
      expect(gitCalls).toBe(0);
      controller.abort(); await expect(blocked).rejects.toThrow();
      expect(logs.some(record => record.message === "[backup] source snapshot established")).toBe(false);
      await expect(access(checkout)).rejects.toThrow();
    } finally { controller.abort(); await Promise.allSettled([blocked]); await lease.release(); }
    const first = await runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit });
    expect(first.remoteConfirmed).toBe(true);
    expect((await git(["rev-parse", "refs/heads/backups"], bare, dir)).stdout.trim()).toBe(first.localCommit);
    const firstBytes = await readFile(join(first.snapshot.snapshotDirectory, "manifest.json"));
    const response = await fetch(new URL("/thoughts", daemon.url), { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" }, body: JSON.stringify({ text: "owned offline thought" }) });
    expect(response.status).toBe(201);
    const offline = join(dir, "offline.git"); await rename(bare, offline);
    try {
      const pending = await runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit });
      expect(pending.remoteConfirmed).toBe(false); expect(pending.localCommit).not.toBe(first.localCommit);
      const pendingBytes = await readFile(join(pending.snapshot.snapshotDirectory, "manifest.json"));
      expect(await readFile(join(first.snapshot.snapshotDirectory, "manifest.json"))).toEqual(firstBytes);
      await rename(offline, bare);
      const retried = await runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit });
      expect(retried.remoteConfirmed).toBe(true); expect(retried.localCommit).toBe(pending.localCommit);
      expect(retried.snapshot.manifestSha256).toBe(pending.snapshot.manifestSha256);
      expect(await readFile(join(pending.snapshot.snapshotDirectory, "manifest.json"))).toEqual(pendingBytes);
      expect((await git(["rev-parse", "refs/heads/backups"], bare, dir)).stdout.trim()).toBe(pending.localCommit);
    } finally {
      try { await rename(offline, bare); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    expect(JSON.stringify(logs)).not.toContain("owned offline thought");
    expect(JSON.stringify(logs)).not.toContain(remote);
    expect(JSON.stringify(logs)).not.toContain(credentials.user);
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 45000);

test("replaced capture roots, incomplete workspaces and source aliases are refused without adoption or deletion", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-workspace-"), bare = join(dir, "remote.git"), checkout = join(dir, "checkout");
  const databasePath = join(dir, "knowledge.sqlite"), mediaDirectory = `${databasePath}.media`;
  let daemon: RunningDaemon | undefined;
  try {
    expect((await git(["init", "--bare", bare], dir, dir)).exitCode).toBe(0);
    daemon = await startDaemon({ dbPath: databasePath, port: 0, credentials }, () => {}, { logSink: () => {} });
    const config = validateBackupConfig({ repositoryUrl: remote, checkout, branch: "backups", intervalSeconds: null }, databasePath, mediaDirectory);
    const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remote}`;
    const runGit = (call: GitInvocation) => git(["-c", redirect, ...call.args], call.cwd, dir, call.signal);
    const logger = createLogger("verbose", () => {}), first = await runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit });
    expect(first.remoteConfirmed).toBe(true);
    const captureRoot = join(dir, ".checkout.thoughtloom-captures"), displaced = join(dir, "displaced-captures");
    const originalNames = await readdir(captureRoot);
    await rename(captureRoot, displaced); await mkdir(captureRoot, { mode: 0o700 });
    await writeFile(join(captureRoot, "caller-owned"), "preserve", { mode: 0o600 });
    await expect(runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit })).rejects.toThrow();
    expect(await readdir(captureRoot)).toEqual(["caller-owned"]);
    expect(await readFile(join(captureRoot, "caller-owned"), "utf8")).toBe("preserve");
    expect(await readdir(displaced)).toEqual(originalNames);
    expect((await git(["rev-parse", "refs/heads/backups"], bare, dir)).stdout.trim()).toBe(first.localCommit);
    await rm(captureRoot, { recursive: true, force: true }); await rename(displaced, captureRoot);
    const record = join(dir, ".checkout.thoughtloom-backup", "capture-workspace.json"), savedRecord = join(dir, "saved-workspace-record");
    const recordBytes = await readFile(record);
    await rename(record, savedRecord); await writeFile(record, "unknown replacement", { mode: 0o600 });
    await expect(runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit })).rejects.toThrow();
    expect(await readFile(record, "utf8")).toBe("unknown replacement");
    expect(await readFile(savedRecord)).toEqual(recordBytes);
    expect(await readdir(captureRoot)).toEqual(originalNames);
    await rm(record); await rename(savedRecord, record);
    const incomplete = join(dir, ".partial.thoughtloom-captures");
    await mkdir(incomplete, { mode: 0o700 }); await writeFile(join(incomplete, "unowned"), "keep", { mode: 0o600 });
    const partial = { ...config, checkout: join(dir, "partial") };
    await expect(runBackupAttempt({ databasePath, mediaDirectory, config: partial, logger }, { runGit })).rejects.toThrow();
    expect(await readdir(incomplete)).toEqual(["unowned"]); expect(await readFile(join(incomplete, "unowned"), "utf8")).toBe("keep");
    const alias = join(dir, "database-alias.sqlite"); await symlink(databasePath, alias);
    await expect(runBackupAttempt({ databasePath: alias, mediaDirectory, config: partial, logger }, { runGit })).rejects.toThrow();
    expect(await readdir(captureRoot)).toEqual(originalNames);
    expect((await git(["rev-parse", "refs/heads/backups"], bare, dir)).stdout.trim()).toBe(first.localCommit);
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 30000);

test("a separate manual attempt cannot capture or call Git while the first attempt holds its pinned source snapshot", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-attempt-lock-"), bare = join(dir, "remote.git"), checkout = join(dir, "checkout");
  const databasePath = join(dir, "knowledge.sqlite"), mediaDirectory = `${databasePath}.media`, marker = join(dir, "contender");
  let daemon: RunningDaemon | undefined, held: number | undefined;
  let first: ReturnType<typeof runBackupAttempt> | undefined;
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
  let childTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    expect((await git(["init", "--bare", bare], dir, dir)).exitCode).toBe(0);
    daemon = await startDaemon({ dbPath: databasePath, port: 0, credentials }, () => {}, { logSink: () => {} });
    const config = validateBackupConfig({ repositoryUrl: remote, checkout, branch: "backups", intervalSeconds: null }, databasePath, mediaDirectory);
    const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remote}`, ready = Promise.withResolvers<void>();
    const logger = createLogger("verbose", record => {
      if (record.message !== "[backup] source snapshot established") return;
      const pid = record.context?.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Missing owned capture child");
      process.kill(pid, "SIGSTOP"); held = pid; ready.resolve();
    });
    first = runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit: call => git(["-c", redirect, ...call.args], call.cwd, dir, call.signal) });
    void first.catch(() => {});
    await Promise.race([ready.promise, Bun.sleep(8000).then(() => { throw new Error("Source snapshot boundary timed out"); })]);
    const script = fileURLToPath(new URL("./backup-attempt-child.ts", import.meta.url));
    child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script, dir, bare, databasePath, mediaDirectory, JSON.stringify(config), marker],
      cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: dir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    childTimeout = setTimeout(() => child?.kill("SIGKILL"), 15000);
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await access(`${marker}.lock`); break; } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error("Contender did not reach lease acquisition");
        await Bun.sleep(10);
      }
    }
    await expect(access(`${marker}.source`)).rejects.toThrow(); await expect(access(`${marker}.git`)).rejects.toThrow();
    if (held === undefined) throw new Error("Owned source process was not held");
    process.kill(held, "SIGCONT"); held = undefined;
    const initial = await first;
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Owned contender failed: ${stderr}`);
    const second = JSON.parse(stdout) as Awaited<ReturnType<typeof runBackupAttempt>>;
    expect(initial.remoteConfirmed).toBe(true); expect(second.remoteConfirmed).toBe(true);
    expect(second.localCommit).toBe(initial.localCommit); await access(`${marker}.source`); await access(`${marker}.git`);
  } finally {
    if (childTimeout) clearTimeout(childTimeout);
    if (held !== undefined) process.kill(held, "SIGKILL");
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child) await child.exited;
    if (first) await Promise.allSettled([first]);
    await daemon?.stop(); await rm(dir, { recursive: true, force: true });
  }
}, 30000);
