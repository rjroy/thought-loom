import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RunRecord } from "../domain/run";
import { RunFenceError } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { record } from "../domain/validation";
import { equalBytes, importManifest, ImportPreservationError, sourceText } from "../domain/markdown-import-contract";
import { isRestoreFenced, isRunRestoreFenced } from "./restore-fences";

interface ImportRestoreOwner { readonly id: string; readonly importId: string; readonly runId: string | null }

/** Fixed f-alias predicate for owned import scans/settlement, applied before their technical LIMIT. */
export const unfencedImportFileSql = `NOT EXISTS(SELECT 1 FROM main.restore_fences rf WHERE
  (rf.entity_kind='import-file' AND rf.entity_id=f.id) OR
  (rf.entity_kind='import-batch' AND rf.entity_id=f.import_id) OR
  (rf.entity_kind='run' AND rf.entity_id=f.run_id))`;

export function isImportOwnerRestoreFenced(db: Database, owner: ImportRestoreOwner): boolean {
  return isRestoreFenced(db,"import-file",owner.id) || isRestoreFenced(db,"import-batch",owner.importId) ||
    (owner.runId !== null && isRunRestoreFenced(db,owner.runId));
}
export function assertImportOwnerNotRestoreFenced(db: Database, owner: ImportRestoreOwner): void {
  if (isImportOwnerRestoreFenced(db,owner)) throw new RunFenceError("Restored import is historical only");
}
export function isImportRunRestoreFenced(db: Database, runId: string): boolean {
  if (isRunRestoreFenced(db,runId)) return true;
  const owner = db.query<ImportRestoreOwner,[string]>(
    "SELECT id,import_id AS importId,run_id AS runId FROM markdown_import_files WHERE run_id=?").get(runId);
  if (!owner) throw new RunFenceError("Import owner is unavailable");
  return isImportOwnerRestoreFenced(db,owner);
}
export function assertImportRunNotRestoreFenced(db: Database, runId: string): void {
  if (isImportRunRestoreFenced(db,runId)) throw new RunFenceError("Restored import is historical only");
}

export interface ImportOwnedStep {
  readonly position: number;
  readonly promptId: string; readonly input: string | null; readonly state: string;
  readonly nativeState: string; readonly result: string | null;
}

/** Read only, inside the caller's claim-fenced transaction. Reuse the actual file/input proof, not a caller mode. */
export function readOwnedImportInput(db: Database, run: RunRecord): {readonly fileId:string;readonly step:ImportOwnedStep;readonly bytes:Uint8Array} {
  if (run.kind!=="import") throw new RunFenceError("Import authority required");
  assertImportRunNotRestoreFenced(db,run.id);
  const file=db.query(`SELECT id,sha256,byte_length AS byteLength FROM markdown_import_files
    WHERE run_id=? AND outcome IS NULL AND waiting_on_file_id IS NULL`).get(run.id) as {id:string;sha256:Uint8Array;byteLength:number}|null;
  if (!file) throw new RunFenceError("Import reservation is no longer owned");
  const payload=db.query("SELECT bytes FROM markdown_import_payloads WHERE file_id=?").get(file.id) as {bytes:Uint8Array}|null;
  const bytes=payload?.bytes;
  if (!bytes || bytes.length!==file.byteLength || !equalBytes(new Uint8Array(createHash("sha256").update(bytes).digest()),file.sha256)) throw new ImportPreservationError("Import staged input mismatch");
  const steps=db.query(`SELECT position,prompt_id AS promptId,input,state,native_state AS nativeState,result_json AS result
    FROM run_steps WHERE run_id=? ORDER BY position`).all(run.id) as ImportOwnedStep[];
  const step=steps[0];
  if (steps.length!==1 || !step || step.position!==0 || step.promptId!==run.promptId) throw new RunFenceError("Import must own its initial prompt");
  if (step.input!==null) {
    const job=record(JSON.parse(step.input));
    const keys=["version","kind","document","manifest","capabilities","instructions"];
    if (protocolJson(job)!==step.input || Object.keys(job).length!==keys.length || keys.some(key => !Object.hasOwn(job,key)) ||
      job.version!==1 || job.kind!=="import-job" || job.document!==sourceText(bytes) ||
      !Array.isArray(job.capabilities) || job.capabilities.length!==0 || !Array.isArray(job.instructions) ||
      job.instructions.some((value:unknown) => typeof value!=="string")) throw new ImportPreservationError("Import prepared input does not own its submitted source");
    importManifest(bytes,job.manifest);
  }
  return {fileId:file.id,step,bytes};
}
