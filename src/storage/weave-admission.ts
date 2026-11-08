import { createLogger } from "../logging";
import type { Database } from "bun:sqlite";
import { RunConflictError, RunNotFoundError, type RunRecord, type RunSources } from "../domain/run";
import type { WeaveIntent } from "../domain/run-operations";
import type { MaterialKind } from "../domain/thought";
import type { MediaRetryEligibility } from "../domain/media-import";
import { resolveWeavePurpose } from "../domain/weave-scheduling";
import { nonEmpty, record } from "../domain/validation";
import { insertRun, readRun } from "./run-record";
import { subjectWeaveWork, weaveWorkBlockReason } from "./weave-work";

export type WeaveSources = RunSources;

/** All interpretation histories gate retry; only the latest interpretation run drives source inspection. */
export function sourceWeaveEligibility(db: Database, subjectId: string): {
  readonly runId: string | null; readonly retry: MediaRetryEligibility;
} {
  const subject = db.query<{kind:MaterialKind},[string]>("SELECT kind FROM thoughts WHERE id=?").get(subjectId);
  if (!subject) throw new RunNotFoundError();
  const work = subjectWeaveWork(db,subjectId,subject.kind), previous = work.at(-1);
  const runId = previous?.id ?? null;
  if (db.query("SELECT 1 FROM thoughts WHERE parent_id=? AND kind='ai-interpretation'").get(subjectId)) {
    return {runId,retry:{eligible:false,reason:"interpretation-exists"}};
  }
  for (const item of work) {
    const reason = weaveWorkBlockReason(db,item);
    if (reason !== null) return {runId,retry:{eligible:false,reason:reason === "work-active" ? "work-active" : "work-unsettled"}};
  }
  return previous?.status === "completed" ? {runId,retry:{eligible:false,reason:"work-completed"}} : {runId,retry:{eligible:true,reason:null}};
}

/** The same admission for manual and scheduled work; nested calls join the originating command's transaction. */
export function admitWeave(db: Database, sources: WeaveSources, input: WeaveIntent): RunRecord {
  const logger = sources.logger ?? createLogger();
  const data = record(input);
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data,"subjectId") || !Object.hasOwn(data,"triggerId")) throw new RunConflictError("Invalid weave intent");
  const intent = {subjectId:nonEmpty(data.subjectId,"subjectId"),triggerId:nonEmpty(data.triggerId,"triggerId")};
  logger.verbose("[run storage] admit weave attempt",{subjectId:intent.subjectId});
  try {
    const result = db.transaction(() => {
      // Resolve purpose before the idempotent existing-run path too. No thought content or corpus snapshot is needed.
      const subject = db.query<{ kind: MaterialKind }, [string]>(`SELECT t.kind FROM thoughts t WHERE t.id=? AND NOT EXISTS
        (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id)`).get(intent.subjectId);
      if (!subject) throw new RunNotFoundError();
      const purpose = resolveWeavePurpose(subject.kind,intent.triggerId);
      const existing = db.query(`SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=? AND weave_trigger_id=? ORDER BY rowid LIMIT 1`)
        .get(intent.subjectId,intent.triggerId) as {id:string} | null;
      if (existing) {
        const run = readRun(db,existing.id);
        if (!run) throw new RunConflictError("Existing weave has no current step");
        return {run,reused:true};
      }
      if (subject.kind === "media-original" && purpose === "ordinary") {
        const {retry} = sourceWeaveEligibility(db,intent.subjectId);
        if (!retry.eligible) {
          throw new RunConflictError(retry.reason === "interpretation-exists" ?
            "Source already has an initial interpretation; use Evolve" : "Previous source processing is still active or unresolved");
        }
      }
      const run: RunRecord = {id:nonEmpty(sources.id(),"runId"),kind:"weave",status:"queued",sessionId:nonEmpty(sources.sessionId?.() ?? sources.id(),"sessionId"),
        promptId:nonEmpty(sources.promptId?.() ?? sources.id(),"promptId"),createdAt:nonEmpty(sources.now(),"createdAt"),generation:0,inputThoughtId:null,nativeState:"unknown"};
      insertRun(db,run,intent);
      return {run,reused:false};
    }).immediate();
    logger.verbose("[run storage] weave admission applied in transaction",{runId:result.run.id,subjectId:intent.subjectId,reused:result.reused});
    return Object.freeze(result.run);
  } catch (error) {
    logger.verbose("[run storage] weave admission failed",{subjectId:intent.subjectId});
    throw error;
  }
}
