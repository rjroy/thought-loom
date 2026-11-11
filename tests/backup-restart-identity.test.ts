import { expect, test } from "bun:test";
import { chmod, copyFile, cp, link, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupCheckoutLease, type GitInvocation, type GitResult } from "../src/backup/git";
import { sourceGuard } from "../src/backup/capture-files";
import { runBackupAttempt } from "../src/backup/run";
import { BackupScheduler, type BackupTimer } from "../src/backup/scheduler";
import { createLogger } from "../src/logging";
import { assertNoIdentityMaintenance, bounded, checkoutWitness, owned, privateText, recordBytes, records, safeReasons, seedRecords, witness, writeRecord,
  type Binding, type ChildResult, type Fixture, type RecordPaths } from "./backup-restart-fixture";

const bindings: readonly { readonly name: string; readonly fields: readonly Binding[] }[] = [
  { name: "checkout", fields: ["checkout"] }, { name: "capture", fields: ["capture"] },
  { name: "source database", fields: ["source"] }, { name: "all", fields: ["checkout", "capture", "source"] },
];

// Public behavior RED stays runnable on v1 production. Only explicit format cases
// below require v2 support; no fixture setup imports or assumes a future API.
for (const binding of bindings) test(`ordinary fresh manual attempts tolerate repeated legacy ${binding.name} device epochs without rewriting identities`, async () => owned(async f => {
  const first = await f.attempt(), checkout = await checkoutWitness(f), captures = await witness(f.captures), source = await witness(f.databasePath);
  expect(first.remoteConfirmed).toBe(true);
  for (const epoch of [1024, 2048, 4096]) {
    await seedRecords(f, 1, 1, epoch, binding.fields);
    const bytes = await recordBytes(f), control = await witness(f.control); f.clearObservations();
    const result = await f.fresh(epoch === 2048 ? "command" : "attempt");
    expect(result.exitCode).toBe(0);
    if (result.attempt) { expect(result.attempt.remoteConfirmed).toBe(true); expect(result.attempt.localCommit).toBe(first.localCommit); expect(result.attempt.snapshot).toEqual(first.snapshot); }
    else expect(result.commandExit).toBe(0);
    expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.control)).toEqual(control);
    expect(await checkoutWitness(f)).toEqual(checkout); expect(await witness(f.captures)).toEqual(captures); expect(await witness(f.databasePath)).toEqual(source);
    expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(first.localCommit);
    expect(await f.git(f.checkout, "rev-list", "--count", "HEAD")).toBe("1");
    expect(f.logs.some(record => record.message === "[backup] source snapshot established")).toBe(true);
    for (const call of f.calls) for (const operation of ["init", "fetch", "add", "commit", "checkout", "reset", "clean", "update-ref", "gc", "repack"])
      expect(call.args.includes(operation)).toBe(false);
    assertNoIdentityMaintenance(f);
  }
}), 45000);

test("a fresh zero-argument manual command characterizes unchanged v1 compatibility before device drift", async () => owned(async f => {
  const first = await f.attempt(); await seedRecords(f, 1, 1);
  const bytes = await recordBytes(f), control = await witness(f.control), captures = await witness(f.captures); f.clearObservations();
  const result = await f.fresh("command"); expect(result.exitCode).toBe(0); expect(result.commandExit).toBe(0);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.control)).toEqual(control); expect(await witness(f.captures)).toEqual(captures);
  expect(await f.git(f.checkout, "rev-parse", "HEAD")).toBe(first.localCommit); assertNoIdentityMaintenance(f);
}), 30000);

