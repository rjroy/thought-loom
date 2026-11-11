import { expect, test } from "bun:test";
import { copyFileSync, readFileSync, renameSync } from "node:fs";
import { chmod, copyFile, cp, link, lstat, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupCheckoutLease, type GitInvocation, type GitResult } from "../src/backup/git";
import { sourceGuard } from "../src/backup/capture-files";
import { runBackupAttempt } from "../src/backup/run";
import { createLogger } from "../src/logging";
import { assertRecoveryOnly, command, oldDevices, owned, privateText, recordBytes, records, safeReasons, witness, writeRecord,
  type Binding, type Fixture } from "./backup-identity-fixture";

const recordNames = new Set(["state.json", "capture-workspace.json"]);
const epochs: readonly { readonly name: string; readonly bindings: readonly Binding[] }[] = [
  { name: "checkout", bindings: ["checkout"] },
  { name: "capture", bindings: ["capture"] },
  { name: "source database", bindings: ["source"] },
  { name: "all persistent", bindings: ["checkout", "capture", "source"] },
];

for (const epoch of epochs) test(`explicit recovery validates existing v1 ${epoch.name} device drift; normal attempts never rebind it`, async () => owned(async f => {
  const first = await f.attempt(); expect(first.remoteConfirmed).toBe(true);
  const original = await recordBytes(f), checkout = await witness(f.checkout), captures = await witness(f.captures), remote = await witness(f.bare);
  await oldDevices(f, epoch.bindings);
  const stale = await recordBytes(f);
  for (let attempt = 0; attempt < 2; attempt++) {
    f.clearObservations(); await expect(f.attempt()).rejects.toThrow();
    expect(await recordBytes(f)).toEqual(stale); expect(f.calls).toHaveLength(0);
    expect(f.logs.some(record => record.message === "[backup] source snapshot established")).toBe(false);
    safeReasons(f);
  }
  f.clearObservations();
  expect(await f.recover()).toBe(0);
  assertRecoveryOnly(f);
  expect(f.logs.some(record => /\bidentity (?:validated|recovered)\b/.test(record.message))).toBe(true);
  expect(await recordBytes(f)).toEqual(original); // No new schema, path, HEAD, binding or payload fact was invented.
  expect(await witness(f.checkout)).toEqual(checkout); expect(await witness(f.captures)).toEqual(captures); expect(await witness(f.bare)).toEqual(remote);
  const identities = await Promise.all([lstat(f.statePath, { bigint: true }), lstat(f.workspacePath, { bigint: true })]);
  f.clearObservations(); expect(await f.recover()).toBe(0); assertRecoveryOnly(f);
  expect(await recordBytes(f)).toEqual(original);
  expect((await lstat(f.statePath, { bigint: true })).ino).toBe(identities[0].ino);
  expect((await lstat(f.workspacePath, { bigint: true })).ino).toBe(identities[1].ino);
  const repeated = await f.attempt(); expect(repeated.remoteConfirmed).toBe(true);
  expect(repeated.localCommit).toBe(first.localCommit); expect(repeated.snapshot).toEqual(first.snapshot);
}), 30000);

test("recovery is local-only while offline and preserves every retained snapshot and unpushed commit before later delivery", async () => owned(async f => {
  const first = await f.attempt(), offline = join(f.dir, "offline.git");
  expect(first.remoteConfirmed).toBe(true); await rename(f.bare, offline);
  await f.addThought(); const second = await f.attempt(); expect(second.remoteConfirmed).toBe(false);
  await f.addThought(`${privateText} second`); const third = await f.attempt(); expect(third.remoteConfirmed).toBe(false);
  expect(await f.git(f.checkout, "rev-parse", `${third.localCommit}^`)).toBe(second.localCommit);
  expect(await f.git(f.checkout, "rev-parse", `${second.localCommit}^`)).toBe(first.localCommit);
  expect((await records(f)).state.pending).toBeNull(); // Unpushed history is not an interrupted local update.
  const checkout = await witness(f.checkout), captures = await witness(f.captures), remote = await witness(offline);
  const control = await witness(f.control, recordNames);
  await oldDevices(f); f.clearObservations();
  expect(await f.recover()).toBe(0); assertRecoveryOnly(f);
  expect(await witness(f.checkout)).toEqual(checkout); expect(await witness(f.captures)).toEqual(captures);
  expect(await witness(offline)).toEqual(remote); expect(await witness(f.control, recordNames)).toEqual(control);
  expect(await f.git(offline, "rev-parse", "refs/heads/backups")).toBe(first.localCommit);
  expect(await f.git(f.checkout, "rev-list", "--count", "HEAD")).toBe("3");
  await rename(offline, f.bare);
  const delivered = await f.attempt(); expect(delivered.remoteConfirmed).toBe(true); expect(delivered.localCommit).toBe(third.localCommit);
  expect(await f.git(f.bare, "rev-parse", "refs/heads/backups")).toBe(third.localCommit);
  expect(await f.git(f.bare, "rev-list", "--count", "refs/heads/backups")).toBe("3");
  const repeated = await f.attempt(); expect(repeated.localCommit).toBe(third.localCommit); expect(repeated.remoteConfirmed).toBe(true);
}), 45000);

