import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SearchConflictError, type SearchSessions } from "../src/domain/agentic-search";

function fixture(action: (db: Database, sessions: SearchSessions, clock: { now: string }) => void): void {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const clock = { now: "2030-01-01T00:00:00.000Z" };
    let next = 0;
    const sources = { id: () => `session-${++next}`, now: () => clock.now };
    action(db, new SqliteStore(db).searchSessions(sources), clock);
  } finally { db.close(); }
}

test("sessions create once, list independently, rename with revision and replay without activity", () => fixture((db, sessions, clock) => {
  const first = sessions.create("user", "create-a", {});
  expect(first.replayed).toBe(false);
  expect(first.session).toEqual(expect.objectContaining({ id: "session-1", createdAt: clock.now, lastActivityAt: clock.now, revision: 0 }));
  expect(first.session.title.length).toBeGreaterThan(0);
  clock.now = "2030-01-02T00:00:00.000Z";
  const second = sessions.create("user", "create-b", {});
  expect(second.session.id).toBe("session-2");
  expect(sessions.list("user").items.map(session => session.id)).toEqual(["session-2", "session-1"]);
  clock.now = "2030-01-03T00:00:00.000Z";
  const renamed = sessions.rename("user", first.session.id, first.session.revision, { title: "My search" });
  expect(renamed).toEqual(expect.objectContaining({ title: "My search", revision: 1, createdAt: first.session.createdAt, lastActivityAt: clock.now }));
  expect(() => sessions.rename("user", first.session.id, 0, { title: "stale" })).toThrow();
  const before = db.query("SELECT * FROM search_sessions ORDER BY sequence").all();
  const revisions = db.query("SELECT * FROM search_revisions").all();
  clock.now = "2030-01-04T00:00:00.000Z";
  expect(sessions.create("user", "create-a", {})).toEqual({ session: renamed, replayed: true });
  expect(sessions.get("user", first.session.id)).toEqual(renamed);
  expect(sessions.list("user").items.map(session => session.id)).toEqual(["session-1", "session-2"]);
  expect(db.query("SELECT * FROM search_sessions ORDER BY sequence").all()).toEqual(before);
  expect(db.query("SELECT * FROM search_revisions").all()).toEqual(revisions);
}));

test("session commands validate actor, create key and exact payload without trusting client metadata", () => fixture((db, sessions) => {
  for (const key of ["", "a b", "x".repeat(129)]) expect(() => sessions.create("user", key, {})).toThrow();
  for (const payload of [null, [], { title: "caller title" }, { createdAt: "2099-01-01T00:00:00Z" }, { id: "caller-id" }]) {
    expect(() => sessions.create("user", "valid-key", payload)).toThrow();
  }
  expect(() => sessions.create("ai", "valid-key", {})).toThrow();
  expect(db.query("SELECT count(*) AS n FROM search_sessions").get()).toEqual({ n: 0 });
  const created = sessions.create("user", "valid-key", {}).session;
  for (const payload of [{ title: "" }, { title: "valid", createdAt: "2099" }, { revision: 20 }]) {
    expect(() => sessions.rename("user", created.id, 0, payload)).toThrow();
  }
  expect(() => sessions.get("ai", created.id)).toThrow();
  expect(() => sessions.list("ai")).toThrow();
  expect(() => sessions.delete("ai", created.id)).toThrow();
  expect(sessions.get("user", created.id)).toEqual(created);
}));

