import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EvolveConflictError, evolvePassageStart } from "../src/domain/evolve-sessions";
import { RejectionService } from "../src/domain/rejection";
import { createLogger } from "../src/logging";
import { evolveContextEligible, evolveInitialContext } from "../src/storage/evolve-context";
import { evolveTurnById } from "../src/storage/evolve-records";
import { SqliteEvolveSessions } from "../src/storage/evolve-sessions";
import { saveEvolveIdea } from "../src/storage/evolve-save";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";

// Test-owned durable state, including an incremental receipt whose originating
// run was stopped. No model, transport, or personal library is involved.
function fixture(action: (f: {
  db: Database; sessions: SqliteEvolveSessions; sessionId: string;
  admit: (key: string, text: string) => { turnId: string; runId: string; promptId: string };
  settle: (runId: string, status: "completed" | "interrupted", reply?: string) => void;
}) => void) {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const store = new SqliteStore(db);
    for (const [id, text] of [["anchor", "Owned eligible anchor"], ["dependency", "Owned dependency"], ["recalled", "A recalled user insight."]]) {
      store.saveThought({ id, text, title: null, author: "user", kind: "captured-original", createdAt: "2030",
        origin: "fixture", parentId: null, sourceIds: [] });
    }
    let sequence = 0;
    const sessions = new SqliteEvolveSessions(db, { id: () => `owned-${++sequence}`, now: () => "2030",
      logger: createLogger("error", () => {}) }, true);
    const sessionId = sessions.create("anchor").id;
    const admit = (key: string, text: string) => {
      const result = sessions.admit(sessionId, key, { parentId: "anchor", text });
      if (!result.run) throw new Error("configured turn has no run");
      const step = db.query<{ prompt_id: string }, [string]>("SELECT prompt_id FROM run_steps WHERE run_id=? AND position=0").get(result.run.id);
      if (!step) throw new Error("missing owned step");
      return { turnId: result.turn.id, runId: result.run.id, promptId: step.prompt_id };
    };
    const settle = (runId: string, status: "completed" | "interrupted", reply?: string) => {
      if (reply !== undefined) db.run("UPDATE evolve_turns SET reply=? WHERE run_id=?", [reply, runId]);
      db.run("UPDATE runs SET status=? WHERE id=?", [status, runId]);
    };
    action({ db, sessions, sessionId, admit, settle });
  } finally { db.close(); }
}

test("a recalled save surviving Stop invalidates both its source history and a prepared dependent run", () => fixture(f => {
  const source = f.admit("source", "A recalled user insight.");
  f.settle(source.runId, "completed", "The first exchange.");
  const destination = f.admit("destination", "Remember the earlier passage.");
  f.db.run("INSERT INTO evolve_turn_history(turn_id,prior_turn_id) VALUES (?,?)", [destination.turnId, source.turnId]);
  f.db.run(`INSERT INTO evolve_saves(thought_id,turn_id,position,speaker,selected_by,source,passage_start,prompt_id,selection_index,source_turn_id)
    VALUES (?,?,0,'user','ai','passage',0,?,0,?)`, ["recalled", destination.turnId, destination.promptId, source.turnId]);
  f.settle(destination.runId, "interrupted");
  const prepared = f.admit("prepared", "Continue from the anchor.");
  const owner = f.sessions.read(f.sessionId).session;
  const preparedTurn = evolveTurnById(f.db, prepared.turnId);
  if (!preparedTurn) throw new Error("missing prepared turn");
  const before = evolveInitialContext(f.db, owner, preparedTurn, () => {});
  expect(before.history.map(turn => turn.id)).toContain(source.turnId);
  const preparedInput = JSON.stringify({ kind: "ideas-job", context: before });
  f.db.run("UPDATE run_steps SET input=? WHERE run_id=? AND position=0", [preparedInput, prepared.runId]);
  expect(evolveContextEligible(f.db, source.turnId)).toBe(true);
  expect(evolveContextEligible(f.db, destination.turnId)).toBe(true);

  new RejectionService(new SqliteRejectionRepository(f.db, createLogger("error", () => {}))).rejectThought("user", "recalled");
  expect(evolveContextEligible(f.db, source.turnId)).toBe(false);
  expect(evolveContextEligible(f.db, destination.turnId)).toBe(false);
  expect(f.db.query("SELECT status FROM runs WHERE id=?").get(prepared.runId)).toEqual({ status: "interrupted" });
  expect(f.db.query("SELECT input FROM run_steps WHERE run_id=? AND position=0").get(prepared.runId)).toEqual({ input: preparedInput });
  const next = f.admit("next", "Continue with eligible context.");
  const nextTurn = evolveTurnById(f.db, next.turnId);
  if (!nextTurn) throw new Error("missing next turn");
  const after = evolveInitialContext(f.db, owner, nextTurn, () => {});
  expect(after.history.map(turn => turn.id)).not.toContain(source.turnId);
}));

