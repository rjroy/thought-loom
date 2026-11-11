import type { Database } from "bun:sqlite";
import { SearchStorageError, searchRevision } from "../domain/agentic-search";
import type { RejectionService } from "../domain/rejection";
import { RunConflictError } from "../domain/run";
import type { Logger } from "../logging";
import { interruptOrdinaryRun, ordinaryRunContextValid, scopedRunVisibility, type InterruptionDiagnostic } from "./run-fences";
import { readRun } from "./run-record";
import { assertRestoreFenceSchema } from "./restore-fences-schema";

export interface SearchInvalidation {
  readonly interruptedRuns: number;
  readonly invalidatedComposers: number;
}
interface AffectedRun { readonly id: string; readonly generation: number; readonly possibleNative: number }

/** Eligibility dependencies, not ancestry propagation: active children redact rejected provenance on fresh reads. */
function affectedReferences(kind: "thought" | "connection"): string {
  return `WITH target(id) AS (VALUES(CAST(? AS TEXT))), affected(kind,id) AS (
    SELECT '${kind}',id FROM target
    ${kind === "thought" ? `UNION SELECT 'connection',id FROM connections WHERE from_id=(SELECT id FROM target)
      UNION SELECT 'connection',id FROM connections WHERE to_id=(SELECT id FROM target)
      UNION SELECT 'response',response_id FROM response_thoughts WHERE thought_id=(SELECT id FROM target)` : ""}
  )`;
}

/** Called only after an actual rejection-marker change, inside its owning transaction. No native calls or settlement. */
export function recordSearchEligibilityChange(db: Database, kind: "thought" | "connection", id: string, rejected: boolean): SearchInvalidation {
  if (!db.inTransaction) throw new SearchStorageError("search-invalidation-requires-transaction");
  assertRestoreFenceSchema(db);
  const revisions = db.query("SELECT eligibility,retrieval FROM search_revisions WHERE id=1").get() as { eligibility: number; retrieval: number } | null;
  if (!revisions) throw new SearchStorageError("search-revisions-unavailable");
  searchRevision(revisions.eligibility + 1); searchRevision(revisions.retrieval + 1);
  db.run("UPDATE search_revisions SET eligibility=eligibility+1,retrieval=retrieval+1 WHERE id=1");
  // Restoration changes eligibility, but can never revive a fenced generation or invalidated draft.
  if (!rejected) return { interruptedRuns: 0, invalidatedComposers: 0 };

  const affected = affectedReferences(kind), target = new TextEncoder().encode(id);
  const runs = db.query(`${affected}
    SELECT DISTINCT r.id,r.generation,
      (r.status!='queued' OR r.cancellation_state!='none'
        OR EXISTS (SELECT 1 FROM agent_bindings b WHERE b.run_id=r.id)
        OR NOT EXISTS (SELECT 1 FROM run_steps p WHERE p.run_id=r.id AND p.position=0 AND p.prompt_id=r.prompt_id)
        OR EXISTS (SELECT 1 FROM run_steps p WHERE p.run_id=r.id AND (p.position!=0 OR p.state!='prepared'
          OR p.native_state!='unknown' OR p.submit_owner IS NOT NULL OR p.envelope_json IS NOT NULL OR p.result_json IS NOT NULL))) AS possibleNative
    FROM affected a JOIN run_context x ON x.kind=a.kind AND x.ref_id=a.id
    JOIN runs r ON r.id=x.run_id JOIN search_turns t ON t.run_id=r.id JOIN search_sessions s ON s.id=t.session_id
    WHERE r.kind='search' AND r.status IN ('queued','submitting','running','uncertain') AND t.open_slot=1 AND s.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM main.restore_fences rf WHERE rf.entity_kind='run' AND rf.entity_id=r.id)`)
    .all(target) as AffectedRun[];
  for (const run of runs) {
    searchRevision(run.generation + 1);
    const runId = new TextEncoder().encode(run.id);
    db.run("UPDATE search_turns SET outcome_reason='context-invalidated' WHERE run_id=CAST(? AS TEXT) AND outcome_reason IS NULL", [runId]);
    // An intact unbound, never-authorized initial journal needs no remote cancellation. All uncertainty stays pending.
    // The existing terminal-status trigger releases the active slot in this same transaction.
    db.run(`UPDATE runs SET status='interrupted',generation=generation+1,
      cancellation_state=CASE WHEN ? THEN 'pending' ELSE cancellation_state END WHERE id=CAST(? AS TEXT)`, [run.possibleNative, runId]);
  }
  const composers = db.run(`${affected} UPDATE search_composer_contexts SET state='invalidated' WHERE state='active' AND id IN (
    SELECT d.composer_id FROM affected a JOIN search_composer_dependencies d ON d.ref_kind=a.kind AND d.ref_id=a.id
    JOIN search_composer_contexts c ON c.id=d.composer_id JOIN search_sessions s ON s.id=c.session_id
    WHERE c.state='active' AND s.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM main.restore_fences rf WHERE rf.entity_kind='composer' AND rf.entity_id=c.id))`, [target]);
  return { interruptedRuns: runs.length, invalidatedComposers: composers.changes };
}

/** Source rejection only. Reuse the affected-reference closure and ordinary eligibility/fence, in the marker transaction. */
export function recordMediaSourceRejection(db: Database, id: string, service: RejectionService, logger: Logger, diagnostics: InterruptionDiagnostic[]): number {
  if (!db.inTransaction) throw new RunConflictError("Media rejection requires its marker transaction");
  assertRestoreFenceSchema(db);
  const target = new TextEncoder().encode(id);
  if (!db.query("SELECT 1 FROM media_sources WHERE source_thought_id=CAST(? AS TEXT)").get(target)) return 0;
  const candidates = db.query<{ id: string }, [Uint8Array]>(`${affectedReferences("thought")}
    SELECT run.id FROM runs run WHERE run.kind IN ('weave','evolve')
      AND NOT EXISTS(SELECT 1 FROM main.restore_fences rf WHERE rf.entity_kind='run' AND rf.entity_id=run.id)
      AND run.status IN ('queued','submitting','running','uncertain') AND (
        run.weave_subject_id=(SELECT id FROM target) OR run.input_thought_id=(SELECT id FROM target)
        OR EXISTS(SELECT 1 FROM run_issued_thoughts issued WHERE issued.run_id=run.id AND issued.thought_id=(SELECT id FROM target))
        OR EXISTS(SELECT 1 FROM run_context context JOIN affected a ON a.kind=context.kind AND a.id=context.ref_id WHERE context.run_id=run.id))`)
    .all(target);
  const visible = scopedRunVisibility(service);
  let interrupted = 0;
  for (const candidate of candidates) {
    const run = readRun(db,candidate.id);
    if (run === null) throw new RunConflictError("Media-dependent run journal unavailable");
    if (ordinaryRunContextValid(db,run,visible)) continue;
    interruptOrdinaryRun(db,run,"context-invalidated",logger);
    diagnostics.push({ run, reason: "context-invalidated" });
    logger.info("[run storage] media context fenced in rejection transaction", { runId: run.id, generation: run.generation, fencedGeneration: run.generation + 1 });
    interrupted++;
  }
  return interrupted;
}
