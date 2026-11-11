import type { Database } from "bun:sqlite";
import type { RunStatus } from "../domain/run";
import type { MaterialKind } from "../domain/thought";
import { resolveWeavePurpose } from "../domain/weave-scheduling";
import { recordedWeaveCancellationSafe } from "./run-cancellation";
import { isRunRestoreFenced } from "./restore-fences";

export interface SubjectWeaveWork {
  readonly id: string;
  readonly status: RunStatus;
  readonly cancellation: string;
  readonly started: number;
  readonly nativePending: number;
  readonly retiredAt: string | null;
}
export type WeaveBlockReason = "work-active" | "work-unsettled" | "work-unverified";
const active = (status: RunStatus): boolean => ["queued","submitting","running","uncertain"].includes(status);

/** Existing insertion order and durable journal facts, not an in-memory subject owner or another queue. */
export function subjectWeaveWork(db: Database, subjectId: string, kind: MaterialKind): readonly SubjectWeaveWork[] {
  const rows = db.query<SubjectWeaveWork & {triggerId:string},[string]>(`SELECT r.id,r.status,
    r.weave_trigger_id AS triggerId,r.cancellation_state AS cancellation,r.weave_retired_at AS retiredAt,
    (r.generation>0 OR EXISTS(SELECT 1 FROM agent_bindings b WHERE b.run_id=r.id) OR EXISTS(
      SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND (s.position>0 OR s.input IS NOT NULL OR
      s.state!='prepared' OR s.native_state!='unknown' OR s.envelope_json IS NOT NULL OR s.result_json IS NOT NULL))) AS started,
    (EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND (s.state IN ('submitting','uncertain') OR s.native_state='running')) OR
      (r.status IN ('submitting','running','uncertain') AND NOT EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=r.id
        AND s.position=(SELECT MAX(position) FROM run_steps WHERE run_id=r.id) AND s.native_state='completed'))) AS nativePending
    FROM runs r WHERE r.kind='weave' AND r.weave_subject_id=? ORDER BY r.rowid`).all(subjectId);
  return rows.filter(row => resolveWeavePurpose(kind,row.triggerId) !== "media-title-only");
}

export function weaveWorkBlockReason(db: Database, work: SubjectWeaveWork): WeaveBlockReason | null {
  if (work.retiredAt !== null || isRunRestoreFenced(db,work.id)) return null;
  if (["queued","submitting","running"].includes(work.status)) return "work-active";
  if (work.status === "uncertain" || work.cancellation === "pending") return "work-unsettled";
  if (work.status === "completed") return null;
  if (work.cancellation !== "settled") return "work-unsettled";
  return recordedWeaveCancellationSafe(db,work.id) ? null : "work-unverified";
}

/** Caller owns its existing read/write transaction. Already-submitted work is observed separately, never redispatched. */
export function weaveDispatchAllowed(db: Database, runId: string): boolean {
  if (isRunRestoreFenced(db,runId) || db.query("SELECT 1 FROM runs WHERE id=? AND weave_retired_at IS NOT NULL").get(runId)) return false;
  const run = db.query<{kind:string;subjectId:string|null;triggerId:string|null;materialKind:MaterialKind|null},[string]>(
    `SELECT r.kind,r.weave_subject_id AS subjectId,r.weave_trigger_id AS triggerId,t.kind AS materialKind
     FROM runs r LEFT JOIN thoughts t ON t.id=r.weave_subject_id WHERE r.id=?`).get(runId);
  if (!run) return false;
  if (run.kind !== "weave" || run.subjectId === null || run.triggerId === null) return true; // Never infer an unknown legacy subject.
  if (run.materialKind === null) return false;
  if (resolveWeavePurpose(run.materialKind,run.triggerId) === "media-title-only") return true;
  const work = subjectWeaveWork(db,run.subjectId,run.materialKind).filter(item => item.retiredAt === null && !isRunRestoreFenced(db,item.id));
  if (work.some(item => item.cancellation === "pending" || (!active(item.status) && weaveWorkBlockReason(db,item) !== null))) return false;
  const candidates = work.filter(item => active(item.status));
  const incumbent = candidates.find(item => item.started) ?? candidates[0];
  if (incumbent?.id !== runId) return false;
  // Legacy overlaps must drain their entered native work before even the incumbent sends another prompt.
  return !candidates.some(item => item.nativePending);
}
