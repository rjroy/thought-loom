import type { Database } from "bun:sqlite";
import { searchCleanupGuardNames, searchCleanupGuards, searchCleanupTable } from "./search-cleanup-schema";

const quote = (name: string): string => '"' + name.replaceAll('"','""') + '"';
interface Definition { readonly name: string; readonly type: string; readonly sql: string }

/** Rebuild this leaf control table only, inside core migrate's immediate transaction with FKs ON. */
export function migrateSearchCleanup(db: Database): void {
  const columns = db.query("PRAGMA table_info(search_native_cleanup)").all() as { name: string; notnull: number }[];
  if (columns.length === 0) db.exec(searchCleanupTable);
  else if (!columns.some(column => column.name === "prompt_manifest_json") || columns.some(column => column.name === "submit_owner" && column.notnull !== 0)) {
    const known = ["run_id","session_id","binding_json","last_prompt_id","submit_owner","drain_state","admission_state",
      "prompt_sha256","evidence_json","state","prompt_manifest_json"];
    if (columns.some(column => !known.includes(column.name))) throw new Error("Unsupported search cleanup columns");
    const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    if (tables.some(table => (db.query(`PRAGMA foreign_key_list(${quote(table.name)})`).all() as { table: string }[])
      .some(fk => fk.table === "search_native_cleanup"))) throw new Error("Unsupported incoming search cleanup foreign key");
    const definitions = db.query(`SELECT name,type,sql FROM sqlite_schema WHERE tbl_name='search_native_cleanup'
      AND type IN ('trigger','index') AND sql IS NOT NULL ORDER BY rowid`).all() as Definition[];
    const names = columns.map(column => quote(column.name)).join(",");
    db.exec(`CREATE TEMP TABLE search_cleanup_migration AS SELECT rowid AS __preserved_rowid,${names} FROM search_native_cleanup`);
    db.exec("DROP TABLE search_native_cleanup");
    db.exec(searchCleanupTable);
    db.exec(`INSERT INTO search_native_cleanup(rowid,${names}) SELECT __preserved_rowid,${names} FROM temp.search_cleanup_migration ORDER BY __preserved_rowid`);
    db.exec("DROP TABLE temp.search_cleanup_migration");
    for (const definition of definitions) {
      if (!searchCleanupGuardNames.some(name => name === definition.name)) db.exec(definition.sql);
    }
  }
  for (const name of searchCleanupGuardNames) db.exec(`DROP TRIGGER IF EXISTS ${quote(name)}`);
  db.exec(searchCleanupGuards);
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Search cleanup migration foreign key integrity failure");
}
