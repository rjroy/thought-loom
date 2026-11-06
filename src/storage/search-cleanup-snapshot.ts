import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { normalizeBinding } from "../agent/binding";
import { protocolJson, type StepState } from "../domain/run-protocol";
import type { NativeState } from "../domain/run";
import { encodeSearchCleanupManifest, parseSearchCleanupManifest, searchCleanupFocus, SearchCleanupJournalError, type SearchCleanupPrompt } from "./search-cleanup-manifest";

export interface SearchCleanupSnapshot {
  readonly runId: string;
  readonly sessionId: string;
  readonly bindingJson: string;
  readonly lastPromptId: string;
  readonly submitOwner: string | null;
  readonly promptSha256: Uint8Array | null;
  readonly promptManifestJson: string;
  readonly drainState: "unknown-after-restart";
  readonly admissionState: "never-submitted" | "uncertain";
  readonly state: "pending";
  readonly evidenceJson: null;
}
interface OwnerRow {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly generation: number;
  readonly status: string;
  readonly cancellation: string;
  readonly deletedAt: string | null;
  readonly openSlot: number;
  readonly setupOwnerId: string | null;
  readonly serviceUrl: string;
  readonly directory: string;
  readonly model: string;
  readonly permissions: string;
  readonly protocolVersion: number;
}
interface StepRow {
  readonly position: number;
  readonly promptId: string;
  readonly input: string | null;
  readonly submitOwnerId: string | null;
  readonly state: StepState;
  readonly nativeState: NativeState;
  readonly hasEnvelope: number;
  readonly hasResult: number;
}

/** Trusted retention preparation only. Caller has already fenced the run and owns the surrounding SQL transaction.
 * Reads exact input transiently for hashing, never returns it or interprets native completion as terminal proof.
 * Does not insert cleanup, purge, mark drained, settle, or make a native call.
 */
export function readSearchCleanupSnapshot(db: Database, runId: string): SearchCleanupSnapshot {
  if (!db.inTransaction) throw new SearchCleanupJournalError();
  try {
    const row = db.query(`SELECT t.session_id AS sessionId,r.session_id AS nativeSessionId,r.generation,r.status,
      r.cancellation_state AS cancellation,s.deleted_at AS deletedAt,t.open_slot AS openSlot,
      b.execution_owner_id AS setupOwnerId,b.service_url AS serviceUrl,b.directory,b.model_json AS model,
      b.permissions_json AS permissions,b.protocol_version AS protocolVersion
      FROM runs r JOIN search_turns t ON t.run_id=r.id JOIN search_sessions s ON s.id=t.session_id
      JOIN agent_bindings b ON b.run_id=r.id AND b.session_id=r.session_id
      WHERE r.id=? AND r.kind='search'`).get(runId) as OwnerRow | null;
    if (!row || row.openSlot !== 0 || !["completed","interrupted","failed"].includes(row.status) ||
      (row.deletedAt === null && row.cancellation !== "pending")) throw new SearchCleanupJournalError();
    const binding = normalizeBinding({sessionId:row.nativeSessionId,serviceUrl:row.serviceUrl,location:{directory:row.directory},
      model:JSON.parse(row.model),permissions:JSON.parse(row.permissions),protocolVersion:row.protocolVersion});
    // A long turn retains all metadata, not an array of all private input bodies while hashing them.
    const rows = db.query<StepRow,[string]>(`SELECT position,prompt_id AS promptId,input,submit_owner AS submitOwnerId,state,native_state AS nativeState,
      envelope_json IS NOT NULL AS hasEnvelope,result_json IS NOT NULL AS hasResult FROM run_steps WHERE run_id=? ORDER BY position`).iterate(runId);
    const steps: SearchCleanupPrompt[] = [];
    for (const step of rows) {
      if (step.state === "prepared" && (step.hasEnvelope || step.hasResult)) throw new SearchCleanupJournalError();
      steps.push({position:step.position,promptId:step.promptId,inputSha256:step.input === null ? null : createHash("sha256").update(step.input,"utf8").digest("hex"),
        submitOwnerId:step.submitOwnerId,authorization:step.state === "prepared" ? "never-authorized" :
          step.submitOwnerId === null ? "unattributed" : "authorized-uncertain",state:step.state,nativeState:step.nativeState});
    }
    const promptManifestJson = encodeSearchCleanupManifest({version:1,runId,searchSessionId:row.sessionId,nativeSessionId:row.nativeSessionId,
      fencedGeneration:row.generation,setupOwnerId:row.setupOwnerId,steps});
    const manifest = parseSearchCleanupManifest(promptManifestJson), focus = searchCleanupFocus(manifest);
    return Object.freeze({runId,sessionId:row.sessionId,bindingJson:protocolJson(binding),lastPromptId:focus.promptId,
      submitOwner:focus.submitOwnerId,promptSha256:focus.inputSha256 === null ? null : new Uint8Array(Buffer.from(focus.inputSha256,"hex")),
      promptManifestJson,drainState:"unknown-after-restart",admissionState:steps.every(step => step.authorization === "never-authorized") ? "never-submitted" : "uncertain",
      state:"pending",evidenceJson:null});
  } catch { throw new SearchCleanupJournalError(); }
}
