import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { captureBackup } from "../src/backup/capture";
import { recoverRestoreStage, stageRestoreSnapshot, type RestoreStage } from "../src/backup/restore-staging";
import { backupTableShapes } from "../src/backup/schema";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger } from "../src/logging";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient, config, logger, now, setup } from "./agentic-search-capability-fixture";

const restoredAt = "2031-02-03T04:05:06.000Z";
const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const clock = { at: "2030-01-01T12:00:00Z", timeZone: "UTC" };
const int64Max = 9223372036854775807n;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owned fixture timed out")), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

interface Fixture {
  readonly stage: RestoreStage;
  readonly source: string;
  readonly activeRun: string;
  readonly terminalRun: string;
  readonly searchRun: string;
  readonly rowlessRun: string;
  readonly batch: string;
  readonly holder: string;
  readonly waiter: string;
  readonly composer: string;
}

async function fixture(action: (fixture: Fixture) => Promise<void>, overflow = false, expectDisposeConflict = false): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/restore-recovery-"), source = join(dir, "source.sqlite");
  const output = join(dir, "capture"), parent = join(dir, "stage");
  let daemon: RunningDaemon | undefined, stage: RestoreStage | undefined;
  try {
    await mkdir(output, { mode: 0o700 }); await mkdir(parent, { mode: 0o700 });
    daemon = await startDaemon({ dbPath: source, port: 0, credentials }, () => {}, { logSink: () => {} });
    await daemon.stop(); daemon = undefined;
    const lease = await ExecutionOwnerLease.acquire(source, logger), db = new Database(source);
    let worker: ConfiguredRunWorker | undefined;
    let ids: Omit<Fixture, "stage" | "source">;
    try {
      migrate(db, logger); lease.register(db);
      let sequence = 0; const id = () => `fixture${String(++sequence).padStart(24, "0")}`;
      const sources = { id, now, logger }, store = new SqliteStore(db);
      const client = new ScriptedClient(() => ({ version: 1, kind: "search-reply", reply: "owned reply", disposition: "done", sourceThoughtIds: [] }));
      worker = new ConfiguredRunWorker({ db, config, id, now, logger, executionOwner: lease,
        resolve: async () => ({ url: "http://127.0.0.1:44991" }), client: () => client });
      const purged = setup(db, store, id), retention = worker.searchRetention();
      if (!retention) throw new Error("Missing owned retention controller");
      client.dropNextAck = true;
      for (let i = 0; i < 96 && client.prompts.length === 0; i++) await bounded(worker.tick(purged.runId));
      if (client.prompts.length !== 1) throw new Error("Owned search did not reach native submission");
      client.historyMode = "empty";
      store.searchSessions(sources, retention).delete("user", purged.session.id);
      if (!db.query("SELECT run_id FROM search_native_cleanup WHERE run_id=?").get(purged.runId) ||
          db.query("SELECT id FROM runs WHERE id=?").get(purged.runId)) throw new Error("Missing rowless cleanup fixture");
      worker.pause(); await bounded(worker.drain()); worker = undefined;

      store.saveThought({ id: "owned-root", text: "owned recovery text", title: null, author: "user", kind: "captured-original",
        createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
      const ops = new SqliteRunOperations(db, sources), runs = new SqliteRunRepository(db, sources);
      const active = ops.admitWeave("user", { subjectId: "owned-root", triggerId: "capture:owned-root" });
      const claim = runs.claim(active.id);
      new SqliteRunProtocolRepository(db, logger).prepare(claim, { promptId: active.promptId, input: "owned private prompt" });
      new SqliteAgentBindings(db, logger).bind(active.id, { sessionId: active.sessionId, serviceUrl: "http://127.0.0.1:44991",
        location: { directory: "/tmp/opencode/owned-recovery-agent" }, model: { providerID: "fixture", id: "fixture" },
        permissions: [{ action: "*", resource: "*", effect: "allow" }], protocolVersion: 1 }, claim);
      const terminal = ops.admitWeave("user", { subjectId: "owned-root", triggerId: "recovery-terminal" });
      runs.stop(terminal.id);
      db.run("UPDATE runs SET generation=? WHERE id=?", [int64Max, terminal.id]);
      if (overflow) db.run("UPDATE runs SET generation=? WHERE id=?", [int64Max, active.id]);
      db.run("INSERT INTO restore_fences VALUES ('run',?,?,?,?)", [terminal.id, "a".repeat(64), now(), "{}\n"]);

      const sessions = store.searchSessions(sources), session = sessions.create("user", "recovery-search", {}).session;
      const token = sessions.openComposer("user", session.id);
      const turn = sessions.admitTurn("user", session.id, "recovery-turn", { text: "owned question", startingThoughtIds: [], requestClock: clock,
        composerId: token.composerId, contextToken: token.contextToken });
      const anotherSession = sessions.create("user", "recovery-composer", {}).session;
      const composer = sessions.openComposer("user", anotherSession.id);
      const imports = new SqliteMarkdownImports(db, sources), batch = imports.createBatch("user", "recovery-batch");
      const bytes = new TextEncoder().encode("owned pending markdown\r\n");
      const holder = imports.admitFile("user", batch.id, "holder", "holder.md", bytes);
      const waiter = imports.admitFile("user", batch.id, "waiter", "waiter.md", bytes);
      ids = { activeRun: active.id, terminalRun: terminal.id, searchRun: turn.run.id, rowlessRun: purged.runId,
        batch: batch.id, holder: holder.id, waiter: waiter.id, composer: composer.composerId };
    } finally {
      try { if (worker) { worker.pause(); await bounded(worker.drain()); } }
      finally { db.close(); lease.release(); }
    }
    const captured = await captureBackup({ databasePath: source, mediaDirectory: `${source}.media`, outputDirectory: output, logger });
    stage = await stageRestoreSnapshot({ snapshotDirectory: captured.snapshotDirectory, stagingParentDirectory: parent, logger });
    await action({ stage, source, ...ids });
  } finally {
    await daemon?.stop();
    try { if (stage) await stage.dispose(); }
    catch (error) { if (!expectDisposeConflict) throw error; }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}

function readDatabase<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true, create: false, safeIntegers: true });
  try { return read(db); } finally { db.close(); }
}
function allTables(path: string) {
  return readDatabase(path, db => backupTableShapes.map(shape => ({ name: shape.name,
    rows: db.query(`SELECT ${shape.preserveRowid ? "rowid AS preserved_rowid," : ""}* FROM "${shape.name}" ORDER BY ${shape.preserveRowid ? "rowid" : shape.primaryKey.map(key => `"${key}"`).join(",")}`).all() })));
}
function row(db: Database, table: string, column: string, id: string) {
  return db.query(`SELECT * FROM ${table} WHERE ${column}=?`).get(id);
}

