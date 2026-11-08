import type { Database } from "bun:sqlite";
import type { TableShape } from "./format";

interface Column { readonly type: "TEXT" | "INTEGER" | "BLOB"; readonly notNull: 0 | 1 }
interface ForeignKey {
  readonly columns: readonly string[];
  readonly table: string;
  readonly target: readonly string[];
  readonly onDelete: "NO ACTION" | "CASCADE";
}
interface UniqueKey { readonly columns: readonly string[]; readonly where: string }
interface Definition {
  readonly name: string;
  readonly columns: Readonly<Record<string, Column>>;
  readonly primaryKey: readonly string[];
  readonly preserveRowid: boolean;
  readonly unique: readonly UniqueKey[];
  readonly references: readonly ForeignKey[];
  readonly autoIncrement: boolean;
}
interface Options {
  readonly preserveRowid?: boolean;
  readonly unique?: readonly UniqueKey[];
  readonly references?: readonly ForeignKey[];
  readonly autoIncrement?: boolean;
}

const text: Column = { type: "TEXT", notNull: 1 }, optionalText: Column = { type: "TEXT", notNull: 0 };
const integer: Column = { type: "INTEGER", notNull: 1 }, optionalInteger: Column = { type: "INTEGER", notNull: 0 };
const blob: Column = { type: "BLOB", notNull: 1 }, optionalBlob: Column = { type: "BLOB", notNull: 0 };
// SQLite reports notnull=0 for INTEGER PRIMARY KEY aliases without an explicit NOT NULL.
const integerKey = optionalInteger;
const unique = (columns: readonly string[], where = ""): UniqueKey => ({ columns, where });
const reference = (columns: readonly string[], table: string, target: readonly string[], onDelete: ForeignKey["onDelete"] = "NO ACTION"): ForeignKey =>
  ({ columns, table, target, onDelete });
function definition(name: string, columns: Definition["columns"], primaryKey: readonly string[], options: Options = {}): Definition {
  return { name, columns, primaryKey, preserveRowid: options.preserveRowid ?? false, unique: options.unique ?? [],
    references: options.references ?? [], autoIncrement: options.autoIncrement ?? false };
}