test("ordinary offline retries across device epochs preserve all unpushed commits and snapshots until normal delivery", async () => owned(async f => {
  const first = await f.attempt(), offline = join(f.dir, "offline.git"); await rename(f.bare, offline);
  await f.addThought(); const second = await f.attempt(); expect(second.remoteConfirmed).toBe(false);
  await f.addThought(`${privateText} second`); const third = await f.attempt(); expect(third.remoteConfirmed).toBe(false);
  const captures = await witness(f.captures), checkout = await checkoutWitness(f), remote = await witness(offline);
  expect(await f.git(f.checkout, "rev-parse", `${third.localCommit}^`)).toBe(second.localCommit);
  expect(await f.git(f.checkout, "rev-parse", `${second.localCommit}^`)).toBe(first.localCommit);
  for (const epoch of [1024, 2048]) {
    await seedRecords(f, 1, 1, epoch); const bytes = await recordBytes(f); f.clearObservations();
    const result = await f.fresh(); expect(result.exitCode).toBe(0); expect(result.attempt?.remoteConfirmed).toBe(false); expect(result.attempt?.localCommit).toBe(third.localCommit);
    expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.captures)).toEqual(captures); expect(await checkoutWitness(f)).toEqual(checkout);
    expect(await witness(offline)).toEqual(remote); assertNoIdentityMaintenance(f);
  }
  await rename(offline, f.bare); await seedRecords(f, 1, 1, 4096); const bytes = await recordBytes(f); f.clearObservations();
  const delivered = await f.fresh(); expect(delivered.exitCode).toBe(0); expect(delivered.attempt?.remoteConfirmed).toBe(true); expect(delivered.attempt?.localCommit).toBe(third.localCommit);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.captures)).toEqual(captures);
  expect(await f.git(f.bare, "rev-list", "--count", "refs/heads/backups")).toBe("3"); assertNoIdentityMaintenance(f);
}), 45000);

class WakeClock implements BackupTimer {
  private time = 0n;
  private event: { due: bigint; callback: () => void } | undefined;
  now(): bigint { return this.time; }
  schedule(delayMs: number, callback: () => void): () => void {
    const event = { due: this.time + BigInt(delayMs), callback }; this.event = event;
    return () => { if (this.event === event) this.event = undefined; };
  }
  tick(): void {
    this.time += 1000n; const event = this.event;
    if (event && event.due <= this.time) { this.event = undefined; event.callback(); }
  }
}

test("the real scheduler seam launches fresh ordinary operations across successive device epochs", async () => owned(async f => {
  const first = await f.attempt(), captures = await witness(f.captures), clock = new WakeClock();
  let next = Promise.withResolvers<ChildResult & { exitCode: number }>(), entries = 0;
  const scheduler = new BackupScheduler({ intervalSeconds: 1, timer: clock, logger: f.logger, async attempt(signal) {
    expect(signal.aborted).toBe(false); entries++; next.resolve(await f.fresh());
  } });
  try {
    for (const epoch of [0, 1024, 2048]) {
      await seedRecords(f, 1, 1, epoch); const bytes = await recordBytes(f); next = Promise.withResolvers(); f.clearObservations();
      if (epoch === 0) scheduler.start(); else clock.tick();
      const result = await bounded(next.promise);
      expect(result.exitCode).toBe(0); expect(result.attempt?.remoteConfirmed).toBe(true); expect(result.attempt?.localCommit).toBe(first.localCommit);
      expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.captures)).toEqual(captures); assertNoIdentityMaintenance(f);
    }
    expect(entries).toBe(3);
  } finally { await scheduler.stop(); }
}), 45000);

test("device compatibility does not turn ordinary attempts into unselected-capture archival scrubs", async () => owned(async f => {
  const first = await f.attempt(); await f.addThought(); const current = await f.attempt();
  const oldTable = join(first.snapshot.snapshotDirectory, "tables", "thoughts.json"); await writeFile(oldTable, "unselected archived corruption\n");
  const oldTree = await witness(first.snapshot.snapshotDirectory);
  expect((await f.attempt()).localCommit).toBe(current.localCommit); // Existing normal scope, before any device mismatch.
  await seedRecords(f, 1, 1, 1024); const bytes = await recordBytes(f); f.clearObservations();
  const result = await f.fresh(); expect(result.exitCode).toBe(0); expect(result.attempt?.localCommit).toBe(current.localCommit);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(first.snapshot.snapshotDirectory)).toEqual(oldTree); assertNoIdentityMaintenance(f);
}), 30000);

test("new ownership records are device-free v2 without changing portable snapshot bytes", async () => owned(async f => {
  const first = await f.attempt(), { state, workspace } = await records(f);
  expect(state.version).toBe(2); expect(workspace.version).toBe(2);
  expect(Object.keys(state)).toEqual(["version", "repositoryUrl", "branch", "ino", "configSha256", "head", "manifest", "pending"]);
  expect(Object.keys(workspace)).toEqual(["version", "checkout", "repositoryUrl", "branch", "path", "ino", "databasePath", "databaseIno", "mediaDirectory"]);
  expect(state.ino).toBe((await lstat(f.checkout, { bigint: true })).ino.toString());
  expect(workspace.ino).toBe((await lstat(f.captures, { bigint: true })).ino.toString());
  expect(workspace.databaseIno).toBe((await lstat(f.databasePath, { bigint: true })).ino.toString());
  const bytes = await recordBytes(f), repeat = await f.attempt(); expect(repeat.snapshot).toEqual(first.snapshot); expect(repeat.localCommit).toBe(first.localCommit);
  expect(await recordBytes(f)).toEqual(bytes);
}), 30000);

