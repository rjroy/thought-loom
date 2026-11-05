import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";

const concurrency=8;

export interface SupervisedWorker {
  tick(runId: string): Promise<void>;
  pause(): void;
}
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
  private after = 0;
  private through: number | null = null;
  constructor(private readonly dependencies: SupervisorDependencies) { this.logger = dependencies.logger ?? createLogger(); }

  start(): void {
    if (this.stopped || this.cancelTimer) return;
    this.cancelTimer = this.dependencies.startTimer(() => {
      void this.poll().catch(() => this.logger.error("[supervisor] scheduled poll failed"));
    });
  }

  async poll(): Promise<void> {
    if (this.stopped) return;
    this.logger.verbose("[supervisor] poll attempt");
    try {
      // A finite membership pass and fixed technical capacity prevent a growing import's weave outbox from
      // creating an all-runs fan-out. Overlapping polls can fill free slots while an earlier native call waits.
      const available=concurrency-this.flights.size;
      if (available<=0) return;
      this.through ??= (this.dependencies.db.query("SELECT COALESCE(MAX(rowid),0) AS n FROM runs").get() as {n:number}).n;
      const rows = this.dependencies.db.query(`SELECT id,rowid AS position FROM runs WHERE kind IN ('weave','evolve','export') AND (status IN ('queued','submitting','running','uncertain') OR
         (status IN ('completed','interrupted','failed') AND cancellation_state='pending')) AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`).all(this.after,this.through,available) as { id: string; position: number }[];
      const flights = rows.map(({ id,position }) => {
        this.after=position;
        const existing = this.flights.get(id);
        if (existing) return existing;
        const flight = Promise.resolve().then(() => this.dependencies.worker.tick(id)).finally(() => this.flights.delete(id));
        this.flights.set(id, flight);
        return flight;
      });
      if (rows.length<available || this.after>=this.through) { this.after=0; this.through=null; }
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
      try { this.dependencies.worker.pause(); } catch { failed = true; }
      const results = await Promise.allSettled(this.flights.values());
      if (results.some(result => result.status === "rejected")) failed = true;
      if (failed) { this.logger.error("[supervisor] stop failed"); throw new Error("Supervisor shutdown failed"); }
      this.logger.verbose("[supervisor] stop succeeded");
    })();
    return this.stopping;
  }
}
