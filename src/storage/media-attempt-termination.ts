import type { Database } from "bun:sqlite";
import { RunConflictError } from "../domain/run";
import type { Logger } from "../logging";

export type MediaInterruptionReason = "stopped" | "context-invalidated" | "failed";
const failureCodes = { stopped: "interrupted", "context-invalidated": "context-unavailable", failed: "processing-failed" } as const;

/** This cycle admits only the complete, untouched initial journal. Never invent a null hash for prepared history. */
function queuedSeal(sourceId: string, runId: string): string {
  return `(SELECT json_object('version',1,'sourceId',${sourceId},'runId',run.id,
    'fencedGeneration',run.generation,'binding',NULL,'steps',json_array(json_object(
      'position',step.position,'promptId',step.prompt_id,'inputSha256',NULL,'parts',json_array(),
      'authorization','never-authorized')))
    FROM runs run JOIN run_steps step ON step.run_id=run.id AND step.position=0 WHERE run.id=${runId})`;
}

/** Install after part/submission migrations: the guards inspect the canonical journal, not another lifecycle ledger. */
export function migrateMediaAttemptTermination(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS media_attempt_transitions_unavailable;
    CREATE TRIGGER IF NOT EXISTS media_attempt_terminal_transition BEFORE UPDATE OF open_slot,interpretation_thought_id,
      failure_code,cleanup_state,cleanup_identity_json,retry_evidence_json ON media_weave_attempts
    WHEN NOT (OLD.cleanup_state='pending' AND NEW.open_slot IS OLD.open_slot
        AND NEW.interpretation_thought_id IS OLD.interpretation_thought_id AND NEW.failure_code IS OLD.failure_code
        AND NEW.cleanup_state IS OLD.cleanup_state AND NEW.cleanup_identity_json IS OLD.cleanup_identity_json
        AND NEW.retry_evidence_json IS OLD.retry_evidence_json)
      AND (OLD.open_slot!=1 OR OLD.interpretation_thought_id IS NOT NULL OR OLD.failure_code IS NOT NULL
        OR OLD.cleanup_state!='none' OR OLD.cleanup_identity_json IS NOT NULL OR OLD.retry_evidence_json IS NOT NULL
        OR NEW.open_slot!=0 OR NEW.interpretation_thought_id IS NOT NULL OR NEW.cleanup_state!='pending'
        OR COALESCE(NEW.failure_code,'') NOT IN ('interrupted','context-unavailable','processing-failed')
        OR NEW.retry_evidence_json IS NOT NULL
        OR NEW.cleanup_identity_json IS NOT ${queuedSeal("NEW.source_id", "NEW.run_id")}
        OR NOT EXISTS (
          SELECT 1 FROM runs run JOIN media_sources source ON source.id=NEW.source_id
          JOIN thoughts root ON root.id=source.source_thought_id
          JOIN run_steps step ON step.run_id=run.id AND step.position=0
          WHERE run.id=NEW.run_id AND run.kind='weave' AND root.kind='media-original'
            AND run.weave_subject_id=root.id AND run.weave_trigger_id='media:'||source.id||':'||CAST(NEW.position AS TEXT)
            AND run.status IN ('interrupted','failed') AND run.cancellation_state='pending'
            AND typeof(run.generation)='integer' AND run.generation BETWEEN 1 AND 9007199254740991
            AND run.input_thought_id IS NULL AND step.prompt_id=run.prompt_id
            AND step.state='prepared' AND step.native_state='unknown' AND step.input IS NULL
            AND step.envelope_json IS NULL AND step.result_json IS NULL AND step.submit_owner IS NULL
            AND step.media_submit_owner_id IS NULL AND step.media_submit_generation IS NULL
            AND (SELECT COUNT(*) FROM run_steps WHERE run_id=run.id)=1
            AND NOT EXISTS(SELECT 1 FROM agent_bindings WHERE run_id=run.id)
            AND NOT EXISTS(SELECT 1 FROM run_media_parts part JOIN run_steps owner ON owner.prompt_id=part.prompt_id WHERE owner.run_id=run.id)
            AND NOT EXISTS(SELECT 1 FROM run_context WHERE run_id=run.id)
            AND NOT EXISTS(SELECT 1 FROM run_operation_receipts WHERE run_id=run.id)
            AND NOT EXISTS(SELECT 1 FROM run_issued_thoughts WHERE run_id=run.id)
            AND NOT EXISTS(SELECT 1 FROM run_replies WHERE run_id=run.id)))
    BEGIN SELECT RAISE(ABORT,'media termination requires its complete untouched journal and pending terminal fence'); END;

    CREATE TRIGGER IF NOT EXISTS media_attempt_sealed_run BEFORE UPDATE OF status,generation ON runs
    WHEN EXISTS(SELECT 1 FROM media_weave_attempts WHERE run_id=OLD.id AND cleanup_identity_json IS NOT NULL)
      AND (NEW.generation IS NOT OLD.generation OR NEW.status NOT IN ('interrupted','failed'))
    BEGIN SELECT RAISE(ABORT,'sealed media attempt cannot resume execution'); END;
    CREATE TRIGGER IF NOT EXISTS media_attempt_sealed_step_insert BEFORE INSERT ON run_steps
    WHEN EXISTS(SELECT 1 FROM media_weave_attempts WHERE run_id=NEW.run_id AND cleanup_identity_json IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'sealed media attempt history immutable'); END;
    CREATE TRIGGER IF NOT EXISTS media_attempt_sealed_step_update BEFORE UPDATE ON run_steps
    WHEN EXISTS(SELECT 1 FROM media_weave_attempts WHERE run_id=OLD.run_id AND cleanup_identity_json IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'sealed media attempt history immutable'); END;
    CREATE TRIGGER IF NOT EXISTS media_attempt_sealed_binding BEFORE INSERT ON agent_bindings
    WHEN EXISTS(SELECT 1 FROM media_weave_attempts WHERE run_id=NEW.run_id AND cleanup_identity_json IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'sealed media attempt cannot acquire a binding'); END;
    CREATE TRIGGER IF NOT EXISTS media_attempt_sealed_receipt BEFORE INSERT ON run_operation_receipts
    WHEN EXISTS(SELECT 1 FROM media_weave_attempts WHERE run_id=NEW.run_id AND cleanup_identity_json IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'sealed media attempt cannot publish a late operation'); END;
  `);
}

/** Join finalInterrupt's existing immediate transaction. No execution, observation, settlement or file access. */
export function sealQueuedMediaAttempt(db: Database, runId: string, previousGeneration: number,
  reason: MediaInterruptionReason, logger: Logger): void {
  if (!db.inTransaction) throw new RunConflictError("Media termination requires its run-fence transaction");
  const attempt = db.query<{ sourceId: string }, [string]>("SELECT source_id AS sourceId FROM media_weave_attempts WHERE run_id=?").get(runId);
  if (attempt === null) return;
  const fencedGeneration = previousGeneration + 1;
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 0 || !Number.isSafeInteger(fencedGeneration)) {
    throw new RunConflictError("Invalid media termination generation");
  }
  const result = db.query(`UPDATE media_weave_attempts SET open_slot=0,failure_code=?,cleanup_state='pending',
    cleanup_identity_json=${queuedSeal("media_weave_attempts.source_id", "media_weave_attempts.run_id")}
    WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND generation=?)`)
    .run(failureCodes[reason],runId,runId,fencedGeneration);
  if (result.changes !== 1) throw new RunConflictError("Media termination differs from its run fence");
  logger.info("[media attempt] termination sealed in transaction", { sourceId: attempt.sourceId, runId, fencedGeneration, failureCode: failureCodes[reason] });
}