for (const [stateVersion, workspaceVersion] of [[1, 1], [1, 2], [2, 1], [2, 2]] as const)
  test(`mixed state v${stateVersion}/workspace v${workspaceVersion} is normalized read-only without a paired migration`, async () => owned(async f => {
    const first = await f.attempt(); await seedRecords(f, stateVersion, workspaceVersion, 1024);
    const bytes = await recordBytes(f), control = await witness(f.control), captures = await witness(f.captures); f.clearObservations();
    const result = await f.fresh(); expect(result.exitCode).toBe(0); expect(result.attempt?.localCommit).toBe(first.localCommit); expect(result.attempt?.remoteConfirmed).toBe(true);
    expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.control)).toEqual(control); expect(await witness(f.captures)).toEqual(captures); assertNoIdentityMaintenance(f);
  }), 30000);

test("a natural changed-snapshot transition upgrades legacy checkout state only, preserving its immutable v1 workspace marker", async () => owned(async f => {
  const first = await f.attempt(); await seedRecords(f, 1, 1);
  const before = await records(f), unchanged = await recordBytes(f), marker = await witness(f.workspacePath);
  expect((await f.attempt()).localCommit).toBe(first.localCommit); expect(await recordBytes(f)).toEqual(unchanged);
  await f.addThought(); f.clearObservations(); const changed = await f.attempt(), after = await records(f);
  expect(changed.remoteConfirmed).toBe(true); expect(await f.git(f.checkout, "rev-parse", `${changed.localCommit}^`)).toBe(first.localCommit);
  expect(after.state).toEqual({ version: 2, repositoryUrl: before.state.repositoryUrl, branch: before.state.branch, ino: before.state.ino,
    configSha256: before.state.configSha256, head: changed.localCommit, manifest: changed.snapshot.manifestSha256, pending: null });
  expect(after.workspace).toEqual(before.workspace); expect(await witness(f.workspacePath)).toEqual(marker); assertNoIdentityMaintenance(f);
}), 30000);

test("an interrupted natural v1 transition publishes v2 pending state without a paired workspace migration", async () => owned(async f => {
  const first = await f.attempt(); await seedRecords(f, 1, 1); const before = await records(f), marker = await witness(f.workspacePath);
  await f.addThought(); let injected = false;
  await expect(f.attempt({ async runGit(call) {
    const result = await f.runGit(call);
    if (!injected && call.args.includes("add") && result.exitCode === 0) { injected = true; throw new Error("owned lost add acknowledgement"); }
    return result;
  } })).rejects.toThrow();
  expect(injected).toBe(true); const pending = (await records(f)).state;
  expect(pending.version).toBe(2); expect(Object.hasOwn(pending, "dev")).toBe(false);
  expect(pending.ino).toBe(before.state.ino); expect(pending.configSha256).toBe(before.state.configSha256);
  expect(pending.head).toBe(first.localCommit); expect(pending.manifest).toBe(first.snapshot.manifestSha256);
  expect(pending.pending?.kind).toBe("update"); expect(await witness(f.workspacePath)).toEqual(marker);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(first.localCommit);
  f.clearObservations(); const result = await f.fresh(); expect(result.exitCode).toBe(0); expect(result.attempt?.remoteConfirmed).toBe(true);
  expect(await f.git(f.checkout, "rev-parse", "HEAD^")).toBe(first.localCommit); expect(await witness(f.workspacePath)).toEqual(marker); assertNoIdentityMaintenance(f);
}), 30000);

