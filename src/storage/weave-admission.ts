import { createLogger } from "../logging";
import type { Database } from "bun:sqlite";
import { RunConflictError, RunNotFoundError, type RunRecord, type RunSources } from "../domain/run";
import type { WeaveIntent } from "../domain/run-operations";
import { nonEmpty, record } from "../domain/validation";
import { insertRun, readRun } from "./run-record";

export type WeaveSources = RunSources;

/** The same admission for manual and scheduled work; nested calls join the originating command's transaction. */
export function admitWeave(db: Database, sources: WeaveSources, input: WeaveIntent): RunRecord {
  const logger = sources.logger ?? createLogger();
  const data = record(input);
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data,"subjectId") || !Object.hasOwn(data,"triggerId")) throw new RunConflictError("Invalid weave intent");
  const intent = {subjectId:nonEmpty(data.subjectId,"subjectId"),triggerId:nonEmpty(data.triggerId,"triggerId")};
  logger.verbose("[run storage] admit weave attempt",{subjectId:intent.subjectId});
  try {
    const result = db.transaction(() => {
      // AI thought eligibility needs only existence/rejection, not thought text or a corpus snapshot.
      if (!db.query(`SELECT 1 FROM thoughts t WHERE t.id=? AND NOT EXISTS
        (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id)`).get(intent.subjectId)) throw new RunNotFoundError();
      const existing = db.query(`SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=? AND weave_trigger_id=? ORDER BY rowid LIMIT 1`)
        .get(intent.subjectId,intent.triggerId) as {id:string} | null;
      if (existing) {
        const run = readRun(db,existing.id);
        if (!run) throw new RunConflictError("Existing weave has no current step");
        return {run,reused:true};
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