/** Versioned logical inventory, independent of whatever tables happen to exist in a source. */
const definitions: readonly Definition[] = [
  definition("thoughts", { id: text, text: optionalText, author: text, kind: text, created_at: text, origin: text,
    parent_id: optionalText, import_document_id: optionalText }, ["id"], {
    unique: [unique(["import_document_id", "id"])], references: [reference(["parent_id"], "thoughts", ["id"]),
      reference(["import_document_id"], "import_document_seals", ["document_id"])] }),
  definition("thought_titles", { thought_id: text, title: optionalText, title_author: optionalText }, ["thought_id"], {
    references: [reference(["thought_id"], "thoughts", ["id"])] }),
  definition("thought_sources", { thought_id: text, position: integer, source_id: text }, ["thought_id", "position"], {
    references: [reference(["thought_id"], "thoughts", ["id"]), reference(["source_id"], "thoughts", ["id"])] }),
  definition("thought_source_seals", { thought_id: text }, ["thought_id"], { references: [reference(["thought_id"], "thoughts", ["id"])] }),
  definition("connections", { id: text, from_id: text, to_id: text, category: text, proposed_by: text, explanation: text }, ["id"], {
    references: [reference(["from_id"], "thoughts", ["id"]), reference(["to_id"], "thoughts", ["id"])] }),
  definition("connection_sources", { connection_id: text, position: integer, source_id: text }, ["connection_id", "position"], {
    references: [reference(["connection_id"], "connections", ["id"]), reference(["source_id"], "thoughts", ["id"])] }),
  definition("responses", { id: text, text, role: text, state: text }, ["id"]),
  definition("response_thoughts", { response_id: text, thought_id: text, position: integer }, ["response_id", "position"], {
    preserveRowid: true, unique: [unique(["response_id", "thought_id"])],
    references: [reference(["response_id"], "responses", ["id"]), reference(["thought_id"], "thoughts", ["id"])] }),
  definition("response_seals", { response_id: text }, ["response_id"], { references: [reference(["response_id"], "responses", ["id"])] }),
  definition("rejected_thoughts", { thought_id: text }, ["thought_id"], { references: [reference(["thought_id"], "thoughts", ["id"])] }),
  definition("rejected_connections", { connection_id: text }, ["connection_id"], { references: [reference(["connection_id"], "connections", ["id"])] }),
  definition("runs", { id: text, kind: text, status: text, session_id: text, prompt_id: text, created_at: text, generation: integer,
    input_thought_id: optionalText, weave_subject_id: optionalText, weave_trigger_id: optionalText, cancellation_state: text }, ["id"], {
    preserveRowid: true, unique: [unique(["session_id"]), unique(["prompt_id"])],
    references: [reference(["input_thought_id"], "thoughts", ["id"]), reference(["weave_subject_id"], "thoughts", ["id"])] }),
  definition("run_steps", { run_id: text, position: integer, prompt_id: text, input: optionalText, state: text, native_state: text,
    envelope_json: optionalText, result_json: optionalText, submit_owner: optionalText }, ["run_id", "position"], {
    unique: [unique(["prompt_id"])], references: [reference(["run_id"], "runs", ["id"])] }),
  definition("agent_bindings", { run_id: text, session_id: text, service_url: text, directory: text, model_json: text,
    permissions_json: text, protocol_version: integer, execution_owner_id: optionalText }, ["run_id"], {
    unique: [unique(["session_id"])], references: [reference(["run_id"], "runs", ["id"]), reference(["execution_owner_id"], "execution_owners", ["id"])] }),
  definition("run_context", { run_id: text, kind: text, ref_id: text, full_read: integer }, ["run_id", "kind", "ref_id"], {
    preserveRowid: true, references: [reference(["run_id"], "runs", ["id"])] }),
  definition("run_operation_receipts", { run_id: text, operation_id: text, operation_json: text, thought_id: optionalText,
    result_json: text, format: text }, ["run_id", "operation_id"], {
    preserveRowid: true, unique: [unique(["run_id", "operation_id", "thought_id"])],
    references: [reference(["run_id"], "runs", ["id"]), reference(["thought_id"], "thoughts", ["id"])] }),
  definition("run_issued_thoughts", { run_id: text, operation_id: text, thought_id: text, position: integer }, ["run_id", "position"], {
    unique: [unique(["run_id", "operation_id"]), unique(["run_id", "thought_id"])],
    references: [reference(["run_id"], "runs", ["id"]), reference(["thought_id"], "thoughts", ["id"]),
      reference(["run_id", "operation_id", "thought_id"], "run_operation_receipts", ["run_id", "operation_id", "thought_id"])] }),
  definition("run_replies", { run_id: text, draft_json: optionalText, response_id: optionalText }, ["run_id"], {
    references: [reference(["run_id"], "runs", ["id"]), reference(["response_id"], "responses", ["id"])] }),
  definition("execution_owners", { id: text, database_identity: text, lease_protocol: text }, ["id"]),
  definition("export_intents", { run_id: text, request: text, effort: text }, ["run_id"], { references: [reference(["run_id"], "runs", ["id"])] }),
  definition("export_reports", { run_id: text, prompt_id: text, markdown: text, sources_json: text }, ["run_id"], {
    references: [reference(["run_id"], "export_intents", ["run_id"])] }),
  definition("import_namespaces", { id: text, kind: text, label: text, created_at: text }, ["id"], {
    preserveRowid: true, unique: [unique(["kind"], "kind='loose-markdown'")] }),
  definition("import_documents", { sequence: integerKey, id: text, original_bytes: blob, sha256: blob, byte_length: integer,
    encoding: text, original_namespace_id: text, original_path: text, created_at: text, parser_version: text,
    segmentation_method: text, segmentation_reason: optionalText }, ["sequence"], {
    autoIncrement: true, unique: [unique(["id"]), unique(["sha256", "byte_length"])],
    references: [reference(["id"], "import_document_seals", ["document_id"]), reference(["original_namespace_id"], "import_namespaces", ["id"])] }),
  definition("import_locations", { namespace_id: text, relative_path: text, document_id: text }, ["namespace_id", "relative_path"], {
    references: [reference(["namespace_id"], "import_namespaces", ["id"]), reference(["document_id"], "import_documents", ["id"])] }),
  definition("import_document_parts", { document_id: text, position: integer, kind: text, start_byte: integer, end_byte: integer,
    thought_id: optionalText, thought_ordinal: optionalInteger }, ["document_id", "position"], {
    unique: [unique(["thought_id"]), unique(["document_id", "thought_ordinal"])],
    references: [reference(["document_id"], "import_documents", ["id"]), reference(["thought_id"], "thoughts", ["id"]),
      reference(["document_id", "thought_id"], "thoughts", ["import_document_id", "id"])] }),
  definition("import_document_seals", { document_id: text }, ["document_id"], { references: [reference(["document_id"], "import_documents", ["id"])] }),
  definition("markdown_imports", { sequence: integerKey, id: text, request_key: text, namespace_id: text, created_at: text, sealed_at: optionalText }, ["sequence"], {
    autoIncrement: true, unique: [unique(["id"]), unique(["request_key"]), unique(["id", "namespace_id"])],
    references: [reference(["namespace_id"], "import_namespaces", ["id"])] }),
  definition("markdown_import_files", { id: text, import_id: text, namespace_id: text, position: integer, request_key: text,
    relative_path: text, sha256: blob, byte_length: integer, created_at: text, run_id: optionalText, waiting_on_file_id: optionalText,
    outcome: optionalText, document_id: optionalText, reason_code: optionalText }, ["id"], {
    preserveRowid: true, unique: [unique(["run_id"]), unique(["import_id", "position"]), unique(["import_id", "request_key"]),
      unique(["sha256", "byte_length"], "outcome IS NULL AND waiting_on_file_id IS NULL")],
    references: [reference(["run_id"], "runs", ["id"]), reference(["waiting_on_file_id"], "markdown_import_files", ["id"]),
      reference(["document_id"], "import_documents", ["id"]), reference(["import_id", "namespace_id"], "markdown_imports", ["id", "namespace_id"])] }),
  definition("markdown_import_payloads", { file_id: text, bytes: blob }, ["file_id"], { references: [reference(["file_id"], "markdown_import_files", ["id"])] }),
  definition("media_store", { singleton: integerKey, store_id: text }, ["singleton"], { unique: [unique(["store_id"])] }),
  definition("media_sources", { id: text, source_thought_id: text, request_key: text, display_name: text, mime_type: text,
    byte_length: integer, sha256: blob, clarification: optionalText, created_at: text }, ["id"], {
    unique: [unique(["source_thought_id"]), unique(["request_key"])], references: [reference(["source_thought_id"], "thoughts", ["id"]),
      reference(["source_thought_id"], "thought_titles", ["thought_id"]), reference(["source_thought_id"], "thought_source_seals", ["thought_id"])] }),
  definition("search_sessions", { sequence: integerKey, id: text, create_request_key: text, title: optionalText,
    created_at: text, last_activity_at: text, revision: integer, deleted_at: optionalText }, ["sequence"], {
    autoIncrement: true, unique: [unique(["id"]), unique(["create_request_key"])] }),
  definition("search_turns", { run_id: text, session_id: text, position: integer, request_key: text, admitted_at: text,
    effort: text, context_mode: text, intent_json: text, open_slot: integer, outcome_reason: optionalText }, ["run_id"], {
    unique: [unique(["session_id", "position"]), unique(["session_id", "request_key"]), unique(["session_id", "run_id"]), unique(["session_id"], "open_slot=1")],
    references: [reference(["run_id"], "runs", ["id"], "CASCADE"), reference(["session_id"], "search_sessions", ["id"])] }),
  definition("search_messages", { id: text, session_id: text, run_id: text, position: integer, role: text, text,
    created_at: text, disposition: optionalText, evidence_json: text }, ["id"], {
    unique: [unique(["session_id", "position"]), unique(["run_id", "role"]), unique(["session_id", "id"])],
    references: [reference(["session_id", "run_id"], "search_turns", ["session_id", "run_id"], "CASCADE")] }),
  definition("search_discoveries", { id: text, session_id: text, thought_id: text, position: integer, why: text,
    evidence_json: text, added_run_id: text, added_prompt_id: text, added_at: text, removed_at: optionalText }, ["id"], {
    unique: [unique(["added_prompt_id"]), unique(["session_id", "position"]), unique(["session_id", "id"]), unique(["session_id", "thought_id"], "removed_at IS NULL")],
    references: [reference(["thought_id"], "thoughts", ["id"]), reference(["added_prompt_id"], "run_steps", ["prompt_id"]),
      reference(["session_id", "added_run_id"], "search_turns", ["session_id", "run_id"], "CASCADE")] }),
  definition("search_content_dependencies", { sequence: integerKey, session_id: text, message_id: optionalText,
    discovery_id: optionalText, ref_kind: text, ref_id: text }, ["sequence"], {
    unique: [unique(["message_id", "ref_kind", "ref_id"], "message_id IS NOT NULL"), unique(["discovery_id", "ref_kind", "ref_id"], "discovery_id IS NOT NULL")],
    references: [reference(["session_id"], "search_sessions", ["id"]), reference(["session_id", "message_id"], "search_messages", ["session_id", "id"], "CASCADE"),
      reference(["session_id", "discovery_id"], "search_discoveries", ["session_id", "id"], "CASCADE")] }),
  definition("search_composer_contexts", { id: text, session_id: text, revision: integer, state: text, created_at: text }, ["id"], {
    references: [reference(["session_id"], "search_sessions", ["id"])] }),
  definition("search_composer_dependencies", { composer_id: text, ref_kind: text, ref_id: text }, ["composer_id", "ref_kind", "ref_id"], {
    references: [reference(["composer_id"], "search_composer_contexts", ["id"], "CASCADE")] }),
  definition("search_revisions", { id: integerKey, eligibility: integer, retrieval: integer, catalog: integer }, ["id"]),
  definition("search_native_cleanup", { run_id: text, session_id: text, binding_json: text, last_prompt_id: text,
    submit_owner: optionalText, drain_state: text, admission_state: text, prompt_sha256: optionalBlob,
    evidence_json: optionalText, state: text, prompt_manifest_json: optionalText }, ["run_id"], {
    preserveRowid: true, references: [reference(["session_id"], "search_sessions", ["id"])] }),
  definition("restore_fences", { entity_kind: text, entity_id: text, snapshot_sha256: text, restored_at: text, original_state_json: text }, ["entity_kind", "entity_id"]),
];

