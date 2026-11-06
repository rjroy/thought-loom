import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SearchStorageError, type SearchComposerView, type SearchSessions } from "../src/domain/agentic-search";

function fixture(action: (db: Database, sessions: SearchSessions, rejection: RejectionService, sessionId: string, messageIds: readonly string[]) => void): void {
  const db = new Database(":memory:");
  try {
    migrate(db);
    db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id) VALUES
      ('T','sensitive source','user','captured-original','2030','capture',NULL),
      ('U','other source','user','captured-original','2030','capture',NULL),
      ('child','visible child','user','user-contribution','2030','capture','T');
      INSERT INTO thought_titles VALUES ('T','Sensitive','user'),('U','Other','user'),('child','Child','user');
      INSERT INTO thought_sources VALUES ('child',0,'U');
      INSERT INTO thought_source_seals VALUES ('T'),('U'),('child');`);
    let next = 0;
    const sessions = new SqliteStore(db).searchSessions({ id: () => `fixture-${++next}`, now: () => "2030-01-01T12:00:00.000Z" });
    const sessionId = sessions.create("user", "session-key", {}).session.id;
    const messages: string[] = [];
    for (const [key, source] of [["one", "T"], ["two", "U"]]) {
      const composer = sessions.openComposer("user", sessionId);
      const turn = sessions.admitTurn("user", sessionId, key, { text: `private-${key}`, startingThoughtIds: [source],
        requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
      messages.push(turn.receipt.userMessageId);
      db.run("UPDATE runs SET status='completed' WHERE id=?", [turn.run.id]);
    }
    action(db, sessions, new RejectionService(new SqliteRejectionRepository(db)), sessionId, messages);
  } finally { db.close(); }
}
function refs(db: Database, composerId: string): unknown {
  return db.query("SELECT ref_kind,ref_id FROM search_composer_dependencies WHERE composer_id=? ORDER BY ref_kind,ref_id").all(composerId);
}
function send(sessions: SearchSessions, sessionId: string, composer: SearchComposerView, key: string): void {
  sessions.admitTurn("user", sessionId, key, { text: "new intent", startingThoughtIds: [], contextMode: "restart",
    requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
}

test("paged message offers monotonically inherit earlier pages and stale responses cannot admit", () => fixture((db, sessions, _rejection, sessionId, ids) => {
  const draft = sessions.openComposer("user", sessionId);
  const first = sessions.messages("user", sessionId, { composerId: draft.composerId, limit: 1 });
  expect(first.composerId).toBe(draft.composerId);
  expect(first.items.map(item => item.id)).toEqual([ids[0]]);
  expect(first.nextCursor).not.toBeNull();
  expect(refs(db, draft.composerId)).toEqual([{ ref_kind: "thought", ref_id: "T" }]);
  const second = sessions.messages("user", sessionId, { composerId: draft.composerId, limit: 1, cursor: first.nextCursor });
  expect(second.items.map(item => item.id)).toEqual([ids[1]]);
  expect(second.composerId).toBe(draft.composerId);
  expect(refs(db, draft.composerId)).toEqual([{ ref_kind: "thought", ref_id: "T" }, { ref_kind: "thought", ref_id: "U" }]);
  expect(() => send(sessions, sessionId, first, "stale")).toThrow(/context-changed/);
  const refreshed = sessions.refreshComposer("user", sessionId, draft.composerId);
  expect(refs(db, draft.composerId)).toEqual([{ ref_kind: "thought", ref_id: "T" }, { ref_kind: "thought", ref_id: "U" }]);
  expect(refreshed.contextToken).toBe(second.contextToken);
  send(sessions, sessionId, refreshed, "current");
  expect(db.query("SELECT ref_id FROM search_content_dependencies WHERE message_id=(SELECT id FROM search_messages WHERE run_id=(SELECT run_id FROM search_turns WHERE request_key='current') AND role='user') ORDER BY ref_id").all()).toEqual([{ ref_id: "T" }, { ref_id: "U" }]);
}));

test("normal collection cursors bind collection, session and limit and retain their high-water", () => fixture((_db, sessions, _rejection, sessionId, ids) => {
  const viewer = sessions.openComposer("user", sessionId);
  const first = sessions.messages("user", sessionId, { composerId: viewer.composerId, limit: 1 });
  expect(first.nextCursor).not.toBeNull();
  if (!first.nextCursor) throw new Error("missing workspace continuation");
  const [payload, signature, extra] = first.nextCursor.split(".");
  if (!payload || !signature || extra !== undefined) throw new Error("invalid signed continuation");
  const fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  for (const change of [{ scope: "history" }, { after: 99 }, { highWater: 0 }, { sessionId: "foreign" }]) {
    const forged = `${Buffer.from(JSON.stringify({ ...fields, ...change })).toString("base64url")}.${signature}`;
    expect(() => sessions.messages("user", sessionId, { composerId: viewer.composerId, limit: 1, cursor: forged })).toThrow();
  }
  expect(() => sessions.messages("user", sessionId, { composerId: viewer.composerId, limit: 2, cursor: first.nextCursor })).toThrow();
  expect(() => sessions.discoveries("user", sessionId, { composerId: viewer.composerId, limit: 1, cursor: first.nextCursor })).toThrow();
  expect(() => sessions.messages("user", sessionId, { composerId: viewer.composerId, limit: 201 })).toThrow();
  const writer = sessions.openComposer("user", sessionId);
  send(sessions, sessionId, writer, "later");
  const continuation = sessions.messages("user", sessionId, { composerId: viewer.composerId, limit: 1, cursor: first.nextCursor });
  expect(continuation.items.map(item => item.id)).toEqual([ids[1]]);
  expect(continuation.nextCursor).toBeNull();
  expect(sessions.messages("user", sessionId, { composerId: viewer.composerId, limit: 10 }).items).toHaveLength(3);
}));

test("C2 recovery requires a fresh registered read and reject-restore cannot wash its ledger", () => fixture((db, sessions, rejection, sessionId, ids) => {
  const c2 = sessions.openComposer("user", sessionId);
  const control = sessions.turnByKey("user", sessionId, "one");
  expect(control).not.toBeNull();
  if (!control) throw new Error("missing admitted control receipt");
  expect(JSON.stringify(control)).not.toContain("private-one");
  const stored = db.query("SELECT intent_json,effort FROM search_turns WHERE session_id=? AND request_key='one'").get(sessionId) as { intent_json: string; effort: string };
  const original = JSON.parse(stored.intent_json) as { startingThoughtIds: string[]; requestClock: { at: string; timeZone: string }; contextMode: string; composerId: string; contextToken: string };
  const replay = sessions.admitTurn("user", sessionId, "one", { text: "private-one", startingThoughtIds: original.startingThoughtIds,
    requestClock: original.requestClock, contextMode: original.contextMode, effort: stored.effort, composerId: original.composerId, contextToken: original.contextToken });
  expect(replay).toEqual(control);
  expect(JSON.stringify(replay)).not.toContain("private-one");
  expect(refs(db, c2.composerId)).toEqual([]);
  const offered = sessions.messages("user", sessionId, { composerId: c2.composerId, limit: 1 });
  expect(offered.items[0]).toEqual(expect.objectContaining({ id: ids[0], text: "private-one" }));
  expect(refs(db, c2.composerId)).toEqual([{ ref_kind: "thought", ref_id: "T" }]);
  rejection.rejectThought("user", "T");
  rejection.restoreThought("user", "T");
  expect(db.query("SELECT state FROM search_composer_contexts WHERE id=?").get(c2.composerId)).toEqual({ state: "invalidated" });
  expect(() => sessions.refreshComposer("user", sessionId, c2.composerId)).toThrow(/context-changed/);
  expect(() => send(sessions, sessionId, offered, "paraphrase")).toThrow(/context-changed/);
  expect(sessions.history("user", sessionId).messages.items[0]?.text).toBe("private-one");
  expect(() => sessions.history("ai", sessionId)).toThrow();
}));

test("separate composers cannot reuse tokens, cursors or rejected history as normal content", () => fixture((db, sessions, rejection, sessionId, ids) => {
  const c1 = sessions.openComposer("user", sessionId), c2 = sessions.openComposer("user", sessionId);
  const c1page = sessions.messages("user", sessionId, { composerId: c1.composerId, limit: 1 });
  expect(refs(db, c2.composerId)).toEqual([]);
  expect(() => send(sessions, sessionId, { ...c2, contextToken: c1page.contextToken }, "foreign-token")).toThrow(/context-changed/);
  expect(() => sessions.messages("ai", sessionId, { composerId: c2.composerId })).toThrow();
  const other = sessions.create("user", "other-session", {}).session;
  expect(() => sessions.messages("user", other.id, { composerId: c1.composerId, cursor: c1page.nextCursor, limit: 1 })).toThrow();
  rejection.rejectThought("user", "T");
  const safe = sessions.messages("user", sessionId, { composerId: c2.composerId, limit: 1 });
  expect(safe.items[0]).toEqual(expect.objectContaining({ id: ids[0], text: null, availability: "context-unavailable", evidenceThoughtIds: [] }));
  expect(JSON.stringify(safe)).not.toContain("private-one");
  expect(refs(db, c2.composerId)).toEqual([]);
  expect(sessions.history("user", sessionId).messages.items[0]?.text).toBe("private-one");
  expect(Object.hasOwn(sessions.history("user", sessionId), "contextToken")).toBe(false);
}));

test("preview redacts rejected ancestry, registers visible provenance and is not a full read witness", () => fixture((db, sessions, rejection, sessionId) => {
  rejection.rejectThought("user", "T");
  const draft = sessions.openComposer("user", sessionId);
  const preview = sessions.previewThought("user", sessionId, draft.composerId, "child");
  expect(preview.composerId).toBe(draft.composerId);
  expect(preview.thought).toEqual(expect.objectContaining({ id: "child", parentId: null, sourceIds: ["U"] }));
  expect(refs(db, draft.composerId)).toEqual([{ ref_kind: "thought", ref_id: "U" }, { ref_kind: "thought", ref_id: "child" }]);
  expect(() => sessions.previewThought("user", sessionId, draft.composerId, "T")).toThrow();
  expect(db.query("SELECT count(*) AS n FROM run_context WHERE full_read=1").get()).toEqual({ n: 0 });
  expect(() => sessions.previewThought("ai", sessionId, draft.composerId, "child")).toThrow();
}));

test("normal discovery pages exclude removed occurrences and hide unsafe rationale without hiding a safe target", () => fixture((db, sessions, rejection, sessionId) => {
  const author = sessions.openComposer("user", sessionId);
  const turn = sessions.admitTurn("user", sessionId, "third", { text: "find U", startingThoughtIds: [],
    requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: author.composerId, contextToken: author.contextToken });
  const runId = turn.run.id;
  const initial = (db.query("SELECT prompt_id FROM runs WHERE id=?").get(runId) as { prompt_id: string }).prompt_id;
  const occurrence = (prompt: string, id: string, position: number) => {
    const why = `private-rationale-${id}`;
    const envelope = JSON.stringify({ version: 1, kind: "request", request: { capability: "addDiscovery", arguments: { thoughtId: "U", why, evidenceThoughtIds: [] } } });
    const receipt = JSON.stringify({ type: "discovery-add", entryId: id, outcome: "added" });
    db.run("UPDATE run_steps SET input='fixture',state='completed',native_state='completed',envelope_json=?,result_json=? WHERE run_id=? AND prompt_id=?", [envelope, receipt, runId, prompt]);
    db.run("INSERT INTO search_discoveries(id,session_id,thought_id,position,why,evidence_json,added_run_id,added_prompt_id,added_at) VALUES (?,?,'U',?,?,'[]',?,?,'2030')", [id, sessionId, position, why, runId, prompt]);
    db.run("INSERT INTO search_content_dependencies(session_id,discovery_id,ref_kind,ref_id) VALUES (?,?,'thought','T')", [sessionId, id]);
  };
  occurrence(initial, "E1", 0);
  sessions.removeDiscovery("user", sessionId, "E1");
  db.run("UPDATE run_steps SET state='processed' WHERE run_id=? AND prompt_id=?", [runId, initial]);
  db.run("INSERT INTO run_steps(run_id,position,prompt_id,state,native_state) VALUES (?,1,'fresh-prompt','prepared','unknown')", [runId]);
  occurrence("fresh-prompt", "E2", 1);
  rejection.rejectThought("user", "T");
  const viewer = sessions.openComposer("user", sessionId);
  const page = sessions.discoveries("user", sessionId, { composerId: viewer.composerId, limit: 1 });
  expect(page.composerId).toBe(viewer.composerId);
  expect(page.items).toEqual([expect.objectContaining({ id: "E2", thought: expect.objectContaining({ id: "U" }), why: null, reasonStatus: "context-unavailable", evidenceThoughtIds: [] })]);
  expect(JSON.stringify(page)).not.toContain("private-rationale");
  expect(refs(db, viewer.composerId)).toEqual([{ ref_kind: "thought", ref_id: "U" }]);
  expect(() => sessions.discoveries("ai", sessionId, { composerId: viewer.composerId })).toThrow();
  expect(() => sessions.discoveries("user", sessionId, { composerId: viewer.composerId, limit: 0 })).toThrow();
  rejection.restoreThought("user", "T");
  const restored = sessions.discoveries("user", sessionId, { composerId: viewer.composerId, limit: 1 });
  expect(restored.items).toEqual([expect.objectContaining({ id: "E2", why: "private-rationale-E2", reasonStatus: "available" })]);
  expect(refs(db, viewer.composerId)).toEqual([{ ref_kind: "thought", ref_id: "T" }, { ref_kind: "thought", ref_id: "U" }]);
  rejection.rejectThought("user", "U");
  const fresh = sessions.openComposer("user", sessionId);
  const hidden = sessions.discoveries("user", sessionId, { composerId: fresh.composerId });
  expect(hidden.items).toEqual([expect.objectContaining({ id: "E2", thought: null, why: null, availability: "thought-unavailable", evidenceThoughtIds: [] })]);
  expect(JSON.stringify(hidden)).not.toContain("Other");
  expect(JSON.stringify(hidden)).not.toContain("private-rationale");
  expect(refs(db, fresh.composerId)).toEqual([]);
}));

test("preview excludes both rejected parent and source from DTO and ledger", () => fixture((db, sessions, rejection, sessionId) => {
  rejection.rejectThought("user", "T");
  rejection.rejectThought("user", "U");
  const draft = sessions.openComposer("user", sessionId);
  const preview = sessions.previewThought("user", sessionId, draft.composerId, "child");
  expect(preview.thought).toEqual(expect.objectContaining({ id: "child", parentId: null, sourceIds: [] }));
  expect(JSON.stringify(preview)).not.toContain("sensitive source");
  expect(JSON.stringify(preview)).not.toContain("other source");
  expect(refs(db, draft.composerId)).toEqual([{ ref_kind: "thought", ref_id: "child" }]);
}));

test.each(["connection", "shared-response"] as const)("offered %s provenance is registered and its rejection invalidates the composer", mode => fixture((db, sessions, rejection, sessionId, ids) => {
  const messageId = ids[0];
  if (!messageId) throw new Error("missing fixture message");
  db.exec(`INSERT INTO connections VALUES ('link','T','U','related','user','fixture');
    INSERT INTO responses VALUES ('shared','shared text','addendum','complete');
    INSERT INTO response_thoughts VALUES ('shared','T',0),('shared','U',1);
    INSERT INTO response_seals VALUES ('shared');`);
  db.run("INSERT INTO search_content_dependencies(session_id,message_id,ref_kind,ref_id) VALUES (?,?,'connection','link'),(?,?,'response','shared')", [sessionId, messageId, sessionId, messageId]);
  const draft = sessions.openComposer("user", sessionId);
  const page = sessions.messages("user", sessionId, { composerId: draft.composerId, limit: 1 });
  expect(page.items[0]?.text).toBe("private-one");
  expect(refs(db, draft.composerId)).toEqual([{ ref_kind: "connection", ref_id: "link" }, { ref_kind: "response", ref_id: "shared" }, { ref_kind: "thought", ref_id: "T" }]);
  if (mode === "connection") rejection.rejectConnection("user", "link");
  else rejection.rejectThought("user", "U");
  expect(db.query("SELECT state FROM search_composer_contexts WHERE id=?").get(draft.composerId)).toEqual({ state: "invalidated" });
  expect(() => sessions.refreshComposer("user", sessionId, draft.composerId)).toThrow(/context-changed/);
}));

test("failed ledger write after page projection returns no content and rolls back revision and coverage", () => fixture((db, sessions, _rejection, sessionId) => {
  const draft = sessions.openComposer("user", sessionId);
  const before = db.query("SELECT revision,state FROM search_composer_contexts WHERE id=?").get(draft.composerId);
  db.exec(`CREATE TEMP TRIGGER fail_workspace_ledger AFTER INSERT ON search_composer_dependencies
    WHEN NEW.ref_kind='thought' AND NEW.ref_id='T' AND EXISTS (SELECT 1 FROM search_messages WHERE text='private-one')
    BEGIN SELECT RAISE(ABORT,'injected-after-workspace-projection'); END`);
  let returned: unknown, failure: unknown;
  try { returned = sessions.messages("user", sessionId, { composerId: draft.composerId, limit: 1 }); } catch (error) { failure = error; }
  expect(returned).toBeUndefined();
  expect(failure).toBeInstanceOf(SearchStorageError);
  if (!(failure instanceof SearchStorageError) || !(failure.cause instanceof Error)) throw new Error("missing sanitized ledger fault");
  expect(failure.message).toBe("search-persistence-failed");
  expect(failure.cause.message).toContain("injected-after-workspace-projection");
  expect(refs(db, draft.composerId)).toEqual([]);
  expect(db.query("SELECT revision,state FROM search_composer_contexts WHERE id=?").get(draft.composerId)).toEqual(before);
  db.exec("DROP TRIGGER temp.fail_workspace_ledger");
  expect(sessions.messages("user", sessionId, { composerId: draft.composerId, limit: 1 }).items[0]?.text).toBe("private-one");
}));

test("imported thought preview exposes neither original source bytes nor source metadata", () => fixture((db, sessions, _rejection, sessionId) => {
  const original = Buffer.from("thought text\nSOURCE-SECRET"), thought = "thought text";
  const namespace = (db.query("SELECT id FROM import_namespaces WHERE kind='loose-markdown'").get() as { id: string }).id;
  db.transaction(() => {
    db.run(`INSERT INTO import_documents(id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,created_at,parser_version,segmentation_method,segmentation_reason)
      VALUES ('doc',?,zeroblob(32),?,'utf-8',?,'private-fixture.md','2030','fixture','structural','fixture')`, [original, original.length, namespace]);
    db.run("INSERT INTO import_locations VALUES (?,'private-fixture.md','doc')", [namespace]);
    db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,import_document_id) VALUES ('imported',?,'source','imported-original','2030','markdown-import','doc')", [thought]);
    db.run("INSERT INTO thought_titles VALUES ('imported',NULL,NULL)");
    db.run("INSERT INTO thought_source_seals VALUES ('imported')");
    db.run("INSERT INTO import_document_parts VALUES ('doc',0,'thought',0,?,'imported',0)", [thought.length]);
    db.run("INSERT INTO import_document_parts VALUES ('doc',1,'separator',?,?,NULL,NULL)", [thought.length, original.length]);
    db.run("INSERT INTO import_document_seals VALUES ('doc')");
  }).immediate();
  const draft = sessions.openComposer("user", sessionId);
  const preview = sessions.previewThought("user", sessionId, draft.composerId, "imported");
  expect(preview.thought).toEqual(expect.objectContaining({ id: "imported", text: thought }));
  expect(JSON.stringify(preview)).not.toContain("SOURCE-SECRET");
  expect(JSON.stringify(preview)).not.toContain("private-fixture.md");
  expect(refs(db, draft.composerId)).toEqual([{ ref_kind: "thought", ref_id: "imported" }]);
}));
