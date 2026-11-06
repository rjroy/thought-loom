import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createLogger, type Logger } from "../logging";
import { SearchConflictError, SearchForbiddenError, SearchNotFoundError, SearchStorageError, searchRevision,
  type SearchCatalogCursor, type SearchCatalogQuery, type SearchSessionOperation, type SearchSessionRecord,
  type SearchSessionRepository, type SearchSessionTransaction } from "../domain/agentic-search";
import { ValidationError } from "../domain/validation";
import { immediate } from "./transaction";
import { readSearchHistory } from "./search-history";
import { purgeLocalSearchSession } from "./search-purge";
import { SqliteSearchComposers } from "./search-composer";
import { SqliteSearchTurns } from "./search-turns";
import { touchSearchSession } from "./search-session-activity";

const columns = "id,create_request_key AS createRequestKey,title,created_at AS createdAt,last_activity_at AS lastActivityAt,revision,deleted_at AS deletedAt";
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
interface CatalogRow extends SearchSessionRecord { readonly sequence: number }

/** Owns only session transactions; it does not inherit ordinary-run or knowledge-write authority. */
export class SqliteSearchSessions implements SearchSessionRepository {
  constructor(private readonly db: Database, private readonly logger: Logger = createLogger()) {}
  transaction<T>(operation: SearchSessionOperation, action: (tx: SearchSessionTransaction) => T): T {
    this.logger.verbose(`[search session storage] ${operation} attempt`);
    try {
      const composers = new SqliteSearchComposers(this.db), turns = new SqliteSearchTurns(this.db);
      const result = immediate(this.db, () => action({
        get: id => this.db.query(`SELECT ${columns} FROM search_sessions WHERE id=CAST(? AS TEXT)`).get(text(id)) as SearchSessionRecord | null,
        byCreateKey: key => this.db.query(`SELECT ${columns} FROM search_sessions WHERE create_request_key=?`).get(key) as SearchSessionRecord | null,
        list: query => this.catalog(query),
        insert: session => {
          if (session.title === null || session.deletedAt !== null || session.revision !== 0) throw new SearchStorageError("invalid-new-search-session");
          this.bumpCatalog();
          this.db.run(`INSERT INTO search_sessions(id,create_request_key,title,created_at,last_activity_at,revision)
            VALUES (CAST(? AS TEXT),?,CAST(? AS TEXT),?,?,0)`, [text(session.id), session.createRequestKey, text(session.title), session.createdAt, session.lastActivityAt]);
        },
        rename: (id, revision, title, at) => {
          const changed = this.db.run(`UPDATE search_sessions SET title=CAST(? AS TEXT),last_activity_at=?,revision=revision+1
            WHERE id=CAST(? AS TEXT) AND revision=? AND deleted_at IS NULL`, [text(title), at, text(id), revision]);
          if (changed.changes !== 1) throw new SearchConflictError("revision-conflict");
          this.bumpCatalog();
        },
        history: (id, query) => readSearchHistory(this.db, id, query),
        purge: (id, at) => { this.requireCatalogCapacity(); purgeLocalSearchSession(this.db, id, at); },
        openComposer: (id, composerId, at) => composers.open(id, composerId, at),
        offerMessage: (id, composerId, messageId) => composers.offerMessage(id, composerId, messageId),
        turnByKey: (id, key) => turns.byKey(id, key),
        hasActiveTurn: id => turns.hasActive(id),
        prepareAdmission: (id, request) => composers.prepareAdmission(id, request),
        admitTurn: admission => { this.requireCatalogCapacity(); return turns.admit(admission); },
        removeDiscovery: (id, entryId, now) => {
          const entry = this.db.query("SELECT removed_at AS removedAt FROM search_discoveries WHERE id=CAST(? AS TEXT) AND session_id=CAST(? AS TEXT)")
            .get(text(entryId), text(id)) as { removedAt: string | null } | null;
          if (!entry) throw new SearchNotFoundError("search-discovery-not-found");
          if (entry.removedAt !== null) return false;
          const at = now();
          this.db.run("UPDATE search_discoveries SET removed_at=? WHERE id=CAST(? AS TEXT) AND session_id=CAST(? AS TEXT)", [at, text(entryId), text(id)]);
          touchSearchSession(this.db, id, at);
          return true;
        },
      }));
      this.logger.verbose(`[search session storage] ${operation} succeeded`);
      return result;
    } catch (error) {
      this.logger.verbose(`[search session storage] ${operation} failed`);
      if (error instanceof SearchConflictError || error instanceof SearchForbiddenError || error instanceof SearchNotFoundError ||
          error instanceof SearchStorageError || error instanceof ValidationError) throw error;
      // SQL errors can contain statement details. They are neither logs nor consumer-facing error messages.
      throw new SearchStorageError("search-persistence-failed", { cause: error });
    }
  }
  private catalogRevision(): number {
    const row = this.db.query("SELECT catalog FROM search_revisions WHERE id=1").get() as { catalog: number } | null;
    if (!row) throw new SearchStorageError("search-catalog-revision-unavailable");
    return searchRevision(row.catalog);
  }
  private requireCatalogCapacity(): void { searchRevision(this.catalogRevision() + 1); }
  private bumpCatalog(): void {
    this.requireCatalogCapacity();
    this.db.run("UPDATE search_revisions SET catalog=catalog+1 WHERE id=1");
  }
  private catalog(query: SearchCatalogQuery): { readonly items: readonly SearchSessionRecord[]; readonly nextCursor: SearchCatalogCursor | null } {
    const revision = this.catalogRevision(), cursor = query.cursor;
    if (cursor && cursor.catalogRevision !== revision) throw new SearchConflictError("list-changed");
    const highWater = searchRevision(cursor?.highWater ?? (this.db.query("SELECT COALESCE(MAX(sequence),0) AS n FROM search_sessions").get() as { n: number }).n);
    const after = cursor ? "AND (last_activity_at,sequence)<(?,?)" : "";
    const params: SQLQueryBindings[] = [highWater, ...(cursor ? [cursor.lastActivityAt, cursor.sequence] : []), query.limit + 1];
    const rows = this.db.query(`SELECT ${columns},sequence FROM search_sessions WHERE deleted_at IS NULL AND sequence<=?
      ${after}
      ORDER BY last_activity_at DESC,sequence DESC LIMIT ?`)
      .all(...params) as CatalogRow[];
    const retained = rows.slice(0, query.limit), last = retained.at(-1);
    if (last) searchRevision(last.sequence);
    const items = retained.map(({ sequence: _sequence, ...session }) => session);
    const nextCursor: SearchCatalogCursor | null = rows.length > query.limit && last ? Object.freeze({ kind: "search-sessions", scope: "user",
      order: "last-activity-desc", limit: query.limit, catalogRevision: revision, highWater, lastActivityAt: last.lastActivityAt, sequence: last.sequence }) : null;
    return { items, nextCursor };
  }
}