const spellingRevision = definition("search_revision", { id: integerKey, revision: integer }, ["id"]);
const virtualTables = new Set(["thought_search_fts", "response_search_fts"]);
const shadowTables = new Set([...virtualTables].flatMap(name => ["data", "idx", "content", "docsize", "config"].map(suffix => `${name}_${suffix}`)));
const bookkeeping = new Set(["sqlite_schema", "sqlite_sequence", "sqlite_stat1", "sqlite_stat4"]);
function invalid(): never { throw new BackupSchemaError(); }

export class BackupSchemaError extends Error {
  constructor() { super("Unsupported backup source schema"); }
}

type SqlInteger = number | bigint;
interface TableInfo { readonly schema: string; readonly name: string; readonly type: string; readonly wr: SqlInteger; readonly strict: SqlInteger }
interface ColumnInfo { readonly name: string; readonly type: string; readonly notNull: SqlInteger; readonly pk: SqlInteger; readonly hidden: SqlInteger }
interface IndexInfo { readonly name: string; readonly unique: SqlInteger; readonly origin: string; readonly partial: SqlInteger }
interface IndexColumn { readonly seqno: SqlInteger; readonly name: string | null; readonly desc: SqlInteger; readonly coll: string; readonly key: SqlInteger }
interface ForeignKeyInfo {
  readonly id: SqlInteger; readonly seq: SqlInteger; readonly table: string; readonly from: string; readonly to: string | null;
  readonly on_update: string; readonly on_delete: string; readonly match: string;
}

