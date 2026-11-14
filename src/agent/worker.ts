import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import { recordedSubjectCancellationSafe } from "../storage/run-cancellation";
import { RunConflictError, RunFenceError, RunNotFoundError, type Claim, type RunKind, type RunRecord, type RunSources } from "../domain/run";
import { parseEnvelope, ProtocolValidationError, type OrdinaryCancellationJournal, type RunStep } from "../domain/run-protocol";
import type { Thought } from "../domain/thought";
import { SqliteAgentBindings } from "../storage/agent-binding";
import { SqliteCapabilityDispatcher } from "../storage/capability";
import { SqliteRunOperations } from "../storage/run-operations";
import { SqliteRunProtocolRepository } from "../storage/run-protocol";
import { SqliteRunRepository } from "../storage/run";
import { SqliteRunWorkerState } from "../storage/run-worker";
import { screeningPolicy } from "../domain/connection-screening";
import { SqliteAgenticExports } from "../storage/agentic-export";
import { AgentBindingError, allowsNativeTools, assertBindingPermissions, normalizeBinding } from "./binding";
import type { AgentBinding, NativePhase, Observation, PersistedPrompt } from "./opencode-adapter";
import { capabilityResultPrompt, initialWorkerPrompt, type MediaPath } from "./worker-prompts";
import { SqliteSearchCapabilityDispatcher } from "../storage/search-capability";
import { SqliteSearchPromptClock } from "../storage/search-prompt-clock";
import type { SearchClockDependencies } from "../domain/search-time";
import type { ExecutionOwnerLease } from "../storage/execution-owner";
import { SqliteSearchCleanup } from "../storage/search-cleanup";
import type { SearchAdmissionFact, SearchCleanupIdentity, SearchCleanupObservation } from "./search-cleanup-contract";
import { SqliteSearchRetention } from "../storage/search-retention";
import { assertRunNotRestoreFenced, isRunRestoreFenced } from "../storage/restore-fences";

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
/** Content supplied to a caller-neutral local pair judgment, not an agent read witness. */
export interface ScreeningThought {
  readonly id: string;
  readonly text: string;
}
export interface ScreeningPair {
  readonly thoughtA: ScreeningThought;
  readonly thoughtB: ScreeningThought;
}
/** The returned probability nominates a candidate; it is not evidence of a connection. */
export interface ConnectionScreeningPort {
  /** Stable identity of the judge configuration and question policy, not a process or claim identity. */
  readonly identity: string;
  judge(pair: ScreeningPair): Promise<number>;
}
const SCREENING_CONCURRENCY = 4;
interface WorkerOwnershipDependencies extends RunSources {
  readonly db: Database;
  readonly searchClock?: SearchClockDependencies;
  readonly executionOwner?: ExecutionOwnerLease;
  /** Daemon-owned resolver; the worker scopes source IDs before requesting an absolute shared-filesystem path. */
  readonly mediaPath?: (sourceId: string) => Promise<string>;
  /** Optional local pair judge. External calls must occur outside guarded storage transactions. */
  readonly connectionScreening?: ConnectionScreeningPort;
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
  override initialGuidance(claim: Claim, prompt: PersistedPrompt): string | null {
    this.localFence(claim.runId);
    return super.initialGuidance(claim,prompt);
  }
  override bind(runId: string, binding: AgentBinding, claim?: Claim): void {
    this.localFence(runId);
    super.bind(runId,binding,claim);
  }
  override cancellationJournal(runId: string, prompt: PersistedPrompt): OrdinaryCancellationJournal {
    this.localFence(runId);
    return super.cancellationJournal(runId,prompt);
  }
  override assertCancellationJournal(journal: OrdinaryCancellationJournal): void {
    this.localFence(journal.runId);
    super.assertCancellationJournal(journal);
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
  private readonly retirements = new Map<string,Promise<unknown>>();
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
    this.bindings = new WorkerBindings(db,runId => this.localFence(runId),this.logger,dependencies.executionOwner);
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
    if (this.paused || !this.dependencies.native || this.retirements.has(runId)) return Promise.resolve();
    const existing = this.flights.get(runId);
    if (existing) return existing.cleanupTail;
    // Defer execution until the in-flight entry exists; simultaneous polls share one boundary, not two submissions.
    const execution = Promise.resolve().then(async () => {
      if (this.paused) return;
      this.dependencies.executionOwner?.assertHeld();
      if (isRunRestoreFenced(this.dependencies.db,runId)) { this.forget(runId); return; }
      if (this.cleanup.isPurged(runId)) return; // Cancellation-only identity, never infer an execution run/binding from its outbox.
      if (beforePoll) await beforePoll();
      if (!this.paused && !this.flights.get(runId)?.retired) {
        this.dependencies.executionOwner?.assertHeld();
        if (isRunRestoreFenced(this.dependencies.db,runId)) { this.forget(runId); return; }
        await this.poll(runId);
      }
    });
    // The tail is registered with execution, and runs only after that actual promise settles. Never await it from poll/cancel.
    const cleanupTail = execution.then(() => this.cleanupRun(runId),async error => {
      await this.cleanupRun(runId); throw error;
    }).finally(() => this.flights.delete(runId));
    this.flights.set(runId,{execution,cleanupTail,retired:false});
    return cleanupTail;
  }
  private active(claim: Claim, prompt?: PersistedPrompt): void {
    if (this.paused) throw new WorkerPaused();
    this.bindings.assertActive(claim,prompt);
  }
  private localFence(runId: string): void {
    if (this.paused) throw new WorkerPaused();
    if (this.flights.get(runId)?.retired) throw new WorkerRetired();
    this.dependencies.executionOwner?.assertHeld();
    assertRunNotRestoreFenced(this.dependencies.db,runId);
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
    let stage = "load-run";
    try {
      this.localFence(runId);
      const run = this.runs.get(runId);
      if (!run) { this.forget(runId); return; } // A locally deleted export/search owner cannot be reconstructed from a stale tick.
      if (run.kind !== "weave" && run.kind !== "evolve" && run.kind !== "export" && run.kind !== "search") return; // Import dispatch belongs to its separately authorized worker.
      if (terminal(run)) { this.forget(runId); return; }
      if (run.kind === "weave" && run.status === "queued" && !this.state.canDispatch(runId)) {
        this.logger.verbose("[worker] subject weave waiting",{runId});
        return;
      }
      stage = "select-binding";
      let binding = this.bindings.get(runId);
      if (!binding) {
        const selected = this.dependencies.bindingFor?.(Object.freeze({...run})) ?? null;
        if (selected === null) return; // No claim, preparation, client construction, or HTTP without configuration.
        binding = normalizeBinding(selected);
      }
      assertBindingPermissions(run.kind,binding);
      stage = "claim-run";
      if (!claim) { claim = this.runs.claim(runId); this.owners.set(runId,claim); }
      const owner = claim;
      stage = "load-step";
      this.active(owner);
      if (run.kind === "export" && this.exports.intent(run.id) === null) throw new RunConflictError("Legacy export request is unavailable; cannot resume safely");
      const step = this.steps.steps(runId).at(-1);
      if (!step) throw new RunConflictError("Run has no current step");
      if (step.input === null) {
        stage = "prepare-initial";
        const context = run.kind === "search" ? null : this.state.initialContext(owner);
        const paths = context === null || (context.job.kind === "weave" && context.job.purpose === "media-title-only")
          ? [] : await this.mediaPaths(owner,run.kind,binding,context.thoughts);
        this.active(owner);
        const job = context?.job;
        const subject = context && job?.kind === "weave" && job.purpose !== "media-title-only" && job.purpose !== "reinterpretation"
          ? context.thoughts.find(thought => thought.id === job.subjectId && thought.kind !== "media-original") : undefined;
        if (subject && this.state.ownsScreening(runId)) await this.screenConnections(owner,subject.id,this.dependencies.connectionScreening);
        this.active(owner);
        const prepared = this.state.prepareInitial(owner,context => initialWorkerPrompt(context,binding,paths),
          (context,nominations) => initialWorkerPrompt(context,binding,paths,nominations));
        if (prepared.input === null) return; // A skipped pair became unconnected; continue screening next tick.
        stage = "bind-session";
        this.bindings.bind(runId,binding,owner);
        return;
      }
      stage = "bind-session";
      if (!this.bindings.get(runId)) { this.bindings.bind(runId,binding,owner); return; }
      const prompt = {promptId:step.promptId,input:step.input};
      this.active(owner,prompt);
      if (step.envelope !== null) { stage = "process-envelope"; await this.process(owner,step,run.kind,binding); return; }
      if (!this.ensured.has(runId)) {
        stage = "ensure-session";
        if ((await this.call(owner,prompt,"ensure session",() => this.transport().ensureSession(owner,binding))).ok) this.ensured.add(runId);
        return;
      }
      stage = "load-step";
      const current = this.runs.get(runId);
      if (!current) throw new RunConflictError();
      if (current.status === "queued" && step.state === "prepared") {
        stage = "submit";
        const submitted = await this.call(owner,prompt,"submit",() => this.transport().submit(owner,binding,prompt,
           run.kind !== "search" ? undefined : fact => {
             try { assertRunNotRestoreFenced(this.dependencies.db,runId); this.cleanup.recordAdmission(fact); }
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
      stage = "observe";
      const prompts = this.prompts(runId);
      const observed = await this.call(owner,prompt,"observe",() => this.transport().observe(owner,binding,prompts));
      if (!observed.ok) return;
      const observation = observed.value;
      this.bindings.assertActive(owner,prompt,observation.state);
      if (observation.state === "completed") {
        stage = "parse-envelope";
        const envelope = parseEnvelope(observation.output);
        stage = "complete-step";
        this.steps.completeStep(owner,prompt.promptId,envelope);
      }
    } catch (error) {
      if (this.paused) return;
      if (error instanceof RunNotFoundError && this.runs.get(runId) === null) { this.forget(runId); return; }
      if (error instanceof RunFenceError) {
        this.searchClock.forget(runId);
        const run = this.runs.get(runId);
        if (run && terminal(run)) this.forget(runId);
        return; // A newer worker owns an active run. This worker never reclaims it on a later poll.
      }
      if (!claim) throw error;
      const category = error instanceof ProtocolValidationError ? "protocol-validation"
        : error instanceof AgentBindingError ? "binding"
        : error instanceof RunConflictError ? "run-conflict" : "unexpected";
      this.logger.error("[worker] local processing failed",{runId,generation:claim.generation,stage,category});
      try { this.active(claim); this.operations.fail(claim); this.forget(runId); }
      catch (failure) { if (!(failure instanceof RunFenceError)) throw failure; }
    }
  }
  private async screenConnections(claim: Claim, subjectId: string, port: ConnectionScreeningPort | undefined): Promise<void> {
    const candidateIds = this.state.beginScreening(claim,subjectId,port ? screeningPolicy(port.identity) : null);
    if (!port || candidateIds.length === 0) return;
    let next = 0, failed = false, failure: unknown;
    this.logger.verbose("[worker] screening attempt",{runId:claim.runId,generation:claim.generation});
    const consume = async () => {
      while (!failed && next < candidateIds.length) {
        const id = candidateIds[next++];
        if (id === undefined) return;
        try {
          this.localFence(claim.runId);
          const pair = this.state.screeningPair(claim,subjectId,id);
          if (!pair) { failed = true; return; }
          if ("kind" in pair) continue;
          if (pair.subject.text === null || pair.candidate.text === null) throw new Error("Screening eligibility changed");
          const score = await port.judge({thoughtA:{id:pair.subject.id,text:pair.subject.text},thoughtB:{id:pair.candidate.id,text:pair.candidate.text}});
          this.localFence(claim.runId);
          this.state.recordScreeningJudgment(claim,subjectId,id,score);
        } catch (error) {
          failed = true; failure = error;
          if (!(error instanceof RunFenceError)) {
            try { this.localFence(claim.runId); this.state.screeningFailed(claim); }
            catch (fence) { failure = fence; }
          }
        }
      }
    };
    await Promise.all(Array.from({length:Math.min(SCREENING_CONCURRENCY,candidateIds.length)},consume));
    this.active(claim);
    if (failed) {
      if (failure instanceof RunFenceError) throw failure;
      return;
    }
    this.logger.verbose("[worker] screening complete",{runId:claim.runId,generation:claim.generation});
  }
  private async process(claim: Claim, step: RunStep, kind: RunKind, binding: AgentBinding): Promise<void> {
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
    if (step.envelope?.kind === "complete" || step.envelope?.kind === "report" || step.envelope?.kind === "review-complete") {
      this.state.finish(claim,step.promptId);
      if (this.runs.get(claim.runId)?.status === "failed") this.logger.error("[worker] source interpretation missing",{runId:claim.runId,kind});
      else this.logger.info("[worker] run completed", { runId: claim.runId, kind });
      this.forget(claim.runId); return;
    }
    if (step.envelope?.kind !== "request") throw new RunConflictError("Completed step has no canonical envelope");
    const result = this.capabilities.dispatch(claim,step.promptId,step.envelope.request);
    if (step.result === null) return;
    const paths = result.type === "thought" && result.thought !== null
      ? await this.mediaPaths(claim,kind,binding,[result.thought]) : [];
    this.active(claim);
    this.steps.advance(claim,step.promptId,result,{promptId:this.dependencies.promptId?.() ?? this.dependencies.id(),input:capabilityResultPrompt(step.envelope.request,result,kind,binding,paths,this.state.purpose(claim.runId))});
  }
  private async mediaPaths(claim: Claim, kind: RunKind, binding: AgentBinding, thoughts: readonly Thought[]): Promise<readonly MediaPath[]> {
    if (kind !== "weave" && kind !== "evolve") return [];
    const paths: MediaPath[] = [];
    for (const thought of thoughts) {
      if (thought.kind !== "media-original") continue;
      this.active(claim);
      if (!allowsNativeTools(binding)) throw new RunConflictError("This saved session cannot open original files");
      const resolve = this.dependencies.mediaPath;
      if (!resolve) throw new RunConflictError("Retained original storage is unavailable");
      const context = {runId:claim.runId,sourceId:thought.mediaSource.id};
      this.logger.verbose("[worker] original path attempt",context);
      try {
        const path = await resolve(thought.mediaSource.id);
        this.active(claim);
        if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.startsWith("/proc/self/fd/")) {
          throw new RunConflictError("Retained original path is unavailable");
        }
        paths.push({thoughtId:thought.id,path});
        this.logger.verbose("[worker] original path available",context);
      } catch (error) {
        this.active(claim);
        this.logger.warning("[worker] original path unavailable",context);
        throw error;
      }
    }
    return paths;
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
    // Called only by this run's registered cleanup tail after its actual execution promise has joined.
    if (run.kind === "search") return;
    if (this.paused || !["interrupted","failed"].includes(run.status)) return;
    if (isRunRestoreFenced(this.dependencies.db,run.id)) return;
    const cancellation = this.steps.cancellation(run.id);
    if (cancellation !== "pending" && !(["weave","evolve"].includes(run.kind) && cancellation === "settled" && !recordedSubjectCancellationSafe(this.dependencies.db,run.id))) return;
    if (this.state.settleUnsubmitted(run.id)) return;
    const binding = this.bindings.get(run.id);
    if (!binding) return;
    const step = this.steps.steps(run.id).at(-1);
    if (!step || step.input === null) return; // Unknown legacy input/binding is never fabricated for cleanup.
    this.logger.verbose("[worker] cancellation attempt",{runId:run.id,promptId:step.promptId});
    try {
      const journal = this.bindings.cancellationJournal(run.id,{promptId:step.promptId,input:step.input});
      const result = await this.transport().cancel(run.id,binding,{promptId:step.promptId,input:step.input});
      this.localFence(run.id);
      if (result === "settled") this.state.settleOrdinaryCancellation(journal,binding);
      this.logger.verbose("[worker] cancellation outcome",{runId:run.id,promptId:step.promptId,state:result});
    } catch { this.logger.verbose("[worker] cancellation remains pending",{runId:run.id,promptId:step.promptId}); }
  }
  private async cleanupRun(runId: string): Promise<void> {
    if (this.paused || !this.dependencies.native) return;
    this.dependencies.executionOwner?.assertHeld();
    if (isRunRestoreFenced(this.dependencies.db,runId)) { this.forget(runId); return; }
    const run = this.runs.get(runId);
    if (run?.kind === "search" || !run) { await this.cleanupSearch(runId); return; }
    if (terminal(run)) { this.forget(runId); await this.cancel(run); }
  }
  private async cleanupSearch(runId: string): Promise<void> {
    if (this.paused || !this.dependencies.native) return;
    try {
      assertRunNotRestoreFenced(this.dependencies.db,runId);
      const identity = this.cleanup.prepare(runId);
      if (!identity || this.paused || !this.cleanup.drained(identity)) return;
      const native = this.transport();
      if (!native.cancelSearch) return;
      const authorize = () => {
        if (this.paused) throw new WorkerPaused();
        assertRunNotRestoreFenced(this.dependencies.db,runId);
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
  /** Join this run's real execution, then commit synchronously while new ticks are excluded. */
  retireWeave<T>(runId: string, commit: () => T): Promise<T> {
    const preceding = this.retirements.get(runId);
    const flight = this.flights.get(runId);
    const operation = Promise.resolve().then(async () => {
      if (preceding) await preceding.catch(() => {});
      if (flight) await flight.execution;
      if (this.paused) throw new RunFenceError("Worker is paused");
      this.dependencies.executionOwner?.assertHeld();
      return commit();
    });
    this.retirements.set(runId,operation);
    return operation.finally(() => { if (this.retirements.get(runId) === operation) this.retirements.delete(runId); });
  }
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
