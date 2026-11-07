import type { Database } from "bun:sqlite";

/** Attribution on the canonical step journal, not a second prompt ledger or a fabricated delivery receipt. */
export function migrateMediaSubmissions(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(run_steps)").all();
  if (!columns.some(column => column.name === "media_submit_owner_id")) {
    db.exec("ALTER TABLE run_steps ADD COLUMN media_submit_owner_id TEXT REFERENCES execution_owners(id) CHECK(media_submit_owner_id IS NULL OR length(media_submit_owner_id)>0)");
  }
  if (!columns.some(column => column.name === "media_submit_generation")) {
    db.exec(`ALTER TABLE run_steps ADD COLUMN media_submit_generation INTEGER CHECK(media_submit_generation IS NULL
      OR (typeof(media_submit_generation)='integer' AND media_submit_generation>=0 AND media_submit_generation<=9007199254740991))`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS media_submission_no_preassignment BEFORE INSERT ON run_steps
    WHEN NEW.media_submit_owner_id IS NOT NULL OR NEW.media_submit_generation IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'media submission requires an existing sealed step'); END;
    DROP TRIGGER IF EXISTS media_submission_once;
    CREATE TRIGGER media_submission_once BEFORE UPDATE OF media_submit_owner_id,media_submit_generation ON run_steps
    WHEN OLD.media_submit_owner_id IS NOT NULL OR OLD.media_submit_generation IS NOT NULL
      OR NEW.media_submit_owner_id IS NULL OR NEW.media_submit_generation IS NULL OR NEW.submit_owner IS NOT NULL
      OR typeof(OLD.position)!='integer' OR OLD.position<0 OR OLD.position>9007199254740991
      OR OLD.state!='prepared' OR NEW.state!='submitting'
      OR OLD.input IS NULL OR NEW.input IS NOT OLD.input OR OLD.native_state!='unknown' OR NEW.native_state!='unknown'
      OR OLD.envelope_json IS NOT NULL OR NEW.envelope_json IS NOT NULL OR OLD.result_json IS NOT NULL OR NEW.result_json IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM runs run JOIN agent_bindings binding ON binding.run_id=run.id
        JOIN execution_owners owner ON owner.id=NEW.media_submit_owner_id
        LEFT JOIN thoughts subject ON subject.id=run.weave_subject_id
        LEFT JOIN thoughts contribution ON contribution.id=run.input_thought_id
        WHERE run.id=OLD.run_id AND run.status='queued' AND run.cancellation_state='none' AND run.generation=NEW.media_submit_generation
          AND NOT EXISTS(SELECT 1 FROM run_steps later WHERE later.run_id=run.id AND later.position>OLD.position)
          AND ((run.kind='weave' AND subject.kind!='media-original'
              AND NOT EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=subject.id))
            OR (run.kind='evolve' AND contribution.kind='user-contribution'
              AND NOT EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=contribution.id))))
      OR NOT EXISTS(SELECT 1 FROM run_media_parts WHERE prompt_id=OLD.prompt_id)
      OR (SELECT COUNT(*) FROM run_steps WHERE run_id=OLD.run_id AND position<OLD.position)!=OLD.position
      OR EXISTS(SELECT 1 FROM run_steps prior WHERE prior.run_id=OLD.run_id AND prior.position<OLD.position
        AND (prior.state!='processed' OR prior.native_state!='completed' OR prior.input IS NULL OR prior.result_json IS NULL
          OR CASE WHEN json_valid(prior.envelope_json) THEN json_extract(prior.envelope_json,'$.kind') IS NOT 'request' ELSE 1 END))
      OR EXISTS (
        SELECT 1 FROM run_media_parts part JOIN media_sources source ON source.id=part.source_id
        WHERE part.prompt_id=OLD.prompt_id AND (part.representation!='original' OR part.observed!=0
          OR part.prepared_key IS NOT NULL OR part.recipe_json IS NOT NULL
          OR part.mime_type!=source.mime_type OR part.byte_length!=source.byte_length OR part.sha256!=source.sha256
          OR EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=source.source_thought_id)
          OR NOT EXISTS(SELECT 1 FROM run_context WHERE run_id=OLD.run_id AND kind='thought' AND ref_id=source.source_thought_id)))
    BEGIN SELECT RAISE(ABORT,'media submission attribution requires its current eligible sealed step and processed history'); END;
  `);
}
