import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RunConflictError, RunFenceError, RunService, type NativeDispatcher } from "../src/domain/run";
import type { CapabilityEnvelope } from "../src/domain/run-protocol";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const now = () => "2030-01-02T00:00:00Z";
const dispatcher: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
const envelope: CapabilityEnvelope = { version: 1, kind: "request", request: { capability: "inspectThought", arguments: { thoughtId: "root" } } };
const next = { promptId: "next-prompt", input: '{"capabilityResult":{"result":"visible"}}' };

function temporary(action: (path: string, db: Database) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "run-protocol-"));
  const path = join(dir, "owned.sqlite");
  const db = new Database(path);
  try { action(path, db); } finally { db.close(false); rmSync(dir, { recursive: true, force: true }); }
}
function services(db: Database) {
  let sequence = 0;
  const id = () => `owned-${++sequence}`;
  const repository = new SqliteRunRepository(db, { id, now });
  return { repository, service: new RunService({ repository, dispatcher, id, now }), steps: new SqliteRunProtocolRepository(db) };
}
function seed(db: Database) {
  migrate(db);
  new SqliteStore(db).saveThought({ id: "root", text: "retained root", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
}

describe("run protocol persistence", () => {
  test("core migration backfills legacy prompt as step zero without inventing input", () => temporary((path, db) => {
    // Frozen pre-step run schema: the prompt identity existed, but its input was not retained.
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,session_id TEXT UNIQUE NOT NULL,prompt_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,generation INTEGER NOT NULL,input_thought_id TEXT,native_state TEXT NOT NULL);
      INSERT INTO runs VALUES ('old-run','weave','uncertain','old-session','old-prompt','2026',0,NULL,'completed');`);
    migrate(db);
    const table = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='run_steps'").get();
    expect(table).toEqual({ name: "run_steps" });
    const repo = new SqliteRunProtocolRepository(db);
    expect(repo.steps("old-run")).toEqual([{ runId: "old-run", position: 0, promptId: "old-prompt", input: null, state: "completed", envelope: null, result: null }]);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      migrate(reopened);
      expect(new SqliteRunProtocolRepository(reopened).steps("old-run")).toEqual(repo.steps("old-run"));
      expect(new SqliteRunRepository(reopened, { id: () => "unused", now }).get("old-run")).toMatchObject({ sessionId: "old-session", promptId: "old-prompt", nativeState: "completed" });
    } finally { reopened.close(); }
  }));

  test("ordered exact prompts and per-step completion survive reopen and do not complete the run", () => temporary((path, db) => {
    seed(db);
    const { service, repository, steps } = services(db);
    const run = service.admit("user", "weave").run;
    const claim = service.claim(run.id);
    const firstInput = '{"subject":"root","instructions":"initial exact input"}';
    expect(steps.prepare(claim, { promptId: run.promptId, input: firstInput })).toEqual({ runId: run.id, position: 0, promptId: run.promptId, input: firstInput, state: "prepared", envelope: null, result: null });
    steps.setStepState(claim, run.promptId, "submitting");
    steps.setStepState(claim, run.promptId, "uncertain");
    steps.completeStep(claim, run.promptId, envelope);
    expect(repository.get(run.id)?.status).not.toBe("completed");
    expect(steps.steps(run.id)[0]).toEqual({ runId: run.id, position: 0, promptId: run.promptId, input: firstInput, state: "completed", envelope, result: null });
    const second = steps.advance(claim, run.promptId, { found: "visible" }, next);
    expect(second).toEqual({ runId: run.id, position: 1, promptId: next.promptId, input: next.input, state: "prepared", envelope: null, result: null });
    expect(steps.advance(claim, run.promptId, { found: "visible" }, next)).toEqual(second);
    expect(() => steps.advance(claim, run.promptId, { found: "different" }, next)).toThrow(RunConflictError);
    expect(() => db.run("UPDATE run_steps SET input='rewritten' WHERE run_id=? AND position=0", [run.id])).toThrow(/immutable/i);
    expect(() => db.run("UPDATE run_steps SET prompt_id='rewritten' WHERE run_id=? AND position=0", [run.id])).toThrow(/immutable/i);
    expect(() => db.run("DELETE FROM run_steps WHERE run_id=? AND position=0", [run.id])).toThrow(/immutable/i);
    expect(repository.reply(run.id)).toBeNull();
    expect(new SqliteStore(db).getResponse(run.promptId)).toBeNull();
    const reopened = new Database(path);
    try {
      migrate(reopened);
      const restored = new SqliteRunProtocolRepository(reopened);
      expect(restored.steps(run.id)).toEqual([
        { runId: run.id, position: 0, promptId: run.promptId, input: firstInput, state: "processed", envelope, result: { found: "visible" } },
        second,
      ]);
      expect(restored.steps(run.id)[1]?.state).toBe("prepared");
      expect(new SqliteRunRepository(reopened, { id: () => "unused", now }).get(run.id)?.status).not.toBe("completed");
    } finally { reopened.close(); }
  }));

  test("fault while preparing the next step rolls back proposal processing and result delivery", () => temporary((_path, db) => {
    seed(db);
    const { service, steps } = services(db);
    const run = service.admit("user", "weave").run;
    const claim = service.claim(run.id);
    steps.prepare(claim, { promptId: run.promptId, input: "initial" });
    steps.completeStep(claim, run.promptId, envelope);
    db.exec("CREATE TRIGGER test_step_failure BEFORE INSERT ON run_steps WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'test step advance failure'); END;");
    expect(() => steps.advance(claim, run.promptId, { found: "visible" }, next)).toThrow(/test step advance failure/);
    expect(steps.steps(run.id)).toEqual([{ runId: run.id, position: 0, promptId: run.promptId, input: "initial", state: "completed", envelope, result: null }]);
    db.exec("DROP TRIGGER test_step_failure");
    expect(steps.advance(claim, run.promptId, { found: "visible" }, next).position).toBe(1);
    expect(steps.steps(run.id)).toHaveLength(2);
  }));

  test("Stop fences step processing but retains cancellation settlement after local termination", () => temporary((path, db) => {
    seed(db);
    const { service, repository, steps } = services(db);
    const run = service.admit("user", "weave").run;
    const claim = service.claim(run.id);
    steps.prepare(claim, { promptId: run.promptId, input: "initial" });
    steps.setStepState(claim, run.promptId, "submitting");
    service.stop("user", run.id);
    expect(repository.get(run.id)?.status).toBe("interrupted");
    expect(steps.cancellation(run.id)).toBe("pending");
    expect(() => steps.completeStep(claim, run.promptId, envelope)).toThrow(RunFenceError);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      const restored = new SqliteRunProtocolRepository(reopened);
      expect(restored.cancellation(run.id)).toBe("pending");
      restored.settleCancellation(run.id);
      expect(restored.cancellation(run.id)).toBe("settled");
      expect(new SqliteRunRepository(reopened, { id: () => "unused", now }).get(run.id)?.status).toBe("interrupted");
    } finally { reopened.close(); }
  }));
});