test("a fresh manual keep rejects ineligible source context while a confirmed key remains recoverable", () => fixture(f => {
  const source = f.admit("source", "First owned insight. Second owned insight.");
  f.db.run("INSERT INTO run_context(run_id,kind,ref_id) VALUES (?,'thought','dependency')", [source.runId]);
  f.settle(source.runId, "completed", "An owned reply.");
  const first = { speaker: "user" as const, text: "First owned insight.", parentId: "anchor" };
  const saved = f.sessions.keep(f.sessionId, source.turnId, "confirmed", first);
  expect(saved.replayed).toBe(false);
  f.db.run("INSERT INTO rejected_thoughts(thought_id) VALUES ('dependency')");
  expect(evolveContextEligible(f.db, source.turnId)).toBe(false);
  const counts = () => ({
    thoughts: f.db.query("SELECT count(*) AS n FROM thoughts").get(),
    runs: f.db.query("SELECT count(*) AS n FROM runs").get(),
    receipts: f.db.query("SELECT count(*) AS n FROM evolve_saves").get(),
  });
  const before = counts();
  expect(() => f.sessions.keep(f.sessionId, source.turnId, "fresh", {
    speaker: "user", text: "Second owned insight.", parentId: "anchor",
  })).toThrow();
  expect(counts()).toEqual(before);
  expect(f.sessions.saveByKey(f.sessionId, source.turnId, "confirmed")).toEqual(saved.receipt);
  expect(f.sessions.keep(f.sessionId, source.turnId, "confirmed", first)).toEqual({ receipt: saved.receipt, replayed: true });
  expect(counts()).toEqual(before);
}));

test("automatic user selection rejects a complete middle sentence inside a single-quoted passage without rejecting contractions", () => fixture(f => {
  const quoted = "A colleague wrote 'First borrowed claim. Second borrowed claim. Third borrowed claim.' I am considering it.";
  const unquoted = "A colleague wrote. First borrowed claim. Second borrowed claim. Third borrowed claim. I am considering it.";
  const passage = "Second borrowed claim.";
  expect(evolvePassageStart(unquoted, passage, true, true)).toBe(unquoted.indexOf(passage));
  const source = f.admit("quoted", quoted);
  const turn = evolveTurnById(f.db, source.turnId);
  if (!turn) throw new Error("missing source turn");
  const before = {
    thoughts: f.db.query("SELECT count(*) AS n FROM thoughts").get(),
    saves: f.db.query("SELECT count(*) AS n FROM evolve_saves").get(),
    runs: f.db.query("SELECT count(*) AS n FROM runs").get(),
  };
  let failure: unknown;
  try {
    f.db.transaction(() => saveEvolveIdea(f.db, { id: () => "not-authorized", now: () => "2030" }, turn,
      { speaker: "user", text: passage, parentId: "anchor" }, "passage",
      { selectedBy: "ai", runId: source.runId, promptId: source.promptId, index: 0 }))();
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(EvolveConflictError);
  expect(failure).toMatchObject({ code: "invalid-passage" });
  expect({
    thoughts: f.db.query("SELECT count(*) AS n FROM thoughts").get(),
    saves: f.db.query("SELECT count(*) AS n FROM evolve_saves").get(),
    runs: f.db.query("SELECT count(*) AS n FROM runs").get(),
  }).toEqual(before);
  const authored = "I don't think the first approach works. A reversible experiment would clarify it.";
  const insight = "A reversible experiment would clarify it.";
  expect(evolvePassageStart(authored, insight, true, true)).toBe(authored.indexOf(insight));
  expect(evolvePassageStart("I don't think the first approach works.", "I don't think the first approach works.", true, true)).toBe(0);
  const pluralQuote = "A colleague wrote 'The writers' notes are tentative. Second borrowed claim. Third borrowed claim.' I am considering it.";
  const pluralUnquoted = "The writers' notes are tentative. Second borrowed claim. Third borrowed claim.";
  expect(evolvePassageStart(pluralUnquoted, passage, true, true)).toBe(pluralUnquoted.indexOf(passage));
  expect(() => evolvePassageStart(pluralQuote, passage, true, true)).toThrow(EvolveConflictError);
}));
