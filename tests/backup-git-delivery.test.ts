import { expect, test } from "bun:test";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureBackup, type CaptureResult } from "../src/backup/capture";
import { validateBackupConfig, type BackupConfig } from "../src/backup/config";
import { BackupCheckoutLease, deliverBackup, type GitInvocation, type GitResult } from "../src/backup/git";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger } from "../src/logging";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const remoteUrl = "https://backup.invalid/owned/fixture.git";
const logger = createLogger("verbose", () => {});

async function processGit(args: readonly string[], cwd: string, home: string, signal?: AbortSignal, globalConfig = "/dev/null"): Promise<GitResult> {
  const child = Bun.spawn({ cmd: ["git", ...args], cwd, signal, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
    PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid",
    GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid",
  } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

interface Fixture {
  readonly dir: string; readonly bare: string; readonly checkout: string; readonly output: string;
  readonly daemon: RunningDaemon; readonly config: BackupConfig;
  readonly runGit: (invocation: GitInvocation) => Promise<GitResult>;
  git(cwd: string, ...args: string[]): Promise<string>;
  capture(): Promise<CaptureResult>;
  deliver(snapshot: CaptureResult): ReturnType<typeof deliverBackup>;
  addThought(text: string): Promise<void>;
}

async function owned(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/backup-git-"), bare = join(dir, "remote.git"), checkout = join(dir, "checkout");
  const dbPath = join(dir, "knowledge.sqlite"), media = `${dbPath}.media`, output = join(dir, "captures");
  let daemon: RunningDaemon | undefined;
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await processGit(args, cwd, dir);
    if (result.exitCode !== 0) throw new Error(`Owned Git fixture command failed: ${args[0]}`);
    return result.stdout.trim();
  }
  try {
    await mkdir(output, { mode: 0o700 });
    await git(dir, "init", "--bare", bare);
    daemon = await startDaemon({ dbPath, port: 0, credentials }, () => {}, { logSink: () => {} });
    const config = validateBackupConfig({ repositoryUrl: remoteUrl, checkout, branch: "backups", intervalSeconds: null }, dbPath, media);
    const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remoteUrl}`;
    const runGit = (invocation: GitInvocation) => processGit(["-c", redirect, ...invocation.args], invocation.cwd, dir, invocation.signal);
    const current = daemon;
    await action({ dir, bare, checkout, output, daemon: current, config, runGit, git,
      capture: () => captureBackup({ databasePath: dbPath, mediaDirectory: media, outputDirectory: output, logger }),
      deliver: snapshot => deliverBackup({ snapshot, config, logger }, { runGit }),
      async addThought(text) {
        const response = await fetch(new URL("/thoughts", current.url), { method: "POST", signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });
        expect(response.status).toBe(201);
      },
    });
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}

async function fileNames(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) paths.push(relative(root, path));
      else throw new Error("Unexpected non-file snapshot entry");
    }
  }
  await walk(root); return paths.sort();
}

async function restartDelivery(f: Fixture, snapshot: CaptureResult, mode = ""): ReturnType<typeof deliverBackup> {
  const childScript = fileURLToPath(new URL("./backup-git-child.ts", import.meta.url));
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", childScript, f.dir, f.bare, JSON.stringify(f.config), JSON.stringify(snapshot), "", mode],
    cwd: f.dir, env: { PATH: "/usr/bin:/bin", HOME: f.dir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0 && (mode === "umask-002" || mode === "umask-077")) {
      let childDiagnostic: unknown;
      try { childDiagnostic = JSON.parse(stderr); } catch { childDiagnostic = null; }
      const initFinished = typeof childDiagnostic === "object" && childDiagnostic !== null && "initFinished" in childDiagnostic && childDiagnostic.initFinished === true;
      const reason = typeof childDiagnostic === "object" && childDiagnostic !== null && "code" in childDiagnostic && typeof childDiagnostic.code === "string" ? childDiagnostic.code : "unknown";
      let gitMode: string | null = null, configState = "missing", headState = "missing", pendingState = "missing";
      try { gitMode = (await lstat(join(f.checkout, ".git"))).mode.toString(8).slice(-3); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      const control = join(dirname(f.checkout), `.${basename(f.checkout)}.thoughtloom-backup`, "state.json");
      try {
        const state: unknown = JSON.parse(await readFile(control, "utf8"));
        if (typeof state === "object" && state !== null) {
          configState = "configSha256" in state ? state.configSha256 === null ? "null" : "present" : "absent-field";
          headState = "head" in state ? state.head === null ? "null" : "present" : "absent-field";
          pendingState = "pending" in state ? state.pending === null ? "null" : "present" : "absent-field";
        }
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      throw new Error(`Owned ${mode} delivery failed: ${JSON.stringify({ reason, initFinished, gitMode, configState, headState, pendingState })}`);
    }
    if (code !== 0) throw new Error(`Owned retry process failed: ${stderr}`);
    return JSON.parse(stdout) as Awaited<ReturnType<typeof deliverBackup>>;
  } finally { clearTimeout(timer); }
}

test("delivery commits and pushes only the snapshot, advances on change and is a no-op when unchanged", async () => owned(async f => {
  const first = await f.capture(), sent = await f.deliver(first);
  expect(sent.remoteConfirmed).toBe(true);
  expect(sent.localCommit).toMatch(/^[0-9a-f]{40,64}$/);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(sent.localCommit);
  const expected = (await fileNames(first.snapshotDirectory)).map(path => `snapshot/${path}`).sort();
  expect((await f.git(f.bare, "ls-tree", "-r", "--name-only", sent.localCommit)).split("\n").sort()).toEqual(expected);
  expect(await f.git(f.bare, "show", `${sent.localCommit}:snapshot/manifest.json`))
    .toBe((await readFile(join(first.snapshotDirectory, "manifest.json"), "utf8")).trimEnd());
  const repeat = await f.deliver(await f.capture());
  expect(repeat.remoteConfirmed).toBe(true); expect(repeat.localCommit).toBe(sent.localCommit);
  expect(await f.git(f.checkout, "rev-list", "--count", sent.localCommit)).toBe("1");
  await f.addThought("owned changed source");
  const changed = await f.capture(), next = await f.deliver(changed);
  expect(next.remoteConfirmed).toBe(true); expect(next.localCommit).not.toBe(sent.localCommit);
  expect(await f.git(f.checkout, "rev-parse", `${next.localCommit}^`)).toBe(sent.localCommit);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(next.localCommit);
  expect((await f.git(f.bare, "ls-tree", "-r", "--name-only", next.localCommit)).split("\n").sort())
    .toEqual((await fileNames(changed.snapshotDirectory)).map(path => `snapshot/${path}`).sort());
}), 30000);

test("default Git runner control delivers with an owned private umask 0077", async () => owned(async f => {
  const snapshot = await f.capture(), sent = await restartDelivery(f, snapshot, "umask-077");
  expect(sent.remoteConfirmed).toBe(true);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(sent.localCommit);
  expect((await lstat(join(f.checkout, ".git"))).mode & 0o777).toBe(0o700);
  expect(await f.git(f.bare, "show", `${sent.localCommit}:snapshot/manifest.json`))
    .toBe((await readFile(join(snapshot.snapshotDirectory, "manifest.json"), "utf8")).trimEnd());
}), 30000);

test("child delivery under inherited umask 0002 keeps Git metadata safe through change and offline retry", async () => owned(async f => {
  async function metadataSafe(): Promise<void> {
    const root = join(f.checkout, ".git");
    expect((await lstat(f.checkout)).mode & 0o777).toBe(0o700);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "config"))).mode & 0o777).toBe(0o600);
    async function walk(path: string): Promise<void> {
      const entry = await lstat(path);
      expect(entry.isSymbolicLink()).toBe(false);
      expect(entry.mode & 0o022).toBe(0);
      if (entry.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
      else expect(entry.isFile()).toBe(true);
    }
    await walk(root);
  }
  const firstSnapshot = await f.capture();
  const first = await restartDelivery(f, firstSnapshot, "umask-002");
  expect(first.remoteConfirmed).toBe(true);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(first.localCommit);
  await metadataSafe();
  await f.addThought("owned umask changed source");
  const changedSnapshot = await f.capture(), changed = await restartDelivery(f, changedSnapshot, "umask-002");
  expect(changed.remoteConfirmed).toBe(true);
  expect(await f.git(f.checkout, "rev-parse", `${changed.localCommit}^`)).toBe(first.localCommit);
  await metadataSafe();
  await f.addThought("owned umask pending source");
  const pendingSnapshot = await f.capture(), originalManifest = await readFile(join(pendingSnapshot.snapshotDirectory, "manifest.json"));
  const offline = join(f.dir, "umask-offline.git"); await rename(f.bare, offline);
  try {
    const pending = await restartDelivery(f, pendingSnapshot, "umask-002");
    expect(pending.remoteConfirmed).toBe(false);
    expect(await f.git(f.checkout, "rev-parse", `${pending.localCommit}^`)).toBe(changed.localCommit);
    expect(await readFile(join(pendingSnapshot.snapshotDirectory, "manifest.json"))).toEqual(originalManifest);
    await metadataSafe();
    await rename(offline, f.bare);
    const retried = await restartDelivery(f, pendingSnapshot, "umask-002");
    expect(retried.remoteConfirmed).toBe(true); expect(retried.localCommit).toBe(pending.localCommit);
    expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(pending.localCommit);
    expect(await f.git(f.checkout, "rev-list", "--count", pending.localCommit)).toBe("3");
    expect(await f.git(f.bare, "show", `${pending.localCommit}:snapshot/manifest.json`)).toBe(originalManifest.toString("utf8").trimEnd());
    await metadataSafe();
  } finally {
    try { await rename(offline, f.bare); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}), 60000);

test("offline delivery retains the commit and snapshot, then retries that same commit after restart", async () => owned(async f => {
  const first = await f.deliver(await f.capture());
  expect(first.remoteConfirmed).toBe(true);
  await f.addThought("offline retained source");
  const snapshot = await f.capture(), manifest = await readFile(join(snapshot.snapshotDirectory, "manifest.json"));
  const offline = join(f.dir, "offline-remote.git");
  await rename(f.bare, offline);
  try {
    const pending = await f.deliver(snapshot);
    expect(pending.remoteConfirmed).toBe(false);
    expect(pending.localCommit).not.toBe(first.localCommit);
    expect(await f.git(f.checkout, "rev-parse", "HEAD")).toBe(pending.localCommit);
    expect(await readFile(join(snapshot.snapshotDirectory, "manifest.json"))).toEqual(manifest);
    await rename(offline, f.bare);
    // Retry in a fresh Bun process, with no in-memory delivery state from the failed attempt.
    const retried = await restartDelivery(f, snapshot);
    expect(retried.remoteConfirmed).toBe(true); expect(retried.localCommit).toBe(pending.localCommit);
    expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(pending.localCommit);
    expect(await f.git(f.checkout, "rev-list", "--count", pending.localCommit)).toBe("2");
  } finally {
    // Restore only this fixture's owned remote if the test failed during the offline phase.
    try { await rename(offline, f.bare); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}), 30000);

test("remote divergence never resets, merges or force-pushes either history", async () => owned(async f => {
  const first = await f.deliver(await f.capture()); expect(first.remoteConfirmed).toBe(true);
  const outsider = join(f.dir, "other-checkout");
  await f.git(f.dir, "clone", "--branch", "backups", f.bare, outsider);
  await writeFile(join(outsider, "external.txt"), "owned external change\n");
  await f.git(outsider, "add", "external.txt"); await f.git(outsider, "commit", "-m", "external fixture");
  await f.git(outsider, "push", "origin", "backups");
  const external = await f.git(f.bare, "rev-parse", "refs/heads/backups");
  await f.addThought("divergent local change");
  const snapshot = await f.capture(), result = await f.deliver(snapshot);
  expect(result.remoteConfirmed).toBe(false);
  expect(result.localCommit).not.toBe(first.localCommit);
  expect(await f.git(f.checkout, "rev-parse", "HEAD")).toBe(result.localCommit);
  expect(await f.git(f.checkout, "rev-parse", `${result.localCommit}^`)).toBe(first.localCommit);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(external);
  expect(await f.git(f.bare, "rev-parse", `${external}^`)).toBe(first.localCommit);
  expect(await f.git(f.bare, "show", `${external}:external.txt`)).toBe("owned external change");
  const retry = await f.deliver(snapshot);
  expect(retry.remoteConfirmed).toBe(false); expect(retry.localCommit).toBe(result.localCommit);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(external);
}), 30000);

test("unrelated, symlinked and dirty checkout paths are refused without modifying caller files", async () => owned(async f => {
  const snapshot = await f.capture(), unrelated = join(f.dir, "unrelated"), alias = join(f.dir, "alias");
  await mkdir(unrelated, { mode: 0o700 });
  const sentinel = join(unrelated, "caller.txt"); await writeFile(sentinel, "caller-owned\n", { mode: 0o600 });
  const deliverAt = (checkout: string) => deliverBackup({ snapshot, config: { ...f.config, checkout }, logger }, { runGit: f.runGit });
  await expect(deliverAt(unrelated)).rejects.toThrow();
  expect(await readdir(unrelated)).toEqual(["caller.txt"]); expect(await readFile(sentinel, "utf8")).toBe("caller-owned\n");
  await symlink(unrelated, alias);
  await expect(deliverAt(alias)).rejects.toThrow();
  expect(await readdir(unrelated)).toEqual(["caller.txt"]); expect(await readFile(sentinel, "utf8")).toBe("caller-owned\n");
  const first = await f.deliver(snapshot); expect(first.remoteConfirmed).toBe(true);
  const dirty = join(f.checkout, "caller-dirty.txt"); await writeFile(dirty, "must not stage or delete\n", { mode: 0o600 });
  const status = await f.git(f.checkout, "status", "--porcelain");
  await f.addThought("new snapshot cannot consume dirty checkout");
  await expect(f.deliver(await f.capture())).rejects.toThrow();
  expect(await readFile(dirty, "utf8")).toBe("must not stage or delete\n");
  expect(await f.git(f.checkout, "status", "--porcelain")).toBe(status);
  expect(await f.git(f.checkout, "rev-parse", "HEAD")).toBe(first.localCommit);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(first.localCommit);
}), 30000);

test("unexpected refs, symbolic tracking and non-ancestor tracking cannot be adopted or rewritten", async () => {
  for (const scenario of ["extra-ref", "symbolic", "unrelated-oid"] as const) await owned(async f => {
    const snapshot = await f.capture(), first = await f.deliver(snapshot);
    expect(first.remoteConfirmed).toBe(true);
    const tracking = "refs/remotes/origin/backups";
    if (scenario === "extra-ref") await f.git(f.checkout, "update-ref", "refs/tags/unexpected", first.localCommit);
    if (scenario === "symbolic") await f.git(f.checkout, "symbolic-ref", tracking, "refs/heads/backups");
    if (scenario === "unrelated-oid") {
      const tree = await f.git(f.checkout, "rev-parse", `${first.localCommit}^{tree}`);
      const unrelated = await f.git(f.checkout, "commit-tree", tree, "-m", "unrelated fixture");
      await f.git(f.checkout, "update-ref", tracking, unrelated);
    }
    const refs = await f.git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname) %(symref)");
    await expect(f.deliver(snapshot)).rejects.toThrow();
    expect(await f.git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname) %(symref)")).toBe(refs);
    expect(await f.git(f.checkout, "rev-parse", "HEAD")).toBe(first.localCommit);
    expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(first.localCommit);
  });
}, 90000);

test("held checkout lease composes with delivery and excludes a separate process until release", async () => owned(async f => {
  const snapshot = await f.capture(), lease = await BackupCheckoutLease.acquire(f.config);
  const marker = join(f.dir, "contender"), script = fileURLToPath(new URL("./backup-git-child.ts", import.meta.url));
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script, f.dir, f.bare, JSON.stringify(f.config), JSON.stringify(snapshot), marker],
    cwd: f.dir, env: { PATH: "/usr/bin:/bin", HOME: f.dir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  let released = false;
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      try { await access(`${marker}.attempt`); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error("Contender did not reach its lock boundary");
        await Bun.sleep(10);
      }
    }
    await expect(access(`${marker}.git`)).rejects.toThrow();
    const controller = new AbortController();
    const blocked = BackupCheckoutLease.acquire(f.config, controller.signal); controller.abort();
    await expect(blocked).rejects.toThrow();
    const ownedResult = await deliverBackup({ snapshot, config: f.config, logger }, { runGit: f.runGit, lease });
    expect(ownedResult.remoteConfirmed).toBe(true);
    await expect(access(`${marker}.git`)).rejects.toThrow();
    await lease.release(); released = true;
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Owned contender failed: ${stderr}`);
    const result = JSON.parse(stdout) as Awaited<ReturnType<typeof deliverBackup>>;
    expect(result).toEqual(ownedResult); await access(`${marker}.git`);
    expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(ownedResult.localCommit);
  } finally {
    clearTimeout(timer);
    if (!released) await lease.release();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}), 30000);

