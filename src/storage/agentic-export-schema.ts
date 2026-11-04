import type { Database } from "bun:sqlite";

/** Subordinate artifact storage only. The authoritative core migration owns initialization and its transaction. */
export function migrateAgenticExports(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS export_intents (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
      request TEXT NOT NULL CHECK (length(trim(request))>0),
      effort TEXT NOT NULL DEFAULT 'standard' CHECK (effort IN ('quick','standard','thorough'))
    );
    CREATE TRIGGER IF NOT EXISTS export_intents_kind BEFORE INSERT ON export_intents
    WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id=NEW.run_id AND kind='export')
    BEGIN SELECT RAISE(ABORT,'export intent requires an export run'); END;
    CREATE TRIGGER IF NOT EXISTS export_intents_immutable_insert BEFORE INSERT ON export_intents
    WHEN EXISTS (SELECT 1 FROM export_intents WHERE run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'export intent immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_intents_immutable_update BEFORE UPDATE ON export_intents
    BEGIN SELECT RAISE(ABORT,'export intent immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_intents_immutable_delete BEFORE DELETE ON export_intents
    BEGIN SELECT RAISE(ABORT,'export intent immutable'); END;
    CREATE TABLE IF NOT EXISTS export_reports (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES export_intents(run_id),
      prompt_id TEXT NOT NULL, markdown TEXT NOT NULL CHECK (length(trim(markdown))>0), sources_json TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS export_reports_step_identity BEFORE INSERT ON export_reports
    WHEN NOT EXISTS (SELECT 1 FROM run_steps WHERE run_id=NEW.run_id AND prompt_id=NEW.prompt_id
      AND state='completed' AND json_extract(envelope_json,'$.kind')='report')
    BEGIN SELECT RAISE(ABORT,'export report requires its completed report step'); END;
    CREATE TRIGGER IF NOT EXISTS export_reports_immutable_insert BEFORE INSERT ON export_reports
    WHEN EXISTS (SELECT 1 FROM export_reports WHERE run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'export report immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_reports_immutable_update BEFORE UPDATE ON export_reports
    BEGIN SELECT RAISE(ABORT,'export report immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_reports_immutable_delete BEFORE DELETE ON export_reports
    BEGIN SELECT RAISE(ABORT,'export report immutable'); END;
  `);
}
