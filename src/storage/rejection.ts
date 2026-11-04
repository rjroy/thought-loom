import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import type { ExportTreeNode, RejectionRepository, RejectionSnapshot, RejectionTransaction } from "../domain/rejection";
import { createThought } from "../domain/thought";
import { createConnection } from "../domain/connection";
import { createResponse } from "../domain/response";

function boundary<T>(logger: Logger, operation: string, action: () => T): T {
  logger.verbose(`[rejection storage] ${operation} attempt`);
  try {
    const result = action();
    logger.verbose(`[rejection storage] ${operation} succeeded`);
    return result;
  } catch (error) {
    logger.verbose(`[rejection storage] ${operation} failed`);
    throw error;
  }
}

function sourcesByOwner(rows: { ownerId: string; sourceId: string }[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const sources = result.get(row.ownerId) ?? [];
    sources.push(row.sourceId);
    result.set(row.ownerId, sources);
  }
  return result;
}

/** Internal adapter; expose scoped RejectionService reads to consumers instead. */
export class SqliteRejectionRepository implements RejectionRepository {
  constructor(private readonly db: Database, private readonly logger: Logger = createLogger()) {}

  exportTree(rootId: string): readonly ExportTreeNode[] {
    return boundary(this.logger, "export tree", () => this.db.transaction(() => {
      const tree = `WITH RECURSIVE tree(id) AS (SELECT id FROM thoughts WHERE id=? UNION SELECT t.id FROM thoughts t JOIN tree p ON t.parent_id=p.id)`;
      const sources = sourcesByOwner(this.db.query(`${tree}
        SELECT s.thought_id AS ownerId,s.source_id AS sourceId FROM thought_sources s JOIN tree ON tree.id=s.thought_id
        LEFT JOIN rejected_thoughts ownerRejected ON ownerRejected.thought_id=s.thought_id
        LEFT JOIN rejected_thoughts sourceRejected ON sourceRejected.thought_id=s.source_id
        WHERE ownerRejected.thought_id IS NULL AND sourceRejected.thought_id IS NULL ORDER BY s.thought_id,s.position`).all(rootId) as { ownerId: string; sourceId: string }[]);
      const rows = this.db.query(`${tree}
        SELECT t.id,t.parent_id AS parentId,t.created_at AS createdAt,
          CASE WHEN r.thought_id IS NULL THEN t.text END AS text,
          CASE WHEN r.thought_id IS NULL THEN m.title END AS title,
          CASE WHEN r.thought_id IS NULL THEN m.title_author END AS titleAuthor,
          CASE WHEN r.thought_id IS NULL THEN t.author END AS author,
          CASE WHEN r.thought_id IS NULL THEN t.kind END AS kind,
          CASE WHEN r.thought_id IS NULL THEN t.origin END AS origin,
          r.thought_id IS NOT NULL AS rejected
        FROM tree JOIN thoughts t ON t.id=tree.id JOIN thought_titles m ON m.thought_id=t.id
        LEFT JOIN rejected_thoughts r ON r.thought_id=t.id`).all(rootId) as { id: string; parentId: string | null; createdAt: string; rejected: number }[];
      return rows.map(row => ({ id: row.id, parentId: row.parentId, createdAt: row.createdAt,
        thought: row.rejected ? null : createThought({ ...row, sourceIds: sources.get(row.id) ?? [] }) }));
    })());
  }

  private readSnapshot(): RejectionSnapshot {
    const thoughtSources = sourcesByOwner(this.db.query("SELECT thought_id AS ownerId, source_id AS sourceId FROM thought_sources ORDER BY thought_id, position").all() as { ownerId: string; sourceId: string }[]);
    const connectionSources = sourcesByOwner(this.db.query("SELECT connection_id AS ownerId, source_id AS sourceId FROM connection_sources ORDER BY connection_id, position").all() as { ownerId: string; sourceId: string }[]);
    const thoughts = this.db.query(`SELECT t.id, t.text, m.title, m.title_author AS titleAuthor, t.author, t.kind, t.created_at AS createdAt, t.origin, t.parent_id AS parentId FROM thoughts t JOIN thought_titles m ON m.thought_id = t.id`).all() as { id: string }[];
    const connections = this.db.query(`SELECT id, from_id AS fromId, to_id AS toId, category, proposed_by AS proposedBy, explanation FROM connections`).all() as { id: string }[];
    const responseThoughts = sourcesByOwner(this.db.query("SELECT response_id AS ownerId, thought_id AS sourceId FROM response_thoughts ORDER BY response_id, position").all() as { ownerId: string; sourceId: string }[]);
    const responses = this.db.query("SELECT id, text, role, state FROM responses").all() as { id: string }[];
    const rejectedThoughts = this.db.query("SELECT thought_id AS id FROM rejected_thoughts").all() as { id: string }[];
    const rejectedConnections = this.db.query("SELECT connection_id AS id FROM rejected_connections").all() as { id: string }[];
    return {
      thoughts: thoughts.map(row => createThought({ ...row, sourceIds: thoughtSources.get(row.id) ?? [] })),
      connections: connections.map(row => createConnection({ ...row, sourceIds: connectionSources.get(row.id) ?? [] })),
      responses: responses.map(response => createResponse({ ...response, thoughtIds: responseThoughts.get(response.id) ?? [] })),
      rejectedThoughtIds: rejectedThoughts.map(row => row.id),
      rejectedConnectionIds: rejectedConnections.map(row => row.id),
    };
  }

  snapshot(): RejectionSnapshot {
    return boundary(this.logger, "snapshot", () => this.db.transaction(() => this.readSnapshot())());
  }

  transaction<T>(action: (tx: RejectionTransaction) => T): T {
    return boundary(this.logger, "transaction", () => this.db.transaction(() => action({
      snapshot: () => this.readSnapshot(),
      setThoughtRejected: (id, rejected) => {
        this.logger.verbose(`[rejection storage] thought ${rejected ? "reject" : "restore"} attempt`);
        if (rejected) this.db.run("INSERT OR IGNORE INTO rejected_thoughts (thought_id) VALUES (?)", [id]);
        else this.db.run("DELETE FROM rejected_thoughts WHERE thought_id = ?", [id]);
        this.logger.verbose(`[rejection storage] thought ${rejected ? "reject" : "restore"} applied in transaction`);
      },
      setConnectionRejected: (id, rejected) => {
        this.logger.verbose(`[rejection storage] connection ${rejected ? "reject" : "restore"} attempt`);
        if (rejected) this.db.run("INSERT OR IGNORE INTO rejected_connections (connection_id) VALUES (?)", [id]);
        else this.db.run("DELETE FROM rejected_connections WHERE connection_id = ?", [id]);
        this.logger.verbose(`[rejection storage] connection ${rejected ? "reject" : "restore"} applied in transaction`);
      },
    })).immediate());
  }
}
