import type { Database } from "bun:sqlite";
import { dailyReviewCeiling, dailyReviewInstant, dailyReviewPolicy, dailyReviewPolicyJson, dailyReviewTrigger,
  defaultDailyReviewPolicy, selectDailyReviewSubjects, type DailyReviewAdmission, type DailyReviewCandidate,
  type DailyReviewCommands, type DailyReviewPolicy } from "../domain/daily-review";
import { RunConflictError, type RunRecord, type RunSources } from "../domain/run";
import { nonEmpty } from "../domain/validation";
import { createLogger, type Logger } from "../logging";
import { insertRun } from "./run-record";
import { immediate } from "./transaction";
import { dailyReviewSubjectBlocked } from "./weave-work";

const utf8 = new TextEncoder();

/** One short admission transaction. There is deliberately no timer, transport or independent job status here. */
export class SqliteDailyReviews implements DailyReviewCommands {
  private readonly logger: Logger;
  private readonly policy: DailyReviewPolicy;
  constructor(private readonly db: Database, private readonly sources: RunSources, policy: DailyReviewPolicy = defaultDailyReviewPolicy) {
    this.logger = sources.logger ?? createLogger(); this.policy = dailyReviewPolicy(policy);
  }
  lastReviewedAt(thoughtId: string): string | null {
    nonEmpty(thoughtId,"thoughtId");
    this.logger.verbose("[daily review] success metadata read attempt");
    try {
      const at = this.db.query<{at:string|null},[Uint8Array]>("SELECT max(completed_at) AS at FROM daily_review_items WHERE thought_id=CAST(? AS TEXT)").get(utf8.encode(thoughtId))?.at ?? null;
      this.logger.verbose("[daily review] success metadata read succeeded"); return at;
    } catch (error) { this.logger.verbose("[daily review] success metadata read failed"); throw error; }
  }
  admitDueBatch(now: string, agentsConfigured: boolean): DailyReviewAdmission {
    const instant = dailyReviewInstant(now), date = instant.slice(0,10);
    if (agentsConfigured !== true) return {kind:"unconfigured",date};
    this.logger.verbose("[daily review] admission attempt",{date});
    try {
      const result = immediate(this.db,(): DailyReviewAdmission => {
        const latest = this.db.query<{date:string},[]>("SELECT review_date AS date FROM daily_review_batches ORDER BY review_date DESC LIMIT 1").get();
        if (latest && latest.date >= date) return {kind:"already-admitted",date};
        // This is exactly AI-normal text membership, without reading unrelated thought or response content.
        const candidates = this.db.query<DailyReviewCandidate,[]>(`SELECT t.id,t.created_at AS createdAt,
          (SELECT max(i.completed_at) FROM daily_review_items i WHERE i.thought_id=t.id) AS lastReviewedAt,
          (SELECT max(b.admitted_at) FROM daily_review_items i JOIN daily_review_batches b ON b.review_date=i.review_date WHERE i.thought_id=t.id) AS lastAttemptedAt
          FROM thoughts t WHERE t.kind!='media-original' AND NOT EXISTS(SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id)`).all();
        const ceiling = dailyReviewCeiling(candidates.length,this.policy);
        if (ceiling === 0) return {kind:"empty",date};
        const selected: string[] = [];
        for (const id of selectDailyReviewSubjects(candidates,candidates.length)) {
          if (!dailyReviewSubjectBlocked(this.db,id)) selected.push(id);
          if (selected.length === ceiling) break;
        }
        if (!selected.length) return {kind:"deferred",date};
        this.db.run(`INSERT INTO daily_review_batches(review_date,admitted_at,eligible_count,ceiling,admitted_count,policy_json) VALUES (?,?,?,?,?,?)`,
          [date,instant,candidates.length,ceiling,selected.length,dailyReviewPolicyJson(this.policy)]);
        const runIds: string[] = [];
        for (const [position,subjectId] of selected.entries()) {
          const run: RunRecord = {id:nonEmpty(this.sources.id(),"runId"),kind:"weave",status:"queued",
            sessionId:nonEmpty(this.sources.sessionId?.() ?? this.sources.id(),"sessionId"),
            promptId:nonEmpty(this.sources.promptId?.() ?? this.sources.id(),"promptId"),createdAt:instant,generation:0,inputThoughtId:null,nativeState:"unknown"};
          // Deferred run FK allows membership to authorize the guarded run INSERT in this same transaction.
          this.db.run("INSERT INTO daily_review_items(run_id,review_date,thought_id,position) VALUES (?,?,CAST(? AS TEXT),?)",[run.id,date,utf8.encode(subjectId),position]);
          insertRun(this.db,run,{subjectId,triggerId:dailyReviewTrigger(date)});
          runIds.push(run.id);
        }
        return {kind:"admitted",date,runIds:Object.freeze(runIds)};
      });
      if (result.kind === "admitted") this.logger.info("[daily review] batch admitted",{date,count:result.runIds.length});
      else this.logger.verbose("[daily review] admission deferred",{date,reason:result.kind});
      return result;
    } catch {
      this.logger.error("[daily review] admission failed",{date});
      throw new RunConflictError("Daily review admission failed");
    }
  }
}
