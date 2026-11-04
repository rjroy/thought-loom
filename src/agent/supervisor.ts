import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";

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
      const rows = this.dependencies.db.query(`SELECT id FROM runs WHERE status IN ('queued','submitting','running','uncertain') OR
         (status IN ('completed','interrupted','failed') AND cancellation_state='pending') ORDER BY rowid`).all() as { id: string }[];
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
      try { this.dependencies.worker.pause(); } catch { failed = true; }
      const results = await Promise.allSettled(this.flights.values());
      if (results.some(result => result.status === "rejected")) failed = true;
      if (failed) { this.logger.error("[supervisor] stop failed"); throw new Error("Supervisor shutdown failed"); }
      this.logger.verbose("[supervisor] stop succeeded");
    })();
    return this.stopping;
  }
}