test("an OS-terminated lease owner releases its actual lock for a later delivery", async () => owned(async f => {
  const snapshot = await f.capture(), marker = join(f.dir, "lease-held");
  const script = fileURLToPath(new URL("./backup-git-lease-child.ts", import.meta.url));
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script, JSON.stringify(f.config), marker], cwd: f.dir,
    env: { PATH: "/usr/bin:/bin", HOME: f.dir }, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await access(marker); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error("Lease holder did not acquire lock");
        await Bun.sleep(10);
      }
    }
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    const lease = await BackupCheckoutLease.acquire(f.config);
    try { expect((await deliverBackup({ snapshot, config: f.config, logger }, { runGit: f.runGit, lease })).remoteConfirmed).toBe(true); }
    finally { await lease.release(); }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}), 20000);

test("completed add or commit with a lost acknowledgement recovers the recorded update in a fresh process", async () => {
  for (const operation of ["add", "commit"] as const) await owned(async f => {
    const first = await f.deliver(await f.capture()); expect(first.remoteConfirmed).toBe(true);
    await f.addThought(`owned interrupted ${operation}`);
    const snapshot = await f.capture(); let injected = false;
    const runGit = async (invocation: GitInvocation): Promise<GitResult> => {
      const result = await f.runGit(invocation);
      if (!injected && invocation.args.includes(operation) && result.exitCode === 0) {
        injected = true; throw new Error("owned lost acknowledgement");
      }
      return result;
    };
    await expect(deliverBackup({ snapshot, config: f.config, logger }, { runGit })).rejects.toThrow();
    expect(injected).toBe(true);
    const retried = await restartDelivery(f, snapshot);
    expect(retried.remoteConfirmed).toBe(true);
    expect(await f.git(f.checkout, "rev-parse", `${retried.localCommit}^`)).toBe(first.localCommit);
    expect(await f.git(f.checkout, "rev-list", "--count", retried.localCommit)).toBe("2");
    expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(retried.localCommit);
  });
}, 60000);

