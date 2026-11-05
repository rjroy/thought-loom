import { createLogger } from "../logging";
import { createThought } from "./thought";
import { nonEmpty } from "./validation";
import type { Thought } from "./thought";
import type { Connection } from "./connection";
import type { SharedResponse } from "./shared-response";

export type RunKind = "weave" | "evolve" | "export" | "import";
export type OrdinaryRunKind = Exclude<RunKind, "import">;
export function requireOrdinaryRun(run: RunRecord): void {
  if (run.kind !== "weave" && run.kind !== "evolve" && run.kind !== "export") throw new RunForbiddenError("Ordinary run authority required");
}
export type RunStatus = "queued" | "submitting" | "running" | "uncertain" | "completed" | "interrupted" | "failed";
export type NativeState = "unknown" | "running" | "completed";
export type ContextRef = { readonly kind: "thought" | "connection" | "response"; readonly id: string };
export type ContextValue = Thought | Connection | SharedResponse;
export interface RunRecord {
  readonly id: string;
  readonly kind: RunKind;
  readonly status: RunStatus;
  /** Effective native identity from the immutable binding, or the initially allocated identity before binding. */
  readonly sessionId: string;
  /** Current prompt projection; each prompt's immutable identity and exact input live in the ordered steps. */
  readonly promptId: string;
  readonly createdAt: string;
  readonly generation: number;
  /** Exact admitted contribution; a legacy evolve run with no mapping cannot resume. */
  readonly inputThoughtId: string | null;
  /** Current step's native observation, distinct from locally committed run finalization. */
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
  /** Finalize the current prompt's native output (request or reply), observe, or resume. Never resubmit. */
  readonly action: "finalize" | "observe" | "resume";
}

