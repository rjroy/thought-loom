import type { Database } from "bun:sqlite";
import type { RejectionRepository, RejectionSnapshot, RejectionTransaction } from "../domain/rejection";
import { createThought } from "../domain/thought";
import { createConnection } from "../domain/connection";
import { createResponse } from "../domain/response";

function boundary<T>(operation: string, action: () => T): T {
  console.info(`[rejection storage] ${operation} attempt`);
  try {
    const result = action();
    console.info(`[rejection storage] ${operation} succeeded`);
    return result;
  } catch (error) {
    console.error(`[rejection storage] ${operation} failed`);
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
  constructor(private readonly db: Database) {}

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
    return boundary("snapshot", () => this.db.transaction(() => this.readSnapshot())());
  }

  transaction<T>(action: (tx: RejectionTransaction) => T): T {
    return boundary("transaction", () => this.db.transaction(() => action({
      snapshot: () => this.readSnapshot(),
      setThoughtRejected: (id, rejected) => {
        console.info(`[rejection storage] thought ${rejected ? "reject" : "restore"} attempt`);
        if (rejected) this.db.run("INSERT OR IGNORE INTO rejected_thoughts (thought_id) VALUES (?)", [id]);
        else this.db.run("DELETE FROM rejected_thoughts WHERE thought_id = ?", [id]);
        console.info(`[rejection storage] thought ${rejected ? "reject" : "restore"} applied in transaction`);
      },
      setConnectionRejected: (id, rejected) => {
        console.info(`[rejection storage] connection ${rejected ? "reject" : "restore"} attempt`);
        if (rejected) this.db.run("INSERT OR IGNORE INTO rejected_connections (connection_id) VALUES (?)", [id]);
        else this.db.run("DELETE FROM rejected_connections WHERE connection_id = ?", [id]);
        console.info(`[rejection storage] connection ${rejected ? "reject" : "restore"} applied in transaction`);
      },
    })).immediate());
  }
}
