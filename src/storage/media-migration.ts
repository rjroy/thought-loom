import type { Database } from "bun:sqlite";
import type { Logger } from "../logging";
import { createMediaGuards, createMediaTables, indexMediaClarification } from "./media-schema";
import { migrateMediaAttempts } from "./media-attempt-schema";
import { migrateRunMediaParts } from "./run-media-schema";
import { migrateMediaSubmissions } from "./media-submission-schema";
import { migrateMediaAttemptTermination } from "./media-attempt-termination";

const thoughts = `CREATE TABLE thoughts (
  id TEXT PRIMARY KEY NOT NULL,text TEXT,
  author TEXT NOT NULL CHECK(author IN ('user','ai','source')),
  kind TEXT NOT NULL CHECK(kind IN ('captured-original','user-contribution','ai-interpretation','developing-idea','imported-original','media-original')),
  created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id),
  import_document_id TEXT REFERENCES import_document_seals(document_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(import_document_id,id),CHECK(parent_id IS NULL OR parent_id!=id),
  CHECK((text IS NULL)=(kind='media-original')),
  CHECK((author='source')=(kind IN ('imported-original','media-original'))),
  CHECK((kind='imported-original')=(import_document_id IS NOT NULL)),
  CHECK(kind!='imported-original' OR (origin='markdown-import' AND parent_id IS NULL)),
  CHECK(kind!='media-original' OR (origin='media-import' AND parent_id IS NULL AND import_document_id IS NULL))
)`;
const quote = (name: string): string => `"${name.replaceAll('"','""')}"`;
// SQLite identifier matching folds ASCII letters only, not Unicode or locale-specific case.
const identifierKey = (name: string): string => name.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32));
interface SchemaObject { readonly type: string; readonly name: string; readonly tbl_name: string; readonly sql: string }

/** Core migrate owns the transaction. No identity allocation, filesystem work or native execution occurs here. */
export function migrateMediaFoundation(db: Database, logger: Logger): void {
  const columns = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(thoughts)").all();
  if (columns.find(column => column.name === "text")?.notnull === 1) {
    const count = rebuildThoughtClosure(db);
    logger.info("[storage] media schema applied in transaction",{rebuiltTables:count});
  }
  createMediaTables(db);
  createMediaGuards(db);
  migrateMediaAttempts(db);
  migrateRunMediaParts(db);
  migrateMediaSubmissions(db);
  migrateMediaAttemptTermination(db);
  indexMediaClarification(db);
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Media migration foreign key integrity failure");
}

function rebuildThoughtClosure(db: Database): number {
  const schema = db.query<SchemaObject, []>("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const tables = schema.filter(item => item.type === "table");
  const actualNames = new Map(tables.map(table => [identifierKey(table.name),table.name]));
  const thoughtTable = actualNames.get("thoughts");
  if (!thoughtTable) throw new Error("Missing media migration thought table");
  // Resolve FK spellings to captured schema names; keep those names and their DDL unchanged.
  const resolveTable = (name: string): string => actualNames.get(identifierKey(name)) ?? name;
  const parents = new Map(tables.map(table => [table.name,db.query<{ table: string }, []>(`PRAGMA foreign_key_list(${quote(table.name)})`).all().map(fk => resolveTable(fk.table))]));
  const closure = new Set([thoughtTable]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [name,refs] of parents) if (!closure.has(name) && refs.some(ref => closure.has(ref))) { closure.add(name); changed = true; }
  }
  const ordered: string[] = [], visited = new Set<string>();
  function visit(name: string): void {
    if (visited.has(name)) return;
    visited.add(name); // Backedges are intentional: deferred checks protect complete cycle restoration.
    for (const parent of parents.get(name) ?? []) if (closure.has(parent)) visit(parent);
    ordered.push(name);
  }
  for (const name of closure) visit(name);
  const hasSequences = db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").get() !== null;
  const staged = ordered.map((name,index) => {
    const table = tables.find(item => item.name === name);
    if (!table) throw new Error("Missing media migration closure table");
    const names = db.query<{ name: string }, []>(`PRAGMA table_info(${quote(name)})`).all().map(column => column.name);
    const rowid = !/\bWITHOUT\s+ROWID\b/i.test(table.sql), temp = `media_migration_${index}`;
    const sequence = hasSequences ? db.query<{ seq: number }, [string]>("SELECT seq FROM sqlite_sequence WHERE name=?").get(name)?.seq ?? null : null;
    db.exec(`CREATE TEMP TABLE ${quote(temp)} AS SELECT ${rowid ? 'rowid AS __preserved_rowid,' : ''}${names.map(quote).join(',')} FROM ${quote(name)}`);
    return {name,names,rowid,temp,sequence,sql:table.sql};
  });
  // FKs remain ON. Defer their immediate checks until the existing outer transaction commits.
  // Staging the complete incoming closure first also preserves rows affected by FK cascades during DROP.
  db.exec("PRAGMA defer_foreign_keys=ON");
  const triggers = schema.filter(item => item.type === "trigger");
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  for (const name of [...ordered].reverse()) db.exec(`DROP TABLE ${quote(name)}`);
  const thoughtSql = thoughtTable === "thoughts" ? thoughts : thoughts.replace("CREATE TABLE thoughts",`CREATE TABLE ${quote(thoughtTable)}`);
  for (const table of staged) db.exec(table.name === thoughtTable ? thoughtSql : table.sql);
  // Unknown incoming FKs may depend on an explicit unique index, not a table-level key.
  // Restore all parent keys before preparing any insert, even with deferred row checks.
  for (const index of schema.filter(item => item.type === "index" && closure.has(resolveTable(item.tbl_name)))) db.exec(index.sql);
  for (const table of staged) {
    const names = table.names.map(quote).join(',');
    db.exec(`INSERT INTO ${quote(table.name)} (${table.rowid ? 'rowid,' : ''}${names})
      SELECT ${table.rowid ? '__preserved_rowid,' : ''}${names} FROM ${quote(table.temp)}${table.rowid ? ' ORDER BY __preserved_rowid' : ''}`);
    if (table.sequence !== null) {
      const existing = db.query("SELECT 1 FROM sqlite_sequence WHERE name=?").get(table.name);
      if (existing) db.run("UPDATE sqlite_sequence SET seq=? WHERE name=?",[table.sequence,table.name]);
      else db.run("INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)",[table.name,table.sequence]);
    }
    db.exec(`DROP TABLE ${quote(table.temp)}`);
  }
  for (const trigger of triggers) db.exec(trigger.sql);
  return staged.length;
}
