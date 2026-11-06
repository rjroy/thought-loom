import type { Database } from "bun:sqlite";

/** Additive control metadata only; core migrate owns the transaction and keeps foreign keys enabled. */
export function migrateExecutionOwners(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_owners (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
      database_identity TEXT NOT NULL CHECK(length(database_identity)>0),
      lease_protocol TEXT NOT NULL CHECK(length(lease_protocol)>0)
    );
    CREATE TRIGGER IF NOT EXISTS execution_owners_immutable_update BEFORE UPDATE ON execution_owners
    BEGIN SELECT RAISE(ABORT,'execution owner immutable'); END;
    CREATE TRIGGER IF NOT EXISTS execution_owners_immutable_delete BEFORE DELETE ON execution_owners
    BEGIN SELECT RAISE(ABORT,'execution owner immutable'); END;
    CREATE TRIGGER IF NOT EXISTS execution_owners_no_replace BEFORE INSERT ON execution_owners
    WHEN EXISTS (SELECT 1 FROM execution_owners WHERE id=NEW.id OR rowid=NEW.rowid)
    BEGIN SELECT RAISE(ABORT,'execution owner cannot be replaced'); END;
  `);
  const columns = db.query("PRAGMA table_info(agent_bindings)").all() as { name: string }[];
  if (!columns.some(column => column.name === "execution_owner_id")) {
    db.exec("ALTER TABLE agent_bindings ADD COLUMN execution_owner_id TEXT REFERENCES execution_owners(id)");
  }
  // Separate from existing guards: do not rewrite their definitions or give old bindings a new owner.
  db.exec(`CREATE TRIGGER IF NOT EXISTS agent_bindings_execution_owner_immutable BEFORE UPDATE OF execution_owner_id ON agent_bindings
    BEGIN SELECT RAISE(ABORT,'agent binding execution owner immutable'); END;`);
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Execution owner migration foreign key integrity failure");
}
