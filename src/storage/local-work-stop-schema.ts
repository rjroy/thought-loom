import type { Database } from "bun:sqlite";

/** Independent identities deliberately survive the permitted purge of their original run. */
export function migrateLocalWorkStops(db:Database):void {
  db.exec(`CREATE TABLE IF NOT EXISTS local_work_stops (
    target_kind TEXT NOT NULL CHECK(target_kind IN ('run','import-file')), target_id TEXT NOT NULL,
    request_key TEXT NOT NULL, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)), stopped_at TEXT NOT NULL,
    run_id TEXT, import_file_id TEXT, PRIMARY KEY(target_kind,target_id),
    CHECK((target_kind='run' AND run_id=target_id) OR (target_kind='import-file' AND import_file_id=target_id))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS local_work_stops_run ON local_work_stops(run_id) WHERE run_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS local_work_stops_file ON local_work_stops(import_file_id) WHERE import_file_id IS NOT NULL;
  CREATE TRIGGER IF NOT EXISTS local_work_stops_no_update BEFORE UPDATE ON local_work_stops
    BEGIN SELECT RAISE(ABORT,'local stop immutable'); END;
  CREATE TRIGGER IF NOT EXISTS local_work_stops_no_delete BEFORE DELETE ON local_work_stops
    BEGIN SELECT RAISE(ABORT,'local stop immutable'); END;
  CREATE TRIGGER IF NOT EXISTS local_work_stops_no_replace BEFORE INSERT ON local_work_stops
    WHEN EXISTS(SELECT 1 FROM local_work_stops WHERE (target_kind=NEW.target_kind AND target_id=NEW.target_id)
      OR (run_id IS NOT NULL AND run_id=NEW.run_id) OR (import_file_id IS NOT NULL AND import_file_id=NEW.import_file_id))
    BEGIN SELECT RAISE(ABORT,'local stop immutable'); END;`);
}
