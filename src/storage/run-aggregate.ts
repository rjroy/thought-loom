import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import type { MaterialKind, Thought } from "../domain/thought";
import type { Connection } from "../domain/connection";
import { RejectionService } from "../domain/rejection";
import { CreationService } from "../domain/creation";
import type { SharedResponse } from "../domain/shared-response";
import { parseEnvelope, protocolJson, type RunStep } from "../domain/run-protocol";
import { requireExecutionRun, requireOrdinaryRun, RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, type Claim, type ContextRef, type NativeState, type RunRecord, type RunStatus } from "../domain/run";
import { isStepOperationCapability, type WeaveIntent } from "../domain/run-operations";
import { SqliteRejectionRepository } from "./rejection";
import { SqliteKnowledgeWriter } from "./knowledge-write";
import { insertRun, readRun } from "./run-record";
import { immediate } from "./transaction";
import { requireSearchExecutionOwner, searchExecutionContextValid } from "./search-run-authority";
import { searchRevision } from "../domain/search-session-guards";
import { assertWeaveCapability, resolveWeavePurpose, type WeavePurpose } from "../domain/weave-scheduling";
import { isReadCapability } from "../domain/capability";
import { interruptOrdinaryRun, issuedRunThoughts, ordinaryRunContextValid, runAssociations, scopedRunVisibility, type RunVisibility } from "./run-fences";

type Associations = Pick<SharedResponse, "role" | "thoughtIds">;
type Visible = RunVisibility;
interface StepRow {
  readonly runId: string;
  readonly position: number;
  readonly promptId: string;
  readonly input: string | null;
  readonly state: RunStep["state"];
  readonly envelopeJson: string | null;
  readonly resultJson: string | null;
}
interface ReceiptRow {
  readonly operation: string;
  readonly result: string;
  readonly thoughtId: string | null;
  readonly format: "legacy" | "step";
}
const stepColumns = "run_id AS runId,position,prompt_id AS promptId,input,state,envelope_json AS envelopeJson,result_json AS resultJson";
function decodeStep(row: StepRow): RunStep {
  return { runId: row.runId, position: row.position, promptId: row.promptId, input: row.input, state: row.state,
    envelope: row.envelopeJson === null ? null : parseEnvelope(row.envelopeJson), result: row.resultJson === null ? null : JSON.parse(row.resultJson) };
}

