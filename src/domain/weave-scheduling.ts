import type { RunRecord } from "./run";
import type { WeaveIntent } from "./run-operations";
import type { SharedResponse } from "./shared-response";
import type { Thought } from "./thought";
import { nonEmpty } from "./validation";

/** Semantic triggers, never inferred from text similarity, current time, or a corpus sweep. */
export function captureWeaveIntent(thought: Thought): WeaveIntent | null {
  if (thought.author !== "user" || thought.kind !== "captured-original" || thought.origin !== "capture" || thought.parentId !== null || thought.sourceIds.length !== 0) return null;
  return {subjectId:thought.id,triggerId:`capture:${thought.id}`};
}

/** Every explicit user clear is a new invitation, including clearing an already absent title. */
export function titleClearWeaveIntent(subjectId: string, invitationId: string): WeaveIntent {
  return {subjectId:nonEmpty(subjectId,"subjectId"),triggerId:`title-clear:${nonEmpty(invitationId,"invitationId")}`};
}

/** Called only after the canonical reply's issued-order associations and current eligibility are checked. */
export function evolveWeaveIntent(run: RunRecord, response: SharedResponse, issued: readonly string[]): WeaveIntent | null {
  if (run.kind !== "evolve" || response.state !== "complete") return null;
  const subjectId = issued.at(-1) ?? run.inputThoughtId;
  return subjectId === null ? null : {subjectId,triggerId:`evolve:${run.id}`};
}
