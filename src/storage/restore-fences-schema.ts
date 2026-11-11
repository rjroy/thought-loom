import type { Database } from "bun:sqlite";
import { RunFenceError } from "../domain/run";
import { exportPurgeSql } from "./export-lifecycle-sql";

const legacyDelete = `CREATE TRIGGER IF NOT EXISTS restore_fences_immutable_delete BEFORE DELETE ON restore_fences
    BEGIN SELECT RAISE(ABORT,'restore fence immutable'); END;`;

const definitions = [
  { type: "table", name: "restore_fences", sql: `CREATE TABLE IF NOT EXISTS restore_fences (
      entity_kind TEXT NOT NULL CHECK(entity_kind IN ('run','import-batch','import-file','composer')),
      entity_id TEXT NOT NULL CHECK(length(entity_id)>0),
      snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
      restored_at TEXT NOT NULL CHECK(length(restored_at)>0),
      original_state_json TEXT NOT NULL CHECK(json_valid(original_state_json) AND json_type(original_state_json)='object'),
      PRIMARY KEY(entity_kind,entity_id)
    );` },
  { type: "trigger", name: "restore_fences_immutable_update", sql: `CREATE TRIGGER IF NOT EXISTS restore_fences_immutable_update BEFORE UPDATE ON restore_fences
    BEGIN SELECT RAISE(ABORT,'restore fence immutable'); END;` },
  { type: "trigger", name: "restore_fences_immutable_delete", sql: `CREATE TRIGGER IF NOT EXISTS restore_fences_immutable_delete BEFORE DELETE ON restore_fences
    WHEN NOT (OLD.entity_kind='run' AND ${exportPurgeSql("OLD.entity_id")})
    BEGIN SELECT RAISE(ABORT,'restore fence immutable'); END;` },
  { type: "trigger", name: "restore_fences_no_replace", sql: `CREATE TRIGGER IF NOT EXISTS restore_fences_no_replace BEFORE INSERT ON restore_fences
    WHEN EXISTS(SELECT 1 FROM restore_fences WHERE rowid=NEW.rowid OR (entity_kind=NEW.entity_kind AND entity_id=NEW.entity_id))
    BEGIN SELECT RAISE(ABORT,'restore fence cannot be replaced'); END;` },
];
// SQLite omits IF NOT EXISTS and a final semicolon in sqlite_schema. Accept no other DDL changes.
const normalized = (sql: string): string => sql.replace(/\bIF\s+NOT\s+EXISTS\b/g, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
const expected = definitions.map(definition => ({ ...definition, sql: normalized(definition.sql) }));
const validated = new WeakMap<Database, number | bigint>();

/** Check the actual main schema, including immutable guards, without treating a missing table as permission. */
export function assertRestoreFenceSchema(db: Database): void {
  const version = db.query<{ schema_version: number | bigint }, []>("PRAGMA main.schema_version").get()?.schema_version;
  if (version === undefined) throw new RunFenceError("Restore fence schema is unavailable");
  if (validated.get(db) === version) return;
  const rows = db.query<{ type: string; name: string; sql: string | null }, []>(
    "SELECT type,name,sql FROM main.sqlite_schema WHERE tbl_name='restore_fences' AND type IN ('table','view','trigger')").all();
  if (rows.length !== expected.length || expected.some(definition => !rows.some(row => row.type === definition.type &&
      row.name === definition.name && row.sql !== null && normalized(row.sql) === definition.sql))) {
    throw new RunFenceError("Restore fence schema is unavailable");
  }
  // Never remember uncommitted DDL: rollback could reuse its schema cookie for a different definition.
  if (!db.inTransaction) validated.set(db, version);
}

/** Additive immutable history metadata. Migration creates no historical identities or recovery transitions. */
export function migrateRestoreFences(db: Database): void {
  const rows = db.query<{type:string;name:string;sql:string|null},[]>(
    "SELECT type,name,sql FROM main.sqlite_schema WHERE tbl_name='restore_fences' AND type IN ('table','view','trigger')").all();
  if (rows.length !== 0) {
    // Only the exact supported predecessor may gain the export-purge exception. Unknown/missing guards fail closed.
    const predecessor = expected.map(definition => definition.name === "restore_fences_immutable_delete"
      ? {...definition,sql:normalized(legacyDelete)} : definition);
    const matches = (definitions: typeof expected) => rows.length === definitions.length && definitions.every(definition =>
      rows.some(row => row.type === definition.type && row.name === definition.name && row.sql !== null && normalized(row.sql) === definition.sql));
    if (matches(predecessor)) db.exec("DROP TRIGGER restore_fences_immutable_delete");
    else if (!matches(expected)) throw new RunFenceError("Restore fence schema is unavailable");
  }
  for (const definition of definitions) db.exec(definition.sql);
  assertRestoreFenceSchema(db);
}
