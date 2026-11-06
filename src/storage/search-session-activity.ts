import type { Database } from "bun:sqlite";
import { SearchStorageError, searchRecordTime, searchRevision } from "../domain/agentic-search";

/** A real session effect and its catalog ordering change commit in the caller's transaction. */
export function touchSearchSession(db: Database, sessionId: string, at: string): void {
  if (!db.inTransaction) throw new SearchStorageError("search-activity-requires-transaction");
  searchRecordTime(at);
  const id = new TextEncoder().encode(sessionId);
  const row = db.query(`SELECT s.revision,r.catalog FROM search_sessions s CROSS JOIN search_revisions r
    WHERE s.id=CAST(? AS TEXT) AND s.deleted_at IS NULL AND r.id=1`).get(id) as { revision: number; catalog: number } | null;
  if (!row) throw new SearchStorageError("search-activity-owner-unavailable");
  searchRevision(row.revision + 1); searchRevision(row.catalog + 1);
  db.run("UPDATE search_sessions SET revision=revision+1,last_activity_at=? WHERE id=CAST(? AS TEXT)", [at, id]);
  db.run("UPDATE search_revisions SET catalog=catalog+1 WHERE id=1");
}
