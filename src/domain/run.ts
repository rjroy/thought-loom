import { createThought } from "./thought";
import { nonEmpty } from "./validation";
import type { Thought } from "./thought";
import type { Connection } from "./connection";
import type { SharedResponse } from "./shared-response";

export type RunKind = "weave" | "evolve" | "export";
export type RunStatus = "queued" | "submitting" | "running" | "uncertain" | "completed" | "interrupted" | "failed";
export type NativeState = "unknown" | "running" | "completed";
export type ContextRef = { readonly kind: "thought" | "connection" | "response"; readonly id: string };
export type ContextValue = Thought | Connection | SharedResponse;
export interface RunRecord {
  readonly id: string;
  readonly kind: RunKind;
  readonly status: RunStatus;
  readonly sessionId: string;
  readonly promptId: string;
  readonly createdAt: string;
  readonly generation: number;
  /** Exact admitted contribution; a legacy evolve run with no mapping cannot resume. */
  readonly inputThoughtId: string | null;
  /** Native observation is distinct from locally committed finalization. */
  readonly nativeState: NativeState;
}
export interface Claim { readonly runId: string; readonly generation: number }
export interface Operation {
  readonly id: string;
  readonly type: "development";
  readonly parentId: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}
export interface OperationResult { readonly thought: Thought }
export interface Receipt { readonly operation: Operation; readonly result: OperationResult }
export interface Admission { readonly run: RunRecord; readonly contribution: Thought | null }
export type ReplyDraft = Omit<SharedResponse, "state">;
export interface Recovery {
  readonly run: RunRecord;
  readonly claim: Claim;
  /** Reconcile existing native output, continue observation, or resume the existing run. Never resubmit. */
  readonly action: "finalize" | "observe" | "resume";
}

/** Atomic methods own all related knowledge writes and receipts inside their transaction. */
export interface RunRepository {
  admit(admission: Admission): void;
  get(id: string): RunRecord | null;
  claim(id: string): Claim;
  /** Revalidate ownership and all exposed context atomically with the transition, including submission authorization. */
  setStatus(claim: Claim, status: RunStatus, nativeState?: NativeState): void;
  stop(id: string): void;
  expose(claim: Claim, ref: ContextRef): ContextValue | null;
  contextRefs(runId: string): readonly ContextRef[];
  commit(claim: Claim, operation: Operation): OperationResult;
  receipt(runId: string, operationId: string): Receipt | null;
  recordPartial(claim: Claim, draft: ReplyDraft): void;
  reply(runId: string): SharedResponse | null;
  finish(claim: Claim, response: SharedResponse): void;
}
export interface NativeDispatcher {
  submit(sessionId: string, promptId: string): Promise<void>;
  observe(sessionId: string, promptId: string): Promise<NativeState>;
}
export interface RunDependencies {
  readonly repository: RunRepository;
  readonly dispatcher: NativeDispatcher;
  readonly id: () => string;
  readonly now: () => string;
}
export class RunNotFoundError extends Error {}
export class RunForbiddenError extends Error {}
export class RunConflictError extends Error {}
export class RunFenceError extends Error {}
export class RunAdmissionError extends Error {}

/** Admission of an evolve run and its contribution is a single repository transaction. */
export class RunService {
  constructor(private readonly deps: RunDependencies) {}
  admit(actor: "user", kind: RunKind, contribution?: { readonly parentId: string; readonly text: string }): Admission {
    if (actor !== "user") throw new RunForbiddenError();
    if (!["weave", "evolve", "export"].includes(kind) || (kind === "evolve") !== (contribution !== undefined)) throw new RunAdmissionError();
    const { id, now, repository } = this.deps;
    const identity = { id: id(), sessionId: id(), promptId: id(), createdAt: now() };
    const thought = contribution ? createThought({ id: id(), text: contribution.text, parentId: nonEmpty(contribution.parentId, "parentId"), title: null, titleAuthor: null,
      author: "user", kind: "user-contribution", origin: "contribution", createdAt: identity.createdAt, sourceIds: [] }) : null;
    const run: RunRecord = Object.freeze({ ...identity, kind, status: "queued", generation: 0, inputThoughtId: thought?.id ?? null, nativeState: "unknown" });
    const admission = { run, contribution: thought };
    repository.admit(admission);
    return admission;
  }
  claim(id: string): Claim { return this.deps.repository.claim(id); }
  async submit(claim: Claim): Promise<void> {
    const repo = this.deps.repository;
    const run = repo.get(claim.runId);
    if (!run) throw new RunNotFoundError();
    // This synchronous transaction is the authorization point; the external call owns no SQL lock.
    repo.setStatus(claim, "submitting");
    console.info("[run] native submit attempt", { runId: run.id, generation: claim.generation });
    try { await this.deps.dispatcher.submit(run.sessionId, run.promptId); }
    catch {
      console.error("[run] native submit uncertain", { runId: run.id, generation: claim.generation });
      // A Stop, rejected context, or a newer owner wins over even a failed acknowledgement.
      repo.setStatus(claim, "uncertain");
      throw new RunAdmissionError("Native submission outcome uncertain");
    }
    console.info("[run] native submit acknowledged", { runId: run.id, generation: claim.generation });
    repo.setStatus(claim, "running");
  }
  async recover(id: string): Promise<Recovery> {
    const repo = this.deps.repository;
    const run = repo.get(id);
    if (!run) throw new RunNotFoundError();
    if (!["submitting", "uncertain", "running"].includes(run.status)) throw new RunConflictError();
    const claim = repo.claim(id);
    let observed = run.nativeState;
    if (observed !== "completed") {
      console.info("[run] native observe attempt", { runId: run.id, generation: claim.generation });
      try { observed = await this.deps.dispatcher.observe(run.sessionId, run.promptId); }
      catch {
        console.error("[run] native observe uncertain", { runId: run.id, generation: claim.generation });
        repo.setStatus(claim, "uncertain", "unknown");
        throw new RunAdmissionError("Native observation outcome uncertain");
      }
      console.info("[run] native observe succeeded", { runId: run.id, generation: claim.generation, nativeState: observed });
    }
    repo.setStatus(claim, observed === "running" ? "running" : "uncertain", observed);
    const reconciled = repo.get(id);
    if (!reconciled) throw new RunNotFoundError();
    return { run: reconciled, claim, action: reconciled.nativeState === "completed" ? "finalize" : reconciled.nativeState === "running" ? "resume" : "observe" };
  }
  stop(actor: "user", id: string): void { if (actor !== "user") throw new RunForbiddenError(); this.deps.repository.stop(id); }
  context(claim: Claim, ref: ContextRef): ContextValue | null { return this.deps.repository.expose(claim, ref); }
  execute(claim: Claim, operation: Operation): OperationResult {
    const run = this.deps.repository.get(claim.runId);
    if (!run) throw new RunNotFoundError();
    if (run.kind === "export") throw new RunForbiddenError();
    return this.deps.repository.commit(claim, operation);
  }
  recordPartial(claim: Claim, draft: ReplyDraft): void { this.deps.repository.recordPartial(claim, draft); }
  finish(claim: Claim, response: SharedResponse): void { this.deps.repository.finish(claim, response); }
}
