import type { Database } from "bun:sqlite";
import { createSearchSchema } from "./search-schema";

interface SchemaEntry {
  readonly name: string;
  readonly tbl_name: string;
  readonly type: string;
  readonly sql: string;
}

const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const identifierKey = (name: string): string => name.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32));

/** Core migrate owns the transaction, predecessor upgrades and FK/recursive-trigger enforcement. */
export function migrateSearchFoundation(db: Database): void {
  const runs = db.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='runs'").get() as { sql: string } | null;
  if (!runs) throw new Error("Search migration requires run storage");
  const kindCheck = /CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i;
  const match = kindCheck.exec(runs.sql);
  const kinds = match?.[1];
  if (!kinds) throw new Error("Unsupported runs kind constraint for search migration");
  if (!/'search'/i.test(kinds)) {
    // Change only this CHECK. In particular, retain import constraints and unknown legacy evolve inputs.
    const widened = runs.sql.replace(kindCheck, `CHECK (kind IN (${kinds},'search'))`);
    rebuildRunClosure(db, widened);
  }
  const columns = db.query("PRAGMA table_info(run_steps)").all() as { name: string }[];
  if (!columns.some(column => column.name === "submit_owner")) db.exec("ALTER TABLE run_steps ADD COLUMN submit_owner TEXT");
  createSearchSchema(db);
  ensureIndex(db, "run_context", "run_context_reverse", ["kind", "ref_id", "run_id"]);
  ensureIndex(db, "response_thoughts", "response_thoughts_by_thought", ["thought_id", "response_id"]);
  ensureIndex(db, "connections", "connections_from", ["from_id"]);
  ensureIndex(db, "connections", "connections_to", ["to_id"]);
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Search migration foreign key integrity failure");
}

/** Rebuild only runs and its incoming FK closure, not the cyclic imported-source/library aggregate. */
function rebuildRunClosure(db: Database, runsSql: string): void {
  const schema = db.query("SELECT name,tbl_name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as SchemaEntry[];
  const tables = schema.filter(entry => entry.type === "table");
  // SQLite resolves ASCII case-insensitively; retain the actual schema names in the closure.
  const actualNames = new Map(tables.map(table => [identifierKey(table.name), table.name]));
  const resolveTable = (name: string): string => actualNames.get(identifierKey(name)) ?? name;
  const parents = new Map(tables.map(table => [table.name,
    (db.query(`PRAGMA foreign_key_list(${quote(table.name)})`).all() as { table: string }[]).map(fk => resolveTable(fk.table))]));
  const closure = new Set(["runs"]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, refs] of parents) {
      if (!closure.has(name) && refs.some(ref => closure.has(ref))) { closure.add(name); changed = true; }
    }
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  function visit(name: string): void {
    if (ordered.includes(name)) return;
    if (visiting.has(name)) throw new Error("Unsupported cyclic search migration foreign key closure");
    visiting.add(name);
    for (const parent of parents.get(name) ?? []) if (parent !== name && closure.has(parent)) visit(parent);
    visiting.delete(name);
    ordered.push(name);
  }
  for (const name of closure) visit(name);
  const staged = ordered.map((name, index) => {
    const table = tables.find(table => table.name === name);
    if (!table) throw new Error("Missing search migration closure table");
    const columns = (db.query(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map(column => column.name);
    const temp = `search_migration_${index}`;
    const rowid = !/\bWITHOUT\s+ROWID\b/i.test(table.sql);
    db.exec(`CREATE TEMP TABLE ${quote(temp)} AS SELECT ${rowid ? 'rowid AS __preserved_rowid,' : ''}${columns.map(quote).join(',')} FROM ${quote(name)}`);
    return { name, columns, temp, rowid, sql: table.sql };
  });
  // Restoring canonical rows must not fire cross-table triggers (initial steps, import ownership, FTS).
  const triggers = schema.filter(entry => entry.type === "trigger");
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  for (const name of [...ordered].reverse()) db.exec(`DROP TABLE ${quote(name)}`);
  for (const table of staged) db.exec(table.name === "runs" ? runsSql : table.sql);
  for (const table of staged) {
    const columns = table.columns.map(quote).join(',');
    db.exec(`INSERT INTO ${quote(table.name)} (${table.rowid ? 'rowid,' : ''}${columns})
      SELECT ${table.rowid ? '__preserved_rowid,' : ''}${columns} FROM ${quote(table.temp)}${table.rowid ? ' ORDER BY __preserved_rowid' : ''}`);
    db.exec(`DROP TABLE ${quote(table.temp)}`);
  }
  for (const index of schema.filter(entry => entry.type === "index" && closure.has(entry.tbl_name))) db.exec(index.sql);
  for (const trigger of triggers) db.exec(trigger.sql);
}

function ensureIndex(db: Database, table: string, name: string, columns: readonly string[]): void {
  const indexes = db.query(`PRAGMA index_list(${quote(table)})`).all() as { name: string; partial: number }[];
  const covered = indexes.some(index => {
    if (index.partial) return false;
    const existing = db.query(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string | null }[];
    return columns.every((column, position) => existing[position]?.name === column);
  });
  if (!covered) db.exec(`CREATE INDEX ${quote(name)} ON ${quote(table)} (${columns.map(quote).join(',')})`);
}
