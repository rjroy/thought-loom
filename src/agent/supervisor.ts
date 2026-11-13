import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { assertRestoreFenceSchema } from "../storage/restore-fences-schema";
import { recordedSubjectCancellationSafeSql } from "../storage/run-cancellation";

const concurrency=8;

export interface SupervisedWorker {
  tick(runId: string): Promise<void>;
  pause(): void;
  onSearchCleanupAvailable?(notify: () => void): () => void;
}
type Source = "runs" | "cleanup";
interface Cursor { after: number; through: number | null }
export interface SupervisorDependencies {
  readonly db: Database;
  readonly logger?: Logger;
  /** One owned worker per supervisor, not one per poll. */
  readonly worker: SupervisedWorker;
  /** Starts a technical polling timer and returns its cancellation function. */
  readonly startTimer: (poll: () => void) => () => void;
}

/** Scans the existing run aggregate; the worker owns claims and native work. */
export class RunSupervisor {
  private readonly logger: Logger;
  private readonly flights = new Map<string, Promise<void>>();
  private cancelTimer: (() => void) | undefined;
  private stopping: Promise<void> | undefined;
  private stopped = false;
  private readonly runCursor: Cursor = {after:0,through:null};
  private readonly cleanupCursor: Cursor = {after:0,through:null};
  private nextSource: Source = "runs";
  private unsubscribeCleanup: (() => void) | undefined;
  private wake: Promise<void> | undefined;
  constructor(private readonly dependencies: SupervisorDependencies) { this.logger = dependencies.logger ?? createLogger(); }

  start(): void {
    if (this.stopped || this.cancelTimer) return;
    this.unsubscribeCleanup ??= this.dependencies.worker.onSearchCleanupAvailable?.(() => this.notifyWork());
    this.cancelTimer = this.dependencies.startTimer(() => {
      void this.poll().catch(() => this.logger.error("[supervisor] scheduled poll failed"));
    });
  }

  notifyWork(): void {
    if (this.stopped || this.wake) return;
    // One coalesced wake, not one SDK job per deleted run. Do not reset an in-progress high-water walk.
    this.wake = Promise.resolve().then(() => this.poll()).catch(() => {
      this.logger.warning("[supervisor] work notification deferred");
    }).finally(() => { this.wake = undefined; });
  }
  private candidates(source: Source, limit: number): readonly {id:string;position:number}[] {
    if (limit <= 0) return [];
    assertRestoreFenceSchema(this.dependencies.db);
    const cursor = source === "runs" ? this.runCursor : this.cleanupCursor;
    const table = source === "runs" ? "runs" : "search_native_cleanup";
    cursor.through ??= (this.dependencies.db.query(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${table}`).get() as {n:number}).n;
    const sql = source === "runs" ? `SELECT r.id,r.rowid AS position FROM runs r WHERE r.kind IN ('weave','evolve','export','search') AND
      (r.status IN ('queued','submitting','running','uncertain') OR (r.status IN ('completed','interrupted','failed') AND r.cancellation_state='pending')
         OR (r.kind IN ('weave','evolve') AND r.status IN ('interrupted','failed') AND r.cancellation_state='settled' AND NOT ${recordedSubjectCancellationSafeSql}))
      AND NOT EXISTS(SELECT 1 FROM main.restore_fences rf WHERE rf.entity_kind='run' AND rf.entity_id=r.id)
      AND r.rowid>? AND r.rowid<=? ORDER BY r.rowid LIMIT ?` :
      `SELECT c.run_id AS id,c.rowid AS position FROM search_native_cleanup c JOIN search_sessions s ON s.id=c.session_id
      WHERE c.state='pending' AND s.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=c.run_id)
      AND NOT EXISTS(SELECT 1 FROM main.restore_fences rf WHERE rf.entity_kind='run' AND rf.entity_id=c.run_id)
      AND c.rowid>? AND c.rowid<=? ORDER BY c.rowid LIMIT ?`;
    const rows = this.dependencies.db.query(sql).all(cursor.after,cursor.through,limit) as {id:string;position:number}[];
    const last = rows.at(-1);
    if (last) cursor.after = last.position;
    if (rows.length < limit || cursor.after >= cursor.through) { cursor.after = 0; cursor.through = null; }
    return rows;
  }

  async poll(): Promise<void> {
    if (this.stopped) return;
    this.logger.verbose("[supervisor] poll attempt");
    try {
      // A finite membership pass and fixed technical capacity prevent a growing import's weave outbox from
      // creating an all-runs fan-out. Overlapping polls can fill free slots while an earlier native call waits.
      const available=concurrency-this.flights.size;
      if (available<=0) return;
      const first = this.nextSource, second = first === "runs" ? "cleanup" : "runs";
      this.nextSource = second;
      const rows = [...this.candidates(first,available)];
      if (rows.length < available) rows.push(...this.candidates(second,available-rows.length));
      const flights = rows.map(({ id }) => {
        const existing = this.flights.get(id);
        if (existing) return existing;
        const flight = Promise.resolve().then(() => this.dependencies.worker.tick(id)).finally(() => this.flights.delete(id));
        this.flights.set(id, flight);
        return flight;
      });
      const results = await Promise.allSettled(flights);
      if (results.some(result => result.status === "rejected")) throw new Error("Supervisor poll failed");
      this.logger.verbose("[supervisor] poll succeeded");
    } catch {
      this.logger.error("[supervisor] poll failed");
      throw new Error("Supervisor poll failed");
    }
  }

  /** Pause and cancel scheduling before draining owned work; never issue a user Stop. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = (async () => {
      this.logger.verbose("[supervisor] stop attempt");
      let failed = false;
      try { this.cancelTimer?.(); } catch { failed = true; }
      try { this.unsubscribeCleanup?.(); } catch { failed = true; }
      try { this.dependencies.worker.pause(); } catch { failed = true; }
      const results = await Promise.allSettled([...this.flights.values(),...(this.wake ? [this.wake] : [])]);
      if (results.some(result => result.status === "rejected")) failed = true;
      if (failed) { this.logger.error("[supervisor] stop failed"); throw new Error("Supervisor shutdown failed"); }
      this.logger.verbose("[supervisor] stop succeeded");
    })();
    return this.stopping;
  }
}
