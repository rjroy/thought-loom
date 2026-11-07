import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { capabilityResultPrompt } from "../src/agent/worker-prompts";
import { RunWorker, type WorkerNative } from "../src/agent/worker";
import { RejectionService } from "../src/domain/rejection";
import { RunFenceError, RunForbiddenError } from "../src/domain/run";
import { protocolJson, type NextStep } from "../src/domain/run-protocol";
import { readMediaSubmission, recordMediaSubmission } from "../src/storage/media-submission";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { migrate } from "../src/storage/sqlite";
import { immediate } from "../src/storage/transaction";
import { expectedSubmission, interceptCompleteSubmission, mediaSubmissionFixture, submissionSnapshot } from "./fixtures/media-submission";
import { commitMediaSuccessor, completedMediaPredecessor, expectedSuccessorParts, failCompleteSuccessorSeal,
  mediaSuccessorInput, originalMediaSuccessor, preparedMediaSuccessor, type OriginalMediaSuccessor,
  type MediaSuccessorPredecessor } from "./fixtures/media-successor";
import { mediaThought } from "./fixtures/media-source";
import { insertOriginalPart, partSnapshot } from "./fixtures/run-media-parts";

describe("original media successors", () => {
  test("media successor seals ordered originals and source exposures with its confirmed predecessor", async () => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), next = originalMediaSuccessor(previous);
    expect(partSnapshot(f.db)).toEqual([]);
    expect(f.runs.contextRefs(previous.run.id)).not.toContainEqual({ kind: "thought", id: mediaThought.id });
    expect(f.runs.contextRefs(previous.run.id)).not.toContainEqual({ kind: "thought", id: "parts-second-root" });
    const step = commitMediaSuccessor(f, previous, next);
    expect(partSnapshot(f.db)).toEqual(expectedSuccessorParts(previous, next.promptId)); // First RED: current advance stores only text.
    expect(step).toEqual({ runId: previous.run.id, position: 1, promptId: next.promptId, input: next.input,
      state: "prepared", envelope: null, result: null });
    expect(f.steps.steps(previous.run.id)).toEqual([{ ...previous.predecessor, state: "processed" }, step]);
    expect(new SqliteRunProtocolRepository(f.other, f.sources.logger).steps(previous.run.id)).toEqual(f.steps.steps(previous.run.id));
    expect(f.runs.contextRefs(previous.run.id)).toEqual(expect.arrayContaining([
      { kind: "thought", id: mediaThought.id }, { kind: "thought", id: "parts-second-root" },
    ]));
    expect(f.db.query("SELECT full_read FROM run_context WHERE run_id=? AND kind='thought' AND ref_id IN ('media-root','parts-second-root') ORDER BY ref_id").all(previous.run.id))
      .toEqual([{ full_read: 0 }, { full_read: 0 }]);
    expect(f.runs.get(previous.run.id)).toMatchObject({ status: "queued", promptId: next.promptId, nativeState: "unknown" });
    expect(readMediaSubmission(f.db, next.promptId)).toBeNull();
    expect(f.db.query("SELECT * FROM run_operation_receipts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM run_issued_thoughts").all()).toEqual([]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test.each(["weave", "evolve"] as const)("%s successor authorization binds the current step and claim, not the initial prompt", async kind => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f, kind), prepared = preparedMediaSuccessor(f, previous);
    expect(partSnapshot(f.db)).toEqual(expectedSuccessorParts(previous, prepared.step.promptId));
    const claim = f.runs.claim(previous.run.id), current = { ...prepared, claim }, before = submissionSnapshot(f.db);
    expect(claim.generation).toBeGreaterThan(previous.claim.generation);
    expect(() => recordMediaSubmission(f.db, f.owner, previous.claim, prepared.prompt)).toThrow(RunFenceError);
    expect(submissionSnapshot(f.db)).toEqual(before);
    const recorded = recordMediaSubmission(f.db, f.owner, claim, prepared.prompt);
    expect(recorded).toEqual({ authorization: expectedSubmission(f, current), replayed: false });
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(recorded.authorization);
    expect(readMediaSubmission(f.db, previous.predecessor.promptId)).toBeNull();
    expect(f.steps.steps(previous.run.id)).toEqual([{ ...previous.predecessor, state: "processed" }, { ...prepared.step, state: "submitting" }]);
    expect(() => recordMediaSubmission(f.db, f.owner, claim, { ...prepared.prompt, promptId: previous.predecessor.promptId })).toThrow();
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
    const retained = submissionSnapshot(f.db), reopened = new Database(f.path);
    try {
      migrate(reopened, f.sources.logger); migrate(reopened, f.sources.logger);
      expect(submissionSnapshot(reopened)).toEqual(retained);
      expect(readMediaSubmission(reopened, prepared.step.promptId)).toEqual(recorded.authorization);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
  }));

  test.each(["second part", "complete seal"] as const)("failure after successor %s rolls back predecessor processing, step, parts and exposures", async phase => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), next = originalMediaSuccessor(previous), before = submissionSnapshot(f.db);
    if (phase === "second part") f.db.exec(`CREATE TRIGGER fixture_successor_part_failure AFTER INSERT ON run_media_parts
      WHEN NEW.prompt_id='media-successor-owned-prompt' AND NEW.position=1
        AND EXISTS(SELECT 1 FROM run_steps WHERE run_id=(SELECT run_id FROM run_steps WHERE prompt_id=NEW.prompt_id) AND position=0 AND state='processed' AND result_json IS NOT NULL)
        AND (SELECT COUNT(*) FROM run_media_parts WHERE prompt_id=NEW.prompt_id)=2
      BEGIN SELECT RAISE(ABORT,'injected after second successor part'); END;`);
    else failCompleteSuccessorSeal(f, previous);
    expect(() => commitMediaSuccessor(f, previous, next)).toThrow(phase === "second part" ? "injected after second successor part" : "injected after complete media successor seal");
    expect(f.db.inTransaction).toBe(false);
    expect(submissionSnapshot(f.db)).toEqual(before);
    expect(readMediaSubmission(f.db, next.promptId)).toBeNull();
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    if (phase === "second part") f.db.exec("DROP TRIGGER fixture_successor_part_failure");
    else f.db.exec("DROP TRIGGER fixture_successor_seal_failure; DROP TRIGGER fixture_successor_exposure_failure");
    commitMediaSuccessor(f, previous, next);
    expect(partSnapshot(f.db)).toEqual(expectedSuccessorParts(previous, next.promptId));
  }));

  const forgedSuccessors: readonly { name: string; change: (previous: MediaSuccessorPredecessor, next: OriginalMediaSuccessor) => NextStep }[] = [
    { name: "manifest text without a prepared-parts argument", change: (_previous, next) => ({ promptId: next.promptId, input: next.input }) },
    { name: "input missing one declared original", change: (previous, next) => ({ ...next,
      input: mediaSuccessorInput(previous, { ...next.media, parts: next.media.parts.slice(1) }) }) },
    { name: "reordered equal-byte source identities", change: (_previous, next) => ({ ...next, media: { ...next.media, parts: [...next.media.parts].reverse() } }) },
    { name: "an invented observation field", change: (previous, next) => {
      const media = { ...next.media, parts: next.media.parts.map(part => ({ ...part, observed: true })) };
      return { ...next, media, input: mediaSuccessorInput(previous, media) };
    } },
  ];
  for (const { name, change } of forgedSuccessors) test(`successor advancement rejects ${name} without processing the predecessor`, async () => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), next = originalMediaSuccessor(previous), before = submissionSnapshot(f.db);
    expect(() => f.steps.advance(previous.claim, previous.predecessor.promptId, previous.result, change(previous, next))).toThrow();
    expect(submissionSnapshot(f.db)).toEqual(before);
    expect(partSnapshot(f.db)).toEqual([]);
    expect(readMediaSubmission(f.db, next.promptId)).toBeNull();
  }));

  test("attaching originals cannot replace the predecessor's confirmed result with a caller-supplied record", async () => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), next = originalMediaSuccessor(previous), wrongThought = f.store.getThought(mediaThought.id);
    if (wrongThought === null) throw new Error("Expected the separate retained media descriptor");
    expect(wrongThought.id).not.toBe(previous.request.arguments.id);
    const before = submissionSnapshot(f.db), wrongResult = { ...previous.result, thought: wrongThought };
    expect(() => f.steps.advance(previous.claim, previous.predecessor.promptId, wrongResult, next)).toThrow();
    expect(submissionSnapshot(f.db)).toEqual(before);
    expect(readMediaSubmission(f.db, next.promptId)).toBeNull();
  }));

  test("exact successor and authorization replay preserve retained input and never grant fresh dispatch permission", async () => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), prepared = preparedMediaSuccessor(f, previous);
    const first = recordMediaSubmission(f.db, f.owner, previous.claim, prepared.prompt), before = submissionSnapshot(f.db);
    const replayedStep = commitMediaSuccessor(f, previous, prepared.next);
    expect(replayedStep).toEqual({ ...prepared.step, state: "submitting" });
    expect(recordMediaSubmission(f.other, f.owner, previous.claim, prepared.prompt)).toEqual({ ...first, replayed: true });
    expect(submissionSnapshot(f.db)).toEqual(before);
    for (const altered of [
      { ...prepared.next, input: `${prepared.next.input}\n` },
      { ...prepared.next, media: { ...prepared.next.media, parts: [...prepared.next.media.parts].reverse() } },
    ]) expect(() => commitMediaSuccessor(f, previous, altered)).toThrow();
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(first.authorization);
    expect(submissionSnapshot(f.db)).toEqual(before);
  }));

  test("stale advancement and rejected unexposed originals leave the predecessor unprocessed", async () => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), next = originalMediaSuccessor(previous), claim = f.runs.claim(previous.run.id);
    const before = submissionSnapshot(f.db);
    expect(() => commitMediaSuccessor(f, previous, next)).toThrow(RunFenceError);
    expect(submissionSnapshot(f.db)).toEqual(before);
    new RejectionService(new SqliteRejectionRepository(f.db, f.sources.logger)).rejectThought("user", "parts-second-root");
    const rejected = submissionSnapshot(f.db);
    expect(() => f.steps.advance(claim, previous.predecessor.promptId, previous.result, next)).toThrow();
    expect(submissionSnapshot(f.db)).toEqual(rejected);
    expect(readMediaSubmission(f.db, next.promptId)).toBeNull();
    expect(partSnapshot(f.db)).toEqual([]);
  }));

  test("rejected successor sources fence cached advancement and authorization without rewriting history", async () => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), prepared = preparedMediaSuccessor(f, previous);
    const recorded = recordMediaSubmission(f.db, f.owner, previous.claim, prepared.prompt), parts = partSnapshot(f.db);
    const inputs = f.steps.steps(previous.run.id).map(step => ({ promptId: step.promptId, input: step.input }));
    new RejectionService(new SqliteRejectionRepository(f.db, f.sources.logger)).rejectThought("user", "parts-second-root");
    expect(() => commitMediaSuccessor(f, previous, prepared.next)).toThrow(RunFenceError);
    expect(() => recordMediaSubmission(f.db, f.owner, previous.claim, prepared.prompt)).toThrow(RunFenceError);
    expect(f.steps.steps(previous.run.id).map(step => ({ promptId: step.promptId, input: step.input }))).toEqual(inputs);
    expect(partSnapshot(f.db)).toEqual(parts);
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(recorded.authorization);
  }));

  test("an unprocessed earlier predecessor cannot gain authorization through a crafted current successor", async () => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), next = originalMediaSuccessor(previous), before = submissionSnapshot(f.db);
    expect(previous.predecessor.state).toBe("completed");
    expect(previous.predecessor.result).toEqual(previous.result);
    expect(() => immediate(f.db, () => {
      // A controlled retained-history forgery: the immediate predecessor is processed, but the earlier step is not.
      // This is not native completion/correlation evidence. Any structural/preparation/authorization boundary may deny it.
      f.db.run(`INSERT INTO run_steps(run_id,position,prompt_id,input,state,native_state,envelope_json,result_json)
        VALUES (?,1,'media-successor-retained-middle',?,'processed','completed',?,?)`, [previous.run.id,
        capabilityResultPrompt(previous.request, previous.result, previous.run.kind, previous.binding),
        protocolJson({ version: 1, kind: "request", request: previous.request }), protocolJson(previous.result)]);
      f.db.run("INSERT INTO run_steps(run_id,position,prompt_id,state,native_state) VALUES (?,2,?,'prepared','unknown')", [previous.run.id, next.promptId]);
      f.db.run("UPDATE runs SET status='queued' WHERE id=?", [previous.run.id]);
      for (const part of previous.parts) insertOriginalPart(f.db, next.promptId, part);
      f.steps.prepare(previous.claim, next);
      recordMediaSubmission(f.db, f.owner, previous.claim, { promptId: next.promptId, input: next.input, media: next.media });
    })).toThrow();
    expect(submissionSnapshot(f.db)).toEqual(before);
    expect(readMediaSubmission(f.db, next.promptId)).toBeNull();
    expect(partSnapshot(f.db)).toEqual([]);
  }));

  test.each(["SQL failure", "lease loss"] as const)("successor %s rolls back complete authorization but preserves its sealed history", async failure => mediaSubmissionFixture(f => {
    const previous = completedMediaPredecessor(f), prepared = preparedMediaSuccessor(f, previous), before = submissionSnapshot(f.db);
    const expected = expectedSubmission(f, prepared), interception = interceptCompleteSubmission(f.db, prepared.step.promptId, () => {
      if (failure === "lease loss") f.owner.release();
      else throw new Error("injected after complete successor authorization");
    });
    const record = () => recordMediaSubmission(interception.connection, f.owner, previous.claim, prepared.prompt);
    if (failure === "SQL failure") expect(record).toThrow("injected after complete successor authorization");
    else expect(record).toThrow(RunFenceError);
    expect(interception.witnessed()).toEqual(expected);
    expect(f.db.inTransaction).toBe(false);
    expect(submissionSnapshot(f.db)).toEqual(before);
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toBeNull();
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    if (failure === "SQL failure") expect(recordMediaSubmission(f.db, f.owner, previous.claim, prepared.prompt))
      .toEqual({ authorization: expected, replayed: false });
  }));

  test("authorized successor originals still cannot enter a text-only native port", async () => mediaSubmissionFixture(async f => {
    const previous = completedMediaPredecessor(f), prepared = preparedMediaSuccessor(f, previous);
    const recorded = recordMediaSubmission(f.db, f.owner, previous.claim, prepared.prompt), received: string[] = [];
    const inputs = f.steps.steps(previous.run.id).map(step => ({ promptId: step.promptId, input: step.input })), parts = partSnapshot(f.db);
    const worker = new RunWorker({ db: f.db, ...f.sources, executionOwner: f.owner,
      bindingFor: () => { throw new Error("Must retain the existing successor binding"); },
      native: () => {
        const native: WorkerNative = {
          ensureSession: async () => { received.push("ensure"); }, submit: async () => { received.push("submit"); },
          observe: async () => { received.push("observe"); return { state: "running" }; },
          cancel: async () => { received.push("cancel"); return "pending"; },
        };
        return native;
      },
    });
    try {
      for (let tick = 0; tick < 4; tick++) {
        try { await worker.tick(previous.run.id); }
        catch (error) { expect(error instanceof RunFenceError || error instanceof RunForbiddenError).toBe(true); }
      }
      expect(received).toEqual([]);
      expect(f.steps.steps(previous.run.id).map(step => ({ promptId: step.promptId, input: step.input }))).toEqual(inputs);
      expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(recorded.authorization);
      expect(partSnapshot(f.db)).toEqual(parts);
      expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
    } finally { worker.pause(); await worker.drain(); }
  }));
});