test("session deletion purges owned content, preserves knowledge and cannot resurrect a create receipt", () => fixture((db, sessions, clock) => {
  const created = sessions.create("user", "delete-key", {}).session;
  db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('thought','retained knowledge','user','captured-original','2030','capture');
    INSERT INTO thought_titles VALUES ('thought','Library title','user');
    INSERT INTO thought_source_seals VALUES ('thought');
    INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES ('run','search','queued','native','prompt','2030',0);`);
  const intent = { version: 1, startingThoughtIds: [], requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" }, daemonObservedAt: "2030-01-01T00:00:00.000Z", contextMode: "continue", composerId: "composer", contextToken: "token", verifiedContext: { sessionId: created.id, composerId: "composer", composerRevision: 0, eligibilityRevision: 0 } };
  db.run("INSERT INTO search_turns(run_id,session_id,position,request_key,admitted_at,effort,context_mode,intent_json) VALUES ('run',?,0,'turn-key','2030','standard','continue',?)", [created.id, JSON.stringify(intent)]);
  db.run("INSERT INTO search_messages(id,session_id,run_id,position,role,text,created_at,evidence_json) VALUES ('message',?,'run',0,'user','private sentinel','2030','[]')", [created.id]);
  db.run("INSERT INTO search_content_dependencies(session_id,message_id,ref_kind,ref_id) VALUES (?,'message','thought','thought')", [created.id]);
  db.run("INSERT INTO run_context VALUES ('run','thought','thought',1)");
  db.run("INSERT INTO search_composer_contexts(id,session_id,state,created_at) VALUES ('composer',?,'active','2030')", [created.id]);
  db.run("INSERT INTO search_composer_dependencies VALUES ('composer','thought','thought')");
  db.run("UPDATE runs SET status='completed' WHERE id='run'");
  const knowledge = [db.query("SELECT rowid,* FROM thoughts").all(), db.query("SELECT rowid,* FROM thought_titles").all(), db.query("SELECT rowid,* FROM thought_source_seals").all()];
  clock.now = "2030-01-02T00:00:00.000Z";
  sessions.delete("user", created.id);
  expect(sessions.get("user", created.id)).toBeNull();
  expect(sessions.list("user")).toEqual({ items: [], nextCursor: null });
  expect(() => sessions.history("user", created.id)).toThrow();
  expect(() => sessions.create("user", "delete-key", {})).toThrow(/session-deleted/i);
  expect(() => sessions.rename("user", created.id, 0, { title: "resurrect" })).toThrow();
  sessions.delete("user", created.id);
  for (const table of ["search_turns", "search_messages", "search_content_dependencies", "search_composer_contexts", "search_composer_dependencies", "runs", "run_steps", "run_context"]) {
    expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(db.query("SELECT id,title,deleted_at FROM search_sessions WHERE id=?").get(created.id)).toEqual({ id: created.id, title: null, deleted_at: clock.now });
  expect([db.query("SELECT rowid,* FROM thoughts").all(), db.query("SELECT rowid,* FROM thought_titles").all(), db.query("SELECT rowid,* FROM thought_source_seals").all()]).toEqual(knowledge);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(sessions.create("user", "new-key", {}).session.id).not.toBe(created.id);
}));

test("catalog uses bounded revision-bound keysets and exact replays do not invalidate a walk", () => fixture((db, sessions) => {
  for (let i = 0; i < 51; i++) sessions.create("user", `key-${i}`, {});
  const before = db.query("SELECT * FROM search_revisions").all();
  const first = sessions.list("user");
  expect(first.items).toHaveLength(50);
  expect(first.items[0]?.id).toBe("session-51");
  expect(first.nextCursor).not.toBeNull();
  if (!first.nextCursor) throw new Error("missing catalog cursor");
  expect(first.nextCursor).toEqual(expect.objectContaining({ kind: "search-sessions", scope: "user", order: "last-activity-desc", limit: 50 }));
  expect(sessions.create("user", "key-0", {}).replayed).toBe(true);
  expect(sessions.list("user", { cursor: first.nextCursor }).items.map(item => item.id)).toEqual(["session-1"]);
  expect(db.query("SELECT * FROM search_revisions").all()).toEqual(before);
  expect(sessions.list("user", { limit: 200 }).items).toHaveLength(51);
  for (const request of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: "1" }, { unknown: 1 },
    { cursor: { ...first.nextCursor, kind: "messages" } }, { cursor: { ...first.nextCursor, scope: "history" } },
    { cursor: { ...first.nextCursor, order: "other" } }, { cursor: first.nextCursor, limit: 1 },
    { cursor: { ...first.nextCursor, sequence: first.nextCursor.highWater + 1 } },
    { cursor: { ...first.nextCursor, extra: true } }]) expect(() => sessions.list("user", request)).toThrow();
}));

test.each(["rename", "create", "delete"] as const)("catalog continuation reports list-changed after %s", change => fixture((_db, sessions, clock) => {
  const first = sessions.create("user", "one", {}).session;
  sessions.create("user", "two", {});
  const page = sessions.list("user", { limit: 1 });
  expect(page.nextCursor).not.toBeNull();
  if (!page.nextCursor) throw new Error("missing catalog cursor");
  clock.now = "2030-01-02T00:00:00.000Z";
  if (change === "rename") sessions.rename("user", first.id, first.revision, { title: "renamed" });
  if (change === "create") sessions.create("user", "three", {});
  if (change === "delete") sessions.delete("user", first.id);
  expect(() => sessions.list("user", { cursor: page.nextCursor })).toThrow(/list-changed/);
}));

test.each(["bound", "possibly-submitted"] as const)("delete refuses %s execution before any local write", scenario => fixture((db, sessions, clock) => {
  const session = sessions.create("user", `key-${scenario}`, {}).session;
  db.run("INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES ('run','search','queued','native','prompt','2030',0)");
  db.run("INSERT INTO search_turns(run_id,session_id,position,request_key,admitted_at,effort,context_mode,intent_json) VALUES ('run',?,0,'turn-key','2030','standard','continue',?)", [session.id, JSON.stringify({ version: 1, startingThoughtIds: [], requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" }, daemonObservedAt: clock.now, contextMode: "continue", composerId: "composer", contextToken: "token", verifiedContext: { sessionId: session.id, composerId: "composer", composerRevision: 0, eligibilityRevision: 0 } })]);
  if (scenario === "bound") db.run("INSERT INTO agent_bindings VALUES ('run','native','https://fixture.invalid','/owned','{}','[]',1)");
  else db.run("UPDATE run_steps SET input='prepared input',state='submitting' WHERE run_id='run'");
  const tables = ["search_sessions", "search_revisions", "search_turns", "runs", "run_steps", "agent_bindings", "search_native_cleanup"];
  const snapshot = () => tables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  clock.now = "2030-01-02T00:00:00.000Z";
  expect(() => sessions.delete("user", session.id)).toThrow(SearchConflictError);
  expect(() => sessions.delete("user", session.id)).toThrow(/native-cleanup-required/);
  expect(snapshot()).toEqual(before);
  expect(sessions.get("user", session.id)).toEqual(session);
}));

test("human history independently bounds messages and discovery occurrences and rejects foreign cursors", () => fixture((db, sessions) => {
  const session = sessions.create("user", "history-key", {}).session;
  const other = sessions.create("user", "other-key", {}).session;
  db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES
      ('a','first thought','user','captured-original','2030','capture'),('b','second thought','user','captured-original','2030','capture');
    INSERT INTO thought_titles VALUES ('a','A','user'),('b','B','user');
    INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES ('run','search','queued','native','prompt-1','2030',0);`);
  db.run("INSERT INTO search_turns(run_id,session_id,position,request_key,admitted_at,effort,context_mode,intent_json) VALUES ('run',?,0,'turn','2030','standard','continue',?)", [session.id, JSON.stringify({ version: 1, startingThoughtIds: [], requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" }, daemonObservedAt: "2030-01-01T00:00:00.000Z", contextMode: "continue", composerId: "composer", contextToken: "token", verifiedContext: { sessionId: session.id, composerId: "composer", composerRevision: 0, eligibilityRevision: 0 } })]);
  db.run("INSERT INTO search_messages(id,session_id,run_id,position,role,text,created_at,evidence_json) VALUES ('m1',?,'run',0,'user','question','2030','[]')", [session.id]);
  db.run("INSERT INTO search_messages(id,session_id,run_id,position,role,text,created_at,disposition,evidence_json) VALUES ('m2',?,'run',1,'assistant','answer','2030','done','[]')", [session.id]);
  const occurrence = (prompt: string, entry: string, thought: string, position: number) => {
    const envelope = JSON.stringify({ kind: "request", request: { capability: "addDiscovery", arguments: { thoughtId: thought, why: `why-${entry}`, evidenceThoughtIds: [] } } });
    const result = JSON.stringify({ type: "discovery-add", outcome: "added", entryId: entry });
    db.run("UPDATE run_steps SET state='completed',native_state='completed',envelope_json=?,result_json=? WHERE prompt_id=?", [envelope, result, prompt]);
    db.run("INSERT INTO search_discoveries(id,session_id,thought_id,position,why,evidence_json,added_run_id,added_prompt_id,added_at) VALUES (?,?,?,?,?,'[]','run',?,'2030')", [entry, session.id, thought, position, `why-${entry}`, prompt]);
  };
  occurrence("prompt-1", "d1", "a", 0);
  db.run("INSERT INTO run_steps(run_id,position,prompt_id,state,native_state) VALUES ('run',1,'prompt-2','prepared','unknown')");
  occurrence("prompt-2", "d2", "b", 1);
  db.run("UPDATE search_discoveries SET removed_at='2031' WHERE id='d1'");
  db.run("INSERT INTO rejected_thoughts VALUES ('a')");
  const revisions = db.query("SELECT * FROM search_revisions").all();
  const all = sessions.history("user", session.id, { messages: { limit: 200 }, discoveries: { limit: 200 } });
  expect(all.messages.items).toHaveLength(2);
  expect(all.discoveries.items).toHaveLength(2);
  const page = sessions.history("user", session.id, { messages: { limit: 1 }, discoveries: { limit: 1 } });
  expect(page.scope).toBe("history");
  expect(page.messages.items).toEqual([expect.objectContaining({ id: "m1", text: "question" })]);
  expect(page.discoveries.items).toEqual([expect.objectContaining({ id: "d1", why: "why-d1", removedAt: "2031", availability: "thought-unavailable" })]);
  expect(page.messages.nextCursor).not.toBeNull();
  expect(page.discoveries.nextCursor).not.toBeNull();
  if (!page.messages.nextCursor || !page.discoveries.nextCursor) throw new Error("missing history continuation");
  const next = sessions.history("user", session.id, { messages: { cursor: page.messages.nextCursor }, discoveries: { cursor: page.discoveries.nextCursor } });
  expect(next.messages.items).toEqual([expect.objectContaining({ id: "m2", text: "answer", disposition: "done" })]);
  expect(next.discoveries.items).toEqual([expect.objectContaining({ id: "d2", why: "why-d2", removedAt: null })]);
  expect(next.messages.nextCursor).toBeNull();
  expect(next.discoveries.nextCursor).toBeNull();
  expect(() => sessions.history("ai", session.id)).toThrow();
  expect(() => sessions.history("user", other.id, { messages: { cursor: page.messages.nextCursor } })).toThrow();
  expect(() => sessions.history("user", session.id, { discoveries: { cursor: page.messages.nextCursor } })).toThrow();
  expect(() => sessions.history("user", session.id, { messages: { cursor: { ...page.messages.nextCursor, scope: "normal" } } })).toThrow();
  expect(() => sessions.history("user", session.id, { messages: { cursor: page.messages.nextCursor, limit: 2 } })).toThrow();
  expect(() => sessions.history("user", session.id, { messages: { limit: 201 } })).toThrow();
  expect(() => sessions.history("user", session.id, { discoveries: { limit: 0 } })).toThrow();
  expect(db.query("SELECT * FROM search_revisions").all()).toEqual(revisions);
}));
