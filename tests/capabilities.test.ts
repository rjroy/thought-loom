import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityRequest, CapabilityResult } from "../src/domain/capability";
import { RejectionService } from "../src/domain/rejection";
import { RunConflictError, RunFenceError, RunForbiddenError, RunService, type NativeDispatcher } from "../src/domain/run";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const now = () => "2030-01-01T00:00:00.000Z";
const native: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
const search: CapabilityRequest = { capability: "search", arguments: { query: "zircon" } };
const read = (id: string): CapabilityRequest => ({ capability: "readThought", arguments: { id } });
const connect: CapabilityRequest = { capability: "connection", arguments: { fromId: "subject", toId: "candidate", category: "supports", explanation: "A supported relation", sourceIds: ["subject"] } };

function fixture(action: (value: { db: Database; service: RunService; runs: SqliteRunRepository; steps: SqliteRunProtocolRepository; ops: SqliteRunOperations; dispatcher: SqliteCapabilityDispatcher; rejection: RejectionService; store: SqliteStore }) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "capability-witness-"));
  const db = new Database(join(dir, "owned.sqlite"));
  try {
    migrate(db);
    const store = new SqliteStore(db);
    store.saveThought({ id: "subject", text: "Subject thought", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
    store.saveThought({ id: "hidden", text: "hidden parent text", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
    store.saveThought({ id: "candidate", text: "zircon candidate recorded text", title: "Candidate label", author: "ai", kind: "developing-idea", createdAt: now(), origin: "fixture", parentId: "hidden", sourceIds: ["hidden", "subject"] });
    store.saveThought({ id: "source", text: "Another visible thought", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
    store.saveConnection({ id: "existing-link", fromId: "subject", toId: "candidate", category: "related", proposedBy: "ai", explanation: "visible connection", sourceIds: ["subject"] });
    store.saveResponse({ id: "shared", text: "private shared reply", role: "addendum", state: "complete", thoughtIds: ["candidate", "source"] });
    let sequence = 0;
    const id = () => `generated-${++sequence}`;
    const runs = new SqliteRunRepository(db, { id, now });
    const service = new RunService({ repository: runs, dispatcher: native, id, now });
    const steps = new SqliteRunProtocolRepository(db);
    const ops = new SqliteRunOperations(db, { id, now });
    const dispatcher = new SqliteCapabilityDispatcher(db, { id, now });
    const rejection = new RejectionService(new SqliteRejectionRepository(db));
    action({ db, service, runs, steps, ops, dispatcher, rejection, store });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function start(value: Parameters<Parameters<typeof fixture>[0]>[0], kind: "weave" | "export" = "weave") {
  const run = kind === "weave" ? value.ops.admitWeave("user", { subjectId: "subject", triggerId: "fixture-trigger" }) : value.service.admit("user", "export").run;
  const claim = value.service.claim(run.id);
  value.steps.prepare(claim, { promptId: run.promptId, input: "test-owned initial context" });
  let promptId = run.promptId;
  let sequence = 0;
  const complete = (request: CapabilityRequest) => value.steps.completeStep(claim, promptId, { version: 1, kind: "request", request });
  const dispatch = (request: CapabilityRequest): CapabilityResult => value.dispatcher.dispatch(claim, promptId, request);
  const advance = (result: CapabilityResult) => {
    const next = { promptId: `next-${run.id}-${++sequence}`, input: JSON.stringify(result) };
    value.steps.advance(claim, promptId, result, next);
    promptId = next.promptId;
  };
  const invoke = (request: CapabilityRequest) => { complete(request); const result = dispatch(request); advance(result); return result; };
  return { run, claim, complete, dispatch, advance, invoke, current: () => promptId };
}

describe("run-scoped capabilities and durable witnesses", () => {
  test("search candidates are scoped and tracked but never authorize a connection alone", () => fixture(value => {
    value.rejection.rejectThought("user", "hidden");
    const run = start(value);
    const result = run.invoke(search);
    expect(result.type).toBe("search");
    if (result.type !== "search") throw new Error("Expected search result");
    expect(result.candidates).toEqual([{ kind: "thought", id: "candidate", thoughtId: "candidate", title: "Candidate label", author: "ai", snippet: "zircon candidate recorded text" }]);
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(value.runs.contextRefs(run.run.id)).toContainEqual({ kind: "thought", id: "candidate" });
    expect(value.dispatcher.fullReadWitnesses(run.run.id)).not.toContainEqual({ kind: "thought", id: "candidate" });
    run.complete(connect);
    expect(() => run.dispatch(connect)).toThrow(RunForbiddenError);
    expect(value.ops.stepReceipt(run.run.id, run.current())).toBeNull();
    expect(value.db.query("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 1 });
  }));

  test("full reads persist witness evidence and enable a scoped connection with step-derived receipt", () => fixture(value => {
    value.rejection.rejectThought("user", "hidden");
    const run = start(value);
    run.invoke(search);
    const candidate = run.invoke(read("candidate"));
    expect(candidate.type).toBe("thought");
    if (candidate.type !== "thought" || !candidate.thought) throw new Error("Expected visible thought");
    expect(candidate.thought.parentId).toBeNull();
    expect(candidate.thought.sourceIds).toEqual(["subject"]);
    expect(JSON.stringify(candidate)).not.toContain("hidden");
    run.invoke(read("subject"));
    expect(value.dispatcher.fullReadWitnesses(run.run.id)).toContainEqual({ kind: "thought", id: "candidate" });
    expect(value.dispatcher.fullReadWitnesses(run.run.id)).toContainEqual({ kind: "thought", id: "subject" });
    expect(value.runs.contextRefs(run.run.id)).toContainEqual({ kind: "thought", id: "subject" });
    run.complete(connect);
    const promptId = run.current();
    const result = run.dispatch(connect);
    expect(result.type).toBe("connection");
    if (result.type !== "connection") throw new Error("Expected connection result");
    expect(result.connection).toMatchObject({ fromId: "subject", toId: "candidate", category: "supports", proposedBy: "ai", sourceIds: ["subject"] });
    expect(value.ops.stepReceipt(run.run.id, promptId)).toEqual({ operation: { type: "connection", ...connect.arguments }, result });
    expect(value.dispatcher.dispatch(run.claim, promptId, connect)).toEqual(result);
    expect(value.db.query("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 2 });
    const dbPath = value.db.filename;
    const reopened = new Database(dbPath);
    try {
      migrate(reopened);
      const restored = new SqliteCapabilityDispatcher(reopened, { id: () => "unused", now });
      expect(restored.fullReadWitnesses(run.run.id)).toContainEqual({ kind: "thought", id: "candidate" });
      expect(restored.fullReadWitnesses(run.run.id)).toContainEqual({ kind: "thought", id: "subject" });
    } finally { reopened.close(); }
  }));

  test("reading both endpoints does not substitute for a full supporting-source read", () => fixture(value => {
    const run = start(value);
    run.invoke(read("subject"));
    run.invoke(read("candidate"));
    const proposal: CapabilityRequest = { capability: "connection", arguments: { ...connect.arguments, sourceIds: ["source"] } };
    run.complete(proposal);
    expect(() => run.dispatch(proposal)).toThrow(RunForbiddenError);
    expect(value.ops.stepReceipt(run.run.id, run.current())).toBeNull();
    expect(value.db.query("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 1 });
  }));

  test("full response exposure tracks every association and fences cached delivery after rejection", () => fixture(value => {
    const run = start(value);
    const request: CapabilityRequest = { capability: "readResponse", arguments: { id: "shared" } };
    run.complete(request);
    const result = run.dispatch(request);
    expect(result).toEqual({ type: "response", response: { id: "shared", text: "private shared reply", role: "addendum", state: "complete", thoughtIds: ["candidate", "source"] } });
    for (const ref of [{ kind: "response", id: "shared" }, { kind: "thought", id: "candidate" }, { kind: "thought", id: "source" }] as const) expect(value.runs.contextRefs(run.run.id)).toContainEqual(ref);
    value.rejection.rejectThought("user", "source");
    expect(() => run.dispatch(request)).toThrow(RunFenceError);
    expect(() => run.advance(result)).toThrow(RunFenceError);
    expect(value.runs.get(run.run.id)?.status).toBe("interrupted");
    expect(value.store.getResponse("shared")?.text).toBe("private shared reply");
  }));

  test("a reply with any rejected owner is not indirectly exposed by search or read", () => fixture(value => {
    value.rejection.rejectThought("user", "source");
    const run = start(value);
    const found = run.invoke({ capability: "search", arguments: { query: "shared" } });
    expect(found).toEqual({ type: "search", candidates: [] });
    const response = run.invoke({ capability: "readResponse", arguments: { id: "shared" } });
    expect(response).toEqual({ type: "response", response: null });
    expect(value.runs.contextRefs(run.run.id)).not.toContainEqual({ kind: "response", id: "shared" });
    expect(value.dispatcher.fullReadWitnesses(run.run.id)).not.toContainEqual({ kind: "response", id: "shared" });
  }));

  test("connection reads record the exposed link and source IDs; Stop fences replay", () => fixture(value => {
    const run = start(value);
    const request: CapabilityRequest = { capability: "readConnection", arguments: { id: "existing-link" } };
    run.complete(request);
    const result = run.dispatch(request);
    expect(result.type).toBe("connection-read");
    expect(value.runs.contextRefs(run.run.id)).toEqual(expect.arrayContaining([{ kind: "connection", id: "existing-link" }, { kind: "thought", id: "subject" }, { kind: "thought", id: "candidate" }]));
    const reopened = new Database(value.db.filename);
    try {
      migrate(reopened);
      const recovered = new SqliteCapabilityDispatcher(reopened, { id: () => "unused", now });
      expect(recovered.dispatch(run.claim, run.current(), request)).toEqual(result);
      expect(recovered.fullReadWitnesses(run.run.id)).toContainEqual({ kind: "connection", id: "existing-link" });
    } finally { reopened.close(); }
    value.service.stop("user", run.run.id);
    expect(() => run.dispatch(request)).toThrow(RunFenceError);
    expect(() => run.advance(result)).toThrow(RunFenceError);
  }));

  test("failed witness recording cannot publish read results", () => fixture(value => {
    const run = start(value);
    const request = read("candidate");
    run.complete(request);
    value.db.exec("CREATE TRIGGER test_context_fault BEFORE INSERT ON run_context WHEN NEW.ref_id='candidate' BEGIN SELECT RAISE(ABORT,'test witness persistence fault'); END;");
    expect(() => run.dispatch(request)).toThrow(/test witness persistence fault/);
    expect(value.runs.contextRefs(run.run.id)).not.toContainEqual({ kind: "thought", id: "candidate" });
    expect(value.dispatcher.fullReadWitnesses(run.run.id)).not.toContainEqual({ kind: "thought", id: "candidate" });
  }));

  test("failure caching a dispatched write rolls back effect, receipt, membership and exposure together", () => fixture(value => {
    const run = start(value);
    run.invoke(read("subject"));
    const request: CapabilityRequest = { capability: "interpretation", arguments: { text: "atomic cache interpretation", sourceIds: [] } };
    run.complete(request);
    const promptId = run.current();
    const beforeContext = value.runs.contextRefs(run.run.id);
    const beforeThoughts = value.db.query("SELECT COUNT(*) AS n FROM thoughts").get();
    value.db.exec(`CREATE TRIGGER test_final_cache_fault BEFORE UPDATE OF result_json ON run_steps
      WHEN NEW.prompt_id='${promptId}' AND NEW.result_json IS NOT NULL
        AND EXISTS (SELECT 1 FROM run_operation_receipts WHERE run_id=NEW.run_id AND operation_id=NEW.prompt_id)
        AND EXISTS (SELECT 1 FROM run_issued_thoughts i JOIN run_context c ON c.run_id=i.run_id AND c.kind='thought' AND c.ref_id=i.thought_id
          JOIN thoughts t ON t.id=i.thought_id WHERE i.run_id=NEW.run_id AND i.operation_id=NEW.prompt_id AND t.text='atomic cache interpretation')
      BEGIN SELECT RAISE(ABORT,'test final result cache fault'); END;`);
    expect(() => run.dispatch(request)).toThrow(/test final result cache fault/);
    expect(value.db.query("SELECT COUNT(*) AS n FROM thoughts").get()).toEqual(beforeThoughts);
    expect(value.db.query("SELECT COUNT(*) AS n FROM run_operation_receipts WHERE run_id=? AND operation_id=?").get(run.run.id, promptId)).toEqual({ n: 0 });
    expect(value.db.query("SELECT COUNT(*) AS n FROM run_issued_thoughts WHERE run_id=? AND operation_id=?").get(run.run.id, promptId)).toEqual({ n: 0 });
    expect(value.runs.contextRefs(run.run.id)).toEqual(beforeContext);
    expect(value.ops.stepReceipt(run.run.id, promptId)).toBeNull();
    expect(value.steps.steps(run.run.id).at(-1)).toMatchObject({ promptId, state: "completed", result: null });
    value.db.exec("DROP TRIGGER test_final_cache_fault");
    const result = run.dispatch(request);
    if (result.type !== "interpretation") throw new Error("Expected interpretation result");
    expect(result.thought.text).toBe("atomic cache interpretation");
    expect(value.ops.stepReceipt(run.run.id, promptId)).toEqual({ operation: { type: "interpretation", text: "atomic cache interpretation", sourceIds: [] }, result });
    expect(value.runs.contextRefs(run.run.id)).toContainEqual({ kind: "thought", id: result.thought.id });
    expect(value.steps.steps(run.run.id).at(-1)).toMatchObject({ state: "completed", result });
    expect(run.dispatch(request)).toEqual(result);
    expect(value.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE text='atomic cache interpretation'").get()).toEqual({ n: 1 });
    expect(value.db.query("SELECT COUNT(*) AS n FROM run_operation_receipts WHERE run_id=? AND operation_id=?").get(run.run.id, promptId)).toEqual({ n: 1 });
    expect(value.db.query("SELECT COUNT(*) AS n FROM run_issued_thoughts WHERE run_id=? AND operation_id=?").get(run.run.id, promptId)).toEqual({ n: 1 });
  }));

  test("export run has scoped reads but no knowledge-write authority", () => fixture(value => {
    const run = start(value, "export");
    expect(run.invoke(search).type).toBe("search");
    expect(run.invoke(read("subject")).type).toBe("thought");
    run.complete(connect);
    expect(() => run.dispatch(connect)).toThrow(RunForbiddenError);
    expect(value.ops.stepReceipt(run.run.id, run.current())).toBeNull();
  }));

  test("unknown or malformed model proposals cannot choose authority or write", () => fixture(value => {
    const run = start(value);
    run.complete(read("subject"));
    for (const invalid of [
      { capability: "rejectThought", arguments: { id: "subject" } },
      { capability: "restoreThought", arguments: { id: "subject" } },
      { capability: "capture", arguments: { text: "forged user" } },
      { capability: "readFile", arguments: { path: "/private" } },
      { capability: "readThought", arguments: { id: "subject", actor: "user" } },
      { capability: "readThought", arguments: { id: 42 } },
      { capability: "readThought", arguments: { id: "subject", runId: "other" } },
      { capability: "readThought", arguments: { id: "subject", operationId: "forged" } },
      { capability: "readThought", arguments: { id: "subject", credentials: "forged-user-token" } },
    ]) {
      let failure: unknown;
      try { value.dispatcher.dispatch(run.claim, run.current(), invalid); } catch (error) { failure = error; }
      expect(failure instanceof RunForbiddenError || failure instanceof RunConflictError).toBe(true);
    }
    expect(value.runs.contextRefs(run.run.id)).toEqual([]);
    expect(value.ops.stepReceipt(run.run.id, run.current())).toBeNull();
  }));

  test("Evolve development stays parented to its admitted contribution", () => fixture(value => {
    const admission = value.service.admit("user", "evolve", { parentId: "subject", text: "user question" });
    if (!admission.contribution) throw new Error("Expected admitted contribution");
    const claim = value.service.claim(admission.run.id);
    value.steps.prepare(claim, { promptId: admission.run.promptId, input: "evolve context" });
    const request: CapabilityRequest = { capability: "development", arguments: { parentId: "subject", text: "forged parent", sourceIds: [] } };
    value.steps.completeStep(claim, admission.run.promptId, { version: 1, kind: "request", request });
    expect(() => value.dispatcher.dispatch(claim, admission.run.promptId, request)).toThrow(RunConflictError);
    expect(value.ops.stepReceipt(admission.run.id, admission.run.promptId)).toBeNull();
    expect(value.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE text='forged parent'").get()).toEqual({ n: 0 });
  }));

  test("complete write proposal rejects model-supplied identity, time and authorship", () => fixture(value => {
    const run = start(value);
    const forged = { capability: "interpretation", arguments: { text: "forged", sourceIds: [], id: "chosen", createdAt: "2000", author: "user" } };
    value.steps.completeStep(run.claim, run.current(), { version: 1, kind: "request", request: forged });
    expect(() => value.dispatcher.dispatch(run.claim, run.current(), forged)).toThrow(RunConflictError);
    expect(value.ops.stepReceipt(run.run.id, run.current())).toBeNull();
    expect(value.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE text='forged'").get()).toEqual({ n: 0 });
  }));
});