test("unknown pending HEAD, index or file changes are refused without reset", async () => {
  for (const scenario of ["head", "index", "file"] as const) await owned(async f => {
    const first = await f.deliver(await f.capture());
    await f.addThought("owned pending tamper");
    const snapshot = await f.capture(); let injected = false;
    const runGit = async (invocation: GitInvocation): Promise<GitResult> => {
      const result = await f.runGit(invocation);
      if (!injected && invocation.args.includes("commit") && result.exitCode === 0) { injected = true; throw new Error("lost commit acknowledgement"); }
      return result;
    };
    await expect(deliverBackup({ snapshot, config: f.config, logger }, { runGit })).rejects.toThrow();
    expect(injected).toBe(true);
    const manifest = join(f.checkout, "snapshot", "manifest.json");
    if (scenario === "head") await f.git(f.checkout, "commit", "--amend", "--no-gpg-sign", "-m", "unknown external change");
    if (scenario === "index") {
      const blobFile = join(f.dir, "unknown-index-bytes"); await writeFile(blobFile, "unknown index change\n");
      const blob = await f.git(f.checkout, "hash-object", "-w", blobFile);
      await f.git(f.checkout, "update-index", "--cacheinfo", `100644,${blob},snapshot/manifest.json`);
    }
    if (scenario === "file") await writeFile(manifest, "unknown user change\n");
    const head = await f.git(f.checkout, "rev-parse", "HEAD"), index = await f.git(f.checkout, "ls-files", "--stage"), bytes = await readFile(manifest);
    expect(head).not.toBe(first.localCommit);
    await expect(restartDelivery(f, snapshot)).rejects.toThrow();
    expect(await readFile(manifest)).toEqual(bytes);
    expect(await f.git(f.checkout, "rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.checkout, "ls-files", "--stage")).toBe(index);
    expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(first.localCommit);
  });
}, 90000);

test("an acknowledged-as-failed real push is confirmed only by a subsequent remote read", async () => owned(async f => {
  const first = await f.deliver(await f.capture());
  await f.addThought("owned uncertain push"); const snapshot = await f.capture();
  let injected = false, observedPush = "";
  const runGit = async (invocation: GitInvocation): Promise<GitResult> => {
    const result = await f.runGit(invocation);
    if (!injected && invocation.args.includes("push") && result.exitCode === 0) {
      injected = true; observedPush = await f.git(f.bare, "rev-parse", "refs/heads/backups");
      throw new Error("owned lost push acknowledgement");
    }
    return result;
  };
  const result = await deliverBackup({ snapshot, config: f.config, logger }, { runGit });
  expect(injected).toBe(true); expect(observedPush).toBe(result.localCommit); expect(result.remoteConfirmed).toBe(true);
  expect(await f.git(f.checkout, "rev-parse", `${result.localCommit}^`)).toBe(first.localCommit);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(result.localCommit);
  expect((await restartDelivery(f, snapshot)).localCommit).toBe(result.localCommit);
}), 30000);

test("a fresh dedicated checkout adopts valid backup history but refuses unrelated remote content", async () => owned(async f => {
  const snapshot = await f.capture(), first = await f.deliver(snapshot);
  expect(first.remoteConfirmed).toBe(true);
  const newConfig = { ...f.config, checkout: join(f.dir, "fresh-checkout") };
  const adopted = await deliverBackup({ snapshot, config: newConfig, logger }, { runGit: f.runGit });
  expect(adopted).toEqual(first);
  expect(await f.git(newConfig.checkout, "rev-parse", "HEAD")).toBe(first.localCommit);
  expect(await f.git(newConfig.checkout, "rev-list", "--count", "HEAD")).toBe("1");
  const outsider = join(f.dir, "external-checkout");
  await f.git(f.dir, "clone", "--branch", "backups", f.bare, outsider);
  await writeFile(join(outsider, "unrelated.txt"), "unrelated remote data\n");
  await f.git(outsider, "add", "unrelated.txt"); await f.git(outsider, "commit", "-m", "external fixture");
  await f.git(outsider, "push", "origin", "backups");
  const external = await f.git(f.bare, "rev-parse", "refs/heads/backups");
  const refused = { ...f.config, checkout: join(f.dir, "refused-checkout") };
  await expect(deliverBackup({ snapshot, config: refused, logger }, { runGit: f.runGit })).rejects.toThrow();
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(external);
  expect(await f.git(f.bare, "show", `${external}:unrelated.txt`)).toBe("unrelated remote data");
  expect(await f.git(f.checkout, "rev-parse", "HEAD")).toBe(first.localCommit);
}), 30000);

test("owned host hooks, attribute filters and signing configuration cannot execute during delivery", async () => owned(async f => {
  const hooks = join(f.dir, "host-hooks"), attributes = join(f.dir, "host-attributes"), config = join(f.dir, "host-gitconfig");
  const marker = join(f.dir, "host-code-ran"), script = join(f.dir, "host-helper");
  await mkdir(hooks, { mode: 0o700 });
  const executable = `#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`;
  await writeFile(join(hooks, "pre-commit"), executable, { mode: 0o700 });
  await writeFile(script, executable, { mode: 0o700 });
  await writeFile(attributes, "* filter=owned-trap\n", { mode: 0o600 });
  await writeFile(config, `[core]\n\thooksPath = ${hooks}\n\tattributesFile = ${attributes}\n[filter "owned-trap"]\n\tclean = ${script}\n\tsmudge = ${script}\n\trequired = true\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${script}\n`, { mode: 0o600 });
  const redirect = `url.${pathToFileURL(f.bare).href}.insteadOf=${remoteUrl}`;
  const runGit = (invocation: GitInvocation) => processGit(["-c", redirect, ...invocation.args], invocation.cwd, f.dir, invocation.signal, config);
  const snapshot = await f.capture(), result = await deliverBackup({ snapshot, config: f.config, logger }, { runGit });
  expect(result.remoteConfirmed).toBe(true);
  await expect(access(marker)).rejects.toThrow();
  expect(await f.git(f.bare, "show", `${result.localCommit}:snapshot/manifest.json`))
    .toBe((await readFile(join(snapshot.snapshotDirectory, "manifest.json"), "utf8")).trimEnd());
}), 30000);

test("default Git runner aborts and joins its owned helper process group", async () => owned(async f => {
  const marker = join(f.dir, "process-marker"), helper = join(f.dir, "owned-git-helper");
  await writeFile(helper, `#!/bin/sh\nprintf '%s' "$$" > '${marker}.shell'\n/bin/sleep 60 &\nprintf '%s' "$!" > '${marker}.sleep'\nwait\n`, { mode: 0o700 });
  const script = fileURLToPath(new URL("./backup-git-abort-child.ts", import.meta.url));
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script, f.dir, helper, marker], cwd: f.dir,
    env: { PATH: "/usr/bin:/bin", HOME: f.dir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Owned abort process failed: ${stderr}`);
    expect(JSON.parse(stdout)).toEqual({ code: "aborted" });
    for (const kind of ["shell", "sleep"]) {
      const pid = Number(await readFile(`${marker}.${kind}`, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      const deadline = Date.now() + 3000;
      for (;;) {
        try {
          const status = await readFile(`/proc/${pid}/status`, "utf8");
          if (/^State:\s*Z/m.test(status)) break;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error("Owned Git helper survived cancellation");
        await Bun.sleep(10);
      }
    }
  } finally { clearTimeout(timer); }
}), 15000);
