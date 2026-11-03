import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RunFenceError, RunForbiddenError, RunConflictError, RunNotFoundError, RunService, type NativeDispatcher, type Operation } from "../src/domain/run";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { latestEligibleDevelopment } from "../src/domain/shared-response";

const clock = () => "2030-01-02T00:00:00Z";
const noop: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
const operation: Operation = { id: "operation-1", type: "development", parentId: "child", text: "AI retained development", sourceIds: ["child"] };

function withDb(action: (path: string, db: Database) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "thoughtloom-runs-"));
  const path = join(dir, "owned.sqlite");
  const db = new Database(path);
  try { action(path, db); } finally { db.close(false); rmSync(dir, { recursive: true, force: true }); }
}
async function withAsyncDb(action: (path: string, db: Database) => Promise<void>) {
  const dir = mkdtempSync(join("/tmp/opencode", "thoughtloom-runs-"));
  const path = join(dir, "owned.sqlite");
  const db = new Database(path);
  try { await action(path, db); } finally { db.close(false); rmSync(dir, { recursive: true, force: true }); }
}
function setup(db: Database, dispatcher: NativeDispatcher = noop) {
  let sequence = 0;
  const id = () => `generated-${++sequence}`;
  const repo = new SqliteRunRepository(db, { id, now: clock });
  const service = new RunService({ repository: repo, dispatcher, id, now: clock });
  return { repo, service };
}
function seed(db: Database) {
  migrate(db);
  const store = new SqliteStore(db);
  store.saveThought({ id: "root", text: "original", title: "original title", author: "user", kind: "captured-original", createdAt: clock(), origin: "capture", parentId: null, sourceIds: [] });
  store.saveThought({ id: "child", text: "child", title: null, author: "ai", kind: "developing-idea", createdAt: clock(), origin: "development", parentId: "root", sourceIds: ["root"] });
  store.saveThought({ id: "other", text: "other", title: null, author: "user", kind: "user-contribution", createdAt: clock(), origin: "contribution", parentId: "root", sourceIds: [] });
  store.saveConnection({ id: "link", fromId: "child", toId: "other", category: "related", proposedBy: "ai", explanation: "relation", sourceIds: [] });
  store.saveResponse({ id: "shared", text: "shared private response", role: "addendum", state: "complete", thoughtIds: ["child", "other"] });
}

