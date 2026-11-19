import type { Database } from "bun:sqlite";

export function migrateEvolveSessions(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolve_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      anchor_id TEXT NOT NULL REFERENCES thoughts(id),
      continuation_id TEXT NOT NULL REFERENCES thoughts(id),
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS evolve_sessions_identity_immutable BEFORE UPDATE OF id,anchor_id,created_at ON evolve_sessions
      BEGIN SELECT RAISE(ABORT,'evolve session identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_sessions_immutable_delete BEFORE DELETE ON evolve_sessions
      BEGIN SELECT RAISE(ABORT,'evolve sessions are retained'); END;
  `);
  const columns = db.query<{name:string},[]>("PRAGMA table_info(evolve_turns)").all();
  const legacy = columns.length > 0 && !columns.some(column => column.name === "run_id");
  if (legacy) db.exec("ALTER TABLE evolve_turns RENAME TO evolve_turns_legacy");
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolve_turns (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES evolve_sessions(id),
      request_key TEXT NOT NULL,
      parent_id TEXT NOT NULL REFERENCES thoughts(id),
      text TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status='pending'),
      open_slot INTEGER NOT NULL CHECK(open_slot IN (0,1)),
      run_id TEXT UNIQUE REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
      reply TEXT,
      UNIQUE(session_id,request_key),
      CHECK(run_id IS NOT NULL OR (open_slot=1 AND reply IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS evolve_turns_one_active ON evolve_turns(session_id) WHERE open_slot=1 AND run_id IS NOT NULL;
  `);
  // Frozen admission-only rows retain their bytes, but never own an active execution slot.
  if (legacy) db.exec(`INSERT INTO evolve_turns(rowid,id,session_id,request_key,parent_id,text,admitted_at,status,open_slot)
    SELECT rowid,id,session_id,request_key,parent_id,text,admitted_at,status,open_slot FROM evolve_turns_legacy ORDER BY rowid;
    DROP TABLE evolve_turns_legacy;`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS evolve_turns_in_session ON evolve_turns(session_id);
    CREATE TRIGGER IF NOT EXISTS evolve_turns_identity_immutable BEFORE UPDATE OF id,session_id,request_key,parent_id,text,admitted_at,status,run_id ON evolve_turns
      BEGIN SELECT RAISE(ABORT,'evolve turn admission is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_turns_reply_once BEFORE UPDATE OF reply ON evolve_turns
      WHEN OLD.reply IS NOT NULL OR NEW.reply IS NULL OR OLD.open_slot!=1
      BEGIN SELECT RAISE(ABORT,'evolve reply is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_turns_slot_once BEFORE UPDATE OF open_slot ON evolve_turns
      WHEN OLD.open_slot!=1 OR NEW.open_slot!=0 OR OLD.run_id IS NULL OR
        NOT EXISTS(SELECT 1 FROM runs WHERE id=OLD.run_id AND status IN ('completed','interrupted','failed'))
      BEGIN SELECT RAISE(ABORT,'evolve turn slot can only be closed by its terminal run'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_turns_immutable_delete BEFORE DELETE ON evolve_turns
      BEGIN SELECT RAISE(ABORT,'evolve turns are retained'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_runs_release AFTER UPDATE OF status ON runs
      WHEN NEW.status IN ('completed','interrupted','failed')
      BEGIN UPDATE evolve_turns SET open_slot=0 WHERE run_id=NEW.id AND open_slot=1; END;
    DROP TRIGGER IF EXISTS runs_input_required;
    CREATE TRIGGER runs_input_required BEFORE INSERT ON runs
      WHEN (NEW.kind='evolve' AND NOT EXISTS(SELECT 1 FROM evolve_turns t WHERE t.run_id=NEW.id)) != (NEW.input_thought_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM evolve_turns t WHERE t.run_id=NEW.id AND (NEW.kind!='evolve' OR t.admitted_at!=NEW.created_at))
      BEGIN SELECT RAISE(ABORT,'run input required for Classic Evolve only'); END;
    CREATE TABLE IF NOT EXISTS evolve_saves (
      thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id),
      turn_id TEXT NOT NULL REFERENCES evolve_turns(id),
      position INTEGER NOT NULL CHECK(position>=0),
      speaker TEXT NOT NULL CHECK(speaker IN ('user','ai')),
      selected_by TEXT NOT NULL CHECK(selected_by IN ('user','ai')),
      source TEXT NOT NULL CHECK(source IN ('passage','synthesis')),
      passage_start INTEGER CHECK(passage_start>=0),
      request_key TEXT,
      prompt_id TEXT REFERENCES run_steps(prompt_id),
      selection_index INTEGER CHECK(selection_index>=0),
      UNIQUE(turn_id,position), UNIQUE(turn_id,request_key), UNIQUE(prompt_id,selection_index),
      CHECK((source='passage')=(passage_start IS NOT NULL)),
      CHECK(source!='synthesis' OR (speaker='ai' AND selected_by='ai')),
      CHECK((selected_by='user' AND request_key IS NOT NULL AND prompt_id IS NULL AND selection_index IS NULL)
        OR (selected_by='ai' AND request_key IS NULL AND prompt_id IS NOT NULL AND selection_index IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS evolve_turn_history (
      turn_id TEXT NOT NULL REFERENCES evolve_turns(id),
      prior_turn_id TEXT NOT NULL REFERENCES evolve_turns(id),
      PRIMARY KEY(turn_id,prior_turn_id), CHECK(turn_id!=prior_turn_id)
    );
    CREATE INDEX IF NOT EXISTS evolve_turn_history_reverse ON evolve_turn_history(prior_turn_id,turn_id);
    CREATE TRIGGER IF NOT EXISTS evolve_saves_immutable_update BEFORE UPDATE ON evolve_saves
      BEGIN SELECT RAISE(ABORT,'evolve save receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_saves_immutable_delete BEFORE DELETE ON evolve_saves
      BEGIN SELECT RAISE(ABORT,'evolve save receipts are retained'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_history_immutable_update BEFORE UPDATE ON evolve_turn_history
      BEGIN SELECT RAISE(ABORT,'evolve history witnesses are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_history_immutable_delete BEFORE DELETE ON evolve_turn_history
      BEGIN SELECT RAISE(ABORT,'evolve history witnesses are retained'); END;
  `);
  if (!db.query<{name:string},[]>("PRAGMA table_info(evolve_saves)").all().some(column => column.name === "source_turn_id")) {
    // Existing receipts refer to their own turn or are syntheses; no historical provenance needs backfilling.
    db.exec(`ALTER TABLE evolve_saves ADD COLUMN source_turn_id TEXT REFERENCES evolve_turns(id)
      CHECK(source_turn_id IS NULL OR (selected_by='ai' AND source='passage' AND source_turn_id!=turn_id));`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS evolve_saves_source_history BEFORE INSERT ON evolve_saves
    WHEN NEW.source_turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM evolve_turn_history
      WHERE turn_id=NEW.turn_id AND prior_turn_id=NEW.source_turn_id)
    BEGIN SELECT RAISE(ABORT,'evolve passage source must be in prepared history'); END;`);
  db.exec(`CREATE INDEX IF NOT EXISTS evolve_saves_by_source_turn ON evolve_saves(source_turn_id) WHERE source_turn_id IS NOT NULL;`);
}
