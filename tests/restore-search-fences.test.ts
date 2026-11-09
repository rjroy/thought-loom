import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { RunSupervisor } from "../src/agent/supervisor";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteSearchCleanup } from "../src/storage/search-cleanup";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient, config, knowledge, logger, now, setup } from "./agentic-search-capability-fixture";

const clock = { at: "2030-01-01T12:00:00Z", timeZone: "UTC" };
function fence(db: Database, kind: "run" | "composer", id: string): void {
  db.run("INSERT INTO restore_fences VALUES (?,?,?,?,?)", [kind, id, "a".repeat(64), now(), "{}"]);
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture timed out")), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function fixture(action: (db: Database, store: SqliteStore, worker: ConfiguredRunWorker, client: ScriptedClient, id: () => string, lease: ExecutionOwnerLease, calls: { resolutions: number }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join("/tmp/opencode", "restore-search-")), path = join(dir, "owned.sqlite");
  const lease = await ExecutionOwnerLease.acquire(path, logger), db = new Database(path);
  let worker: ConfiguredRunWorker | undefined;
  try {
    migrate(db, logger); lease.register(db);
    let sequence = 0; const id = () => `fixture${String(++sequence).padStart(24, "0")}`;
    const store = new SqliteStore(db), client = new ScriptedClient(() => ({ version: 1, kind: "search-reply", reply: "owned reply", disposition: "done", sourceThoughtIds: [] }));
    const calls = { resolutions: 0 };
    worker = new ConfiguredRunWorker({ db, config, id, now, logger, executionOwner: lease,
      resolve: async () => { calls.resolutions++; return { url: "http://127.0.0.1:44991" }; }, client: () => client });
    await action(db, store, worker, client, id, lease, calls);
  } finally {
    if (worker) { worker.pause(); await bounded(worker.drain()); }
    db.close(); lease.release(); rmSync(dir, { recursive: true, force: true });
  }
}
async function until(worker: ConfiguredRunWorker, runId: string, done: () => boolean): Promise<void> {
  for (let i = 0; i < 96 && !done(); i++) await bounded(worker.tick(runId));
  expect(done()).toBe(true);
}
function cleanup(db: Database, runId: string): unknown {
  return db.query("SELECT rowid,* FROM search_native_cleanup WHERE run_id=?").get(runId);
}

test("a fenced active composer cannot authorize a turn with its still-valid token; fresh work and history remain available", async () => {
  await fixture(async (db, store, _worker, _client, id) => {
    const sessions = store.searchSessions({ id, now, logger });
    const session = sessions.create("user", "saved", {}).session;
    const old = sessions.openComposer("user", session.id);
    const input = { text: "old question", startingThoughtIds: [], requestClock: clock, composerId: old.composerId, contextToken: old.contextToken };
    expect(db.query("SELECT state FROM search_composer_contexts WHERE id=?").get(old.composerId)).toEqual({ state: "active" });
    fence(db, "composer", old.composerId);
    const before = db.query("SELECT rowid,* FROM search_composer_contexts WHERE id=?").get(old.composerId);
    expect(() => sessions.admitTurn("user", session.id, "old-key", input)).toThrow();
    expect(db.query("SELECT rowid,* FROM search_composer_contexts WHERE id=?").get(old.composerId)).toEqual(before);
    expect(sessions.turnByKey("user", session.id, "old-key")).toBeNull();
    expect(sessions.get("user", session.id)).not.toBeNull();
    const fresh = sessions.openComposer("user", session.id);
    expect(fresh.composerId).not.toBe(old.composerId);
    const turn = sessions.admitTurn("user", session.id, "fresh-key", { ...input, composerId: fresh.composerId, contextToken: fresh.contextToken });
    expect(sessions.turnByKey("user", session.id, "fresh-key")).toEqual(turn);
    expect(() => sessions.admitTurn("user", session.id, "another-old-key", input)).toThrow();
  });
});

