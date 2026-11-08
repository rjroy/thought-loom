import type { Database } from "bun:sqlite";
import type { Logger } from "../logging";
import { createMediaGuards, createMediaTables, indexMediaClarification } from "./media-schema";

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
  migrateMediaFileRuns(db);
  indexMediaClarification(db);
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Media migration foreign key integrity failure");
}

/** Upgrade development databases to source metadata plus ordinary runs, preserving their core records. */
function migrateMediaFileRuns(db: Database): void {
  const tables = new Set(db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  const columns = new Set(db.query<{name:string},[]>("PRAGMA table_info(run_steps)").all().map(row => row.name));
  const affected = new Set<string>();
  if (tables.has("media_weave_attempts")) {
    for (const row of db.query<{runId:string},[]>("SELECT run_id AS runId FROM media_weave_attempts").all()) affected.add(row.runId);
  }
  if (tables.has("run_media_parts")) {
    for (const row of db.query<{runId:string},[]>("SELECT DISTINCT step.run_id AS runId FROM run_steps step JOIN run_media_parts part ON part.prompt_id=step.prompt_id").all()) affected.add(row.runId);
  }
  if (columns.has("media_submit_owner_id")) {
    for (const row of db.query<{runId:string},[]>("SELECT DISTINCT run_id AS runId FROM run_steps WHERE media_submit_owner_id IS NOT NULL").all()) affected.add(row.runId);
  }
  const triggers = db.query<{name:string},[]>(`SELECT name FROM sqlite_schema WHERE type='trigger' AND
    (name GLOB 'media_attempt_*' OR name GLOB 'media_submission_*' OR name GLOB 'run_media_parts_*' OR name='media_source_successor_unsubmitted')`).all();
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  // Never resume saved inputs as a new file-path request or claim that an unresolved native outcome settled.
  for (const runId of affected) db.run(`UPDATE runs SET status='interrupted',generation=generation+1,cancellation_state='pending'
    WHERE id=? AND status IN ('queued','submitting','running','uncertain')`,[runId]);
  if (tables.has("run_media_parts")) db.exec("DROP TABLE run_media_parts");
  if (tables.has("media_weave_attempts")) db.exec("DROP TABLE media_weave_attempts");
  for (const column of ["media_submit_owner_id","media_submit_generation"]) {
    if (columns.has(column)) db.exec(`ALTER TABLE run_steps DROP COLUMN ${quote(column)}`);
  }
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
