import type { Database } from "bun:sqlite";
import { dailyReviewInstant, scheduledTitlePrefix, type DailyReviewAdmission } from "../domain/daily-review";
import { RunConflictError, type RunRecord, type RunSources } from "../domain/run";
import { nonEmpty } from "../domain/validation";
import { createLogger } from "../logging";
import { insertRun } from "./run-record";
import { immediate } from "./transaction";
import { dailyReviewSubjectBlocked } from "./weave-work";

/** The immutable run identities are the daily admission ledger, not a second execution queue. */
export class SqliteScheduledTitles {
  constructor(private readonly db: Database, private readonly sources: RunSources) {}
  admitDueBatch(now: string, configured: boolean): DailyReviewAdmission {
    const instant = dailyReviewInstant(now), date = instant.slice(0,10), triggerId = `${scheduledTitlePrefix}${date}`;
    if (!configured) return {kind:"unconfigured",date};
    const logger = this.sources.logger ?? createLogger();
    logger.verbose("[title scheduling] admission attempt",{date});
    try {
      const result = immediate(this.db,(): DailyReviewAdmission => {
        const latest = this.db.query<{trigger:string},[]>("SELECT weave_trigger_id AS trigger FROM runs WHERE kind='weave' AND weave_schedule_kind='title-only' ORDER BY weave_trigger_id DESC LIMIT 1").get();
        if (latest && latest.trigger >= triggerId) return {kind:"already-admitted",date};
        const candidates = this.db.query<{id:string},[]>(`SELECT t.id FROM thoughts t JOIN thought_titles title ON title.thought_id=t.id
          WHERE title.title IS NULL AND NOT EXISTS(SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id)
          ORDER BY (SELECT max(r.weave_trigger_id) FROM runs r WHERE r.kind='weave' AND r.weave_subject_id=t.id
            AND r.weave_schedule_kind='title-only'),t.created_at COLLATE BINARY,t.id COLLATE BINARY`).all();
        if (!candidates.length) return {kind:"empty",date};
        const selected = candidates.filter(candidate => !dailyReviewSubjectBlocked(this.db,candidate.id)).slice(0,20);
        if (!selected.length) return {kind:"deferred",date};
        const runIds: string[] = [];
        for (const subject of selected) {
          const run: RunRecord = {id:nonEmpty(this.sources.id(),"runId"),kind:"weave",status:"queued",
            sessionId:nonEmpty(this.sources.sessionId?.() ?? this.sources.id(),"sessionId"),
            promptId:nonEmpty(this.sources.promptId?.() ?? this.sources.id(),"promptId"),createdAt:instant,generation:0,inputThoughtId:null,nativeState:"unknown"};
          insertRun(this.db,run,{subjectId:subject.id,triggerId},"title-only"); runIds.push(run.id);
        }
        return {kind:"admitted",date,runIds:Object.freeze(runIds)};
      });
      if (result.kind === "admitted") logger.info("[title scheduling] batch admitted",{date,count:result.runIds.length});
      else logger.verbose("[title scheduling] admission outcome",{date,kind:result.kind});
      return result;
    } catch { logger.error("[title scheduling] admission failed",{date}); throw new RunConflictError("Title scheduling admission failed"); }
  }
}