for (const operation of ["add", "commit"] as const) test(`legitimate pending ${operation} resumes in a fresh attempt despite legacy device drift`, async () => owned(async f => {
  const first = await f.attempt(); await f.addThought(); let injected = false;
  await expect(f.attempt({ async runGit(call) {
    const result = await f.runGit(call);
    if (!injected && call.args.includes(operation) && result.exitCode === 0) { injected = true; throw new Error("owned lost acknowledgement"); }
    return result;
  } })).rejects.toThrow();
  expect(injected).toBe(true); expect((await records(f)).state.pending?.kind).toBe("update");
  await seedRecords(f, 1, 1, 1024); const marker = await witness(f.workspacePath), captures = await witness(f.captures); f.clearObservations();
  const result = await f.fresh(); expect(result.exitCode).toBe(0); expect(result.attempt?.remoteConfirmed).toBe(true);
  expect(await f.git(f.checkout, "rev-parse", "HEAD^")).toBe(first.localCommit); expect(await f.git(f.checkout, "rev-list", "--count", "HEAD")).toBe("2");
  expect((await records(f)).state.version).toBe(2); expect((await records(f)).state.pending).toBeNull();
  expect(await witness(f.workspacePath)).toEqual(marker); expect(await witness(f.captures)).toEqual(captures); assertNoIdentityMaintenance(f);
}), 30000);

test("a legitimate pending remote adoption resumes through the same device-independent normal path", async () => owned(async f => {
  const first = await f.attempt(), config = { ...f.config, checkout: join(f.dir, "adopting") }; let injected = false;
  await expect(runBackupAttempt({ databasePath: f.databasePath, mediaDirectory: f.mediaDirectory, config, logger: f.logger }, { async runGit(call) {
    const result = await f.runGit(call);
    if (!injected && call.args.includes("checkout") && result.exitCode === 0) { injected = true; throw new Error("owned lost adoption acknowledgement"); }
    return result;
  } })).rejects.toThrow();
  expect(injected).toBe(true);
  const paths: RecordPaths = { checkout: config.checkout, databasePath: f.databasePath, captures: join(f.dir, ".adopting.thoughtloom-captures"),
    statePath: join(f.dir, ".adopting.thoughtloom-backup", "state.json"), workspacePath: join(f.dir, ".adopting.thoughtloom-backup", "capture-workspace.json") };
  expect((await records(paths)).state.pending?.kind).toBe("adopt"); await seedRecords(paths, 1, 1, 1024);
  const marker = await witness(paths.workspacePath); f.clearObservations(); const result = await f.fresh("attempt", config);
  expect(result.exitCode).toBe(0); expect(result.attempt?.remoteConfirmed).toBe(true); expect(result.attempt?.localCommit).toBe(first.localCommit);
  expect(await f.git(config.checkout, "rev-list", "--count", "HEAD")).toBe("1");
  expect((await records(paths)).state.version).toBe(2); expect((await records(paths)).state.pending).toBeNull(); expect(await witness(paths.workspacePath)).toEqual(marker);
  assertNoIdentityMaintenance(f);
}), 30000);

async function replaceDirectory(path: string): Promise<void> {
  const displaced = `${path}.displaced`;
  await rename(path, displaced); await cp(displaced, path, { recursive: true, preserveTimestamps: true }); await chmod(path, 0o700);
  expect((await lstat(path, { bigint: true })).ino).not.toBe((await lstat(displaced, { bigint: true })).ino);
}

