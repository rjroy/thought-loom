import type { Database } from "bun:sqlite";

/** Outside the public token alphabet, so no future user retry key can alias position zero. */
export const initialMediaAttemptRequestKey = "@initial";

/** Additive only. Core migrate owns the transaction, FK checks and preservation of predecessor data. */
export function migrateMediaAttempts(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_weave_attempts (
      source_id TEXT NOT NULL REFERENCES media_sources(id) CHECK(length(source_id)>0),
      position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0 AND position<=9007199254740991),
      run_id TEXT UNIQUE NOT NULL REFERENCES runs(id) CHECK(length(run_id)>0),
      request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128 AND length(trim(request_key))>0),
      open_slot INTEGER NOT NULL DEFAULT 1 CHECK(typeof(open_slot)='integer' AND open_slot IN (0,1)),
      interpretation_thought_id TEXT UNIQUE REFERENCES thoughts(id) CHECK(interpretation_thought_id IS NULL OR length(interpretation_thought_id)>0),
      failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('original-unavailable','unsupported-model-input',
        'media-transport-incompatible','conversion-unavailable','invalid-output','interpretation-missing',
        'processing-failed','interrupted','context-unavailable')),
      cleanup_state TEXT NOT NULL DEFAULT 'none' CHECK(cleanup_state IN ('none','pending','settled','ownership-conflict')),
      cleanup_identity_json TEXT CHECK(cleanup_identity_json IS NULL OR json_valid(cleanup_identity_json)),
      retry_evidence_json TEXT CHECK(retry_evidence_json IS NULL OR json_valid(retry_evidence_json)),
      PRIMARY KEY(source_id,position), UNIQUE(source_id,request_key),
      CHECK((cleanup_state='none')=(cleanup_identity_json IS NULL)),
      CHECK((cleanup_state='settled')=(retry_evidence_json IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_attempt_open_slot ON media_weave_attempts(source_id) WHERE open_slot=1;
    CREATE UNIQUE INDEX IF NOT EXISTS media_attempt_confirmed_interpretation ON media_weave_attempts(source_id) WHERE interpretation_thought_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS media_attempt_identity_immutable BEFORE UPDATE OF source_id,position,run_id,request_key ON media_weave_attempts
    BEGIN SELECT RAISE(ABORT,'media attempt identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS media_attempt_immutable_delete BEFORE DELETE ON media_weave_attempts
    BEGIN SELECT RAISE(ABORT,'media attempt history immutable'); END;
    CREATE TRIGGER IF NOT EXISTS media_attempt_no_replace BEFORE INSERT ON media_weave_attempts
    WHEN EXISTS(SELECT 1 FROM media_weave_attempts WHERE (source_id=NEW.source_id AND position=NEW.position)
      OR run_id=NEW.run_id OR (source_id=NEW.source_id AND request_key=NEW.request_key))
    BEGIN SELECT RAISE(ABORT,'media attempt identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS media_attempt_contiguous BEFORE INSERT ON media_weave_attempts
    WHEN NEW.position!=COALESCE((SELECT MAX(position)+1 FROM media_weave_attempts WHERE source_id=NEW.source_id),0)
    BEGIN SELECT RAISE(ABORT,'media attempts must follow source order'); END;
    CREATE TRIGGER IF NOT EXISTS media_attempt_admission_valid BEFORE INSERT ON media_weave_attempts
    WHEN NOT EXISTS (
      SELECT 1 FROM media_sources source JOIN thoughts thought ON thought.id=source.source_thought_id
      JOIN thought_titles title ON title.thought_id=thought.id JOIN thought_source_seals seal ON seal.thought_id=thought.id
      JOIN runs run ON run.id=NEW.run_id JOIN run_steps step ON step.run_id=run.id AND step.position=0
      WHERE source.id=NEW.source_id AND thought.kind='media-original' AND run.kind='weave'
        AND run.weave_subject_id=thought.id AND run.weave_trigger_id='media:'||source.id||':'||CAST(NEW.position AS TEXT)
        AND run.status='queued' AND run.generation=0 AND run.input_thought_id IS NULL
        AND step.prompt_id=run.prompt_id AND step.state='prepared' AND step.native_state='unknown'
        AND step.input IS NULL AND step.envelope_json IS NULL AND step.result_json IS NULL
        AND NOT EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=thought.id)
        AND NOT EXISTS(SELECT 1 FROM run_steps later WHERE later.run_id=run.id AND later.position!=0)
        AND NOT EXISTS(SELECT 1 FROM agent_bindings WHERE run_id=run.id)
        AND NOT EXISTS(SELECT 1 FROM run_context WHERE run_id=run.id)
        AND NOT EXISTS(SELECT 1 FROM run_operation_receipts WHERE run_id=run.id)
        AND NOT EXISTS(SELECT 1 FROM run_issued_thoughts WHERE run_id=run.id)
        AND NOT EXISTS(SELECT 1 FROM run_replies WHERE run_id=run.id))
    BEGIN SELECT RAISE(ABORT,'media attempt requires its untouched ordinary weave and source root'); END;
  `);
  // Admission still cannot preassign lifecycle facts. Terminal guards are installed after the part/submission journal exists.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS media_attempt_initial_only BEFORE INSERT ON media_weave_attempts
    WHEN NEW.position!=0 OR NEW.request_key!='${initialMediaAttemptRequestKey}' OR NEW.open_slot!=1
      OR NEW.interpretation_thought_id IS NOT NULL OR NEW.failure_code IS NOT NULL OR NEW.cleanup_state!='none'
      OR NEW.cleanup_identity_json IS NOT NULL OR NEW.retry_evidence_json IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'only initial media attempt admission is available'); END;
  `);
}
