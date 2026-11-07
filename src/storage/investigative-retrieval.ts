import type { Database } from "bun:sqlite";
import type { InvestigationCandidate, InvestigationRequest, InvestigationResult, RelatedItem, RelatedRequest, RelatedResult, SearchInvestigation } from "../domain/investigative-retrieval";
import { ValidationError } from "../domain/validation";
import { SqliteSearchRepository } from "./search";
import type { Logger } from "../logging";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { uniqueKeys } from "../domain/run-protocol";

type Cursor = { version: 3; binding: string; revision: number; thoughtHigh: number; responseHigh: number; key: number; id: string; kind: "thought" | "response" };
type Row = InvestigationCandidate & { key: number };
const scope = { actor: "ai", mode: "normal" } as const;
const authors = ["user", "ai", "source"];
const kinds = ["captured-original", "user-contribution", "ai-interpretation", "developing-idea", "imported-original", "media-original"];
// One key per process, shared across store facets and SQLite connections.
const cursorKey = randomBytes(32);
const cursorMac = (payload: string) => createHmac("sha256", cursorKey).update(payload).digest();

function signCursor(cursor: object): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${cursorMac(payload).toString("base64url")}`;
}

function normalize(request: InvestigationRequest): { binding: string; limit: number } {
  if (!request || typeof request !== "object" || Object.keys(request).some(k => !["query", "authors", "kinds", "from", "until", "sort", "limit", "cursor"].includes(k))) throw new ValidationError("Invalid investigation request");
  if (request.query !== null && (typeof request.query !== "string" || !request.query.trim())) throw new ValidationError("Invalid query");
  if (!Array.isArray(request.authors) || request.authors.some(a => !authors.includes(a)) || new Set(request.authors).size !== request.authors.length ||
      !Array.isArray(request.kinds) || request.kinds.some(k => !kinds.includes(k)) || new Set(request.kinds).size !== request.kinds.length) throw new ValidationError("Invalid filters");
  for (const value of [request.from, request.until]) {
    if (value !== null && (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))) throw new ValidationError("Invalid UTC endpoint");
  }
  if (request.from && request.until && Date.parse(request.from) >= Date.parse(request.until)) throw new ValidationError("Invalid date range");
  if (!["relevance", "newest", "oldest"].includes(request.sort) || (request.query === null && (!request.from || !request.until || request.sort === "relevance"))) throw new ValidationError("Invalid investigation sort or range");
  const limit = request.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("Invalid limit");
  const canonical = JSON.stringify([request.query, [...request.authors].sort(), [...request.kinds].sort(), request.from, request.until, request.sort, limit]);
  const binding = createHmac("sha256", cursorKey).update("find-thoughts-binding\0").update(canonical).digest("base64url");
  return { limit, binding };
}

function verifiedCursor(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new ValidationError("Invalid cursor");
  let c: unknown;
  try {
    const [payload, signature] = value.split(".");
    const received = Buffer.from(signature, "base64url"), expected = cursorMac(payload);
    if (received.length !== expected.length || received.toString("base64url") !== signature || !timingSafeEqual(received, expected)) throw new Error();
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) throw new Error();
    const json = bytes.toString("utf8");
    c = JSON.parse(json);
    uniqueKeys(json);
  } catch { throw new ValidationError("Invalid cursor"); }
  return c;
}

function parseCursor(value: unknown, binding: string): Cursor | null {
  const c = verifiedCursor(value);
  if (c === null) return null;
  if (!c || typeof c !== "object") throw new ValidationError("Invalid cursor");
  const x = c as Record<string, unknown>;
  if (Object.keys(x).sort().join(",") !== "binding,id,key,kind,responseHigh,revision,thoughtHigh,version" || x.version !== 3 || x.binding !== binding ||
      ![x.revision, x.thoughtHigh, x.responseHigh].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ||
      typeof x.key !== "number" || !Number.isFinite(x.key) || typeof x.id !== "string" || !x.id || (x.kind !== "thought" && x.kind !== "response")) throw new ValidationError("Invalid cursor");
  return x as Cursor;
}

type RelatedCursor = { version: 1; type: "related"; binding: string; revision: number; highWater: number; id: string };
function relatedCursor(value: unknown, binding: string): RelatedCursor | null {
  const data = verifiedCursor(value);
  if (data === null) return null;
  if (typeof data !== "object") throw new ValidationError("Invalid cursor");
  const c = data as Record<string, unknown>;
  if (Object.keys(c).sort().join(",") !== "binding,highWater,id,revision,type,version" || c.version !== 1 || c.type !== "related" || c.binding !== binding ||
      ![c.revision, c.highWater].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) || typeof c.id !== "string" || !c.id) throw new ValidationError("Invalid cursor");
  return c as RelatedCursor;
}

export class SqliteSearchInvestigation implements SearchInvestigation {
  private readonly search: SqliteSearchRepository;
  constructor(private readonly db: Database, search: SqliteSearchRepository, private readonly logger: Logger) { this.search = search; }

  related(request: RelatedRequest): RelatedResult {
    if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some(k => !["thoughtId", "relation", "limit", "cursor"].includes(k)) ||
        typeof request.thoughtId !== "string" || !request.thoughtId.trim() || !["connections", "children", "parent", "sources", "responses"].includes(request.relation)) throw new ValidationError("Invalid related request");
    const limit = request.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("Invalid limit");
    const binding = JSON.stringify([request.thoughtId, request.relation, limit]);
    const cursor = relatedCursor(request.cursor, binding);
    this.logger.verbose("[investigation storage] related attempt");
    try {
      const result = this.db.transaction(() => {
        const revision = (this.db.query("SELECT retrieval FROM search_revisions WHERE id=1").get() as { retrieval: number }).retrieval;
        if (cursor && cursor.revision !== revision) return { type: "retrieval-changed" } as const;
        const found = this.db.query(`SELECT 1 FROM thoughts t JOIN thought_titles m ON m.thought_id=t.id
          WHERE t.id=CAST(? AS TEXT) AND NOT EXISTS (SELECT 1 FROM rejected_thoughts x WHERE x.thought_id=t.id)`).get(new TextEncoder().encode(request.thoughtId));
        if (!found) throw new ValidationError("Thought not found");
        const table = request.relation === "connections" ? "connections" : request.relation === "sources" ? "thought_sources" : request.relation === "responses" ? "response_thoughts" : "thoughts";
        const highWater = cursor?.highWater ?? (this.db.query(`SELECT coalesce(max(rowid),0) AS value FROM ${table}`).get() as { value: number }).value;
        const clauses = {
          children: `SELECT 'thought' AS kind,t.id AS id FROM thoughts t JOIN thought_titles m ON m.thought_id=t.id WHERE t.parent_id=CAST($thought AS TEXT) AND t.rowid<=$high AND NOT EXISTS (SELECT 1 FROM rejected_thoughts x WHERE x.thought_id=t.id)`,
          parent: `SELECT 'thought' AS kind,t.id AS id FROM thoughts owner JOIN thoughts t ON t.id=owner.parent_id JOIN thought_titles m ON m.thought_id=t.id WHERE owner.id=CAST($thought AS TEXT) AND t.rowid<=$high AND NOT EXISTS (SELECT 1 FROM rejected_thoughts x WHERE x.thought_id=t.id)`,
          sources: `SELECT DISTINCT 'thought' AS kind,t.id AS id FROM thought_sources s JOIN thoughts t ON t.id=s.source_id JOIN thought_titles m ON m.thought_id=t.id WHERE s.thought_id=CAST($thought AS TEXT) AND s.rowid<=$high AND NOT EXISTS (SELECT 1 FROM rejected_thoughts x WHERE x.thought_id=t.id)`,
          connections: `SELECT 'connection' AS kind,c.id AS id,c.from_id AS fromId,c.to_id AS toId,c.category AS category FROM connections c WHERE (c.from_id=CAST($thought AS TEXT) OR c.to_id=CAST($thought AS TEXT)) AND c.rowid<=$high AND NOT EXISTS (SELECT 1 FROM rejected_connections x WHERE x.connection_id=c.id) AND NOT EXISTS (SELECT 1 FROM rejected_thoughts x WHERE x.thought_id=c.from_id OR x.thought_id=c.to_id)`,
          responses: `SELECT 'response' AS kind,r.id AS id FROM response_thoughts rt JOIN responses r ON r.id=rt.response_id WHERE rt.thought_id=CAST($thought AS TEXT) AND rt.rowid<=$high AND NOT EXISTS (SELECT 1 FROM response_thoughts members JOIN rejected_thoughts x ON x.thought_id=members.thought_id WHERE members.response_id=r.id)`,
        };
        const rows = this.db.query(`SELECT * FROM (${clauses[request.relation]}) WHERE ($after IS NULL OR id>CAST($after AS TEXT)) ORDER BY id LIMIT $limit`).all({
          $thought: new TextEncoder().encode(request.thoughtId), $high: highWater, $after: cursor ? new TextEncoder().encode(cursor.id) : null, $limit: limit + 1,
        }) as RelatedItem[];
        const items = rows.slice(0, limit), last = items.at(-1);
        return { type: "page", items, nextCursor: rows.length > limit && last ? signCursor({ version: 1, type: "related", binding, revision, highWater, id: last.id }) : null } as const;
      })();
      this.logger.verbose("[investigation storage] related succeeded");
      return result;
    } catch (error) {
      this.logger.verbose("[investigation storage] related failed");
      if (error instanceof ValidationError) throw error;
      throw new Error("Investigative retrieval failed");
    }
  }

  findThoughts(request: InvestigationRequest): InvestigationResult {
    const { binding, limit } = normalize(request);
    const cursor = parseCursor(request.cursor, binding);
    this.logger.verbose("[investigation storage] retrieval attempt");
    try {
    const result = this.db.transaction(() => {
      const revision = (this.db.query("SELECT retrieval FROM search_revisions WHERE id=1").get() as { retrieval: number }).retrieval;
      if (cursor && cursor.revision !== revision) return { type: "retrieval-changed" } as const;
      const high = cursor ?? this.db.query("SELECT coalesce((SELECT max(rowid) FROM thoughts),0) AS thoughtHigh, coalesce((SELECT max(rowid) FROM responses),0) AS responseHigh").get() as { thoughtHigh: number; responseHigh: number };
      const match = request.query === null ? null : this.search.lexicalMatch(scope, request.query);
      if (request.query !== null && match === null) return { type: "page", items: [], nextCursor: null } as const;
      const lexical = match !== null;
      const thoughtSource = lexical ? "thought_search_fts JOIN thoughts t ON t.id=thought_search_fts.thought_id" : "thoughts t";
      const responseSource = lexical ? "response_search_fts JOIN responses r ON r.id=response_search_fts.response_id" : "responses r";
      const thoughtMatch = lexical ? "thought_search_fts MATCH $match AND" : "";
      const responseMatch = lexical ? "response_search_fts MATCH $match AND" : "";
      const thoughtScore = lexical ? "bm25(thought_search_fts)" : "0.0";
      const responseScore = lexical ? "bm25(response_search_fts)" : "0.0";
      const descending = request.sort === "newest";
      const key = request.sort === "relevance" ? "score" : "coalesce(julianday(createdAt),-1)";
      const rows = this.db.query(`WITH matched AS MATERIALIZED (
        SELECT 'thought' AS kind,t.id AS id,t.id AS thoughtId,
          substr(CASE WHEN t.kind='media-original' THEN coalesce(s.clarification,'') ELSE t.text END,1,160) AS snippet,t.author AS author,${thoughtScore} AS score
        FROM ${thoughtSource} LEFT JOIN media_sources s ON s.source_thought_id=t.id
        WHERE ${thoughtMatch} t.rowid <= $thoughtHigh AND NOT EXISTS (SELECT 1 FROM rejected_thoughts x WHERE x.thought_id=t.id)
        UNION ALL
        SELECT 'response' AS kind,r.id AS id,(SELECT rt.thought_id FROM response_thoughts rt WHERE rt.response_id=r.id ORDER BY rt.position DESC LIMIT 1) AS thoughtId,
          substr(r.text,1,160) AS snippet,'ai' AS author,${responseScore} AS score
        FROM ${responseSource} WHERE ${responseMatch} r.rowid <= $responseHigh
          AND EXISTS (SELECT 1 FROM response_thoughts rt WHERE rt.response_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM response_thoughts rt JOIN rejected_thoughts x ON x.thought_id=rt.thought_id WHERE rt.response_id=r.id)
      ), candidates AS MATERIALIZED (
        SELECT matched.*,t.kind AS materialKind,t.created_at AS createdAt FROM matched JOIN thoughts t ON t.id=matched.thoughtId
        WHERE t.rowid <= $thoughtHigh AND ($from IS NULL OR julianday(t.created_at)>=julianday($from)) AND ($until IS NULL OR julianday(t.created_at)<julianday($until))
          AND (json_array_length($authors)=0 OR matched.author IN (SELECT value FROM json_each($authors)))
          AND (json_array_length($kinds)=0 OR t.kind IN (SELECT value FROM json_each($kinds)))
      ), ordered AS (SELECT *,${key} AS key FROM candidates)
      SELECT kind,id,thoughtId,snippet,author,materialKind,createdAt,key FROM ordered
      WHERE $cursorKey IS NULL OR key ${descending ? "<" : ">"} $cursorKey OR (key=$cursorKey AND (id>$cursorId OR (id=$cursorId AND kind>$cursorKind)))
      ORDER BY key ${descending ? "DESC" : "ASC"},id,kind LIMIT $limit`).all({
        ...(lexical ? { $match: match } : {}), $thoughtHigh: high.thoughtHigh, $responseHigh: high.responseHigh,
        $from: request.from, $until: request.until, $authors: JSON.stringify(request.authors), $kinds: JSON.stringify(request.kinds),
        $cursorKey: cursor?.key ?? null, $cursorId: cursor?.id ?? null, $cursorKind: cursor?.kind ?? null, $limit: limit + 1,
      }) as Row[];
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const nextCursor = rows.length > limit && last ? signCursor({ version: 3, binding, revision, thoughtHigh: high.thoughtHigh, responseHigh: high.responseHigh, key: last.key, id: last.id, kind: last.kind }) : null;
      return { type: "page", items: items.map(({ key: _key, ...item }) => item), nextCursor } as const;
    })();
    this.logger.verbose("[investigation storage] retrieval succeeded");
    return result;
    } catch {
      this.logger.verbose("[investigation storage] retrieval failed");
      throw new Error("Investigative retrieval failed");
    }
  }
}
