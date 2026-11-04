import { record, thought } from "../idea/validation";
import type { AdmissionSnapshot, EvolveReceipt, EvolveRun } from "./types";

export function validRun(value: unknown, id?: string): value is EvolveRun {
  if (!record(value) || typeof value.id !== "string" || !value.id.trim() || (id !== undefined && value.id !== id)
      || value.kind !== "evolve" || !["queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"].includes(String(value.status))
      || !Array.isArray(value.confirmedThoughtIds) || !value.confirmedThoughtIds.every(item => typeof item === "string" && !!item.trim())
      || new Set(value.confirmedThoughtIds).size !== value.confirmedThoughtIds.length
      || !(value.responseId === null || (typeof value.responseId === "string" && !!value.responseId.trim()))) return false;
  return true;
}
export function validReceipt(value: unknown, snapshot: AdmissionSnapshot): value is EvolveReceipt {
  if (!record(value) || !thought(value.contribution) || !validRun(value.run)) return false;
  const item = value.contribution;
  return item.parentId === snapshot.thoughtId && item.text === snapshot.text && item.author === "user"
    && item.kind === "user-contribution" && item.origin === "contribution" && item.rejected !== true;
}
export function publicRun(run: EvolveRun): EvolveRun {
  return { id: run.id, kind: run.kind, status: run.status, confirmedThoughtIds: [...run.confirmedThoughtIds], responseId: run.responseId };
}
