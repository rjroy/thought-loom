import { describe, expect, test } from "bun:test";
import { capabilityResultPrompt, initialWorkerPrompt } from "../src/agent/worker-prompts";
import { readCapabilityResult, type CapabilityRequest, type ReadCapabilityRequest } from "../src/domain/capability";
import { RunFenceError, RunForbiddenError } from "../src/domain/run";
import { stepOperationEnvelope, type StepOperation, type StepOperationResult } from "../src/domain/run-operations";
import { protocolJson } from "../src/domain/run-protocol";
import type { TextThought } from "../src/domain/thought";
import { record } from "../src/domain/validation";
import { mediaThought, mediaTime } from "./fixtures/media-source";
import { asyncMediaWeaveFixture, bindMediaReplay, mediaNeighbor, mediaReplayWorker, mediaWeaveFixture, prepareMediaRun,
  retainForbiddenMediaSuccessor, retainUnmappedMediaWeave, seedMediaRelations, startMediaTitleClear,
  retainedChildMediaWeaveFixture,
  type MediaWeaveFixture, type PreparedMediaRun } from "./fixtures/media-weave";

const interpretation: Extract<StepOperation, { type: "interpretation" }> = {
  type: "interpretation", text: "An interpretation that title regeneration must never publish", sourceIds: [],
};
const interpretationRequest: CapabilityRequest = {
  capability: "interpretation", arguments: { text: interpretation.text, sourceIds: interpretation.sourceIds },
};

function request(f: MediaWeaveFixture, prepared: PreparedMediaRun, input: CapabilityRequest): void {
  f.steps.completeStep(prepared.claim, prepared.step.promptId, { version: 1, kind: "request", request: input });
}

function noIssuedInterpretation(f: MediaWeaveFixture, prepared: PreparedMediaRun): void {
  expect(f.db.query("SELECT id FROM thoughts WHERE parent_id=?").all(mediaThought.id)).toEqual([]);
  expect(f.ops.stepReceipt(prepared.run.id, prepared.step.promptId)).toBeNull();
  expect(f.db.query("SELECT thought_id FROM run_issued_thoughts WHERE run_id=?").all(prepared.run.id)).toEqual([]);
}

async function reachMediaSubmission(replay: ReturnType<typeof mediaReplayWorker>, runId: string): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  // Test-owned scheduling bound, not a product effort limit. A bound prepared successor needs no model response.
  for (let tick = 0; tick < 6 && replay.submitted.length === 0; tick++) {
    try { await replay.worker.tick(runId); } catch (error) { failures.push(error); }
  }
  return failures;
}

