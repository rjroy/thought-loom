import type { SearchResult, Source } from "./index";

export const INQUIRY_LIMITS = { rootItems: 64, relationships: 64, history: 32, evidencePerVersion: 32, evidenceSources: 512 } as const;
export type FormulationView = { id: string; text: string; author: "user" | "ai"; evidenceSourceIds: string[] };
export type ItemView = { id: string; sourceId: string; kind: "interpretation" | "developing-idea"; current: FormulationView; history: FormulationView[]; historyTruncated: boolean };
export type RelationshipVersionView = { id: string; status: "active" | "rejected"; rationale: string; author: "user" | "ai"; evidenceSourceIds: string[] };
export type RelationshipView = { id: string; fromItemId: string; toItemId: string; type: "supports" | "challenges" | "suggests"; current: RelationshipVersionView; history: RelationshipVersionView[]; historyTruncated: boolean };
export type EvidenceSource = { id: string; excerpt: string; provenance: string; createdAt: string };
export type InquiryView = { source: Source; items: ItemView[]; relationships: RelationshipView[]; evidenceSources: EvidenceSource[]; truncated: boolean };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
export function isRecordId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(value); }
export function isIdempotencyKey(value: unknown): value is string { return isRecordId(value); }
function date(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function author(value: unknown): value is "user" | "ai" { return value === "user" || value === "ai"; }
function list<T>(value: unknown, parse: (entry: unknown) => T | null, maximum: number): T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const entries: T[] = [];
  for (const entry of value) { const parsed = parse(entry); if (parsed === null) return null; entries.push(parsed); }
  return entries;
}
function evidence(value: unknown): string[] | null {
  const ids = list(value, (id) => isRecordId(id) ? id : null, INQUIRY_LIMITS.evidencePerVersion);
  return ids && ids.length > 0 && new Set(ids).size === ids.length ? ids : null;
}
export function parseSourceRecord(value: unknown): Source | null {
  if (!record(value) || !isRecordId(value.id) || !text(value.text) || !text(value.provenance) || !date(value.createdAt)) return null;
  return { id: value.id, text: value.text, provenance: value.provenance, createdAt: value.createdAt };
}
function sourceReference(value: unknown): EvidenceSource | null {
  if (!record(value) || !isRecordId(value.id) || typeof value.excerpt !== "string" || !text(value.provenance) || !date(value.createdAt)) return null;
  return { id: value.id, excerpt: value.excerpt, provenance: value.provenance, createdAt: value.createdAt };
}
function formulation(value: unknown): FormulationView | null {
  if (!record(value) || !isRecordId(value.id) || !text(value.text) || !author(value.author)) return null;
  const ids = evidence(value.evidenceSourceIds);
  return ids ? { id: value.id, text: value.text, author: value.author, evidenceSourceIds: ids } : null;
}
function relationshipVersion(value: unknown): RelationshipVersionView | null {
  if (!record(value) || !isRecordId(value.id) || !text(value.rationale) || !author(value.author) || (value.status !== "active" && value.status !== "rejected")) return null;
  const ids = evidence(value.evidenceSourceIds);
  return ids ? { id: value.id, status: value.status, rationale: value.rationale, author: value.author, evidenceSourceIds: ids } : null;
}
function validHistory<T extends { id: string }>(current: T, history: T[]): boolean {
  return history.length > 0 && new Set(history.map((entry) => entry.id)).size === history.length && JSON.stringify(current) === JSON.stringify(history.at(-1));
}
function item(value: unknown): ItemView | null {
  if (!record(value) || !isRecordId(value.id) || !isRecordId(value.sourceId) || (value.kind !== "interpretation" && value.kind !== "developing-idea") || typeof value.historyTruncated !== "boolean") return null;
  const current = formulation(value.current), history = list(value.history, formulation, INQUIRY_LIMITS.history);
  if (!current || !history || !validHistory(current, history)) return null;
  return { id: value.id, sourceId: value.sourceId, kind: value.kind, current, history, historyTruncated: value.historyTruncated };
}
function relationship(value: unknown): RelationshipView | null {
  if (!record(value) || !isRecordId(value.id) || !isRecordId(value.fromItemId) || !isRecordId(value.toItemId) || value.fromItemId === value.toItemId || typeof value.historyTruncated !== "boolean") return null;
  const type = value.type;
  if (type !== "supports" && type !== "challenges" && type !== "suggests") return null;
  const current = relationshipVersion(value.current), history = list(value.history, relationshipVersion, INQUIRY_LIMITS.history);
  if (!current || !history || !validHistory(current, history)) return null;
  return { id: value.id, fromItemId: value.fromItemId, toItemId: value.toItemId, type, current, history, historyTruncated: value.historyTruncated };
}

