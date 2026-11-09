import type { Database } from "bun:sqlite";
import { RunFenceError, type NativeState } from "../domain/run";
import { protocolJson, type OrdinaryCancellationJournal, type StepState } from "../domain/run-protocol";
import { assertRunNotRestoreFenced } from "./restore-fences";

interface JournalRow {
  readonly position: number;
  readonly promptId: string;
  readonly input: string | null;
  readonly state: StepState;
  readonly nativeState: NativeState;
  readonly hasEnvelope: number;
  readonly hasResult: number;
}

/** Caller owns a short transaction. A settled bit is retained as identity, never accepted as terminal evidence. */
export function ordinaryCancellationJournal(db: Database, runId: string): OrdinaryCancellationJournal {
  assertRunNotRestoreFenced(db,runId);
  const run = db.query<{kind:string;status:string;generation:number;initialPromptId:string;cancellation:string},[string]>(
    `SELECT kind,status,generation,prompt_id AS initialPromptId,cancellation_state AS cancellation FROM runs WHERE id=?`).get(runId);
  if (!run || !["weave","evolve","export"].includes(run.kind) ||
      (run.status !== "interrupted" && run.status !== "failed") ||
      (run.cancellation !== "pending" && run.cancellation !== "settled")) throw new RunFenceError("Ordinary cancellation authority is unavailable");
  const rows = db.query<JournalRow,[string]>(`SELECT position,prompt_id AS promptId,input,state,native_state AS nativeState,
    envelope_json IS NOT NULL AS hasEnvelope,result_json IS NOT NULL AS hasResult FROM run_steps WHERE run_id=? ORDER BY position`).all(runId);
  if (!rows.length || rows[0]?.promptId !== run.initialPromptId || new Set(rows.map(row => row.promptId)).size !== rows.length) {
    throw new RunFenceError("Ordinary cancellation journal is incomplete");
  }
  const steps = rows.map((row,index) => {
    if (row.position !== index || !row.promptId.trim() || row.input === null || !row.input.trim() ||
        (index < rows.length-1 && row.state !== "processed") ||
        (row.state === "prepared" && (row.nativeState !== "unknown" || row.hasEnvelope || row.hasResult)) ||
        ((row.state === "completed" || row.state === "processed") !== (row.nativeState === "completed"))) {
      throw new RunFenceError("Ordinary cancellation journal cannot prove submission identity");
    }
    return Object.freeze({promptId:row.promptId,input:row.input,state:row.state,nativeState:row.nativeState,
      hasEnvelope:row.hasEnvelope !== 0,hasResult:row.hasResult !== 0});
  });
  return Object.freeze({runId,generation:run.generation,status:run.status,cancellation:run.cancellation,steps:Object.freeze(steps)});
}

/** Recheck the exact terminal generation and complete journal after external reconciliation, in the commit transaction. */
export function assertOrdinaryCancellationJournal(db: Database, journal: OrdinaryCancellationJournal): void {
  if (protocolJson(ordinaryCancellationJournal(db,journal.runId)) !== protocolJson(journal)) {
    throw new RunFenceError("Ordinary cancellation journal changed during reconciliation");
  }
}

/** Read-only admission proof. Historical settlement alone says nothing about a possibly dispatched prompt. */
export function recordedWeaveCancellationSafe(db: Database, runId: string): boolean {
  const run = db.query<{status:string;initialPromptId:string},[string]>(`SELECT status,prompt_id AS initialPromptId FROM runs
    WHERE id=? AND kind='weave' AND status IN ('interrupted','failed') AND cancellation_state='settled'`).get(runId);
  if (!run) return false;
  // Inspect existence and protocol facts only; a control read does not need private prompt bytes.
  const rows = db.query<Omit<JournalRow,"input"> & {hasInput:number},[string]>(`SELECT position,prompt_id AS promptId,
    input IS NOT NULL AND length(trim(input))>0 AS hasInput,state,native_state AS nativeState,
    envelope_json IS NOT NULL AS hasEnvelope,result_json IS NOT NULL AS hasResult FROM run_steps WHERE run_id=? ORDER BY position`).all(runId);
  if (!rows.length || rows[0]?.promptId !== run.initialPromptId || new Set(rows.map(row => row.promptId)).size !== rows.length) return false;
  const initial = rows[0];
  if (rows.length === 1 && initial?.position === 0 && initial.state === "prepared" && initial.nativeState === "unknown" &&
      !initial.hasEnvelope && !initial.hasResult && (initial.hasInput || run.status === "interrupted")) return true;
  let submitted = 0;
  for (const [index,step] of rows.entries()) {
    if (step.position !== index || !step.promptId.trim() || !step.hasInput) return false;
    if (step.state === "prepared") {
      if (index !== rows.length-1 || step.nativeState !== "unknown" || step.hasEnvelope || step.hasResult) return false;
    } else {
      if (step.nativeState !== "completed" || (step.state !== "completed" && step.state !== "processed") ||
          (index < rows.length-1 && (step.state !== "processed" || !step.hasEnvelope || !step.hasResult))) return false;
      submitted++;
    }
  }
  return submitted > 0;
}