// These are the two durable interruption boundaries of independently atomic record
// replacement. Retry must revalidate everything, not trust an earlier partial success.
for (const updated of ["checkout", "workspace"] as const) test(`a partial recovery with only ${updated} current stays fail-closed until explicit revalidation`, async () => owned(async f => {
  const first = await f.attempt(), current = await records(f), original = await recordBytes(f);
  await oldDevices(f);
  if (updated === "checkout") await writeRecord(f.statePath, current.state);
  else await writeRecord(f.workspacePath, current.workspace);
  const partial = await recordBytes(f); f.clearObservations();
  await expect(f.attempt()).rejects.toThrow(); expect(await recordBytes(f)).toEqual(partial);
  expect(f.calls).toHaveLength(0); expect(f.logs.some(record => record.message === "[backup] source snapshot established")).toBe(false);
  f.clearObservations(); expect(await f.recover()).toBe(0); assertRecoveryOnly(f); expect(await recordBytes(f)).toEqual(original);
  expect((await f.attempt()).localCommit).toBe(first.localCommit);
}), 30000);

async function replaceDirectory(path: string): Promise<void> {
  const displaced = `${path}.displaced`;
  await rename(path, displaced); await cp(displaced, path, { recursive: true, preserveTimestamps: true }); await chmod(path, 0o700);
  expect((await lstat(path, { bigint: true })).ino).not.toBe((await lstat(displaced, { bigint: true })).ino);
}

