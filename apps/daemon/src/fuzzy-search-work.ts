import { setImmediate } from "node:timers/promises";

export type FuzzyFailure = "invalid" | "busy" | "cancelled" | "deadline" | "memory" | "projection" | "unavailable";
export class FuzzySearchError extends Error {
  constructor(readonly code: FuzzyFailure, message: string) { super(message); this.name = "FuzzySearchError"; }
}

export type FuzzyReadPolicy = Readonly<{ deadlineMs: number; workingSetBytes: number }>;
export const DEFAULT_FUZZY_READ_POLICY: FuzzyReadPolicy = Object.freeze({ deadlineMs: 5_000, workingSetBytes: 64 * 1024 * 1024 });
export const FUZZY_STEP_UPDATES = 4_096;

// Counts traversal-owned buffers, not SQLite's cache or the runtime's baseline.
// A chunk allowance covers original/normalized strings, segmenter lookahead and
// overlapping old/new chunks. This is deliberately not a process-RSS guarantee.
export class FuzzySearchWork {
  readonly startedAt: number;
  targets = 0;
  chunks = 0;
  updates = 0;
  private sinceYield = 0;
  private retainedBytes = 0;

  constructor(
    private readonly policy: FuzzyReadPolicy,
    private readonly signal: AbortSignal | undefined,
    private readonly now: () => number = () => performance.now(),
    private readonly schedule: () => Promise<void> = async () => { await setImmediate(); },
  ) { this.startedAt = now(); }

  get remainingUpdates(): number { return FUZZY_STEP_UPDATES - this.sinceYield; }
  get elapsedMs(): number { return this.now() - this.startedAt; }

  check(): void {
    if (this.signal?.aborted) throw new FuzzySearchError("cancelled", "Search cancelled");
    if (this.elapsedMs >= this.policy.deadlineMs) throw new FuzzySearchError("deadline", "Search deadline exceeded");
  }

  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.retainedBytes + bytes > this.policy.workingSetBytes) {
      throw new FuzzySearchError("memory", "Search working-set budget exceeded");
    }
    this.retainedBytes += bytes;
  }

  release(bytes: number): void { this.retainedBytes -= bytes; }

  checkChunk(utf16Length: number): void {
    this.check();
    const bytes = utf16Length * 16;
    if (!Number.isSafeInteger(bytes) || bytes + this.retainedBytes > this.policy.workingSetBytes) {
      throw new FuzzySearchError("memory", "Search chunk exceeds working-set budget");
    }
  }

  // Callers perform at most remainingUpdates before recording/scheduling.
  record(updates: number): boolean {
    this.updates += updates;
    this.sinceYield += updates;
    this.check();
    return this.sinceYield >= FUZZY_STEP_UPDATES;
  }

  async yield(): Promise<void> {
    this.check();
    await this.schedule();
    this.sinceYield = 0;
    this.check();
  }
}