const invalid: readonly { readonly name: string; readonly change: (f: Fixture) => Promise<void> }[] = [
  { name: "byte-identical replacement checkout inode", change: f => replaceDirectory(f.checkout) },
  { name: "byte-identical replacement capture inode", change: f => replaceDirectory(f.captures) },
  { name: "byte-identical replacement source inode", async change(f) { await f.daemon.stop(); await rename(f.databasePath, `${f.databasePath}.displaced`); await copyFile(`${f.databasePath}.displaced`, f.databasePath); } },
  { name: "symlinked checkout", async change(f) { await rename(f.checkout, `${f.checkout}.displaced`); await symlink(`${f.checkout}.displaced`, f.checkout); } },
  { name: "symlinked capture root", async change(f) { await rename(f.captures, `${f.captures}.displaced`); await symlink(`${f.captures}.displaced`, f.captures); } },
  { name: "symlinked source", async change(f) { await f.daemon.stop(); await rename(f.databasePath, `${f.databasePath}.displaced`); await symlink(`${f.databasePath}.displaced`, f.databasePath); } },
  { name: "unsafe capture mode", change: f => chmod(f.captures, 0o750) },
  { name: "hard-linked workspace record", change: f => link(f.workspacePath, join(f.dir, "workspace-record-alias")) },
  { name: "modified local Git config", async change(f) { await writeFile(join(f.checkout, ".git", "config"), "\n# private altered config sentinel\n", { flag: "a" }); } },
  { name: "unrecorded HEAD", async change(f) { await f.git(f.checkout, "commit", "--amend", "--no-gpg-sign", "-m", "private altered history sentinel"); } },
  { name: "unexpected Git ref", async change(f) { await f.git(f.checkout, "update-ref", "refs/tags/unexpected", "HEAD"); } },
  { name: "changed index", async change(f) {
    const file = join(f.dir, "index-bytes"); await writeFile(file, "private index sentinel\n", { mode: 0o600 });
    const oid = await f.git(f.checkout, "hash-object", "-w", file); await f.git(f.checkout, "update-index", "--cacheinfo", `100644,${oid},snapshot/manifest.json`);
  } },
  { name: "changed selected payload", change: f => writeFile(join(f.checkout, "snapshot", "tables", "thoughts.json"), "private payload sentinel\n") },
  { name: "checkout inode binding conflict", async change(f) { const r = await records(f); await writeRecord(f.statePath, { ...r.state, ino: (BigInt(r.state.ino) + 1n).toString() }); } },
  { name: "capture inode binding conflict", async change(f) { const r = await records(f); await writeRecord(f.workspacePath, { ...r.workspace, ino: (BigInt(r.workspace.ino) + 1n).toString() }); } },
  { name: "source inode binding conflict", async change(f) { const r = await records(f); await writeRecord(f.workspacePath, { ...r.workspace, databaseIno: (BigInt(r.workspace.databaseIno) + 1n).toString() }); } },
  { name: "remote binding conflict", async change(f) { const r = await records(f); await writeRecord(f.statePath, { ...r.state, repositoryUrl: "https://backup.invalid/foreign.git" }); } },
  { name: "branch binding conflict", async change(f) { const r = await records(f); await writeRecord(f.statePath, { ...r.state, branch: "foreign" }); } },
  { name: "source path binding conflict", async change(f) { const r = await records(f); await writeRecord(f.workspacePath, { ...r.workspace, databasePath: join(f.dir, "foreign.sqlite") }); } },
  { name: "media path binding conflict", async change(f) { const r = await records(f); await writeRecord(f.workspacePath, { ...r.workspace, mediaDirectory: join(f.dir, "foreign-media") }); } },
  { name: "workspace remote binding conflict", async change(f) { const r = await records(f); await writeRecord(f.workspacePath, { ...r.workspace, repositoryUrl: "https://backup.invalid/foreign.git" }); } },
  { name: "workspace branch binding conflict", async change(f) { const r = await records(f); await writeRecord(f.workspacePath, { ...r.workspace, branch: "foreign" }); } },
  { name: "capture path binding conflict", async change(f) { const r = await records(f); await writeRecord(f.workspacePath, { ...r.workspace, path: join(f.dir, "foreign-captures") }); } },
  { name: "checkout path binding conflict", async change(f) { const r = await records(f); await writeRecord(f.workspacePath, { ...r.workspace, checkout: join(f.dir, "foreign-checkout") }); } },
  { name: "noncanonical workspace record", async change(f) { const r = await records(f); await writeFile(f.workspacePath, `${JSON.stringify(r.workspace, null, 2)}\n`); } },
  { name: "unknown state fields", async change(f) { const r = await records(f); await writeFile(f.statePath, `${JSON.stringify({ ...r.state, foreign: true })}\n`); } },
  { name: "unrecorded update scratch", async change(f) { await mkdir(join(f.control, "next"), { mode: 0o700 }); await writeFile(join(f.control, "next", "keep"), "private scratch sentinel", { mode: 0o600 }); } },
  { name: "leftover Git index lock", change: f => writeFile(join(f.checkout, ".git", "index.lock"), "private lock sentinel", { mode: 0o600 }) },
  { name: "crash-left capture scratch", async change(f) { await mkdir(join(f.captures, ".capture-00000000-0000-4000-8000-000000000000"), { mode: 0o700 }); } },
];

for (const scenario of invalid) test(`ordinary attempts reject ${scenario.name} and preserve existing evidence`, async () => owned(async f => {
  await f.attempt(); await scenario.change(f); // No stale-device failure may mask the invariant under test.
  const bytes = await recordBytes(f), checkout = await witness(f.checkout), captures = await witness(f.captures), control = await witness(f.control), remote = await witness(f.bare);
  f.clearObservations(); await expect(f.attempt()).rejects.toThrow(); safeReasons(f);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.checkout)).toEqual(checkout); expect(await witness(f.captures)).toEqual(captures);
  expect(await witness(f.control)).toEqual(control); expect(await witness(f.bare)).toEqual(remote);
  for (const secret of ["private altered config sentinel", "private altered history sentinel", "private payload sentinel", "private scratch sentinel", "private lock sentinel"])
    expect(JSON.stringify(f.logs)).not.toContain(secret);
}), 30000);