const invalid: readonly { readonly name: string; readonly change: (f: Fixture) => Promise<void> }[] = [
  { name: "byte-identical replacement checkout inode", change: f => replaceDirectory(f.checkout) },
  { name: "byte-identical replacement capture inode", change: f => replaceDirectory(f.captures) },
  { name: "byte-identical replacement source inode", async change(f) {
    await f.daemon.stop(); await rename(f.databasePath, `${f.databasePath}.displaced`); await copyFile(`${f.databasePath}.displaced`, f.databasePath);
  } },
  { name: "symlinked checkout", async change(f) { await rename(f.checkout, `${f.checkout}.displaced`); await symlink(`${f.checkout}.displaced`, f.checkout); } },
  { name: "symlinked capture root", async change(f) { await rename(f.captures, `${f.captures}.displaced`); await symlink(`${f.captures}.displaced`, f.captures); } },
  { name: "symlinked source", async change(f) {
    await f.daemon.stop(); await rename(f.databasePath, `${f.databasePath}.displaced`); await symlink(`${f.databasePath}.displaced`, f.databasePath);
  } },
  { name: "unsafe capture mode", change: f => chmod(f.captures, 0o750) },
  { name: "hard-linked workspace ownership record", change: f => link(f.workspacePath, join(f.dir, "workspace-record-alias")) },
  { name: "modified local Git config", async change(f) { await writeFile(join(f.checkout, ".git", "config"), "\n# private altered config sentinel\n", { flag: "a" }); } },
  { name: "unrecorded HEAD", async change(f) { await f.git(f.checkout, "commit", "--amend", "--no-gpg-sign", "-m", "private altered history sentinel"); } },
  { name: "unexpected Git ref", async change(f) { await f.git(f.checkout, "update-ref", "refs/tags/unexpected", "HEAD"); } },
  { name: "changed index", async change(f) {
    const file = join(f.dir, "index-bytes"); await writeFile(file, "private index sentinel\n", { mode: 0o600 });
    const oid = await f.git(f.checkout, "hash-object", "-w", file); await f.git(f.checkout, "update-index", "--cacheinfo", `100644,${oid},snapshot/manifest.json`);
  } },
  { name: "changed selected payload", change: f => writeFile(join(f.checkout, "snapshot", "tables", "thoughts.json"), "private payload sentinel\n") },
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

for (const scenario of invalid) test(`identity recovery refuses ${scenario.name} before rebinding either record and preserves evidence`, async () => owned(async f => {
  await f.attempt(); await oldDevices(f); await scenario.change(f);
  const bytes = await recordBytes(f), checkout = await witness(f.checkout), captures = await witness(f.captures), control = await witness(f.control), remote = await witness(f.bare);
  f.clearObservations(); expect(await f.recover()).toBe(1); assertRecoveryOnly(f); safeReasons(f);
  expect(await recordBytes(f)).toEqual(bytes);
  expect(await witness(f.checkout)).toEqual(checkout); expect(await witness(f.captures)).toEqual(captures);
  expect(await witness(f.control)).toEqual(control); expect(await witness(f.bare)).toEqual(remote);
  for (const secret of ["private altered config sentinel", "private altered history sentinel", "private payload sentinel", "private scratch sentinel", "private lock sentinel"])
    expect(JSON.stringify(f.logs)).not.toContain(secret);
}), 30000);

test("recovery verifies older retained capture bytes rather than silently blessing an unselected corrupt snapshot", async () => owned(async f => {
  const first = await f.attempt(); await f.addThought(); await f.attempt();
  await oldDevices(f); await writeFile(join(first.snapshot.snapshotDirectory, "tables", "thoughts.json"), "corrupt prior snapshot\n");
  const bytes = await recordBytes(f), captures = await witness(f.captures), remote = await witness(f.bare);
  f.clearObservations(); expect(await f.recover()).toBe(1); assertRecoveryOnly(f); safeReasons(f);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.captures)).toEqual(captures); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("recovery verifies reachable ancestor objects, not only the matching current HEAD/tree", async () => owned(async f => {
  const first = await f.attempt(); await f.addThought(); const second = await f.attempt();
  expect(second.localCommit).not.toBe(first.localCommit);
  const object = join(f.checkout, ".git", "objects", first.localCommit.slice(0, 2), first.localCommit.slice(2));
  await chmod(object, 0o600); await writeFile(object, "corrupt owned ancestor object\n"); await oldDevices(f);
  const bytes = await recordBytes(f), checkout = await witness(f.checkout), remote = await witness(f.bare);
  f.clearObservations(); expect(await f.recover()).toBe(1); assertRecoveryOnly(f); safeReasons(f);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.checkout)).toEqual(checkout); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("recovery refuses a real commit-with-lost-ack pending update without resuming, resetting or clearing it", async () => owned(async f => {
  const first = await f.attempt(); await f.addThought(); let injected = false;
  await expect(runBackupAttempt({ databasePath: f.databasePath, mediaDirectory: f.mediaDirectory, config: f.config, logger: f.logger }, {
    async runGit(call) {
      const result = await f.runGit(call);
      if (!injected && call.args.includes("commit") && result.exitCode === 0) { injected = true; throw new Error("owned lost commit acknowledgement"); }
      return result;
    },
  })).rejects.toThrow();
  expect(injected).toBe(true); expect((await records(f)).state.pending?.kind).toBe("update");
  expect(await f.git(f.checkout, "rev-parse", "HEAD")).not.toBe(first.localCommit);
  await oldDevices(f);
  const bytes = await recordBytes(f), checkout = await witness(f.checkout), control = await witness(f.control), captures = await witness(f.captures), remote = await witness(f.bare);
  f.clearObservations(); expect(await f.recover()).toBe(1); assertRecoveryOnly(f); safeReasons(f);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.checkout)).toEqual(checkout); expect(await witness(f.control)).toEqual(control);
  expect(await witness(f.captures)).toEqual(captures); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

for (const missing of ["state", "workspace"] as const) test(`missing ${missing} ownership evidence is not initialized or adopted by explicit recovery`, async () => owned(async f => {
  await f.attempt(); await rm(missing === "state" ? f.statePath : f.workspacePath);
  const control = await witness(f.control), captures = await witness(f.captures), remote = await witness(f.bare);
  f.clearObservations(); expect(await f.recover()).toBe(1); assertRecoveryOnly(f); safeReasons(f);
  expect(await witness(f.control)).toEqual(control); expect(await witness(f.captures)).toEqual(captures); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("recovery without an existing workspace does not create backup directories, ownership records or a first commit", async () => owned(async f => {
  const names = (await readdir(f.dir)).sort(), remote = await witness(f.bare);
  f.clearObservations(); expect(await f.recover()).toBe(1); expect(f.calls).toHaveLength(0); assertRecoveryOnly(f);
  expect((await readdir(f.dir)).sort()).toEqual(names); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("matching current device fields do not bypass full validation on an idempotent recovery invocation", async () => owned(async f => {
  await f.attempt(); await writeFile(join(f.checkout, ".git", "config"), "\n# altered even though device matches\n", { flag: "a" });
  const bytes = await recordBytes(f), checkout = await witness(f.checkout), remote = await witness(f.bare);
  f.clearObservations(); expect(await f.recover()).toBe(1); assertRecoveryOnly(f); safeReasons(f);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.checkout)).toEqual(checkout); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("explicit recovery waits on the shared lease and cancellation joins without entering validation or writing records", async () => owned(async f => {
  await f.attempt(); await oldDevices(f); const bytes = await recordBytes(f);
  const lease = await BackupCheckoutLease.acquire(f.config), controller = new AbortController(), ready = Promise.withResolvers<void>();
  const logger = createLogger("verbose", record => { f.logs.push(record); if (/lock acquisition attempt/.test(record.message)) ready.resolve(); });
  f.clearObservations(); const pending = f.recover({ signal: controller.signal, logger });
  try {
    await Promise.race([ready.promise, Bun.sleep(5000).then(() => { throw new Error("Recovery never reached checkout lease"); })]);
    expect(f.calls).toHaveLength(0); expect(await recordBytes(f)).toEqual(bytes);
    controller.abort(); expect(await pending).toBe(1); assertRecoveryOnly(f); expect(await recordBytes(f)).toEqual(bytes);
  } finally { controller.abort(); await Promise.allSettled([pending]); await lease.release(); }
  f.clearObservations(); expect(await f.recover()).toBe(0); assertRecoveryOnly(f);
}), 30000);

for (const replaced of ["source", "capture", "checkout"] as const) test(`a ${replaced} replacement during local recovery validation is not hidden by device rebinding`, async () => owned(async f => {
  await f.attempt(); await f.daemon.stop(); await oldDevices(f);
  const bytes = await recordBytes(f), remote = await witness(f.bare); let injected = false;
  f.clearObservations();
  const runGit = async (call: GitInvocation): Promise<GitResult> => {
    const result = await f.runGit(call);
    if (!injected) {
      injected = true;
      if (replaced === "source") { await rename(f.databasePath, `${f.databasePath}.displaced`); await copyFile(`${f.databasePath}.displaced`, f.databasePath); }
      else await replaceDirectory(replaced === "capture" ? f.captures : f.checkout);
    }
    return result;
  };
  expect(await f.recover({ runGit })).toBe(1); expect(injected).toBe(true); assertRecoveryOnly(f); safeReasons(f);
  expect(await recordBytes(f)).toEqual(bytes); expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("a source replacement between durable identity-record writes prevents the second rebind without rolling back the first", async () => owned(async f => {
  await f.attempt(); await f.daemon.stop(); const current = await recordBytes(f); await oldDevices(f);
  const stale = await recordBytes(f), remote = await witness(f.bare); let boundary: readonly Buffer[] | undefined;
  f.clearObservations();
  const logger = createLogger("verbose", record => {
    f.logs.push(record);
    if (boundary || record.message !== "[backup] identity binding recovered") return;
    expect(record.context?.binding === "checkout" || record.context?.binding === "workspace").toBe(true);
    boundary = [readFileSync(f.statePath), readFileSync(f.workspacePath)];
    const written = boundary.map((bytes, index) => bytes.equals(current[index]));
    expect(written.filter(Boolean)).toHaveLength(1); // The event follows one durable atomic replacement, not both.
    for (let index = 0; index < boundary.length; index++) expect(boundary[index]).toEqual(written[index] ? current[index] : stale[index]);
    renameSync(f.databasePath, `${f.databasePath}.displaced`); copyFileSync(`${f.databasePath}.displaced`, f.databasePath);
  });
  expect(await f.recover({ logger })).toBe(1);
  if (boundary === undefined) throw new Error("Recovery never reached the first durable identity-binding boundary");
  assertRecoveryOnly(f); safeReasons(f);
  expect(await recordBytes(f)).toEqual(boundary); expect(await witness(f.bare)).toEqual(remote);
  expect(f.logs.some(record => /\bidentity (?:validated|recovered)\b/.test(record.message))).toBe(false);
  const partial = await recordBytes(f); f.clearObservations(); await expect(f.attempt()).rejects.toThrow(); expect(await recordBytes(f)).toEqual(partial);
}), 30000);

test("identity refusals distinguish checkout, capture and source device drift using only static sanitized reasons", async () => owned(async f => {
  await f.attempt(); const current = await records(f), observed: string[] = [];
  for (const binding of ["checkout", "capture", "source"] as const) {
    await writeRecord(f.statePath, current.state); await writeRecord(f.workspacePath, current.workspace); await oldDevices(f, [binding]);
    f.clearObservations(); await expect(f.attempt()).rejects.toThrow();
    const reasons = safeReasons(f); observed.push(reasons.join(","));
  }
  expect(new Set(observed).size).toBe(3);
}), 30000);

test("sourceGuard remains a strict device-plus-inode guard within one operation", async () => owned(async f => {
  const stat = await lstat(f.databasePath, { bigint: true });
  expect(() => sourceGuard(f.databasePath, stat.dev.toString(), stat.ino.toString(), () => {})()).not.toThrow();
  expect(() => sourceGuard(f.databasePath, (stat.dev + 1024n).toString(), stat.ino.toString(), () => {})()).toThrow("source-replaced");
  expect(() => sourceGuard(f.databasePath, stat.dev.toString(), (stat.ino + 1n).toString(), () => {})()).toThrow("source-replaced");
}), 15000);

test("unknown, duplicate and mixed command arguments fail before capture, Git or identity writes", async () => owned(async f => {
  await f.attempt(); const bytes = await recordBytes(f), remote = await witness(f.bare);
  for (const args of [["--unknown"], ["--recover-identity", "--recover-identity"], ["--recover-identity", "extra"], ["--recover-identity=true"]]) {
    f.clearObservations(); expect(await command(f.env, { logger: f.logger, runGit: f.runGit }, args)).toBe(1);
    expect(f.calls).toHaveLength(0); assertRecoveryOnly(f); expect(await recordBytes(f)).toEqual(bytes);
  }
  expect(await witness(f.bare)).toEqual(remote);
}), 30000);

test("actual no-env-file CLI selects recovery without capture, credentials, network delivery or a new checkout", async () => owned(async f => {
  await f.attempt(); const current = await recordBytes(f), checkout = await witness(f.checkout), captures = await witness(f.captures), remote = await witness(f.bare);
  await oldDevices(f); await writeFile(join(f.dir, ".env"), "THOUGHTLOOM_BACKUP_CONFIG=private-dotenv-recovery-sentinel\n", { mode: 0o600 });
  const script = fileURLToPath(new URL("../scripts/backup.ts", import.meta.url));
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script, "--recover-identity"], cwd: f.dir,
    env: { PATH: "/usr/bin:/bin", HOME: f.dir, ...f.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(stdout + stderr).toMatch(/\bidentity (?:validated|recovered)\b/);
    expect(stdout + stderr).not.toMatch(/source snapshot established|remote delivery|remote branch confirmed/);
    for (const secret of [f.dir, privateText, "private-dotenv-recovery-sentinel"]) expect(stdout + stderr).not.toContain(secret);
  } finally { clearTimeout(timer); }
  expect(await recordBytes(f)).toEqual(current); expect(await witness(f.checkout)).toEqual(checkout);
  expect(await witness(f.captures)).toEqual(captures); expect(await witness(f.bare)).toEqual(remote);
  expect((await readdir(f.dir)).filter(name => name === "checkout")).toEqual(["checkout"]);
}), 30000);
