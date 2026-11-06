import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import type { SearchSessions } from "../src/domain/agentic-search";
import type { ContextRef } from "../src/domain/run";

interface Active { readonly runId: string; readonly composerId: string; readonly sessionId: string }

function fixture(action: (db: Database, rejection: RejectionService, sessions: SearchSessions) => void): void {
  const db = new Database(":memory:");
  try {
    migrate(db);
    db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES
      ('target','target','user','captured-original','2030','capture'),
      ('other','other','user','captured-original','2030','capture'),
      ('unrelated','unrelated','user','captured-original','2030','capture');
      INSERT INTO thought_titles VALUES ('target','Target','user'),('other','Other','user'),('unrelated','Unrelated','user');
      INSERT INTO thought_source_seals VALUES ('target'),('other'),('unrelated');
      INSERT INTO connections VALUES ('link','target','other','related','user','fixture');
      INSERT INTO responses VALUES ('shared','shared response','addendum','complete');
      INSERT INTO response_thoughts VALUES ('shared','target',0),('shared','other',1);
      INSERT INTO response_seals VALUES ('shared');`);
    let next = 0;
    const sources = { id: () => `owned-${++next}`, now: () => "2030-01-01T12:00:00.000Z" };
    action(db, new RejectionService(new SqliteRejectionRepository(db)), new SqliteStore(db).searchSessions(sources));
  } finally { db.close(); }
}

// Use real admission and the real ledger-aware message offer. The SQL dependency
// represents already-retained trusted provenance, not caller-provided authority.
function active(db: Database, sessions: SearchSessions, key: string, ref: ContextRef, mode: "bound" | "queued" | "uncertain" = "bound"): Active {
  const sessionId = sessions.create("user", `session-${key}`, {}).session.id;
  const draft = sessions.openComposer("user", sessionId);
  const turn = sessions.admitTurn("user", sessionId, `turn-${key}`, { text: `request-${key}`, startingThoughtIds: [],
    requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: draft.composerId, contextToken: draft.contextToken });
  db.run("INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES (?,?,?,0)", [turn.run.id, ref.kind, ref.id]);
  db.run("INSERT INTO search_content_dependencies(session_id,message_id,ref_kind,ref_id) VALUES (?,?,?,?)", [sessionId, turn.receipt.userMessageId, ref.kind, ref.id]);
  const composer = sessions.openComposer("user", sessionId);
  const offered = sessions.offerMessage("user", sessionId, composer.composerId, turn.receipt.userMessageId);
  expect(offered.message.text).toBe(`request-${key}`);
  expect(db.query("SELECT ref_kind,ref_id FROM search_composer_dependencies WHERE composer_id=?").all(composer.composerId)).toEqual([{ ref_kind: ref.kind, ref_id: ref.id }]);
  const row = db.query("SELECT session_id FROM runs WHERE id=?").get(turn.run.id) as { session_id: string };
  if (mode === "bound") {
    db.run("INSERT INTO agent_bindings VALUES (?,?,'https://fixture.invalid','/owned','{}','[]',1)", [turn.run.id, row.session_id]);
    db.run("UPDATE runs SET status='running' WHERE id=?", [turn.run.id]);
  }
  if (mode === "uncertain") {
    db.run("UPDATE run_steps SET input='owned fixture',state='uncertain' WHERE run_id=?", [turn.run.id]);
    db.run("UPDATE runs SET status='uncertain' WHERE id=?", [turn.run.id]);
  }
  return { runId: turn.run.id, composerId: composer.composerId, sessionId };
}

function state(db: Database, item: Active): unknown {
  return {
    run: db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(item.runId),
    turn: db.query("SELECT open_slot,outcome_reason FROM search_turns WHERE run_id=?").get(item.runId),
    composer: db.query("SELECT state FROM search_composer_contexts WHERE id=?").get(item.composerId),
  };
}
function fenced(db: Database, item: Active): void {
  expect(state(db, item)).toEqual({ run: { status: "interrupted", generation: 1, cancellation_state: "pending" },
    turn: { open_slot: 0, outcome_reason: "context-invalidated" }, composer: { state: "invalidated" } });
}
function revisions(db: Database): { eligibility: number; retrieval: number } {
  return db.query("SELECT eligibility,retrieval FROM search_revisions WHERE id=1").get() as { eligibility: number; retrieval: number };
}

test("real user reject and restore change eligibility and retrieval revisions exactly once per effect", () => fixture((db, rejection) => {
  const before = revisions(db);
  expect(() => rejection.rejectThought("ai", "target")).toThrow();
  expect(revisions(db)).toEqual(before);
  rejection.rejectThought("user", "target");
  expect(revisions(db)).toEqual({ eligibility: before.eligibility + 1, retrieval: before.retrieval + 1 });
  rejection.rejectThought("user", "target");
  expect(revisions(db)).toEqual({ eligibility: before.eligibility + 1, retrieval: before.retrieval + 1 });
  rejection.restoreThought("user", "target");
  expect(revisions(db)).toEqual({ eligibility: before.eligibility + 2, retrieval: before.retrieval + 2 });
  rejection.restoreThought("user", "target");
  expect(revisions(db)).toEqual({ eligibility: before.eligibility + 2, retrieval: before.retrieval + 2 });
}));

test("connection reject and restore also advance the dedicated revisions", () => fixture((db, rejection) => {
  const before = revisions(db);
  expect(() => rejection.rejectConnection("ai", "link")).toThrow();
  expect(revisions(db)).toEqual(before);
  rejection.rejectConnection("user", "link");
  expect(revisions(db)).toEqual({ eligibility: before.eligibility + 1, retrieval: before.retrieval + 1 });
  rejection.restoreConnection("user", "link");
  expect(revisions(db)).toEqual({ eligibility: before.eligibility + 2, retrieval: before.retrieval + 2 });
}));

test.each([
  { name: "uncited thought exposure", ref: { kind: "thought", id: "target" } as const, action: "thought" as const, target: "target" },
  { name: "direct connection rejection", ref: { kind: "connection", id: "link" } as const, action: "connection" as const, target: "link" },
  { name: "connection endpoint rejection", ref: { kind: "connection", id: "link" } as const, action: "thought" as const, target: "other" },
  { name: "other member of a shared response", ref: { kind: "response", id: "shared" } as const, action: "thought" as const, target: "other" },
])("$name fences only affected run and inherited composer at rejection commit", scenario => fixture((db, rejection, sessions) => {
  const affected = active(db, sessions, "affected", scenario.ref);
  const unaffected = active(db, sessions, "unaffected", { kind: "thought", id: "unrelated" });
  const unaffectedBefore = state(db, unaffected), before = revisions(db);
  const library = ["thoughts", "thought_titles", "connections", "responses", "response_thoughts"].map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  if (scenario.action === "thought") rejection.rejectThought("user", scenario.target);
  else rejection.rejectConnection("user", scenario.target);
  fenced(db, affected);
  expect(state(db, unaffected)).toEqual(unaffectedBefore);
  expect(revisions(db)).toEqual({ eligibility: before.eligibility + 1, retrieval: before.retrieval + 1 });
  expect(["thoughts", "thought_titles", "connections", "responses", "response_thoughts"].map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all())).toEqual(library);
}));

test("reject then restore before any search poll never revives affected work", () => fixture((db, rejection, sessions) => {
  const affected = active(db, sessions, "affected", { kind: "response", id: "shared" });
  const unaffected = active(db, sessions, "unaffected", { kind: "thought", id: "unrelated" });
  const before = state(db, unaffected), revision = revisions(db);
  rejection.rejectThought("user", "other");
  rejection.restoreThought("user", "other");
  fenced(db, affected);
  expect(state(db, unaffected)).toEqual(before);
  expect(revisions(db)).toEqual({ eligibility: revision.eligibility + 2, retrieval: revision.retrieval + 2 });
  expect(db.query("SELECT * FROM rejected_thoughts").all()).toEqual([]);
}));

test("rejection and search fencing roll back together when fencing fails", () => fixture((db, rejection, sessions) => {
  const affected = active(db, sessions, "affected", { kind: "thought", id: "target" });
  const before = state(db, affected), revision = revisions(db);
  db.exec(`CREATE TEMP TRIGGER fail_rejection_fence AFTER UPDATE OF status ON runs
    WHEN NEW.id='${affected.runId}' AND NEW.status='interrupted' AND NEW.generation=OLD.generation+1
      AND EXISTS (SELECT 1 FROM rejected_thoughts WHERE thought_id='target')
    BEGIN SELECT RAISE(ABORT,'injected-after-rejection-and-run-fence'); END`);
  expect(() => rejection.rejectThought("user", "target")).toThrow(/injected-after-rejection-and-run-fence/);
  expect(db.query("SELECT * FROM rejected_thoughts").all()).toEqual([]);
  expect(state(db, affected)).toEqual(before);
  expect(revisions(db)).toEqual(revision);
  db.exec("DROP TRIGGER temp.fail_rejection_fence");
  rejection.rejectThought("user", "target");
  fenced(db, affected);
}));

test("branch rejection fences overlapping dependencies once and leaves terminal and non-search runs untouched", () => fixture((db, rejection, sessions) => {
  db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id) VALUES ('child','child','user','user-contribution','2030','capture','target');
    INSERT INTO thought_titles VALUES ('child','Child','user'); INSERT INTO thought_source_seals VALUES ('child');`);
  const affected = active(db, sessions, "branch", { kind: "thought", id: "target" });
  db.run("INSERT INTO run_context VALUES (?,'thought','child',0)", [affected.runId]);
  const terminal = active(db, sessions, "terminal", { kind: "thought", id: "child" });
  db.run("UPDATE runs SET status='completed' WHERE id=?", [terminal.runId]);
  db.exec(`INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES ('weave','weave','running','weave-native','weave-prompt','2030',3);
    INSERT INTO run_context VALUES ('weave','thought','target',0);`);
  const terminalRun = db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(terminal.runId);
  const weave = db.query("SELECT status,generation,cancellation_state FROM runs WHERE id='weave'").get();
  const before = revisions(db);
  rejection.rejectBranch("user", rejection.previewBranch("user", "target"));
  fenced(db, affected);
  expect(db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(terminal.runId)).toEqual(terminalRun);
  expect(db.query("SELECT status,generation,cancellation_state FROM runs WHERE id='weave'").get()).toEqual(weave);
  expect(revisions(db)).toEqual({ eligibility: before.eligibility + 2, retrieval: before.retrieval + 2 });
  expect(db.query("SELECT thought_id FROM rejected_thoughts ORDER BY thought_id").all()).toEqual([{ thought_id: "child" }, { thought_id: "target" }]);
}));

