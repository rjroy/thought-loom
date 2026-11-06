import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore, migrate } from "../src/storage/sqlite";
import { SearchStorageError } from "../src/domain/agentic-search";
import type { Claim } from "../src/domain/run";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Proposed trusted internal persistence seam, separate from user session commands.
// The dispatcher, not a user, owns claim/prompt and the completed step. The SQL
// fixture below represents already-persisted native evidence; it does not test a model.
interface Receipt { readonly type: "discovery-add"; readonly entryId: string; readonly outcome: "added" | "already-active" }
interface Publication {
  addDiscovery(claim: Claim, promptId: string): Receipt;
  finalizeReply(claim: Claim, promptId: string): void;
}
interface Removal { removeDiscovery(actor: "user" | "ai", sessionId: string, entryId: string): void }

function fixture(action: (db: Database, publisher: Publication, removal: Removal, sessionId: string, runId: string, prompt: string, clock: { now: string }) => void,
  options: { db?: Database; bound?: boolean } = {}): void {
  const db = options.db ?? new Database(":memory:");
  try {
    migrate(db);
    let id = 0;
    const clock = { now: "2030-01-01T12:00:00.000Z" };
    const sources = { id: () => `fixture-${++id}`, now: () => clock.now };
    const store = new SqliteStore(db);
    const sessions = store.searchSessions(sources);
    const session = sessions.create("user", "session-key", {}).session;
    db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES
      ('target','target text','user','captured-original','2030','capture'),
      ('evidence','evidence text','user','captured-original','2030','capture'),
      ('uncited','uncited text','user','captured-original','2030','capture');
      INSERT INTO thought_titles VALUES ('target','T','user'),('evidence','E','user'),('uncited','U','user');
      INSERT INTO thought_source_seals VALUES ('target'),('evidence'),('uncited');`);
    const composer = sessions.openComposer("user", session.id);
    const turn = sessions.admitTurn("user", session.id, "turn-key", { text: "find it", startingThoughtIds: [],
      requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
    const runId = turn.receipt.runId;
    const run = db.query("SELECT prompt_id,session_id FROM runs WHERE id=?").get(runId) as { prompt_id: string; session_id: string };
    db.run("UPDATE runs SET status='running',generation=1 WHERE id=?", [runId]);
    if (options.bound !== false) db.run("INSERT INTO agent_bindings VALUES (?,?, 'https://fixture.invalid','/owned','{}','[]',1)", [runId, run.session_id]);
    for (const [ref, full] of [["target", 1], ["evidence", 0], ["uncited", 0]] as const) {
      db.run("INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES (?,'thought',?,?)", [runId, ref, full]);
    }
    const factory: unknown = Reflect.get(store, "searchPublication");
    expect(typeof factory).toBe("function");
    if (typeof factory !== "function") throw new Error("missing trusted search publication facet");
    const candidate: unknown = Reflect.apply(factory, store, [sources]);
    expect(candidate).not.toBeNull();
    if (candidate === null || typeof candidate !== "object") throw new Error("invalid publication facet");
    for (const method of ["addDiscovery", "finalizeReply"]) expect(typeof Reflect.get(candidate, method)).toBe("function");
    expect(typeof Reflect.get(sessions, "removeDiscovery")).toBe("function");
    expect(Reflect.get(sessions, "addDiscovery")).toBeUndefined();
    expect(Reflect.get(sessions, "finalizeReply")).toBeUndefined();
    action(db, candidate as Publication, sessions as unknown as Removal, session.id, runId, run.prompt_id, clock);
  } finally { db.close(); }
}

function completed(db: Database, runId: string, prompt: string, envelope: object, position?: number): void {
  if (position !== undefined) db.run("INSERT INTO run_steps(run_id,position,prompt_id,state,native_state) VALUES (?, ?, ?, 'prepared','unknown')", [runId, position, prompt]);
  db.run("UPDATE run_steps SET input='fixture native input',state='completed',native_state='completed',envelope_json=? WHERE run_id=? AND prompt_id=?", [JSON.stringify(envelope), runId, prompt]);
}
const proposal = (why: string) => ({ version: 1, kind: "request", request: { capability: "addDiscovery", arguments: { thoughtId: "target", why, evidenceThoughtIds: ["evidence"] } } });
const claim = (runId: string): Claim => ({ runId, generation: 1 });
function stepProcessed(db: Database, runId: string, prompt: string): void { db.run("UPDATE run_steps SET state='processed' WHERE run_id=? AND prompt_id=?", [runId, prompt]); }
function snapshot(db: Database): unknown {
  return ["search_sessions", "search_revisions", "runs", "run_steps", "search_turns", "search_messages", "search_discoveries", "search_content_dependencies", "run_context"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
}

test("discovery receipts replay without reviving removal; a fresh step can rediscover", () => fixture((db, publisher, removal, sessionId, runId, p1, clock) => {
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  completed(db, runId, p1, proposal("first rationale"));
  const first = publisher.addDiscovery(claim(runId), p1);
  expect(first).toEqual({ type: "discovery-add", entryId: expect.any(String), outcome: "added" });
  expect(db.query("SELECT position,why,removed_at FROM search_discoveries WHERE id=?").get(first.entryId)).toEqual({ position: 0, why: "first rationale", removed_at: null });
  expect(db.query("SELECT ref_kind,ref_id FROM search_content_dependencies WHERE discovery_id=? ORDER BY ref_id").all(first.entryId)).toEqual([
    { ref_kind: "thought", ref_id: "evidence" }, { ref_kind: "thought", ref_id: "target" }, { ref_kind: "thought", ref_id: "uncited" },
  ]);
  expect(JSON.parse((db.query("SELECT result_json FROM run_steps WHERE prompt_id=?").get(p1) as { result_json: string }).result_json)).toEqual(first);
  const active = snapshot(db);
  expect(publisher.addDiscovery(claim(runId), p1)).toEqual(first);
  expect(snapshot(db)).toEqual(active);
  stepProcessed(db, runId, p1);
  completed(db, runId, "p2", proposal("different rationale"), 1);
  const beforeNoop = db.query("SELECT revision,last_activity_at FROM search_sessions WHERE id=?").get(sessionId);
  const duplicate = publisher.addDiscovery(claim(runId), "p2");
  expect(duplicate).toEqual({ type: "discovery-add", entryId: first.entryId, outcome: "already-active" });
  expect(db.query("SELECT revision,last_activity_at FROM search_sessions WHERE id=?").get(sessionId)).toEqual(beforeNoop);
  expect(() => removal.removeDiscovery("ai", sessionId, first.entryId)).toThrow();
  clock.now = "2030-01-01T13:00:00.000Z";
  removal.removeDiscovery("user", sessionId, first.entryId);
  const afterRemove = snapshot(db);
  expect(publisher.addDiscovery(claim(runId), "p2")).toEqual(duplicate);
  expect(snapshot(db)).toEqual(afterRemove);
  stepProcessed(db, runId, "p2");
  completed(db, runId, "p3", proposal("rediscovered"), 2);
  const second = publisher.addDiscovery(claim(runId), "p3");
  expect(second.outcome).toBe("added");
  expect(second.entryId).not.toBe(first.entryId);
  const beforeRetry = snapshot(db);
  expect(publisher.addDiscovery(claim(runId), p1)).toEqual(first);
  expect(snapshot(db)).toEqual(beforeRetry);
  removal.removeDiscovery("user", sessionId, first.entryId);
  expect(snapshot(db)).toEqual(beforeRetry);
  expect(db.query("SELECT position,why,removed_at FROM search_discoveries WHERE id=?").get(second.entryId)).toEqual({ position: 1, why: "rediscovered", removed_at: null });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}));

test("discovery requires current claim, prompt, eligible sources and full reads in this run", () => fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
  completed(db, runId, prompt, proposal("why"));
  const initial = snapshot(db);
  expect(() => publisher.addDiscovery({ runId, generation: 0 }, prompt)).toThrow();
  expect(() => publisher.addDiscovery(claim(runId), "foreign-prompt")).toThrow();
  expect(snapshot(db)).toEqual(initial);
  const unread = snapshot(db);
  expect(() => publisher.addDiscovery(claim(runId), prompt)).toThrow();
  expect(snapshot(db)).toEqual(unread);
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  db.run("INSERT INTO rejected_thoughts VALUES ('uncited')");
  expect(() => publisher.addDiscovery(claim(runId), prompt)).toThrow();
  expect(db.query("SELECT count(*) AS n FROM search_discoveries").get()).toEqual({ n: 0 });
  expect(db.query("SELECT result_json FROM run_steps WHERE prompt_id=?").get(prompt)).toEqual({ result_json: null });
}));

test("discovery receipt and occurrence roll back together when dependency insertion fails", () => fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  completed(db, runId, prompt, proposal("why"));
  db.exec(`CREATE TEMP TRIGGER fail_discovery_dependency BEFORE INSERT ON search_content_dependencies
    WHEN NEW.discovery_id IS NOT NULL AND EXISTS (SELECT 1 FROM search_discoveries WHERE id=NEW.discovery_id)
      AND EXISTS (SELECT 1 FROM run_steps WHERE prompt_id=(SELECT added_prompt_id FROM search_discoveries WHERE id=NEW.discovery_id) AND result_json IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'injected-after-occurrence-and-receipt'); END`);
  const before = snapshot(db);
  let failure: unknown;
  try { publisher.addDiscovery(claim(runId), prompt); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SearchStorageError);
  if (!(failure instanceof SearchStorageError) || !(failure.cause instanceof Error)) throw new Error("missing sanitized injected failure");
  expect(failure.message).toBe("search-persistence-failed");
  expect(failure.cause.message).toContain("injected-after-occurrence-and-receipt");
  expect(snapshot(db)).toEqual(before);
  db.exec("DROP TRIGGER temp.fail_discovery_dependency");
  expect(publisher.addDiscovery(claim(runId), prompt).outcome).toBe("added");
}));

test.each(["awaiting-user", "done"] as const)("final %s reply commits its inherited dependencies and releases the slot", disposition => fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  completed(db, runId, prompt, { version: 1, kind: "search-reply", reply: "A useful clarification", disposition, sourceThoughtIds: ["evidence"] });
  const knowledge = ["thoughts", "thought_titles", "connections", "responses", "run_issued_thoughts", "run_operation_receipts"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  expect(() => publisher.finalizeReply({ runId, generation: 0 }, prompt)).toThrow();
  publisher.finalizeReply(claim(runId), prompt);
  expect(db.query("SELECT status,generation FROM runs WHERE id=?").get(runId)).toEqual(expect.objectContaining({ status: "completed" }));
  expect(db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot: 0 });
  const message = db.query("SELECT id,text,disposition FROM search_messages WHERE run_id=? AND role='assistant'").get(runId) as { id: string; text: string; disposition: string };
  expect(message).toEqual(expect.objectContaining({ text: "A useful clarification", disposition }));
  expect(db.query("SELECT ref_id FROM search_content_dependencies WHERE message_id=? ORDER BY ref_id").all(message.id)).toEqual([{ ref_id: "evidence" }, { ref_id: "target" }, { ref_id: "uncited" }]);
  expect(["thoughts", "thought_titles", "connections", "responses", "run_issued_thoughts", "run_operation_receipts"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all())).toEqual(knowledge);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}));

test("separate SQLite connections serialize removal, fresh adds and historical replay", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "search-publication-"));
  const path = join(dir, "owned.sqlite");
  try {
    fixture((db, firstPublisher, firstRemoval, sessionId, runId, p1, clock) => {
      const second = new Database(path);
      try {
        migrate(second);
        const sources = { id: () => "second-entry", now: () => clock.now };
        const secondStore = new SqliteStore(second);
        const secondPublisher = secondStore.searchPublication(sources);
        const secondRemoval = secondStore.searchSessions(sources);
        db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
        completed(db, runId, p1, proposal("first"));
        const first = firstPublisher.addDiscovery(claim(runId), p1);
        expect(secondPublisher.addDiscovery(claim(runId), p1)).toEqual(first);
        stepProcessed(db, runId, p1);
        completed(db, runId, "duplicate-prompt", proposal("duplicate"), 1);
        const duplicate = secondPublisher.addDiscovery(claim(runId), "duplicate-prompt");
        expect(duplicate).toEqual({ type: "discovery-add", entryId: first.entryId, outcome: "already-active" });
        expect(db.query("SELECT count(*) AS n FROM search_discoveries WHERE removed_at IS NULL").get()).toEqual({ n: 1 });
        secondRemoval.removeDiscovery("user", sessionId, first.entryId);
        expect(firstPublisher.addDiscovery(claim(runId), "duplicate-prompt")).toEqual(duplicate);
        stepProcessed(db, runId, "duplicate-prompt");
        completed(db, runId, "second-connection-prompt", proposal("second"), 2);
        const fresh = secondPublisher.addDiscovery(claim(runId), "second-connection-prompt");
        expect(fresh).toEqual({ type: "discovery-add", entryId: "second-entry", outcome: "added" });
        const before = snapshot(db);
        expect(firstPublisher.addDiscovery(claim(runId), p1)).toEqual(first);
        firstRemoval.removeDiscovery("user", sessionId, first.entryId);
        expect(snapshot(db)).toEqual(before);
        expect(second.query("SELECT id,position,removed_at FROM search_discoveries ORDER BY position").all()).toEqual([
          { id: first.entryId, position: 0, removed_at: clock.now }, { id: fresh.entryId, position: 1, removed_at: null },
        ]);
        expect(second.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { second.close(); }
    }, { db: new Database(path) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an older unfinished prompt cannot publish", () => fixture((db, publisher, _removal, _sessionId, runId, p1) => {
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  completed(db, runId, p1, proposal("first"));
  completed(db, runId, "later-prompt", proposal("second"), 1);
  const before = snapshot(db);
  expect(() => publisher.addDiscovery(claim(runId), p1)).toThrow();
  expect(() => publisher.addDiscovery(claim(runId), "later-prompt")).toThrow();
  expect(snapshot(db)).toEqual(before);
}));

test("a completed proposal with unrecognized arguments cannot publish", () => fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  const changed = proposal("why");
  completed(db, runId, prompt, { ...changed, request: { ...changed.request, arguments: { ...changed.request.arguments, entryId: "caller-chosen" } } });
  const before = snapshot(db);
  expect(() => publisher.addDiscovery(claim(runId), prompt)).toThrow();
  expect(snapshot(db)).toEqual(before);
}));

test("unbound runs cannot publish and a retained binding cannot be changed", () => {
  fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
    db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
    completed(db, runId, prompt, proposal("why"));
    const before = snapshot(db);
    expect(() => publisher.addDiscovery(claim(runId), prompt)).toThrow();
    expect(snapshot(db)).toEqual(before);
  }, { bound: false });
  fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
    db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
    completed(db, runId, prompt, proposal("why"));
    expect(() => db.run("UPDATE agent_bindings SET session_id='foreign' WHERE run_id=?", [runId])).toThrow();
    expect(publisher.addDiscovery(claim(runId), prompt).outcome).toBe("added");
  });
});

test.each(["interrupted", "failed"] as const)("%s execution retains selections and user text but cannot publish", status => fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  completed(db, runId, prompt, proposal("confirmed"));
  const saved = publisher.addDiscovery(claim(runId), prompt);
  db.run("UPDATE runs SET status=?,generation=generation+1 WHERE id=?", [status, runId]);
  const before = snapshot(db);
  expect(() => publisher.addDiscovery(claim(runId), prompt)).toThrow();
  expect(() => publisher.finalizeReply(claim(runId), prompt)).toThrow();
  expect(snapshot(db)).toEqual(before);
  expect(db.query("SELECT why FROM search_discoveries WHERE id=?").get(saved.entryId)).toEqual({ why: "confirmed" });
  expect(db.query("SELECT role,text FROM search_messages WHERE run_id=?").all(runId)).toEqual([{ role: "user", text: "find it" }]);
  expect(db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot: 0 });
}));

test.each(["target", "evidence"] as const)("rejecting the %s fences discovery without publishing a receipt", rejected => fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  completed(db, runId, prompt, proposal("why"));
  db.run("INSERT INTO rejected_thoughts VALUES (?)", [rejected]);
  expect(() => publisher.addDiscovery(claim(runId), prompt)).toThrow();
  expect(db.query("SELECT count(*) AS n FROM search_discoveries").get()).toEqual({ n: 0 });
  expect(db.query("SELECT result_json FROM run_steps WHERE prompt_id=?").get(prompt)).toEqual({ result_json: null });
  expect(db.query("SELECT status,generation FROM runs WHERE id=?").get(runId)).toEqual({ status: "interrupted", generation: 2 });
}));

test("final reply insertion and inherited dependencies roll back when terminal transition fails", () => fixture((db, publisher, _removal, _sessionId, runId, prompt) => {
  db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND ref_id='evidence'", [runId]);
  completed(db, runId, prompt, { version: 1, kind: "search-reply", reply: "final text", disposition: "done", sourceThoughtIds: ["evidence"] });
  db.exec(`CREATE TEMP TRIGGER fail_reply_terminal BEFORE UPDATE OF status ON runs
    WHEN NEW.status='completed' AND EXISTS (SELECT 1 FROM search_messages m JOIN search_content_dependencies d ON d.message_id=m.id
      WHERE m.run_id=NEW.id AND m.role='assistant' AND d.ref_id='uncited')
    BEGIN SELECT RAISE(ABORT,'injected-after-reply-and-dependencies'); END`);
  const before = snapshot(db);
  let failure: unknown;
  try { publisher.finalizeReply(claim(runId), prompt); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SearchStorageError);
  if (!(failure instanceof SearchStorageError) || !(failure.cause instanceof Error)) throw new Error("missing sanitized injected failure");
  expect(failure.message).toBe("search-persistence-failed");
  expect(failure.cause.message).toContain("injected-after-reply-and-dependencies");
  expect(snapshot(db)).toEqual(before);
  expect(db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot: 1 });
  db.exec("DROP TRIGGER temp.fail_reply_terminal");
  publisher.finalizeReply(claim(runId), prompt);
  expect(db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot: 0 });
}));
