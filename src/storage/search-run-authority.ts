import type { Database } from "bun:sqlite";
import { RunFenceError, type ContextRef, type RunRecord } from "../domain/run";
import { searchReferencesEligible } from "./search-eligibility";

/** Structural ownership is separate from source eligibility. No raw conversation is read at native boundaries. */
export function requireSearchExecutionOwner(db: Database, run: RunRecord): void {
  const owner = db.query(`SELECT 1 FROM runs r JOIN search_turns t ON t.run_id=r.id
    JOIN search_sessions s ON s.id=t.session_id
    JOIN search_messages u ON u.session_id=t.session_id AND u.run_id=r.id AND u.role='user'
    LEFT JOIN agent_bindings b ON b.run_id=r.id
    WHERE r.id=? AND r.kind='search' AND s.deleted_at IS NULL AND t.open_slot=1 AND r.cancellation_state='none'
      AND r.input_thought_id IS NULL AND r.weave_subject_id IS NULL AND r.weave_trigger_id IS NULL
      AND (b.run_id IS NULL OR b.session_id=r.session_id)
      AND NOT EXISTS (SELECT 1 FROM run_operation_receipts WHERE run_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM run_issued_thoughts WHERE run_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM run_replies WHERE run_id=r.id)`).get(run.id);
  if (!owner) throw new RunFenceError("Live search execution owner required");
}
export function searchExecutionContextValid(db: Database, runId: string): boolean {
  const refs = db.query("SELECT kind,ref_id AS id FROM run_context WHERE run_id=?").all(runId) as ContextRef[];
  return searchReferencesEligible(db, refs);
}
