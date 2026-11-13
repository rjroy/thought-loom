import type { Database } from "bun:sqlite";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import { assertConnectionOperationRecord, parseConnectionOperationResult, parseStepOperation, stepOperationEnvelope, stepOperationScope, type ConnectionOperationResult, type RunOperations, type StepOperation, type StepOperationResult, type StepReceipt, type WeaveIntent } from "../domain/run-operations";
import { protocolJson } from "../domain/run-protocol";
import { CreationNotFoundError } from "../domain/creation";
import { createThought } from "../domain/thought";
import { createSharedResponse } from "../domain/shared-response";
import { TitleConflictError, TitleNotFoundError, TitleService } from "../domain/title";
import { record } from "../domain/validation";
import { assertWeaveCapability, connectionDiscoveryIntent } from "../domain/weave-scheduling";
import { SqliteRunAggregate } from "./run-aggregate";
import { SqliteTitleRepository } from "./title";
import { admitWeave } from "./weave-admission";
import { SqliteSharedResponses } from "./shared-response";
import type { RunVisibility } from "./run-fences";
import { dailyReviewInstant } from "../domain/daily-review";

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
      if (data.type === "connection" && operation.type === "connection") {
        result = parseConnectionOperationResult(operation,data);
        assertConnectionOperationRecord(result,result.status === "not-created" ? null : this.storedConnection(result.connection.id));
      }
      else if (data.type === "title-fill" && (data.status === "filled" || data.status === "unchanged")) result = { type: "title-fill", status: data.status };
      else throw new RunConflictError("Invalid receipt result");
    }
    return { operation, result };
  }
  executeStep(claim: Claim, promptId: string, input: StepOperation): StepOperationResult {
    const result = this.guarded("execute step",claim,(run,visible) => {
      if (run.kind !== "weave" && run.kind !== "evolve") throw new RunForbiddenError();
      const operation = parseStepOperation(input);
      this.requireWeaveCapability(run,operation.type);
      const step = this.readStep(run.id,promptId);
      if (!step || !["completed","processed"].includes(step.state) ||
          protocolJson(step.envelope) !== protocolJson(stepOperationEnvelope(operation))) throw new RunConflictError("Operation differs from the completed prompt request");
      const { subjectId, refs } = stepOperationScope(run,this.readWeaveIntent(run.id),operation,this.weavePurpose(run));
      if (refs.some(id => !visible({kind:"thought",id}))) throw new RunNotFoundError();
      if (operation.type === "connection") for (const id of refs) {
        if (!this.db.query("SELECT 1 FROM run_context WHERE run_id=? AND kind='thought' AND ref_id=? AND full_read=1").get(run.id,id)) {
          throw new RunForbiddenError("A full read is required before using a thought as evidence");
        }
      }
      const existing = this.stepReceipt(run.id,step.promptId);
      if (existing) {
        if (protocolJson(existing.operation) !== protocolJson(operation)) throw new RunConflictError("Receipt proposal differs");
        return existing.result;
      }
      if (step.promptId !== run.promptId || step.state !== "completed") throw new RunFenceError("Prompt is no longer current");
      if (operation.type === "interpretation" && subjectId !== null &&
          this.db.query("SELECT 1 FROM thoughts WHERE id=? AND kind='media-original'").get(subjectId)) {
        if (this.weavePurpose(run) === "reinterpretation") {
          if (this.hasIssuedInterpretation(run.id,subjectId)) throw new RunConflictError("This media run already issued its interpretation");
        } else if (this.db.query("SELECT 1 FROM thoughts WHERE parent_id=? AND kind='ai-interpretation'").get(subjectId)) {
          throw new RunConflictError("Source already has an initial interpretation; use Evolve");
        }
      }
      const effect = operation.type === "connection" ? this.connect(operation,visible) : this.apply(operation,subjectId);
      const thoughtId = effect.type === "development" || effect.type === "interpretation" ? effect.thought.id : null;
      this.db.run(`INSERT INTO run_operation_receipts (run_id,operation_id,operation_json,thought_id,result_json,format) VALUES (?,?,?,?,?,'step')`,
        [run.id,step.promptId,protocolJson(operation),thoughtId,protocolJson(effect)]);
      if (thoughtId !== null) {
        this.appendIssued(run.id,step.promptId,thoughtId);
        admitWeave(this.db,this.sources,connectionDiscoveryIntent(thoughtId,run.id));
      }
      for (const id of refs) this.track(run.id,{kind:"thought",id});
      if (thoughtId !== null) this.track(run.id,{kind:"thought",id:thoughtId});
      if (effect.type === "connection" && effect.status !== "not-created") this.trackConnection(run.id,effect.connection);
      return effect;
    });
    this.logger.verbose("[run storage] step operation confirmed", { runId: claim.runId, promptId, type: result.type, generation: claim.generation });
    return result;
  }
  private hasIssuedInterpretation(runId: string, subjectId: string): boolean {
    return this.db.query(`SELECT 1 FROM run_issued_thoughts issued JOIN thoughts t ON t.id=issued.thought_id
      WHERE issued.run_id=? AND t.parent_id=? AND t.kind='ai-interpretation'`).get(runId,subjectId) !== null;
  }
  /** Caller has already fenced claim/prompt/purpose, visibility and all full-read witnesses in this immediate transaction. */
  private connect(operation: Extract<StepOperation,{type:"connection"}>, visible: RunVisibility): ConnectionOperationResult {
    const key = [operation.fromId,operation.toId,operation.category];
    // Only identity metadata crosses this suppression boundary. Never return or witness a rejected relation.
    if (this.db.query(`SELECT 1 FROM connections c JOIN rejected_connections r ON r.connection_id=c.id
      WHERE c.from_id=? AND c.to_id=? AND c.category=? LIMIT 1`).get(...key)) return {type:"connection",status:"not-created"};
    const matches = this.db.query<{id:string},[string,string,string]>(`SELECT id FROM connections
      WHERE from_id=? AND to_id=? AND category=? ORDER BY rowid`).all(operation.fromId,operation.toId,operation.category);
    for (const match of matches) {
      const connection = visible({kind:"connection",id:match.id});
      if (connection && "fromId" in connection) return {type:"connection",status:"already-present",connection};
    }
    if (matches.length) return {type:"connection",status:"not-created"};
    try { return {type:"connection",status:"created",connection:this.creation(this.sources).connect("ai",operation)}; }
    catch (error) { if (error instanceof CreationNotFoundError) throw new RunNotFoundError(); throw error; }
  }
  private apply(operation: Exclude<StepOperation,{type:"connection"}>, subjectId: string | null): StepOperationResult {
    try {
      if (operation.type === "development") return { type: "development", thought: this.creation(this.sources).develop("ai",operation.parentId,operation) };
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
      const intent = this.readWeaveIntent(run.id);
      if (!intent) throw new RunConflictError("Legacy weave subject is unknown");
      if (run.promptId !== promptId) throw new RunFenceError("Prompt is no longer current");
      const step = this.currentStep(run.id);
      const purpose = this.weavePurpose(run);
      if (purpose === "daily-review") {
        if (step.input === null || step.state !== "completed" || step.envelope?.kind !== "review-complete") {
          throw new RunConflictError("Daily review requires both completed checks");
        }
        const completedAt = dailyReviewInstant(this.sources.now());
        this.db.run("UPDATE runs SET status='completed',generation=generation+1,cancellation_state='none' WHERE id=?",[run.id]);
        const changed = this.db.run("UPDATE daily_review_items SET completed_at=? WHERE run_id=? AND completed_at IS NULL",[completedAt,run.id]);
        if (changed.changes !== 1) throw new RunConflictError("Daily review completion membership unavailable");
        return;
      }
      if (step.state !== "completed" || step.envelope?.kind !== "complete") throw new RunConflictError("Weave requires an explicit completed final envelope");
      // Associate the subject and every issued thought: a rejected summary must not
      // expose an outcome that may describe it to AI through another association.
      const issued = this.issued(run.id);
      if (purpose === "connection-only") {
        if (issued.length) throw new RunForbiddenError("Discovery cannot publish issued knowledge");
        // The canonical complete envelope is internal history, never a searchable/public Full reply.
        this.db.run("UPDATE runs SET status='completed',generation=generation+1,cancellation_state='none' WHERE id=?",[run.id]);
        return;
      }
      if (purpose === "media-title-only") {
        if (issued.length) throw new RunForbiddenError("Media title-only work cannot publish issued knowledge");
        // A later complete envelope cannot launder a retained forbidden request or a legacy receipt.
        for (const earlier of this.readSteps(run.id)) {
          if (earlier.envelope?.kind === "request") assertWeaveCapability("media-title-only",earlier.envelope.request.capability);
        }
        const receipts = this.db.query<{ format: string; operation: string }, [string]>(
          "SELECT format,operation_json AS operation FROM run_operation_receipts WHERE run_id=?").all(run.id);
        for (const receipt of receipts) {
          if (receipt.format !== "step") throw new RunForbiddenError("Media title-only work cannot publish legacy operations");
          assertWeaveCapability("media-title-only",parseStepOperation(JSON.parse(receipt.operation)).type);
        }
      }
      const response = createSharedResponse({ id: this.sources.id(), text: step.envelope.reply, state: "complete",
        role: issued.length ? "addendum" : "fallback", thoughtIds: [intent.subjectId,...issued] });
      new SqliteSharedResponses(this.db,this.logger).save(response);
      this.db.run("INSERT INTO run_replies (run_id,response_id) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET draft_json=NULL,response_id=excluded.response_id",[run.id,response.id]);
      const missingInterpretation = purpose !== "media-title-only" &&
        this.db.query("SELECT 1 FROM thoughts WHERE id=? AND kind='media-original'").get(intent.subjectId) !== null &&
        (purpose === "reinterpretation" ? !this.hasIssuedInterpretation(run.id,intent.subjectId) :
          this.db.query("SELECT 1 FROM thoughts WHERE parent_id=? AND kind='ai-interpretation'").get(intent.subjectId) === null);
      this.db.run("UPDATE runs SET status=?,generation=generation+1,cancellation_state=? WHERE id=?",
        [missingInterpretation ? "failed" : "completed",missingInterpretation ? "pending" : "none",run.id]);
    });
  }
  fail(claim: Claim): void {
    this.guardedExecution("fail run",claim,run => {
      // Reuse Stop's retention and native-settlement fence, without misreporting failure as successful completion.
      this.finalInterrupt(run,"failed");
      this.db.run("UPDATE runs SET status='failed' WHERE id=?",[run.id]);
    });
  }
}
