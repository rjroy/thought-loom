import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { RunConflictError, RunFenceError, type Claim, type RunKind, type RunRecord, type RunSources } from "../domain/run";
import { parseEnvelope, type RunStep } from "../domain/run-protocol";
import { SqliteAgentBindings } from "../storage/agent-binding";
import { SqliteCapabilityDispatcher } from "../storage/capability";
import { SqliteRunOperations } from "../storage/run-operations";
import { SqliteRunProtocolRepository } from "../storage/run-protocol";
import { SqliteRunRepository } from "../storage/run";
import { SqliteRunWorkerState } from "../storage/run-worker";
import { SqliteAgenticExports } from "../storage/agentic-export";
import { AgentBindingError, assertBindingPermissions, normalizeBinding } from "./binding";
import type { AgentBinding, NativePhase, Observation, PersistedPrompt } from "./opencode-adapter";
import { capabilityResultPrompt, initialWorkerPrompt } from "./worker-prompts";
import { SqliteSearchCapabilityDispatcher } from "../storage/search-capability";
import { SqliteSearchPromptClock } from "../storage/search-prompt-clock";
import type { SearchClockDependencies } from "../domain/search-time";
import type { ExecutionOwnerLease } from "../storage/execution-owner";
import { SqliteSearchCleanup } from "../storage/search-cleanup";
import type { SearchAdmissionFact, SearchCleanupIdentity, SearchCleanupObservation } from "./search-cleanup-contract";
import { SqliteSearchRetention } from "../storage/search-retention";

/** Native calls are outside SQLite transactions. Production supplies OpenCodeAdapter. */
export interface WorkerNative {
  ensureSession(claim: Claim, binding: AgentBinding): Promise<void>;
  /** Must commit the supplied bindings' "submit" phase before external dispatch. Prepared/queued therefore proves no dispatch. */
  submit(claim: Claim, binding: AgentBinding, prompt: PersistedPrompt, onAdmission?: (fact: SearchAdmissionFact) => void): Promise<void>;
  observe(claim: Claim, binding: AgentBinding, prompts: readonly PersistedPrompt[]): Promise<Observation>;
  cancel(runId: string, binding: AgentBinding, prompt: PersistedPrompt): Promise<"pending" | "settled">;
  /** Cancellation-only sealed metadata; isolated ordinary fixtures need not implement this port. */
  cancelSearch?(identity: SearchCleanupIdentity, authorize: () => void): Promise<SearchCleanupObservation>;
}
interface WorkerOwnershipDependencies extends RunSources {
  readonly db: Database;
  readonly searchClock?: SearchClockDependencies;
  readonly executionOwner?: ExecutionOwnerLease;
}
export type WorkerDependencies = WorkerOwnershipDependencies & ({
  /** Bind the supplied bindings.assertActive to its receiver; it fences SQL claims/context and local pause around native calls. */
  readonly native: (bindings: SqliteAgentBindings) => WorkerNative;
  /** Select only for an unbound run; a persisted binding takes precedence on restart. */
  readonly bindingFor: (run: RunRecord) => AgentBinding | null;
} | {
  /** Configless runtime owns local retention/lifetime only: no native producer, selection or cleanup polling. */
  readonly native?: never;
  readonly bindingFor?: never;
});

class WorkerPaused extends RunFenceError {}
class WorkerRetired extends RunFenceError {}
/** The real adapter binds this actual method, so pause also fences its intermediate asynchronous callbacks. */
class WorkerBindings extends SqliteAgentBindings {
  constructor(db: Database, private readonly localFence: (runId: string) => void, logger: Logger, executionOwner?: ExecutionOwnerLease) { super(db,logger,executionOwner); }
  override assertActive(claim: Claim, prompt?: PersistedPrompt, phase?: NativePhase): readonly PersistedPrompt[] | void {
    this.localFence(claim.runId);
    return super.assertActive(claim,prompt,phase);
  }
  override bind(runId: string, binding: AgentBinding, claim?: Claim): void {
    this.localFence(runId);
    super.bind(runId,binding,claim);
  }
}
const terminal = (run: RunRecord): boolean => ["completed","interrupted","failed"].includes(run.status);
interface RunFlight { readonly execution: Promise<void>; readonly cleanupTail: Promise<void>; retired: boolean }

