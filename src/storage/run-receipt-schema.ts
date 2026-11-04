import type { Database } from "bun:sqlite";

function createTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_operation_receipts (
      run_id TEXT NOT NULL REFERENCES runs(id), operation_id TEXT NOT NULL, operation_json TEXT NOT NULL,
      thought_id TEXT REFERENCES thoughts(id), result_json TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'legacy' CHECK (format IN ('legacy','step')),
      PRIMARY KEY (run_id,operation_id), UNIQUE (run_id,operation_id,thought_id),
      CHECK (format != 'legacy' OR thought_id IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS run_issued_thoughts (
      run_id TEXT NOT NULL REFERENCES runs(id), operation_id TEXT NOT NULL, thought_id TEXT NOT NULL REFERENCES thoughts(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (run_id,position), UNIQUE (run_id,operation_id), UNIQUE (run_id,thought_id),
      FOREIGN KEY (run_id,operation_id,thought_id) REFERENCES run_operation_receipts(run_id,operation_id,thought_id)
    );
  `);
}

/** Runs only inside the authoritative core migration transaction, with foreign keys enabled throughout. */
export function migrateRunReceipts(db: Database): void {
  const columns = db.query("PRAGMA table_info(run_operation_receipts)").all() as { name: string; notnull: number }[];
  const hasIssued = db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='run_issued_thoughts'").get() !== null;
  const hasFormat = columns.some(column => column.name === "format");
  if (columns.length && (!hasFormat || columns.some(column => column.name === "thought_id" && column.notnull === 1))) {
    // Rebuild the referencing pair together. Renaming keeps the old pair's foreign keys intact until the child is dropped.
    if (hasIssued) db.exec("ALTER TABLE run_issued_thoughts RENAME TO run_issued_thoughts_legacy");
    db.exec("ALTER TABLE run_operation_receipts RENAME TO run_operation_receipts_legacy");
    createTables(db);
    db.exec(`INSERT INTO run_operation_receipts (rowid,run_id,operation_id,operation_json,thought_id,result_json,format)
      SELECT rowid,run_id,operation_id,operation_json,thought_id,result_json,${hasFormat ? "format" : "'legacy'"}
      FROM run_operation_receipts_legacy ORDER BY rowid`);
    if (hasIssued) {
      db.exec(`INSERT INTO run_issued_thoughts (run_id,operation_id,thought_id,position)
        SELECT run_id,operation_id,thought_id,position FROM run_issued_thoughts_legacy;
        DROP TABLE run_issued_thoughts_legacy;`);
    }
    db.exec("DROP TABLE run_operation_receipts_legacy");
  } else createTables(db);
  if (!hasIssued) {
    db.exec(`INSERT INTO run_issued_thoughts (run_id,operation_id,thought_id,position)
      SELECT run_id,operation_id,thought_id,ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY rowid)-1
      FROM run_operation_receipts WHERE thought_id IS NOT NULL`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS run_receipts_immutable_update BEFORE UPDATE ON run_operation_receipts
    BEGIN SELECT RAISE(ABORT,'receipt immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_receipts_immutable_delete BEFORE DELETE ON run_operation_receipts
    BEGIN SELECT RAISE(ABORT,'receipt immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_receipts_step_identity BEFORE INSERT ON run_operation_receipts
    WHEN NEW.format='step' AND NOT EXISTS (SELECT 1 FROM run_steps WHERE run_id=NEW.run_id AND prompt_id=NEW.operation_id)
    BEGIN SELECT RAISE(ABORT,'step receipt must identify a persisted prompt'); END;
    CREATE TRIGGER IF NOT EXISTS run_issued_immutable_update BEFORE UPDATE ON run_issued_thoughts
    BEGIN SELECT RAISE(ABORT,'issued membership immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_issued_immutable_delete BEFORE DELETE ON run_issued_thoughts
    BEGIN SELECT RAISE(ABORT,'issued membership immutable'); END;
  `);
}
