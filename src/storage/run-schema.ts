import type { Database } from "bun:sqlite";
import { migrateRunReceipts } from "./run-receipt-schema";

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
      weave_subject_id TEXT REFERENCES thoughts(id), weave_trigger_id TEXT,
      cancellation_state TEXT NOT NULL DEFAULT 'none' CHECK (cancellation_state IN ('none','pending','settled')),
      CHECK ((kind = 'evolve') = (input_thought_id IS NOT NULL)),
      CHECK ((weave_subject_id IS NULL) = (weave_trigger_id IS NULL)),
      CHECK (weave_subject_id IS NULL OR kind = 'weave')
    );
  `);
  const columns = db.query("PRAGMA table_info(runs)").all() as { name: string }[];
  // Earlier run rows did not retain input identity. Leave those unknown, never infer it from content or ancestry.
  if (!columns.some(column => column.name === "input_thought_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN input_thought_id TEXT REFERENCES thoughts(id)");
  }
  if (!columns.some(column => column.name === "cancellation_state")) {
    db.exec("ALTER TABLE runs ADD COLUMN cancellation_state TEXT NOT NULL DEFAULT 'none' CHECK (cancellation_state IN ('none','pending','settled'))");
    db.exec("UPDATE runs SET cancellation_state='pending' WHERE status='interrupted'");
  }
  if (!columns.some(column => column.name === "weave_subject_id")) db.exec("ALTER TABLE runs ADD COLUMN weave_subject_id TEXT REFERENCES thoughts(id)");
  if (!columns.some(column => column.name === "weave_trigger_id")) db.exec("ALTER TABLE runs ADD COLUMN weave_trigger_id TEXT");
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS runs_identity_immutable BEFORE UPDATE OF id, kind, session_id, prompt_id, created_at ON runs
    BEGIN SELECT RAISE(ABORT,'run identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS runs_input_immutable BEFORE UPDATE OF input_thought_id ON runs
    BEGIN SELECT RAISE(ABORT,'run input immutable'); END;
    CREATE TRIGGER IF NOT EXISTS runs_input_required BEFORE INSERT ON runs
    WHEN (NEW.kind = 'evolve') != (NEW.input_thought_id IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'run input required for evolve only'); END;
    CREATE TRIGGER IF NOT EXISTS runs_weave_intent_immutable BEFORE UPDATE OF weave_subject_id,weave_trigger_id ON runs
    BEGIN SELECT RAISE(ABORT,'weave intent immutable'); END;
    CREATE TRIGGER IF NOT EXISTS runs_weave_intent_valid BEFORE INSERT ON runs
    WHEN (NEW.weave_subject_id IS NULL) != (NEW.weave_trigger_id IS NULL) OR (NEW.weave_subject_id IS NOT NULL AND NEW.kind != 'weave')
    BEGIN SELECT RAISE(ABORT,'invalid weave intent'); END;
    -- Preserve all legacy duplicate jobs and their immutable histories. Prevent every future duplicate pair instead.
    CREATE INDEX IF NOT EXISTS runs_weave_trigger_lookup ON runs(weave_subject_id,weave_trigger_id) WHERE kind='weave';
    CREATE TRIGGER IF NOT EXISTS runs_weave_trigger_unique BEFORE INSERT ON runs
    WHEN NEW.kind='weave' AND NEW.weave_subject_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM runs WHERE kind='weave' AND weave_subject_id=NEW.weave_subject_id AND weave_trigger_id=NEW.weave_trigger_id)
    BEGIN SELECT RAISE(ABORT,'UNIQUE constraint failed: runs.weave_subject_id, runs.weave_trigger_id'); END;
    CREATE TRIGGER IF NOT EXISTS runs_immutable_delete BEFORE DELETE ON runs
    BEGIN SELECT RAISE(ABORT,'run immutable'); END;
    CREATE TABLE IF NOT EXISTS run_context (
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL CHECK (kind IN ('thought','connection','response')),
      ref_id TEXT NOT NULL,
      full_read INTEGER NOT NULL DEFAULT 0 CHECK (full_read IN (0,1)),
      PRIMARY KEY (run_id,kind,ref_id)
    );
    CREATE TABLE IF NOT EXISTS run_replies (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id), draft_json TEXT, response_id TEXT REFERENCES responses(id)
    );
  `);
  // Earlier exposure rows did not distinguish snippets from full reads. Do not invent evidence for them.
  const contextColumns = db.query("PRAGMA table_info(run_context)").all() as { name: string }[];
  if (!contextColumns.some(column => column.name === "full_read")) db.exec("ALTER TABLE run_context ADD COLUMN full_read INTEGER NOT NULL DEFAULT 0 CHECK (full_read IN (0,1))");
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS run_context_identity_immutable BEFORE UPDATE OF run_id,kind,ref_id ON run_context
    BEGIN SELECT RAISE(ABORT,'context identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_context_witness_durable BEFORE UPDATE OF full_read ON run_context
    WHEN NEW.full_read < OLD.full_read
    BEGIN SELECT RAISE(ABORT,'full read witness immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_context_immutable_delete BEFORE DELETE ON run_context
    BEGIN SELECT RAISE(ABORT,'exposed context immutable'); END;
  `);
  migrateSteps(db,columns.some(column => column.name === "native_state"));
  migrateRunReceipts(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_bindings (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id), session_id TEXT UNIQUE NOT NULL,
      service_url TEXT NOT NULL, directory TEXT NOT NULL, model_json TEXT NOT NULL, permissions_json TEXT NOT NULL,
      protocol_version INTEGER NOT NULL CHECK (protocol_version=1)
    );
    CREATE TRIGGER IF NOT EXISTS agent_bindings_immutable_update BEFORE UPDATE ON agent_bindings
    BEGIN SELECT RAISE(ABORT,'agent binding immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_bindings_immutable_delete BEFORE DELETE ON agent_bindings
    BEGIN SELECT RAISE(ABORT,'agent binding immutable'); END;
  `);
}

