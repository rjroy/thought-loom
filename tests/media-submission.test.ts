import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capabilityResultPrompt, initialWorkerPrompt } from "../src/agent/worker-prompts";
import { RunWorker, type WorkerNative } from "../src/agent/worker";
import { RejectionService } from "../src/domain/rejection";
import { RunFenceError, RunForbiddenError } from "../src/domain/run";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { readMediaSubmission, recordMediaSubmission, type MediaSubmissionPrompt } from "../src/storage/media-submission";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { migrate } from "../src/storage/sqlite";
import { expectedSubmission, interceptCompleteSubmission, mediaSubmissionFixture, prepareMediaSubmission,
  submissionBinding, submissionSnapshot } from "./fixtures/media-submission";
import { mediaThought } from "./fixtures/media-source";
import { mediaNeighbor } from "./fixtures/media-weave";
import { partSnapshot } from "./fixtures/run-media-parts";

describe("durable media submission authorization", () => {
  test("media authorization is durable before dispatch without observing originals", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), beforeParts = partSnapshot(f.db), expected = expectedSubmission(f, prepared);
    // The held lease is a real capability, and its immutable registry row belongs to this exact owned DB file.
    f.owner.assertRegistered(f.db);
    expect(f.db.query("SELECT database_identity,lease_protocol FROM execution_owners WHERE id=?").get(f.owner.id))
      .toEqual({ database_identity: f.owner.databaseIdentity, lease_protocol: f.owner.leaseProtocol });
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt)).not.toThrow();
    expect(f.db.inTransaction).toBe(false);
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(expected); // Separate connection, before any native call.
    expect(f.runs.get(prepared.run.id)).toMatchObject({ status: "submitting", nativeState: "unknown", generation: prepared.claim.generation });
    expect(f.steps.steps(prepared.run.id)).toEqual([{ ...prepared.step, state: "submitting" }]);
    expect(partSnapshot(f.db)).toEqual(beforeParts);
    expect(f.db.query("SELECT observed FROM run_media_parts ORDER BY position").all()).toEqual([{ observed: 0 }, { observed: 0 }]);
    expect(f.db.query("SELECT * FROM run_operation_receipts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM run_issued_thoughts").all()).toEqual([]);
    const reopened = new Database(f.path);
    try {
      migrate(reopened, f.sources.logger); migrate(reopened, f.sources.logger);
      expect(readMediaSubmission(reopened, prepared.step.promptId)).toEqual(expected);
      expect(partSnapshot(reopened)).toEqual(beforeParts);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
  }));

  test("Evolve records its own exact initial-step media authorization", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f, "evolve");
    expect(recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt))
      .toEqual({ authorization: expectedSubmission(f, prepared), replayed: false });
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(expectedSubmission(f, prepared));
    expect(f.runs.get(prepared.run.id)).toMatchObject({ status: "submitting", inputThoughtId: prepared.run.inputThoughtId });
    expect(partSnapshot(f.db)).toHaveLength(prepared.parts.length);
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
  }));

  test("preparation, binding and a descriptor read do not backfill media authorization", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), parts = partSnapshot(f.db);
    expect(new SqliteAgentBindings(f.db, f.sources.logger, f.owner).get(prepared.run.id)).toEqual(prepared.binding);
    const readRun = f.ops.admitWeave("user", { subjectId: mediaNeighbor.id, triggerId: "submission-descriptor-control" });
    const readClaim = f.runs.claim(readRun.id);
    f.state.prepareInitial(readClaim, initialWorkerPrompt);
    const request = { capability: "readThought", arguments: { id: mediaThought.id } } as const;
    f.steps.completeStep(readClaim, readRun.promptId, { version: 1, kind: "request", request });
    const result = f.dispatcher.dispatch(readClaim, readRun.promptId, request);
    expect(result.type).toBe("thought");
    if (result.type !== "thought" || result.thought === null) throw new Error("Expected a descriptor control");
    expect(result.thought.kind).toBe("media-original");
    expect(f.dispatcher.fullReadWitnesses(readRun.id)).toContainEqual({ kind: "thought", id: mediaThought.id });
    migrate(f.db, f.sources.logger);
    expect(readMediaSubmission(f.db, prepared.step.promptId)).toBeNull();
    expect(readMediaSubmission(f.db, readRun.promptId)).toBeNull();
    expect(partSnapshot(f.db)).toEqual(parts);
    expect(f.runs.get(prepared.run.id)?.status).toBe("queued");
  }));

  test("an exact authorization replay retains one original intent and cannot claim a fresh dispatch", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f);
    const first = recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt), before = submissionSnapshot(f.db);
    expect(first).toEqual({ authorization: expectedSubmission(f, prepared), replayed: false });
    expect(recordMediaSubmission(f.other, f.owner, prepared.claim, prepared.prompt)).toEqual({ ...first, replayed: true });
    expect(readMediaSubmission(f.db, prepared.step.promptId)).toEqual(first.authorization);
    expect(submissionSnapshot(f.db)).toEqual(before);
  }));

  const alteredPrompts: readonly { name: string; change: (prompt: MediaSubmissionPrompt) => MediaSubmissionPrompt }[] = [
    { name: "semantically equal but byte-different input", change: prompt => ({ ...prompt, input: `${prompt.input}\n` }) },
    { name: "missing original", change: prompt => ({ ...prompt, media: { ...prompt.media, parts: prompt.media.parts.slice(1) } }) },
    { name: "reordered equal-byte source identities", change: prompt => ({ ...prompt, media: { ...prompt.media, parts: [...prompt.media.parts].reverse() } }) },
    { name: "changed digest", change: prompt => ({ ...prompt, media: { ...prompt.media, parts: prompt.media.parts.map(part => ({ ...part,
      sha256: `${part.sha256.startsWith("0") ? "1" : "0"}${part.sha256.slice(1)}` })) } }) },
    { name: "invented observation field", change: prompt => ({ ...prompt, media: { ...prompt.media,
      parts: prompt.media.parts.map(part => ({ ...part, observed: true })) } }) },
  ];
  for (const { name, change } of alteredPrompts) test(`authorization rejects ${name} before recording or replaying intent`, async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), before = submissionSnapshot(f.db);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, change(prepared.prompt))).toThrow();
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toBeNull();
    expect(submissionSnapshot(f.db)).toEqual(before);
    const recorded = recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt), committed = submissionSnapshot(f.db);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, change(prepared.prompt))).toThrow();
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(recorded.authorization);
    expect(submissionSnapshot(f.db)).toEqual(committed);
  }));

  test("a real foreign step cannot acquire authorization under another run's claim", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f);
    const otherRun = f.ops.admitWeave("user", { subjectId: mediaNeighbor.id, triggerId: "submission-foreign-step" });
    const claim = f.runs.claim(otherRun.id);
    f.state.prepareInitial(claim, initialWorkerPrompt);
    const foreignStep = f.steps.steps(otherRun.id)[0];
    expect(foreignStep).toBeDefined();
    if (!foreignStep || foreignStep.input === null) throw new Error("Expected a real prepared foreign step");
    const before = submissionSnapshot(f.db);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, { ...prepared.prompt, promptId: otherRun.promptId })).toThrow();
    expect(() => recordMediaSubmission(f.db, f.owner, claim, prepared.prompt)).toThrow();
    expect(readMediaSubmission(f.db, prepared.step.promptId)).toBeNull();
    expect(readMediaSubmission(f.db, otherRun.promptId)).toBeNull();
    expect(submissionSnapshot(f.db)).toEqual(before);
  }));

  test("an exact retained predecessor cannot authorize after a successor becomes current", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), request = { capability: "readThought", arguments: { id: mediaNeighbor.id } } as const;
    // Controlled protocol state, not proof of native completion or binary observation. Only the current-step guard is under test.
    f.steps.completeStep(prepared.claim, prepared.step.promptId, { version: 1, kind: "request", request });
    const result = f.dispatcher.dispatch(prepared.claim, prepared.step.promptId, request);
    expect(result.type).toBe("thought");
    if (result.type !== "thought" || result.thought === null) throw new Error("Expected the confirmed record-read result");
    const next = f.steps.advance(prepared.claim, prepared.step.promptId, result, { promptId: "media-submission-text-successor",
      input: capabilityResultPrompt(request, result, "weave", prepared.binding) });
    expect(next.position).toBe(prepared.step.position + 1);
    expect(f.steps.steps(prepared.run.id)).toHaveLength(2);
    expect(f.runs.get(prepared.run.id)?.promptId).toBe(next.promptId);
    const before = submissionSnapshot(f.db);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt)).toThrow();
    expect(readMediaSubmission(f.db, prepared.step.promptId)).toBeNull();
    expect(readMediaSubmission(f.db, next.promptId)).toBeNull();
    expect(submissionSnapshot(f.db)).toEqual(before);
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
  }));

  test("stale generations and rejected sources cannot record or replay authorization", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), newer = f.runs.claim(prepared.run.id), before = submissionSnapshot(f.db);
    expect(newer.generation).toBeGreaterThan(prepared.claim.generation);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt)).toThrow(RunFenceError);
    expect(readMediaSubmission(f.db, prepared.step.promptId)).toBeNull();
    expect(submissionSnapshot(f.db)).toEqual(before);
    const recorded = recordMediaSubmission(f.db, f.owner, newer, prepared.prompt);
    expect(recorded.authorization.generation).toBe(newer.generation);
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt)).toThrow(RunFenceError);
    new RejectionService(new SqliteRejectionRepository(f.db, f.sources.logger)).rejectThought("user", mediaThought.id);
    expect(() => recordMediaSubmission(f.db, f.owner, newer, prepared.prompt)).toThrow(RunFenceError);
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(recorded.authorization);
    expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
  }));

  test("an unbound prepared step cannot authorize media by inventing a binding", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f, "weave", false), before = submissionSnapshot(f.db);
    expect(new SqliteAgentBindings(f.db, f.sources.logger, f.owner).get(prepared.run.id)).toBeNull();
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, { ...prepared.prompt, ...{ binding: prepared.binding } })).toThrow();
    expect(readMediaSubmission(f.db, prepared.step.promptId)).toBeNull();
    expect(submissionSnapshot(f.db)).toEqual(before);
  }));

  test("registry strings and a forged lease-shaped object are not a held capability", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), before = submissionSnapshot(f.db);
    expect(f.db.query("SELECT id FROM execution_owners WHERE id=?").get(f.owner.id)).toEqual({ id: f.owner.id });
    expect(() => recordMediaSubmission(f.db, undefined, prepared.claim, prepared.prompt)).toThrow(RunFenceError);
    const forged = { id: f.owner.id, databaseIdentity: f.owner.databaseIdentity, leaseProtocol: f.owner.leaseProtocol,
      assertRegistered: () => {}, assertHeld: () => {} };
    expect(() => Reflect.apply(recordMediaSubmission, undefined, [f.db, forged, prepared.claim, prepared.prompt])).toThrow(RunFenceError);
    expect(readMediaSubmission(f.db, prepared.step.promptId)).toBeNull();
    expect(submissionSnapshot(f.db)).toEqual(before);
  }));

  test("released and unregistered replacement leases cannot authorize an existing prepared step", async () => mediaSubmissionFixture(async f => {
    const prepared = prepareMediaSubmission(f), before = submissionSnapshot(f.db);
    f.owner.release();
    expect(() => recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt)).toThrow(RunFenceError);
    const replacement = await ExecutionOwnerLease.acquire(f.path, f.sources.logger);
    try {
      replacement.assertHeld();
      expect(f.db.query("SELECT id FROM execution_owners WHERE id=?").get(replacement.id)).toBeNull();
      expect(() => recordMediaSubmission(f.db, replacement, prepared.claim, prepared.prompt)).toThrow(RunFenceError);
      expect(readMediaSubmission(f.db, prepared.step.promptId)).toBeNull();
      expect(submissionSnapshot(f.db)).toEqual(before);
    } finally { replacement.release(); }
  }));

  test("copied registry and prompt rows do not authorize the original lease against another database", async () => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), copy = join(dirname(f.path), "submission-copy.sqlite");
    expect(f.db.inTransaction).toBe(false);
    copyFileSync(f.path, copy);
    const copied = new Database(copy);
    try {
      migrate(copied, f.sources.logger);
      expect(copied.query("SELECT id FROM execution_owners WHERE id=?").get(f.owner.id)).toEqual({ id: f.owner.id });
      expect(copied.query("SELECT input FROM run_steps WHERE prompt_id=?").get(prepared.step.promptId)).toEqual({ input: prepared.prompt.input });
      const before = submissionSnapshot(copied);
      expect(() => recordMediaSubmission(copied, f.owner, prepared.claim, prepared.prompt)).toThrow(RunFenceError);
      expect(readMediaSubmission(copied, prepared.step.promptId)).toBeNull();
      expect(submissionSnapshot(copied)).toEqual(before);
    } finally { copied.close(); }
  }));

  test.each(["SQL failure", "lease loss"] as const)("%s after complete authorization rolls back intent and submission states", async failure => mediaSubmissionFixture(f => {
    const prepared = prepareMediaSubmission(f), before = submissionSnapshot(f.db), expected = expectedSubmission(f, prepared);
    const interception = interceptCompleteSubmission(f.db, prepared.step.promptId, () => {
      if (failure === "lease loss") f.owner.release();
      else throw new Error("injected after durable media authorization");
    });
    const record = () => recordMediaSubmission(interception.connection, f.owner, prepared.claim, prepared.prompt);
    if (failure === "SQL failure") expect(record).toThrow("injected after durable media authorization");
    else expect(record).toThrow(RunFenceError);
    expect(interception.witnessed()).toEqual(expected); // Real complete record + both submitting states existed inside the failed transaction.
    expect(f.db.inTransaction).toBe(false);
    expect(readMediaSubmission(f.other, prepared.step.promptId)).toBeNull();
    expect(submissionSnapshot(f.db)).toEqual(before);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    if (failure === "SQL failure") expect(recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt))
      .toEqual({ authorization: expected, replayed: false });
  }));

  test("recorded media authorization still cannot reach a text-only native port", async () => mediaSubmissionFixture(async f => {
    const prepared = prepareMediaSubmission(f), recorded = recordMediaSubmission(f.db, f.owner, prepared.claim, prepared.prompt);
    const received: string[] = [];
    const worker = new RunWorker({ db: f.db, ...f.sources, executionOwner: f.owner,
      bindingFor: () => { throw new Error("Must retain the immutable binding"); },
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
        try { await worker.tick(prepared.run.id); }
        catch (error) { expect(error instanceof RunFenceError || error instanceof RunForbiddenError).toBe(true); }
      }
      expect(received).toEqual([]);
      expect(readMediaSubmission(f.other, prepared.step.promptId)).toEqual(recorded.authorization);
      expect(f.steps.steps(prepared.run.id)[0]?.input).toBe(prepared.prompt.input);
      expect(f.db.query("SELECT DISTINCT observed FROM run_media_parts").all()).toEqual([{ observed: 0 }]);
    } finally { worker.pause(); await worker.drain(); }
  }));

  test("ordinary text submission retains its existing unqualified native path", async () => mediaSubmissionFixture(f => {
    const run = f.ops.admitWeave("user", { subjectId: mediaNeighbor.id, triggerId: "submission-text-control" }), claim = f.runs.claim(run.id);
    const step = f.state.prepareInitial(claim, initialWorkerPrompt);
    if (step.input === null) throw new Error("Expected exact text control input");
    const bindings = new SqliteAgentBindings(f.db, f.sources.logger);
    bindings.bind(run.id, submissionBinding(run), claim);
    const prompt = { promptId: step.promptId, input: step.input };
    const before = submissionSnapshot(f.db);
    expect(() => recordMediaSubmission(f.db, f.owner, claim, { ...prompt, media: { version: 1, parts: [] } })).toThrow();
    expect(submissionSnapshot(f.db)).toEqual(before);
    expect(bindings.assertActive(claim, prompt, "history")).toEqual([prompt]);
    expect(() => bindings.assertActive(claim, prompt, "submit")).not.toThrow();
    expect(f.runs.get(run.id)?.status).toBe("submitting");
    expect(readMediaSubmission(f.db, step.promptId)).toBeNull();
    expect(partSnapshot(f.db)).toEqual([]);
  }));
});