describe("persisted media weave purpose", () => {
  test("media title-clear cannot publish an interpretation", () => mediaWeaveFixture(f => {
    const prepared = startMediaTitleClear(f);
    expect(f.ops.weaveIntent(prepared.run.id)).toEqual({ subjectId: mediaThought.id, triggerId: expect.stringMatching(/^title-clear:.+/) });
    expect(f.store.getThought(mediaThought.id)).toEqual(mediaThought);
    expect(prepared.context.thoughts).toContainEqual(mediaThought);
    // This real full-read witness prevents a missing-read denial from making the purpose test falsely green.
    expect(f.dispatcher.fullReadWitnesses(prepared.run.id)).toContainEqual({ kind: "thought", id: mediaThought.id });
    request(f, prepared, interpretationRequest);
    expect(f.steps.steps(prepared.run.id)).toEqual([expect.objectContaining({
      promptId: prepared.step.promptId, state: "completed", envelope: stepOperationEnvelope(interpretation), result: null,
    })]);
    let failure: unknown;
    try { f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, interpretationRequest); } catch (error) { failure = error; }
    noIssuedInterpretation(f, prepared);
    expect(failure).toBeInstanceOf(RunForbiddenError);
    expect(f.steps.steps(prepared.run.id)[0]?.result).toBeNull();
  }));

  test("title-only authority also denies direct typed interpretation and legacy development", () => mediaWeaveFixture(f => {
    const prepared = startMediaTitleClear(f);
    request(f, prepared, interpretationRequest);
    expect(() => f.ops.executeStep(prepared.claim, prepared.step.promptId, interpretation)).toThrow(RunForbiddenError);
    expect(() => f.runs.commit(prepared.claim, { id: "legacy-title-bypass", type: "development", parentId: mediaThought.id,
      text: "A legacy write must not bypass title-only purpose", sourceIds: [] })).toThrow(RunForbiddenError);
    expect(f.runs.receipt(prepared.run.id, "legacy-title-bypass")).toBeNull();
    noIssuedInterpretation(f, prepared);
  }));

  test.each(["manual-media-pass", `capture:${mediaThought.id}`, "evolve:unmapped-follow-up", `media:${mediaThought.mediaSource.id}:0`])(
    "unmapped media trigger %s cannot admit a run or initial step", triggerId => mediaWeaveFixture(f => {
      expect(() => f.ops.admitWeave("user", { subjectId: mediaThought.id, triggerId })).toThrow(RunForbiddenError);
      for (const table of ["runs", "run_steps", "run_context", "run_operation_receipts", "run_issued_thoughts"]) {
        expect(f.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      expect(f.store.getThought(mediaThought.id)).toEqual({ ...mediaThought, title: "Existing source label", titleAuthor: "user" });
    }),
  );

  test("title-only context advertises only title fill, not neighboring knowledge", () => mediaWeaveFixture(f => {
    seedMediaRelations(f);
    const prepared = startMediaTitleClear(f);
    expect(prepared.context.thoughts).toEqual([mediaThought]);
    expect(prepared.context.connections).toEqual([]);
    expect(prepared.context.responses).toEqual([]);
    const job = record(JSON.parse(prepared.input));
    if (!Array.isArray(job.capabilities)) throw new Error("Expected rendered capability definitions");
    expect(job.capabilities.map((entry: unknown) => record(entry).capability)).toEqual(["title-fill"]);
    expect(prepared.input).toContain(JSON.stringify(mediaThought.mediaSource.clarification));
  }));

  test("media title-clear fills an absent title and completes without an interpretation", () => mediaWeaveFixture(f => {
    const prepared = startMediaTitleClear(f);
    const fill: CapabilityRequest = { capability: "title-fill", arguments: { title: "A regenerated source label" } };
    request(f, prepared, fill);
    const result = f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, fill);
    expect(result).toEqual({ type: "title-fill", status: "filled" });
    if (result.type !== "title-fill") throw new Error("Expected a confirmed title-fill result");
    expect(f.ops.stepReceipt(prepared.run.id, prepared.step.promptId)).toEqual({
      operation: { type: "title-fill", title: "A regenerated source label" }, result,
    });
    expect(f.store.getThought(mediaThought.id)).toEqual({ ...mediaThought, title: "A regenerated source label", titleAuthor: "ai" });
    const next = f.steps.advance(prepared.claim, prepared.step.promptId, result, { promptId: "title-completion", input: "The title fill was confirmed" });
    f.steps.completeStep(prepared.claim, next.promptId, { version: 1, kind: "complete", reply: "Source title regenerated" });
    f.state.finish(prepared.claim, next.promptId);
    expect(f.runs.get(prepared.run.id)?.status).toBe("completed");
    expect(f.runs.reply(prepared.run.id)).toMatchObject({ role: "fallback", state: "complete", text: "Source title regenerated", thoughtIds: [mediaThought.id] });
    expect(f.db.query("SELECT id FROM thoughts WHERE parent_id=?").all(mediaThought.id)).toEqual([]);
    expect(f.db.query("SELECT thought_id FROM run_issued_thoughts WHERE run_id=?").all(prepared.run.id)).toEqual([]);
  }));

  test.each(["search", "readThought", "readConnection", "readResponse"] as const)(
    "a crafted title-only %s request cannot gain application read authority", capability => mediaWeaveFixture(f => {
      seedMediaRelations(f);
      const prepared = startMediaTitleClear(f);
      const ids = { readThought: mediaNeighbor.id, readConnection: "media-purpose-link", readResponse: "media-purpose-response" };
      const input: ReadCapabilityRequest = capability === "search" ? { capability, arguments: { query: "Zircon" } } : { capability, arguments: { id: ids[capability] } };
      const before = f.runs.contextRefs(prepared.run.id);
      request(f, prepared, input);
      expect(() => f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, input)).toThrow(RunForbiddenError);
      expect(f.steps.steps(prepared.run.id)[0]?.result).toBeNull();
      expect(f.runs.contextRefs(prepared.run.id)).toEqual(before);
      noIssuedInterpretation(f, prepared);
    }),
  );

  test("a correctly witnessed title-only connection proposal is denied at dispatch and storage", () => mediaWeaveFixture(f => {
    const prepared = startMediaTitleClear(f);
    // Controlled historical evidence: do not use a now-prohibited read as test setup.
    f.db.run("INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES (?,'thought',?,1)", [prepared.run.id, mediaNeighbor.id]);
    expect(f.dispatcher.fullReadWitnesses(prepared.run.id)).toEqual(expect.arrayContaining([
      { kind: "thought", id: mediaThought.id }, { kind: "thought", id: mediaNeighbor.id },
    ]));
    const operation: StepOperation = { type: "connection", fromId: mediaThought.id, toId: mediaNeighbor.id,
      category: "related", explanation: "A valid relation outside title-only authority", sourceIds: [] };
    const envelope = stepOperationEnvelope(operation);
    f.steps.completeStep(prepared.claim, prepared.step.promptId, envelope);
    expect(() => f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, envelope.request)).toThrow(RunForbiddenError);
    expect(() => f.ops.executeStep(prepared.claim, prepared.step.promptId, operation)).toThrow(RunForbiddenError);
    expect(f.db.query("SELECT id FROM connections").all()).toEqual([]);
    noIssuedInterpretation(f, prepared);
  }));

  test.each(["typed storage", "capability dispatcher"] as const)("a retained interpretation receipt cannot authorize title-only replay through %s", boundary => retainedChildMediaWeaveFixture(
    { id: "retained-forbidden-interpretation", text: interpretation.text }, f => {
    const prepared = startMediaTitleClear(f);
    request(f, prepared, interpretationRequest);
    const child: TextThought = { id: "retained-forbidden-interpretation", text: interpretation.text, title: null, titleAuthor: null,
      author: "ai", kind: "ai-interpretation", createdAt: mediaTime, origin: "weave", parentId: mediaThought.id, sourceIds: [] };
    // The historical child survived migration/reopen; it is not a new write through today's generic writer.
    expect(f.store.getThought(child.id)).toEqual(child);
    expect(f.ops.stepReceipt(prepared.run.id, prepared.step.promptId)).toBeNull();
    expect(f.db.query("SELECT thought_id FROM run_issued_thoughts WHERE run_id=?").all(prepared.run.id)).toEqual([]);
    expect(f.db.query("SELECT * FROM media_weave_attempts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM run_media_parts").all()).toEqual([]);
    const result: StepOperationResult = { type: "interpretation", thought: child };
    // Deliberate adversarial corruption, not a canonical producer, accepted interpretation or delivery witness.
    // A syntactically valid retained receipt/issued association must still fail the current purpose wall.
    f.db.run(`INSERT INTO run_operation_receipts(run_id,operation_id,operation_json,thought_id,result_json,format)
      VALUES (?,?,?,?,?,'step')`, [prepared.run.id, prepared.step.promptId, protocolJson(interpretation), child.id, protocolJson(result)]);
    f.db.run("INSERT INTO run_issued_thoughts(run_id,operation_id,thought_id,position) VALUES (?,?,?,0)", [prepared.run.id, prepared.step.promptId, child.id]);
    f.db.run("INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES (?,'thought',?,0)", [prepared.run.id, child.id]);
    expect(f.ops.stepReceipt(prepared.run.id, prepared.step.promptId)).toEqual({ operation: interpretation, result });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => boundary === "typed storage" ? f.ops.executeStep(prepared.claim, prepared.step.promptId, interpretation) :
      f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, interpretationRequest)).toThrow(RunForbiddenError);
    expect(f.store.getThought(child.id)).toEqual(child);
    expect(f.ops.stepReceipt(prepared.run.id, prepared.step.promptId)).toEqual({ operation: interpretation, result });
    expect(f.db.query("SELECT thought_id FROM run_issued_thoughts WHERE run_id=?").all(prepared.run.id)).toEqual([{ thought_id: child.id }]);
    expect(f.steps.steps(prepared.run.id)[0]?.result).toBeNull();
  }));

  test("a cached forbidden read cannot be replayed or advanced into another title-only prompt", () => mediaWeaveFixture(f => {
    const prepared = startMediaTitleClear(f);
    const input: ReadCapabilityRequest = { capability: "readThought", arguments: { id: mediaNeighbor.id } };
    const result = { type: "thought", thought: mediaNeighbor } satisfies ReturnType<typeof readCapabilityResult>;
    request(f, prepared, input);
    f.db.run("INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES (?,'thought',?,1)", [prepared.run.id, mediaNeighbor.id]);
    f.db.run("UPDATE run_steps SET result_json=? WHERE run_id=? AND prompt_id=?", [protocolJson(result), prepared.run.id, prepared.step.promptId]);
    expect(readCapabilityResult(input, result)).toEqual(result);
    expect(f.dispatcher.fullReadWitnesses(prepared.run.id)).toContainEqual({ kind: "thought", id: mediaNeighbor.id });
    expect(f.steps.steps(prepared.run.id)[0]?.result).toEqual(result);
    expect(() => f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, input)).toThrow(RunForbiddenError);
    expect(() => f.steps.advance(prepared.claim, prepared.step.promptId, result, { promptId: "forbidden-read-successor", input: protocolJson(result) })).toThrow(RunForbiddenError);
    expect(f.steps.steps(prepared.run.id)).toHaveLength(1);
    expect(f.steps.steps(prepared.run.id)[0]).toMatchObject({ state: "completed", result });
    noIssuedInterpretation(f, prepared);
  }));

  test("retained title-clear history cannot submit a prepared forbidden-read successor", async () => asyncMediaWeaveFixture(async f => {
    const retained = retainForbiddenMediaSuccessor(f);
    const runId = retained.prepared.run.id;
    expect(f.ops.weaveIntent(runId)).toEqual({ subjectId: mediaThought.id, triggerId: expect.stringMatching(/^title-clear:.+/) });
    expect(f.runs.get(runId)).toMatchObject({ status: "queued", promptId: retained.next.promptId, nativeState: "unknown" });
    expect(f.steps.steps(runId)).toEqual([
      expect.objectContaining({ state: "processed", envelope: { version: 1, kind: "request", request: retained.read }, result: retained.result }),
      expect.objectContaining({ position: 1, promptId: retained.next.promptId, input: retained.next.input, state: "prepared", envelope: null, result: null }),
    ]);
    expect(readCapabilityResult(retained.read, retained.result)).toEqual(retained.result);
    expect(f.dispatcher.fullReadWitnesses(runId)).toContainEqual({ kind: "thought", id: mediaNeighbor.id });
    expect(retained.next.input).toContain(mediaNeighbor.text);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const history = () => f.db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(runId);
    const before = history();
    const replay = mediaReplayWorker(f);
    try {
      const failures = await reachMediaSubmission(replay, runId);
      expect(replay.submitted).toEqual([]);
      // Rejecting only inside a native adapter callback is too late: no port may receive these bytes.
      expect(replay.received).toEqual([]);
      expect(history()).toEqual(before);
      for (const failure of failures) expect(failure instanceof RunForbiddenError || failure instanceof RunFenceError).toBe(true);
      expect(f.runs.reply(runId)).toBeNull();
    } finally { replay.worker.pause(); await replay.worker.drain(); }
  }));

  test("retained title-only title-fill successor resumes with its exact persisted input", async () => asyncMediaWeaveFixture(async f => {
    const prepared = startMediaTitleClear(f);
    const binding = bindMediaReplay(f, prepared);
    const fill: CapabilityRequest = { capability: "title-fill", arguments: { title: "A retained valid title fill" } };
    request(f, prepared, fill);
    const result = f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, fill);
    expect(result).toEqual({ type: "title-fill", status: "filled" });
    if (result.type !== "title-fill") throw new Error("Expected a confirmed title-fill result");
    const next = f.steps.advance(prepared.claim, prepared.step.promptId, result, { promptId: "retained-valid-media-successor",
      input: capabilityResultPrompt(fill, result, "weave", binding) });
    const nextInput = next.input;
    expect(nextInput).not.toBeNull();
    if (nextInput === null) throw new Error("Expected retained successor input");
    expect(f.steps.steps(prepared.run.id)).toEqual([
      expect.objectContaining({ state: "processed", result }),
      expect.objectContaining({ position: 1, promptId: next.promptId, input: next.input, state: "prepared" }),
    ]);
    const immutableHistory = () => f.db.query(`SELECT rowid,position,prompt_id,input,envelope_json,result_json
      FROM run_steps WHERE run_id=? ORDER BY position`).all(prepared.run.id);
    const before = immutableHistory();
    const replay = mediaReplayWorker(f);
    try {
      expect(await reachMediaSubmission(replay, prepared.run.id)).toEqual([]);
      expect(replay.ensured).toEqual([binding.sessionId]);
      expect(replay.submitted).toEqual([{ promptId: next.promptId, input: nextInput }]);
      expect(replay.received).toEqual([{ boundary: "submit", prompt: { promptId: next.promptId, input: nextInput } }]);
      expect(immutableHistory()).toEqual(before);
      expect(f.ops.stepReceipt(prepared.run.id, prepared.step.promptId)).toEqual({ operation: { type: "title-fill", title: "A retained valid title fill" }, result });
      expect(f.store.getThought(mediaThought.id)).toMatchObject({ title: "A retained valid title fill", titleAuthor: "ai" });
    } finally { replay.worker.pause(); await replay.worker.drain(); }
  }));

  test("late title-only fill and receipt replay preserve a newer user title", () => mediaWeaveFixture(f => {
    const prepared = startMediaTitleClear(f);
    const fill: CapabilityRequest = { capability: "title-fill", arguments: { title: "A late generated title" } };
    request(f, prepared, fill);
    f.titles.setUser("user", mediaThought.id, "The user's newer title");
    const result = f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, fill);
    expect(result).toEqual({ type: "title-fill", status: "unchanged" });
    if (result.type !== "title-fill") throw new Error("Expected a confirmed title-fill result");
    expect(f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, fill)).toEqual(result);
    expect(f.store.getThought(mediaThought.id)).toEqual({ ...mediaThought, title: "The user's newer title", titleAuthor: "user" });
    expect(f.ops.stepReceipt(prepared.run.id, prepared.step.promptId)).toEqual({ operation: { type: "title-fill", title: "A late generated title" }, result });
    expect(f.db.query("SELECT thought_id FROM run_issued_thoughts WHERE run_id=?").all(prepared.run.id)).toEqual([]);
  }));

  test("a retained unmapped media run cannot be reused or prepare initial context", () => mediaWeaveFixture(f => {
    const retained = retainUnmappedMediaWeave(f);
    expect(() => f.ops.admitWeave("user", retained.intent)).toThrow(RunForbiddenError);
    expect(() => f.state.prepareInitial(retained.claim, initialWorkerPrompt)).toThrow(RunForbiddenError);
    expect(f.steps.steps(retained.run.id)[0]).toMatchObject({ state: "prepared", input: null, envelope: null, result: null });
    expect(f.runs.contextRefs(retained.run.id)).toEqual([]);
  }));

  test("a retained unmapped media run cannot publish an otherwise valid final reply", () => mediaWeaveFixture(f => {
    const retained = retainUnmappedMediaWeave(f);
    // Historical completion is setup, not authorization through today's worker preparation path.
    f.db.run("UPDATE run_steps SET input=? WHERE run_id=?", ["retained predecessor input", retained.run.id]);
    f.db.run("UPDATE run_steps SET state='completed',native_state='completed',envelope_json=? WHERE run_id=?", [
      protocolJson({ version: 1, kind: "complete", reply: "An unmapped job must not publish this reply" }), retained.run.id,
    ]);
    f.db.run("UPDATE runs SET status='uncertain' WHERE id=?", [retained.run.id]);
    expect(f.steps.steps(retained.run.id)[0]?.envelope?.kind).toBe("complete");
    expect(() => f.state.finish(retained.claim, retained.run.promptId)).toThrow(RunForbiddenError);
    expect(f.runs.reply(retained.run.id)).toBeNull();
    expect(f.db.query("SELECT id FROM responses").all()).toEqual([]);
    expect(f.runs.get(retained.run.id)?.status).not.toBe("completed");
  }));

  test("Evolve from a media root keeps normal contribution, development and child-weave authority", () => mediaWeaveFixture(f => {
    const admission = f.admissions.admit("user", "evolve", { parentId: mediaThought.id, text: "Develop a different implication" });
    if (!admission.contribution) throw new Error("Expected the admitted user contribution");
    const prepared = prepareMediaRun(f, admission.run);
    expect(admission.contribution).toMatchObject({ author: "user", kind: "user-contribution", parentId: mediaThought.id });
    const source = f.store.getThought(mediaThought.id);
    expect(source).not.toBeNull();
    if (source === null) throw new Error("Expected the persisted media source");
    expect(prepared.context.thoughts).toContainEqual(source);
    const develop: CapabilityRequest = { capability: "development", arguments: { parentId: admission.contribution.id, text: "An ordinary new development", sourceIds: [] } };
    request(f, prepared, develop);
    const developed = f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, develop);
    if (developed.type !== "development") throw new Error("Expected a confirmed development");
    expect(developed.thought).toMatchObject({ parentId: admission.contribution.id, author: "ai", kind: "developing-idea" });
    const childRun = f.ops.admitWeave("user", { subjectId: developed.thought.id, triggerId: "ordinary-child-weave" });
    const child = prepareMediaRun(f, childRun);
    request(f, child, interpretationRequest);
    const interpreted = f.dispatcher.dispatch(child.claim, child.step.promptId, interpretationRequest);
    if (interpreted.type !== "interpretation") throw new Error("Expected an ordinary child interpretation");
    expect(interpreted.thought).toMatchObject({ parentId: developed.thought.id, kind: "ai-interpretation", author: "ai" });
    expect(f.db.query("SELECT id FROM thoughts WHERE parent_id=?").all(mediaThought.id)).toEqual([{ id: admission.contribution.id }]);
  }));
});
