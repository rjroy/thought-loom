import type { Database } from "bun:sqlite";
import { SearchConflictError, SearchStorageError, searchRevision } from "../domain/agentic-search";
import { ExecutionOwnerLease } from "./execution-owner";
import { SqliteSearchCleanup } from "./search-cleanup";
import { purgeSearchSessionContent } from "./search-purge";
import type { Logger } from "../logging";

interface OwnedRun {
  readonly id: string; readonly status: string; readonly cancellation: string; readonly generation: number; readonly bound: number;
  readonly kind: string; readonly input: string | null; readonly subject: string | null; readonly trigger: string | null;
}

/** Explicit internal capability, bound to the worker's actual lease and SQL connection, never a request DTO. */
export class SqliteSearchRetention {
  private readonly batches = new WeakMap<readonly string[],string>();
  private readonly cleanup: SqliteSearchCleanup;
  private constructor(private readonly db: Database, private readonly owner: ExecutionOwnerLease,
    private readonly retireAndNotify: (runIds: readonly string[]) => void, logger: Logger) {
    this.cleanup = new SqliteSearchCleanup(db,owner,logger);
  }
  static forWorker(db: Database, owner: ExecutionOwnerLease, retireAndNotify: (runIds: readonly string[]) => void, logger: Logger): SqliteSearchRetention {
    if (!(owner instanceof ExecutionOwnerLease)) throw new SearchStorageError("search-retention-requires-lease");
    owner.assertRegistered(db);
    return new SqliteSearchRetention(db,owner,retireAndNotify,logger);
  }
  assertFor(db: Database): void {
    // One transaction cannot span two SQLite handles, even when their filenames identify the same database.
    if (db !== this.db) throw new SearchStorageError("search-retention-connection-mismatch");
    this.owner.assertRegistered(db);
  }
  purgeInTransaction(sessionId: string, at: string): readonly string[] {
    this.assertFor(this.db);
    if (!this.db.inTransaction) throw new SearchStorageError("search-retention-requires-transaction");
    const session = new TextEncoder().encode(sessionId);
    const runs = this.db.query(`SELECT r.id,r.kind,r.status,r.generation,r.cancellation_state AS cancellation,
      r.input_thought_id AS input,r.weave_subject_id AS subject,r.weave_trigger_id AS trigger,
      EXISTS(SELECT 1 FROM agent_bindings WHERE run_id=r.id) AS bound
      FROM search_turns t JOIN runs r ON r.id=t.run_id WHERE t.session_id=CAST(? AS TEXT) ORDER BY t.position`).all(session) as OwnedRun[];
    for (const run of runs) {
      searchRevision(run.generation + 1);
      if (run.kind !== "search" || run.input !== null || run.subject !== null || run.trigger !== null) throw new SearchStorageError("search-retention-owner-unavailable");
      if (!run.bound && !this.neverAuthorizedUnbound(run)) throw new SearchConflictError("native-cleanup-required");
    }
    for (const run of runs) {
      const active = ["queued","submitting","running","uncertain"].includes(run.status);
      if (active) this.db.run("UPDATE search_turns SET outcome_reason=COALESCE(outcome_reason,'stopped') WHERE run_id=?",[run.id]);
      // Completed/failed/interrupted outcomes stay exactly those outcomes. Delete does not turn completed work into Stop.
      // RETURNING identifies the owned row; the terminal-slot trigger can also change a child row.
      const fenced = this.db.query<{id:string},[number,string,string,string]>(
        "UPDATE runs SET generation=?,status=?,cancellation_state=? WHERE id=? RETURNING id").get(
          run.generation+1,active ? "interrupted" : run.status,run.bound && run.cancellation === "none" ? "pending" : run.cancellation,run.id);
      if (fenced?.id !== run.id) throw new SearchStorageError("search-retention-fence-unavailable");
    }
    this.db.run("UPDATE search_composer_contexts SET state='invalidated' WHERE session_id=CAST(? AS TEXT) AND state='active'",[session]);
    const changed = this.db.run(`UPDATE search_sessions SET title=NULL,deleted_at=?,last_activity_at=?,revision=revision+1
      WHERE id=CAST(? AS TEXT) AND deleted_at IS NULL`,[at,at,session]);
    if (changed.changes !== 1) throw new SearchStorageError("search-purge-owner-unavailable");
    for (const run of runs) if (run.bound) this.cleanup.sealInTransaction(run.id);
    purgeSearchSessionContent(this.db,sessionId);
    this.owner.assertRegistered(this.db);
    const batch = Object.freeze(runs.map(run => run.id));
    this.batches.set(batch,sessionId);
    return batch;
  }
  private neverAuthorizedUnbound(run: OwnedRun): boolean {
    if (["submitting","running","uncertain"].includes(run.status)) return false;
    if (run.cancellation !== "none") {
      // Stop conservatively marks even untouched searches pending. Only its closed,
      // pristine initial journal can prove that this particular pending run was never authorized.
      if (run.cancellation !== "pending" || run.status !== "interrupted" || !this.db.query(`SELECT 1 FROM search_turns
        WHERE run_id=? AND open_slot=0 AND outcome_reason='stopped'`).get(run.id)) return false;
    }
    return this.db.query(`SELECT 1 FROM run_steps WHERE run_id=? AND position=0
      AND prompt_id=(SELECT prompt_id FROM runs WHERE id=?) AND state='prepared' AND native_state='unknown'
      AND submit_owner IS NULL AND envelope_json IS NULL AND result_json IS NULL
      AND (?='none' OR input IS NULL)
      AND NOT EXISTS(SELECT 1 FROM run_steps WHERE run_id=? AND position!=0)
      AND NOT EXISTS(SELECT 1 FROM search_native_cleanup WHERE run_id=?)`).get(run.id,run.id,run.cancellation,run.id,run.id) !== null;
  }
  /** Synchronous metadata retirement only. SQL commit, not savepoint release, must have succeeded first. */
  afterCommit(runIds: readonly string[]): void {
    const sessionId = this.batches.get(runIds);
    if (sessionId === undefined || this.db.inTransaction || !this.db.query("SELECT 1 FROM search_sessions WHERE id=CAST(? AS TEXT) AND deleted_at IS NOT NULL")
      .get(new TextEncoder().encode(sessionId)) || this.db.query("SELECT 1 FROM search_turns WHERE session_id=CAST(? AS TEXT) LIMIT 1")
      .get(new TextEncoder().encode(sessionId))) throw new SearchStorageError("search-retention-commit-unavailable");
    this.batches.delete(runIds);
    this.retireAndNotify(runIds);
  }
}
