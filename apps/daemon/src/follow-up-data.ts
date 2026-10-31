import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isRecordId, parseDialogueChanges, parseFollowUpOrigin, parseFollowUpTarget, type DialogueChange,
  type FollowUpOriginView, type FollowUpTargetView } from "@thoughtloom/contracts";

export class FollowUpDataError extends Error {
  constructor() { super("invalid_follow_up_data"); this.name = "FollowUpDataError"; }
}
const fail = (): never => { throw new FollowUpDataError(); };
export function followUpOrigins(db: Database, jobId: string, limit: number): FollowUpOriginView[] {
  return db.query<Record<string, unknown>, [string, number]>(`SELECT kind,run_id AS runId,dialogue_id AS dialogueId,turn_id AS turnId,
    turn_source_id AS turnSourceId,operation_id AS operationId FROM follow_up_origin_refs WHERE job_id=?
    ORDER BY kind,COALESCE(run_id,operation_id) LIMIT ?`).all(jobId, limit).map((row) => parseFollowUpOrigin(row) ?? fail());
}
export function followUpTargets(db: Database, jobId: string, limit: number): FollowUpTargetView[] {
  return db.query<Record<string, unknown>, [string, number]>(`SELECT kind,id,version_id AS versionId FROM follow_up_target_refs
    WHERE job_id=? ORDER BY kind,id,version_id LIMIT ?`).all(jobId, limit).map((row) => parseFollowUpTarget(row) ?? fail());
}
export type FollowUpInput = { sourceId: string; sourceIds: string[]; origins: FollowUpOriginView[]; targets: FollowUpTargetView[]; hash: string };
export function readFollowUpInput(db: Database, jobId: string): FollowUpInput | null {
  const row = db.query<{ payload: string; hash: string; sourceId: string }, [string]>(`SELECT f.payload,f.payload_hash AS hash,j.source_id AS sourceId
    FROM follow_up_inputs f JOIN jobs j ON j.id=f.job_id WHERE j.id=? AND j.kind='follow_up'`).get(jobId);
  if (!row) return null;
  if (row.payload.length > 16_777_216 || createHash("sha256").update(row.payload).digest("hex") !== row.hash) return fail();
  const value: unknown = JSON.parse(row.payload);
  if (typeof value !== "object" || !value || !("version" in value) || value.version !== 1 || !("sourceId" in value) || value.sourceId !== row.sourceId ||
      !("sourceIds" in value) || !Array.isArray(value.sourceIds) || !value.sourceIds.length || value.sourceIds.length > 100_000 || !value.sourceIds.every(isRecordId) ||
      new Set(value.sourceIds).size !== value.sourceIds.length || !value.sourceIds.includes(row.sourceId) ||
      !("origins" in value) || !Array.isArray(value.origins) || !value.origins.length || value.origins.length > 100_000 ||
      !("targets" in value) || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > 100_000) return fail();
  const sourceIds = value.sourceIds;
  const origins = value.origins.map((entry) => parseFollowUpOrigin(entry) ?? fail()), targets = value.targets.map((entry) => parseFollowUpTarget(entry) ?? fail());
  if (new Set(origins.map((origin) => origin.kind === "user" ? `user:${origin.operationId}` : `dialogue:${origin.runId}`)).size !== origins.length ||
      new Set(targets.map((target) => JSON.stringify([target.kind, target.id, target.versionId]))).size !== targets.length ||
      origins.some((origin) => origin.kind === "dialogue" && (!sourceIds.includes(origin.turnSourceId) || origin.turnSourceId === row.sourceId))) return fail();
  for (const id of sourceIds) if (id !== row.sourceId && !db.query(`SELECT 1 FROM dialogue_turns t JOIN dialogues d ON d.id=t.dialogue_id WHERE t.source_id=? AND d.source_id=?`).get(id, row.sourceId)) return fail();
  return { sourceId: row.sourceId, sourceIds, origins, targets, hash: row.hash };
}

