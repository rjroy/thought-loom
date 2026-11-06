import type { Database } from "bun:sqlite";
import { CreationNotFoundError } from "../domain/creation";
import { createSharedResponse, type SharedResponse } from "../domain/shared-response";
import { createThought } from "../domain/thought";
import { nonEmpty, record, references } from "../domain/validation";
import { requireOrdinaryRun, RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, type Admission, type Claim, type ContextRef, type ContextValue, type NativeState, type Operation, type OperationResult, type Receipt, type ReplyDraft, type RunRecord, type RunRepository, type RunSources, type RunStatus } from "../domain/run";
import { SqliteSharedResponses } from "./shared-response";
import { migrate } from "./sqlite";
import { SqliteRunAggregate } from "./run-aggregate";
import { evolveWeaveIntent } from "../domain/weave-scheduling";
import { admitWeave } from "./weave-admission";

/** Durable transaction boundary; never invokes a model or network while holding a SQLite lock. */
export class SqliteRunRepository extends SqliteRunAggregate implements RunRepository {
  constructor(db: Database, private readonly sources: RunSources & { readonly scheduleWeave?: boolean }) { super(db,sources.logger); }
  get(id: string): RunRecord | null { return this.loadRun(id); }
  migrate(): void { migrate(this.db); }
  admit(admission: Admission): void {
    this.transaction("admit", admission.run.id, () => {
      const { run, contribution } = admission;
      requireOrdinaryRun(run);
      if (run.status !== "queued" || run.generation !== 0 || run.nativeState !== "unknown" ||
          (run.kind === "evolve") !== (contribution !== null) || run.inputThoughtId !== (contribution?.id ?? null)) throw new RunConflictError();
      for (const value of [run.id,run.sessionId,run.promptId,run.createdAt]) nonEmpty(value,"run identity");
      if (contribution) {
        if (contribution.parentId === null || contribution.author !== "user" || contribution.kind !== "user-contribution" ||
            contribution.origin !== "contribution" || contribution.title !== null || contribution.titleAuthor !== null ||
            contribution.sourceIds.length || contribution.createdAt !== run.createdAt) throw new RunConflictError();
        try { this.creation({ id: () => contribution.id, now: () => contribution.createdAt }).contribute("user", contribution.parentId, { text: contribution.text }); }
        catch (error) { if (error instanceof CreationNotFoundError) throw new RunNotFoundError(); throw error; }
      }
      this.insertRun(run);
    });
  }
  claim(id: string): Claim {
    const outcome = this.transaction("claim", id, () => {
      const run = this.require(id);
      requireOrdinaryRun(run);
      this.active({ runId: id, generation: run.generation });
      if (!this.contextValid(run,this.visibility())) { this.finalInterrupt(run); return null; }
      const generation = run.generation + 1;
      this.db.run("UPDATE runs SET generation=? WHERE id=?", [generation,id]);
      return { runId: id, generation };
    });
    if (!outcome) {
      this.logger.verbose("[run storage] rejected context fenced", { runId: id });
      throw new RunFenceError();
    }
    this.logger.verbose("[run storage] ownership claimed", { runId: id, generation: outcome.generation });
    return outcome;
  }
  setStatus(claim: Claim, status: RunStatus, nativeState?: NativeState, promptId?: string): void {
    this.transitionNative(claim,status,nativeState,promptId);
  }
  stop(id: string): void { this.transaction("stop", id, () => {
    const run = this.require(id);
    if (["completed","interrupted","failed"].includes(run.status)) return;
    this.finalInterrupt(run);
  }); }
  expose(claim: Claim, ref: ContextRef): ContextValue | null { return this.transaction("expose", claim.runId, () => {
    const run = this.require(claim.runId);
    requireOrdinaryRun(run);
    if (run.status === "interrupted" && run.generation !== claim.generation) return null;
    this.active(claim);
    const visible = this.visibility();
    if (!this.contextValid(run,visible)) { this.finalInterrupt(run); return null; }
    nonEmpty(ref.id, "id");
    const value = visible(ref);
    if (value) this.track(claim.runId,ref);
    return value;
  }); }
  private receiptRead(runId: string, operationId: string): Receipt | null {
    const row = this.readReceipt(runId,operationId);
    if (!row) return null;
    if (row.format !== "legacy") throw new RunConflictError("Receipt belongs to a typed step operation");
    const data = record(JSON.parse(row.operation));
    if (data.type !== "development") throw new RunConflictError();
    const operation: Operation = { id: nonEmpty(data.id,"id"), type: "development", parentId: nonEmpty(data.parentId,"parentId"), text: nonEmpty(data.text,"text"), sourceIds: references(data.sourceIds,"sourceIds") };
    return { operation, result: { thought: createThought(JSON.parse(row.result)) } };
  }
  receipt(runId: string, operationId: string): Receipt | null { return this.receiptRead(runId,operationId); }
  commit(claim: Claim, input: Operation): OperationResult {
    return this.guarded("commit", claim, (run,visible) => {
      if (run.kind !== "weave" && run.kind !== "evolve") throw new RunForbiddenError();
      if (input.type !== "development") throw new RunForbiddenError();
      const operation: Operation = { id: nonEmpty(input.id,"id"), type: "development", parentId: nonEmpty(input.parentId,"parentId"), text: nonEmpty(input.text,"text"), sourceIds: references(input.sourceIds,"sourceIds") };
      if (run.kind === "evolve" && operation.parentId !== run.inputThoughtId) throw new RunConflictError("Development parent must be the admitted contribution");
      const existing = this.receiptRead(claim.runId,operation.id);
      if (existing) {
        if (JSON.stringify(existing.operation) !== JSON.stringify(operation)) throw new RunConflictError();
        if ([operation.parentId, ...operation.sourceIds].some(id => !visible({ kind: "thought", id }))) throw new RunFenceError();
        if (!visible({kind:"thought",id:existing.result.thought.id})) throw new RunFenceError();
        return existing.result;
      }
      if ([operation.parentId, ...operation.sourceIds].some(id => !visible({ kind: "thought", id }))) throw new RunNotFoundError();
      try {
        const thought = this.creation(this.sources).develop("ai", operation.parentId, { text: operation.text, sourceIds: operation.sourceIds });
        this.db.run("INSERT INTO run_operation_receipts (run_id,operation_id,operation_json,thought_id,result_json) VALUES (?,?,?,?,?)", [claim.runId,operation.id,JSON.stringify(operation),thought.id,JSON.stringify(thought)]);
        this.appendIssued(claim.runId,operation.id,thought.id);
        // The returned result exposes these references too; later publication cannot reuse rejected provenance.
        for (const id of [operation.parentId,...operation.sourceIds,thought.id]) this.track(claim.runId,{kind:"thought",id});
        return { thought };
      } catch (error) { if (error instanceof CreationNotFoundError) throw new RunNotFoundError(); throw error; }
    });
  }
  recordPartial(claim: Claim, draft: ReplyDraft): void {
    this.guarded("partial", claim, (run,visible) => {
      if (run.kind !== "weave" && run.kind !== "evolve") throw new RunForbiddenError();
      const checked = createSharedResponse({ ...draft, state: "interrupted" });
      this.checkAssociations(run,checked,visible);
      this.db.run("INSERT INTO run_replies (run_id,draft_json) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET draft_json=excluded.draft_json", [claim.runId,JSON.stringify({ id: checked.id,text: checked.text,role: checked.role,thoughtIds: checked.thoughtIds })]);
    });
  }
  reply(runId: string): SharedResponse | null {
    const row = this.db.query("SELECT response_id AS id FROM run_replies WHERE run_id=?").get(runId) as {id: string | null} | null;
    return row?.id ? new SqliteSharedResponses(this.db,this.logger).get(row.id) : null;
  }
  finish(claim: Claim, response: SharedResponse): void {
    this.guarded("finish", claim, (run,visible) => {
      if (run.kind !== "weave" && run.kind !== "evolve") throw new RunForbiddenError();
      const value = createSharedResponse(response);
      this.checkAssociations(run,value,visible);
      new SqliteSharedResponses(this.db,this.logger).save(value);
      this.db.run("INSERT INTO run_replies (run_id,response_id) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET draft_json=NULL,response_id=excluded.response_id", [claim.runId,value.id]);
      const intent = evolveWeaveIntent(run,value,this.issued(run.id));
      if (this.sources.scheduleWeave && intent) admitWeave(this.db,this.sources,intent);
      this.db.run("UPDATE runs SET status=?,generation=generation+1 WHERE id=?", [value.state === "complete" ? "completed" : "interrupted",claim.runId]);
    });
  }
}
