import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SearchStorageError } from "../src/domain/agentic-search";

// Proposed internal seam, not an HTTP contract. offerMessage identifies an existing
// same-session message; trusted storage derives its eligible offered dependencies.
// No caller supplies an authoritative dependency list. The implementation may
// choose another typed boundary while preserving these transaction behaviors.
interface Composer { readonly composerId: string; readonly contextToken: string }
interface TurnInput {
  readonly text: string;
  readonly startingThoughtIds: readonly string[];
  readonly requestClock: { readonly at: string; readonly timeZone: string };
  readonly contextMode: "continue" | "restart";
  readonly effort: "standard";
  readonly composerId: string;
  readonly contextToken: string;
}
interface Control {
  readonly receipt: { readonly searchSessionId: string; readonly runId: string; readonly userMessageId: string; readonly admittedAt: string };
  readonly run: { readonly id: string; readonly kind: "search"; readonly status: string };
  readonly session: { readonly id: string; readonly revision: number; readonly lastActivityAt: string };
}
interface TurnCommands {
  openComposer(actor: "user" | "ai", sessionId: string): Composer;
  offerMessage(actor: "user" | "ai", sessionId: string, composerId: string, messageId: string): Composer;
  admitTurn(actor: "user" | "ai", sessionId: string, requestKey: string, input: TurnInput): Control;
  turnByKey(actor: "user" | "ai", sessionId: string, requestKey: string): Control | null;
}

function fixture(action: (db: Database, commands: TurnCommands, sessionId: string, clock: { now: string }) => void): void {
  const db = new Database(":memory:");
  try {
    migrate(db);
    let id = 0;
    const clock = { now: "2030-01-01T12:00:00.000Z" };
    const sessions = new SqliteStore(db).searchSessions({ id: () => `owned-${++id}`, now: () => clock.now });
    const sessionId = sessions.create("user", "create-session", {}).session.id;
    for (const name of ["openComposer", "offerMessage", "admitTurn", "turnByKey"]) {
      expect(typeof Reflect.get(sessions, name)).toBe("function");
    }
    action(db, sessions as unknown as TurnCommands, sessionId, clock);
  } finally { db.close(); }
}

