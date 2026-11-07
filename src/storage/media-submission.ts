import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AgentBinding, PersistedPrompt } from "../agent/opencode-adapter";
import { RunConflictError, RunFenceError, RunForbiddenError, type Claim } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { createLogger, type Logger } from "../logging";
import { SqliteAgentBindings } from "./agent-binding";
import { ExecutionOwnerLease, type ExecutionOwnerId } from "./execution-owner";
import { SqliteRunAggregate } from "./run-aggregate";
import { readOriginalMediaParts, type OriginalMediaPart, type OriginalMediaManifest } from "./run-media";

export type OriginalSubmissionPart = OriginalMediaPart;
export type MediaSubmissionManifest = OriginalMediaManifest;
/** Fingerprints only, not native file parts, URIs, byte payloads or evidence of observation. */
export interface MediaSubmissionPrompt extends PersistedPrompt {
  readonly media: MediaSubmissionManifest;
}
export interface MediaSubmissionAuthorization {
  readonly version: 1;
  readonly runId: string;
  readonly promptId: string;
  readonly generation: number;
  readonly executionOwnerId: ExecutionOwnerId;
  readonly binding: AgentBinding;
  readonly inputSha256: string;
  readonly media: MediaSubmissionManifest;
}
export interface RecordedMediaSubmission {
  readonly authorization: MediaSubmissionAuthorization;
  /** Retained intent is observation-only, never a second dispatch permission. */
  readonly replayed: boolean;
}

/** Persist intent only. The existing text-only native gate remains closed, including after this command succeeds. */
export function recordMediaSubmission(db: Database, owner: ExecutionOwnerLease | undefined, claim: Claim,
  prompt: MediaSubmissionPrompt, logger: Logger = createLogger()): RecordedMediaSubmission {
  if (!(owner instanceof ExecutionOwnerLease)) throw new RunFenceError("A held registered runtime lease is required");
  owner.assertRegistered(db);
  return new MediaSubmissionWriter(db,owner,logger).record(claim,prompt);
}

/** Internal audit metadata, independent of active execution; does not authorize replay or expose original bytes. */
export function readMediaSubmission(db: Database, promptId: string): MediaSubmissionAuthorization | null {
  return db.transaction(() => {
    const row = db.query<{ runId: string; input: string | null; ownerId: ExecutionOwnerId | null; generation: number | null }, [string]>(
      `SELECT run_id AS runId,input,media_submit_owner_id AS ownerId,media_submit_generation AS generation
       FROM run_steps WHERE prompt_id=?`).get(promptId);
    if (!row || (row.ownerId === null && row.generation === null)) return null;
    if (row.ownerId === null || row.generation === null || row.input === null) throw new RunConflictError("Incomplete media submission attribution");
    const binding = new SqliteAgentBindings(db).get(row.runId), {manifest} = readOriginalMediaParts(db,promptId);
    if (binding === null || manifest.parts.length === 0) throw new RunConflictError("Media submission lacks its immutable input records");
    return Object.freeze({version:1,runId:row.runId,promptId,generation:row.generation,executionOwnerId:row.ownerId,binding,
      inputSha256:createHash("sha256").update(row.input,"utf8").digest("hex"),media:manifest});
  })();
}

/** Reuse the same active-claim, persisted-purpose, context and transaction boundary as every ordinary run write. */
class MediaSubmissionWriter extends SqliteRunAggregate {
  constructor(db: Database, private readonly owner: ExecutionOwnerLease, logger: Logger) { super(db,logger); }
  record(claim: Claim, prompt: MediaSubmissionPrompt): RecordedMediaSubmission {
    return this.guardedExecution("record media submission",claim,(run,visible) => {
      this.owner.assertRegistered(this.db);
      if ((run.kind !== "weave" && run.kind !== "evolve") || this.weavePurpose(run) !== "ordinary") throw new RunForbiddenError();
      const step = this.currentStep(run.id);
      if (step.input === null || step.envelope !== null || step.result !== null || run.nativeState !== "unknown") {
        throw new RunConflictError("Media submission requires its current sealed input");
      }
      this.confirmMediaInput(run,step,step.input,visible);
      const {manifest} = readOriginalMediaParts(this.db,step.promptId);
      if (manifest.parts.length === 0) throw new RunConflictError("Media submission requires persisted parts");
      let supplied: string;
      try { supplied = protocolJson(prompt); }
      catch { throw new RunConflictError("Invalid media submission identity"); }
      if (supplied !== protocolJson({promptId:step.promptId,input:step.input,media:manifest})) {
        throw new RunConflictError("Media submission differs from the exact retained input and parts");
      }
      const retained = readMediaSubmission(this.db,step.promptId);
      if (retained !== null) {
        if (retained.executionOwnerId !== this.owner.id || retained.generation !== claim.generation) throw new RunFenceError();
        if (!["submitting","uncertain"].includes(run.status) || !["submitting","uncertain"].includes(step.state)) {
          throw new RunConflictError("Retained media intent cannot authorize a new dispatch");
        }
        this.owner.assertRegistered(this.db);
        return {authorization:retained,replayed:true};
      }
      if (run.status !== "queued" || step.state !== "prepared") throw new RunConflictError("Media input was already submitted without qualified intent");
      this.db.run(`UPDATE run_steps SET state='submitting',media_submit_owner_id=?,media_submit_generation=?
        WHERE run_id=? AND prompt_id=?`,[this.owner.id,claim.generation,run.id,step.promptId]);
      this.db.run("UPDATE runs SET status='submitting' WHERE id=?",[run.id]);
      const authorization = readMediaSubmission(this.db,step.promptId);
      if (authorization === null) throw new RunConflictError("Media submission attribution was not retained");
      // Recheck inside the transaction after all writes, so lease loss at the final SQL boundary rolls back intent too.
      this.owner.assertRegistered(this.db);
      this.logger.info("[media submission] intent applied in transaction",{runId:run.id,promptId:step.promptId,generation:claim.generation,partCount:manifest.parts.length});
      return {authorization,replayed:false};
    });
  }
}
