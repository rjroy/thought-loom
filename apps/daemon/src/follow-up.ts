import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { WeavingRun } from "./weaving";

export type FollowUpTarget = { kind: "item" | "relationship"; id: string; versionId: string };
export type FollowUpOrigin = { kind: "dialogue"; runId: string; turnId: string; dialogueId: string; turnSourceId: string };
type EnqueueResult = { kind: "none" } | { kind: "queued" | "coalesced" | "replayed"; jobId: string };

function pendingJob(db: Database, sourceId: string) {
  return db.query<{ id: string }, [string]>(`SELECT j.id FROM jobs j WHERE j.kind='follow_up' AND j.status='queued' AND j.source_id=?
    AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.job_id=j.id)
    AND NOT EXISTS (SELECT 1 FROM follow_up_inputs frozen WHERE frozen.job_id=j.id) ORDER BY j.rowid LIMIT 1`).get(sourceId);
}

export class FollowUpError extends Error {
  constructor(readonly code: "invalid_origin" | "storage_error") { super(code); this.name = "FollowUpError"; }
}

// Called only within the worker's successful settlement IMMEDIATE transaction.
// The ledger, not assistant prose or adapter-reported counts, identifies changes.
export function enqueueDialogueFollowUp(db: Database, run: WeavingRun): EnqueueResult {
  console.info("follow_up.enqueue attempt", { runId: run.runId });
  try {
    const result = enqueue(db, run);
    console.info("follow_up.enqueue outcome", { runId: run.runId, ...result });
    return result;
  } catch (error) {
    const failure = error instanceof FollowUpError ? error : new FollowUpError("storage_error");
    console.error("follow_up.enqueue failed", { runId: run.runId, category: failure.code });
    throw failure;
  }
}

function enqueue(db: Database, run: WeavingRun): EnqueueResult {
  const origin = db.query<FollowUpOrigin, [string, string, string, string, string]>(`SELECT 'dialogue' AS kind,r.id AS runId,t.id AS turnId,d.id AS dialogueId,t.source_id AS turnSourceId FROM weaving_runs r
    JOIN jobs j ON j.id=r.job_id JOIN dialogue_turns t ON t.job_id=j.id JOIN dialogues d ON d.id=t.dialogue_id
    JOIN dialogue_outcomes o ON o.turn_id=t.id AND o.run_id=r.id
    WHERE r.id=? AND j.id=? AND j.source_id=? AND r.session_id=? AND r.prompt_id=? AND j.kind='dialogue' AND j.status='completed'
      AND d.source_id=j.source_id AND r.state='completed' AND r.outcome='succeeded' AND o.outcome='succeeded'`)
    .get(run.runId, run.jobId, run.sourceId, run.sessionId, run.promptId);
  if (!origin) throw new FollowUpError("invalid_origin");
  if (db.query("SELECT 1 FROM dialogue_stop_requests WHERE job_id=?").get(run.jobId)) return { kind: "none" };
  const prior = db.query<{ jobId: string }, [string]>("SELECT job_id AS jobId FROM follow_up_origins WHERE run_id=?").get(run.runId);
  if (prior) return { kind: "replayed", jobId: prior.jobId };
  const targets = db.query<FollowUpTarget, [string, string, string, string, string]>(`SELECT 'item' AS kind,i.id,f.id AS versionId FROM formulations f
    JOIN knowledge_items i ON i.id=f.item_id JOIN knowledge_receipts k ON k.operation_id=f.operation_id AND k.result_id=i.id AND k.revision_id=f.id
    WHERE f.run_id=? AND f.author='ai' AND i.source_id=?
    UNION SELECT 'relationship',rel.id,v.id FROM relationship_revisions v JOIN relationships rel ON rel.id=v.relationship_id
    JOIN knowledge_items a ON a.id=rel.from_item_id JOIN knowledge_items b ON b.id=rel.to_item_id
    JOIN knowledge_receipts k ON k.operation_id=v.operation_id AND k.result_id=rel.id AND k.revision_id=v.id
    WHERE v.run_id=? AND v.author='ai' AND (a.source_id=? OR b.source_id=?)`).all(run.runId, run.sourceId, run.runId, run.sourceId, run.sourceId);
  if (!targets.length) return { kind: "none" };
  // Coalesce only before any attempt exists. Later origins never extend an
  // already-claimed run's immutable scope, even if that job is requeued later.
  const pending = pendingJob(db, run.sourceId);
  const jobId = pending?.id ?? randomUUID();
  if (!pending) db.run("INSERT INTO jobs(id,source_id,status,priority,kind) VALUES (?,?,'queued',0,'follow_up')", [jobId, run.sourceId]);
  db.run("INSERT INTO follow_up_origins(run_id,job_id,turn_id) VALUES (?,?,?)", [run.runId, jobId, origin.turnId]);
  for (const target of targets) db.run(`INSERT INTO follow_up_targets(origin_run_id,item_id,formulation_id,relationship_id,revision_id) VALUES (?,?,?,?,?)`,
    [run.runId, target.kind === "item" ? target.id : null, target.kind === "item" ? target.versionId : null,
      target.kind === "relationship" ? target.id : null, target.kind === "relationship" ? target.versionId : null]);
  return { kind: pending ? "coalesced" : "queued", jobId };
}

