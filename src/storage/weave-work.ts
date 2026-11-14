import type { Database } from "bun:sqlite";
import type { RunStatus } from "../domain/run";
import type { MaterialKind } from "../domain/thought";
import { interpretationPurpose, resolveWeavePurpose } from "../domain/weave-scheduling";
import { recordedSubjectCancellationSafe } from "./run-cancellation";
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

interface SubjectWork extends SubjectWeaveWork { readonly kind: string; readonly subjectId: string | null; readonly triggerId: string | null }
/** Fixed-subject weaves plus the run that created an admitted input/issued thought. Context readers do not own it. */
function subjectWork(db: Database, subjectId: string, creators = true): readonly SubjectWork[] {
  return db.query<SubjectWork,[string]>(`SELECT r.id,r.kind,r.status,r.weave_subject_id AS subjectId,
    r.weave_trigger_id AS triggerId,r.cancellation_state AS cancellation,r.weave_retired_at AS retiredAt,
    (r.generation>0 OR EXISTS(SELECT 1 FROM agent_bindings b WHERE b.run_id=r.id) OR EXISTS(
      SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND (s.position>0 OR s.input IS NOT NULL OR
      s.state!='prepared' OR s.native_state!='unknown' OR s.envelope_json IS NOT NULL OR s.result_json IS NOT NULL))) AS started,
    (EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND (s.state IN ('submitting','uncertain') OR s.native_state='running')) OR
      (r.status IN ('submitting','running','uncertain') AND NOT EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=r.id
        AND s.position=(SELECT MAX(position) FROM run_steps WHERE run_id=r.id) AND s.native_state='completed'))) AS nativePending
     FROM runs r WHERE ${creators ? `r.id IN (
       SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=?1
       UNION SELECT id FROM runs WHERE kind='evolve' AND input_thought_id=?1
       UNION SELECT i.run_id FROM run_issued_thoughts i JOIN runs creator ON creator.id=i.run_id
         WHERE i.thought_id=?1 AND creator.kind IN ('weave','evolve'))` : "r.kind='weave' AND r.weave_subject_id=?1"}
     ORDER BY r.rowid`).all(subjectId);
}
/** Keep interpretation ownership/history separate from cross-purpose execution coordination. */
export function subjectWeaveWork(db: Database, subjectId: string, kind: MaterialKind): readonly SubjectWeaveWork[] {
  return subjectWork(db,subjectId,false).filter(row => row.triggerId !== null &&
    interpretationPurpose(resolveWeavePurpose(kind,row.triggerId)));
}

function subjectBlockReason(db: Database, work: SubjectWork): WeaveBlockReason | null {
  if (work.kind === "weave") return weaveWorkBlockReason(db,work);
  if (isRunRestoreFenced(db,work.id)) return null;
  if (["queued","submitting","running"].includes(work.status)) return "work-active";
  if (work.status === "uncertain" || work.cancellation === "pending") return "work-unsettled";
  if (work.status === "completed") return null;
  if (work.cancellation !== "settled") return "work-unsettled";
  return recordedSubjectCancellationSafe(db,work.id) ? null : "work-unverified";
}
export function dailyReviewSubjectBlocked(db: Database, subjectId: string): boolean {
  return subjectWork(db,subjectId).some(work => subjectBlockReason(db,work) !== null);
}

export function weaveWorkBlockReason(db: Database, work: SubjectWeaveWork): WeaveBlockReason | null {
  if (work.retiredAt !== null || isRunRestoreFenced(db,work.id)) return null;
  if (["queued","submitting","running"].includes(work.status)) return "work-active";
  if (work.status === "uncertain" || work.cancellation === "pending") return "work-unsettled";
  if (work.status === "completed") return null;
  if (work.cancellation !== "settled") return "work-unsettled";
  return recordedSubjectCancellationSafe(db,work.id) ? null : "work-unverified";
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
  const materialKind = run.materialKind, purpose = resolveWeavePurpose(materialKind,run.triggerId);
  const owned = subjectWork(db,run.subjectId).filter(work => subjectBlockReason(db,work) !== null);
  const daily = owned.filter(work => work.kind === "weave" && work.subjectId === run.subjectId && work.triggerId !== null &&
    resolveWeavePurpose(materialKind,work.triggerId) === "daily-review");
  if (purpose === "daily-review" || daily.length) {
    // Daily admission starts only on an idle subject. Later ordinary/discovery invitations wait behind
    // that reservation; they must not make an untouched daily owner wait on them in turn.
    const review = daily[0];
    if (review && purpose !== "daily-review") return false;
    if (purpose === "daily-review") {
      if (review?.id !== runId) return false;
      const beforeReview = owned.slice(0,owned.findIndex(work => work.id === runId));
      return beforeReview.length === 0 && !owned.some(work => work.id !== runId && work.started && subjectBlockReason(db,work) !== null);
    }
  }
  if (!interpretationPurpose(purpose)) return true;
  const work = subjectWeaveWork(db,run.subjectId,run.materialKind).filter(item => item.retiredAt === null && !isRunRestoreFenced(db,item.id));
  if (work.some(item => item.cancellation === "pending" || (!active(item.status) && weaveWorkBlockReason(db,item) !== null))) return false;
  const candidates = work.filter(item => active(item.status));
  const incumbent = candidates.find(item => item.started) ?? candidates[0];
  if (incumbent?.id !== runId) return false;
  // Legacy overlaps must drain their entered native work before even the incumbent sends another prompt.
  return !candidates.some(item => item.nativePending);
}