/** Manual polling seam; the daemon supervisor owns scheduling and can drive independent runs. */
export class RunWorker {
  private readonly logger: Logger;
  private readonly bindings: WorkerBindings;
  private readonly runs: SqliteRunRepository;
  private readonly steps: SqliteRunProtocolRepository;
  private readonly operations: SqliteRunOperations;
  private readonly capabilities: SqliteCapabilityDispatcher;
  private readonly searchCapabilities: SqliteSearchCapabilityDispatcher;
  private readonly searchClock: SqliteSearchPromptClock;
  private readonly state: SqliteRunWorkerState;
  private readonly exports: SqliteAgenticExports;
  private readonly owners = new Map<string,Claim>();
  private readonly flights = new Map<string,RunFlight>();
  private readonly cleanup: SqliteSearchCleanup;
  private retention: SqliteSearchRetention | undefined;
  private readonly cleanupListeners = new Set<() => void>();
  private readonly unavailable = new Set<string>();
  private readonly ensured = new Set<string>();
  private native: WorkerNative | undefined;
  private paused = false;
  constructor(private readonly dependencies: WorkerDependencies) {
    const {db} = dependencies;
    this.logger = dependencies.logger ?? createLogger();
    this.bindings = new WorkerBindings(db,runId => {
      if (this.paused) throw new WorkerPaused();
      if (this.flights.get(runId)?.retired) throw new WorkerRetired();
      this.dependencies.executionOwner?.assertHeld();
    },this.logger,dependencies.executionOwner);
    this.runs = new SqliteRunRepository(db,dependencies);
    this.searchClock = new SqliteSearchPromptClock(db,dependencies.now,dependencies.searchClock);
    this.steps = new SqliteRunProtocolRepository(db,this.logger,this.searchClock);
    this.operations = new SqliteRunOperations(db,dependencies);
    this.capabilities = new SqliteCapabilityDispatcher(db,dependencies);
    this.searchCapabilities = new SqliteSearchCapabilityDispatcher(db,dependencies);
    this.state = new SqliteRunWorkerState(db,dependencies,this.searchClock);
    this.exports = new SqliteAgenticExports(db,dependencies);
    this.cleanup = new SqliteSearchCleanup(db,dependencies.executionOwner,this.logger);
  }
  tick(runId: string, beforePoll?: () => Promise<void>): Promise<void> {
    if (this.paused || !this.dependencies.native) return Promise.resolve();
    const existing = this.flights.get(runId);
    if (existing) return existing.cleanupTail;
    // Defer execution until the in-flight entry exists; simultaneous polls share one boundary, not two submissions.
    const execution = Promise.resolve().then(async () => {
      if (this.paused) return;
      this.dependencies.executionOwner?.assertHeld();
      if (this.cleanup.isPurged(runId)) return; // Cancellation-only identity, never infer an execution run/binding from its outbox.
      if (beforePoll) await beforePoll();
      if (!this.paused && !this.flights.get(runId)?.retired) {
        this.dependencies.executionOwner?.assertHeld();
        await this.poll(runId);
      }
    });
    // The tail is registered with execution, and runs only after that actual promise settles. Never await it from poll/cancel.
    const cleanupTail = execution.then(() => this.cleanupSearch(runId),async error => {
      await this.cleanupSearch(runId); throw error;
    }).finally(() => this.flights.delete(runId));
    this.flights.set(runId,{execution,cleanupTail,retired:false});
    return cleanupTail;
  }
  private active(claim: Claim, prompt?: PersistedPrompt): void {
    if (this.paused) throw new WorkerPaused();
    this.bindings.assertActive(claim,prompt);
  }
  private transport(): WorkerNative {
    const factory = this.dependencies.native;
    if (!factory) throw new RunFenceError("Native execution is unconfigured");
    return this.native ??= factory(this.bindings);
  }
  private forget(runId: string): void {
    this.owners.delete(runId); this.ensured.delete(runId);
    this.searchClock.forget(runId);
    for (const key of this.unavailable) if (key.startsWith(`${runId}:`)) this.unavailable.delete(key);
  }
  private prompts(runId: string): readonly PersistedPrompt[] {
    return this.steps.steps(runId).map(step => {
      if (step.input === null) throw new RunConflictError("Exact historical prompt input is unavailable");
      return {promptId:step.promptId,input:step.input};
    });
  }
  private async poll(runId: string): Promise<void> {
    if (this.paused) return;
    let claim = this.owners.get(runId);
    try {
      const run = this.runs.get(runId);
      if (!run) { this.searchClock.forget(runId); throw new RunConflictError("Worker run does not exist"); }
      if (run.kind !== "weave" && run.kind !== "evolve" && run.kind !== "export" && run.kind !== "search") return; // Import dispatch belongs to its separately authorized worker.
      if (terminal(run)) { this.forget(runId); await this.cancel(run); return; }
      let binding = this.bindings.get(runId);
      if (!binding) {
        const selected = this.dependencies.bindingFor?.(Object.freeze({...run})) ?? null;
        if (selected === null) return; // No claim, preparation, client construction, or HTTP without configuration.
        binding = normalizeBinding(selected);
      }
      assertBindingPermissions(run.kind,binding);
      if (!claim) { claim = this.runs.claim(runId); this.owners.set(runId,claim); }
      const owner = claim;
      this.active(owner);
      if (run.kind === "export" && this.exports.intent(run.id) === null) throw new RunConflictError("Legacy export request is unavailable; cannot resume safely");
      const step = this.steps.steps(runId).at(-1);
      if (!step) throw new RunConflictError("Run has no current step");
      if (step.input === null) {
        this.state.prepareInitial(owner,context => initialWorkerPrompt(context,binding));
        this.bindings.bind(runId,binding,owner);
        return;
      }
      if (!this.bindings.get(runId)) { this.bindings.bind(runId,binding,owner); return; }
      const prompt = {promptId:step.promptId,input:step.input};
      this.active(owner,prompt);
      if (step.envelope !== null) { this.process(owner,step,run.kind,binding); return; }
      if (!this.ensured.has(runId)) {
        if ((await this.call(owner,prompt,"ensure session",() => this.transport().ensureSession(owner,binding))).ok) this.ensured.add(runId);
        return;
      }
      const current = this.runs.get(runId);
      if (!current) throw new RunConflictError();
      if (current.status === "queued" && step.state === "prepared") {
        const submitted = await this.call(owner,prompt,"submit",() => this.transport().submit(owner,binding,prompt,
          run.kind !== "search" ? undefined : fact => {
            try { this.cleanup.recordAdmission(fact); }
            catch { this.logger.warning("[search cleanup] admission metadata remains uncertain",{runId,promptId:prompt.promptId}); }
          }));
        if (submitted.ok && this.runs.get(runId)?.status === "queued") {
          // An implementation that reports successful dispatch without durable intent violates WorkerNative's contract.
          // Fail closed instead of inventing uncertainty or allowing another dispatch on the next tick.
          throw new RunConflictError("Native submission succeeded without recording its intent");
        }
        return;
      }
      // Recorded submission/native uncertainty is observation-only, even when native history is empty.
      const prompts = this.prompts(runId);
      const observed = await this.call(owner,prompt,"observe",() => this.transport().observe(owner,binding,prompts));
      if (!observed.ok) return;
      const observation = observed.value;
      this.bindings.assertActive(owner,prompt,observation.state);
      if (observation.state === "completed") this.steps.completeStep(owner,prompt.promptId,parseEnvelope(observation.output));
    } catch (error) {
      if (this.paused) return;
      if (error instanceof RunFenceError) {
        this.searchClock.forget(runId);
        const run = this.runs.get(runId);
        if (run && terminal(run)) { this.forget(runId); await this.cancel(run); }
        return; // A newer worker owns an active run. This worker never reclaims it on a later poll.
      }
      if (!claim) throw error;
      this.logger.error("[worker] local processing failed",{runId,generation:claim.generation});
      try { this.active(claim); this.operations.fail(claim); this.forget(runId); }
      catch (failure) { if (!(failure instanceof RunFenceError)) throw failure; }
    }
  }
  private process(claim: Claim, step: RunStep, kind: RunKind, binding: AgentBinding): void {
    this.active(claim);
    if (kind === "search") {
      if (step.envelope?.kind === "search-reply") {
        this.state.finish(claim,step.promptId);
        this.logger.info("[worker] run completed", { runId: claim.runId, kind });
        this.forget(claim.runId); return;
      }
      if (step.envelope?.kind !== "request") throw new RunConflictError("A strict search request or reply is required");
      this.searchCapabilities.dispatch(claim,step.promptId);
      if (step.result === null) return;
      this.steps.advanceSearch(claim,step.promptId,() => this.dependencies.promptId?.() ?? `msg_${this.dependencies.id()}`);
      return;
    }
    if (step.envelope?.kind === "complete" || step.envelope?.kind === "report") {
      this.state.finish(claim,step.promptId);
      this.logger.info("[worker] run completed", { runId: claim.runId, kind });
      this.forget(claim.runId); return;
    }
    if (step.envelope?.kind !== "request") throw new RunConflictError("Completed step has no canonical envelope");
    const result = this.capabilities.dispatch(claim,step.promptId,step.envelope.request);
    if (step.result === null) return;
    this.steps.advance(claim,step.promptId,result,{promptId:this.dependencies.promptId?.() ?? this.dependencies.id(),input:capabilityResultPrompt(step.envelope.request,result,kind,binding)});
  }
  private async call<T>(claim: Claim, prompt: PersistedPrompt, operation: "ensure session" | "submit" | "observe", action: () => Promise<T>): Promise<{readonly ok:true;readonly value:T} | {readonly ok:false}> {
    this.active(claim,prompt);
    const key = `${claim.runId}:${operation}`;
    this.logger.verbose("[worker] native boundary attempt",{runId:claim.runId,promptId:prompt.promptId,generation:claim.generation,operation});
    try {
      const value = await action();
      this.active(claim,prompt);
      if (this.unavailable.delete(key)) this.logger.info("[worker] native service recovered", { runId: claim.runId, operation });
      this.logger.verbose("[worker] native boundary succeeded",{runId:claim.runId,promptId:prompt.promptId,generation:claim.generation,operation});
      return {ok:true,value};
    } catch (error) {
      if (this.paused || error instanceof RunFenceError) throw error;
      if (error instanceof AgentBindingError) { this.bindings.assertActive(claim,prompt,"quarantined"); throw error; }
      if (!this.unavailable.has(key)) {
        this.unavailable.add(key);
        this.logger.warning("[worker] native service unavailable", { runId: claim.runId, operation });
      } else this.logger.verbose("[worker] native boundary remains unavailable",{runId:claim.runId,operation});
      if (operation === "submit") this.state.submissionFailed(claim,prompt.promptId);
      return {ok:false};
    }
  }
  private async cancel(run: RunRecord): Promise<void> {
    // Search is appended as this lane's tail after execution joins, never self-joined from poll's fence handler.
    if (run.kind === "search") return;
    if (this.paused || !["interrupted","failed"].includes(run.status) || this.steps.cancellation(run.id) !== "pending") return;
    if (this.state.settleUnsubmitted(run.id)) return;
    const binding = this.bindings.get(run.id);
    if (!binding) return;
    const step = this.steps.steps(run.id).at(-1);
    if (!step || step.input === null) return; // Unknown legacy input/binding is never fabricated for cleanup.
    this.logger.verbose("[worker] cancellation attempt",{runId:run.id,promptId:step.promptId});
    try {
      const result = await this.transport().cancel(run.id,binding,{promptId:step.promptId,input:step.input});
      if (this.paused) return;
      if (result === "settled") this.steps.settleCancellation(run.id);
      this.logger.verbose("[worker] cancellation outcome",{runId:run.id,promptId:step.promptId,state:result});
    } catch { this.logger.verbose("[worker] cancellation remains pending",{runId:run.id,promptId:step.promptId}); }
  }
  private async cleanupSearch(runId: string): Promise<void> {
    if (this.paused || !this.dependencies.native) return;
    try {
      const identity = this.cleanup.prepare(runId);
      if (!identity || this.paused || !this.cleanup.drained(identity)) return;
      const native = this.transport();
      if (!native.cancelSearch) return;
      const authorize = () => {
        if (this.paused) throw new WorkerPaused();
        this.cleanup.authorize(identity);
      };
      authorize();
      const observed = await native.cancelSearch(identity,authorize);
      authorize();
      this.cleanup.observed(identity,observed);
    } catch {
      this.logger.verbose("[search cleanup] cancellation remains pending",{runId});
    }
  }
  /** Trusted retention hook; this is not cancellation or a change to execution ownership. */
  forgetSearchClock(runId: string): void { this.searchClock.forget(runId); }
  /** Local ownership does not require a native port. A fixture without a deployed lease cannot authorize bound purge. */
  searchRetention(): SqliteSearchRetention | null {
    const owner = this.dependencies.executionOwner;
    if (!owner) return null;
    return this.retention ??= SqliteSearchRetention.forWorker(this.dependencies.db,owner,ids => {
      for (const id of ids) {
        const lane = this.flights.get(id);
        if (lane) lane.retired = true; // Capture/retain its existing execution and cleanup promises, never delete or self-join them.
        this.forget(id);
      }
      if (!this.paused) for (const notify of this.cleanupListeners) {
        try { notify(); } catch { this.logger.warning("[search cleanup] scanner notification deferred"); }
      }
    },this.logger);
  }
  onSearchCleanupAvailable(notify: () => void): () => void {
    if (this.paused) return () => {};
    this.cleanupListeners.add(notify);
    return () => { this.cleanupListeners.delete(notify); };
  }
  /** Join actual execution and serialized cleanup tails after admission is paused, including direct non-supervisor ticks. */
  async drain(): Promise<readonly PromiseSettledResult<void>[]> {
    if (!this.paused) throw new RunConflictError("Worker drain requires pause");
    return Promise.allSettled([...this.flights.values()].map(flight => flight.cleanupTail));
  }
  /** Local shutdown only: never a user Stop. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.searchClock.clear();
    this.cleanupListeners.clear();
    this.logger.verbose("[worker] paused",{ownedRuns:this.owners.size,activeTicks:this.flights.size});
  }
}
