import { isRecordId, parseSourceRecord } from "./inspection";
import type { Source } from "./index";
import { isWeavingJobStatus, type WeavingJobStatus } from "./weaving";
import { parseDialogueContext, parseDialogueSelection, type DialogueSelectedContext, type DialogueSelection } from "./dialogue-context";
export * from "./dialogue-context";

export const DIALOGUE_LIMITS = { turnText: 32_000, turns: 100, evidenceSources: 32, pastTurns: 4, pastCharacters: 16_000 } as const;
export type DialogueInput = { selection: DialogueSelection };
export type DialogueTurnInput = { text: string };
export type DialogueTurnReceipt = { id: string; dialogueId: string; sourceId: string; jobId: string; createdAt: string; status: "queued" };
export type DialogueStopInput = { expectedRunId: string | null };
export type DialogueStopReceipt = DialogueStopInput & { id: string; dialogueId: string; turnId: string; status: "stop_requested"; createdAt: string };
export type DialogueTurnActions = { stop: { eligible: boolean; expectedRunId: string | null }; retry: false };
export type DialogueChange = { kind: "interpretation" | "developing-idea" | "relationship" | "alias"; id: string; versionId?: string };
export type DialogueTurnView = { id: string; jobId: string; source: Source; createdAt: string; status: WeavingJobStatus; changes: DialogueChange[]; assistant?: { text: string }; outcome?: "succeeded" | "failed" | "interrupted";
  stopRequested?: boolean; actions?: DialogueTurnActions };
export type DialogueView = { id: string; sourceId: string; selection: DialogueSelection; selectedContext: DialogueSelectedContext;
  createdAt: string; turns: DialogueTurnView[]; turnsTruncated: boolean };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function date(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
export function parseDialogueInput(value: unknown): DialogueInput | null {
  if (!record(value) || Object.keys(value).length !== 1) return null;
  const selection = parseDialogueSelection(value.selection);
  return selection ? { selection } : null;
}
export function parseDialogueTurnInput(value: unknown): DialogueTurnInput | null {
  return record(value) && Object.keys(value).length === 1 && text(value.text) && value.text.length <= DIALOGUE_LIMITS.turnText ? { text: value.text } : null;
}
export function parseDialogueTurnReceipt(value: unknown): DialogueTurnReceipt | null {
  if (!record(value) || !isRecordId(value.id) || !isRecordId(value.dialogueId) || !isRecordId(value.sourceId) || !isRecordId(value.jobId) || !date(value.createdAt) || value.status !== "queued") return null;
  return { id: value.id, dialogueId: value.dialogueId, sourceId: value.sourceId, jobId: value.jobId, createdAt: value.createdAt, status: "queued" };
}
export function parseDialogueStopInput(value: unknown): DialogueStopInput | null {
  return record(value) && Object.keys(value).length === 1 && (value.expectedRunId === null || isRecordId(value.expectedRunId))
    ? { expectedRunId: value.expectedRunId } : null;
}
export function parseDialogueStopReceipt(value: unknown): DialogueStopReceipt | null {
  return record(value) && isRecordId(value.id) && isRecordId(value.dialogueId) && isRecordId(value.turnId) && date(value.createdAt) &&
    value.status === "stop_requested" && (value.expectedRunId === null || isRecordId(value.expectedRunId))
    ? { id: value.id, dialogueId: value.dialogueId, turnId: value.turnId, createdAt: value.createdAt, expectedRunId: value.expectedRunId, status: "stop_requested" } : null;
}
function actions(value: unknown): DialogueTurnActions | null {
  if (!record(value) || value.retry !== false || !record(value.stop) || typeof value.stop.eligible !== "boolean" ||
      (value.stop.expectedRunId !== null && !isRecordId(value.stop.expectedRunId))) return null;
  return { stop: { eligible: value.stop.eligible, expectedRunId: value.stop.expectedRunId }, retry: false };
}
export function parseDialogueView(value: unknown): DialogueView | null {
  if (!record(value) || !isRecordId(value.id) || !isRecordId(value.sourceId) || !date(value.createdAt) || typeof value.turnsTruncated !== "boolean") return null;
  const selection = parseDialogueSelection(value.selection);
  const selectedContext = selection ? parseDialogueContext(selection, value.selectedContext) : null;
  if (!selection || !selectedContext || (selection.kind === "source" && selection.id !== value.sourceId) || !Array.isArray(value.turns) || value.turns.length > DIALOGUE_LIMITS.turns) return null;
  if (selectedContext.kind === "relationship" && selectedContext.from.sourceId !== value.sourceId && selectedContext.to.sourceId !== value.sourceId) return null;
  const turns: DialogueTurnView[] = [];
  for (const entry of value.turns) {
    if (!record(entry) || !isRecordId(entry.id) || !isRecordId(entry.jobId) || !date(entry.createdAt) || !isWeavingJobStatus(entry.status)) return null;
    const source = parseSourceRecord(entry.source);
    if (!source || source.provenance !== "discussion-turn" || source.createdAt !== entry.createdAt || source.id === value.sourceId) return null;
    const changes = parseDialogueChanges(entry.changes);
    if (!changes || (entry.assistant !== undefined && (!record(entry.assistant) || typeof entry.assistant.text !== "string")) ||
        (entry.outcome !== undefined && entry.outcome !== "succeeded" && entry.outcome !== "failed" && entry.outcome !== "interrupted")) return null;
    if (entry.outcome === "succeeded" && (!record(entry.assistant) || entry.status !== "completed")) return null;
    const turnActions = entry.actions === undefined ? undefined : actions(entry.actions);
    if (turnActions === null || (entry.stopRequested !== undefined && typeof entry.stopRequested !== "boolean") ||
        (turnActions?.stop.eligible && (entry.stopRequested || !["queued", "running", "uncertain"].includes(entry.status)))) return null;
    turns.push({ id: entry.id, jobId: entry.jobId, source, createdAt: entry.createdAt, status: entry.status, changes,
      ...(typeof entry.stopRequested === "boolean" ? { stopRequested: entry.stopRequested } : {}), ...(turnActions ? { actions: turnActions } : {}),
      ...(record(entry.assistant) && typeof entry.assistant.text === "string" ? { assistant: { text: entry.assistant.text } } : {}), ...(entry.outcome ? { outcome: entry.outcome } : {}) });
  }
  for (const key of ["id", "jobId"] as const) if (new Set(turns.map((turn) => turn[key])).size !== turns.length) return null;
  if (new Set(turns.map((turn) => turn.source.id)).size !== turns.length) return null;
  return { id: value.id, sourceId: value.sourceId, selection, selectedContext,
    createdAt: value.createdAt, turns, turnsTruncated: value.turnsTruncated };
}
export function parseDialogueChanges(value: unknown): DialogueChange[] | null {
  if (!Array.isArray(value)) return null;
  const result: DialogueChange[] = [];
  for (const entry of value) {
    if (!record(entry) || !isRecordId(entry.id) || (entry.kind !== "interpretation" && entry.kind !== "developing-idea" && entry.kind !== "relationship" && entry.kind !== "alias") || (entry.kind !== "alias" && !isRecordId(entry.versionId))) return null;
    result.push({ id: entry.id, kind: entry.kind, ...(isRecordId(entry.versionId) ? { versionId: entry.versionId } : {}) });
  }
  return result;
}
