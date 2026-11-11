import type { Database } from "bun:sqlite";
import { sameBinding, type AgentBinding } from "../agent/binding";
import type { InitialRunContext } from "../domain/run-context";
import { requireOrdinaryRun, RunConflictError, RunFenceError, RunForbiddenError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import type { CancellationState, OrdinaryCancellationJournal, RunStep } from "../domain/run-protocol";
import { createSharedResponse, type SharedResponse } from "../domain/shared-response";
import type { Thought } from "../domain/thought";
import { nonEmpty } from "../domain/validation";
import { SqliteRunAggregate } from "./run-aggregate";
import { SqliteRunOperations } from "./run-operations";
import { SqliteRunRepository } from "./run";
import { SqliteAgenticExports } from "./agentic-export";
import { initialSearchContext } from "./search-initial-context";
import { SqliteSearchPublication } from "./search-publication";
import { SqliteSearchPromptClock } from "./search-prompt-clock";
import { assertOrdinaryCancellationJournal } from "./run-cancellation";
import { weaveDispatchAllowed } from "./weave-work";
import { readAgentBinding } from "./run-record";
import { assertRunNotRestoreFenced, isRunRestoreFenced } from "./restore-fences";
import { assertImportRunNotRestoreFenced } from "./import-authority";
import { SqliteAgentInstructions } from "./agent-instructions";

/** Orchestration transactions on the existing aggregate, never a second job journal or native-call boundary. */
export class SqliteRunWorkerState extends SqliteRunAggregate {
  constructor(db: Database, private readonly sources: RunSources,
    private readonly searchClock = new SqliteSearchPromptClock(db,sources.now)) { super(db,sources.logger); }
  canDispatch(runId: string): boolean {
    return this.transaction("check weave dispatch",runId,() => !isRunRestoreFenced(this.db,runId) && weaveDispatchAllowed(this.db,runId));
  }
  prepareInitial(claim: Claim, render: (context: InitialRunContext) => string): RunStep {
    const prepared = this.guardedExecution("prepare worker context",claim,run => {
      const step = this.currentStep(run.id);
      if (step.input !== null) return { step, clock: null };
      if (step.position !== 0 || step.state !== "prepared" || run.status !== "queued" || run.nativeState !== "unknown") {
        throw new RunConflictError("Unknown legacy input cannot be reconstructed");
      }
      const clock = run.kind === "search" ? this.searchClock.prepare(run,step,step.promptId) : null;
      if (clock && clock.context === null) throw new RunConflictError("Initial search clock attachment required");
      const search = clock?.context ? initialSearchContext(this.db,run,clock.context) : null;
      const context = search?.context ?? this.selectInitialContext(run);
      const settings = new SqliteAgentInstructions(this.db,this.logger).get();
      const guidance = run.kind === "weave" ? settings.weaver : run.kind === "evolve" ? settings.evolve :
        run.kind === "search" ? settings.search : run.kind === "export" ? settings.export : null;
      if (guidance === null) throw new RunForbiddenError("Ordinary agent guidance required");
      // This renderer is synchronous, trusted application code, not a model callback or an external operation.
      const input = nonEmpty(render(context),"initial input");
      if (search) for (const ref of search.dependencies) this.track(run.id,ref);
      for (const thought of context.thoughts) this.trackThought(run.id,thought);
      for (const connection of context.connections) this.trackConnection(run.id,connection);
      for (const response of context.responses) this.trackResponse(run.id,response);
      this.db.run("UPDATE run_steps SET input=?,guidance=CAST(? AS TEXT) WHERE run_id=? AND prompt_id=?",[input,new TextEncoder().encode(guidance),run.id,step.promptId]);
      return { step: { ...step, input }, clock };
    });
    prepared.clock?.committed();
    return prepared.step;
  }
  /** Commit normal context before asynchronous path resolution, so rejection fences an entered read. */
  initialContext(claim: Claim): InitialRunContext {
    return this.guarded("select worker context",claim,run => {
      const context = this.selectInitialContext(run);
      for (const thought of context.thoughts) this.trackThought(run.id,thought);
      for (const connection of context.connections) this.trackConnection(run.id,connection);
      for (const response of context.responses) this.trackResponse(run.id,response);
      return context;
    });
  }
  private selectInitialContext(run: RunRecord): InitialRunContext {
    requireOrdinaryRun(run);
    if (run.kind === "export") {
      const intent = new SqliteAgenticExports(this.db,this.sources).intent(run.id);
      if (!intent) throw new RunConflictError("Legacy export request is unavailable; cannot infer intent");
      // An export starts with its retained question, not a corpus dump or an invented subject. Reads add scoped witnesses.
      return {job:{kind:"export",...intent},thoughts:[],connections:[],responses:[]};
    }
    const scope = {actor:"ai",mode:"normal"} as const;
    const rejection = this.rejection();
    const visible = new Map(rejection.listThoughts(scope).map(thought => [thought.id,thought]));
    const subjectId = run.kind === "weave" ? this.readWeaveIntent(run.id)?.subjectId : run.inputThoughtId;
    const subject = subjectId === null || subjectId === undefined ? undefined : visible.get(subjectId);
    if (!subject) throw new RunConflictError("Run subject identity is unavailable");
    const purpose = this.weavePurpose(run);
    if (purpose === "media-title-only") {
      return {job:{kind:"weave",subjectId:subject.id,purpose},thoughts:[subject],connections:[],responses:[]};
    }
    const thoughts: Thought[] = [];
    const selected = new Set<string>();
    let thought: Thought | undefined = subject;
    // Evolve's explicit discussion follows only its visible evolution path, not arbitrary discovered neighbors.
    while (thought && !selected.has(thought.id)) {
      thoughts.push(thought); selected.add(thought.id);
      thought = run.kind === "evolve" && thought.parentId !== null ? visible.get(thought.parentId) : undefined;
    }
    const connections = rejection.listConnections(scope).filter(connection => selected.has(connection.fromId) || selected.has(connection.toId));
    const responses = new Map<string,SharedResponse>();
    for (const thought of thoughts) {
      const refs = this.db.query("SELECT response_id AS id FROM response_thoughts WHERE thought_id=? ORDER BY rowid").all(thought.id) as {id:string}[];
      for (const ref of refs) {
        if (responses.has(ref.id)) continue;
        const response = rejection.getResponse(scope,ref.id);
        if (response) responses.set(response.id,response);
      }
    }
    return {job:run.kind === "weave" ? {kind:"weave",subjectId:subject.id,...(purpose === "reinterpretation" ? {purpose} : {})} :
      {kind:"evolve",contributionId:subject.id,continuationId:subject.parentId},thoughts,connections,responses:[...responses.values()]};
  }
  /** Failed transport is not submission evidence. Only a previously committed intent makes this observation-only. */
  submissionFailed(claim: Claim, promptId: string): void {
    this.guardedExecution("worker submission failure",claim,run => {
      if (run.promptId !== promptId) throw new RunFenceError();
      const step = this.currentStep(run.id);
      if (step.input === null) throw new RunConflictError("Exact prompt input was not retained");
      if (run.status === "queued" && step.state === "prepared") {
        this.logger.verbose("[run storage] failed pre-dispatch retained prepared prompt",{runId:run.id,promptId,generation:claim.generation});
        return;
      }
      if (run.nativeState === "completed") return;
      if (step.state !== "submitting" && step.state !== "uncertain") throw new RunConflictError("Failed submission has no coherent durable phase");
      this.transitionNative(claim,"uncertain",undefined,promptId);
    });
  }
  finish(claim: Claim, promptId: string): void {
    assertRunNotRestoreFenced(this.db,claim.runId);
    // Publication owns its own commit-after-fence transaction; an outer transaction must not roll that fence back.
    if (this.require(claim.runId).kind === "search") {
      new SqliteSearchPublication(this.db,this.sources).finalizeReply(claim,promptId);
      return;
    }
    this.guarded("finish worker reply",claim,run => {
      if (run.promptId !== promptId) throw new RunFenceError();
      if (run.kind === "export") { new SqliteAgenticExports(this.db,this.sources).finalize(claim,promptId); return; }
      const step = this.currentStep(run.id);
      if (step.input === null || step.state !== "completed" || step.envelope?.kind !== "complete") throw new RunConflictError("No canonical final reply is available");
      if (run.kind === "weave") { new SqliteRunOperations(this.db,this.sources).completeWeave(claim,promptId); return; }
      if (run.kind !== "evolve") throw new RunForbiddenError();
      const associations = this.associations(run);
      if (!associations) throw new RunConflictError("Reply associations are unavailable");
      const response = createSharedResponse({id:this.sources.id(),text:step.envelope.reply,state:"complete",...associations});
      // Reuse the one canonical response store and its commit-time association/visibility checks.
      new SqliteRunRepository(this.db,{...this.sources,scheduleWeave:true}).finish(claim,response);
    });
  }
  settleUnsubmitted(runId: string): boolean {
    return this.transaction("settle unsubmitted worker",runId,() => {
      assertRunNotRestoreFenced(this.db,runId);
      const run = this.require(runId);
      if (run.kind === "import") assertImportRunNotRestoreFenced(this.db,runId);
      if (run.kind === "search") return false; // Search settlement needs its later joined-flight and admission proof.
      if (!["interrupted","failed"].includes(run.status)) return false;
      const cancellation = this.db.query("SELECT cancellation_state AS state FROM runs WHERE id=?").get(runId) as {state:CancellationState};
      if (cancellation.state !== "pending" && cancellation.state !== "settled") return false;
      // Inspect the whole durable history, not the current prepared successor or the presence of a binding.
      // Only one untouched initial step proves no prompt was dispatched; creating/binding a session is not a submission.
      // Legacy interrupted rows backfill as uncertain. Legacy failed rows can backfill as prepared with unknown input,
      // so that ambiguous failed/null-input history must remain pending rather than inventing absence evidence.
      const history = this.db.query(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN
        s.position=0 AND s.prompt_id=r.prompt_id AND s.state='prepared' AND s.native_state='unknown'
        AND s.envelope_json IS NULL AND s.result_json IS NULL AND (s.input IS NOT NULL OR r.status='interrupted')
        THEN 1 ELSE 0 END),0) AS unsubmitted
        FROM run_steps s JOIN runs r ON r.id=s.run_id WHERE r.id=?`).get(runId) as {total:number;unsubmitted:number};
      if (history.total !== 1 || history.unsubmitted !== 1) return false;
      this.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=? AND cancellation_state='pending'",[runId]);
      this.logger.verbose("[run storage] unsubmitted cancellation settled locally",{runId});
      return true;
    });
  }
  /** Positive native-terminal proof settles only its unchanged journal/binding, never a protocol reply. */
  settleOrdinaryCancellation(journal: OrdinaryCancellationJournal, expectedBinding: AgentBinding): void {
    const changed = this.transaction("settle ordinary worker cancellation",journal.runId,() => {
      assertOrdinaryCancellationJournal(this.db,journal);
      const binding = readAgentBinding(this.db,journal.runId);
      if (!binding || !sameBinding(binding,expectedBinding)) throw new RunFenceError("Cancellation binding changed during reconciliation");
      let verifiedSteps = 0;
      if (this.require(journal.runId).kind === "weave") {
        for (const step of journal.steps) {
          if (step.state !== "submitting" && step.state !== "uncertain") continue;
          // The turn ended, including interruption/failure. The paired state is required by the SQL CHECK;
          // no successful envelope/result is invented, and processed or never-submitted steps stay intact.
          const updated = this.db.run(`UPDATE run_steps SET state='completed',native_state='completed'
            WHERE run_id=? AND prompt_id=? AND input=? AND state=? AND native_state=?`,
          [journal.runId,step.promptId,step.input,step.state,step.nativeState]);
          if (updated.changes !== 1) throw new RunFenceError("Cancellation step changed during reconciliation");
          verifiedSteps++;
        }
      }
      this.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=? AND cancellation_state='pending'",[journal.runId]);
      return {settled:journal.cancellation === "pending",verifiedSteps};
    });
    if (changed.settled || changed.verifiedSteps > 0) this.logger.info("[worker] native cancellation settled",{runId:journal.runId,generation:journal.generation,
      reason:changed.settled ? "pending-cancellation" : "historical-terminal-verification"});
  }
}
