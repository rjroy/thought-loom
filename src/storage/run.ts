import type { Database } from "bun:sqlite";
import { CreationService, CreationNotFoundError } from "../domain/creation";
import { RejectionService } from "../domain/rejection";
import { createSharedResponse, type SharedResponse } from "../domain/shared-response";
import { createThought } from "../domain/thought";
import type { Thought } from "../domain/thought";
import type { Connection } from "../domain/connection";
import { nonEmpty, record, references } from "../domain/validation";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, type Admission, type Claim, type ContextRef, type ContextValue, type NativeState, type Operation, type OperationResult, type Receipt, type ReplyDraft, type RunRecord, type RunRepository, type RunStatus } from "../domain/run";
import { SqliteRejectionRepository } from "./rejection";
import { SqliteSharedResponses } from "./shared-response";
import { migrate, SqliteStore } from "./sqlite";

type Associations = Pick<SharedResponse, "role" | "thoughtIds">;
type Visible = (ref: ContextRef) => ContextValue | null;

/** Durable transaction boundary; never invokes a model or network while holding a SQLite lock. */
export class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: Database, private readonly sources: { readonly id: () => string; readonly now: () => string }) {}
  private transaction<T>(operation: string, runId: string, action: () => T): T {
    console.info(`[run storage] ${operation} attempt`, { runId });
    try { const result = this.db.transaction(action).immediate(); console.info(`[run storage] ${operation} succeeded`, { runId }); return result; }
    catch (error) { console.error(`[run storage] ${operation} failed`, { runId }); throw error; }
  }
  migrate(): void { migrate(this.db); }
  private load(id: string): RunRecord | null {
    return this.db.query(`SELECT id,kind,status,session_id AS sessionId,prompt_id AS promptId,created_at AS createdAt,generation,
      input_thought_id AS inputThoughtId,native_state AS nativeState FROM runs WHERE id=?`).get(id) as RunRecord | null;
  }
  get(id: string): RunRecord | null { return this.load(id); }
  private require(id: string): RunRecord { const run = this.load(id); if (!run) throw new RunNotFoundError(); return run; }
  private active(claim: Claim): RunRecord {
    const run = this.require(claim.runId);
    if (run.generation !== claim.generation || !["queued","submitting","running","uncertain"].includes(run.status)) throw new RunFenceError();
    if (run.kind === "evolve" && run.inputThoughtId === null) throw new RunFenceError("Legacy evolve input identity unavailable; cannot resume safely");
    return run;
  }
  /** Commit the interruption before throwing: throwing inside the transaction would undo the fence. */
  private guarded<T>(operation: string, claim: Claim, action: (run: RunRecord, visible: Visible) => T): T {
    const outcome = this.transaction(operation, claim.runId, () => {
      const run = this.active(claim);
      const visible = this.visibility();
      if (!this.contextValid(run,visible)) {
        this.finalInterrupt(run);
        return { valid: false } as const;
      }
      return { valid: true, value: action(run,visible) } as const;
    });
    if (!outcome.valid) {
      console.info("[run storage] rejected context fenced", { runId: claim.runId, generation: claim.generation });
      throw new RunFenceError();
    }
    return outcome.value;
  }
  private rejection(): RejectionService { return new RejectionService(new SqliteRejectionRepository(this.db)); }
  private creation(id = this.sources.id, now = this.sources.now): CreationService {
    const store = new SqliteStore(this.db);
    return new CreationService({ rejection: this.rejection(), id, now, writes: {
      createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection),
    } });
  }
  admit(admission: Admission): void {
    this.transaction("admit", admission.run.id, () => {
      const { run, contribution } = admission;
      if (run.status !== "queued" || run.generation !== 0 || run.nativeState !== "unknown" ||
          (run.kind === "evolve") !== (contribution !== null) || run.inputThoughtId !== (contribution?.id ?? null)) throw new RunConflictError();
      for (const value of [run.id,run.sessionId,run.promptId,run.createdAt]) nonEmpty(value,"run identity");
      if (contribution) {
        if (contribution.parentId === null || contribution.author !== "user" || contribution.kind !== "user-contribution" ||
            contribution.origin !== "contribution" || contribution.title !== null || contribution.titleAuthor !== null ||
            contribution.sourceIds.length || contribution.createdAt !== run.createdAt) throw new RunConflictError();
        try { this.creation(() => contribution.id, () => contribution.createdAt).contribute("user", contribution.parentId, { text: contribution.text }); }
        catch (error) { if (error instanceof CreationNotFoundError) throw new RunNotFoundError(); throw error; }
      }
      this.db.run("INSERT INTO runs (id,kind,status,session_id,prompt_id,created_at,generation,input_thought_id,native_state) VALUES (?,?,?,?,?,?,?,?,?)",
        [run.id,run.kind,run.status,run.sessionId,run.promptId,run.createdAt,run.generation,run.inputThoughtId,run.nativeState]);
    });
  }
  claim(id: string): Claim {
    const outcome = this.transaction("claim", id, () => {
      const run = this.require(id);
      this.active({ runId: id, generation: run.generation });
      if (!this.contextValid(run,this.visibility())) { this.finalInterrupt(run); return null; }
      const generation = run.generation + 1;
      this.db.run("UPDATE runs SET generation=? WHERE id=?", [generation,id]);
      return { runId: id, generation };
    });
    if (!outcome) {
      console.info("[run storage] rejected context fenced", { runId: id });
      throw new RunFenceError();
    }
    console.info("[run storage] ownership claimed", { runId: id, generation: outcome.generation });
    return outcome;
  }
  setStatus(claim: Claim, status: RunStatus, nativeState?: NativeState): void {
    const transition = this.guarded("status", claim, run => {
      const allowed: Partial<Record<RunStatus, readonly RunStatus[]>> = { queued: ["submitting"], submitting: ["running","uncertain"], running: ["running","uncertain"], uncertain: ["running","uncertain"] };
      if (!allowed[run.status]?.includes(status)) throw new RunConflictError();
      const evidence = run.nativeState === "completed" ? "completed" : nativeState ?? run.nativeState;
      this.db.run("UPDATE runs SET status=?,native_state=? WHERE id=?", [status,evidence,claim.runId]);
      return { from: run.status, to: status, nativeState: evidence };
    });
    console.info("[run storage] status committed", { runId: claim.runId, generation: claim.generation, ...transition });
  }
  private issued(id: string): readonly string[] {
    const rows = this.db.query("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(id) as { id: string }[];
    return rows.map(row => row.id);
  }
  private associations(run: RunRecord): Associations | null {
    const thoughtIds = this.issued(run.id);
    if (thoughtIds.length) return { role: "addendum", thoughtIds };
    return run.kind === "evolve" && run.inputThoughtId !== null ? { role: "fallback", thoughtIds: [run.inputThoughtId] } : null;
  }
  private checkAssociations(run: RunRecord, response: SharedResponse, visible: Visible): void {
    const expected = this.associations(run);
    if (!expected || response.role !== expected.role || response.thoughtIds.length !== expected.thoughtIds.length ||
        response.thoughtIds.some((id,index) => id !== expected.thoughtIds[index])) throw new RunConflictError("Reply must link this run's results in issued order");
    if (response.thoughtIds.some(id => !visible({kind:"thought",id}))) throw new RunNotFoundError();
  }
  private finalInterrupt(run: RunRecord): void {
    const row = this.db.query("SELECT draft_json AS draft, response_id AS responseId FROM run_replies WHERE run_id=?").get(run.id) as { draft: string | null; responseId: string | null } | null;
    const associations = this.associations(run);
    if (row?.draft && !row.responseId && associations) {
      // Draft text may predate later commits. Membership always comes from the durable operation aggregate.
      const response = createSharedResponse({ ...record(JSON.parse(row.draft)), ...associations, state: "interrupted" });
      new SqliteSharedResponses(this.db).save(response);
      this.db.run("UPDATE run_replies SET draft_json=NULL,response_id=? WHERE run_id=?", [response.id,run.id]);
    }
    // Unmapped legacy input is retained as-is; it must not be guessed to manufacture a response association.
    this.db.run("UPDATE runs SET status='interrupted',generation=generation+1 WHERE id=?", [run.id]);
  }
  stop(id: string): void { this.transaction("stop", id, () => {
    const run = this.require(id);
    if (["completed","interrupted","failed"].includes(run.status)) return;
    this.finalInterrupt(run);
  }); }
  /** Scoped reads cached only for this synchronous transaction, not across rejection changes. */
  private visibility(): Visible {
    const service = this.rejection(); const scope = { actor: "ai", mode: "normal" } as const;
    let thoughts: ReadonlyMap<string, Thought> | undefined;
    let connections: ReadonlyMap<string, Connection> | undefined;
    const responses = new Map<string, SharedResponse | null>();
    return ref => {
      if (ref.kind === "thought") {
        thoughts ??= new Map(service.listThoughts(scope).map(item => [item.id,item]));
        return thoughts.get(ref.id) ?? null;
      }
      if (ref.kind === "connection") {
        connections ??= new Map(service.listConnections(scope).map(item => [item.id,item]));
        return connections.get(ref.id) ?? null;
      }
      if (ref.kind !== "response") throw new RunConflictError();
      if (!responses.has(ref.id)) responses.set(ref.id,service.getResponse(scope,ref.id));
      return responses.get(ref.id) ?? null;
    };
  }
  contextRefs(runId: string): readonly ContextRef[] {
    return this.db.query("SELECT kind,ref_id AS id FROM run_context WHERE run_id=? ORDER BY rowid").all(runId) as ContextRef[];
  }
  private contextValid(run: RunRecord, visible: Visible): boolean {
    const thoughtIds = [...this.issued(run.id), ...(run.inputThoughtId === null ? [] : [run.inputThoughtId])];
    return thoughtIds.every(id => visible({kind:"thought",id}) !== null) &&
      this.contextRefs(run.id).every(ref => visible(ref) !== null);
  }
  private track(id: string, ref: ContextRef): void {
    this.db.run("INSERT OR IGNORE INTO run_context (run_id,kind,ref_id) VALUES (?,?,?)", [id,ref.kind,ref.id]);
  }
  expose(claim: Claim, ref: ContextRef): ContextValue | null { return this.transaction("expose", claim.runId, () => {
    const run = this.require(claim.runId);
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
    const row = this.db.query("SELECT operation_json AS operation, result_json AS result FROM run_operation_receipts WHERE run_id=? AND operation_id=?").get(runId,operationId) as { operation: string; result: string } | null;
    if (!row) return null;
    const data = record(JSON.parse(row.operation));
    if (data.type !== "development") throw new RunConflictError();
    const operation: Operation = { id: nonEmpty(data.id,"id"), type: "development", parentId: nonEmpty(data.parentId,"parentId"), text: nonEmpty(data.text,"text"), sourceIds: references(data.sourceIds,"sourceIds") };
    return { operation, result: { thought: createThought(JSON.parse(row.result)) } };
  }
  receipt(runId: string, operationId: string): Receipt | null { return this.receiptRead(runId,operationId); }
  commit(claim: Claim, input: Operation): OperationResult {
    return this.guarded("commit", claim, (run,visible) => {
      if (run.kind === "export") throw new RunForbiddenError();
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
        const thought = this.creation().develop("ai", operation.parentId, { text: operation.text, sourceIds: operation.sourceIds });
        this.db.run("INSERT INTO run_operation_receipts (run_id,operation_id,operation_json,thought_id,result_json) VALUES (?,?,?,?,?)", [claim.runId,operation.id,JSON.stringify(operation),thought.id,JSON.stringify(thought)]);
        this.db.run(`INSERT INTO run_issued_thoughts (run_id,operation_id,thought_id,position)
          SELECT ?,?,?,COALESCE(MAX(position)+1,0) FROM run_issued_thoughts WHERE run_id=?`, [claim.runId,operation.id,thought.id,claim.runId]);
        // The returned result exposes these references too; later publication cannot reuse rejected provenance.
        for (const id of [operation.parentId,...operation.sourceIds,thought.id]) this.track(claim.runId,{kind:"thought",id});
        return { thought };
      } catch (error) { if (error instanceof CreationNotFoundError) throw new RunNotFoundError(); throw error; }
    });
  }
  recordPartial(claim: Claim, draft: ReplyDraft): void {
    this.guarded("partial", claim, (run,visible) => {
      if (run.kind === "export") throw new RunForbiddenError();
      const checked = createSharedResponse({ ...draft, state: "interrupted" });
      this.checkAssociations(run,checked,visible);
      this.db.run("INSERT INTO run_replies (run_id,draft_json) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET draft_json=excluded.draft_json", [claim.runId,JSON.stringify({ id: checked.id,text: checked.text,role: checked.role,thoughtIds: checked.thoughtIds })]);
    });
  }
  reply(runId: string): SharedResponse | null {
    const row = this.db.query("SELECT response_id AS id FROM run_replies WHERE run_id=?").get(runId) as {id: string | null} | null;
    return row?.id ? new SqliteSharedResponses(this.db).get(row.id) : null;
  }
  finish(claim: Claim, response: SharedResponse): void {
    this.guarded("finish", claim, (run,visible) => {
      if (run.kind === "export") throw new RunForbiddenError();
      const value = createSharedResponse(response);
      this.checkAssociations(run,value,visible);
      new SqliteSharedResponses(this.db).save(value);
      this.db.run("INSERT INTO run_replies (run_id,response_id) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET draft_json=NULL,response_id=excluded.response_id", [claim.runId,value.id]);
      this.db.run("UPDATE runs SET status=?,generation=generation+1 WHERE id=?", [value.state === "complete" ? "completed" : "interrupted",claim.runId]);
    });
  }
}
