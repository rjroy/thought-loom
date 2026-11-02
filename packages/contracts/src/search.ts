import type { SourceOrigin, ThoughtTitle } from "./index";
import { isRecordId, parseSourceOrigin, parseThoughtTitle } from "./inspection";

export const SEARCH_ENGINE_VERSION = 2;
export const SEARCH_QUERY_MAX_LENGTH = 512;
export const SEARCH_MAX_TERMS = 32;
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;
export const SEARCH_PASSAGE_GRAPHEMES = 240;
export const SEARCH_PASSAGE_UTF16 = 4_096;

export type SearchInput = { query: string; limit?: number };
export type SearchRequest = { query: string; limit: number };
export type SearchCorrection = { from: string; to: string };
export type SearchMatch = {
  kind: "exact" | "prefix" | "typo" | "alias";
  field: "source-body" | "formulation-body" | "title";
  fieldRevisionId: string;
  correctedTerms: readonly SearchCorrection[];
};
// FTS snippets have fragment-local UTF-16 highlights, not invented global field
// offsets. Text is plain text; clients render escaped nodes, never snippet HTML.
export type SearchPassageFragment = { text: string; highlights: readonly { start: number; end: number }[] };
export type SearchPassage = {
  fragments: readonly SearchPassageFragment[];
  leadingEllipsis: boolean; trailingEllipsis: boolean; omitted: boolean;
};
export type SearchAlias = {
  id: string; alias: string; expansion: string; author: "user" | "ai"; evidenceSourceIds: string[];
  direction: "alias-to-expansion" | "expansion-to-alias"; expandedQuery: string;
};
export type SearchResult = {
  sourceId: string; matchOrigin: "source" | "interpretation" | "alias" | "title";
  title?: ThoughtTitle;
  source: { excerpt: string; provenance: string; createdAt: string; origin: SourceOrigin };
  // Search is not a full formulation read and never supplies a read witness.
  item?: { id: string; kind: "interpretation" | "developing-idea"; formulationId: string; author: "user" | "ai" };
  match: SearchMatch; passage: SearchPassage; alias?: SearchAlias;
};
export type SearchResponse = {
  engineVersion: typeof SEARCH_ENGINE_VERSION; results: SearchResult[]; hasMore: boolean;
  searchTruncated: boolean; aliasExpansionTruncated: boolean;
};

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function natural(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function author(value: unknown): value is "user" | "ai" { return value === "user" || value === "ai"; }
function wellFormed(value: unknown): value is string { return typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value); }

