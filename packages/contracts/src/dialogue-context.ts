import { isRecordId, parseFormulationView, parseSourceRecord, type FormulationView } from "./inspection";
import type { Source } from "./index";

export type DialogueSelection = { kind: "source"; id: string } | { kind: "item"; id: string; versionId: string } |
  { kind: "relationship"; id: string; versionId: string; fromVersionId: string; toVersionId: string };
export type EndpointSnapshot = { id: string; sourceId: string; version: FormulationView };
export type DialogueSelectedContext = ({ kind: "source" } & Source) | ({ kind: "item" } & FormulationView) |
  { kind: "relationship"; id: string; fromItemId: string; toItemId: string; type: "supports" | "challenges" | "suggests";
    rationale: string; status: "active" | "rejected"; author: "user" | "ai"; evidenceSourceIds: string[]; from: EndpointSnapshot; to: EndpointSnapshot };
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function parseDialogueSelection(value: unknown): DialogueSelection | null {
  if (!record(value) || !isRecordId(value.id)) return null;
  if (value.kind === "source" && Object.keys(value).length === 2) return { kind: "source", id: value.id };
  if (!isRecordId(value.versionId)) return null;
  if (value.kind === "item" && Object.keys(value).length === 3) return { kind: "item", id: value.id, versionId: value.versionId };
  return value.kind === "relationship" && Object.keys(value).length === 5 && isRecordId(value.fromVersionId) && isRecordId(value.toVersionId)
    ? { kind: "relationship", id: value.id, versionId: value.versionId, fromVersionId: value.fromVersionId, toVersionId: value.toVersionId } : null;
}
function endpoint(value: unknown): EndpointSnapshot | null {
  if (!record(value) || !isRecordId(value.id) || !isRecordId(value.sourceId)) return null;
  const version = parseFormulationView(value.version);
  return version ? { id: value.id, sourceId: value.sourceId, version } : null;
}
export function parseDialogueContext(selection: DialogueSelection, value: unknown): DialogueSelectedContext | null {
  if (!record(value)) return null;
  if (selection.kind === "source") {
    const source = parseSourceRecord(value);
    return source?.id === selection.id ? { ...source, kind: "source" } : null;
  }
  if (selection.kind === "item") {
    const version = parseFormulationView(value);
    return version?.id === selection.versionId ? { ...version, kind: "item" } : null;
  }
  const from = endpoint(value.from), to = endpoint(value.to);
  if (!from || !to || from.id === to.id || from.id !== value.fromItemId || to.id !== value.toItemId || from.version.id !== selection.fromVersionId || to.version.id !== selection.toVersionId || value.id !== selection.versionId ||
      (value.type !== "supports" && value.type !== "challenges" && value.type !== "suggests") || (value.status !== "active" && value.status !== "rejected") || (value.author !== "user" && value.author !== "ai") || typeof value.rationale !== "string" || !value.rationale.trim() ||
      !Array.isArray(value.evidenceSourceIds) || value.evidenceSourceIds.length < 1 || value.evidenceSourceIds.length > 32 || !value.evidenceSourceIds.every(isRecordId) || new Set(value.evidenceSourceIds).size !== value.evidenceSourceIds.length) return null;
  return { kind: "relationship", id: selection.versionId, fromItemId: from.id, toItemId: to.id, type: value.type, status: value.status, author: value.author,
    rationale: value.rationale, evidenceSourceIds: [...value.evidenceSourceIds], from, to };
}