// Freeze metadata/authority at the first claim, before any run or external call.
// Current version TEXT is separately frozen in each attempt's native command.
export function freezeFollowUpInput(db: Database, jobId: string): FollowUpInput {
  const prior = readFollowUpInput(db, jobId);
  if (prior) return prior;
  const job = db.query<{ sourceId: string }, [string]>("SELECT source_id AS sourceId FROM jobs WHERE id=? AND kind='follow_up' AND status='queued'").get(jobId);
  if (!job) return fail();
  const origins = followUpOrigins(db, jobId, 100_001), targets = followUpTargets(db, jobId, 100_001);
  if (!origins.length || !targets.length || origins.length > 100_000 || targets.length > 100_000) return fail();
  const sourceIds = new Set([job.sourceId]);
  for (const origin of origins) if (origin.kind === "dialogue") sourceIds.add(origin.turnSourceId);
  // Only retained discussion evidence owned by this root extends write evidence
  // scope. Merely citing some other original never grants writes in that root.
  const evidence = db.query<{ id: string }, [string, string, string, string]>(`SELECT DISTINCT t.source_id AS id FROM follow_up_target_refs target
    JOIN formulation_evidence e ON target.kind='item' AND e.formulation_id=target.version_id
    JOIN dialogue_turns t ON t.source_id=e.source_id JOIN dialogues d ON d.id=t.dialogue_id
    WHERE target.job_id=? AND d.source_id=?
    UNION SELECT DISTINCT t.source_id FROM follow_up_target_refs target JOIN relationship_evidence e ON target.kind='relationship' AND e.revision_id=target.version_id
    JOIN dialogue_turns t ON t.source_id=e.source_id JOIN dialogues d ON d.id=t.dialogue_id WHERE target.job_id=? AND d.source_id=?`)
    .all(jobId, job.sourceId, jobId, job.sourceId);
  for (const source of evidence) sourceIds.add(source.id);
  const payload = JSON.stringify({ version: 1, sourceId: job.sourceId, sourceIds: [...sourceIds].sort(), origins, targets });
  db.run("INSERT INTO follow_up_inputs(job_id,payload,payload_hash) VALUES (?,?,?)", [jobId, payload, createHash("sha256").update(payload).digest("hex")]);
  return readFollowUpInput(db, jobId) ?? fail();
}

export function followUpChanges(db: Database, jobId: string, limit: number): DialogueChange[] {
  const rows = db.query<Record<string, unknown>, [string, string, string, number]>(`SELECT i.id AS id,i.kind AS kind,f.id AS versionId FROM formulations f JOIN knowledge_items i ON i.id=f.item_id
    JOIN weaving_runs r ON r.id=f.run_id JOIN knowledge_receipts k ON k.operation_id=f.operation_id AND k.result_id=i.id AND k.revision_id=f.id WHERE r.job_id=? AND f.author='ai'
    UNION SELECT v.relationship_id,'relationship',v.id FROM relationship_revisions v JOIN weaving_runs r ON r.id=v.run_id
      JOIN knowledge_receipts k ON k.operation_id=v.operation_id AND k.result_id=v.relationship_id AND k.revision_id=v.id WHERE r.job_id=? AND v.author='ai'
    UNION SELECT a.id,'alias',NULL FROM search_aliases a JOIN weaving_runs r ON r.id=a.run_id JOIN knowledge_receipts k ON k.operation_id=a.operation_id AND k.result_id=a.id
      WHERE r.job_id=? AND a.author='ai' ORDER BY kind,id,versionId LIMIT ?`).all(jobId, jobId, jobId, limit);
  return parseDialogueChanges(rows) ?? fail();
}
export function followUpChangeCount(db: Database, jobId: string): number {
  const row = db.query<{ count: number }, [string, string, string]>(`SELECT COUNT(*) AS count FROM (
    SELECT f.operation_id FROM formulations f JOIN weaving_runs r ON r.id=f.run_id JOIN knowledge_receipts k ON k.operation_id=f.operation_id AND k.revision_id=f.id AND k.result_id=f.item_id WHERE r.job_id=? AND f.author='ai'
    UNION SELECT v.operation_id FROM relationship_revisions v JOIN weaving_runs r ON r.id=v.run_id JOIN knowledge_receipts k ON k.operation_id=v.operation_id AND k.revision_id=v.id AND k.result_id=v.relationship_id WHERE r.job_id=? AND v.author='ai'
    UNION SELECT a.operation_id FROM search_aliases a JOIN weaving_runs r ON r.id=a.run_id JOIN knowledge_receipts k ON k.operation_id=a.operation_id AND k.result_id=a.id WHERE r.job_id=? AND a.author='ai')`).get(jobId, jobId, jobId);
  return row?.count ?? fail();
}
