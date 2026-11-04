import type { Database } from "bun:sqlite";
import type { InitialRunContext } from "../domain/run-context";
import { RunConflictError, RunFenceError, RunForbiddenError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import type { CancellationState, RunStep } from "../domain/run-protocol";
import { createSharedResponse, type SharedResponse } from "../domain/shared-response";
import type { Thought } from "../domain/thought";
import { nonEmpty } from "../domain/validation";
import { SqliteRunAggregate } from "./run-aggregate";
import { SqliteRunOperations } from "./run-operations";
import { SqliteRunRepository } from "./run";

/** Orchestration transactions on the existing aggregate, never a second job journal or native-call boundary. */
export class SqliteRunWorkerState extends SqliteRunAggregate {
  constructor(db: Database, private readonly sources: RunSources) { super(db); }
  prepareInitial(claim: Claim, render: (context: InitialRunContext) => string): RunStep {
    return this.guarded("prepare worker context",claim,run => {
      const step = this.currentStep(run.id);
      if (step.input !== null) return step;
      if (step.position !== 0 || step.state !== "prepared" || run.status !== "queued" || run.nativeState !== "unknown") {
        throw new RunConflictError("Unknown legacy input cannot be reconstructed");
      }
      const context = this.initialContext(run);
      // This renderer is synchronous, trusted application code, not a model callback or an external operation.
      const input = nonEmpty(render(context),"initial input");
      for (const thought of context.thoughts) this.trackThought(run.id,thought);
      for (const connection of context.connections) this.trackConnection(run.id,connection);
      for (const response of context.responses) this.trackResponse(run.id,response);
      this.db.run("UPDATE run_steps SET input=? WHERE run_id=? AND prompt_id=?",[input,run.id,step.promptId]);
      return { ...step, input };
    });
  }
  private initialContext(run: RunRecord): InitialRunContext {
    const scope = {actor:"ai",mode:"normal"} as const;
    const rejection = this.rejection();
    const visible = new Map(rejection.listThoughts(scope).map(thought => [thought.id,thought]));
    const subjectId = run.kind === "weave" ? this.readWeaveIntent(run.id)?.subjectId : run.inputThoughtId;
    const subject = subjectId === null || subjectId === undefined ? undefined : visible.get(subjectId);
    if (!subject) throw new RunConflictError("Run subject identity is unavailable");
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
    if (run.kind === "export") throw new RunForbiddenError("Export execution is not implemented by this worker");
    return {job:run.kind === "weave" ? {kind:"weave",subjectId:subject.id} :
      {kind:"evolve",contributionId:subject.id,continuationId:subject.parentId},thoughts,connections,responses:[...responses.values()]};
  }
  /** Failed transport is not submission evidence. Only a previously committed intent makes this observation-only. */
  submissionFailed(claim: Claim, promptId: string): void {
    this.guarded("worker submission failure",claim,run => {
      if (run.promptId !== promptId) throw new RunFenceError();
      const step = this.currentStep(run.id);
      if (step.input === null) throw new RunConflictError("Exact prompt input was not retained");
      if (run.status === "queued" && step.state === "prepared") {
        console.info("[run storage] failed pre-dispatch retained prepared prompt",{runId:run.id,promptId,generation:claim.generation});
        return;
      }
      if (run.nativeState === "completed") return;
      if (step.state !== "submitting" && step.state !== "uncertain") throw new RunConflictError("Failed submission has no coherent durable phase");
      this.transitionNative(claim,"uncertain",undefined,promptId);
    });
  }
  finish(claim: Claim, promptId: string): void {
    this.guarded("finish worker reply",claim,run => {
      if (run.promptId !== promptId) throw new RunFenceError();
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
      const run = this.require(runId);
      if (!["interrupted","failed"].includes(run.status)) return false;
      const cancellation = this.db.query("SELECT cancellation_state AS state FROM runs WHERE id=?").get(runId) as {state:CancellationState};
      if (cancellation.state === "settled") return true;
      if (cancellation.state !== "pending") return false;
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
      console.info("[run storage] unsubmitted cancellation settled locally",{runId});
      return true;
    });
  }
}
