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

/** SQL predicate over a runs row named r. Shared by Weaver/Evolve subject ownership and the bounded supervisor scan. */
export const recordedSubjectCancellationSafeSql = `(
  EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND s.position=0 AND s.prompt_id=r.prompt_id)
  AND (
    (SELECT COUNT(*) FROM run_steps s WHERE s.run_id=r.id)=1 AND EXISTS(
      SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND s.position=0 AND s.state='prepared' AND s.native_state='unknown'
        AND s.envelope_json IS NULL AND s.result_json IS NULL
        AND ((s.input IS NOT NULL AND length(trim(s.input))>0) OR r.status='interrupted'))
    OR (
      (SELECT COUNT(*) FROM run_steps s WHERE s.run_id=r.id)=(SELECT MAX(s.position)+1 FROM run_steps s WHERE s.run_id=r.id)
      AND EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND s.state IN ('completed','processed'))
      AND NOT EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND (
        length(trim(s.prompt_id,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))=0
        OR s.input IS NULL OR length(trim(s.input))=0
        OR (s.state='prepared' AND (s.position!=(SELECT MAX(last.position) FROM run_steps last WHERE last.run_id=r.id)
          OR s.native_state!='unknown' OR s.envelope_json IS NOT NULL OR s.result_json IS NOT NULL))
        OR (s.state!='prepared' AND (s.native_state!='completed' OR s.state NOT IN ('completed','processed')
          OR (s.position!=(SELECT MAX(last.position) FROM run_steps last WHERE last.run_id=r.id)
            AND (s.state!='processed' OR s.envelope_json IS NULL OR s.result_json IS NULL))))
      ))
    )
  )
)`;

/** Shared Weaver/Evolve proof. Historical settlement alone says nothing about a possibly dispatched prompt. */
export function recordedSubjectCancellationSafe(db: Database, runId: string): boolean {
  const row = db.query<{safe:number},[string]>(`SELECT EXISTS(SELECT 1 FROM runs r WHERE r.id=? AND r.kind IN ('weave','evolve')
    AND r.status IN ('interrupted','failed') AND r.cancellation_state='settled' AND ${recordedSubjectCancellationSafeSql}) AS safe`).get(runId);
  return row?.safe === 1;
}
