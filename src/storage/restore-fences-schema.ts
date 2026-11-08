import type { Database } from "bun:sqlite";

/** Additive history metadata only. Execution enforcement is supplied by the offline-restore implementation. */
export function migrateRestoreFences(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS restore_fences (
      entity_kind TEXT NOT NULL CHECK(entity_kind IN ('run','import-batch','import-file','composer')),
      entity_id TEXT NOT NULL CHECK(length(entity_id)>0),
      snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
      restored_at TEXT NOT NULL CHECK(length(restored_at)>0),
      original_state_json TEXT NOT NULL CHECK(json_valid(original_state_json) AND json_type(original_state_json)='object'),
      PRIMARY KEY(entity_kind,entity_id)
    );
    CREATE TRIGGER IF NOT EXISTS restore_fences_immutable_update BEFORE UPDATE ON restore_fences
    BEGIN SELECT RAISE(ABORT,'restore fence immutable'); END;
    CREATE TRIGGER IF NOT EXISTS restore_fences_immutable_delete BEFORE DELETE ON restore_fences
    BEGIN SELECT RAISE(ABORT,'restore fence immutable'); END;
    CREATE TRIGGER IF NOT EXISTS restore_fences_no_replace BEFORE INSERT ON restore_fences
    WHEN EXISTS(SELECT 1 FROM restore_fences WHERE rowid=NEW.rowid OR (entity_kind=NEW.entity_kind AND entity_id=NEW.entity_id))
    BEGIN SELECT RAISE(ABORT,'restore fence cannot be replaced'); END;
  `);
}