// User text is word input, not an FTS expression. unicode61 does the indexed
// matching; this bounded lexical projection supplies quoted AND/prefix terms
// and Latin-accent/case-normalized vocabulary lookups for modest corrections.
export function searchTerms(query: string): string[] {
  // Fold Latin accents for vocabulary lookup without deleting meaningful
  // marks in other scripts or leaving Hangul decomposed into different tokens.
  const words = query.normalize("NFD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  return [...new Set(words)].sort();
}
export function isSearchQuery(value: unknown): value is string {
  return wellFormed(value) && value.length <= SEARCH_QUERY_MAX_LENGTH && searchTerms(value).length <= SEARCH_MAX_TERMS;
}
export function parseSearchInput(value: unknown, strict = true): SearchInput | null {
  if (!record(value) || (strict && !keys(value, ["query", "limit"])) || !isSearchQuery(value.query) ||
      (value.limit !== undefined && (!natural(value.limit) || value.limit < 1 || value.limit > SEARCH_MAX_LIMIT))) return null;
  return { query: value.query, ...(typeof value.limit === "number" ? { limit: value.limit } : {}) };
}
export function resolveSearchInput(value: unknown): SearchRequest | null {
  const input = parseSearchInput(value);
  return input ? { query: input.query, limit: input.limit ?? SEARCH_DEFAULT_LIMIT } : null;
}
export function parseSearchParameters(params: URLSearchParams): SearchRequest | null {
  const queries = params.getAll("q"), limits = params.getAll("limit");
  if (queries.length > 1 || limits.length > 1 || (limits.length === 1 && !/^[1-9]\d*$/.test(limits[0]))) return null;
  return resolveSearchInput({ query: queries[0] ?? "", ...(limits.length ? { limit: Number(limits[0]) } : {}) });
}

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
function boundaries(text: string): Set<number> {
  const result = new Set<number>([text.length]);
  for (const part of segmenter.segment(text)) result.add(part.index);
  return result;
}
function boundedText(value: unknown): value is string {
  return wellFormed(value) && value.length <= SEARCH_PASSAGE_UTF16 && boundaries(value).size - 1 <= SEARCH_PASSAGE_GRAPHEMES;
}
function passage(value: unknown): SearchPassage | null {
  if (!record(value) || !keys(value, ["fragments", "leadingEllipsis", "trailingEllipsis", "omitted"]) ||
      typeof value.leadingEllipsis !== "boolean" || typeof value.trailingEllipsis !== "boolean" || typeof value.omitted !== "boolean" ||
      !Array.isArray(value.fragments) || value.fragments.length > 1 || (!value.fragments.length && !value.omitted)) return null;
  const fragments: SearchPassageFragment[] = [];
  for (const fragment of value.fragments) {
    if (!record(fragment) || !keys(fragment, ["text", "highlights"]) || !boundedText(fragment.text) || !fragment.text ||
        !Array.isArray(fragment.highlights) || fragment.highlights.length > 64) return null;
    const edges = boundaries(fragment.text), highlights: { start: number; end: number }[] = [];
    let previous = 0;
    for (const range of fragment.highlights) {
      if (!record(range) || !keys(range, ["start", "end"]) || !natural(range.start) || !natural(range.end) ||
          range.start < previous || range.end <= range.start || range.end > fragment.text.length || !edges.has(range.start) || !edges.has(range.end)) return null;
      highlights.push({ start: range.start, end: range.end }); previous = range.end;
    }
    fragments.push({ text: fragment.text, highlights });
  }
  return { fragments, leadingEllipsis: value.leadingEllipsis, trailingEllipsis: value.trailingEllipsis, omitted: value.omitted };
}
function alias(value: unknown): SearchAlias | null {
  if (!record(value) || !keys(value, ["id", "alias", "expansion", "author", "evidenceSourceIds", "direction", "expandedQuery"]) ||
      !isRecordId(value.id) || !isSearchQuery(value.alias) || !value.alias.trim() || !isSearchQuery(value.expansion) || !value.expansion.trim() ||
      !author(value.author) || !Array.isArray(value.evidenceSourceIds) || !value.evidenceSourceIds.length || value.evidenceSourceIds.length > 16 ||
      !value.evidenceSourceIds.every(isRecordId) || new Set(value.evidenceSourceIds).size !== value.evidenceSourceIds.length ||
      (value.direction !== "alias-to-expansion" && value.direction !== "expansion-to-alias") ||
      value.expandedQuery !== (value.direction === "alias-to-expansion" ? value.expansion : value.alias)) return null;
  return { id: value.id, alias: value.alias, expansion: value.expansion, author: value.author, evidenceSourceIds: [...value.evidenceSourceIds],
    direction: value.direction, expandedQuery: value.expandedQuery };
}
function result(value: unknown): SearchResult | null {
  if (!record(value) || !keys(value, ["sourceId", "matchOrigin", "source", "item", "title", "match", "passage", "alias"]) ||
      !isRecordId(value.sourceId) || !record(value.source) || !keys(value.source, ["excerpt", "provenance", "createdAt", "origin"]) ||
      !boundedText(value.source.excerpt) || typeof value.source.provenance !== "string" || !value.source.provenance.trim() ||
      typeof value.source.createdAt !== "string" || Number.isNaN(Date.parse(value.source.createdAt)) || !record(value.match)) return null;
  const origin = parseSourceOrigin(value.source.origin), preview = passage(value.passage), match = value.match;
  if (!origin || !preview || !keys(match, ["kind", "field", "fieldRevisionId", "correctedTerms"]) || !isRecordId(match.fieldRevisionId) ||
      (match.kind !== "exact" && match.kind !== "prefix" && match.kind !== "typo" && match.kind !== "alias") ||
      (match.field !== "source-body" && match.field !== "formulation-body" && match.field !== "title") ||
      !Array.isArray(match.correctedTerms) || match.correctedTerms.length > 2) return null;
  const correctedTerms: SearchCorrection[] = [], correctedFrom = new Set<string>();
  for (const correction of match.correctedTerms) {
    if (!record(correction) || !keys(correction, ["from", "to"]) || !wellFormed(correction.from) || !wellFormed(correction.to) ||
        !correction.from || !correction.to || correction.from === correction.to || correction.from.length > 64 || correction.to.length > 66 ||
        correctedFrom.has(correction.from)) return null;
    correctedFrom.add(correction.from);
    correctedTerms.push({ from: correction.from, to: correction.to });
  }
  if ((match.kind === "typo") !== (correctedTerms.length > 0)) return null;
  let item: SearchResult["item"];
  if (value.item !== undefined) {
    const entry = value.item;
    if (!record(entry) || !keys(entry, ["id", "kind", "formulationId", "author"]) || !isRecordId(entry.id) || !isRecordId(entry.formulationId) ||
        !author(entry.author) || (entry.kind !== "interpretation" && entry.kind !== "developing-idea")) return null;
    item = { id: entry.id, kind: entry.kind, formulationId: entry.formulationId, author: entry.author };
  }
  const title = value.title === undefined ? undefined : parseThoughtTitle(value.title);
  if (title === null) return null;
  const owner = match.field === "title" ? title?.revisionId : match.field === "formulation-body" ? item?.formulationId : !item ? value.sourceId : undefined;
  if (owner !== match.fieldRevisionId) return null;
  const matchOrigin = match.kind === "alias" ? "alias" : match.field === "title" ? "title" : item ? "interpretation" : "source";
  if (value.matchOrigin !== matchOrigin) return null;
  const via = match.kind === "alias" ? alias(value.alias) : undefined;
  if (via === null || (match.kind !== "alias" && value.alias !== undefined)) return null;
  return { sourceId: value.sourceId, matchOrigin, source: { excerpt: value.source.excerpt, provenance: value.source.provenance, createdAt: value.source.createdAt, origin },
    match: { kind: match.kind, field: match.field, fieldRevisionId: match.fieldRevisionId, correctedTerms }, passage: preview,
    ...(item ? { item } : {}), ...(title ? { title } : {}), ...(via ? { alias: via } : {}) };
}
export function parseSearchResponse(value: unknown): SearchResponse | null {
  if (!record(value) || !keys(value, ["engineVersion", "results", "hasMore", "searchTruncated", "aliasExpansionTruncated"]) ||
      value.engineVersion !== SEARCH_ENGINE_VERSION || typeof value.hasMore !== "boolean" || typeof value.searchTruncated !== "boolean" ||
      typeof value.aliasExpansionTruncated !== "boolean" || !Array.isArray(value.results) || value.results.length > SEARCH_MAX_LIMIT) return null;
  const results: SearchResult[] = [], seen = new Set<string>();
  for (const entry of value.results) {
    const found = result(entry); if (!found) return null;
    const key = found.item ? `item:${found.item.id}` : `source:${found.sourceId}`;
    if (seen.has(key)) return null;
    seen.add(key); results.push(found);
  }
  return { engineVersion: SEARCH_ENGINE_VERSION, results, hasMore: value.hasMore, searchTruncated: value.searchTruncated, aliasExpansionTruncated: value.aliasExpansionTruncated };
}
