import { Database } from "bun:sqlite";
import { setImmediate } from "node:timers/promises";
import { resolveSearchInput, searchTerms, SEARCH_ENGINE_VERSION, type SearchAlias, type SearchInput, type SearchResponse, type SearchResult } from "@thoughtloom/contracts";
import { ftsExpression, SEARCH_CANDIDATE_LIMIT, typoVariants, type SearchVariant } from "./search-query";
import { boundedExcerpt, snippetMarkers, snippetPassage } from "./search-preview";
import { sourceOrigin } from "./source-origin";
import { readTitle } from "./title-projection";

export class SearchError extends Error {
  constructor(readonly code: "invalid" | "busy" | "cancelled" | "unavailable") { super(code); this.name = "SearchError"; }
}
export type SearchService = { search(input: SearchInput, signal?: AbortSignal): Promise<SearchResponse> };
type Field = {
  id: number; targetKind: "source" | "item"; targetId: string; sourceId: string; itemId: string | null;
  formulationId: string | null; titleRevisionId: string | null; field: SearchResult["match"]["field"]; score: number;
};
type Hit = Field & { variant: SearchVariant; alias?: SearchAlias };
const tiers = { exact: 0, prefix: 1, typo: 2, alias: 3 } as const;
function binary(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compare(a: Hit, b: Hit): number {
  return tiers[a.variant.kind] - tiers[b.variant.kind] || a.variant.correctedTerms.length - b.variant.correctedTerms.length ||
    Number(a.field !== "title") - Number(b.field !== "title") || a.score - b.score ||
    binary(a.sourceId, b.sourceId) || binary(a.itemId ?? "", b.itemId ?? "") ||
    binary(a.titleRevisionId ?? a.formulationId ?? a.sourceId, b.titleRevisionId ?? b.formulationId ?? b.sourceId) || binary(a.alias?.id ?? "", b.alias?.id ?? "");
}

function aliases(db: Database, terms: readonly string[]): { routes: SearchAlias[]; truncated: boolean } {
  const rows = db.query<{ id: string; side: "alias" | "expansion"; alias: string; expansion: string; author: "user" | "ai" }, [string]>(`
    SELECT a.id,k.side,a.alias,a.expansion,a.author FROM search_alias_keys k JOIN search_aliases a ON a.id=k.alias_id
    WHERE k.lookup_key=? ORDER BY a.id,k.side LIMIT 9`).all(JSON.stringify(terms));
  const routes: SearchAlias[] = [];
  for (const row of rows.slice(0, 8)) {
    if (JSON.stringify(searchTerms(row[row.side])) !== JSON.stringify(terms)) throw new SearchError("unavailable");
    const evidence = db.query<{ id: string }, [string]>("SELECT source_id AS id FROM alias_evidence WHERE alias_id=? ORDER BY position LIMIT 17").all(row.id);
    if (!evidence.length || evidence.length > 16) throw new SearchError("unavailable");
    routes.push({ id: row.id, alias: row.alias, expansion: row.expansion, author: row.author, evidenceSourceIds: evidence.map((entry) => entry.id),
      direction: row.side === "alias" ? "alias-to-expansion" : "expansion-to-alias", expandedQuery: row[row.side === "alias" ? "expansion" : "alias"] });
  }
  return { routes, truncated: rows.length > 8 };
}

function hydrate(db: Database, hit: Hit): SearchResult {
  const source = db.query<{ provenance: string; createdAt: string; excerpt: string }, [string]>(
    "SELECT provenance,created_at AS createdAt,substr(text,1,4097) AS excerpt FROM sources WHERE id=?").get(hit.sourceId);
  if (!source) throw new SearchError("unavailable");
  let item: SearchResult["item"];
  if (hit.targetKind === "item") {
    const current = db.query<{ id: string; kind: "interpretation" | "developing-idea"; formulationId: string; author: "user" | "ai" }, [string, string]>(`
      SELECT i.id,i.kind,f.id AS formulationId,f.author FROM knowledge_items i JOIN formulations f ON f.item_id=i.id
      WHERE i.id=? AND i.source_id=? ORDER BY f.rowid DESC LIMIT 1`).get(hit.targetId, hit.sourceId);
    if (!current || current.formulationId !== hit.formulationId) throw new SearchError("unavailable");
    item = current;
  }
  const title = readTitle(db, hit.sourceId, item?.id, item?.formulationId).title;
  if ((title?.revisionId ?? null) !== hit.titleRevisionId) throw new SearchError("unavailable");
  const fieldRevisionId = hit.field === "title" ? title?.revisionId : item?.formulationId ?? hit.sourceId;
  if (!fieldRevisionId) throw new SearchError("unavailable");
  const markers = snippetMarkers();
  // Markers are internal framing, not trusted record text. A collision omits
  // this preview instead of turning stored characters into highlight authority.
  const marked = db.query<{ text: string }, [string, string, string, string, number, string, string, string]>(`
    SELECT substr(snippet(search_fts,0,?,?,?,32),1,16384) AS text FROM search_fts JOIN search_fields f ON f.id=search_fts.rowid
    WHERE search_fts MATCH ? AND f.id=? AND instr(f.text,?)=0 AND instr(f.text,?)=0 AND instr(f.text,?)=0`)
    .get(markers.start, markers.end, markers.ellipsis, hit.variant.expression, hit.id, markers.start, markers.end, markers.ellipsis);
  const passage = marked ? snippetPassage(marked.text, markers) : { fragments: [], leadingEllipsis: false, trailingEllipsis: false, omitted: true };
  return { sourceId: hit.sourceId, matchOrigin: hit.alias ? "alias" : hit.field === "title" ? "title" : item ? "interpretation" : "source",
    source: { provenance: source.provenance, createdAt: source.createdAt, origin: sourceOrigin(db, hit.sourceId),
      excerpt: hit.field === "source-body" ? passage.fragments[0]?.text ?? "" : boundedExcerpt(source.excerpt) },
    ...(item ? { item } : {}), ...(title ? { title } : {}), ...(hit.alias ? { alias: hit.alias } : {}), passage,
    match: { kind: hit.variant.kind, field: hit.field, fieldRevisionId, correctedTerms: hit.variant.correctedTerms } };
}

async function retrieve(db: Database, terms: readonly string[], limit: number, check: () => void): Promise<SearchResponse> {
  const hits = new Map<string, Hit>();
  let remaining = SEARCH_CANDIDATE_LIMIT, searchTruncated = false, aliasExpansionTruncated = false;
  const query = db.prepare<Field, [string, number]>(`SELECT f.id,f.target_kind AS targetKind,f.target_id AS targetId,
    f.source_id AS sourceId,f.item_id AS itemId,f.formulation_id AS formulationId,f.title_revision_id AS titleRevisionId,
    f.field_kind AS field,bm25(search_fts) AS score FROM search_fts JOIN search_fields f ON f.id=search_fts.rowid
    WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`);
  async function collect(variant: SearchVariant, alias?: SearchAlias): Promise<void> {
    check();
    if (!remaining) { searchTruncated = true; return; }
    const rows = query.all(variant.expression, remaining + 1);
    if (rows.length > remaining) { rows.length = remaining; searchTruncated = true; }
    remaining -= rows.length;
    for (const row of rows) {
      const key = `${row.targetKind}:${row.targetId}`, hit: Hit = { ...row, variant, ...(alias ? { alias } : {}) };
      const previous = hits.get(key);
      if (!previous || compare(hit, previous) < 0) hits.set(key, hit);
    }
    await setImmediate(); check();
  }
  try {
    await collect({ expression: ftsExpression(terms, false), kind: "exact", correctedTerms: [] });
    await collect({ expression: ftsExpression(terms, true), kind: "prefix", correctedTerms: [] });
    if (remaining) {
      const corrected = typoVariants(db, terms, check); searchTruncated ||= corrected.truncated;
      for (const variant of corrected.variants) { await collect(variant); if (!remaining) break; }
    }
    if (remaining) {
      const expanded = aliases(db, terms); aliasExpansionTruncated = expanded.truncated;
      const seen = new Set<string>();
      for (const alias of expanded.routes) {
        const other = searchTerms(alias.expandedQuery), expression = ftsExpression(other, true);
        if (!other.length || seen.has(expression)) continue;
        seen.add(expression); await collect({ expression, kind: "alias", correctedTerms: [] }, alias);
        if (!remaining) break;
      }
    }
    // Exhausting the shared field-row budget may leave later variants/routes
    // unvisited even when the last query itself had no overflow row.
    if (!remaining) searchTruncated = true;
    const ordered = [...hits.values()].sort(compare), results: SearchResult[] = [];
    for (const hit of ordered.slice(0, limit)) { check(); results.push(hydrate(db, hit)); }
    return { engineVersion: SEARCH_ENGINE_VERSION, results, hasMore: ordered.length > limit, searchTruncated, aliasExpansionTruncated };
  } finally { query.finalize(); }
}

// One daemon-owned indexed service is injected into GET and the authorized tool.
// Only bounded FTS matches/vocabulary entries cross into JS. Schema preparation
// remains startup/writer-owned; search never migrates or writes its connection.
export function createSearchService(options: { databasePath: string }): SearchService {
  let active = false;
  return { async search(value, signal): Promise<SearchResponse> {
    const input = resolveSearchInput(value);
    if (!input) throw new SearchError("invalid");
    const terms = searchTerms(input.query), metadata = { engineVersion: SEARCH_ENGINE_VERSION, queryLength: input.query.length, termCount: terms.length, limit: input.limit };
    if (!terms.length) return { engineVersion: SEARCH_ENGINE_VERSION, results: [], hasMore: false, searchTruncated: false, aliasExpansionTruncated: false };
    if (active) throw new SearchError("busy");
    active = true;
    const started = performance.now();
    console.info("search.request attempt", metadata);
    const check = () => { if (signal?.aborted) throw new SearchError("cancelled"); };
    try {
      check();
      const db = new Database(options.databasePath, { readonly: true, create: false });
      let transaction = false;
      let response: SearchResponse;
      try {
        db.exec("BEGIN"); transaction = true;
        response = await retrieve(db, terms, input.limit, check);
        check(); db.exec("COMMIT"); transaction = false;
      } finally { try { if (transaction) db.exec("ROLLBACK"); } finally { db.close(); } }
      console.info("search.request succeeded", { ...metadata, elapsedMs: performance.now() - started, resultCount: response.results.length,
        hasMore: response.hasMore, searchTruncated: response.searchTruncated, aliasExpansionTruncated: response.aliasExpansionTruncated });
      return response;
    } catch (error) {
      const failure = error instanceof SearchError ? error : new SearchError("unavailable");
      console.warn("search.request failed", { ...metadata, elapsedMs: performance.now() - started, category: failure.code });
      throw failure;
    } finally { active = false; }
  } };
}