describe("durable run SQLite boundary", () => {
  test("adding run storage preserves frozen legacy inline title and single-owner response data", () => withDb((_path, db) => {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;
      CREATE TABLE thoughts (id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,title TEXT,author TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id));
      CREATE TRIGGER thoughts_immutable_update BEFORE UPDATE ON thoughts BEGIN SELECT RAISE(ABORT,'thoughts are immutable'); END;
      CREATE TRIGGER thoughts_immutable_delete BEFORE DELETE ON thoughts BEGIN SELECT RAISE(ABORT,'thoughts are immutable'); END;
      CREATE TABLE responses (id TEXT PRIMARY KEY NOT NULL,thought_id TEXT NOT NULL REFERENCES thoughts(id),text TEXT NOT NULL,role TEXT NOT NULL);
      CREATE TRIGGER responses_immutable_update BEFORE UPDATE ON responses BEGIN SELECT RAISE(ABORT,'responses are immutable'); END;
      CREATE TRIGGER responses_immutable_delete BEFORE DELETE ON responses BEGIN SELECT RAISE(ABORT,'responses are immutable'); END;
      INSERT INTO thoughts VALUES ('legacy','legacy text','legacy title','user','captured-original','2026','capture',NULL);
      INSERT INTO responses VALUES ('legacy-response','legacy','legacy response text','fallback');`);
    migrate(db);
    const { repo, service } = setup(db);
    const store = new SqliteStore(db);
    expect(store.getThought("legacy")).toEqual({ id: "legacy", text: "legacy text", title: "legacy title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2026", origin: "capture", parentId: null, sourceIds: [] });
    expect(store.getResponse("legacy-response")).toEqual({ id: "legacy-response", text: "legacy response text", role: "fallback", state: "complete", thoughtIds: ["legacy"] });
    expect(() => db.run("UPDATE thoughts SET text='changed' WHERE id='legacy'")).toThrow(/immutable/i);
    expect(() => db.run("UPDATE responses SET text='changed' WHERE id='legacy-response'")).toThrow(/immutable/i);
    const run = service.admit("user", "weave").run;
    expect(repo.get(run.id)).toEqual(run);
  }));

  test("core migration alone initializes fresh runs and reopen without an adapter migration", () => withDb((path, db) => {
    migrate(db);
    const { service, repo } = setup(db);
    const run = service.admit("user", "weave").run;
    expect(repo.get(run.id)).toEqual(run);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      const restored = new SqliteRunRepository(reopened, { id: () => "unused", now: clock });
      expect(restored.get(run.id)).toEqual(run);
    } finally { reopened.close(); }
  }));

  test("evolve admissions retain distinct immutable input identities and fence unrelated parents", () => withDb((path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const first = service.admit("user", "evolve", { parentId: "root", text: "same question" });
    const second = service.admit("user", "evolve", { parentId: "root", text: "same question" });
    if (!first.contribution || !second.contribution) throw new Error("Expected both contributions");
    const firstInputId = first.contribution.id;
    const secondInputId = second.contribution.id;
    expect(firstInputId).not.toBe(secondInputId);
    // Input identity is part of the persisted immutable run identity.
    expect(() => db.run("UPDATE runs SET input_thought_id=? WHERE id=?", [secondInputId, first.run.id])).toThrow(/immutable/i);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      const restored = new SqliteRunRepository(reopened, { id: () => "unused", now: clock });
      expect(restored.get(first.run.id)?.inputThoughtId).toBe(firstInputId);
      expect(restored.get(second.run.id)?.inputThoughtId).toBe(secondInputId);
    } finally { reopened.close(); }
    const claim = service.claim(first.run.id);
    const before = db.query("SELECT COUNT(*) AS n FROM thoughts").get();
    for (const parentId of ["root", "child", secondInputId]) {
      const attempt = { ...operation, id: `invalid-${parentId}`, parentId };
      expect(() => service.execute(claim, attempt)).toThrow(RunConflictError);
      expect(repo.receipt(claim.runId, attempt.id)).toBeNull();
      expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(before);
    }
    const valid = { ...operation, parentId: firstInputId };
    expect(service.execute(claim, valid).thought.parentId).toBe(firstInputId);
    expect(repo.get(first.run.id)?.inputThoughtId).toBe(firstInputId);
  }));

  test("failed evolve admission creates neither contribution nor run", () => withDb((_path, db) => {
    seed(db);
    const { service } = setup(db);
    const before = db.query("SELECT COUNT(*) AS n FROM thoughts").get();
    expect(() => service.admit("user", "evolve", { parentId: "missing", text: "retain only if admitted" })).toThrow(RunNotFoundError);
    expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    // Either insertion order fires only once both test-owned rows are visible.
    db.exec(`
      CREATE TRIGGER test_admission_run_after_both AFTER INSERT ON runs
      WHEN NEW.kind='evolve' AND EXISTS (SELECT 1 FROM thoughts WHERE text='must roll back')
      BEGIN SELECT RAISE(ABORT,'test admission failure after both'); END;
      CREATE TRIGGER test_admission_thought_after_both AFTER INSERT ON thoughts
      WHEN NEW.text='must roll back' AND EXISTS (SELECT 1 FROM runs WHERE kind='evolve')
      BEGIN SELECT RAISE(ABORT,'test admission failure after both'); END;
    `);
    expect(() => service.admit("user", "evolve", { parentId: "root", text: "must roll back" })).toThrow(/test admission failure after both/);
    expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM thoughts WHERE text='must roll back'").get()).toEqual({ n: 0 });
  }));

  test("new rejected parent or source is denied even when never exposed as context", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const claim = service.claim(service.admit("user", "weave").run.id);
    new RejectionService(new SqliteRejectionRepository(db)).rejectThought("user", "root");
    const before = db.query("SELECT COUNT(*) AS n FROM thoughts").get();
    for (const invalid of [
      { ...operation, id: "hidden-parent", parentId: "root", sourceIds: [] },
      { ...operation, id: "hidden-source", parentId: "child", sourceIds: ["root"] },
    ]) {
      let failure: unknown;
      try { service.execute(claim, invalid); } catch (error) { failure = error; }
      expect(failure instanceof RunNotFoundError || failure instanceof RunFenceError).toBe(true);
      expect(repo.receipt(claim.runId, invalid.id)).toBeNull();
      expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(before);
    }
    expect(repo.contextRefs(claim.runId)).toEqual([]);
  }));

  test("restart recovery observes stored native identities without resubmitting or holding a SQLite write lock", async () => {
    await withAsyncDb(async (path, db) => {
      seed(db);
      const observed: string[][] = [];
      const submitted: string[][] = [];
      const dispatcher: NativeDispatcher = {
        async submit(session, prompt) { submitted.push([session, prompt]); const probe = new Database(path); try { probe.exec("BEGIN IMMEDIATE; ROLLBACK;"); } finally { probe.close(); } },
        async observe(session, prompt) { observed.push([session, prompt]); const probe = new Database(path); try { probe.exec("BEGIN IMMEDIATE; ROLLBACK;"); } finally { probe.close(); } return "running"; },
      };
      const first = setup(db, dispatcher);
      const run = first.service.admit("user", "weave").run;
      const claim = first.service.claim(run.id);
      expect(first.repo.get(run.id)).toMatchObject({ sessionId: run.sessionId, promptId: run.promptId });
      await first.service.submit(claim);
      first.repo.setStatus(claim, "uncertain");
      const reopened = new Database(path);
      try {
        migrate(reopened);
        const second = setup(reopened, dispatcher);
        await second.service.recover(run.id);
        expect(observed).toEqual([[run.sessionId, run.promptId]]);
        expect(submitted).toEqual([[run.sessionId, run.promptId]]);
        expect(second.repo.get(run.id)?.status).toBe("running");
      } finally { reopened.close(); }
    });
  });
  test("admission, confirmed operations, partial reply and identity survive reopen; Stop fences replay", () => withDb((path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const admitted = service.admit("user", "evolve", { parentId: "root", text: "my retained question" });
    expect(admitted.contribution?.author).toBe("user");
    expect(new SqliteStore(db).getThought(admitted.contribution?.id ?? "missing")).toEqual(admitted.contribution);
    const claim = service.claim(admitted.run.id);
    if (!admitted.contribution) throw new Error("Expected admitted contribution");
    const evolveOperation = { ...operation, parentId: admitted.contribution.id };
    const saved = service.execute(claim, evolveOperation);
    expect(saved.thought.author).toBe("ai");
    expect(repo.receipt(claim.runId, evolveOperation.id)).toEqual({ operation: evolveOperation, result: saved });
    expect(service.execute(claim, evolveOperation)).toEqual(saved);
    expect(() => service.execute(claim, { ...evolveOperation, text: "different request" })).toThrow(RunConflictError);
    service.recordPartial(claim, { id: "partial", text: "unfinished reply", role: "addendum", thoughtIds: [saved.thought.id] });
    service.stop("user", admitted.run.id);
    expect(repo.get(admitted.run.id)?.status).toBe("interrupted");
    expect(repo.reply(admitted.run.id)).toEqual({ id: "partial", text: "unfinished reply", role: "addendum", state: "interrupted", thoughtIds: [saved.thought.id] });
    expect(() => service.execute(claim, evolveOperation)).toThrow(RunFenceError);
    expect(new SqliteStore(db).getThought(saved.thought.id)).toEqual(saved.thought);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      const restored = new SqliteRunRepository(reopened, { id: () => "unused", now: clock });
      expect(restored.get(admitted.run.id)).toMatchObject({ id: admitted.run.id, kind: "evolve", sessionId: admitted.run.sessionId, promptId: admitted.run.promptId, status: "interrupted" });
      expect(restored.receipt(claim.runId, evolveOperation.id)).toEqual({ operation: evolveOperation, result: saved });
      expect(restored.reply(admitted.run.id)).toEqual({ id: "partial", text: "unfinished reply", role: "addendum", state: "interrupted", thoughtIds: [saved.thought.id] });
    } finally { reopened.close(); }
  }));

  test("fault after knowledge insert before receipt rolls back the entire operation", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const claim = service.claim(service.admit("user", "weave").run.id);
    const before = db.query("SELECT COUNT(*) AS n FROM thoughts").get();
    // The receipt insert happens after the synchronous domain writes inside the same transaction.
    db.exec("CREATE TRIGGER test_receipt_failure BEFORE INSERT ON run_operation_receipts BEGIN SELECT RAISE(ABORT,'test receipt failure'); END;");
    expect(() => service.execute(claim, operation)).toThrow(/test receipt failure/);
    expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(before);
    expect(repo.receipt(claim.runId, operation.id)).toBeNull();
    db.exec("DROP TRIGGER test_receipt_failure");
    const saved = service.execute(claim, operation);
    expect(new SqliteStore(db).getThought(saved.thought.id)).toEqual(saved.thought);
    expect(repo.receipt(claim.runId, operation.id)).toEqual({ operation, result: saved });
  }));

  test("issued membership survives stale partial draft, replay, Stop and reopen in commit order", () => withDb((path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const admission = service.admit("user", "evolve", { parentId: "root", text: "question" });
    if (!admission.contribution) throw new Error("Expected contribution");
    const claim = service.claim(admission.run.id);
    const firstOp = { ...operation, id: "issued-a", parentId: admission.contribution.id };
    const secondOp = { ...operation, id: "issued-b", parentId: admission.contribution.id, text: "second development" };
    const first = service.execute(claim, firstOp);
    service.recordPartial(claim, { id: "ordered-reply", text: "partial", role: "addendum", thoughtIds: [first.thought.id] });
    const second = service.execute(claim, secondOp);
    expect(service.execute(claim, secondOp)).toEqual(second);
    service.stop("user", admission.run.id);
    const expected = { id: "ordered-reply", text: "partial", role: "addendum", state: "interrupted", thoughtIds: [first.thought.id, second.thought.id] } as const;
    expect(repo.reply(admission.run.id)).toEqual(expected);
    expect(latestEligibleDevelopment(expected)).toBe(second.thought.id);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      const restored = new SqliteRunRepository(reopened, { id: () => "unused", now: clock });
      const response = restored.reply(admission.run.id);
      expect(response).toEqual(expected);
      if (!response) throw new Error("Expected interrupted reply");
      expect(latestEligibleDevelopment(response)).toBe(second.thought.id);
      expect(restored.receipt(admission.run.id, secondOp.id)).toEqual({ operation: secondOp, result: second });
    } finally { reopened.close(); }
  }));

  test("finalization rejects reversed issued membership and accepts canonical order", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const admission = service.admit("user", "evolve", { parentId: "root", text: "question" });
    if (!admission.contribution) throw new Error("Expected contribution");
    const inputId = admission.contribution.id;
    const claim = service.claim(admission.run.id);
    const first = service.execute(claim, { ...operation, id: "first", parentId: inputId });
    const second = service.execute(claim, { ...operation, id: "second", parentId: admission.contribution.id });
    const response = { id: "final-ordered", text: "complete", role: "addendum", state: "complete", thoughtIds: [first.thought.id, second.thought.id] } as const;
    expect(() => service.finish(claim, { ...response, thoughtIds: [second.thought.id, first.thought.id] })).toThrow(RunConflictError);
    expect(new SqliteStore(db).getResponse(response.id)).toBeNull();
    expect(repo.get(claim.runId)?.status).not.toBe("completed");
    service.finish(claim, response);
    expect(new SqliteStore(db).getResponse(response.id)).toEqual(response);
  }));

  test("receipt fault rolls back issued membership along with the failed development", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const admission = service.admit("user", "evolve", { parentId: "root", text: "question" });
    if (!admission.contribution) throw new Error("Expected contribution");
    const inputId = admission.contribution.id;
    const claim = service.claim(admission.run.id);
    const first = service.execute(claim, { ...operation, id: "first", parentId: inputId });
    service.recordPartial(claim, { id: "rollback-reply", text: "partial", role: "addendum", thoughtIds: [first.thought.id] });
    const before = db.query("SELECT COUNT(*) AS n FROM thoughts").get();
    // The two tables expose run_id and operation_id; fail only after both matching rows exist.
    db.exec(`
      CREATE TRIGGER test_receipt_after_both AFTER INSERT ON run_operation_receipts
      WHEN NEW.operation_id='fault' AND EXISTS (SELECT 1 FROM run_issued_thoughts WHERE run_id=NEW.run_id AND operation_id=NEW.operation_id)
      BEGIN SELECT RAISE(ABORT,'test fault after receipt and membership'); END;
      CREATE TRIGGER test_membership_after_both AFTER INSERT ON run_issued_thoughts
      WHEN NEW.operation_id='fault' AND EXISTS (SELECT 1 FROM run_operation_receipts WHERE run_id=NEW.run_id AND operation_id=NEW.operation_id)
      BEGIN SELECT RAISE(ABORT,'test fault after receipt and membership'); END;
    `);
    expect(() => service.execute(claim, { ...operation, id: "fault", parentId: inputId })).toThrow(/test fault after receipt and membership/);
    expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(before);
    expect(repo.receipt(claim.runId, "fault")).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM run_issued_thoughts WHERE run_id=? AND operation_id='fault'").get(claim.runId)).toEqual({ n: 0 });
    service.stop("user", admission.run.id);
    expect(repo.reply(admission.run.id)).toEqual({ id: "rollback-reply", text: "partial", role: "addendum", state: "interrupted", thoughtIds: [first.thought.id] });
  }));

  test("issued membership insert fault rolls back development and receipt", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const admission = service.admit("user", "evolve", { parentId: "root", text: "question" });
    if (!admission.contribution) throw new Error("Expected contribution");
    const inputId = admission.contribution.id;
    const claim = service.claim(admission.run.id);
    const before = db.query("SELECT COUNT(*) AS n FROM thoughts").get();
    // Schema seam for fault injection: run_issued_thoughts records committed issue order.
    db.exec("CREATE TRIGGER test_issued_failure AFTER INSERT ON run_issued_thoughts BEGIN SELECT RAISE(ABORT,'test issued membership failure'); END;");
    expect(() => service.execute(claim, { ...operation, parentId: inputId })).toThrow(/test issued membership failure/);
    expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(before);
    expect(repo.receipt(claim.runId, operation.id)).toBeNull();
  }));

  test("rejected exposed context fences native submit while preserving confirmed work", async () => {
    await withAsyncDb(async (_path, db) => {
      seed(db);
      const submissions: string[][] = [];
      const dispatcher: NativeDispatcher = { async submit(session, prompt) { submissions.push([session, prompt]); }, async observe() { return "running"; } };
      const { repo, service } = setup(db, dispatcher);
      const normal = service.admit("user", "weave").run;
      await service.submit(service.claim(normal.id));
      expect(submissions).toEqual([[normal.sessionId, normal.promptId]]);
      const run = service.admit("user", "weave").run;
      const claim = service.claim(run.id);
      const saved = service.execute(claim, operation);
      expect(service.context(claim, { kind: "thought", id: "root" })).not.toBeNull();
      new RejectionService(new SqliteRejectionRepository(db)).rejectThought("user", "root");
      await expect(service.submit(claim)).rejects.toThrow(RunFenceError);
      expect(submissions).toEqual([[normal.sessionId, normal.promptId]]);
      expect(repo.get(run.id)?.status).toBe("interrupted");
      expect(repo.receipt(run.id, operation.id)).toEqual({ operation, result: saved });
      expect(new SqliteStore(db).getThought(saved.thought.id)).toEqual(saved.thought);
    });
  });

  test("late native submission acknowledgement cannot revive a stopped run", async () => {
    await withAsyncDb(async (_path, db) => {
      seed(db);
      let release: (() => void) | undefined;
      let entered: (() => void) | undefined;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      const dispatcher: NativeDispatcher = { async submit() { entered?.(); await pending; }, async observe() { return "running"; } };
      const { repo, service } = setup(db, dispatcher);
      const run = service.admit("user", "weave").run;
      const claim = service.claim(run.id);
      const submitting = service.submit(claim);
      try {
        await Promise.race([started, submitting.then(() => { throw new Error("Submission completed before acknowledgement release"); }), Bun.sleep(2000).then(() => { throw new Error("Submission did not start"); })]);
        service.stop("user", run.id);
        release?.();
        await expect(submitting).rejects.toThrow(RunFenceError);
        expect(repo.get(run.id)?.status).toBe("interrupted");
      } finally { release?.(); }
    });
  });

  test("completed native observation persists finalization handoff across reopen and repeated recovery", async () => {
    await withAsyncDb(async (path, db) => {
      seed(db);
      const observations: string[][] = [];
      const submissions: string[][] = [];
      const dispatcher: NativeDispatcher = { async submit(s, p) { submissions.push([s, p]); }, async observe(s, p) { observations.push([s, p]); return "completed"; } };
      const { repo, service } = setup(db, dispatcher);
      const run = service.admit("user", "weave").run;
      const claim = service.claim(run.id);
      const saved = service.execute(claim, operation);
      await service.submit(claim);
      repo.setStatus(claim, "uncertain");
      await service.recover(run.id);
      expect(repo.get(run.id)).toMatchObject({ nativeState: "completed", sessionId: run.sessionId, promptId: run.promptId });
      expect(repo.get(run.id)?.status).not.toBe("completed");
      const reopened = new Database(path);
      try {
        migrate(reopened);
        const restored = setup(reopened, dispatcher);
        expect(restored.repo.get(run.id)?.nativeState).toBe("completed");
        await restored.service.recover(run.id);
        expect(restored.repo.get(run.id)?.nativeState).toBe("completed");
        expect(submissions).toEqual([[run.sessionId, run.promptId]]);
        expect(observations.every(pair => pair[0] === run.sessionId && pair[1] === run.promptId)).toBe(true);
        const finishClaim = restored.service.claim(run.id);
        const response = { id: "recovered-reply", text: "existing response", role: "addendum", state: "complete", thoughtIds: [saved.thought.id] } as const;
        restored.service.finish(finishClaim, response);
        expect(restored.repo.get(run.id)?.status).toBe("completed");
        expect(new SqliteStore(reopened).getResponse(response.id)).toEqual(response);
        expect(restored.repo.receipt(run.id, operation.id)).toEqual({ operation, result: saved });
      } finally { reopened.close(); }
    });
  });

  test("rejected exposed thoughts, connections and mixed shared responses fence late writes", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const rejection = new RejectionService(new SqliteRejectionRepository(db));
    const cases = [
      { ref: { kind: "thought", id: "root" } as const, reject: () => rejection.rejectThought("user", "root") },
      { ref: { kind: "connection", id: "link" } as const, reject: () => rejection.rejectConnection("user", "link") },
      { ref: { kind: "response", id: "shared" } as const, reject: () => rejection.rejectThought("user", "other") },
    ];
    for (const entry of cases) {
      const claim = service.claim(service.admit("user", "weave").run.id);
      expect(service.context(claim, entry.ref)).not.toBeNull();
      expect(repo.contextRefs(claim.runId)).toEqual([entry.ref]);
      entry.reject();
      expect(() => service.execute(claim, operation)).toThrow(RunFenceError);
      expect(repo.receipt(claim.runId, operation.id)).toBeNull();
      expect(service.context(claim, entry.ref)).toBeNull();
      if (entry.ref.kind === "thought") rejection.restoreThought("user", "root");
      if (entry.ref.kind === "connection") rejection.restoreConnection("user", "link");
      if (entry.ref.kind === "response") rejection.restoreThought("user", "other");
    }
  }));

  test("claim generation fences stale owners, including terminal publication and receipt replay", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const run = service.admit("user", "weave").run;
    const first = service.claim(run.id);
    const saved = service.execute(first, operation);
    const second = service.claim(run.id);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(() => service.execute(first, operation)).toThrow(RunFenceError);
    expect(() => service.finish(first, { id: "late", text: "late", role: "addendum", state: "complete", thoughtIds: [saved.thought.id] })).toThrow(RunFenceError);
    expect(new SqliteStore(db).getResponse("late")).toBeNull();
    expect(repo.receipt(run.id, operation.id)).toEqual({ operation, result: saved });
    const response = { id: "final", text: "completed", role: "addendum", state: "complete", thoughtIds: [saved.thought.id] } as const;
    service.finish(second, response);
    expect(repo.get(run.id)?.status).toBe("completed");
    expect(new SqliteStore(db).getResponse("final")).toEqual(response);
  }));

  test("rejected context prevents cached replay while trusted receipt and saved work remain", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const claim = service.claim(service.admit("user", "weave").run.id);
    expect(service.context(claim, { kind: "thought", id: "root" })).not.toBeNull();
    const saved = service.execute(claim, operation);
    new RejectionService(new SqliteRejectionRepository(db)).rejectThought("user", "root");
    expect(() => service.execute(claim, operation)).toThrow(RunFenceError);
    expect(repo.receipt(claim.runId, operation.id)).toEqual({ operation, result: saved });
    expect(new SqliteStore(db).getThought(saved.thought.id)).toEqual(saved.thought);
  }));

  test("terminal response and final status roll back together if finalization fails", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const claim = service.claim(service.admit("user", "weave").run.id);
    const saved = service.execute(claim, operation);
    const response = { id: "final-fault", text: "final response", role: "addendum", state: "complete", thoughtIds: [saved.thought.id] } as const;
    db.exec("CREATE TRIGGER test_final_failure BEFORE UPDATE ON runs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'test final failure'); END;");
    expect(() => service.finish(claim, response)).toThrow(/test final failure/);
    expect(new SqliteStore(db).getResponse(response.id)).toBeNull();
    expect(repo.get(claim.runId)?.status).not.toBe("completed");
    expect(repo.receipt(claim.runId, operation.id)).toEqual({ operation, result: saved });
    db.exec("DROP TRIGGER test_final_failure");
    service.finish(claim, response);
    expect(new SqliteStore(db).getResponse(response.id)).toEqual(response);
    expect(repo.get(claim.runId)?.status).toBe("completed");
  }));

  test("export authority is durable and cannot dispatch writes", () => withDb((_path, db) => {
    seed(db);
    const { repo, service } = setup(db);
    const run = service.admit("user", "export").run;
    const claim = service.claim(run.id);
    expect(() => service.execute(claim, operation)).toThrow(RunForbiddenError);
    expect(repo.receipt(run.id, operation.id)).toBeNull();
    expect(() => db.run("UPDATE runs SET kind='weave' WHERE id=?", [run.id])).toThrow(/immutable/i);
    expect(repo.get(run.id)?.kind).toBe("export");
  }));
});