function input(composer: Composer): TurnInput {
  return { text: "Find this thought", startingThoughtIds: ["thought"], requestClock: { at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" },
    contextMode: "continue", effort: "standard", composerId: composer.composerId, contextToken: composer.contextToken };
}

function seedEligibleMessage(db: Database, sessionId: string): void {
  db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES
      ('thought','first source','user','captured-original','2030','capture'),('other','other source','user','captured-original','2030','capture');
    INSERT INTO thought_titles VALUES ('thought','A','user'),('other','B','user');
    INSERT INTO thought_source_seals VALUES ('thought'),('other');
    INSERT INTO connections VALUES ('connection','thought','other','related','user','related');
    INSERT INTO responses VALUES ('response','shared response','addendum','complete');
    INSERT INTO response_thoughts VALUES ('response','thought',0),('response','other',1);
    INSERT INTO response_seals VALUES ('response');
    INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES ('old-run','search','queued','old-native','old-prompt','2030',0);`);
  const intent = { version: 1, startingThoughtIds: [], requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" },
    daemonObservedAt: "2030-01-01T12:00:00.000Z", contextMode: "continue", composerId: "old-composer", contextToken: "old-token",
    verifiedContext: { sessionId, composerId: "old-composer", composerRevision: 0, eligibilityRevision: 0 } };
  db.run("INSERT INTO search_turns(run_id,session_id,position,request_key,admitted_at,effort,context_mode,intent_json) VALUES ('old-run',?,0,'old-key','2030','standard','continue',?)", [sessionId, JSON.stringify(intent)]);
  db.run("INSERT INTO search_messages(id,session_id,run_id,position,role,text,created_at,evidence_json) VALUES ('old-message',?,'old-run',0,'user','previous text','2030','[]')", [sessionId]);
  for (const [kind, ref] of [["thought", "thought"], ["connection", "connection"], ["response", "response"]]) {
    db.run("INSERT INTO search_content_dependencies(session_id,message_id,ref_kind,ref_id) VALUES (?,'old-message',?,?)", [sessionId, kind, ref]);
  }
  db.run("UPDATE runs SET status='completed' WHERE id='old-run'");
}

function snapshot(db: Database): unknown {
  return ["search_sessions", "search_revisions", "search_composer_contexts", "search_composer_dependencies", "runs", "run_steps", "search_turns", "search_messages", "search_content_dependencies", "run_context"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
}

test("admission atomically inherits the whole trusted offered union and freezes both clocks", () => fixture((db, commands, sessionId, clock) => {
  seedEligibleMessage(db, sessionId);
  const composer = commands.openComposer("user", sessionId);
  const offered = commands.offerMessage("user", sessionId, composer.composerId, "old-message");
  expect(offered.contextToken).not.toBe(composer.contextToken);
  const stale = snapshot(db);
  expect(() => commands.admitTurn("user", sessionId, "new-key", input(composer))).toThrow(/context-changed/i);
  expect(snapshot(db)).toEqual(stale);
  clock.now = "2030-01-01T12:10:00.000Z";
  const payload = input(offered);
  const result = commands.admitTurn("user", sessionId, "new-key", payload);
  expect(Object.keys(result).sort()).toEqual(["receipt", "run", "session"]);
  expect(JSON.stringify(result)).not.toContain(payload.text);
  expect(result.receipt).toEqual(expect.objectContaining({ searchSessionId: sessionId, admittedAt: clock.now }));
  expect(result.run).toEqual(expect.objectContaining({ id: result.receipt.runId, kind: "search", status: "queued" }));
  const row = db.query("SELECT intent_json FROM search_turns WHERE run_id=?").get(result.receipt.runId) as { intent_json: string };
  expect(JSON.parse(row.intent_json)).toEqual(expect.objectContaining({ requestClock: payload.requestClock, daemonObservedAt: clock.now, composerId: composer.composerId }));
  expect(db.query("SELECT text,created_at FROM search_messages WHERE id=?").get(result.receipt.userMessageId)).toEqual({ text: payload.text, created_at: clock.now });
  const expected = [{ kind: "connection", id: "connection" }, { kind: "response", id: "response" }, { kind: "thought", id: "thought" }];
  expect(db.query("SELECT ref_kind AS kind,ref_id AS id FROM search_content_dependencies WHERE message_id=? ORDER BY kind,id").all(result.receipt.userMessageId)).toEqual(expected);
  expect(db.query("SELECT kind,ref_id AS id FROM run_context WHERE run_id=? ORDER BY kind,id").all(result.receipt.runId)).toEqual(expected);
  expect(db.query("SELECT kind,ref_id AS id,full_read FROM run_context WHERE run_id=? ORDER BY kind,id").all(result.receipt.runId))
    .toEqual(expected.map(ref => ({ ...ref, full_read: 0 })));
  expect(db.query("SELECT state FROM search_composer_contexts WHERE id=?").get(composer.composerId)).toEqual({ state: "consumed" });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}));

test("exact turn replay wins over consumed composer and active slot, but new and changed commands do not", () => fixture((db, commands, sessionId, clock) => {
  seedEligibleMessage(db, sessionId);
  const composer = commands.openComposer("user", sessionId);
  const payload = input(composer);
  const first = commands.admitTurn("user", sessionId, "turn-key", payload);
  const saved = snapshot(db);
  clock.now = "2030-01-01T13:00:00.000Z";
  expect(commands.admitTurn("user", sessionId, "turn-key", payload)).toEqual(first);
  expect(commands.turnByKey("user", sessionId, "turn-key")).toEqual(first);
  expect(JSON.stringify(commands.turnByKey("user", sessionId, "turn-key"))).not.toContain(payload.text);
  expect(() => commands.admitTurn("user", sessionId, "turn-key", { ...payload, text: "different" })).toThrow(/idempotency-conflict/i);
  expect(snapshot(db)).toEqual(saved);
  const other = commands.openComposer("user", sessionId);
  const withOther = snapshot(db);
  expect(() => commands.admitTurn("user", sessionId, "other-key", input(other))).toThrow(/turn-active/i);
  expect(snapshot(db)).toEqual(withOther);
  expect(commands.turnByKey("user", sessionId, "unknown")).toBeNull();
  expect(db.query("SELECT count(*) AS n FROM search_turns WHERE request_key='turn-key'").get()).toEqual({ n: 1 });
  // A later composer creation is the sole intentional difference from the replay snapshot.
  expect(saved).not.toEqual(withOther);
}));

test("offered context is same-session and fail-closed for rejected dependencies", () => fixture((db, commands, sessionId) => {
  seedEligibleMessage(db, sessionId);
  const composer = commands.openComposer("user", sessionId);
  expect(() => commands.offerMessage("user", "another-session", composer.composerId, "old-message")).toThrow();
  db.run("INSERT INTO rejected_thoughts VALUES ('other')");
  const offered = commands.offerMessage("user", sessionId, composer.composerId, "old-message");
  expect(JSON.stringify(offered)).not.toContain("previous text");
  expect(db.query("SELECT * FROM search_composer_dependencies WHERE composer_id=?").all(composer.composerId)).toEqual([]);
  const before = snapshot(db);
  expect(() => commands.admitTurn("user", sessionId, "bad-start", { ...input(offered), startingThoughtIds: ["other"] })).toThrow();
  expect(snapshot(db)).toEqual(before);
}));

test("composer and turn commands reject AI actors and caller-owned dependency or identity fields", () => fixture((db, commands, sessionId) => {
  seedEligibleMessage(db, sessionId);
  const composer = commands.openComposer("user", sessionId);
  const request = input(composer);
  const before = snapshot(db);
  expect(() => commands.openComposer("ai", sessionId)).toThrow();
  expect(() => commands.offerMessage("ai", sessionId, composer.composerId, "old-message")).toThrow();
  expect(() => commands.admitTurn("ai", sessionId, "ai-key", request)).toThrow();
  expect(() => commands.turnByKey("ai", sessionId, "missing")).toThrow();
  for (const extra of [
    { dependencies: [{ kind: "thought", id: "thought" }] },
    { runId: "caller-run" },
    { createdAt: "2099-01-01T00:00:00.000Z" },
    { unknown: true },
  ]) expect(() => commands.admitTurn("user", sessionId, "strict-key", { ...request, ...extra })).toThrow();
  expect(snapshot(db)).toEqual(before);
  expect(commands.turnByKey("user", sessionId, "strict-key")).toBeNull();
}));

test("admission failure after run insertion rolls back receipt, message, composer and clocks", () => fixture((db, commands, sessionId) => {
  seedEligibleMessage(db, sessionId);
  const composer = commands.openComposer("user", sessionId);
  db.exec(`CREATE TEMP TRIGGER fail_search_message BEFORE INSERT ON search_messages
    WHEN NEW.text='Find this thought'
      AND EXISTS (SELECT 1 FROM runs WHERE id=NEW.run_id AND kind='search')
      AND EXISTS (SELECT 1 FROM search_turns WHERE run_id=NEW.run_id AND session_id=NEW.session_id)
    BEGIN SELECT RAISE(ABORT,'injected-after-search-run-and-turn'); END`);
  const before = snapshot(db);
  let failure: unknown;
  try { commands.admitTurn("user", sessionId, "fault-key", input(composer)); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SearchStorageError);
  if (!(failure instanceof SearchStorageError)) throw new Error("admission did not return a sanitized storage error");
  expect(failure.message).toBe("search-persistence-failed");
  expect(failure.cause).toBeInstanceOf(Error);
  if (!(failure.cause instanceof Error)) throw new Error("missing underlying SQLite fault");
  expect(failure.cause.message).toContain("injected-after-search-run-and-turn");
  expect(Object.getOwnPropertyDescriptor(failure, "cause")?.enumerable).toBe(false);
  expect(JSON.stringify(failure)).not.toContain("injected-after-search-run-and-turn");
  expect(snapshot(db)).toEqual(before);
  expect(commands.turnByKey("user", sessionId, "fault-key")).toBeNull();
  db.exec("DROP TRIGGER temp.fail_search_message");
  const admitted = commands.admitTurn("user", sessionId, "fault-key", input(composer));
  expect(admitted.receipt.searchSessionId).toBe(sessionId);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}));
