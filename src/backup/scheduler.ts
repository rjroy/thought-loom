import type { Logger } from "../logging";
import { createLogger } from "../logging";

export interface BackupTimer {
  now(): bigint;
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface BackupSchedulerOptions {
  readonly intervalSeconds: number | null;
  readonly timer: BackupTimer;
  readonly logger?: Logger;
  readonly attempt: (signal: AbortSignal) => Promise<void>;
}

const maximumDelay = 2147483647n;
/** Monotonic technical time, independent of wall-clock corrections and application timestamps. */
export const systemBackupTimer: BackupTimer = Object.freeze({
  now: () => process.hrtime.bigint() / 1000000n,
  schedule(delayMs: number, callback: () => void): () => void {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
});

export class BackupScheduler {
  private readonly interval: bigint | null;
  private readonly timer: BackupTimer;
  private readonly logger: Logger;
  private readonly attempt: BackupSchedulerOptions["attempt"];
  private started = false;
  private stopped = false;
  private pending = false;
  private due = 0n;
  private generation = 0;
  private cancelTimer: (() => void) | undefined;
  private controller: AbortController | undefined;
  private active: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(options: BackupSchedulerOptions) {
    if (options.intervalSeconds !== null && (!Number.isSafeInteger(options.intervalSeconds) || options.intervalSeconds < 1)) {
      throw new Error("Invalid backup schedule interval");
    }
    this.interval = options.intervalSeconds === null ? null : BigInt(options.intervalSeconds) * 1000n;
    this.timer = options.timer; this.logger = options.logger ?? createLogger(); this.attempt = options.attempt;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.interval === null) return;
    const now = this.readNow();
    if (now === undefined) { this.wake(); return; }
    this.due = now + this.interval;
    this.log("info", "[backup scheduler] started");
    this.arm(); this.wake();
  }

  /** Seal and abort synchronously, then join entered work; a stale cancelled callback cannot resurrect it. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true; this.pending = false; this.generation++;
    this.stopping = Promise.resolve(this.active).then(() => { this.log("verbose", "[backup scheduler] stopped"); });
    const cancel = this.cancelTimer; this.cancelTimer = undefined;
    try { cancel?.(); } catch { this.log("warning", "[backup scheduler] timer cancellation failed"); }
    this.controller?.abort();
    return this.stopping;
  }

  private arm(): void {
    if (this.stopped || this.interval === null) return;
    const now = this.readNow(); if (now === undefined) return;
    const remaining = this.due - now;
    const delay = remaining < 1n ? 1 : Number(remaining > maximumDelay ? maximumDelay : remaining);
    const generation = ++this.generation;
    try {
      this.cancelTimer = this.timer.schedule(delay, () => {
        if (this.stopped || generation !== this.generation) return;
        this.cancelTimer = undefined;
        const now = this.readNow(); if (now === undefined) return;
        if (this.interval !== null && now >= this.due) {
          // Skip every missed deadline arithmetically, while retaining at most one pending wake.
          this.due += ((now - this.due) / this.interval + 1n) * this.interval;
          this.wake();
        }
        this.arm();
      });
    } catch {
      this.log("warning", "[backup scheduler] timer unavailable");
      // No busy retry loop on a failed technical timer. The entered attempt still owns its normal drain.
    }
  }

  private wake(): void {
    if (this.stopped) return;
    if (this.active) { this.pending = true; return; }
    const controller = new AbortController(); this.controller = controller;
    this.active = Promise.resolve().then(async () => {
      if (this.stopped) return;
      this.log("info", "[backup scheduler] attempt started");
      if (this.stopped) return;
      try { await this.attempt(controller.signal); this.log("verbose", "[backup scheduler] attempt settled"); }
      catch {
        if (controller.signal.aborted) this.log("verbose", "[backup scheduler] attempt cancelled");
        else this.log("warning", "[backup scheduler] attempt failed; later scheduled wakes remain enabled");
      }
    }).finally(() => {
      this.active = undefined; this.controller = undefined;
      if (!this.stopped && this.pending) { this.pending = false; this.wake(); }
    });
    // Resource/attempt failures are handled above; a throwing diagnostic sink must not become an unhandled rejection.
    void this.active.catch(() => {});
  }

  private log(level: "info" | "verbose" | "warning", message: string): void {
    try { this.logger[level](message); } catch { /* Diagnostics cannot skip abort/join or reopen a sealed producer. */ }
  }

  private readNow(): bigint | undefined {
    try {
      const now = this.timer.now(); if (typeof now === "bigint") return now;
    } catch { /* A failed technical clock must not escape an automatic timer callback into the daemon. */ }
    this.log("warning", "[backup scheduler] monotonic clock unavailable"); return undefined;
  }
}
