import type { Database } from "bun:sqlite";

/** Additive fingerprint journal only. Core migration owns the transaction; no original bytes are stored here. */
export function migrateRunMediaParts(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_media_parts (
      prompt_id TEXT NOT NULL REFERENCES run_steps(prompt_id) CHECK(length(prompt_id)>0),
      position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0 AND position<=9007199254740991),
      source_id TEXT NOT NULL REFERENCES media_sources(id) CHECK(length(source_id)>0),
      representation TEXT NOT NULL CHECK(representation IN ('original','derived')),
      mime_type TEXT NOT NULL CHECK(length(trim(mime_type))>0),
      byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length>0 AND byte_length<=9007199254740991),
      sha256 BLOB NOT NULL CHECK(typeof(sha256)='blob' AND length(sha256)=32),
      prepared_key TEXT UNIQUE,
      recipe_json TEXT CHECK(recipe_json IS NULL OR json_valid(recipe_json)),
      observed INTEGER NOT NULL DEFAULT 0 CHECK(typeof(observed)='integer' AND observed IN (0,1)),
      PRIMARY KEY(prompt_id,position),
      CHECK((representation='original' AND prepared_key IS NULL AND recipe_json IS NULL)
        OR (representation='derived' AND prepared_key IS NOT NULL AND length(trim(prepared_key))>0 AND recipe_json IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS run_media_parts_payload_immutable BEFORE UPDATE OF prompt_id,position,source_id,
      representation,mime_type,byte_length,sha256,prepared_key,recipe_json ON run_media_parts
    BEGIN SELECT RAISE(ABORT,'media part identity and payload immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_media_parts_immutable_delete BEFORE DELETE ON run_media_parts
    BEGIN SELECT RAISE(ABORT,'media part history immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_media_parts_no_replace BEFORE INSERT ON run_media_parts
    WHEN EXISTS(SELECT 1 FROM run_media_parts WHERE (prompt_id=NEW.prompt_id AND position=NEW.position)
      OR (NEW.prepared_key IS NOT NULL AND prepared_key=NEW.prepared_key))
    BEGIN SELECT RAISE(ABORT,'media part identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_media_parts_contiguous BEFORE INSERT ON run_media_parts
    WHEN NEW.position!=COALESCE((SELECT MAX(position)+1 FROM run_media_parts WHERE prompt_id=NEW.prompt_id),0)
    BEGIN SELECT RAISE(ABORT,'media parts must follow prompt order'); END;
    CREATE TRIGGER IF NOT EXISTS run_media_parts_owner_valid BEFORE INSERT ON run_media_parts
    WHEN NOT EXISTS (
      SELECT 1 FROM run_steps step JOIN runs run ON run.id=step.run_id
      LEFT JOIN thoughts subject ON subject.id=run.weave_subject_id
      LEFT JOIN thoughts contribution ON contribution.id=run.input_thought_id
      WHERE step.prompt_id=NEW.prompt_id AND run.status='queued' AND run.cancellation_state='none'
        AND step.state='prepared' AND step.native_state='unknown' AND step.input IS NULL
        AND step.envelope_json IS NULL AND step.result_json IS NULL
        AND NOT EXISTS(SELECT 1 FROM run_steps later WHERE later.run_id=run.id AND later.position>step.position)
        AND ((run.kind='weave' AND subject.kind!='media-original'
            AND NOT EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=subject.id))
          OR (run.kind='evolve' AND contribution.kind='user-contribution'
            AND NOT EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=contribution.id))))
    BEGIN SELECT RAISE(ABORT,'media parts require current unsealed ordinary Weaver or Evolve input'); END;
    CREATE TRIGGER IF NOT EXISTS run_media_parts_original_valid BEFORE INSERT ON run_media_parts
    WHEN NEW.representation='original' AND NOT EXISTS (
      SELECT 1 FROM media_sources source JOIN thoughts thought ON thought.id=source.source_thought_id
      JOIN thought_titles title ON title.thought_id=thought.id JOIN thought_source_seals seal ON seal.thought_id=thought.id
      WHERE source.id=NEW.source_id AND thought.kind='media-original'
        AND source.mime_type=NEW.mime_type AND source.byte_length=NEW.byte_length AND source.sha256=NEW.sha256
        AND NOT EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=thought.id))
    BEGIN SELECT RAISE(ABORT,'original media part requires its eligible exact source fingerprint'); END;
    -- A representation recipe is not proof of preparation; no derived writer is authorized yet.
    CREATE TRIGGER IF NOT EXISTS run_media_parts_derived_unavailable BEFORE INSERT ON run_media_parts
    WHEN NEW.representation!='original'
    BEGIN SELECT RAISE(ABORT,'derived media parts require verified preparation authority'); END;
    -- Descriptor reads, preparation and submission intent are not correlated binary admission/history evidence.
    CREATE TRIGGER IF NOT EXISTS run_media_parts_observation_insert BEFORE INSERT ON run_media_parts
    WHEN NEW.observed!=0
    BEGIN SELECT RAISE(ABORT,'media observation requires correlated delivery evidence'); END;
    CREATE TRIGGER IF NOT EXISTS run_media_parts_observation_unavailable BEFORE UPDATE OF observed ON run_media_parts
    BEGIN SELECT RAISE(ABORT,'media observation requires correlated delivery evidence'); END;
  `);
}
