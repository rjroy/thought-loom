import type { Database } from "bun:sqlite";
import { dailyReviewDate } from "../domain/daily-review";
import { RunForbiddenError } from "../domain/run";

/** Membership is admission authority, not a model-selectable trigger or a second execution journal. */
export function requireDailyReviewMembership(db: Database, runId: string, subjectId: string, triggerId: string): void {
  const date = dailyReviewDate(triggerId);
  if (date === null || !db.query(`SELECT 1 FROM daily_review_items i JOIN daily_review_batches b ON b.review_date=i.review_date
    WHERE i.run_id=? AND i.thought_id=? AND i.review_date=? AND i.completed_at IS NULL
      AND (SELECT count(*) FROM daily_review_items WHERE review_date=b.review_date)=b.admitted_count`).get(runId,subjectId,date)) {
    throw new RunForbiddenError("Daily review membership is unavailable");
  }
}