test("recovery fences historical identities and changes only documented local execution fields", async () => fixture(async f => {
  const before = allTables(f.stage.databasePath), marker = await readFile(join(f.stage.stagingDirectory, ".restore-in-progress"));
  const sourceBefore = allTables(f.source);
  const original = readDatabase(f.stage.databasePath, db => ({
    active: row(db, "runs", "id", f.activeRun), terminal: row(db, "runs", "id", f.terminalRun),
    search: row(db, "runs", "id", f.searchRun), cleanup: row(db, "search_native_cleanup", "run_id", f.rowlessRun),
    holder: row(db, "markdown_import_files", "id", f.holder), waiter: row(db, "markdown_import_files", "id", f.waiter),
    composer: row(db, "search_composer_contexts", "id", f.composer),
    priorFence: db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(f.terminalRun),
    runs: db.query<{ n: bigint }, []>("SELECT count(*) AS n FROM runs WHERE status IN ('queued','submitting','running','uncertain')").get(),
    files: db.query<{ n: bigint }, []>("SELECT count(*) AS n FROM markdown_import_files WHERE outcome IS NULL").get(),
    composers: db.query<{ n: bigint }, []>("SELECT count(*) AS n FROM search_composer_contexts WHERE state='active'").get(),
    activeFields: db.query<{ status: string; generation: bigint }, [string]>("SELECT status,generation FROM runs WHERE id=?").get(f.activeRun),
    searchFields: db.query<{ status: string; generation: bigint; open_slot: bigint; outcome_reason: string | null }, [string]>(
      "SELECT r.status,r.generation,t.open_slot,t.outcome_reason FROM runs r JOIN search_turns t ON t.run_id=r.id WHERE r.id=?").get(f.searchRun),
    identities: db.query<{ n: bigint }, []>(`SELECT count(*) AS n FROM (
      SELECT 'run' AS kind,id FROM runs UNION SELECT 'run',run_id FROM search_native_cleanup
      UNION SELECT 'import-batch',id FROM markdown_imports UNION SELECT 'import-file',id FROM markdown_import_files
      UNION SELECT 'composer',id FROM search_composer_contexts)`).get(),
  }));
  if (!original.runs || !original.files || !original.composers || !original.activeFields || !original.searchFields || !original.identities) throw new Error("Missing owned recovery fixture counts");
  const activeFields = original.activeFields, searchFields = original.searchFields;
  expect(original.cleanup).not.toBeNull(); expect(original.holder).not.toBeNull(); expect(original.waiter).not.toBeNull();
  const result = await recoverRestoreStage(f.stage, { restoredAt, logger });
  expect(result.manifestSha256).toBe(f.stage.manifestSha256); expect(result.restoredAt).toBe(restoredAt);
  expect(BigInt(result.interruptedRuns)).toBe(original.runs.n);
  expect(BigInt(result.interruptedImportFiles)).toBe(original.files.n);
  expect(BigInt(result.invalidatedComposers)).toBe(original.composers.n);
  expect(BigInt(result.addedFences)).toBe(original.identities.n - 1n);
  readDatabase(f.stage.databasePath, db => {
    expect(row(db, "runs", "id", f.terminalRun)).toEqual(original.terminal);
    expect(row(db, "search_native_cleanup", "run_id", f.rowlessRun)).toEqual(original.cleanup);
    expect(db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(f.terminalRun)).toEqual(original.priorFence);
    for (const id of [f.activeRun, f.searchRun]) {
      expect(db.query("SELECT status FROM runs WHERE id=?").get(id)).toEqual({ status: "interrupted" });
    }
    expect(db.query("SELECT status,generation FROM runs WHERE id=?").get(f.activeRun))
      .toEqual({ status: "interrupted", generation: activeFields.generation + 1n });
    expect(db.query("SELECT original_state_json FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(f.activeRun))
      .toEqual({ original_state_json: `{"runs.generation":{"$integer":"${activeFields.generation}"},"runs.status":"${activeFields.status}"}\n` });
    expect(db.query("SELECT original_state_json FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(f.searchRun))
      .toEqual({ original_state_json: `{"runs.generation":{"$integer":"${searchFields.generation}"},"runs.status":"${searchFields.status}","search_turns.open_slot":{"$integer":"${searchFields.open_slot}"}}\n` });
    expect(db.query("SELECT outcome,reason_code FROM markdown_import_files WHERE id IN (?,?) ORDER BY id").all(f.holder, f.waiter))
      .toEqual([{ outcome: "interrupted", reason_code: "interrupted" }, { outcome: "interrupted", reason_code: "interrupted" }]);
    expect(db.query("SELECT state FROM search_composer_contexts WHERE id=?").get(f.composer)).toEqual({ state: "invalidated" });
    for (const [kind, id] of [["run", f.activeRun], ["run", f.searchRun], ["run", f.rowlessRun], ["import-batch", f.batch],
      ["import-file", f.holder], ["import-file", f.waiter], ["composer", f.composer]] as const) {
      expect(db.query("SELECT snapshot_sha256,restored_at FROM restore_fences WHERE entity_kind=? AND entity_id=?").get(kind, id))
        .toEqual({ snapshot_sha256: f.stage.manifestSha256, restored_at: restoredAt });
    }
    expect(db.query("SELECT original_state_json FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(f.rowlessRun))
      .toEqual({ original_state_json: "{}\n" });
    expect(db.query("SELECT original_state_json FROM restore_fences WHERE entity_kind='composer' AND entity_id=?").get(f.composer))
      .toEqual({ original_state_json: '{"search_composer_contexts.state":"active"}\n' });
    expect(db.query("SELECT original_state_json FROM restore_fences WHERE entity_kind='import-file' AND entity_id=?").get(f.holder))
      .toEqual({ original_state_json: '{"markdown_import_files.outcome":null,"markdown_import_files.reason_code":null}\n' });
    expect(db.query("SELECT open_slot,outcome_reason FROM search_turns WHERE run_id=?").get(f.searchRun))
      .toEqual({ open_slot: 0n, outcome_reason: searchFields.outcome_reason });
  });
  const after = allTables(f.stage.databasePath);
  for (const table of ["run_steps", "agent_bindings", "run_operation_receipts", "run_context", "search_native_cleanup", "markdown_import_payloads", "search_composer_dependencies"]) {
    expect(after.find(item => item.name === table)).toEqual(before.find(item => item.name === table));
  }
  expect(allTables(f.source)).toEqual(sourceBefore);
  expect(Array.from(await readFile(join(f.stage.stagingDirectory, ".restore-in-progress")))).toEqual(Array.from(marker));
  await recoverRestoreStage(f.stage, { restoredAt, logger });
  expect(allTables(f.stage.databasePath)).toEqual(after);
  await expect(recoverRestoreStage(f.stage, { restoredAt: "2032-02-03T04:05:06.000Z", logger })).rejects.toThrow();
  expect(allTables(f.stage.databasePath)).toEqual(after);
}), 30000);

test("generation overflow refuses the whole recovery, while a terminal int64 maximum remains valid", async () => fixture(async f => {
  const before = allTables(f.stage.databasePath);
  const failure = await recoverRestoreStage(f.stage, { restoredAt, logger }).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure && typeof failure === "object" && "code" in failure ? failure.code : null).toBe("invalid-records");
  expect(allTables(f.stage.databasePath)).toEqual(before);
  expect(readDatabase(f.stage.databasePath, db => db.query("SELECT generation FROM runs WHERE id=?").get(f.terminalRun))).toEqual({ generation: int64Max });
}, true), 30000);

test("abort at the validated boundary rolls back all recovery writes and leaves the stage disposable", async () => fixture(async f => {
  const before = allTables(f.stage.databasePath), controller = new AbortController(); let reached = false;
  const abortLogger = createLogger("verbose", record => { if (record.message === "[restore] recovery validated") { reached = true; controller.abort(); } });
  await expect(recoverRestoreStage(f.stage, { restoredAt, signal: controller.signal, logger: abortLogger })).rejects.toThrow();
  expect(reached).toBe(true); expect(allTables(f.stage.databasePath)).toEqual(before);
  await f.stage.dispose(); await f.stage.dispose();
  await expect(recoverRestoreStage(f.stage, { restoredAt, logger })).rejects.toThrow();
}), 30000);

test("recovery refuses forged and disposed capabilities, and preserves unexpected owned artifacts", async () => fixture(async f => {
  const before = allTables(f.stage.databasePath);
  await expect(recoverRestoreStage({ ...f.stage }, { restoredAt, logger })).rejects.toThrow();
  expect(allTables(f.stage.databasePath)).toEqual(before);
  const unknown = join(f.stage.stagingDirectory, "caller-owned"); await writeFile(unknown, "preserve", { mode: 0o600 });
  try {
    await expect(recoverRestoreStage(f.stage, { restoredAt, logger })).rejects.toThrow();
    expect(await readFile(unknown, "utf8")).toBe("preserve"); expect(allTables(f.stage.databasePath)).toEqual(before);
    await expect(f.stage.dispose()).rejects.toThrow(); expect(await readFile(unknown, "utf8")).toBe("preserve");
  } finally { await rm(unknown); }
  await expect(recoverRestoreStage(f.stage, { restoredAt, logger })).rejects.toThrow();
}, false, true), 30000);
