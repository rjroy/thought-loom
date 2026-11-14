import { dailyReviewInstant, type DailyReviewAdmission } from "../domain/daily-review";
import { createLogger, type Logger } from "../logging";

const retryMilliseconds = 60_000;

export interface DailyReviewDriverDependencies {
  readonly now: () => string;
  readonly admit: (now: string) => DailyReviewAdmission | Promise<DailyReviewAdmission>;
  readonly startTimer: (poll: () => void) => () => void;
  readonly notifyWork: () => void;
  readonly logger?: Logger;
}

/** One coalesced admission lane on the shared technical timer, never an execution queue. */
export class DailyReviewDriver {
  private readonly logger: Logger;
  private active: Promise<void> | undefined;
  private cancel: (() => void) | undefined;
  private stopped = false;
  private started = false;
  private sealedDate: string | undefined;
  private latestDate: string | undefined;
  private retryDate: string | undefined;
  private retryAt = 0;
  private stopping: Promise<void> | undefined;
  constructor(private readonly dependencies: DailyReviewDriverDependencies) { this.logger = dependencies.logger ?? createLogger(); }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.cancel = this.dependencies.startTimer(() => { void this.wake(); });
    void this.wake();
  }
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    const flight = Promise.resolve().then(async () => {
      if (this.stopped) return;
      let instant: string;
      try { instant = dailyReviewInstant(this.dependencies.now()); }
      catch { this.logger.warning("[daily review driver] clock unavailable"); return; }
      const date = instant.slice(0,10), milliseconds = Date.parse(instant);
      if (this.latestDate !== undefined && date < this.latestDate) return;
      this.latestDate = date;
      if (this.sealedDate !== undefined && date <= this.sealedDate) return;
      if (this.retryDate === date && milliseconds < this.retryAt) return;
      this.logger.verbose("[daily review driver] admission attempt",{date});
      try {
        const result = await this.dependencies.admit(instant);
        if (this.stopped) return;
        if (result.kind === "admitted" || result.kind === "already-admitted") {
          this.sealedDate = date;
          this.retryDate = undefined;
          this.logger.verbose("[daily review driver] admission outcome",{date,kind:result.kind});
          if (result.kind === "admitted") this.dependencies.notifyWork();
        } else {
          this.retryDate = date; this.retryAt = milliseconds + retryMilliseconds;
          this.logger.verbose("[daily review driver] admission outcome",{date,kind:result.kind});
        }
      } catch {
        if (this.stopped) return;
        this.retryDate = date; this.retryAt = milliseconds + retryMilliseconds;
        this.logger.warning("[daily review driver] admission deferred",{date});
      }
    }).finally(() => { if (this.active === flight) this.active = undefined; });
    this.active = flight;
    void flight.catch(() => {});
    return flight;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    const cancel = this.cancel; this.cancel = undefined;
    try { cancel?.(); } catch { this.logger.warning("[daily review driver] timer cancellation failed"); }
    this.stopping = Promise.resolve(this.active).then(() => {});
    return this.stopping;
  }
}
