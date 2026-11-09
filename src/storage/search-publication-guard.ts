import type { Database } from "bun:sqlite";
import { RunConflictError, RunFenceError, RunForbiddenError, type Claim, type ContextRef } from "../domain/run";
import { searchRevision, searchString } from "../domain/agentic-search";
import { record, ValidationError } from "../domain/validation";
import { searchReferencesEligible } from "./search-eligibility";
import { assertRunNotRestoreFenced } from "./restore-fences";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
export interface SearchPublicationOwner {
  readonly runId: string; readonly sessionId: string; readonly generation: number; readonly currentPromptId: string;
  readonly promptId: string; readonly state: string; readonly input: string; readonly envelopeJson: string; readonly resultJson: string | null;
  readonly exposures: readonly ContextRef[];
}
interface OwnerRow {
  readonly runId: string; readonly kind: string; readonly sessionId: string; readonly generation: number; readonly status: string;
  readonly openSlot: number; readonly deletedAt: string | null; readonly cancellation: string; readonly inputThoughtId: string | null;
  readonly weaveSubjectId: string | null; readonly weaveTriggerId: string | null;
  readonly bindingSessionId: string | null; readonly protocolVersion: number | null; readonly currentPromptId: string | null;
}
interface StepRow { readonly promptId: string; readonly state: string; readonly input: string | null; readonly nativeState: string;
  readonly envelopeJson: string | null; readonly resultJson: string | null }

/** Read proof from the existing aggregate; never infer a binding, native completion or full read. */
export function searchPublicationOwner(db: Database, claim: Claim, promptId: string): SearchPublicationOwner {
  const data = record(claim);
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data, "runId") || !Object.hasOwn(data, "generation")) throw new ValidationError("Invalid publication claim");
  searchString(claim.runId, "runId"); searchRevision(claim.generation); searchString(promptId, "promptId");
  assertRunNotRestoreFenced(db,claim.runId);
  const row = db.query(`SELECT r.id AS runId,r.kind,t.session_id AS sessionId,r.generation,r.status,t.open_slot AS openSlot,s.deleted_at AS deletedAt,
    r.cancellation_state AS cancellation,r.input_thought_id AS inputThoughtId,r.weave_subject_id AS weaveSubjectId,r.weave_trigger_id AS weaveTriggerId,
    b.session_id AS bindingSessionId,b.protocol_version AS protocolVersion,
    (SELECT prompt_id FROM run_steps WHERE run_id=r.id ORDER BY position DESC LIMIT 1) AS currentPromptId
    FROM runs r JOIN search_turns t ON t.run_id=r.id JOIN search_sessions s ON s.id=t.session_id
    JOIN search_messages u ON u.run_id=r.id AND u.session_id=t.session_id AND u.role='user'
    LEFT JOIN agent_bindings b ON b.run_id=r.id WHERE r.id=CAST(? AS TEXT)`).get(text(claim.runId)) as OwnerRow | null;
  if (!row || row.deletedAt !== null || row.generation !== claim.generation || row.openSlot !== 1 || row.cancellation !== "none" ||
      !["queued", "submitting", "running", "uncertain"].includes(row.status)) throw new RunFenceError("Search publication authority is no longer active");
  if (row.kind !== "search" || row.inputThoughtId !== null || row.weaveSubjectId !== null || row.weaveTriggerId !== null ||
      !row.bindingSessionId?.trim() || row.protocolVersion !== 1) throw new RunForbiddenError("Bound search publication authority required");
  const contaminated = db.query(`SELECT 1 FROM run_operation_receipts WHERE run_id=CAST(? AS TEXT)
    UNION ALL SELECT 1 FROM run_issued_thoughts WHERE run_id=CAST(? AS TEXT)
    UNION ALL SELECT 1 FROM run_replies WHERE run_id=CAST(? AS TEXT) LIMIT 1`).get(text(row.runId), text(row.runId), text(row.runId));
  if (contaminated) throw new RunForbiddenError("Search cannot publish library knowledge");
  const invalidJournal = db.query(`SELECT 1 FROM run_steps earlier JOIN run_steps current ON current.run_id=earlier.run_id
    WHERE current.run_id=CAST(? AS TEXT) AND current.prompt_id=CAST(? AS TEXT) AND earlier.position<current.position
      AND (earlier.state!='processed' OR earlier.input IS NULL) LIMIT 1`).get(text(row.runId), text(row.currentPromptId ?? ""));
  if (invalidJournal) throw new RunConflictError("Search prompt predecessors are not durably processed");
  const step = db.query(`SELECT prompt_id AS promptId,state,input,native_state AS nativeState,envelope_json AS envelopeJson,result_json AS resultJson
    FROM run_steps WHERE run_id=CAST(? AS TEXT) AND prompt_id=CAST(? AS TEXT)`).get(text(row.runId), text(promptId)) as StepRow | null;
  if (!step || step.input === null || !step.input.trim() || step.envelopeJson === null || step.nativeState !== "completed" ||
      !["completed", "processed"].includes(step.state) || row.currentPromptId === null) throw new RunConflictError("Completed owned native prompt required");
  const exposures = db.query("SELECT kind,ref_id AS id FROM run_context WHERE run_id=CAST(? AS TEXT) ORDER BY rowid").all(text(row.runId)) as ContextRef[];
  return { runId: row.runId, sessionId: row.sessionId, generation: row.generation, currentPromptId: row.currentPromptId,
    promptId: step.promptId, state: step.state, input: step.input, envelopeJson: step.envelopeJson, resultJson: step.resultJson, exposures };
}
export function requireCurrentSearchPublication(owner: SearchPublicationOwner): void {
  if (owner.promptId !== owner.currentPromptId || owner.state !== "completed") throw new RunFenceError("Search publication prompt is no longer current");
}
export function requireSearchFullReads(db: Database, owner: SearchPublicationOwner, ids: readonly string[]): void {
  for (const id of new Set(ids)) {
    if (!db.query("SELECT 1 FROM run_context WHERE run_id=CAST(? AS TEXT) AND kind='thought' AND ref_id=CAST(? AS TEXT) AND full_read=1")
      .get(text(owner.runId), text(id))) throw new RunForbiddenError("A full thought read in this search run is required");
  }
  if (!searchReferencesEligible(db, ids.map(id => ({ kind: "thought", id })))) throw new RunFenceError("Search publication source is unavailable");
}
/** Commit this observed contamination fence outside any publication effects, then report failure. */
export function fenceSearchPublication(db: Database, owner: SearchPublicationOwner): void {
  assertRunNotRestoreFenced(db,owner.runId);
  searchRevision(owner.generation + 1);
  db.run("UPDATE search_turns SET outcome_reason='context-invalidated' WHERE run_id=CAST(? AS TEXT) AND outcome_reason IS NULL", [text(owner.runId)]);
  db.run("UPDATE runs SET status='interrupted',generation=generation+1,cancellation_state='pending' WHERE id=CAST(? AS TEXT)", [text(owner.runId)]);
}
