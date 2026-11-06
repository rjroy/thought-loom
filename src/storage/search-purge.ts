import type { Database } from "bun:sqlite";
import { SearchConflictError, SearchStorageError } from "../domain/agentic-search";

/** Local-only foundation. A binding/setup flight or possible dispatch needs the later owned drain/cleanup integration. */
export function purgeLocalSearchSession(db: Database, sessionId: string, at: string): void {
  if (!db.inTransaction) throw new SearchStorageError("search-purge-requires-transaction");
  const id = new TextEncoder().encode(sessionId);
  const owned = "SELECT run_id FROM search_turns WHERE session_id=CAST(? AS TEXT)";
  // An absent binding is not proof of no submission. Require an intact, untouched initial journal as well.
  const unsafe = db.query(`SELECT 1 FROM search_turns t JOIN runs r ON r.id=t.run_id
    WHERE t.session_id=CAST(? AS TEXT) AND (r.kind!='search' OR r.input_thought_id IS NOT NULL
      OR r.weave_subject_id IS NOT NULL OR r.weave_trigger_id IS NOT NULL OR r.cancellation_state!='none'
      OR r.status IN ('submitting','running','uncertain')
      OR EXISTS (SELECT 1 FROM agent_bindings b WHERE b.run_id=r.id)
      OR NOT EXISTS (SELECT 1 FROM run_steps p WHERE p.run_id=r.id AND p.position=0 AND p.prompt_id=r.prompt_id)
      OR EXISTS (SELECT 1 FROM run_steps p WHERE p.run_id=r.id AND (p.position!=0 OR p.state!='prepared'
        OR p.native_state!='unknown' OR p.submit_owner IS NOT NULL OR p.envelope_json IS NOT NULL OR p.result_json IS NOT NULL))) LIMIT 1`).get(id);
  if (unsafe || db.query("SELECT 1 FROM search_native_cleanup WHERE session_id=CAST(? AS TEXT) LIMIT 1").get(id)) {
    throw new SearchConflictError("native-cleanup-required");
  }
  // Fence all local identities before erasing their content. No native settlement is inferred or recorded.
  db.run(`UPDATE runs SET generation=generation+1,status=CASE WHEN status IN ('queued','submitting','running','uncertain')
    THEN 'interrupted' ELSE status END WHERE id IN (${owned})`, [id]);
  db.run("UPDATE search_composer_contexts SET state='invalidated' WHERE session_id=CAST(? AS TEXT) AND state='active'", [id]);
  const changed = db.run(`UPDATE search_sessions SET title=NULL,deleted_at=?,last_activity_at=?,revision=revision+1
    WHERE id=CAST(? AS TEXT) AND deleted_at IS NULL`, [at, at, id]);
  if (changed.changes !== 1) throw new SearchStorageError("search-purge-owner-unavailable");
  db.run("DELETE FROM search_content_dependencies WHERE session_id=CAST(? AS TEXT)", [id]);
  db.run(`DELETE FROM search_composer_dependencies WHERE composer_id IN
    (SELECT id FROM search_composer_contexts WHERE session_id=CAST(? AS TEXT))`, [id]);
  db.run("DELETE FROM search_composer_contexts WHERE session_id=CAST(? AS TEXT)", [id]);
  db.run("DELETE FROM search_discoveries WHERE session_id=CAST(? AS TEXT)", [id]);
  db.run("DELETE FROM search_messages WHERE session_id=CAST(? AS TEXT)", [id]);
  for (const table of ["run_issued_thoughts", "run_operation_receipts", "run_replies", "run_context", "agent_bindings", "run_steps"]) {
    db.run(`DELETE FROM ${table} WHERE run_id IN (${owned})`, [id]);
  }
  // The retained turn still proves each run's kind and tombstone; its FK cascade is deliberately last.
  db.run(`DELETE FROM runs WHERE id IN (${owned})`, [id]);
  db.run("UPDATE search_revisions SET catalog=catalog+1 WHERE id=1");
  for (const table of ["search_turns", "search_messages", "search_discoveries", "search_content_dependencies", "search_composer_contexts"]) {
    if (db.query(`SELECT 1 FROM ${table} WHERE session_id=CAST(? AS TEXT) LIMIT 1`).get(id)) throw new SearchStorageError("search-purge-incomplete");
  }
}