function migrateSteps(db: Database, hasLegacyNativeState: boolean): void {
  const schema = db.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='run_steps'").get() as { sql: string } | null;
  const stagedResults = schema !== null && /CHECK\s*\(\s*result_json\s+IS\s+NULL\s+OR\s+state\s*=\s*'processed'\s*\)/i.test(schema.sql);
  if (stagedResults) {
    // Only the old CHECK changes: a completed request may now retain its dispatched result before successor preparation.
    // No table has an FK to run_steps; the two cross-table triggers are recreated below and by migrateRunReceipts.
    db.exec(`DROP TRIGGER IF EXISTS runs_prepare_initial_step; DROP TRIGGER IF EXISTS run_receipts_step_identity;
      ALTER TABLE run_steps RENAME TO run_steps_legacy;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_steps (
      run_id TEXT NOT NULL REFERENCES runs(id), position INTEGER NOT NULL CHECK (position >= 0),
      prompt_id TEXT UNIQUE NOT NULL, input TEXT CHECK (input IS NULL OR length(input) > 0),
      state TEXT NOT NULL CHECK (state IN ('prepared','submitting','uncertain','completed','processed')),
      native_state TEXT NOT NULL DEFAULT 'unknown' CHECK (native_state IN ('unknown','running','completed')),
      envelope_json TEXT, result_json TEXT,
      PRIMARY KEY (run_id,position),
      CHECK (state != 'processed' OR (envelope_json IS NOT NULL AND result_json IS NOT NULL)),
      CHECK (envelope_json IS NULL OR state IN ('completed','processed')),
      CHECK (result_json IS NULL OR (state IN ('completed','processed') AND envelope_json IS NOT NULL)),
      CHECK ((native_state = 'completed') = (state IN ('completed','processed')))
    );
  `);
  if (stagedResults) db.exec(`INSERT INTO run_steps (rowid,run_id,position,prompt_id,input,state,native_state,envelope_json,result_json)
    SELECT rowid,run_id,position,prompt_id,input,state,native_state,envelope_json,result_json FROM run_steps_legacy ORDER BY rowid;
    DROP TABLE run_steps_legacy;`);
  // The legacy column is moved, not reset. Each later prompt starts with its own unknown native evidence.
  const native = hasLegacyNativeState ? "r.native_state" : "'unknown'";
  db.exec(`INSERT INTO run_steps (run_id,position,prompt_id,input,state,native_state)
    SELECT r.id,0,r.prompt_id,NULL,
      CASE WHEN ${native}='completed' THEN 'completed'
        WHEN ${native}='running' OR r.status IN ('submitting','running') THEN 'submitting'
        WHEN r.status IN ('uncertain','interrupted') THEN 'uncertain' ELSE 'prepared' END,
      ${native} FROM runs r WHERE NOT EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id=r.id)`);
  if (hasLegacyNativeState) {
    db.exec("DROP TRIGGER IF EXISTS runs_native_completion_durable; ALTER TABLE runs DROP COLUMN native_state");
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS runs_prepare_initial_step AFTER INSERT ON runs BEGIN
      INSERT INTO run_steps (run_id,position,prompt_id,state,native_state) VALUES (NEW.id,0,NEW.prompt_id,'prepared','unknown');
    END;
    CREATE TRIGGER IF NOT EXISTS run_steps_ordered_insert BEFORE INSERT ON run_steps
    WHEN NEW.position != COALESCE((SELECT MAX(position)+1 FROM run_steps WHERE run_id=NEW.run_id),0)
      OR (NEW.position=0 AND NEW.prompt_id != (SELECT prompt_id FROM runs WHERE id=NEW.run_id))
    BEGIN SELECT RAISE(ABORT,'steps must follow issued order'); END;
    CREATE TRIGGER IF NOT EXISTS run_steps_identity_immutable BEFORE UPDATE OF run_id,position,prompt_id ON run_steps
    BEGIN SELECT RAISE(ABORT,'step identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_steps_input_immutable BEFORE UPDATE OF input ON run_steps
    WHEN OLD.input IS NOT NULL OR NEW.input IS NULL OR OLD.state != 'prepared' OR OLD.native_state != 'unknown'
    BEGIN SELECT RAISE(ABORT,'step input immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_steps_envelope_immutable BEFORE UPDATE OF envelope_json ON run_steps
    WHEN OLD.envelope_json IS NOT NULL AND NEW.envelope_json IS NOT OLD.envelope_json
    BEGIN SELECT RAISE(ABORT,'step envelope immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_steps_result_immutable BEFORE UPDATE OF result_json ON run_steps
    WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json
    BEGIN SELECT RAISE(ABORT,'step result immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_steps_native_completion_durable BEFORE UPDATE OF native_state ON run_steps
    WHEN OLD.native_state='completed' AND NEW.native_state != 'completed'
    BEGIN SELECT RAISE(ABORT,'step native completion evidence immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_steps_completion_durable BEFORE UPDATE OF state ON run_steps
    WHEN (OLD.state='processed' AND NEW.state != 'processed') OR (OLD.state='completed' AND NEW.state NOT IN ('completed','processed'))
    BEGIN SELECT RAISE(ABORT,'step completion immutable'); END;
    CREATE TRIGGER IF NOT EXISTS run_steps_immutable_delete BEFORE DELETE ON run_steps
    BEGIN SELECT RAISE(ABORT,'step immutable'); END;
  `);
}
