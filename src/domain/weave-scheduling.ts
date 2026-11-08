import { RunForbiddenError, type RunRecord } from "./run";
import type { WeaveIntent } from "./run-operations";
import type { SharedResponse } from "./shared-response";
import type { MaterialKind, Thought } from "./thought";
import { nonEmpty } from "./validation";
import { isReinterpretationTrigger } from "./reinterpretation";

export type WeavePurpose = "ordinary" | "media-title-only" | "reinterpretation";
const titleClearPrefix = "title-clear:";

/** An explicit title clear never schedules a new source interpretation. */
export function resolveWeavePurpose(kind: MaterialKind, triggerId: string): WeavePurpose {
  if (isReinterpretationTrigger(triggerId)) return "reinterpretation";
  if (kind !== "media-original") return "ordinary";
  if (triggerId.startsWith(titleClearPrefix) && triggerId.slice(titleClearPrefix.length).trim().length > 0) return "media-title-only";
  return "ordinary";
}

/** Apply before effects and before returning any retained result or receipt. */
export function assertWeaveCapability(purpose: WeavePurpose, capability: string): void {
  if (purpose === "media-title-only" && capability !== "title-fill") throw new RunForbiddenError("Media title regeneration permits only title fill and completion");
}

/** Semantic triggers, never inferred from text similarity, current time, or a corpus sweep. */
export function captureWeaveIntent(thought: Thought): WeaveIntent | null {
  if (thought.author !== "user" || thought.kind !== "captured-original" || thought.origin !== "capture" || thought.parentId !== null || thought.sourceIds.length !== 0) return null;
  return {subjectId:thought.id,triggerId:`capture:${thought.id}`};
}

/** Every explicit user clear is a new invitation, including clearing an already absent title. */
export function titleClearWeaveIntent(subjectId: string, invitationId: string): WeaveIntent {
  return {subjectId:nonEmpty(subjectId,"subjectId"),triggerId:`${titleClearPrefix}${nonEmpty(invitationId,"invitationId")}`};
}

/** Called only after the canonical reply's issued-order associations and current eligibility are checked. */
export function evolveWeaveIntent(run: RunRecord, response: SharedResponse, issued: readonly string[]): WeaveIntent | null {
  if (run.kind !== "evolve" || response.state !== "complete") return null;
  const subjectId = issued.at(-1) ?? run.inputThoughtId;
  return subjectId === null ? null : {subjectId,triggerId:`evolve:${run.id}`};
}
