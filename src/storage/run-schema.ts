import type { Database } from "bun:sqlite";

/** Schema-only helper. The authoritative core migration owns its transaction and connection setup. */
export function migrateRunSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('weave','evolve','export')),
      status TEXT NOT NULL CHECK (status IN ('queued','submitting','running','uncertain','completed','interrupted','failed')),
      session_id TEXT UNIQUE NOT NULL,
      prompt_id TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      input_thought_id TEXT REFERENCES thoughts(id),
      native_state TEXT NOT NULL DEFAULT 'unknown' CHECK (native_state IN ('unknown','running','completed')),
      CHECK ((kind = 'evolve') = (input_thought_id IS NOT NULL))
    );
  `);
  const columns = db.query("PRAGMA table_info(runs)").all() as { name: string }[];
  // Earlier run rows did not retain input identity. Leave those unknown, never infer it from content or ancestry.
  if (!columns.some(column => column.name === "input_thought_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN input_thought_id TEXT REFERENCES thoughts(id)");
  }
  if (!columns.some(column => column.name === "native_state")) {
    db.exec("ALTER TABLE runs ADD COLUMN native_state TEXT NOT NULL DEFAULT 'unknown' CHECK (native_state IN ('unknown','running','completed'))");
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS runs_identity_immutable BEFORE UPDATE OF id, kind, session_id, prompt_id, created_at ON runs
    BEGIN SELECT RAISE(ABORT,'run identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS runs_input_immutable BEFORE UPDATE OF input_thought_id ON runs
    BEGIN SELECT RAISE(ABORT,'run input immutable'); END;
    CREATE TRIGGER IF NOT EXISTS runs_input_required BEFORE INSERT ON runs
    WHEN (NEW.kind = 'evolve') != (NEW.input_thought_id IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'run input required for evolve only'); END;
    CREATE TRIGGER IF NOT EXISTS runs_native_completion_durable BEFORE UPDATE OF native_state ON runs
    WHEN OLD.native_state = 'completed' AND NEW.native_state != 'completed'
    BEGIN SELECT RAISE(ABORT,'native completion evidence immutable'); END;
    CREATE TRIGGER IF NOT EXISTS runs_immutable_delete BEFORE DELETE ON runs
    BEGIN SELECT RAISE(ABORT,'run immutable'); END;
    CREATE TABLE IF NOT EXISTS run_context (
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL CHECK (kind IN ('thought','connection','response')),
      ref_id TEXT NOT NULL,
      PRIMARY KEY (run_id,kind,ref_id)
    );
    CREATE TABLE IF NOT EXISTS run_operation_receipts (
      run_id TEXT NOT NULL REFERENCES runs(id), operation_id TEXT NOT NULL, operation_json TEXT NOT NULL,
      thought_id TEXT NOT NULL REFERENCES thoughts(id), result_json TEXT NOT NULL,
      PRIMARY KEY (run_id,operation_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS run_receipt_result ON run_operation_receipts (run_id,operation_id,thought_id);
    CREATE TRIGGER IF NOT EXISTS run_receipts_immutable_update BEFORE UPDATE ON run_operation_receipts
    BEGIN SELECT RAISE(ABORT,'receipt immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_receipts_immutable_delete BEFORE DELETE ON run_operation_receipts
    BEGIN SELECT RAISE(ABORT,'receipt immutable'); END;
    CREATE TABLE IF NOT EXISTS run_replies (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id), draft_json TEXT, response_id TEXT REFERENCES responses(id)
    );
  `);
  const hasIssued = db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='run_issued_thoughts'").get() !== null;
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_issued_thoughts (
      run_id TEXT NOT NULL REFERENCES runs(id), operation_id TEXT NOT NULL, thought_id TEXT NOT NULL REFERENCES thoughts(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (run_id,position), UNIQUE (run_id,operation_id), UNIQUE (run_id,thought_id),
      FOREIGN KEY (run_id,operation_id,thought_id) REFERENCES run_operation_receipts(run_id,operation_id,thought_id)
    );
  `);
  if (!hasIssued) {
    // Legacy receipts were inserted synchronously in commit order. Preserve that persisted order, not IDs or timestamps.
    db.exec(`INSERT INTO run_issued_thoughts (run_id,operation_id,thought_id,position)
      SELECT run_id,operation_id,thought_id,ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY rowid)-1 FROM run_operation_receipts`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS run_issued_immutable_update BEFORE UPDATE ON run_issued_thoughts
    BEGIN SELECT RAISE(ABORT,'issued membership immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_issued_immutable_delete BEFORE DELETE ON run_issued_thoughts
    BEGIN SELECT RAISE(ABORT,'issued membership immutable'); END;
  `);
}