function smallInteger(value: SqlInteger): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
const identifierKey = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase());

/** Normalize only the fixed partial predicates, preserving quoted string contents. */
function predicate(value: string): string {
  return value.trim().replace(/;$/, "").split(/('(?:''|[^'])*')/).map((part, position) =>
    position % 2 ? part : identifierKey(part.replace(/\s+/g, ""))).join("");
}
const uniqueSignature = (columns: readonly string[], where: string): string => JSON.stringify([columns, predicate(where)]);
const foreignKeySignature = (columns: readonly string[], table: string, target: readonly string[], onDelete: string): string =>
  JSON.stringify([columns, identifierKey(table), target, onDelete]);

function validateColumns(db: Database, expected: Definition): void {
  const actual = db.query<ColumnInfo, [string]>(`SELECT name,type,"notnull" AS "notNull",pk,hidden FROM pragma_table_xinfo(?,'main')`).all(expected.name);
  if (actual.length !== Object.keys(expected.columns).length) invalid();
  for (const column of actual) {
    const spec = expected.columns[column.name];
    if (!Object.hasOwn(expected.columns, column.name) || !spec || column.type.toUpperCase() !== spec.type ||
      smallInteger(column.notNull) !== spec.notNull || smallInteger(column.hidden) !== 0) invalid();
  }
  const primary = actual.filter(column => smallInteger(column.pk) > 0).sort((a, b) => smallInteger(a.pk) - smallInteger(b.pk));
  if (!same(primary.map(column => column.name), expected.primaryKey) || primary.some((column, index) => smallInteger(column.pk) !== index + 1)) invalid();
  const sql = db.query<{ sql: string | null }, [string]>("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?").get(expected.name)?.sql;
  if (!sql || /\bAUTOINCREMENT\b/i.test(sql) !== expected.autoIncrement) invalid();
}