for (const missing of ["state", "workspace"] as const) test(`missing ${missing} evidence is not recreated by an ordinary attempt over existing roots`, async () => owned(async f => {
  await f.attempt(); await rm(missing === "state" ? f.statePath : f.workspacePath);
  const control = await witness(f.control), captures = await witness(f.captures), remote = await witness(f.bare);
  f.clearObservations(); await expect(f.attempt()).rejects.toThrow(); safeReasons(f);
  expect(await witness(f.control)).toEqual(control); expect(await witness(f.captures)).toEqual(captures); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

for (const malformed of ["checkout-device", "capture-device", "source-device", "unknown-version", "missing-field"] as const)
  test(`legacy normalization still rejects ${malformed} malformed record syntax`, async () => owned(async f => {
    await f.attempt(); await seedRecords(f, 1, 1); const r = await records(f);
    if (malformed === "checkout-device") await writeFile(f.statePath, `${JSON.stringify({ ...r.state, dev: "not-a-device" })}\n`);
    if (malformed === "capture-device") await writeFile(f.workspacePath, `${JSON.stringify({ ...r.workspace, dev: 42 })}\n`);
    if (malformed === "source-device") await writeFile(f.workspacePath, `${JSON.stringify({ ...r.workspace, databaseDev: null })}\n`);
    if (malformed === "unknown-version") await writeFile(f.statePath, `${JSON.stringify({ ...r.state, version: 99 })}\n`);
    if (malformed === "missing-field") {
      const { databaseIno: omitted, ...missing } = r.workspace; expect(omitted).toBeDefined(); await writeFile(f.workspacePath, `${JSON.stringify(missing)}\n`);
    }
    const bytes = await recordBytes(f); f.clearObservations(); await expect(f.attempt()).rejects.toThrow(); expect(await recordBytes(f)).toEqual(bytes); safeReasons(f);
  }), 30000);

test("normalization preserves the raw legacy record guard against a concurrent edit to an ignored device field", async () => owned(async f => {
  const first = await f.attempt(); await seedRecords(f, 1, 1); await f.addThought();
  const marker = await witness(f.workspacePath), checkout = await checkoutWitness(f), remote = await witness(f.bare); let changed: Buffer | undefined;
  f.clearObservations(); await expect(f.attempt({ async runGit(call) {
    const result = await f.runGit(call);
    if (changed === undefined) {
      const state = (await records(f)).state;
      if (state.version !== 1) throw new Error("Owned fixture must still hold its legacy record before the natural transition");
      await writeRecord(f.statePath, { ...state, dev: (BigInt(state.dev) + 1024n).toString() }); changed = await readFile(f.statePath);
    }
    return result;
  } })).rejects.toThrow();
  if (changed === undefined) throw new Error("Attempt never entered the owned Git boundary");
  expect((await readFile(f.statePath)).equals(changed)).toBe(true); expect(await witness(f.workspacePath)).toEqual(marker);
  expect(await checkoutWitness(f)).toEqual(checkout); expect(await witness(f.bare)).toEqual(remote);
  expect(await f.git(f.checkout, "rev-parse", "HEAD")).toBe(first.localCommit); expect(safeReasons(f)).toContain("checkout-record-changed");
}), 30000);

for (const path of ["state", "workspace"] as const) test(`v2 ${path} rejects added legacy device fields instead of interpreting an unversioned hybrid`, async () => owned(async f => {
  await f.attempt(); await seedRecords(f, 2, 2); const r = await records(f);
  await writeFile(path === "state" ? f.statePath : f.workspacePath, `${JSON.stringify(path === "state" ? { ...r.state, dev: "123" } : { ...r.workspace, databaseDev: "123" })}\n`);
  const bytes = await recordBytes(f); f.clearObservations(); await expect(f.attempt()).rejects.toThrow(); expect(await recordBytes(f)).toEqual(bytes); safeReasons(f);
}), 30000);

test("a legacy-device mismatch cannot bypass the shared lease or cancellation join", async () => owned(async f => {
  await f.attempt(); await seedRecords(f, 1, 1, 1024); const bytes = await recordBytes(f);
  const lease = await BackupCheckoutLease.acquire(f.config), controller = new AbortController(), ready = Promise.withResolvers<void>();
  const logger = createLogger("verbose", record => { f.logs.push(record); if (/lock acquisition attempt/.test(record.message)) ready.resolve(); });
  f.clearObservations(); const pending = f.attempt({ signal: controller.signal, logger }); void pending.catch(() => {});
  try {
    await bounded(ready.promise); expect(f.calls).toHaveLength(0); expect(await recordBytes(f)).toEqual(bytes);
    controller.abort(); await expect(pending).rejects.toThrow(); expect(await recordBytes(f)).toEqual(bytes);
    expect(f.logs.some(record => record.message === "[backup] source snapshot established")).toBe(false);
  } finally { controller.abort(); await Promise.allSettled([pending]); await lease.release(); }
}), 30000);

for (const replaced of ["source", "capture", "checkout"] as const) test(`ordinary operation guards still reject a ${replaced} replacement after capture has entered Git`, async () => owned(async f => {
  await f.attempt(); await f.daemon.stop(); const bytes = await recordBytes(f), remote = await witness(f.bare); let injected = false;
  f.clearObservations(); const runGit = async (call: GitInvocation): Promise<GitResult> => {
    const result = await f.runGit(call);
    if (!injected) {
      injected = true;
      if (replaced === "source") { await rename(f.databasePath, `${f.databasePath}.displaced`); await copyFile(`${f.databasePath}.displaced`, f.databasePath); }
      else await replaceDirectory(replaced === "capture" ? f.captures : f.checkout);
    }
    return result;
  };
  await expect(f.attempt({ runGit })).rejects.toThrow(); expect(injected).toBe(true); safeReasons(f);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("sourceGuard remains strict device-plus-inode within one operation", async () => owned(async f => {
  const stat = await lstat(f.databasePath, { bigint: true });
  expect(() => sourceGuard(f.databasePath, stat.dev.toString(), stat.ino.toString(), () => {})()).not.toThrow();
  expect(() => sourceGuard(f.databasePath, (stat.dev + 1024n).toString(), stat.ino.toString(), () => {})()).toThrow("source-replaced");
  expect(() => sourceGuard(f.databasePath, stat.dev.toString(), (stat.ino + 1n).toString(), () => {})()).toThrow("source-replaced");
}), 15000);

test("obsolete --recover-identity and all other arguments reject before any backup or identity work", async () => owned(async f => {
  await f.attempt(); const control = await witness(f.control), checkout = await witness(f.checkout), captures = await witness(f.captures), remote = await witness(f.bare);
  for (const args of [["--recover-identity"], ["--unknown"], ["--recover-identity", "--recover-identity"], ["--recover-identity", "extra"], ["--recover-identity=true"]]) {
    f.clearObservations(); expect(await f.command(args)).toBe(1); expect(f.calls).toHaveLength(0);
    expect(f.logs.some(record => record.message === "[backup] source snapshot established")).toBe(false); assertNoIdentityMaintenance(f);
    expect(await witness(f.control)).toEqual(control); expect(await witness(f.checkout)).toEqual(checkout); expect(await witness(f.captures)).toEqual(captures);
  }
  expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("actual no-env-file CLI rejects the retired recovery flag before resolving source input", async () => owned(async f => {
  const home = join(f.dir, "cli-home"); await mkdir(home);
  const names = (await readdir(f.dir)).sort(), remote = await witness(f.bare);
  const script = fileURLToPath(new URL("../scripts/backup.ts", import.meta.url));
  // If argv wiring regresses, this absent owned source still stops the command
  // before Git/network entry. The diagnostic distinguishes that from parsing.
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script, "--recover-identity"], cwd: f.dir,
    env: { PATH: "/usr/bin:/bin", HOME: home, ...f.env, THOUGHTLOOM_DB_PATH: join(f.dir, "must-not-resolve.sqlite") }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(stdout + stderr).toContain("invalid-command-input");
    expect(stdout + stderr).not.toMatch(/identity (?:recovered|validated|recovery)|source snapshot established|remote delivery/);
    expect(stdout + stderr).not.toContain(f.dir);
  } finally { clearTimeout(timer); }
  expect((await readdir(f.dir)).sort()).toEqual(names); expect(await witness(f.bare)).toEqual(remote);
}), 30000);
