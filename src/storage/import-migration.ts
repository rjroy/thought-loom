import type { Database } from "bun:sqlite";
import { createImportSchema, createImportTables } from "./import-schema";

const thoughts = `CREATE TABLE thoughts (
  id TEXT PRIMARY KEY NOT NULL, text TEXT NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('user','ai','source')),
  kind TEXT NOT NULL CHECK(kind IN ('captured-original','user-contribution','ai-interpretation','developing-idea','imported-original')),
  created_at TEXT NOT NULL, origin TEXT NOT NULL, parent_id TEXT REFERENCES thoughts(id),
  import_document_id TEXT REFERENCES import_document_seals(document_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(import_document_id,id), CHECK(parent_id IS NULL OR parent_id!=id),
  CHECK((kind='imported-original')=(author='source')),
  CHECK((kind='imported-original')=(import_document_id IS NOT NULL)),
  CHECK(kind!='imported-original' OR (origin='markdown-import' AND parent_id IS NULL))
)`;
const runs = `CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('weave','evolve','export','import')),
  status TEXT NOT NULL CHECK(status IN ('queued','submitting','running','uncertain','completed','interrupted','failed')),
  session_id TEXT UNIQUE NOT NULL, prompt_id TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0), input_thought_id TEXT REFERENCES thoughts(id),
  weave_subject_id TEXT REFERENCES thoughts(id), weave_trigger_id TEXT,
  cancellation_state TEXT NOT NULL DEFAULT 'none' CHECK(cancellation_state IN ('none','pending','settled')),
  -- Unmapped legacy evolve inputs remain unknown. The insert trigger requires input for new evolve runs.
  CHECK(kind='evolve' OR input_thought_id IS NULL),
  CHECK((weave_subject_id IS NULL)=(weave_trigger_id IS NULL)), CHECK(weave_subject_id IS NULL OR kind='weave')
)`;
const steps = `CREATE TABLE run_steps (
  run_id TEXT NOT NULL REFERENCES runs(id), position INTEGER NOT NULL CHECK(position>=0),
  prompt_id TEXT UNIQUE NOT NULL, input TEXT CHECK(input IS NULL OR length(input)>0),
  state TEXT NOT NULL CHECK(state IN ('prepared','submitting','uncertain','completed','processed')),
  native_state TEXT NOT NULL DEFAULT 'unknown' CHECK(native_state IN ('unknown','running','completed')),
  envelope_json TEXT, result_json TEXT, PRIMARY KEY(run_id,position),
  CHECK(state!='processed' OR (envelope_json IS NOT NULL AND result_json IS NOT NULL)),
  CHECK(envelope_json IS NULL OR state IN ('completed','processed')),
  CHECK(result_json IS NULL OR (state IN ('completed','processed') AND envelope_json IS NOT NULL)
    OR (json_valid(result_json) AND COALESCE(json_extract(result_json,'$.type')='import-partition',0))),
  CHECK((native_state='completed')=(state IN ('completed','processed')))
)`;
const quote = (name: string): string => '"' + name.replaceAll('"','""') + '"';
interface Schema { readonly name: string; readonly tbl_name: string; readonly type: string; readonly sql: string }

/** Called after predecessor upgrades, inside core migrate's transaction, with FKs ON throughout. */
export function migrateImportFoundation(db: Database): void {
  const columns = db.query("PRAGMA table_info(thoughts)").all() as {name:string}[];
  if (!columns.some(column => column.name === "import_document_id")) rebuildClosure(db);
  createImportSchema(db);
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Import migration foreign key integrity failure");
}

function rebuildClosure(db: Database): void {
  const schema = db.query("SELECT name,tbl_name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as Schema[];
  const tables = schema.filter(item => item.type === "table");
  const parents = new Map(tables.map(table => [table.name,(db.query(`PRAGMA foreign_key_list(${quote(table.name)})`).all() as {table:string}[]).map(fk => fk.table)]));
  const closure = new Set(["thoughts","runs","run_steps"]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [name,refs] of parents) if (!closure.has(name) && refs.some(ref => closure.has(ref))) { closure.add(name); changed = true; }
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  function visit(name: string): void {
    if (ordered.includes(name)) return;
    if (visiting.has(name)) throw new Error("Unsupported cyclic predecessor foreign key closure");
    visiting.add(name);
    for (const parent of parents.get(name) ?? []) if (parent !== name && closure.has(parent)) visit(parent);
    visiting.delete(name); ordered.push(name);
  }
  for (const name of closure) visit(name);
  const staged = ordered.map((name,index) => {
    const table = tables.find(table => table.name === name);
    if (!table) throw new Error("Missing predecessor closure table");
    const names = (db.query(`PRAGMA table_info(${quote(name)})`).all() as {name:string}[]).map(column => column.name);
    const temp = `import_migration_${index}`;
    const rowid = !/\bWITHOUT\s+ROWID\b/i.test(table.sql);
    db.exec(`CREATE TEMP TABLE ${quote(temp)} AS SELECT ${rowid ? 'rowid AS __preserved_rowid,' : ''}${names.map(quote).join(',')} FROM ${quote(name)}`);
    return {name,names,temp,rowid,sql:table.sql};
  });
  // Cross-table triggers must not fire while restoring canonical rows (e.g. initial run steps and FTS).
  const triggers = schema.filter(item => item.type === "trigger");
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  for (const name of [...ordered].reverse()) db.exec(`DROP TABLE ${quote(name)}`);
  for (const table of staged) db.exec(table.name === "thoughts" ? thoughts : table.name === "runs" ? runs : table.name === "run_steps" ? steps : table.sql);
  // Both sides of the new cycle and all referenced keys exist before copying any data.
  createImportTables(db);
  for (const table of staged) {
    const names = table.names.map(quote).join(',');
    db.exec(`INSERT INTO ${quote(table.name)} (${table.rowid ? 'rowid,' : ''}${names})
      SELECT ${table.rowid ? '__preserved_rowid,' : ''}${names} FROM ${quote(table.temp)}${table.rowid ? ' ORDER BY __preserved_rowid' : ''}`);
    db.exec(`DROP TABLE ${quote(table.temp)}`);
  }
  for (const index of schema.filter(item => item.type === "index" && closure.has(item.tbl_name))) db.exec(index.sql);
  for (const trigger of triggers) db.exec(trigger.sql);
}
