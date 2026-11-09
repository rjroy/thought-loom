import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Logger } from "../logging";
import { migrate } from "../storage/sqlite";
import { rebuildResponseSearch, rebuildThoughtSearch } from "../storage/search-projections";
import { assertRestoreFenceSchema } from "../storage/restore-fences-schema";
import { BackupCaptureError, check, type Guard } from "./capture-files";
import { encodeTable, type BackupManifest, type RawCell } from "./format";
import { backupTableDefinitions, backupTableShapes, validateSourceSchema } from "./schema";
import { readSqlSnapshot, validateBytes, type CapturedTable, type SqlSnapshot } from "./records";

export class RestoreLoadError extends Error {
  constructor() { super("Invalid restore records"); }
}
/** Internal fixed-file capability: callers retain path/inode ownership, including across SQLite's connections. */
export interface RestoreDatabaseFile {
  readonly path: string;
  check(): void;
  refresh(): void;
}
interface SchemaObject { readonly type: string; readonly name: string; readonly tbl_name: string; readonly sql: string }
function schemaObjects(db: Database): readonly SchemaObject[] {
  return db.query<SchemaObject,[]>("SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
}
export const restoreSchemaFingerprint = (db: Database): string => JSON.stringify(schemaObjects(db));
const quote = (value: string): string => `"${value.replaceAll('"','""')}"`;
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function compareRestoreRecords(snapshot: SqlSnapshot, manifest: BackupManifest): void {
  check(snapshot.tables.length === manifest.tables.length,"inconsistent-source");
  for (const captured of snapshot.tables) {
    const expected = manifest.tables.find(entry => entry.name === captured.shape.name); check(expected !== undefined,"inconsistent-source");
    const encoded = encodeTable(captured.shape,captured.rows);
    check(String(captured.rows.length) === expected.rowCount && String(encoded.length) === expected.byteLength && digest(encoded) === expected.sha256,"inconsistent-source");
  }
  check(snapshot.sequences.length === manifest.sequences.length && snapshot.sequences.every((entry,index) =>
    entry.name === manifest.sequences[index].name && entry.value === manifest.sequences[index].value),"inconsistent-source");
}
function binding(cell: RawCell): SQLQueryBindings {
  if (cell.storage === "null") return null;
  if (cell.storage === "integer") return cell.value;
  if (cell.storage === "text" || cell.storage === "blob") return cell.bytes;
  throw new RestoreLoadError();
}

/** Newly created empty DB only. All schema/trigger SQL comes from current app migration, never the payload. */
export function loadRestoreDatabase(file: RestoreDatabaseFile, decoded: readonly CapturedTable[], manifest: BackupManifest, logger: Logger, guard: Guard): string {
  // Normal migration uses number-valued PRAGMAs; raw record loading uses a separate exact-integer connection.
  file.check(); const empty = new Database(file.path,{create:false,strict:true});
  try { file.check(); guard(); migrate(empty,logger); } finally { empty.close(true); file.refresh(); }
  file.check(); const db = new Database(file.path,{create:false,strict:true,safeIntegers:true});
  try {
    file.check(); guard(); db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
    validateSourceSchema(db); const schema = schemaObjects(db), triggers = schema.filter(object => object.type === "trigger");
    const tables = new Set([...backupTableShapes.map(table => table.name),"search_revision","thought_search_fts","response_search_fts"]);
    check(triggers.every(trigger => tables.has(trigger.tbl_name)),"inconsistent-source");
    db.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;");
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    for (const shape of backupTableShapes) db.exec(`DELETE FROM main.${quote(shape.name)}`);
    for (const captured of decoded) {
      guard(); const {shape} = captured, definition = backupTableDefinitions.find(table => table.shape.name === shape.name);
      check(definition !== undefined,"inconsistent-source");
      const columns = [...(shape.preserveRowid ? ["rowid"] : []),...shape.columns];
      const placeholders = [...(shape.preserveRowid ? ["?"] : []),...shape.columns.map(name => definition.columns[name].storage === "text" ? "CAST(? AS TEXT)" : "?")];
      const statement = db.query(`INSERT INTO main.${quote(shape.name)} (${columns.map(quote).join(",")}) VALUES (${placeholders.join(",")})`);
      for (const row of captured.rows) {
        guard(); statement.run(...(shape.preserveRowid ? [row.rowid] : []),...shape.columns.map(name => binding(row.values[name])));
      }
    }
    db.exec("DELETE FROM main.sqlite_sequence");
    for (const sequence of manifest.sequences) db.run("INSERT INTO main.sqlite_sequence(name,seq) VALUES (?,?)",[sequence.name,sequence.value]);
    rebuildThoughtSearch(db); rebuildResponseSearch(db); db.exec("UPDATE search_revision SET revision=0 WHERE id=1");
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec("ANALYZE");
    check(restoreSchemaFingerprint(db) === JSON.stringify(schema),"inconsistent-source"); assertRestoreFenceSchema(db);
    const loaded = readSqlSnapshot(db,guard); validateBytes(loaded); compareRestoreRecords(loaded,manifest);
    guard(); db.exec("COMMIT"); return JSON.stringify(schema);
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    // Preserve lifetime/path refusals; sanitize SQL diagnostics without disclosing statements or raw values.
    if (error instanceof BackupCaptureError && ["unsafe-path","unsafe-output","unsupported-storage","storage-failed"].includes(error.code) ||
        error instanceof RestoreLoadError || error instanceof Error && "code" in error &&
        ["aborted","unsafe-path","storage-failed","cleanup-conflict","invalid-records"].includes(String(error.code))) throw error;
    throw new RestoreLoadError();
  } finally { db.close(true); file.refresh(); }
}
