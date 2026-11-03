import { describe, expect, test } from "bun:test";
import { RunAdmissionError, RunForbiddenError, RunService, type Admission, type Claim, type ContextRef, type NativeDispatcher, type Operation, type OperationResult, type Receipt, type ReplyDraft, type RunRecord, type RunRepository, type RunStatus } from "../src/domain/run";
import type { SharedResponse } from "../src/domain/shared-response";
import type { Thought } from "../src/domain/thought";

class ControlledRepository implements RunRepository {
  readonly admissions: Admission[] = [];
  readonly transitions: RunStatus[] = [];
  run: RunRecord | null = null;
  operations: Operation[] = [];
  admit(admission: Admission): void { this.admissions.push(admission); this.run = admission.run; }
  get(id: string): RunRecord | null { return this.run?.id === id ? this.run : null; }
  claim(id: string): Claim { return { runId: id, generation: 1 }; }
  setStatus(_claim: Claim, status: RunStatus): void { this.transitions.push(status); if (this.run) this.run = { ...this.run, status }; }
  stop(_id: string): void { if (this.run) this.run = { ...this.run, status: "interrupted" }; }
  expose(_claim: Claim, _ref: ContextRef): null { return null; }
  contextRefs(_runId: string): readonly ContextRef[] { return []; }
  commit(_claim: Claim, operation: Operation): OperationResult {
    this.operations.push(operation);
    const thought: Thought = { id: "owned", text: operation.text, author: "ai", title: null, titleAuthor: null, kind: "developing-idea", createdAt: "2030-01-02T00:00:00Z", origin: "development", parentId: operation.parentId, sourceIds: operation.sourceIds };
    return { thought };
  }
  receipt(_runId: string, _operationId: string): Receipt | null { return null; }
  recordPartial(_claim: Claim, _draft: ReplyDraft): void {}
  reply(_runId: string): SharedResponse | null { return null; }
  finish(_claim: Claim, _response: SharedResponse): void {}
}

function fixture() {
  const repository = new ControlledRepository();
  const submits: string[][] = [];
  const observations: string[][] = [];
  let fail = false;
  const dispatcher: NativeDispatcher = {
    async submit(session, prompt) { submits.push([session, prompt]); if (fail) throw new Error("lost admission acknowledgement"); },
    async observe(session, prompt) { observations.push([session, prompt]); return "running"; },
  };
  let sequence = 0;
  const service = new RunService({ repository, dispatcher, id: () => `id-${++sequence}`, now: () => "2030-01-02T00:00:00Z" });
  return { service, repository, submits, observations, loseAck: () => { fail = true; } };
}

describe("durable run service", () => {
  test("evolve admission assigns app and native identities and saves the user contribution together", () => {
    const t = fixture();
    const admitted = t.service.admit("user", "evolve", { parentId: "parent", text: "user contribution" });
    expect(t.repository.admissions).toEqual([admitted]);
    expect(admitted.run).toEqual({ id: "id-1", kind: "evolve", status: "queued", sessionId: "id-2", promptId: "id-3", createdAt: "2030-01-02T00:00:00Z", generation: 0, inputThoughtId: "id-4", nativeState: "unknown" });
    expect(admitted.contribution).toEqual({ id: "id-4", text: "user contribution", title: null, titleAuthor: null, author: "user", kind: "user-contribution", origin: "contribution", createdAt: "2030-01-02T00:00:00Z", parentId: "parent", sourceIds: [] });
  });

  test("lost acknowledgement transitions uncertain and recovery observes the same identity without resubmitting", async () => {
    const t = fixture();
    const admitted = t.service.admit("user", "weave");
    const claim = t.service.claim(admitted.run.id);
    t.loseAck();
    await expect(t.service.submit(claim)).rejects.toThrow(RunAdmissionError);
    expect(t.repository.transitions).toEqual(["submitting", "uncertain"]);
    expect(t.submits).toEqual([[admitted.run.sessionId, admitted.run.promptId]]);
    await t.service.recover(admitted.run.id);
    expect(t.observations).toEqual([[admitted.run.sessionId, admitted.run.promptId]]);
    expect(t.submits).toHaveLength(1);
    expect(t.repository.run?.status).toBe("running");
  });

  test("readonly export cannot dispatch knowledge writes even with model-supplied operation arguments", () => {
    const t = fixture();
    const admitted = t.service.admit("user", "export");
    const claim = t.service.claim(admitted.run.id);
    expect(() => t.service.execute(claim, { id: "op", type: "development", parentId: "parent", text: "forged user content", sourceIds: [] })).toThrow(RunForbiddenError);
    expect(t.repository.operations).toEqual([]);
  });
});
