import type { Source, SourceOrigin, ThoughtTitle } from "./index";
import type { IdeaDerivation } from "./tools";

export const INQUIRY_LIMITS = { rootItems: 64, relationships: 64, history: 32, evidencePerVersion: 32, evidenceSources: 512 } as const;
// Receipt-backed display provenance, not authority to act on this job or source.
export type FollowUpVersionOrigin = { jobId: string; sourceId: string };
export type FormulationView = { id: string; text: string; author: "user" | "ai"; evidenceSourceIds: string[]; followUp?: FollowUpVersionOrigin };
export type ItemView = { id: string; sourceId: string; kind: "interpretation" | "developing-idea"; current: FormulationView; history: FormulationView[]; historyTruncated: boolean; derivation?: IdeaDerivation; title?: ThoughtTitle };
export type RelationshipVersionView = { id: string; status: "active" | "rejected"; rationale: string; author: "user" | "ai"; evidenceSourceIds: string[]; followUp?: FollowUpVersionOrigin };
export type RelationshipView = { id: string; fromItemId: string; toItemId: string; type: "supports" | "challenges" | "suggests"; current: RelationshipVersionView; history: RelationshipVersionView[]; historyTruncated: boolean };
export type EvidenceSource = { id: string; excerpt: string; provenance: string; createdAt: string; origin?: SourceOrigin };
export type InquirySelectedTarget = { kind: "item"; id: string; versionId: string; text: string; author: "user" | "ai"; evidenceSourceIds: string[]; title?: ThoughtTitle };
export type InquiryView = { source: Source; items: ItemView[]; relationships: RelationshipView[]; evidenceSources: EvidenceSource[]; truncated: boolean; selectedTarget?: InquirySelectedTarget };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
export function isRecordId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(value); }
export function isIdempotencyKey(value: unknown): value is string { return isRecordId(value); }
function date(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function author(value: unknown): value is "user" | "ai" { return value === "user" || value === "ai"; }
export function isThoughtTitleText(value: unknown): value is string {
  // In Unicode mode the surrogate range matches only unpaired UTF-16 code units;
  // well-formed supplementary characters are matched as their full code point.
  return typeof value === "string" && !!value.trim() && value.length <= 240 && !/[\u0000-\u001f\u007f\u2028\u2029\uD800-\uDFFF]/u.test(value);
}
export function parseThoughtTitle(value: unknown): ThoughtTitle | null {
  return record(value) && isRecordId(value.revisionId) && isThoughtTitleText(value.text) && author(value.author)
    ? { revisionId: value.revisionId, text: value.text, author: value.author } : null;
}
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
  const origin = value.origin === undefined ? undefined : parseSourceOrigin(value.origin);
  const title = value.title === undefined ? undefined : parseThoughtTitle(value.title);
  if (origin === null || title === null) return null;
  return { id: value.id, text: value.text, provenance: value.provenance, createdAt: value.createdAt, ...(origin ? { origin } : {}), ...(title ? { title } : {}) };
}
export function parseSourceOrigin(value: unknown): SourceOrigin | null {
  if (!record(value)) return null;
  if (value.kind === "capture") return { kind: "capture" };
  return value.kind === "discussion-turn" && isRecordId(value.dialogueId) && isRecordId(value.turnId) && isRecordId(value.rootSourceId)
    ? { kind: "discussion-turn", dialogueId: value.dialogueId, turnId: value.turnId, rootSourceId: value.rootSourceId } : null;
}
export function parseIdeaDerivation(value: unknown): IdeaDerivation | null {
  if (!record(value) || !isRecordId(value.dialogueId) || !isRecordId(value.turnId) || !isRecordId(value.turnSourceId)) return null;
  if ((value.itemId !== undefined || value.versionId !== undefined) && (!isRecordId(value.itemId) || !isRecordId(value.versionId))) return null;
  return { dialogueId: value.dialogueId, turnId: value.turnId, turnSourceId: value.turnSourceId,
    ...(isRecordId(value.itemId) && isRecordId(value.versionId) ? { itemId: value.itemId, versionId: value.versionId } : {}) };
}
function sourceReference(value: unknown): EvidenceSource | null {
  if (!record(value) || !isRecordId(value.id) || typeof value.excerpt !== "string" || !text(value.provenance) || !date(value.createdAt)) return null;
  const origin = value.origin === undefined ? undefined : parseSourceOrigin(value.origin);
  if (origin === null) return null;
  return { id: value.id, excerpt: value.excerpt, provenance: value.provenance, createdAt: value.createdAt, ...(origin ? { origin } : {}) };
}
export function parseFormulationView(value: unknown): FormulationView | null {
  if (!record(value) || !isRecordId(value.id) || !text(value.text) || !author(value.author)) return null;
  const ids = evidence(value.evidenceSourceIds);
  const followUp = value.followUp === undefined ? undefined : followUpOrigin(value.followUp);
  return ids && followUp !== null && (!followUp || value.author === "ai") ? { id: value.id, text: value.text, author: value.author, evidenceSourceIds: ids, ...(followUp ? { followUp } : {}) } : null;
}
function followUpOrigin(value: unknown): FollowUpVersionOrigin | null {
  return record(value) && isRecordId(value.jobId) && isRecordId(value.sourceId) ? { jobId: value.jobId, sourceId: value.sourceId } : null;
}
function relationshipVersion(value: unknown): RelationshipVersionView | null {
  if (!record(value) || !isRecordId(value.id) || !text(value.rationale) || !author(value.author) || (value.status !== "active" && value.status !== "rejected")) return null;
  const ids = evidence(value.evidenceSourceIds);
  const followUp = value.followUp === undefined ? undefined : followUpOrigin(value.followUp);
  return ids && followUp !== null && (!followUp || value.author === "ai") ? { id: value.id, status: value.status, rationale: value.rationale, author: value.author, evidenceSourceIds: ids, ...(followUp ? { followUp } : {}) } : null;
}
function validHistory<T extends { id: string }>(current: T, history: T[]): boolean {
  return history.length > 0 && new Set(history.map((entry) => entry.id)).size === history.length && JSON.stringify(current) === JSON.stringify(history.at(-1));
}
export function parseItemView(value: unknown): ItemView | null {
  if (!record(value) || !isRecordId(value.id) || !isRecordId(value.sourceId) || (value.kind !== "interpretation" && value.kind !== "developing-idea") || typeof value.historyTruncated !== "boolean") return null;
  const current = parseFormulationView(value.current), history = list(value.history, parseFormulationView, INQUIRY_LIMITS.history);
  if (!current || !history || !validHistory(current, history)) return null;
  const derivation = value.derivation === undefined ? undefined : parseIdeaDerivation(value.derivation);
  const title = value.title === undefined ? undefined : parseThoughtTitle(value.title);
  if (derivation === null || title === null) return null;
  return { id: value.id, sourceId: value.sourceId, kind: value.kind, current, history, historyTruncated: value.historyTruncated, ...(derivation ? { derivation } : {}), ...(title ? { title } : {}) };
}
export function parseRelationshipView(value: unknown): RelationshipView | null {
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
  const items = list(value.items, parseItemView, INQUIRY_LIMITS.rootItems + INQUIRY_LIMITS.relationships);
  const relationships = list(value.relationships, parseRelationshipView, INQUIRY_LIMITS.relationships);
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
  let selectedTarget: InquirySelectedTarget | undefined;
  if (value.selectedTarget !== undefined) {
    const target = value.selectedTarget;
    if (!record(target) || target.kind !== "item" || !isRecordId(target.id) || !isRecordId(target.versionId) || !text(target.text) || !author(target.author)) return null;
    const ids = evidence(target.evidenceSourceIds);
    const item = items.find((entry) => entry.id === target.id && entry.sourceId === source.id);
    const version = item?.history.find((entry) => entry.id === target.versionId);
    if (!ids || !version || version.text !== target.text || version.author !== target.author || JSON.stringify(version.evidenceSourceIds) !== JSON.stringify(ids)) return null;
    const title = target.title === undefined ? undefined : parseThoughtTitle(target.title);
    if (title === null) return null;
    selectedTarget = { kind: "item", id: target.id, versionId: target.versionId, text: target.text, author: target.author, evidenceSourceIds: ids, ...(title ? { title } : {}) };
  }
  return { source, items, relationships, evidenceSources, truncated: value.truncated, ...(selectedTarget ? { selectedTarget } : {}) };
}
