import type { SourceOrigin, ThoughtTitle } from "./index";
import { isRecordId, parseSourceOrigin, parseThoughtTitle } from "./inspection";

export const SEARCH_ENGINE_VERSION = 1;
export const SEARCH_QUERY_MAX_LENGTH = 512;
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;
export const SEARCH_PASSAGE_GRAPHEMES = 240;
export const SEARCH_PASSAGE_UTF16 = 4_096;

export type SearchInput = { query: string; limit?: number };
export type SearchRequest = { query: string; limit: number };
export type SearchMatch = {
  route: "direct" | "alias"; field: "source-body" | "formulation-body" | "title";
  class: "whole-word" | "contiguous" | "initials" | "scattered";
  // Half-open normalized-key positions, NOT original text offsets.
  skipped: number; start: number; end: number; fieldRevisionId: string;
};
// Half-open original-field UTF-16 bounds; highlights are fragment-local UTF-16
// bounds. All displayed ranges must end at whole original grapheme edges.
export type SearchPassageFragment = {
  start: number; end: number; text: string;
  highlights: readonly { start: number; end: number }[];
};
export type SearchPassage = {
  // Full original-field UTF-16 match bounds, including undisplayed gaps.
  matchStart: number; matchEnd: number; matchedKeyCount: number;
  omittedMatchedCharacters: boolean; fragments: readonly SearchPassageFragment[];
};
export type SearchAlias = {
  id: string; alias: string; expansion: string; author: "user" | "ai"; evidenceSourceIds: string[];
  direction: "alias-to-expansion" | "expansion-to-alias"; expandedQuery: string;
};
export type SearchResult = {
  sourceId: string; matchOrigin: "source" | "interpretation" | "alias" | "title";
  title?: ThoughtTitle;
  source: { excerpt: string; provenance: string; createdAt: string; origin: SourceOrigin };
  // Search is not a full formulation read or a read witness. Never place a
  // preview in item.text, whose old meaning was the complete formulation.
  item?: { id: string; kind: "interpretation" | "developing-idea"; formulationId: string; author: "user" | "ai" };
  match: SearchMatch; passage: SearchPassage; alias?: SearchAlias;
};
export type SearchResponse = {
  engineVersion: typeof SEARCH_ENGINE_VERSION; results: SearchResult[];
  hasMore: boolean; aliasExpansionTruncated: boolean;
};

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function natural(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function author(value: unknown): value is "user" | "ai" { return value === "user" || value === "ai"; }
function wellFormed(value: unknown): value is string { return typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value); }
export function isSearchQuery(value: unknown): value is string { return wellFormed(value) && value.length <= SEARCH_QUERY_MAX_LENGTH; }

// Preserve raw spelling, punctuation and every explicitly typed whitespace key.
// Empty/whitespace-only inputs are valid requests with no matches, not operators.
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
  if (queries.length > 1 || limits.length > 1 ||
      (limits.length === 1 && !/^[1-9]\d*$/.test(limits[0]))) return null;
  return resolveSearchInput({ query: queries[0] ?? "", ...(limits.length ? { limit: Number(limits[0]) } : {}) });
}

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
function edges(text: string): Set<number> {
  const result = new Set<number>([text.length]);
  for (const part of segmenter.segment(text)) result.add(part.index);
  return result;
}
function boundedText(value: unknown): value is string {
  return wellFormed(value) && value.length <= SEARCH_PASSAGE_UTF16 && edges(value).size - 1 <= SEARCH_PASSAGE_GRAPHEMES;
}

