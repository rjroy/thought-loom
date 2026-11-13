import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { SqliteDailyReviews } from "../../src/storage/daily-review";
import { SqliteRunRepository } from "../../src/storage/run";
import { SqliteRunWorkerState } from "../../src/storage/run-worker";

export const sealedReviewNow = "2031-01-01T12:00:00.000Z";

/** Admit real review work before runtime startup, then settle its never-submitted owners. */
export function sealDailyReview(db: Database, now = sealedReviewNow): void {
  let sequence = 0;
  const sources = { id: () => `owned-seal-${++sequence}`, now: () => now };
  const batch = new SqliteDailyReviews(db, sources).admitDueBatch(now, true);
  expect(batch.kind).toBe("admitted");
  if (batch.kind !== "admitted") throw new Error(`Review seal was ${batch.kind}`);
  expect(batch.date).toBe(now.slice(0, 10));
  expect(batch.runIds.length).toBeGreaterThan(0);
  const runs = new SqliteRunRepository(db, sources), state = new SqliteRunWorkerState(db, sources);
  for (const runId of batch.runIds) {
    runs.stop(runId);
    expect(state.settleUnsubmitted(runId)).toBe(true);
  }
}
