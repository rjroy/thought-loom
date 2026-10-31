import type { Database } from "bun:sqlite";
import type { WeavingRun } from "./weaving";
import { readFollowUpInput } from "./follow-up-data";

export type RunScope = { kind: "capture"; rootSourceId: string; sourceIds: [string] } |
  { kind: "dialogue"; rootSourceId: string; sourceIds: [string, string]; dialogueId: string; turnId: string; turnSourceId: string } |
  { kind: "follow_up"; rootSourceId: string; sourceIds: string[]; inputHash: string };

// Authority comes from immutable job/turn/run joins, not caller-supplied job kind,
// model roles or a session's current turn. Admission state is checked by callers.
export function runScope(db: Database, run: WeavingRun): RunScope | null {
  const row = db.query<{ kind: string; dialogueId: string | null; turnId: string | null; turnSourceId: string | null; root: string | null }, [string, string, string, string, string]>(
    `SELECT j.kind,t.dialogue_id AS dialogueId,t.id AS turnId,t.source_id AS turnSourceId,d.source_id AS root
     FROM weaving_runs r JOIN jobs j ON j.id=r.job_id LEFT JOIN dialogue_turns t ON t.job_id=j.id LEFT JOIN dialogues d ON d.id=t.dialogue_id
     WHERE r.id=? AND j.id=? AND j.source_id=? AND r.session_id=? AND r.prompt_id=?`,
  ).get(run.runId, run.jobId, run.sourceId, run.sessionId, run.promptId);
  if (!row || (run.kind !== undefined && run.kind !== row.kind)) return null;
  if (row.kind === "follow_up") {
    const frozen = readFollowUpInput(db, run.jobId);
    return frozen && frozen.sourceId === run.sourceId ? { kind: "follow_up", rootSourceId: run.sourceId, sourceIds: frozen.sourceIds, inputHash: frozen.hash } : null;
  }
  if (row.kind === "capture" && row.turnId === null) return { kind: "capture", rootSourceId: run.sourceId, sourceIds: [run.sourceId] };
  if (row.kind !== "dialogue" || row.root !== run.sourceId || !row.dialogueId || !row.turnId || !row.turnSourceId || row.turnSourceId === run.sourceId) return null;
  return { kind: "dialogue", rootSourceId: run.sourceId, sourceIds: [run.sourceId, row.turnSourceId], dialogueId: row.dialogueId, turnId: row.turnId, turnSourceId: row.turnSourceId };
}
