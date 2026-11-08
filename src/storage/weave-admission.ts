import { createLogger } from "../logging";
import type { Database } from "bun:sqlite";
import { RunConflictError, RunNotFoundError, type RunRecord, type RunSources } from "../domain/run";
import type { WeaveIntent } from "../domain/run-operations";
import type { MaterialKind } from "../domain/thought";
import type { MediaRetryEligibility } from "../domain/media-import";
import type { RunStatus } from "../domain/run";
import { resolveWeavePurpose } from "../domain/weave-scheduling";
import { nonEmpty, record } from "../domain/validation";
import { insertRun, readRun } from "./run-record";

export type WeaveSources = RunSources;

/** Shared source gate: caller checks source visibility; the latest ordinary weave also drives inspection. */
export function sourceWeaveEligibility(db: Database, subjectId: string): {
  readonly runId: string | null; readonly retry: MediaRetryEligibility;
} {
  const previous = db.query<{id:string;status:RunStatus;cancellation:string},[string]>(`SELECT id,status,cancellation_state AS cancellation
    FROM runs WHERE kind='weave' AND weave_subject_id=? AND weave_trigger_id NOT LIKE 'title-clear:%' ORDER BY rowid DESC LIMIT 1`).get(subjectId);
  const runId = previous?.id ?? null;
  if (db.query("SELECT 1 FROM thoughts WHERE parent_id=? AND kind='ai-interpretation'").get(subjectId)) {
    return {runId,retry:{eligible:false,reason:"interpretation-exists"}};
  }
  if (!previous || ((previous.status === "failed" || previous.status === "interrupted") && previous.cancellation === "settled")) {
    return {runId,retry:{eligible:true,reason:null}};
  }
  const reason = previous.status === "completed" ? "work-completed" :
    previous.status === "queued" || previous.status === "submitting" || previous.status === "running" ? "work-active" : "work-unsettled";
  return {runId,retry:{eligible:false,reason}};
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
