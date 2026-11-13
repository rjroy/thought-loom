import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RejectionService } from "../src/domain/rejection";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, RunService, type NativeDispatcher } from "../src/domain/run";
import type { StepOperation } from "../src/domain/run-operations";
import { parseEnvelope, ProtocolValidationError } from "../src/domain/run-protocol";
import { TitleService } from "../src/domain/title";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";

const now = () => "2031-02-03T04:05:06.000Z";
const dispatcher: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
const intent = { subjectId: "subject", triggerId: "test-trigger" };
function fixture(action: (ctx: { db: Database; path: string; store: SqliteStore; runs: SqliteRunRepository; service: RunService; steps: SqliteRunProtocolRepository; ops: SqliteRunOperations; rejection: RejectionService; title: TitleService }) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "run-typed-operations-"));
  const path = join(dir, "fixture.sqlite");
  const db = new Database(path);
  try {
    migrate(db);
    const store = new SqliteStore(db);
    store.saveThought({ id: "subject", text: "source text", title: "Human title", author: "user", kind: "captured-original", createdAt: "2020", origin: "fixture", parentId: null, sourceIds: [] });
    store.saveThought({ id: "target", text: "other thinking", title: null, author: "user", kind: "captured-original", createdAt: "2021", origin: "fixture", parentId: null, sourceIds: [] });
    let sequence = 0;
    const id = () => `issued-${++sequence}`;
    const runs = new SqliteRunRepository(db, { id, now });
    const service = new RunService({ repository: runs, dispatcher, id, now });
    const steps = new SqliteRunProtocolRepository(db);
    const ops = new SqliteRunOperations(db, { id, now });
    const rejection = new RejectionService(new SqliteRejectionRepository(db));
    const title = new TitleService(new SqliteTitleRepository(db));
    action({ db, path, store, runs, service, steps, ops, rejection, title });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function proposal(operation: StepOperation) {
  const { type, ...arguments_ } = operation;
  return { version: 1, kind: "request", request: { capability: type, arguments: arguments_ } } as const;
}

describe("typed operations on durable run aggregate", () => {
  test("Evolve title fill targets only its admitted contribution and retains CAS, receipt and Stop guards", () => fixture(({ service, steps, ops, store, title }) => {
    const admission = service.admit("user", "evolve", { parentId: "subject", text: "user contribution" });
    if (!admission.contribution) throw new Error("Expected contribution");
    const claim = service.claim(admission.run.id);
    const fill: StepOperation = { type: "title-fill", title: "AI label" };
    steps.prepare(claim, { promptId: admission.run.promptId, input: "context" });
    steps.completeStep(claim, admission.run.promptId, proposal(fill));
    expect(() => ops.executeStep(claim, admission.run.promptId, { ...fill, subjectId: "target" } as StepOperation)).toThrow(RunConflictError);
    title.setUser("user", admission.contribution.id, "User label");
    const result = ops.executeStep(claim, admission.run.promptId, fill);
    expect(result).toEqual({ type: "title-fill", status: "unchanged" });
    expect(store.getThought(admission.contribution.id)).toMatchObject({ title: "User label", titleAuthor: "user" });
    expect(store.getThought("subject")?.title).toBe("Human title");
    expect(store.getThought("target")?.title).toBeNull();
    title.setUser("user", admission.contribution.id, null);
    expect(ops.executeStep(claim, admission.run.promptId, fill)).toEqual(result);
    expect(store.getThought(admission.contribution.id)?.title).toBeNull();
    expect(ops.stepReceipt(admission.run.id, admission.run.promptId)).toEqual({ operation: fill, result });
    service.stop("user", admission.run.id);
    expect(() => ops.executeStep(claim, admission.run.promptId, fill)).toThrow(RunFenceError);
  }));

  test("rejecting an Evolve contribution fences its pending title fill", () => fixture(({ service, steps, ops, rejection, store }) => {
    const admission = service.admit("user", "evolve", { parentId: "subject", text: "rejected contribution" });
    if (!admission.contribution) throw new Error("Expected contribution");
    const claim = service.claim(admission.run.id);
    const fill: StepOperation = { type: "title-fill", title: "Must not save" };
    steps.prepare(claim, { promptId: admission.run.promptId, input: "context" });
    expect(service.context(claim, { kind: "thought", id: admission.contribution.id })).not.toBeNull();
    steps.completeStep(claim, admission.run.promptId, proposal(fill));
    rejection.rejectThought("user", admission.contribution.id);
    expect(() => ops.executeStep(claim, admission.run.promptId, fill)).toThrow(RunFenceError);
    expect(store.getThought(admission.contribution.id)?.title).toBeNull();
    expect(ops.stepReceipt(admission.run.id, admission.run.promptId)).toBeNull();
  }));

  test("persists weave intent and step-derived title no-op, interpretation and connection receipts", () => fixture(({ db, path, store, runs, service, steps, ops, title }) => {
    const run = ops.admitWeave("user", intent);
    expect(ops.weaveIntent(run.id)).toEqual(intent);
    const claim = service.claim(run.id);
    steps.prepare(claim, { promptId: run.promptId, input: "initial context" });
    const noTitle: StepOperation = { type: "title-fill", title: "Late AI title" };
    steps.completeStep(claim, run.promptId, proposal(noTitle));
    const noOp = ops.executeStep(claim, run.promptId, noTitle);
    expect(noOp).toEqual({ type: "title-fill", status: "unchanged" });
    expect(ops.stepReceipt(run.id, run.promptId)).toEqual({ operation: noTitle, result: noOp });
    expect(store.getThought("subject")?.title).toBe("Human title");
    title.setUser("user", "subject", null);
    expect(ops.executeStep(claim, run.promptId, noTitle)).toEqual(noOp);
    expect(store.getThought("subject")).toMatchObject({ title: null, titleAuthor: null });
    expect(() => ops.executeStep(claim, run.promptId, { type: "title-fill", title: "different proposal" })).toThrow(RunConflictError);
    const second = steps.advance(claim, run.promptId, noOp, { promptId: "prompt-interpretation", input: "title outcome" });
    const interpretation: StepOperation = { type: "interpretation", text: "an AI interpretation", sourceIds: ["target"] };
    steps.completeStep(claim, second.promptId, proposal(interpretation));
    const interpreted = ops.executeStep(claim, second.promptId, interpretation);
    expect(interpreted.type).toBe("interpretation");
    if (interpreted.type !== "interpretation") throw new Error("Expected interpretation result");
    expect(interpreted.thought.id).toMatch(/^issued-\d+$/);
    expect(interpreted.thought).toEqual({ id: interpreted.thought.id, text: "an AI interpretation", title: null, titleAuthor: null, author: "ai", kind: "ai-interpretation", createdAt: now(), origin: "weave", parentId: "subject", sourceIds: ["target"] });
    expect(store.getThought(interpreted.thought.id)).toEqual(interpreted.thought);
    const third = steps.advance(claim, second.promptId, interpreted, { promptId: "prompt-connection", input: "interpretation outcome" });
    const connection: StepOperation = { type: "connection", fromId: "subject", toId: "target", category: "supports", explanation: "supporting evidence", sourceIds: ["subject"] };
    // This aggregate fixture supplies a trusted initial read; unlike dispatcher fixtures it does not render/read model context.
    for (const id of ["subject","target"]) db.run("INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES (?,'thought',?,1) ON CONFLICT(run_id,kind,ref_id) DO UPDATE SET full_read=1",[run.id,id]);
    steps.completeStep(claim, third.promptId, proposal(connection));
    const linked = ops.executeStep(claim, third.promptId, connection);
    expect(linked.type).toBe("connection");
    if (linked.type !== "connection" || linked.status !== "created") throw new Error("Expected created connection result");
    expect(linked.connection.id).toMatch(/^issued-\d+$/);
    expect(linked.connection).toEqual({ id: linked.connection.id, fromId: "subject", toId: "target", category: "supports", explanation: "supporting evidence", sourceIds: ["subject"], proposedBy: "ai" });
    expect(store.getConnection(linked.connection.id)).toEqual(linked.connection);
    expect(ops.stepReceipt(run.id, third.promptId)).toEqual({ operation: connection, result: linked });
    expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual({ n: 3 });
    expect(db.query("SELECT thought_id AS id,position FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(run.id)).toEqual([{ id: interpreted.thought.id, position: 0 }]);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      const restored = new SqliteRunOperations(reopened, { id: () => "unused", now });
      expect(restored.weaveIntent(run.id)).toEqual(intent);
      expect(restored.stepReceipt(run.id, run.promptId)).toEqual({ operation: noTitle, result: noOp });
      expect(restored.stepReceipt(run.id, third.promptId)).toEqual({ operation: connection, result: linked });
      expect(new SqliteRunRepository(reopened, { id: () => "unused", now }).get(run.id)?.kind).toBe("weave");
    } finally { reopened.close(); }
    expect(runs.reply(run.id)).toBeNull();
  }));

  test("receipt failure rolls back interpretation and issued membership; retry commits once", () => fixture(({ db, store, service, steps, ops }) => {
    const run = ops.admitWeave("user", intent);
    const claim = service.claim(run.id);
    const interpretation: StepOperation = { type: "interpretation", text: "rollback interpretation", sourceIds: [] };
    steps.prepare(claim, { promptId: run.promptId, input: "context" });
    steps.completeStep(claim, run.promptId, proposal(interpretation));
    const before = db.query("SELECT COUNT(*) AS n FROM thoughts").get();
    db.exec("CREATE TRIGGER test_typed_receipt_failure AFTER INSERT ON run_operation_receipts BEGIN SELECT RAISE(ABORT,'typed receipt fault'); END;");
    expect(() => ops.executeStep(claim, run.promptId, interpretation)).toThrow(/typed receipt fault/);
    expect(db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM run_issued_thoughts WHERE run_id=?").get(run.id)).toEqual({ n: 0 });
    expect(ops.stepReceipt(run.id, run.promptId)).toBeNull();
    db.exec("DROP TRIGGER test_typed_receipt_failure");
    const result = ops.executeStep(claim, run.promptId, interpretation);
    expect(result.type).toBe("interpretation");
    if (result.type !== "interpretation") throw new Error("Expected interpretation result");
    expect(store.getThought(result.thought.id)).toEqual(result.thought);
    expect(ops.executeStep(claim, run.promptId, interpretation)).toEqual(result);
    expect(db.query("SELECT COUNT(*) AS n FROM run_issued_thoughts WHERE run_id=?").get(run.id)).toEqual({ n: 1 });
  }));

  test("rejected connection sources and context fence writes and no model-supplied identity is accepted", () => fixture(({ db, service, steps, ops, rejection }) => {
    const run = ops.admitWeave("user", intent);
    const claim = service.claim(run.id);
    const connection: StepOperation = { type: "connection", fromId: "subject", toId: "target", category: "related", explanation: "reason", sourceIds: ["target"] };
    steps.prepare(claim, { promptId: run.promptId, input: "context" });
    steps.completeStep(claim, run.promptId, proposal(connection));
    rejection.rejectThought("user", "target");
    expect(() => ops.executeStep(claim, run.promptId, connection)).toThrow(RunNotFoundError);
    expect(ops.stepReceipt(run.id, run.promptId)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 0 });
    rejection.restoreThought("user", "target");
    const forged = { ...connection, id: "model-chosen-id" };
    expect(() => ops.executeStep(claim, run.promptId, forged)).toThrow(RunConflictError);
    expect(ops.stepReceipt(run.id, run.promptId)).toBeNull();
  }));

  test("export authority denies every typed knowledge operation", () => fixture(({ service, ops }) => {
    const run = service.admit("user", "export").run;
    const claim = service.claim(run.id);
    const operations: StepOperation[] = [
      { type: "development", parentId: "subject", text: "x", sourceIds: [] },
      { type: "interpretation", text: "x", sourceIds: [] },
      { type: "title-fill", title: "x" },
      { type: "connection", fromId: "subject", toId: "target", category: "related", explanation: "x", sourceIds: [] },
    ];
    for (const operation of operations) expect(() => ops.executeStep(claim, run.promptId, operation)).toThrow(RunForbiddenError);
    expect(ops.stepReceipt(run.id, run.promptId)).toBeNull();
  }));

  test("no-findings weave retains its outcome and guarded failure retains confirmed work", () => fixture(({ db, service, runs, steps, ops, store, rejection }) => {
    const empty = ops.admitWeave("user", { ...intent, triggerId: "empty-pass" });
    const emptyClaim = service.claim(empty.id);
    steps.prepare(emptyClaim, { promptId: empty.promptId, input: "context" });
    steps.completeStep(emptyClaim, empty.promptId, { version: 1, kind: "complete", reply: "No findings" });
    ops.completeWeave(emptyClaim, empty.promptId);
    expect(runs.get(empty.id)?.status).toBe("completed");
    expect(runs.reply(empty.id)).toMatchObject({ text: "No findings", state: "complete", thoughtIds: ["subject"] });
    const filled = ops.admitWeave("user", { ...intent, triggerId: "filled-pass" });
    const claim = service.claim(filled.id);
    const interpretation: StepOperation = { type: "interpretation", text: "confirmed work", sourceIds: [] };
    steps.prepare(claim, { promptId: filled.promptId, input: "context" });
    steps.completeStep(claim, filled.promptId, proposal(interpretation));
    const result = ops.executeStep(claim, filled.promptId, interpretation);
    if (result.type !== "interpretation") throw new Error("Expected interpretation result");
    ops.fail(claim);
    expect(runs.get(filled.id)?.status).toBe("failed");
    expect(store.getThought(result.thought.id)).toEqual(result.thought);
    expect(ops.stepReceipt(filled.id, filled.promptId)).toEqual({ operation: interpretation, result });
    expect(() => ops.executeStep(claim, filled.promptId, interpretation)).toThrow(RunFenceError);
    expect(db.query("SELECT COUNT(*) AS n FROM responses").get()).toEqual({ n: 1 });
    const guarded = ops.admitWeave("user", { ...intent, triggerId: "guarded-pass" });
    expect(steps.cancellation(filled.id)).toBe("pending");
    expect(() => service.claim(guarded.id)).toThrow();
    // The controlled completed native step above supplies the journal proof; emulate its trusted cleanup settlement.
    expect(steps.steps(filled.id)).toEqual([expect.objectContaining({ state: "completed", input: "context" })]);
    steps.settleCancellation(filled.id);
    const guardedClaim = service.claim(guarded.id);
    expect(service.context(guardedClaim, { kind: "thought", id: "subject" })).not.toBeNull();
    rejection.rejectThought("user", "subject");
    expect(() => ops.fail(guardedClaim)).toThrow(RunFenceError);
    expect(runs.get(guarded.id)?.status).toBe("interrupted");
    expect(store.getThought(result.thought.id)).toEqual(result.thought);
  }));

  test("title-only weave retains an outcome without fabricating a thought", () => fixture(({ db, service, runs, steps, ops, title, store }) => {
    title.setUser("user", "subject", null);
    const run = ops.admitWeave("user", intent);
    const claim = service.claim(run.id);
    const fill: StepOperation = { type: "title-fill", title: "Generated label" };
    steps.prepare(claim, { promptId: run.promptId, input: "context" });
    steps.completeStep(claim, run.promptId, proposal(fill));
    const outcome = ops.executeStep(claim, run.promptId, fill);
    expect(outcome).toEqual({ type: "title-fill", status: "filled" });
    expect(store.getThought("subject")).toMatchObject({ title: "Generated label", titleAuthor: "ai", text: "source text", author: "user" });
    const next = steps.advance(claim, run.promptId, outcome, { promptId: "title-only-completion", input: "title accepted" });
    steps.completeStep(claim, next.promptId, { version: 1, kind: "complete", reply: "No further findings" });
    ops.completeWeave(claim, next.promptId);
    expect(runs.get(run.id)?.status).toBe("completed");
    expect(runs.reply(run.id)).toMatchObject({ text: "No further findings", state: "complete", thoughtIds: ["subject"] });
    expect(db.query("SELECT COUNT(*) AS n FROM run_issued_thoughts WHERE run_id=?").get(run.id)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM responses").get()).toEqual({ n: 1 });
  }));

  test("malformed model output cannot become fallback; an explicit final Evolve reply uses the input once", () => fixture(({ service, runs, steps, store }) => {
    const admission = service.admit("user", "evolve", { parentId: "subject", text: "user question" });
    if (!admission.contribution) throw new Error("Expected contribution");
    const claim = service.claim(admission.run.id);
    steps.prepare(claim, { promptId: admission.run.promptId, input: "context" });
    expect(() => parseEnvelope('{"version":1,"kind":"complete","reply":"truncated')).toThrow(ProtocolValidationError);
    expect(runs.reply(admission.run.id)).toBeNull();
    steps.completeStep(claim, admission.run.promptId, { version: 1, kind: "complete", reply: "final human-facing reply" });
    const response = { id: "reply", role: "fallback", state: "complete", text: "final human-facing reply", thoughtIds: [admission.contribution.id] } as const;
    service.finish(claim, response);
    expect(runs.reply(admission.run.id)).toEqual(response);
    expect(store.getResponse("reply")).toEqual(response);
  }));
});
