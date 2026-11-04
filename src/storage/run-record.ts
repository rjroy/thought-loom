import type { Database } from "bun:sqlite";
import type { RunRecord } from "../domain/run";
import type { WeaveIntent } from "../domain/run-operations";

/** One run identity/projection shared by aggregate operations and transactional weave admission. No initialization here. */
export function readRun(db: Database, id: string): RunRecord | null {
  // runs.prompt_id is the immutable initial identity; the projection follows the current ordered step.
  return db.query(`SELECT r.id,r.kind,r.status,COALESCE(b.session_id,r.session_id) AS sessionId,s.prompt_id AS promptId,r.created_at AS createdAt,r.generation,
    r.input_thought_id AS inputThoughtId,s.native_state AS nativeState FROM runs r LEFT JOIN agent_bindings b ON b.run_id=r.id JOIN run_steps s ON s.run_id=r.id
    AND s.position=(SELECT MAX(position) FROM run_steps WHERE run_id=r.id) WHERE r.id=?`).get(id) as RunRecord | null;
}

export function insertRun(db: Database, run: RunRecord, intent: WeaveIntent | null = null): void {
  db.run(`INSERT INTO runs (id,kind,status,session_id,prompt_id,created_at,generation,input_thought_id,weave_subject_id,weave_trigger_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,[run.id,run.kind,run.status,run.sessionId,run.promptId,run.createdAt,run.generation,run.inputThoughtId,intent?.subjectId ?? null,intent?.triggerId ?? null]);
}
