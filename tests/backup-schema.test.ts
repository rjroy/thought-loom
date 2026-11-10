import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BackupSchemaError, validateSourceSchema } from "../src/backup/schema";
import { migrate } from "../src/storage/sqlite";

const included = [
  "thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources",
  "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections",
  "runs", "run_steps", "agent_bindings", "run_context", "run_operation_receipts", "run_issued_thoughts", "run_replies", "execution_owners",
  "export_intents", "export_reports", "import_namespaces", "import_documents", "import_locations", "import_document_parts", "import_document_seals",
  "markdown_imports", "markdown_import_files", "markdown_import_payloads", "media_store", "media_sources",
  "search_sessions", "search_turns", "search_messages", "search_discoveries", "search_content_dependencies", "search_composer_contexts",
  "search_composer_dependencies", "search_revisions", "search_native_cleanup", "restore_fences", "agent_instructions",
].sort();
const rowidTables = ["runs", "run_operation_receipts", "response_thoughts", "run_context", "markdown_import_files", "import_namespaces", "search_native_cleanup"].sort();

function fixture(action: (db: Database) => void): void {
  const db = new Database(":memory:");
  try { migrate(db); action(db); } finally { db.close(); }
}

test("compiled inventory matches the fresh migrated schema, including closed columns and preserved rowids", () => fixture(db => {
  const inventory = validateSourceSchema(db);
  expect(inventory.map(table => table.name).sort()).toEqual(included);
  expect(inventory.find(table => table.name === "agent_instructions")?.columns).toEqual(["evolve","export","revision","search","singleton","weaver"]);
  expect(inventory.find(table => table.name === "run_steps")?.columns).toContain("guidance");
  expect(inventory.filter(table => table.preserveRowid).map(table => table.name).sort()).toEqual(rowidTables);
  for (const table of inventory) {
    const quoted = table.name.replaceAll('"', '""');
    const actual = db.query<{ name: string; pk: number }, []>(`PRAGMA table_info("${quoted}")`).all();
    expect([...table.columns].sort()).toEqual(actual.map(column => column.name).sort());
    expect([...table.primaryKey]).toEqual(actual.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name));
  }
  const actualNames = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
  for (const excluded of ["thought_search_fts", "thought_search_fts_data", "response_search_fts", "response_search_fts_data", "search_revision", "sqlite_sequence"]) {
    expect(actualNames).toContain(excluded);
    expect(inventory.some(table => table.name === excluded)).toBe(false);
  }
}));

test("schema validation refuses unknown tables, including fake derived-table prefixes", () => {
  for (const name of ["future_history", "thought_search_fts_extra"]) fixture(db => {
    db.exec(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY)`);
    expect(() => validateSourceSchema(db)).toThrow(BackupSchemaError);
  });
});

test("schema validation refuses added and renamed columns rather than dropping data", () => {
  fixture(db => {
    db.exec("ALTER TABLE thoughts ADD COLUMN future_fact TEXT");
    expect(() => validateSourceSchema(db)).toThrow(BackupSchemaError);
  });
  fixture(db => {
    db.exec("ALTER TABLE thoughts RENAME COLUMN origin TO predecessor_origin");
    expect(() => validateSourceSchema(db)).toThrow(BackupSchemaError);
  });
});

test("schema validation accepts a read-only safe-integer connection with bigint pragma metadata", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "backup-schema-"));
  const path = join(dir, "fixture.sqlite");
  try {
    const writer = new Database(path);
    try { migrate(writer); } finally { writer.close(); }
    const reader = new Database(path, { readonly: true, create: false, safeIntegers: true });
    try {
      const column = reader.query<{ pk: bigint }, []>("PRAGMA table_info(thought_sources)").get();
      expect(typeof column?.pk).toBe("bigint");
      expect(validateSourceSchema(reader).map(table => table.name).sort()).toEqual(included);
    } finally { reader.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("schema validation rejects changed storage, nullability, key, foreign key and collation metadata", () => {
  const normal = `CREATE TABLE thought_sources (
    thought_id TEXT NOT NULL REFERENCES thoughts(id), position INTEGER NOT NULL,
    source_id TEXT NOT NULL REFERENCES thoughts(id), PRIMARY KEY (thought_id, position))`;
  const alternatives = [
    normal.replace("position INTEGER", "position TEXT"),
    normal.replace("source_id TEXT NOT NULL", "source_id TEXT"),
    normal.replace("PRIMARY KEY (thought_id, position)", "PRIMARY KEY (position, thought_id)"),
    normal.replace("source_id TEXT NOT NULL REFERENCES thoughts(id)", "source_id TEXT NOT NULL"),
    normal.replace("thought_id TEXT NOT NULL", "thought_id TEXT COLLATE NOCASE NOT NULL"),
  ];
  for (const ddl of alternatives) fixture(db => {
    expect(validateSourceSchema(db).map(table => table.name).sort()).toEqual(included);
    db.exec("PRAGMA foreign_keys=OFF; DROP TABLE thought_sources;");
    db.exec(ddl);
    expect(() => validateSourceSchema(db)).toThrow(BackupSchemaError);
  });
});
