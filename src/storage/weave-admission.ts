import { createLogger } from "../logging";
import type { Database } from "bun:sqlite";
import { RunConflictError, RunFenceError, RunNotFoundError, type RunRecord, type RunSources } from "../domain/run";
import type { WeaveIntent } from "../domain/run-operations";
import type { MaterialKind, Thought } from "../domain/thought";
import type { MediaRetryEligibility } from "../domain/media-import";
import { connectionDiscoveryOrigin, connectionDiscoveryPrefix, directConnectionDiscoveryIntent, directConnectionDiscoveryPrefix, directConnectionDiscoverySubject, resolveWeavePurpose } from "../domain/weave-scheduling";
import { nonEmpty, record } from "../domain/validation";
import { insertRun, readRun } from "./run-record";
import { subjectWeaveWork, weaveWorkBlockReason } from "./weave-work";
import { assertRunNotRestoreFenced, isRunRestoreFenced } from "./restore-fences";

export type WeaveSources = RunSources;

export function hasConnectionDiscovery(db: Database, subjectId: string): boolean {
  return db.query(`SELECT 1 FROM runs WHERE kind='weave' AND weave_subject_id=?
    AND (substr(weave_trigger_id,1,?)=? OR substr(weave_trigger_id,1,?)=?) LIMIT 1`)
    .get(subjectId,connectionDiscoveryPrefix.length,connectionDiscoveryPrefix,directConnectionDiscoveryPrefix.length,directConnectionDiscoveryPrefix) !== null;
}

/** Only the writer calls this while atomically inserting a new direct thought. General admission cannot backfill it. */
export function admitDirectConnectionDiscovery(db: Database, sources: WeaveSources, thought: Thought): RunRecord {
  const intent = directConnectionDiscoveryIntent(thought);
  if (!db.inTransaction || !intent) throw new RunConflictError("Direct discovery requires its thought creation transaction");
  return admit(db,sources,intent,thought.id);
}

/** Unfenced interpretation work gates retry; the latest historical run still drives source inspection. */
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
  const live = work.filter(item => !isRunRestoreFenced(db,item.id));
  for (const item of live) {
    const reason = weaveWorkBlockReason(db,item);
    if (reason !== null) return {runId,retry:{eligible:false,reason:reason === "work-active" ? "work-active" : "work-unsettled"}};
  }
  return live.at(-1)?.status === "completed" ? {runId,retry:{eligible:false,reason:"work-completed"}} : {runId,retry:{eligible:true,reason:null}};
}

/** The same admission for manual and scheduled work; nested calls join the originating command's transaction. */
export function admitWeave(db: Database, sources: WeaveSources, input: WeaveIntent): RunRecord {
  return admit(db,sources,input,null);
}
function admit(db: Database, sources: WeaveSources, input: WeaveIntent, directCreationId: string | null): RunRecord {
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
      const originRunId = connectionDiscoveryOrigin(intent.triggerId);
      const directSubjectId = directConnectionDiscoverySubject(intent.triggerId);
      if (purpose === "connection-only" && directSubjectId === null) {
        if (subject.kind === "media-original" || !db.query(`SELECT 1 FROM runs r WHERE r.id=? AND r.kind IN ('weave','evolve')
          AND ((r.kind='evolve' AND r.input_thought_id=?) OR EXISTS(
            SELECT 1 FROM run_issued_thoughts i WHERE i.run_id=r.id AND i.thought_id=?))`).get(originRunId,intent.subjectId,intent.subjectId)) {
          throw new RunConflictError("Connection discovery requires its durable creation origin");
        }
      }
      if (directSubjectId !== null && (directSubjectId !== intent.subjectId || !db.query(`SELECT 1 FROM thoughts t WHERE t.id=? AND t.parent_id IS NOT NULL
        AND ((t.kind='user-contribution' AND t.author='user' AND t.origin='contribution' AND NOT EXISTS(SELECT 1 FROM thought_sources s WHERE s.thought_id=t.id))
          OR (t.kind='developing-idea' AND t.author='ai' AND t.origin='development'))
        AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.input_thought_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM run_issued_thoughts i WHERE i.thought_id=t.id)`).get(intent.subjectId))) {
        throw new RunConflictError("Direct discovery source differs from its thought");
      }
      const existing = db.query(`SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=? AND weave_trigger_id=? ORDER BY rowid LIMIT 1`)
        .get(intent.subjectId,intent.triggerId) as {id:string} | null;
      if (existing) {
        const run = readRun(db,existing.id);
        if (!run) throw new RunConflictError("Existing weave has no current step");
        return {run,reused:true};
      }
      if (originRunId !== null) {
        assertRunNotRestoreFenced(db,originRunId);
        if (!db.query("SELECT 1 FROM runs WHERE id=? AND status IN ('queued','submitting','running','uncertain')").get(originRunId)) {
          throw new RunFenceError("Discovery creation authority has ended");
        }
      }
      if (directSubjectId !== null && directCreationId !== directSubjectId) throw new RunFenceError("Direct discovery creation authority is unavailable");
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
    const originRunId = connectionDiscoveryOrigin(intent.triggerId);
    const directSubjectId = directConnectionDiscoverySubject(intent.triggerId);
    if (!result.reused && (originRunId !== null || directSubjectId !== null)) logger.info("[run storage] connection discovery admission applied in transaction",{
      runId:result.run.id,subjectId:intent.subjectId,...(originRunId === null ? {creation:"direct"} : {originRunId}),
    });
    return Object.freeze(result.run);
  } catch (error) {
    logger.verbose("[run storage] weave admission failed",{subjectId:intent.subjectId});
    throw error;
  }
}