test("purged cleanup is fenced at direct authority and worker boundaries, and excluded from supervisor scans", async () => {
  await fixture(async (db, store, worker, client, id, lease, calls) => {
    const first = setup(db, store, id), retention = worker.searchRetention();
    if (!retention) throw new Error("missing owned retention controller");
    client.dropNextAck = true;
    await until(worker, first.runId, () => client.prompts.length === 1);
    client.historyMode = "empty";
    store.searchSessions({ id, now, logger }, retention).delete("user", first.session.id);
    expect(db.query("SELECT id FROM runs WHERE id=?").get(first.runId)).toBeNull();
    const journal = new SqliteSearchCleanup(db, lease, logger), identity = journal.prepare(first.runId);
    if (!identity) throw new Error("fixture did not create qualified purged cleanup");
    const before = cleanup(db, first.runId), nativeBefore = { resolutions: calls.resolutions, history: client.historyRequests.length, prompts: client.prompts.length };
    fence(db, "run", first.runId);
    let prepared: ReturnType<SqliteSearchCleanup["prepare"]> = null;
    try { prepared = journal.prepare(first.runId); } catch { /* Refusal may throw rather than return no authority. */ }
    expect(prepared).toBeNull();
    expect(() => journal.drained(identity)).toThrow();
    expect(() => journal.authorize(identity)).toThrow();
    expect(() => journal.observed(identity, { state: "ownership-conflict" })).toThrow();
    await bounded(worker.tick(first.runId));
    expect(cleanup(db, first.runId)).toEqual(before);
    expect(calls.resolutions).toBe(nativeBefore.resolutions);
    expect(client.historyRequests).toHaveLength(nativeBefore.history);
    expect(client.prompts).toHaveLength(nativeBefore.prompts);
    expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]);

    // A separate eligible row proves both scan progress and the positive native path.
    const session = first.sessions.create("user", "fresh", {}).session;
    const composer = first.sessions.openComposer("user", session.id);
    const turn = first.sessions.admitTurn("user", session.id, "fresh-turn", { text: "fresh", startingThoughtIds: [], requestClock: clock, composerId: composer.composerId, contextToken: composer.contextToken });
    client.dropNextAck = true;
    await until(worker, turn.run.id, () => client.prompts.length === 2);
    const oldNative = client.prompts[0]?.sessionID, freshNative = client.prompts[1]?.sessionID;
    if (!oldNative || !freshNative || oldNative === freshNative) throw new Error("missing distinct owned native sessions");
    store.searchSessions({ id, now, logger }, retention).delete("user", session.id);
    const historyBeforeScan = client.historyRequests.length;
    const visited: string[] = [];
    const supervisor = new RunSupervisor({ db, logger, startTimer: () => () => {}, worker: { tick: async runId => { visited.push(runId); await worker.tick(runId); }, pause: () => {} } });
    supervisor.start();
    try {
      for (let i = 0; i < 8 && client.historyRequests.length === historyBeforeScan; i++) await bounded(supervisor.poll());
      expect(visited).toContain(turn.run.id); expect(visited).not.toContain(first.runId);
      const scanHistory = client.historyRequests.slice(historyBeforeScan);
      expect(scanHistory).toContain(freshNative); expect(scanHistory).not.toContain(oldNative);
      expect(cleanup(db, first.runId)).toEqual(before);
    } finally { await bounded(supervisor.stop()); }
  });
});

test("local Delete preserves old fenced cleanup and performs normal cleanup for fresh work in the same session", async () => {
  await fixture(async (db, store, worker, client, id, lease) => {
    const old = setup(db, store, id), library = knowledge(db), retention = worker.searchRetention();
    if (!retention) throw new Error("missing retention controller");
    const other = old.sessions.create("user", "other", {}).session;
    client.dropNextAck = true;
    await until(worker, old.runId, () => client.prompts.length === 1);
    new SqliteRunRepository(db, { id, now, logger }).stop(old.runId);
    const journal = new SqliteSearchCleanup(db, lease, logger);
    expect(journal.prepare(old.runId)).not.toBeNull();
    const oldCleanup = cleanup(db, old.runId);
    fence(db, "run", old.runId);
    const composer = old.sessions.openComposer("user", old.session.id);
    const fresh = old.sessions.admitTurn("user", old.session.id, "fresh", { text: "fresh question", startingThoughtIds: [], requestClock: clock, composerId: composer.composerId, contextToken: composer.contextToken });
    client.dropNextAck = true;
    await until(worker, fresh.run.id, () => client.prompts.length === 2);
    const beforeHistory = client.historyRequests.length;
    client.historyMode = "empty";
    store.searchSessions({ id, now, logger }, retention).delete("user", old.session.id);
    expect(db.query("SELECT id FROM runs WHERE id=?").get(old.runId)).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM search_messages WHERE session_id=?").get(old.session.id)).toEqual({ n: 0 });
    expect(cleanup(db, old.runId)).toEqual(oldCleanup);
    expect(cleanup(db, fresh.run.id)).not.toBeNull();
    expect(db.query("SELECT entity_id FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(old.runId)).toEqual({ entity_id: old.runId });
    await until(worker, fresh.run.id, () => client.historyRequests.length > beforeHistory);
    await bounded(worker.tick(old.runId));
    expect(cleanup(db, old.runId)).toEqual(oldCleanup);
    expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]);
    expect(old.sessions.get("user", other.id)).not.toBeNull(); expect(knowledge(db)).toEqual(library);
  });
});
