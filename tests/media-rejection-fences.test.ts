import { describe, expect, test } from "bun:test";
import { RunFenceError, type Claim } from "../src/domain/run";
import { readMediaSubmission, recordMediaSubmission } from "../src/storage/media-submission";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { mediaAdmissionInput } from "./fixtures/media-admission";
import { expectImmediateMediaFence, expectRejectedQueuedAttempt, exposeIndirectMediaDependency, installMediaRejectionFault,
  mediaRejection, mediaRejectionSnapshot, retainedMediaEvidence, type IndirectMediaExposure } from "./fixtures/media-rejection";
import { expectedSubmission, mediaSubmissionFixture, prepareMediaSubmission } from "./fixtures/media-submission";
import { mediaThought } from "./fixtures/media-source";
import { expectUntouchedMediaAttempt, mediaTerminationFixture, terminationAttempt } from "./fixtures/media-termination";

const ai = { actor: "ai", mode: "normal" } as const;

describe("immediate media-dependent rejection fences", () => {
  test("source rejection immediately fences and seals an unprepared media attempt", async () => mediaTerminationFixture(f => {
    expectUntouchedMediaAttempt(f);
    const { run, thought } = f.admission, before = retainedMediaEvidence(f.db);
    const rejection = mediaRejection(f.db, f.sources.logger);

    rejection.rejectThought("user", thought.id);

    expect(f.db.query("SELECT thought_id FROM rejected_thoughts").all()).toEqual([{ thought_id: thought.id }]);
    // These are raw reads immediately after the rejection command: no worker, claim, replay or lazy guard can supply the fence.
    expectImmediateMediaFence(f.db, { runId: run.id, generation: run.generation });
    const seal = expectRejectedQueuedAttempt(f.db, f.admission);
    expect(expectRejectedQueuedAttempt(f.other, f.admission)).toBe(seal);
    expect(retainedMediaEvidence(f.db)).toEqual(before);
    expect(f.store.getThought(thought.id)).toEqual(thought);
    expect(rejection.listThoughts(ai)).toEqual([]);
    expect(f.db.query("SELECT * FROM run_media_parts").all()).toEqual([]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test("reject then restore preserves the queued attempt's exact terminal seal without resuming or scheduling work", async () => mediaTerminationFixture(f => {
    const unaffected = f.admissions.admit("user", mediaAdmissionInput(1));
    const otherAttempt = terminationAttempt(f.db, unaffected.run.id);
    const { run, thought } = f.admission, rejection = mediaRejection(f.db, f.sources.logger);
    const originalRunIds = f.db.query("SELECT id FROM runs ORDER BY rowid").all();
    const evidence = retainedMediaEvidence(f.db);

    rejection.rejectThought("user", thought.id);
    const seal = expectRejectedQueuedAttempt(f.db, f.admission), rejected = mediaRejectionSnapshot(f.db);
    rejection.rejectThought("user", thought.id);
    expect(mediaRejectionSnapshot(f.db)).toEqual(rejected);
    rejection.restoreThought("user", thought.id);

    expect(f.db.query("SELECT thought_id FROM rejected_thoughts").all()).toEqual([]);
    expect(rejection.listThoughts(ai)).toContainEqual(thought);
    expect(expectRejectedQueuedAttempt(f.db, f.admission)).toBe(seal);
    expect(f.db.query("SELECT id FROM runs ORDER BY rowid").all()).toEqual(originalRunIds);
    expect(f.runs.get(unaffected.run.id)).toEqual(unaffected.run);
    expect(terminationAttempt(f.db, unaffected.run.id)).toEqual(otherAttempt);
    expect(retainedMediaEvidence(f.db)).toEqual(evidence);
    const restored = mediaRejectionSnapshot(f.db), stale: Claim = { runId: run.id, generation: run.generation };
    expect(() => f.runs.claim(run.id)).toThrow(RunFenceError);
    expect(() => new SqliteRunProtocolRepository(f.db, f.sources.logger).prepare(stale,
      { promptId: run.promptId, input: "must not revive after restoration" })).toThrow(RunFenceError);
    f.runs.stop(run.id);
    expect(mediaRejectionSnapshot(f.db)).toEqual(restored);
  }));

  test.each(["weave", "evolve"] as const)("source rejection fences authorized ordinary %s before any replay and restoration cannot revive intent", async kind => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f, kind);
    const recorded = recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger);
    expect(recorded).toEqual({ authorization: expectedSubmission(f, prepared), replayed: false });
    expect(f.runs.get(prepared.run.id)).toMatchObject({ status: "submitting", generation: prepared.claim.generation, nativeState: "unknown" });
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
    expect(f.db.query("SELECT * FROM media_weave_attempts").all()).toEqual([]); // Ordinary work must not acquire an initial-attempt mapping.
    const evidence = retainedMediaEvidence(f.db), originalRunIds = f.db.query("SELECT id FROM runs ORDER BY rowid").all();
    const rejection = mediaRejection(f.db, f.sources.logger);

    rejection.rejectThought("user", mediaThought.id);

    expectImmediateMediaFence(f.db, prepared.claim);
    expectImmediateMediaFence(f.other, prepared.claim);
    expect(retainedMediaEvidence(f.db)).toEqual(evidence);
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(recorded.authorization);
    expect(rejection.listThoughts(ai).some(thought => thought.id === mediaThought.id)).toBe(false);
    const rejected = mediaRejectionSnapshot(f.db);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger)).toThrow(RunFenceError);
    expect(mediaRejectionSnapshot(f.db)).toEqual(rejected);

    rejection.restoreThought("user", mediaThought.id);

    expect(rejection.listThoughts(ai)).toContainEqual(mediaThought);
    expectImmediateMediaFence(f.db, prepared.claim);
    expect(f.db.query("SELECT id FROM runs ORDER BY rowid").all()).toEqual(originalRunIds);
    const restored = mediaRejectionSnapshot(f.db);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger)).toThrow(RunFenceError);
    expect(() => f.runs.claim(prepared.run.id)).toThrow(RunFenceError);
    expect(mediaRejectionSnapshot(f.db)).toEqual(restored);
    expect(retainedMediaEvidence(f.db)).toEqual(evidence);
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  const indirect: readonly IndirectMediaExposure[] = ["connection", "response"];
  for (const kind of indirect) test(`rejecting an indirectly exposed media source invalidates its scoped ${kind} dependency immediately`, async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f);
    const recorded = recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger);
    const { source, ref } = exposeIndirectMediaDependency(f, prepared, kind);
    const rejection = mediaRejection(f.db, f.sources.logger), evidence = retainedMediaEvidence(f.db);

    rejection.rejectThought("user", source.thought.id);

    // The root is neither a part source nor a direct run_context Thought; canonical connection/reply visibility is decisive.
    expectImmediateMediaFence(f.db, prepared.claim);
    if (ref.kind === "connection") expect(rejection.listConnections(ai).some(connection => connection.id === ref.id)).toBe(false);
    else if (ref.kind === "response") expect(rejection.getResponse(ai, ref.id)).toBeNull();
    else throw new Error("Expected an indirect connection or response dependency");
    expect(retainedMediaEvidence(f.db)).toEqual(evidence);
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(recorded.authorization);
    rejection.restoreThought("user", source.thought.id);
    expectImmediateMediaFence(f.db, prepared.claim);
    const restored = mediaRejectionSnapshot(f.db);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger)).toThrow(RunFenceError);
    expect(mediaRejectionSnapshot(f.db)).toEqual(restored);
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
  }));

  test("rejecting an unrelated media source does not invalidate a still-eligible original intent", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), unrelated = mediaAdmissionInput(55);
    const recorded = recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger);
    f.store.saveMediaSource(unrelated);
    const rejection = mediaRejection(f.db, f.sources.logger), evidence = retainedMediaEvidence(f.db);
    const run = f.runs.get(prepared.run.id);

    rejection.rejectThought("user", unrelated.thought.id);
    expect(f.runs.get(prepared.run.id)).toEqual(run);
    expect(recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger)).toEqual({ ...recorded, replayed: true });
    rejection.restoreThought("user", unrelated.thought.id);
    expect(f.runs.get(prepared.run.id)).toEqual(run);
    expect(retainedMediaEvidence(f.db)).toEqual(evidence);
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
  }));

  test("SQL failure after the rejection marker, queued fence and seal rolls the entire command back", async () => mediaTerminationFixture(f => {
    expectUntouchedMediaAttempt(f);
    const { run, thought } = f.admission, rejection = mediaRejection(f.db, f.sources.logger);
    const before = mediaRejectionSnapshot(f.db);
    const disarm = installMediaRejectionFault(f.db, { runId: run.id, generation: run.generation }, thought.id, true);
    try {
      expect(() => rejection.rejectThought("user", thought.id)).toThrow("injected complete media rejection fence");
      expect(f.db.inTransaction).toBe(false);
      expect(mediaRejectionSnapshot(f.db)).toEqual(before);
      expect(mediaRejectionSnapshot(f.other)).toEqual(before);
      expectUntouchedMediaAttempt(f);
      expect(rejection.listThoughts(ai)).toContainEqual(thought);
    } finally { disarm(); }

    rejection.rejectThought("user", thought.id);
    expectRejectedQueuedAttempt(f.db, f.admission);
    expectRejectedQueuedAttempt(f.other, f.admission);
    expect(f.store.getThought(thought.id)).toEqual(thought);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test("SQL failure after an authorized ordinary fence rolls back rejection without changing retained intent", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f);
    const recorded = recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger);
    const rejection = mediaRejection(f.db, f.sources.logger), before = mediaRejectionSnapshot(f.db);
    const disarm = installMediaRejectionFault(f.db, prepared.claim, mediaThought.id, false);
    try {
      expect(() => rejection.rejectThought("user", mediaThought.id)).toThrow("injected complete media rejection fence");
      expect(f.db.inTransaction).toBe(false);
      expect(mediaRejectionSnapshot(f.db)).toEqual(before);
      expect(mediaRejectionSnapshot(f.other)).toEqual(before);
      expect(recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt, f.sources.logger)).toEqual({ ...recorded, replayed: true });
      expect(mediaRejectionSnapshot(f.db)).toEqual(before);
    } finally { disarm(); }

    rejection.rejectThought("user", mediaThought.id);
    expectImmediateMediaFence(f.db, prepared.claim);
    expectImmediateMediaFence(f.other, prepared.claim);
    expect(readMediaSubmission(f.db, prepared.step.promptId)).toEqual(recorded.authorization);
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));
});
