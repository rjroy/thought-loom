import { isRecordId } from "./inspection";
export type RelationshipRejectInput = { expectedVersionId: string; rationale: string; evidenceSourceIds: string[] };
export type RelationshipRestoreInput = { expectedVersionId: string; restoreVersionId: string };
export type ItemCorrectionInput = { expectedVersionId: string; sourceId: string; text: string };
export type ItemRestoreInput = RelationshipRestoreInput;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function parseRelationshipRejectInput(value: unknown): RelationshipRejectInput | null {
  if (!record(value) || Object.keys(value).length !== 3 || !isRecordId(value.expectedVersionId) || typeof value.rationale !== "string" || !value.rationale.trim() || value.rationale.length > 32_000 ||
      !Array.isArray(value.evidenceSourceIds) || !value.evidenceSourceIds.length || value.evidenceSourceIds.length > 32 || !value.evidenceSourceIds.every(isRecordId) || new Set(value.evidenceSourceIds).size !== value.evidenceSourceIds.length) return null;
  return { expectedVersionId: value.expectedVersionId, rationale: value.rationale, evidenceSourceIds: [...value.evidenceSourceIds] };
}
export function parseRelationshipRestoreInput(value: unknown): RelationshipRestoreInput | null {
  return record(value) && Object.keys(value).length === 2 && isRecordId(value.expectedVersionId) && isRecordId(value.restoreVersionId)
    ? { expectedVersionId: value.expectedVersionId, restoreVersionId: value.restoreVersionId } : null;
}
export function parseItemCorrectionInput(value: unknown): ItemCorrectionInput | null {
  return record(value) && Object.keys(value).length === 3 && isRecordId(value.expectedVersionId) && isRecordId(value.sourceId) &&
    typeof value.text === "string" && value.text.trim().length > 0 && value.text.length <= 32_000
    ? { expectedVersionId: value.expectedVersionId, sourceId: value.sourceId, text: value.text } : null;
}
export const parseItemRestoreInput = parseRelationshipRestoreInput;