function validateUniqueKeys(db: Database, expected: Definition): void {
  const actual: string[] = [];
  for (const index of db.query<IndexInfo, [string]>("SELECT name,\"unique\",origin,partial FROM pragma_index_list(?,'main')").all(expected.name)) {
    if (smallInteger(index.unique) !== 1) continue; // Additional non-unique performance indexes carry no payload.
    const columns = db.query<IndexColumn, [string]>("SELECT seqno,name,\"desc\",coll,\"key\" FROM pragma_index_xinfo(?,'main')").all(index.name)
      .filter(column => smallInteger(column.key) === 1).sort((a, b) => smallInteger(a.seqno) - smallInteger(b.seqno));
    const names = columns.map(column => {
      if (column.name === null || smallInteger(column.desc) !== 0 || column.coll !== "BINARY") invalid();
      return column.name;
    });
    if (index.origin === "pk") {
      if (!same(names, expected.primaryKey) || smallInteger(index.partial) !== 0) invalid();
      continue;
    }
    let where = "";
    if (smallInteger(index.partial) === 1) {
      const sql = db.query<{ sql: string | null }, [string]>("SELECT sql FROM main.sqlite_schema WHERE type='index' AND name=?").get(index.name)?.sql;
      const clause = sql?.match(/\bWHERE\b([\s\S]+)$/i)?.[1];
      if (!clause) invalid();
      where = clause;
    }
    actual.push(uniqueSignature(names, where));
  }
  if (!same(actual.sort(), expected.unique.map(key => uniqueSignature(key.columns, key.where)).sort())) invalid();
}

function validateForeignKeys(db: Database, expected: Definition): void {
  const groups = new Map<number, ForeignKeyInfo[]>();
  for (const row of db.query<ForeignKeyInfo, [string]>("SELECT * FROM pragma_foreign_key_list(?,'main')").all(expected.name)) {
    const id = smallInteger(row.id), group = groups.get(id) ?? [];
    group.push(row); groups.set(id, group);
  }
  const actual = [...groups.values()].map(group => {
    group.sort((a, b) => smallInteger(a.seq) - smallInteger(b.seq));
    const first = group[0];
    if (group.some((row, index) => smallInteger(row.seq) !== index || row.to === null || row.table !== first.table ||
      row.on_delete !== first.on_delete || row.on_update !== "NO ACTION" || row.match !== "NONE")) invalid();
    return foreignKeySignature(group.map(row => row.from), first.table, group.map(row => row.to === null ? invalid() : row.to), first.on_delete);
  });
  if (!same(actual.sort(), expected.references.map(key => foreignKeySignature(key.columns, key.table, key.target, key.onDelete)).sort())) invalid();
}

/** Read-only metadata check. Capture must call this inside its single source read transaction.
 * Defaults/CHECK expressions and trigger SQL are application-owned migration concerns, not executable backup payload.
 */
export function validateSourceSchema(db: Database): readonly TableShape[] {
  const expected = new Map([...definitions, spellingRevision].map(table => [table.name, table]));
  const required = new Set([...expected.keys(), ...virtualTables, ...shadowTables, "sqlite_sequence"]);
  for (const table of db.query<TableInfo, []>("PRAGMA main.table_list").all()) {
    if (table.schema !== "main") continue;
    if (expected.has(table.name)) {
      if (table.type !== "table" || smallInteger(table.wr) !== 0 || smallInteger(table.strict) !== 0) invalid();
    } else if (virtualTables.has(table.name)) {
      if (table.type !== "virtual") invalid();
    } else if (shadowTables.has(table.name)) {
      if (table.type !== "shadow") invalid();
    } else if (!bookkeeping.has(table.name)) invalid();
    required.delete(table.name);
  }
  if (required.size !== 0) invalid();
  for (const table of expected.values()) {
    validateColumns(db, table); validateUniqueKeys(db, table); validateForeignKeys(db, table);
  }
  return Object.freeze(definitions.map(table => Object.freeze({ name: table.name, columns: Object.freeze(Object.keys(table.columns).sort()),
    primaryKey: Object.freeze([...table.primaryKey]), preserveRowid: table.preserveRowid })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
