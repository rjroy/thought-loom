import type { Database } from "bun:sqlite";
import type { RunKind, RunRecord } from "../domain/run";
import type { WeaveIntent } from "../domain/run-operations";
import { resolveWeavePurpose, type WeaveScheduleKind } from "../domain/weave-scheduling";
import { RunConflictError } from "../domain/run";
import type { MaterialKind } from "../domain/thought";
import { assertBindingPermissions, normalizeBinding, type AgentBinding } from "../agent/binding";
import { assertRunNotRestoreFenced } from "./restore-fences";
import { assertRunLocallyTracked } from "./local-work-stop-fence";

/** One run identity/projection shared by aggregate operations and transactional weave admission. No initialization here. */
export function readRun(db: Database, id: string): RunRecord | null {
  // runs.prompt_id is the immutable initial identity; the projection follows the current ordered step.
  return db.query(`SELECT r.id,r.kind,r.status,COALESCE(b.session_id,r.session_id) AS sessionId,s.prompt_id AS promptId,r.created_at AS createdAt,r.generation,
    r.input_thought_id AS inputThoughtId,s.native_state AS nativeState FROM runs r LEFT JOIN agent_bindings b ON b.run_id=r.id JOIN run_steps s ON s.run_id=r.id
    AND s.position=(SELECT MAX(position) FROM run_steps WHERE run_id=r.id) WHERE r.id=?`).get(id) as RunRecord | null;
}

/** Canonical immutable binding projection without an aggregate import cycle. */
export function readAgentBinding(db: Database, runId: string): AgentBinding | null {
  const row = db.query<{ sessionId: string; serviceUrl: string; directory: string; model: string; permissions: string;
    protocolVersion: number; kind: RunKind }, [string]>(`SELECT b.session_id AS sessionId,b.service_url AS serviceUrl,b.directory,
    b.model_json AS model,b.permissions_json AS permissions,b.protocol_version AS protocolVersion,r.kind
    FROM agent_bindings b JOIN runs r ON r.id=b.run_id WHERE b.run_id=?`).get(runId);
  if (row === null) return null;
  const binding = normalizeBinding({sessionId:row.sessionId,serviceUrl:row.serviceUrl,location:{directory:row.directory},
    model:JSON.parse(row.model),permissions:JSON.parse(row.permissions),protocolVersion:row.protocolVersion});
  assertBindingPermissions(row.kind,binding);
  return binding;
}

export function insertRun(db: Database, run: RunRecord, intent: WeaveIntent | null = null, scheduleKind: WeaveScheduleKind | null = null): void {
  assertRunLocallyTracked(db,run.id);
  assertRunNotRestoreFenced(db,run.id);
  if (scheduleKind !== null) {
    if (run.kind !== "weave" || intent === null) throw new RunConflictError("Scheduled weave identity required");
    const subject = db.query<{kind:MaterialKind},[string]>("SELECT kind FROM thoughts WHERE id=?").get(intent.subjectId);
    if (!subject || resolveWeavePurpose(subject.kind,intent.triggerId,scheduleKind) !== scheduleKind) throw new RunConflictError("Scheduled weave purpose differs");
  }
  db.run(`INSERT INTO runs (id,kind,status,session_id,prompt_id,created_at,generation,input_thought_id,weave_subject_id,weave_trigger_id,weave_schedule_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[run.id,run.kind,run.status,run.sessionId,run.promptId,run.createdAt,run.generation,run.inputThoughtId,intent?.subjectId ?? null,intent?.triggerId ?? null,scheduleKind]);
}
