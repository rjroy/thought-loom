import type { Database } from "bun:sqlite";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import { parseStepOperation, stepOperationEnvelope, stepOperationScope, type RunOperations, type StepOperation, type StepOperationResult, type StepReceipt, type WeaveIntent } from "../domain/run-operations";
import { protocolJson } from "../domain/run-protocol";
import { CreationNotFoundError } from "../domain/creation";
import { createThought } from "../domain/thought";
import { createConnection } from "../domain/connection";
import { TitleConflictError, TitleNotFoundError, TitleService } from "../domain/title";
import { record } from "../domain/validation";
import { SqliteRunAggregate } from "./run-aggregate";
import { SqliteTitleRepository } from "./title";
import { admitWeave } from "./weave-admission";

/** Typed writes share the original run aggregate, transaction, receipt table, and issued ordering. */
export class SqliteRunOperations extends SqliteRunAggregate implements RunOperations {
  constructor(db: Database, private readonly sources: RunSources) { super(db,sources.logger); }
  admitWeave(actor: "user", input: WeaveIntent): RunRecord {
    if (actor !== "user") throw new RunForbiddenError();
    return admitWeave(this.db,this.sources,input);
  }
  weaveIntent(runId: string): WeaveIntent | null { this.require(runId); return this.readWeaveIntent(runId); }
  stepReceipt(runId: string, promptId: string): StepReceipt | null {
    const row = this.readReceipt(runId,promptId);
    if (!row) return null;
    if (row.format !== "step") throw new RunConflictError("Receipt belongs to a legacy development operation");
    const operation = parseStepOperation(JSON.parse(row.operation));
    const data = record(JSON.parse(row.result));
    if (data.type !== operation.type) throw new RunConflictError("Receipt result type differs from its operation");
    let result: StepOperationResult;
    if (data.type === "development" || data.type === "interpretation") {
      const thought = createThought(data.thought);
      if (thought.id !== row.thoughtId) throw new RunConflictError("Receipt thought identity differs");
      result = { type: data.type, thought };
    } else {
      if (row.thoughtId !== null) throw new RunConflictError("Non-thought receipt has thought membership");
      if (data.type === "connection") result = { type: "connection", connection: createConnection(data.connection) };
      else if (data.type === "title-fill" && (data.status === "filled" || data.status === "unchanged")) result = { type: "title-fill", status: data.status };
      else throw new RunConflictError("Invalid receipt result");
    }
    return { operation, result };
  }
  executeStep(claim: Claim, promptId: string, input: StepOperation): StepOperationResult {
    const result = this.guarded("execute step",claim,(run,visible) => {
      if (run.kind !== "weave" && run.kind !== "evolve") throw new RunForbiddenError();
      const operation = parseStepOperation(input);
      const step = this.readStep(run.id,promptId);
      if (!step || !["completed","processed"].includes(step.state) ||
          protocolJson(step.envelope) !== protocolJson(stepOperationEnvelope(operation))) throw new RunConflictError("Operation differs from the completed prompt request");
      const { subjectId, refs } = stepOperationScope(run,this.readWeaveIntent(run.id),operation);
      if (refs.some(id => !visible({kind:"thought",id}))) throw new RunNotFoundError();
      const existing = this.stepReceipt(run.id,step.promptId);
      if (existing) {
        if (protocolJson(existing.operation) !== protocolJson(operation)) throw new RunConflictError("Receipt proposal differs");
        return existing.result;
      }
      if (step.promptId !== run.promptId || step.state !== "completed") throw new RunFenceError("Prompt is no longer current");
      const effect = this.apply(operation,subjectId);
      const thoughtId = effect.type === "development" || effect.type === "interpretation" ? effect.thought.id : null;
      this.db.run(`INSERT INTO run_operation_receipts (run_id,operation_id,operation_json,thought_id,result_json,format) VALUES (?,?,?,?,?,'step')`,
        [run.id,step.promptId,protocolJson(operation),thoughtId,protocolJson(effect)]);
      if (thoughtId !== null) this.appendIssued(run.id,step.promptId,thoughtId);
      for (const id of refs) this.track(run.id,{kind:"thought",id});
      if (thoughtId !== null) this.track(run.id,{kind:"thought",id:thoughtId});
      if (effect.type === "connection") this.track(run.id,{kind:"connection",id:effect.connection.id});
      return effect;
    });
    this.logger.verbose("[run storage] step operation confirmed", { runId: claim.runId, promptId, type: result.type, generation: claim.generation });
    return result;
  }
  private apply(operation: StepOperation, subjectId: string | null): StepOperationResult {
    try {
      if (operation.type === "development") return { type: "development", thought: this.creation(this.sources).develop("ai",operation.parentId,operation) };
      if (operation.type === "connection") return { type: "connection", connection: this.creation(this.sources).connect("ai",operation) };
      if (subjectId === null) throw new RunConflictError("Weave subject is unknown");
      if (operation.type === "interpretation") return { type: "interpretation", thought: this.creation(this.sources).interpret("ai",subjectId,operation) };
      try {
        new TitleService(new SqliteTitleRepository(this.db,undefined,this.logger)).fillAi("ai",subjectId,operation.title);
        return { type: "title-fill", status: "filled" };
      } catch (error) {
        if (error instanceof TitleConflictError) return { type: "title-fill", status: "unchanged" };
        throw error;
      }
    } catch (error) {
      if (error instanceof CreationNotFoundError || error instanceof TitleNotFoundError) throw new RunNotFoundError();
      throw error;
    }
  }
  completeWeave(claim: Claim, promptId: string): void {
    this.guarded("complete weave",claim,run => {
      if (run.kind !== "weave") throw new RunForbiddenError();
      if (!this.readWeaveIntent(run.id)) throw new RunConflictError("Legacy weave subject is unknown");
      if (run.promptId !== promptId) throw new RunFenceError("Prompt is no longer current");
      const step = this.currentStep(run.id);
      if (step.state !== "completed" || step.envelope?.kind !== "complete") throw new RunConflictError("Weave requires an explicit completed final envelope");
      this.db.run("UPDATE runs SET status='completed',generation=generation+1 WHERE id=?",[run.id]);
    });
  }
  fail(claim: Claim): void {
    this.guarded("fail run",claim,run => {
      // Reuse Stop's retention and native-settlement fence, without misreporting failure as successful completion.
      this.finalInterrupt(run);
      this.db.run("UPDATE runs SET status='failed' WHERE id=?",[run.id]);
    });
  }
}
