import type { Database } from "bun:sqlite";
import { RunConflictError, RunFenceError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import { parseEnvelope, type RunStep } from "../domain/run-protocol";
import { SqliteAgentBindings } from "../storage/agent-binding";
import { SqliteCapabilityDispatcher } from "../storage/capability";
import { SqliteRunOperations } from "../storage/run-operations";
import { SqliteRunProtocolRepository } from "../storage/run-protocol";
import { SqliteRunRepository } from "../storage/run";
import { SqliteRunWorkerState } from "../storage/run-worker";
import { AgentBindingError, normalizeBinding } from "./binding";
import type { AgentBinding, NativePhase, Observation, PersistedPrompt } from "./opencode-adapter";
import { capabilityResultPrompt, initialWorkerPrompt } from "./worker-prompts";

/** Native calls are outside SQLite transactions. Production supplies OpenCodeAdapter. */
export interface WorkerNative {
  ensureSession(claim: Claim, binding: AgentBinding): Promise<void>;
  /** Must commit the supplied bindings' "submit" phase before external dispatch. Prepared/queued therefore proves no dispatch. */
  submit(claim: Claim, binding: AgentBinding, prompt: PersistedPrompt): Promise<void>;
  observe(claim: Claim, binding: AgentBinding, prompts: readonly PersistedPrompt[]): Promise<Observation>;
  cancel(runId: string, binding: AgentBinding, prompt: PersistedPrompt): Promise<"pending" | "settled">;
}
export interface WorkerDependencies extends RunSources {
  readonly db: Database;
  /** Bind the supplied bindings.assertActive to its receiver; it fences SQL claims/context and local pause around native calls. */
  readonly native: (bindings: SqliteAgentBindings) => WorkerNative;
  /** Select only for an unbound run; a persisted binding takes precedence on restart. */
  readonly bindingFor: (run: RunRecord) => AgentBinding | null;
}

class WorkerPaused extends RunFenceError {}
/** The real adapter binds this actual method, so pause also fences its intermediate asynchronous callbacks. */
class WorkerBindings extends SqliteAgentBindings {
  constructor(db: Database, private readonly localFence: () => void) { super(db); }
  override assertActive(claim: Claim, prompt?: PersistedPrompt, phase?: NativePhase): readonly PersistedPrompt[] | void {
    this.localFence();
    return super.assertActive(claim,prompt,phase);
  }
  override bind(runId: string, binding: AgentBinding, claim?: Claim): void {
    this.localFence();
    super.bind(runId,binding,claim);
  }
}
const terminal = (run: RunRecord): boolean => ["completed","interrupted","failed"].includes(run.status);

/** Manual polling seam; the daemon supervisor owns scheduling and can drive independent runs. */
export class RunWorker {
  private readonly bindings: WorkerBindings;
  private readonly runs: SqliteRunRepository;
  private readonly steps: SqliteRunProtocolRepository;
  private readonly operations: SqliteRunOperations;
  private readonly capabilities: SqliteCapabilityDispatcher;
  private readonly state: SqliteRunWorkerState;
  private readonly owners = new Map<string,Claim>();
  private readonly flights = new Map<string,Promise<void>>();
  private readonly ensured = new Set<string>();
  private native: WorkerNative | undefined;
  private paused = false;
  constructor(private readonly dependencies: WorkerDependencies) {
    const {db} = dependencies;
    this.bindings = new WorkerBindings(db,() => { if (this.paused) throw new WorkerPaused(); });
    this.runs = new SqliteRunRepository(db,dependencies);
    this.steps = new SqliteRunProtocolRepository(db);
    this.operations = new SqliteRunOperations(db,dependencies);
    this.capabilities = new SqliteCapabilityDispatcher(db,dependencies);
    this.state = new SqliteRunWorkerState(db,dependencies);
  }
  tick(runId: string): Promise<void> {
    if (this.paused) return Promise.resolve();
    const existing = this.flights.get(runId);
    if (existing) return existing;
    // Defer execution until the in-flight entry exists; simultaneous polls share one boundary, not two submissions.
    const flight = Promise.resolve().then(() => this.poll(runId)).finally(() => this.flights.delete(runId));
    this.flights.set(runId,flight);
    return flight;
  }
  private active(claim: Claim, prompt?: PersistedPrompt): void {
    if (this.paused) throw new WorkerPaused();
    this.bindings.assertActive(claim,prompt);
  }
  private transport(): WorkerNative { return this.native ??= this.dependencies.native(this.bindings); }
  private forget(runId: string): void { this.owners.delete(runId); this.ensured.delete(runId); }
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
      if (!run) throw new RunConflictError("Worker run does not exist");
      if (terminal(run)) { this.forget(runId); await this.cancel(run); return; }
      if (run.kind === "export") return; // Agentic export belongs to the subsequent execution slice.
      let binding = this.bindings.get(runId);
      if (!binding) {
        const selected = this.dependencies.bindingFor(Object.freeze({...run}));
        if (selected === null) return; // No claim, preparation, client construction, or HTTP without configuration.
        binding = normalizeBinding(selected);
      }
      if (!claim) { claim = this.runs.claim(runId); this.owners.set(runId,claim); }
      const owner = claim;
      this.active(owner);
      const step = this.steps.steps(runId).at(-1);
      if (!step) throw new RunConflictError("Run has no current step");
      if (step.input === null) {
        this.state.prepareInitial(owner,initialWorkerPrompt);
        this.bindings.bind(runId,binding,owner);
        return;
      }
      if (!this.bindings.get(runId)) { this.bindings.bind(runId,binding,owner); return; }
      const prompt = {promptId:step.promptId,input:step.input};
      this.active(owner,prompt);
      if (step.envelope !== null) { this.process(owner,step); return; }
      if (!this.ensured.has(runId)) {
        if ((await this.call(owner,prompt,"ensure session",() => this.transport().ensureSession(owner,binding))).ok) this.ensured.add(runId);
        return;
      }
      const current = this.runs.get(runId);
      if (!current) throw new RunConflictError();
      if (current.status === "queued" && step.state === "prepared") {
        const submitted = await this.call(owner,prompt,"submit",() => this.transport().submit(owner,binding,prompt));
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
        const run = this.runs.get(runId);
        if (run && terminal(run)) { this.forget(runId); await this.cancel(run); }
        return; // A newer worker owns an active run. This worker never reclaims it on a later poll.
      }
      if (!claim) throw error;
      console.error("[worker] local processing failed",{runId,generation:claim.generation});
      try { this.active(claim); this.operations.fail(claim); this.forget(runId); }
      catch (failure) { if (!(failure instanceof RunFenceError)) throw failure; }
    }
  }
  private process(claim: Claim, step: RunStep): void {
    this.active(claim);
    if (step.envelope?.kind === "complete") { this.state.finish(claim,step.promptId); this.forget(claim.runId); return; }
    if (step.envelope?.kind !== "request") throw new RunConflictError("Completed step has no canonical envelope");
    const result = this.capabilities.dispatch(claim,step.promptId,step.envelope.request);
    if (step.result === null) return;
    this.steps.advance(claim,step.promptId,result,{promptId:this.dependencies.promptId?.() ?? this.dependencies.id(),input:capabilityResultPrompt(step.envelope.request,result)});
  }
  private async call<T>(claim: Claim, prompt: PersistedPrompt, operation: "ensure session" | "submit" | "observe", action: () => Promise<T>): Promise<{readonly ok:true;readonly value:T} | {readonly ok:false}> {
    this.active(claim,prompt);
    console.info("[worker] native boundary attempt",{runId:claim.runId,promptId:prompt.promptId,generation:claim.generation,operation});
    try {
      const value = await action();
      this.active(claim,prompt);
      console.info("[worker] native boundary succeeded",{runId:claim.runId,promptId:prompt.promptId,generation:claim.generation,operation});
      return {ok:true,value};
    } catch (error) {
      if (this.paused || error instanceof RunFenceError) throw error;
      if (error instanceof AgentBindingError) { this.bindings.assertActive(claim,prompt,"quarantined"); throw error; }
      console.error("[worker] native boundary failed",{runId:claim.runId,promptId:prompt.promptId,generation:claim.generation,operation});
      if (operation === "submit") this.state.submissionFailed(claim,prompt.promptId);
      return {ok:false};
    }
  }
  private async cancel(run: RunRecord): Promise<void> {
    if (this.paused || !["interrupted","failed"].includes(run.status) || this.steps.cancellation(run.id) !== "pending") return;
    if (this.state.settleUnsubmitted(run.id)) return;
    const binding = this.bindings.get(run.id);
    if (!binding) return;
    const step = this.steps.steps(run.id).at(-1);
    if (!step || step.input === null) return; // Unknown legacy input/binding is never fabricated for cleanup.
    console.info("[worker] cancellation attempt",{runId:run.id,promptId:step.promptId});
    try {
      const result = await this.transport().cancel(run.id,binding,{promptId:step.promptId,input:step.input});
      if (this.paused) return;
      if (result === "settled") this.steps.settleCancellation(run.id);
      console.info("[worker] cancellation outcome",{runId:run.id,promptId:step.promptId,state:result});
    } catch { console.error("[worker] cancellation remains pending",{runId:run.id,promptId:step.promptId}); }
  }
  /** Local shutdown only: never a user Stop. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    console.info("[worker] paused",{ownedRuns:this.owners.size,activeTicks:this.flights.size});
  }
}
