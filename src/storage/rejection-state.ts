import type { Database } from "bun:sqlite";
import type { RejectionState, RejectionTarget } from "../domain/rejection";

/** Fetch identities for a mutation, never library text, titles, responses or explanations. */
export function readRejectionState(db: Database, target: RejectionTarget): RejectionState {
  const id = new TextEncoder().encode(target.id);
  if (target.kind === "connection") {
    const connections = db.query("SELECT id FROM connections WHERE id=CAST(? AS TEXT)").all(id) as { id: string }[];
    return { thoughts: [], connections, rejectedThoughtIds: [] };
  }
  // UNION terminates even for retained self-parent/cyclic ancestry. Only the requested evolution closure is fetched.
  const tree = target.kind === "branch"
    ? "WITH RECURSIVE tree(id) AS (SELECT id FROM thoughts WHERE id=CAST(? AS TEXT) UNION SELECT t.id FROM thoughts t JOIN tree p ON t.parent_id=p.id)"
    : "WITH tree(id) AS (SELECT id FROM thoughts WHERE id=CAST(? AS TEXT))";
  const rows = db.query(`${tree} SELECT t.id,t.parent_id AS parentId,r.thought_id IS NOT NULL AS rejected
    FROM tree JOIN thoughts t ON t.id=tree.id LEFT JOIN rejected_thoughts r ON r.thought_id=t.id`)
    .all(id) as { id: string; parentId: string | null; rejected: number }[];
  return { thoughts: rows.map(({ id, parentId }) => ({ id, parentId })), connections: [],
    rejectedThoughtIds: rows.filter(row => row.rejected).map(row => row.id) };
}