function parsePassage(value: unknown): SearchPassage | null {
  if (!record(value) || !keys(value, ["matchStart", "matchEnd", "matchedKeyCount", "omittedMatchedCharacters", "fragments"]) ||
      !natural(value.matchStart) || !natural(value.matchEnd) || value.matchEnd <= value.matchStart ||
      !natural(value.matchedKeyCount) || value.matchedKeyCount < 1 || value.matchedKeyCount > SEARCH_QUERY_MAX_LENGTH ||
      typeof value.omittedMatchedCharacters !== "boolean" || !Array.isArray(value.fragments) || value.fragments.length > 3) return null;
  const fragments: SearchPassageFragment[] = [];
  let previousEnd = 0, payload = 0, graphemes = 0, firstHighlight: number | undefined, lastHighlight: number | undefined;
  for (const fragment of value.fragments) {
    if (!record(fragment) || !keys(fragment, ["start", "end", "text", "highlights"]) ||
        !natural(fragment.start) || !natural(fragment.end) || fragment.end <= fragment.start || fragment.start < previousEnd ||
        !wellFormed(fragment.text) || fragment.end - fragment.start !== fragment.text.length ||
        !Array.isArray(fragment.highlights) || fragment.highlights.length > SEARCH_QUERY_MAX_LENGTH) return null;
    payload += fragment.text.length;
    if (payload > SEARCH_PASSAGE_UTF16) return null;
    const boundaries = edges(fragment.text);
    graphemes += boundaries.size - 1;
    if (graphemes > SEARCH_PASSAGE_GRAPHEMES) return null;
    const highlights: { start: number; end: number }[] = [];
    let highlightedEnd = 0;
    for (const range of fragment.highlights) {
      if (!record(range) || !keys(range, ["start", "end"]) || !natural(range.start) || !natural(range.end) ||
          range.start < highlightedEnd || range.end <= range.start || range.end > fragment.text.length ||
          !boundaries.has(range.start) || !boundaries.has(range.end) ||
          fragment.start + range.start < value.matchStart || fragment.start + range.end > value.matchEnd) return null;
      highlights.push({ start: range.start, end: range.end });
      firstHighlight ??= fragment.start + range.start;
      lastHighlight = fragment.start + range.end;
      highlightedEnd = range.end;
    }
    fragments.push({ start: fragment.start, end: fragment.end, text: fragment.text, highlights });
    previousEnd = fragment.end;
  }
  if (!value.omittedMatchedCharacters && (firstHighlight !== value.matchStart || lastHighlight !== value.matchEnd)) return null;
  return { matchStart: value.matchStart, matchEnd: value.matchEnd, matchedKeyCount: value.matchedKeyCount,
    omittedMatchedCharacters: value.omittedMatchedCharacters, fragments };
}

function parseMatch(value: unknown): SearchMatch | null {
  if (!record(value) || !keys(value, ["route", "field", "class", "skipped", "start", "end", "fieldRevisionId"]) ||
      (value.route !== "direct" && value.route !== "alias") ||
      (value.field !== "source-body" && value.field !== "formulation-body" && value.field !== "title") ||
      (value.class !== "whole-word" && value.class !== "contiguous" && value.class !== "initials" && value.class !== "scattered") ||
      !natural(value.skipped) || !natural(value.start) || !natural(value.end) || value.end <= value.start ||
      !isRecordId(value.fieldRevisionId) || ((value.class === "whole-word" || value.class === "contiguous") && value.skipped !== 0)) return null;
  return { route: value.route, field: value.field, class: value.class, skipped: value.skipped,
    start: value.start, end: value.end, fieldRevisionId: value.fieldRevisionId };
}

function parseAlias(value: unknown): SearchAlias | null {
  if (!record(value) || !keys(value, ["id", "alias", "expansion", "author", "evidenceSourceIds", "direction", "expandedQuery"]) ||
      !isRecordId(value.id) || !isSearchQuery(value.alias) || !value.alias.trim() ||
      !isSearchQuery(value.expansion) || !value.expansion.trim() || !author(value.author) ||
      !Array.isArray(value.evidenceSourceIds) || !value.evidenceSourceIds.length || value.evidenceSourceIds.length > 16 ||
      !value.evidenceSourceIds.every(isRecordId) || new Set(value.evidenceSourceIds).size !== value.evidenceSourceIds.length ||
      (value.direction !== "alias-to-expansion" && value.direction !== "expansion-to-alias") ||
      value.expandedQuery !== (value.direction === "alias-to-expansion" ? value.expansion : value.alias)) return null;
  return { id: value.id, alias: value.alias, expansion: value.expansion, author: value.author,
    evidenceSourceIds: [...value.evidenceSourceIds], direction: value.direction, expandedQuery: value.expandedQuery };
}