export function parseInquiryView(value: unknown): InquiryView | null {
  if (!record(value) || typeof value.truncated !== "boolean") return null;
  const source = parseSourceRecord(value.source);
  const items = list(value.items, item, INQUIRY_LIMITS.rootItems + INQUIRY_LIMITS.relationships);
  const relationships = list(value.relationships, relationship, INQUIRY_LIMITS.relationships);
  const evidenceSources = list(value.evidenceSources, sourceReference, INQUIRY_LIMITS.evidenceSources);
  if (!source || !items || !relationships || !evidenceSources) return null;
  const itemIds = new Set(items.map((entry) => entry.id)), refIds = new Set(evidenceSources.map((entry) => entry.id));
  if (itemIds.size !== items.length || refIds.size !== evidenceSources.length || new Set(relationships.map((entry) => entry.id)).size !== relationships.length) return null;
  const roots = new Set(items.filter((entry) => entry.sourceId === source.id).map((entry) => entry.id));
  const endpoints = new Set<string>();
  for (const relation of relationships) {
    if (!itemIds.has(relation.fromItemId) || !itemIds.has(relation.toItemId) || (!roots.has(relation.fromItemId) && !roots.has(relation.toItemId))) return null;
    endpoints.add(relation.fromItemId); endpoints.add(relation.toItemId);
  }
  const needed = new Set([source.id]);
  for (const entry of items) {
    if (entry.sourceId !== source.id && !endpoints.has(entry.id)) return null;
    needed.add(entry.sourceId);
    for (const revision of entry.history) for (const id of revision.evidenceSourceIds) needed.add(id);
  }
  for (const entry of relationships) for (const revision of entry.history) for (const id of revision.evidenceSourceIds) needed.add(id);
  if (needed.size !== refIds.size || [...needed].some((id) => !refIds.has(id))) return null;
  const rootRef = evidenceSources.find((entry) => entry.id === source.id);
  if (!rootRef || rootRef.provenance !== source.provenance || rootRef.createdAt !== source.createdAt) return null;
  return { source, items, relationships, evidenceSources, truncated: value.truncated };
}

function searchResult(value: unknown): SearchResult | null {
  if (!record(value) || !isRecordId(value.sourceId) || !record(value.source) || typeof value.source.excerpt !== "string" || !text(value.source.provenance) || !date(value.source.createdAt)) return null;
  if (value.matchOrigin !== "source" && value.matchOrigin !== "interpretation" && value.matchOrigin !== "alias") return null;
  let foundItem: SearchResult["item"];
  if (value.item !== undefined) {
    const entry = value.item;
    if (!record(entry) || !isRecordId(entry.id) || !isRecordId(entry.formulationId) || !text(entry.text) || !author(entry.author) || (entry.kind !== "interpretation" && entry.kind !== "developing-idea")) return null;
    foundItem = { id: entry.id, kind: entry.kind, formulationId: entry.formulationId, text: entry.text, author: entry.author };
  }
  if (value.matchOrigin === "interpretation" && !foundItem) return null;
  return { sourceId: value.sourceId, matchOrigin: value.matchOrigin, source: { excerpt: value.source.excerpt, provenance: value.source.provenance, createdAt: value.source.createdAt }, ...(foundItem ? { item: foundItem } : {}) };
}
export function parseSearchResponse(value: unknown): { results: SearchResult[] } | null {
  if (!record(value)) return null;
  const results = list(value.results, searchResult, 200);
  return results ? { results } : null;
}