test("unbound untouched queue needs no remote cancellation; uncertain dispatch stays pending", () => fixture((db, rejection, sessions) => {
  const queued = active(db, sessions, "queue", { kind: "thought", id: "target" }, "queued");
  const uncertain = active(db, sessions, "uncertain", { kind: "thought", id: "target" }, "uncertain");
  rejection.rejectThought("user", "target");
  expect(state(db, queued)).toEqual({ run: { status: "interrupted", generation: 1, cancellation_state: "none" }, turn: { open_slot: 0, outcome_reason: "context-invalidated" }, composer: { state: "invalidated" } });
  fenced(db, uncertain);
}));

test("rejection commands use identity projection rather than the full knowledge snapshot", () => fixture((db) => {
  let fullSnapshotReads = 0;
  const observed = new Proxy(db, { get(target, property) {
    if (property === "query") return (sql: string) => {
      if (sql.includes("t.text, m.title") || sql.includes("SELECT id, text, role, state FROM responses")) fullSnapshotReads++;
      return target.query(sql);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const rejection = new RejectionService(new SqliteRejectionRepository(observed));
  rejection.rejectThought("user", "target");
  rejection.restoreThought("user", "target");
  rejection.rejectConnection("user", "link");
  rejection.restoreConnection("user", "link");
  const preview = rejection.previewBranch("user", "target");
  rejection.rejectBranch("user", preview);
  rejection.restoreBranch("user", "target");
  expect(fullSnapshotReads).toBe(0);
}));
