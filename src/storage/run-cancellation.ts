import type { Database } from "bun:sqlite";
import { RunFenceError, type NativeState } from "../domain/run";
import { protocolJson, type OrdinaryCancellationJournal, type StepState } from "../domain/run-protocol";

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