// Trusted USER revision commands call this after their domain receipt is written,
// inside that same IMMEDIATE transaction. AI tool writes never call this path.
export function enqueueUserFollowUp(db: Database, operationId: string): void {
  console.info("follow_up.user enqueue attempt", { operationId });
  try {
    const changes = db.query<FollowUpTarget & { sourceId: string }, [string, string]>(`SELECT 'item' AS kind,i.id,f.id AS versionId,i.source_id AS sourceId
      FROM formulations f JOIN knowledge_items i ON i.id=f.item_id JOIN knowledge_receipts k ON k.operation_id=f.operation_id AND k.result_id=i.id AND k.revision_id=f.id
      WHERE k.operation_id=? AND f.author='user'
      UNION SELECT 'relationship',rel.id,v.id,i.source_id FROM relationship_revisions v JOIN relationships rel ON rel.id=v.relationship_id
      JOIN knowledge_items i ON i.id=rel.from_item_id OR i.id=rel.to_item_id
      JOIN knowledge_receipts k ON k.operation_id=v.operation_id AND k.result_id=rel.id AND k.revision_id=v.id WHERE k.operation_id=? AND v.author='user'`)
      .all(operationId, operationId);
    if (!changes.length) throw new FollowUpError("invalid_origin");
    for (const sourceId of [...new Set(changes.map((change) => change.sourceId))].sort()) {
      if (db.query(`SELECT 1 FROM follow_up_user_origins o JOIN jobs j ON j.id=o.job_id WHERE o.operation_id=? AND j.source_id=?`).get(operationId, sourceId)) continue;
      const pending = pendingJob(db, sourceId), jobId = pending?.id ?? randomUUID();
      if (!pending) db.run("INSERT INTO jobs(id,source_id,status,priority,kind) VALUES (?,?,'queued',0,'follow_up')", [jobId, sourceId]);
      db.run("INSERT INTO follow_up_user_origins(job_id,operation_id) VALUES (?,?)", [jobId, operationId]);
      for (const target of changes.filter((change) => change.sourceId === sourceId)) db.run(`INSERT INTO follow_up_user_targets(job_id,operation_id,item_id,formulation_id,relationship_id,revision_id) VALUES (?,?,?,?,?,?)`,
        [jobId, operationId, target.kind === "item" ? target.id : null, target.kind === "item" ? target.versionId : null,
          target.kind === "relationship" ? target.id : null, target.kind === "relationship" ? target.versionId : null]);
      console.info("follow_up.user enqueue outcome", { operationId, sourceId, jobId, outcome: pending ? "coalesced" : "queued" });
    }
  } catch (error) {
    const failure = error instanceof FollowUpError ? error : new FollowUpError("storage_error");
    console.error("follow_up.user enqueue failed", { operationId, category: failure.code }); throw failure;
  }
}
