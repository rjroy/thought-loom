import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "../src/daemon/agent-config";
import { startDaemon, type DaemonEvent, type RunningDaemon, type RuntimeDependencies } from "../src/daemon/runtime";
import type { LogRecord } from "../src/logging";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { migrate } from "../src/storage/sqlite";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const agent: AgentConfig = { service: { url: "http://127.0.0.1:44991" }, directory: "/tmp/opencode/owned-restore-fixture",
  model: { providerID: "fixture", id: "fixture" }, effort: { quick: null, standard: null, thorough: null } };
const markerText = "private-restore-marker-sentinel";
const thoughtText = "private-existing-thought-sentinel";

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function seed(path: string): void {
  const db = new Database(path);
  try {
    migrate(db);
    db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id) VALUES (?,?, 'user','captured-original','2030','test',NULL)", ["owned-root", thoughtText]);
    db.exec(`INSERT INTO thought_titles VALUES ('owned-root',NULL,NULL);
      INSERT INTO thought_source_seals VALUES ('owned-root');
      INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation,weave_subject_id,weave_trigger_id)
      VALUES ('owned-run','weave','queued','owned-session','owned-prompt','2030',0,'owned-root','capture:owned-root');`);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  } finally { db.close(); }
}

test("a restore marker rejects configured and configless startup before WAL, migration and producers", async () => {
  for (const scenario of ["regular", "dangling-symlink", "directory"] as const) {
    for (const configured of [false, true]) {
      const dir = await mkdtemp("/tmp/opencode/restore-startup-"), path = join(dir, "knowledge.sqlite"), marker = join(dir, ".restore-in-progress");
      let daemon: RunningDaemon | undefined;
      try {
        seed(path);
        if (scenario === "regular") await writeFile(marker, markerText, { mode: 0o600 });
        else if (scenario === "dangling-symlink") await symlink(join(dir, "missing-marker-target"), marker);
        else await mkdir(marker, { mode: 0o700 });
        const originalMarker = await lstat(marker, { bigint: true }), originalDb = await lstat(path, { bigint: true }), bytes = await readFile(path);
        const events: DaemonEvent[] = [], logs: LogRecord[] = [];
        let nativeCalls = 0, timers = 0, backupCalls = 0, backupTimers = 0;
        const dependencies: RuntimeDependencies = {
          logSink: record => logs.push(record),
          startTimer() { timers++; return () => {}; },
          async resolveAgentService() { nativeCalls++; throw new Error("unexpected owned native resolver"); },
          createPublicClient() { nativeCalls++; throw new Error("unexpected owned native client"); },
          backupScheduler: { timer: { now: () => 0n, schedule() { backupTimers++; return () => {}; } }, async attempt() { backupCalls++; } },
        };
        let failure: unknown;
        try {
          daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials, logLevel: "verbose", ...(configured ? {
            agent, backup: { repositoryUrl: "https://backup.invalid/owned/fixture.git", checkout: join(dir, "checkout"), branch: "backups", intervalSeconds: 5 },
          } : {}) }, event => events.push(event), dependencies), "guarded startup");
        } catch (error) { failure = error; }
        // Baseline currently starts: always join that listener and its workers before asserting RED.
        if (daemon) { await bounded(daemon.stop(), "unexpected daemon stop"); daemon = undefined; }
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error("Expected startup refusal for the owned restore marker");
        expect(failure.message).toMatch(/startup failed|restore/i);
        expect(logs.some(record => record.message === "[execution owner] acquired")).toBe(true);
        expect(logs.some(record => record.message === "[storage] enable WAL attempt" || record.message === "[storage] migrate attempt")).toBe(false);
        expect(events.some(event => "operation" in event && event.operation === "start" && event.phase === "outcome" && event.success === false)).toBe(true);
        expect(nativeCalls).toBe(0); expect(timers).toBe(0); expect(backupCalls).toBe(0); expect(backupTimers).toBe(0);
        const afterMarker = await lstat(marker, { bigint: true }), afterDb = await lstat(path, { bigint: true });
        expect(afterMarker.ino).toBe(originalMarker.ino); expect(afterMarker.mode).toBe(originalMarker.mode);
        expect(afterDb.ino).toBe(originalDb.ino); expect(await readFile(path)).toEqual(bytes);
        if (scenario === "regular") expect(await readFile(marker, "utf8")).toBe(markerText);
        const check = new Database(path, { readonly: true, create: false });
        try {
          expect(check.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
          expect(check.query("SELECT text FROM thoughts WHERE id='owned-root'").get()).toEqual({ text: thoughtText });
          expect(check.query("SELECT status,generation FROM runs WHERE id='owned-run'").get()).toEqual({ status: "queued", generation: 0 });
          expect(check.query("SELECT count(*) AS n FROM execution_owners").get()).toEqual({ n: 0 });
        } finally { check.close(); }
        const acquired = await bounded(ExecutionOwnerLease.acquire(path), "lease after refusal");
        acquired.release();
        const text = JSON.stringify({ error: failure.message, events, logs });
        for (const secret of [dir, markerText, thoughtText, credentials.user, credentials.ai]) expect(text).not.toContain(secret);
      } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
    }
  }
}, 45000);

test("execution-owner contention wins before inspecting a restore marker, and refusal releases its own lease", async () => {
  const dir = await mkdtemp("/tmp/opencode/restore-startup-"), path = join(dir, "knowledge.sqlite"), marker = join(dir, ".restore-in-progress");
  let daemon: RunningDaemon | undefined, lease: ExecutionOwnerLease | undefined;
  try {
    await writeFile(marker, markerText, { mode: 0o600 });
    lease = await ExecutionOwnerLease.acquire(path);
    const initial = await lstat(path, { bigint: true });
    let failure: unknown;
    try { daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials }, () => {}, { logSink: () => {} }), "contended startup"); }
    catch (error) { failure = error; }
    if (daemon) { await bounded(daemon.stop(), "unexpected daemon stop"); daemon = undefined; }
    expect(failure instanceof Error ? failure.message : null).toBe("Daemon startup failed: execution owner already held");
    expect((await lstat(path, { bigint: true })).ino).toBe(initial.ino);
    expect(await readFile(marker, "utf8")).toBe(markerText);
    lease.release(); lease = undefined;
    try { daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials }, () => {}, { logSink: () => {} }), "marked startup"); }
    catch (error) { failure = error; }
    if (daemon) { await bounded(daemon.stop(), "unexpected daemon stop"); daemon = undefined; failure = null; }
    expect(failure).toBeInstanceOf(Error);
    expect((await lstat(path, { bigint: true })).ino).toBe(initial.ino);
    expect(await readFile(marker, "utf8")).toBe(markerText);
    lease = await bounded(ExecutionOwnerLease.acquire(path), "lease after marked refusal");
  } finally { await daemon?.stop(); lease?.release(); await rm(dir, { recursive: true, force: true }); }
}, 15000);
