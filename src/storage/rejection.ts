import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { RejectionService, type BrowseThoughtQuery, type BrowseThoughtRows, type NeighborhoodPosition, type NeighborhoodRows, type ReadScope, type ExportTreeNode, type RejectionRepository, type RejectionSnapshot, type RejectionState, type RejectionTarget, type RejectionTransaction } from "../domain/rejection";
import { createConnection } from "../domain/connection";
import { createResponse } from "../domain/response";
import { immediate } from "./transaction";
import { readRejectionState } from "./rejection-state";
import { recordMediaSourceRejection, recordSearchEligibilityChange } from "./search-invalidation";
import { storedThoughts } from "./media-source";
import { logCommittedInterruption, type InterruptionDiagnostic } from "./run-fences";

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

  neighborhood(scope: ReadScope, id: string, limit: number, after?: NeighborhoodPosition): NeighborhoodRows | null {
    return boundary(this.logger, "neighborhood", () => this.db.transaction(() => {
      const visible = scope.mode === "normal";
      const focus = this.db.query<{ id: string }, [string]>(`SELECT t.id FROM thoughts t WHERE t.id=?
        ${visible ? "AND NOT EXISTS (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id)" : ""}`).get(id);
      if (!focus) return null;
      type EdgeRow = { kind: number; owner: string; position: number; fromId: string; toId: string };
      const selected = this.db.query<EdgeRow, [string, number | null, string | null, number | null, number]>(`
        WITH edges AS (
          SELECT 0 AS kind,t.id AS owner,0 AS position,t.parent_id AS fromId,t.id AS toId
          FROM thoughts t WHERE t.parent_id IS NOT NULL AND (t.id=?1 OR t.parent_id=?1)
          UNION ALL
          SELECT 1,s.thought_id,s.position,s.source_id,s.thought_id FROM thought_sources s
          WHERE s.thought_id=?1 OR s.source_id=?1
          UNION ALL
          SELECT 2,c.id,0,c.from_id,c.to_id FROM connections c WHERE c.from_id=?1 OR c.to_id=?1
        )
        SELECT e.* FROM edges e
        WHERE (?2 IS NULL OR (e.kind,e.owner,e.position) > (?2,?3,?4))
          ${visible ? `AND NOT EXISTS (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=e.fromId)
            AND NOT EXISTS (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=e.toId)
            AND (e.kind<>2 OR NOT EXISTS (SELECT 1 FROM rejected_connections r WHERE r.connection_id=e.owner))` : ""}
        ORDER BY e.kind,e.owner,e.position LIMIT ?5`).all(id, after?.kind ?? null, after?.owner ?? null, after?.position ?? null, limit + 1);
      const page = selected.slice(0, limit);
      const ids = new Set([id]);
      for (const edge of page) { ids.add(edge.fromId); ids.add(edge.toId); }
      const thoughtIds = JSON.stringify([...ids]);
      const thoughtSources = sourcesByOwner(this.db.query<{ ownerId: string; sourceId: string }, [string]>(`
        SELECT thought_id AS ownerId,source_id AS sourceId FROM thought_sources
        WHERE thought_id IN (SELECT value FROM json_each(?)) ORDER BY thought_id,position`).all(thoughtIds));
      const thoughtRows = this.db.query<{ id: string }, [string]>(`SELECT t.id,t.text,m.title,m.title_author AS titleAuthor,
        t.author,t.kind,t.created_at AS createdAt,t.origin,t.parent_id AS parentId FROM thoughts t
        JOIN thought_titles m ON m.thought_id=t.id WHERE t.id IN (SELECT value FROM json_each(?))`).all(thoughtIds);
      const thoughts = storedThoughts(this.db, thoughtRows.map(row => ({ ...row, sourceIds: thoughtSources.get(row.id) ?? [] })));
      const connectionIds = JSON.stringify(page.filter(edge => edge.kind === 2).map(edge => edge.owner));
      const connectionSources = sourcesByOwner(this.db.query<{ ownerId: string; sourceId: string }, [string]>(`
        SELECT connection_id AS ownerId,source_id AS sourceId FROM connection_sources
        WHERE connection_id IN (SELECT value FROM json_each(?)) ORDER BY connection_id,position`).all(connectionIds));
      const connectionRows = this.db.query<{ id: string }, [string]>(`SELECT id,from_id AS fromId,to_id AS toId,
        category,proposed_by AS proposedBy,explanation FROM connections WHERE id IN (SELECT value FROM json_each(?))`).all(connectionIds);
      const connections = connectionRows.map(row => createConnection({ ...row, sourceIds: connectionSources.get(row.id) ?? [] }));
      const byConnection = new Map(connections.map(connection => [connection.id, connection]));
      const references = new Set(ids);
      if (scope.actor === "ai") {
        for (const thought of thoughts) {
          if (thought.parentId !== null) references.add(thought.parentId);
          for (const source of thought.sourceIds) references.add(source);
        }
        for (const connection of connections) for (const source of connection.sourceIds) references.add(source);
      }
      const rejectedThoughtIds = this.db.query<{ id: string }, [string]>(`SELECT thought_id AS id FROM rejected_thoughts
        WHERE thought_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...references])).map(row => row.id);
      const rejectedConnectionIds = this.db.query<{ id: string }, [string]>(`SELECT connection_id AS id FROM rejected_connections
        WHERE connection_id IN (SELECT value FROM json_each(?))`).all(connectionIds).map(row => row.id);
      return { thoughts, rejectedThoughtIds, rejectedConnectionIds, hasMore: selected.length > limit,
        edges: page.map(({ kind, owner, position, fromId, toId }) => ({ key: { kind, owner, position }, fromId, toId,
          ...(kind === 2 ? { connection: byConnection.get(owner) } : {}) })) };
    })());
  }

  browseThoughts(scope: ReadScope, query: BrowseThoughtQuery): BrowseThoughtRows {
    return boundary(this.logger, "browse thoughts", () => this.db.transaction(() => {
      const direction = query.sort === "newest" ? "DESC" : "ASC";
      const comparison = query.sort === "newest" ? "<" : ">";
      const candidates = this.db.query<{ id: string }, [string, string | null, string | null, string | null, number]>(`
        SELECT t.id FROM thoughts t
        WHERE t.author IN (SELECT value FROM json_each(?))
          AND (${scope.mode === "normal" ? "NOT EXISTS (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id)" : "1"})
          AND (? IS NULL OR (t.created_at,t.id) ${comparison} (?,?))
        ORDER BY t.created_at ${direction},t.id ${direction} LIMIT ?`);
      // The cursor timestamp appears twice in the keyset predicate.
      const after = query.after;
      const selected = candidates.all(JSON.stringify(query.authors), after?.createdAt ?? null, after?.createdAt ?? null, after?.id ?? null, query.limit + 1);
      const ids = selected.slice(0, query.limit).map(row => row.id);
      if (!ids.length) return { thoughts: [], rejectedThoughtIds: [], hasMore: false };
      const json = JSON.stringify(ids);
      const sourceRows = this.db.query<{ ownerId: string; sourceId: string }, [string]>(`
        SELECT thought_id AS ownerId,source_id AS sourceId FROM thought_sources
        WHERE thought_id IN (SELECT value FROM json_each(?)) ORDER BY thought_id,position`).all(json);
      const sources = sourcesByOwner(sourceRows);
      const rows = this.db.query<{ id: string; parentId: string | null }, [string]>(`
        SELECT t.id,t.text,m.title,m.title_author AS titleAuthor,t.author,t.kind,t.created_at AS createdAt,t.origin,t.parent_id AS parentId
        FROM thoughts t JOIN thought_titles m ON m.thought_id=t.id
        WHERE t.id IN (SELECT value FROM json_each(?))`).all(json);
      const thoughts = storedThoughts(this.db, rows.map(row => ({ ...row, sourceIds: sources.get(row.id) ?? [] })));
      const byId = new Map(thoughts.map(thought => [thought.id, thought]));
      const ordered = ids.map(id => {
        const thought = byId.get(id);
        if (!thought) throw new Error("Browse thought unavailable");
        return thought;
      });
      const references = new Set(ids);
      if (scope.actor === "ai") for (const thought of ordered) {
        if (thought.parentId !== null) references.add(thought.parentId);
        for (const id of thought.sourceIds) references.add(id);
      }
      const rejected = this.db.query<{ id: string }, [string]>(`SELECT thought_id AS id FROM rejected_thoughts
        WHERE thought_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...references]));
      return { thoughts: ordered, rejectedThoughtIds: rejected.map(row => row.id), hasMore: selected.length > query.limit };
    })());
  }

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
      const visible = new Map(storedThoughts(this.db, rows.filter(row => !row.rejected)
        .map(row => ({ ...row, sourceIds: sources.get(row.id) ?? [] }))).map(thought => [thought.id, thought]));
      return rows.map(row => ({ id: row.id, parentId: row.parentId, createdAt: row.createdAt,
        thought: visible.get(row.id) ?? null }));
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
      thoughts: storedThoughts(this.db, thoughts.map(row => ({ ...row, sourceIds: thoughtSources.get(row.id) ?? [] }))),
      connections: connections.map(row => createConnection({ ...row, sourceIds: connectionSources.get(row.id) ?? [] })),
      responses: responses.map(response => createResponse({ ...response, thoughtIds: responseThoughts.get(response.id) ?? [] })),
      rejectedThoughtIds: rejectedThoughts.map(row => row.id),
      rejectedConnectionIds: rejectedConnections.map(row => row.id),
    };
  }

  snapshot(): RejectionSnapshot {
    return boundary(this.logger, "snapshot", () => this.db.transaction(() => this.readSnapshot())());
  }

  state(target: RejectionTarget): RejectionState {
    return boundary(this.logger, "target state", () => this.db.transaction(() => readRejectionState(this.db, target))());
  }

  private setRejected(kind: "thought" | "connection", id: string, rejected: boolean, diagnostics: InterruptionDiagnostic[]): void {
    const operation = `${kind} ${rejected ? "reject" : "restore"}`;
    this.logger.verbose(`[rejection storage] ${operation} attempt`);
    const table = kind === "thought" ? "rejected_thoughts" : "rejected_connections", column = `${kind}_id`;
    const key = new TextEncoder().encode(id);
    const changed = rejected
      ? this.db.run(`INSERT OR IGNORE INTO ${table} (${column}) VALUES (CAST(? AS TEXT))`, [key])
      : this.db.run(`DELETE FROM ${table} WHERE ${column}=CAST(? AS TEXT)`, [key]);
    if (changed.changes === 0) {
      this.logger.verbose(`[rejection storage] ${operation} unchanged`);
      return;
    }
    const invalidated = recordSearchEligibilityChange(this.db, kind, id, rejected);
    const interruptedMediaRuns = rejected && kind === "thought"
      ? recordMediaSourceRejection(this.db,id,new RejectionService(this),this.logger,diagnostics) : 0;
    this.logger.info(`[rejection storage] ${operation} applied in transaction`, { ...invalidated, interruptedMediaRuns });
  }

  transaction<T>(action: (tx: RejectionTransaction) => T): T {
    const outerTransaction = this.db.inTransaction;
    const diagnostics: InterruptionDiagnostic[] = [];
    const result = boundary(this.logger, "transaction", () => immediate(this.db, () => action({
      snapshot: () => this.readSnapshot(),
      state: target => readRejectionState(this.db, target),
      setThoughtRejected: (id, rejected) => this.setRejected("thought", id, rejected,diagnostics),
      setConnectionRejected: (id, rejected) => this.setRejected("connection", id, rejected,diagnostics),
    })));
    if (!outerTransaction) for (const diagnostic of diagnostics) logCommittedInterruption(this.db,this.logger,diagnostic);
    return result;
  }
}