function parseResult(value: unknown): SearchResult | null {
  if (!record(value) || !keys(value, ["sourceId", "matchOrigin", "source", "item", "title", "match", "passage", "alias"]) ||
      !isRecordId(value.sourceId) || !record(value.source) || !keys(value.source, ["excerpt", "provenance", "createdAt", "origin"]) ||
      !boundedText(value.source.excerpt) || typeof value.source.provenance !== "string" || !value.source.provenance.trim() ||
      typeof value.source.createdAt !== "string" || Number.isNaN(Date.parse(value.source.createdAt))) return null;
  const origin = parseSourceOrigin(value.source.origin), match = parseMatch(value.match), passage = parsePassage(value.passage);
  if (!origin || !record(value.source.origin) || !keys(value.source.origin, origin.kind === "capture" ? ["kind"] : ["kind", "dialogueId", "turnId", "rootSourceId"]) || !match || !passage ||
      match.end - match.start - match.skipped !== passage.matchedKeyCount) return null;
  let item: SearchResult["item"];
  if (value.item !== undefined) {
    const entry = value.item;
    if (!record(entry) || !keys(entry, ["id", "kind", "formulationId", "author"]) || !isRecordId(entry.id) ||
        !isRecordId(entry.formulationId) || !author(entry.author) || (entry.kind !== "interpretation" && entry.kind !== "developing-idea")) return null;
    item = { id: entry.id, kind: entry.kind, formulationId: entry.formulationId, author: entry.author };
  }
  const title = value.title === undefined ? undefined : parseThoughtTitle(value.title);
  if (title === null || (value.title !== undefined && (!record(value.title) || !keys(value.title, ["revisionId", "text", "author"])))) return null;
  const owner = match.field === "title" ? title?.revisionId : match.field === "formulation-body" ? item?.formulationId : !item ? value.sourceId : undefined;
  if (owner !== match.fieldRevisionId) return null;
  const matchOrigin = match.route === "alias" ? "alias" : match.field === "title" ? "title" : item ? "interpretation" : "source";
  if (value.matchOrigin !== matchOrigin) return null;
  const alias = match.route === "alias" ? parseAlias(value.alias) : undefined;
  if (alias === null || (match.route === "direct" && value.alias !== undefined)) return null;
  return { sourceId: value.sourceId, matchOrigin, source: { excerpt: value.source.excerpt, provenance: value.source.provenance,
    createdAt: value.source.createdAt, origin }, match, passage, ...(item ? { item } : {}), ...(title ? { title } : {}), ...(alias ? { alias } : {}) };
}

// Local structure/grapheme checks are not proof of canonical field contents or
// of a true outside-fragment boundary. Only a pinned full read can supply that.
export function parseSearchResponse(value: unknown): SearchResponse | null {
  if (!record(value) || !keys(value, ["engineVersion", "results", "hasMore", "aliasExpansionTruncated"]) ||
      value.engineVersion !== SEARCH_ENGINE_VERSION || typeof value.hasMore !== "boolean" || typeof value.aliasExpansionTruncated !== "boolean" ||
      !Array.isArray(value.results) || value.results.length > SEARCH_MAX_LIMIT || (value.hasMore && !value.results.length)) return null;
  const results: SearchResult[] = [], seen = new Set<string>();
  for (const entry of value.results) {
    const result = parseResult(entry);
    if (!result) return null;
    const key = result.item ? `item:${result.item.id}` : `source:${result.sourceId}`;
    if (seen.has(key)) return null;
    seen.add(key); results.push(result);
  }
  return { engineVersion: SEARCH_ENGINE_VERSION, results, hasMore: value.hasMore, aliasExpansionTruncated: value.aliasExpansionTruncated };
}