/** Atomic methods own all related knowledge writes and receipts inside their transaction. */
export interface RunRepository {
  admit(admission: Admission): void;
  get(id: string): RunRecord | null;
  claim(id: string): Claim;
  /** Revalidate ownership/context atomically. Async callbacks also bind their original promptId so they cannot affect a later step. */
  setStatus(claim: Claim, status: RunStatus, nativeState?: NativeState, promptId?: string): void;
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
export interface RunSources {
  readonly logger?: import("../logging").Logger;
  readonly id: () => string;
  readonly now: () => string;
  readonly sessionId?: () => string;
  readonly promptId?: () => string;
}
export interface RunDependencies extends RunSources {
  readonly repository: RunRepository;
  readonly dispatcher: NativeDispatcher;
}
export class RunNotFoundError extends Error {}
export class RunForbiddenError extends Error {}
export class RunConflictError extends Error {}
export class RunFenceError extends Error {}
export class RunAdmissionError extends Error {}

/** Admission has no native transport dependency; the repository commits run and contribution together. */
export class RunAdmissionService {
  constructor(private readonly deps: RunSources & { readonly repository: RunRepository }) {}
  admit(actor: "user", kind: OrdinaryRunKind, contribution?: { readonly parentId: string; readonly text: string }): Admission {
    if (actor !== "user") throw new RunForbiddenError();
    if (!["weave", "evolve", "export"].includes(kind) || (kind === "evolve") !== (contribution !== undefined)) throw new RunAdmissionError();
    const { id, now, repository } = this.deps;
    const identity = { id: id(), sessionId: this.deps.sessionId?.() ?? id(), promptId: this.deps.promptId?.() ?? id(), createdAt: now() };
    const thought = contribution ? createThought({ id: id(), text: contribution.text, parentId: nonEmpty(contribution.parentId, "parentId"), title: null, titleAuthor: null,
      author: "user", kind: "user-contribution", origin: "contribution", createdAt: identity.createdAt, sourceIds: [] }) : null;
    const run: RunRecord = Object.freeze({ ...identity, kind, status: "queued", generation: 0, inputThoughtId: thought?.id ?? null, nativeState: "unknown" });
    const admission = { run, contribution: thought };
    repository.admit(admission);
    return admission;
  }
}

export class RunService {
  constructor(private readonly deps: RunDependencies) {}
  admit(actor: "user", kind: OrdinaryRunKind, contribution?: { readonly parentId: string; readonly text: string }): Admission {
    return new RunAdmissionService(this.deps).admit(actor,kind,contribution);
  }
  claim(id: string): Claim { return this.deps.repository.claim(id); }
  async submit(claim: Claim): Promise<void> {
    const repo = this.deps.repository;
    const run = repo.get(claim.runId);
    if (!run) throw new RunNotFoundError();
    requireOrdinaryRun(run);
    // This synchronous transaction is the authorization point; the external call owns no SQL lock.
    repo.setStatus(claim, "submitting", undefined, run.promptId);
    (this.deps.logger ?? createLogger()).verbose("[run] native submit attempt", { runId: run.id, promptId: run.promptId, generation: claim.generation });
    try { await this.deps.dispatcher.submit(run.sessionId, run.promptId); }
    catch {
      (this.deps.logger ?? createLogger()).warning("[run] native submit uncertain", { runId: run.id, promptId: run.promptId, generation: claim.generation });
      // A Stop, rejected context, or a newer owner wins over even a failed acknowledgement.
      repo.setStatus(claim, "uncertain", undefined, run.promptId);
      throw new RunAdmissionError("Native submission outcome uncertain");
    }
    (this.deps.logger ?? createLogger()).verbose("[run] native submit acknowledged", { runId: run.id, promptId: run.promptId, generation: claim.generation });
    repo.setStatus(claim, "running", undefined, run.promptId);
  }
  async recover(id: string): Promise<Recovery> {
    const repo = this.deps.repository;
    const run = repo.get(id);
    if (!run) throw new RunNotFoundError();
    requireOrdinaryRun(run);
    if (!["submitting", "uncertain", "running"].includes(run.status)) throw new RunConflictError();
    const claim = repo.claim(id);
    let observed = run.nativeState;
    if (observed !== "completed") {
      (this.deps.logger ?? createLogger()).verbose("[run] native observe attempt", { runId: run.id, promptId: run.promptId, generation: claim.generation });
      try { observed = await this.deps.dispatcher.observe(run.sessionId, run.promptId); }
      catch {
        (this.deps.logger ?? createLogger()).warning("[run] native observe uncertain", { runId: run.id, promptId: run.promptId, generation: claim.generation });
        repo.setStatus(claim, "uncertain", "unknown", run.promptId);
        throw new RunAdmissionError("Native observation outcome uncertain");
      }
      (this.deps.logger ?? createLogger()).verbose("[run] native observe succeeded", { runId: run.id, promptId: run.promptId, generation: claim.generation, nativeState: observed });
    }
    repo.setStatus(claim, observed === "running" ? "running" : "uncertain", observed, run.promptId);
    const reconciled = repo.get(id);
    if (!reconciled) throw new RunNotFoundError();
    return { run: reconciled, claim, action: reconciled.nativeState === "completed" ? "finalize" : reconciled.nativeState === "running" ? "resume" : "observe" };
  }
  stop(actor: "user", id: string): void { if (actor !== "user") throw new RunForbiddenError(); this.deps.repository.stop(id); }
  context(claim: Claim, ref: ContextRef): ContextValue | null { return this.deps.repository.expose(claim, ref); }
  execute(claim: Claim, operation: Operation): OperationResult {
    const run = this.deps.repository.get(claim.runId);
    if (!run) throw new RunNotFoundError();
    if (run.kind !== "weave" && run.kind !== "evolve") throw new RunForbiddenError();
    return this.deps.repository.commit(claim, operation);
  }
  recordPartial(claim: Claim, draft: ReplyDraft): void { this.deps.repository.recordPartial(claim, draft); }
  finish(claim: Claim, response: SharedResponse): void { this.deps.repository.finish(claim, response); }
}
