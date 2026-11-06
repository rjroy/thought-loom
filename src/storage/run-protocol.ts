import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { requireOrdinaryRun, RunConflictError, RunFenceError, RunForbiddenError, type Claim, type RunRecord } from "../domain/run";
import { parseEnvelope, protocolJson, type CancellationState, type NextStep, type ProtocolEnvelope, type RunProtocolRepository, type RunStep } from "../domain/run-protocol";
import { nonEmpty } from "../domain/validation";
import { isStepOperationCapability } from "../domain/run-operations";
import { isReadCapability } from "../domain/capability";
import { SqliteRunAggregate } from "./run-aggregate";

/** Extends the existing run aggregate, core migration, transaction and claim fencing; no independent run state. */
export class SqliteRunProtocolRepository extends SqliteRunAggregate implements RunProtocolRepository {
  constructor(db: Database, logger: Logger = createLogger()) { super(db,logger); }
  steps(runId: string): readonly RunStep[] {
    return this.transaction("read steps",runId,() => { requireOrdinaryRun(this.require(runId)); return this.readSteps(runId); });
  }
  private current(run: RunRecord, promptId: string): RunStep {
    if (run.promptId !== promptId) throw new RunFenceError("Prompt is no longer current");
    return this.currentStep(run.id);
  }
  prepare(claim: Claim, input: NextStep): RunStep {
    const prepared = this.guarded("prepare prompt",claim,run => {
      const promptId = nonEmpty(input.promptId,"promptId");
      const text = nonEmpty(input.input,"input");
      const step = this.current(run,promptId);
      if (step.input !== null) {
        if (step.input !== text) throw new RunConflictError("Prompt input differs from prepared input");
        return step;
      }
      if (step.state !== "prepared" || run.status !== "queued" || run.nativeState !== "unknown") throw new RunConflictError("Legacy prompt input is unknown and cannot be replaced");
      this.db.run("UPDATE run_steps SET input=? WHERE run_id=? AND prompt_id=?",[text,run.id,promptId]);
      return { ...step, input: text };
    });
    this.logger.verbose("[run storage] prompt input confirmed", { runId: claim.runId, promptId: prepared.promptId, position: prepared.position, state: prepared.state });
    return prepared;
  }
  setStepState(claim: Claim, promptId: string, state: "submitting" | "uncertain"): void {
    this.guarded("prompt state",claim,run => {
      const step = this.current(run,promptId);
      if (step.input === null) throw new RunConflictError("Exact prompt input was not retained");
      const allowed = state === "submitting" ? step.state === "prepared" : state === "uncertain" && ["submitting","uncertain"].includes(step.state);
      if (!allowed) throw new RunConflictError("Invalid prompt transition");
      this.db.run("UPDATE run_steps SET state=? WHERE run_id=? AND prompt_id=?",[state,run.id,promptId]);
      this.db.run("UPDATE runs SET status=? WHERE id=?",[state,run.id]);
    });
    this.logger.verbose("[run storage] prompt state committed", { runId: claim.runId, promptId, state, generation: claim.generation });
  }
  completeStep(claim: Claim, promptId: string, envelope: ProtocolEnvelope): void {
    const kind = this.guarded("complete prompt",claim,run => {
      const step = this.current(run,promptId);
      const value = parseEnvelope(protocolJson(envelope));
      if ((value.kind === "report" && run.kind !== "export") || (value.kind === "complete" && run.kind === "export")) throw new RunForbiddenError("Final envelope does not match the run kind");
      const encoded = protocolJson(value);
      if (step.envelope !== null) {
        if (protocolJson(step.envelope) !== encoded) throw new RunConflictError("Completed prompt envelope differs");
        return value.kind;
      }
      this.db.run("UPDATE run_steps SET state='completed',native_state='completed',envelope_json=? WHERE run_id=? AND prompt_id=?",[encoded,run.id,promptId]);
      // Native completion settles this prompt only. Canonical user reply finalization is a separate run operation.
      this.db.run("UPDATE runs SET status='uncertain' WHERE id=?",[run.id]);
      return value.kind;
    });
    this.logger.verbose("[run storage] prompt completion confirmed", { runId: claim.runId, promptId, kind, generation: claim.generation });
  }
  advance(claim: Claim, promptId: string, result: unknown, next: NextStep): RunStep {
    const successor = this.guarded<RunStep>("advance prompt",claim,run => {
      const step = this.readStep(run.id,promptId);
      if (!step) throw new RunConflictError("Prompt does not belong to this run");
      const resultJson = protocolJson(result);
      const nextPromptId = nonEmpty(next.promptId,"promptId");
      const nextInput = nonEmpty(next.input,"input");
      if (step.result !== null && protocolJson(step.result) !== resultJson) throw new RunConflictError("Result differs from the dispatched step result");
      if (step.envelope?.kind === "request" && isReadCapability(step.envelope.request.capability) && step.result === null) {
        throw new RunConflictError("Read result must be committed with its context witnesses before advancing");
      }
      if (step.envelope?.kind === "request" && isStepOperationCapability(step.envelope.request.capability)) {
        const receipt = this.readReceipt(run.id,step.promptId);
        if (!receipt || receipt.format !== "step" || protocolJson(JSON.parse(receipt.result)) !== resultJson) throw new RunConflictError("Write result must match its committed step receipt");
      }
      if (step.state === "processed") {
        const successor = this.readStep(run.id,nextPromptId);
        if (protocolJson(step.result) !== resultJson || !successor || successor.position !== step.position+1 || successor.input !== nextInput) {
          throw new RunConflictError("Processed prompt result or successor differs");
        }
        return successor;
      }
      this.current(run,promptId);
      if (step.state !== "completed" || step.envelope?.kind !== "request") throw new RunConflictError("Only a completed capability request can advance");
      if (this.db.query("SELECT 1 FROM run_steps WHERE prompt_id=?").get(nextPromptId)) throw new RunConflictError("Prompt identity already issued");
      this.db.run("UPDATE run_steps SET state='processed',result_json=? WHERE run_id=? AND prompt_id=?",[resultJson,run.id,promptId]);
      this.db.run("INSERT INTO run_steps (run_id,position,prompt_id,input,state,native_state) VALUES (?,?,?,?,'prepared','unknown')",
        [run.id,step.position+1,nextPromptId,nextInput]);
      this.db.run("UPDATE runs SET status='queued' WHERE id=?",[run.id]);
      return { runId: run.id, position: step.position+1, promptId: nextPromptId, input: nextInput, state: "prepared", envelope: null, result: null };
    });
    this.logger.verbose("[run storage] prompt successor confirmed", { runId: claim.runId, from: promptId, to: successor.promptId, position: successor.position, generation: claim.generation });
    return successor;
  }
  cancellation(runId: string): CancellationState {
    this.require(runId);
    const row = this.db.query("SELECT cancellation_state AS state FROM runs WHERE id=?").get(runId) as { state: CancellationState };
    return row.state;
  }
  settleCancellation(runId: string): void {
    this.transaction("settle cancellation",runId,() => {
      const run = this.require(runId);
      if (run.status !== "interrupted" && run.status !== "failed" && !(run.kind === "import" && run.status === "completed")) throw new RunFenceError("Only fenced runs have native cancellation to settle");
      const state = this.cancellation(runId);
      if (state === "settled") return;
      if (state !== "pending") throw new RunConflictError("No pending native cancellation");
      this.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=?",[runId]);
    });
  }
}