/** Internal shared run boundary. Knowledge and protocol methods use the same ownership, context, and Stop fences. */
export class SqliteRunAggregate {
  constructor(protected readonly db: Database, protected readonly logger: Logger = createLogger()) {}
  protected transaction<T>(operation: string, runId: string, action: () => T): T {
    this.logger.verbose(`[run storage] ${operation} attempt`, { runId });
    try { const result = immediate(this.db,action); this.logger.verbose(`[run storage] ${operation} succeeded`, { runId }); return result; }
    catch (error) { this.logger.verbose(`[run storage] ${operation} failed`, { runId }); throw error; }
  }
  protected loadRun(id: string): RunRecord | null {
    return readRun(this.db,id);
  }
  protected require(id: string): RunRecord { const run = this.loadRun(id); if (!run) throw new RunNotFoundError(); return run; }
  protected active(claim: Claim): RunRecord {
    const run = this.require(claim.runId);
    if (run.generation !== claim.generation || !["queued","submitting","running","uncertain"].includes(run.status)) throw new RunFenceError();
    if (run.kind === "evolve" && run.inputThoughtId === null) throw new RunFenceError("Legacy evolve input identity unavailable; cannot resume safely");
    if (run.kind === "search") requireSearchExecutionOwner(this.db,run);
    // Also fences native binding/submission and already-prepared/replayed media jobs.
    const purpose = this.weavePurpose(run);
    this.requireWeaveHistory(run,purpose);
    return run;
  }
  /** Persist the interruption before throwing: throwing inside the transaction would undo the fence. */
  protected guarded<T>(operation: string, claim: Claim, action: (run: RunRecord, visible: Visible) => T): T {
    return this.guard(operation,claim,requireOrdinaryRun,action);
  }
  protected guardedExecution<T>(operation: string, claim: Claim, action: (run: RunRecord, visible: Visible) => T): T {
    return this.guard(operation,claim,requireExecutionRun,action);
  }
  private guard<T>(operation: string, claim: Claim, authority: (run: RunRecord) => void, action: (run: RunRecord, visible: Visible) => T): T {
    const outcome = this.transaction(operation, claim.runId, () => {
      const run = this.active(claim);
      authority(run);
      const visible = this.visibility();
      if (!this.contextValid(run,visible)) {
        this.finalInterrupt(run,"context-invalidated");
        return { valid: false } as const;
      }
      return { valid: true, value: action(run,visible) } as const;
    });
    if (!outcome.valid) {
      this.logger.verbose("[run storage] rejected context fenced", { runId: claim.runId, generation: claim.generation });
      throw new RunFenceError();
    }
    return outcome.value;
  }
  protected rejection(): RejectionService { return new RejectionService(new SqliteRejectionRepository(this.db,this.logger)); }
  protected creation(sources: { readonly id: () => string; readonly now: () => string }): CreationService {
    const store = new SqliteKnowledgeWriter(this.db,this.logger);
    return new CreationService({ rejection: this.rejection(), ...sources, writes: {
      createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection),
    } });
  }
  protected transitionNative(claim: Claim, status: RunStatus, nativeState?: NativeState, promptId?: string): void {
    const transition = this.guardedExecution("status",claim,run => {
      if (run.kind === "search" && status === "submitting") throw new RunForbiddenError("Search submission requires its durable owner authorization");
      if (promptId !== undefined && promptId !== run.promptId) throw new RunFenceError("Native callback belongs to an earlier prompt");
      const allowed: Partial<Record<RunStatus, readonly RunStatus[]>> = {queued:["submitting"],submitting:["running","uncertain"],running:["running","uncertain"],uncertain:["running","uncertain"]};
      if (!allowed[run.status]?.includes(status)) throw new RunConflictError();
      const evidence = run.nativeState === "completed" ? "completed" : nativeState ?? run.nativeState;
      const step = this.currentStep(run.id);
      const stepState = evidence === "completed" ? "completed" : status === "uncertain" ? "uncertain" : "submitting";
      this.db.run("UPDATE run_steps SET state=?,native_state=? WHERE run_id=? AND prompt_id=?",[stepState,evidence,run.id,step.promptId]);
      const localStatus = evidence === "completed" ? "uncertain" : status;
      this.db.run("UPDATE runs SET status=? WHERE id=?",[localStatus,run.id]);
      return {from:run.status,to:localStatus,promptId:step.promptId,nativeState:evidence};
    });
    this.logger.verbose("[run storage] status committed",{runId:claim.runId,generation:claim.generation,...transition});
  }
  protected insertRun(run: RunRecord, intent: WeaveIntent | null = null): void {
    insertRun(this.db,run,intent);
  }
  protected readWeaveIntent(runId: string): WeaveIntent | null {
    const row = this.db.query("SELECT weave_subject_id AS subjectId,weave_trigger_id AS triggerId FROM runs WHERE id=?").get(runId) as { subjectId: string | null; triggerId: string | null } | null;
    if (!row || row.subjectId === null || row.triggerId === null) return null;
    return { subjectId: row.subjectId, triggerId: row.triggerId };
  }
  private weaveSubject(run: RunRecord): { readonly kind: MaterialKind; readonly triggerId: string } | null {
    if (run.kind !== "weave") return null;
    const intent = this.readWeaveIntent(run.id);
    if (!intent) return null; // Legacy unknown input keeps its existing, limited operation checks.
    const subject = this.db.query<{ kind: MaterialKind }, [string]>("SELECT kind FROM thoughts WHERE id=?").get(intent.subjectId);
    if (!subject) throw new RunNotFoundError();
    return { kind: subject.kind, triggerId: intent.triggerId };
  }
  protected weavePurpose(run: RunRecord): WeavePurpose {
    const subject = this.weaveSubject(run);
    return subject === null ? "ordinary" : resolveWeavePurpose(subject.kind,subject.triggerId);
  }
  protected requireWeaveCapability(run: RunRecord, capability: string): void {
    assertWeaveCapability(this.weavePurpose(run),capability);
  }
  private requireWeaveHistory(run: RunRecord, purpose: WeavePurpose): void {
    if (purpose !== "media-title-only") return;
    // Check retained protocol, not prompt wording. A prepared successor may already contain a forbidden cached read.
    // Do not load or rewrite input/result bytes merely to establish execution eligibility.
    const history = this.db.query<{ promptId: string; state: RunStep["state"]; envelope: string | null; hasResult: number }, [string]>(
      `SELECT prompt_id AS promptId,state,envelope_json AS envelope,result_json IS NOT NULL AS hasResult
       FROM run_steps WHERE run_id=? ORDER BY position`).all(run.id);
    for (const step of history) {
      const predecessor = step.promptId !== run.promptId;
      if (predecessor && (step.state !== "processed" || step.hasResult === 0)) {
        throw new RunForbiddenError("Media title-only history has an unconfirmed predecessor");
      }
      // A current, unprocessed request may be recorded for audit, then denied by dispatch and retired by failure.
      // Once it has a result, was processed, or has a successor, it must have been an authorized title-only request.
      if (!predecessor && step.state !== "processed" && step.hasResult === 0) continue;
      const envelope = step.envelope === null ? null : parseEnvelope(step.envelope);
      if (envelope?.kind !== "request") throw new RunForbiddenError("Media title-only history has no authorized predecessor request");
      assertWeaveCapability(purpose,envelope.request.capability);
    }
  }
  protected readReceipt(runId: string, operationId: string): ReceiptRow | null {
    return this.db.query(`SELECT operation_json AS operation,result_json AS result,thought_id AS thoughtId,format
      FROM run_operation_receipts WHERE run_id=? AND operation_id=?`).get(runId,operationId) as ReceiptRow | null;
  }
  protected appendIssued(runId: string, operationId: string, thoughtId: string): void {
    this.db.run(`INSERT INTO run_issued_thoughts (run_id,operation_id,thought_id,position)
      SELECT ?,?,?,COALESCE(MAX(position)+1,0) FROM run_issued_thoughts WHERE run_id=?`,[runId,operationId,thoughtId,runId]);
  }
  protected readSteps(runId: string): readonly RunStep[] {
    const rows = this.db.query(`SELECT ${stepColumns} FROM run_steps WHERE run_id=? ORDER BY position`).all(runId) as StepRow[];
    return rows.map(decodeStep);
  }
  protected readStep(runId: string, promptId: string): RunStep | null {
    const row = this.db.query(`SELECT ${stepColumns} FROM run_steps WHERE run_id=? AND prompt_id=?`).get(runId,promptId) as StepRow | null;
    return row === null ? null : decodeStep(row);
  }
  protected currentStep(runId: string): RunStep {
    const row = this.db.query(`SELECT ${stepColumns} FROM run_steps WHERE run_id=? ORDER BY position DESC LIMIT 1`).get(runId) as StepRow | null;
    if (!row) throw new RunConflictError("Run has no current prompt");
    return decodeStep(row);
  }
  /** A successor uses the exact result already confirmed by its canonical dispatcher. */
  protected confirmedStepResult(step: RunStep, result: unknown): string {
    const resultJson = protocolJson(result);
    if (step.result !== null && protocolJson(step.result) !== resultJson) throw new RunConflictError("Result differs from the dispatched step result");
    if (step.envelope?.kind === "request" && isReadCapability(step.envelope.request.capability) && step.result === null) {
      throw new RunConflictError("Read result must be committed with its context witnesses before advancing");
    }
    if (step.envelope?.kind === "request" && isStepOperationCapability(step.envelope.request.capability)) {
      const receipt = this.readReceipt(step.runId,step.promptId);
      if (!receipt || receipt.format !== "step" || protocolJson(JSON.parse(receipt.result)) !== resultJson) {
        throw new RunConflictError("Write result must match its committed step receipt");
      }
    }
    return resultJson;
  }
  protected issued(id: string): readonly string[] {
    return issuedRunThoughts(this.db,id);
  }
  protected associations(run: RunRecord): Associations | null {
    return runAssociations(this.db,run);
  }
  protected checkAssociations(run: RunRecord, response: SharedResponse, visible: Visible): void {
    const expected = this.associations(run);
    if (!expected || response.role !== expected.role || response.thoughtIds.length !== expected.thoughtIds.length ||
        response.thoughtIds.some((id,index) => id !== expected.thoughtIds[index])) throw new RunConflictError("Reply must link this run's results in issued order");
    if (response.thoughtIds.some(id => !visible({kind:"thought",id}))) throw new RunNotFoundError();
  }
  protected finalInterrupt(run: RunRecord, reason: "stopped" | "context-invalidated" | "failed" = "stopped"): void {
    if (run.kind === "search") {
      searchRevision(run.generation + 1);
      this.db.run("UPDATE search_turns SET outcome_reason=? WHERE run_id=? AND outcome_reason IS NULL",[reason,run.id]);
      this.db.run("UPDATE runs SET status='interrupted',generation=generation+1,cancellation_state='pending' WHERE id=?",[run.id]);
      return;
    }
    if (run.kind === "import") {
      this.db.run("UPDATE markdown_import_files SET outcome='interrupted',reason_code='interrupted' WHERE run_id=? AND outcome IS NULL",[run.id]);
      this.db.run("DELETE FROM markdown_import_payloads WHERE file_id IN (SELECT id FROM markdown_import_files WHERE run_id=? AND outcome IS NOT NULL)",[run.id]);
      this.db.run("UPDATE runs SET status='interrupted',generation=generation+1,cancellation_state='pending' WHERE id=?",[run.id]);
      return;
    }
    interruptOrdinaryRun(this.db,run,reason,this.logger);
  }
  /** Scoped reads cached only for this synchronous transaction, not across rejection changes. */
  protected visibility(): Visible {
    return scopedRunVisibility(this.rejection());
  }
  contextRefs(runId: string): readonly ContextRef[] {
    return this.db.query("SELECT kind,ref_id AS id FROM run_context WHERE run_id=? ORDER BY rowid").all(runId) as ContextRef[];
  }
  protected contextValid(run: RunRecord, visible: Visible): boolean {
    if (run.kind === "search") return searchExecutionContextValid(this.db,run.id);
    return ordinaryRunContextValid(this.db,run,visible);
  }
  protected track(id: string, ref: ContextRef, fullRead = false): void {
    // The retained-search INSERT guard deliberately rejects duplicate insertion, even an UPSERT's pre-update path.
    const existing = this.db.query("SELECT full_read AS fullRead FROM run_context WHERE run_id=? AND kind=? AND ref_id=?")
      .get(id,ref.kind,ref.id) as { fullRead: number } | null;
    if (existing) {
      if (fullRead && existing.fullRead === 0) this.db.run("UPDATE run_context SET full_read=1 WHERE run_id=? AND kind=? AND ref_id=?",[id,ref.kind,ref.id]);
      return;
    }
    this.db.run("INSERT INTO run_context (run_id,kind,ref_id,full_read) VALUES (?,?,?,?)", [id,ref.kind,ref.id,fullRead ? 1 : 0]);
  }
  /** IDs in full DTOs are exposures, not evidence that the referenced texts have been read. */
  protected trackThought(runId: string, thought: Thought): void {
    this.track(runId,{kind:"thought",id:thought.id},true);
    for (const id of [...(thought.parentId === null ? [] : [thought.parentId]),...thought.sourceIds]) this.track(runId,{kind:"thought",id});
  }
  protected trackConnection(runId: string, connection: Connection): void {
    this.track(runId,{kind:"connection",id:connection.id},true);
    for (const id of [connection.fromId,connection.toId,...connection.sourceIds]) this.track(runId,{kind:"thought",id});
  }
  protected trackResponse(runId: string, response: SharedResponse): void {
    this.track(runId,{kind:"response",id:response.id},true);
    for (const id of response.thoughtIds) this.track(runId,{kind:"thought",id});
  }
}
