import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RawCell, RawRow, TableShape } from "./format";
import { validateSourceSchema } from "./schema";
import { check, type Guard } from "./capture-files";
import { parseScreeningJudgment, parseScreeningPolicy } from "../domain/connection-screening";
import { connectionDiscoveryPrefix, directConnectionDiscoveryPrefix } from "../domain/weave-scheduling";
import { createConnection } from "../domain/connection";
import { assertConnectionOperationRecord, parseConnectionOperationResult, parseStepOperation, stepOperationEnvelope } from "../domain/run-operations";
import { parseEnvelope, protocolJson } from "../domain/run-protocol";

export interface CapturedTable { readonly shape: TableShape; readonly rows: readonly RawRow[] }
export interface SqlSnapshot {
  readonly tables: readonly CapturedTable[];
  readonly sequences: readonly { readonly name: string; readonly value: bigint }[];
  readonly rowCount: string;
}
type SqlValue = string | bigint | number | Uint8Array | null;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function noRows(db: Database, sql: string): void { check(db.query(sql).get() === null, "inconsistent-source"); }
function ordered(db: Database, table: string, owner: string, position = "position", filter = ""): void {
  noRows(db, `SELECT 1 FROM (SELECT count(*) AS n,min(${quote(position)}) AS lo,max(${quote(position)}) AS hi
    FROM main.${quote(table)} ${filter} GROUP BY ${quote(owner)}) WHERE lo!=0 OR hi!=n-1 LIMIT 1`);
}
function polymorphic(db: Database, table: string, kind: string, id: string): void {
  noRows(db, `SELECT 1 FROM main.${quote(table)} x WHERE
    x.${quote(kind)} NOT IN ('thought','connection','response') OR
    (x.${quote(kind)}='thought' AND NOT EXISTS(SELECT 1 FROM main.thoughts t WHERE t.id=x.${quote(id)})) OR
    (x.${quote(kind)}='connection' AND NOT EXISTS(SELECT 1 FROM main.connections c WHERE c.id=x.${quote(id)})) OR
    (x.${quote(kind)}='response' AND NOT EXISTS(SELECT 1 FROM main.responses r WHERE r.id=x.${quote(id)})) LIMIT 1`);
}

/** Read-only cross-row checks: no admission replay or initial-title assumptions. */
export function validateRecords(db: Database): void {
  check(db.query<{ integrity_check: string }, []>("PRAGMA main.integrity_check(1)").get()?.integrity_check === "ok", "inconsistent-source");
  noRows(db, "PRAGMA main.foreign_key_check");
  noRows(db,`SELECT 1 FROM main.runs d LEFT JOIN main.thoughts t ON t.id=d.weave_subject_id
    WHERE d.kind='weave' AND substr(d.weave_trigger_id,1,${connectionDiscoveryPrefix.length})='${connectionDiscoveryPrefix}' AND (
      t.kind='media-original' OR NOT EXISTS(SELECT 1 FROM main.runs origin
        WHERE origin.id=substr(d.weave_trigger_id,${connectionDiscoveryPrefix.length + 1}) AND origin.kind IN ('weave','evolve')
          AND ((origin.kind='evolve' AND origin.input_thought_id=d.weave_subject_id) OR EXISTS(
            SELECT 1 FROM main.run_issued_thoughts i WHERE i.run_id=origin.id AND i.thought_id=d.weave_subject_id)))
      OR EXISTS(SELECT 1 FROM main.run_issued_thoughts i WHERE i.run_id=d.id)
      OR EXISTS(SELECT 1 FROM main.run_replies r WHERE r.run_id=d.id AND (r.draft_json IS NOT NULL OR r.response_id IS NOT NULL))) LIMIT 1`);
  noRows(db,`SELECT 1 FROM main.runs d LEFT JOIN main.thoughts t ON t.id=d.weave_subject_id
    WHERE d.kind='weave' AND substr(d.weave_trigger_id,1,${directConnectionDiscoveryPrefix.length})='${directConnectionDiscoveryPrefix}' AND (
      d.weave_subject_id IS NOT substr(d.weave_trigger_id,${directConnectionDiscoveryPrefix.length + 1}) OR t.parent_id IS NULL
      OR NOT ((t.kind='user-contribution' AND t.author='user' AND t.origin='contribution' AND NOT EXISTS(SELECT 1 FROM main.thought_sources s WHERE s.thought_id=t.id))
        OR (t.kind='developing-idea' AND t.author='ai' AND t.origin='development'))
      OR EXISTS(SELECT 1 FROM main.runs r WHERE r.input_thought_id=t.id)
      OR EXISTS(SELECT 1 FROM main.run_issued_thoughts i WHERE i.thought_id=t.id OR i.run_id=d.id)
      OR EXISTS(SELECT 1 FROM main.run_replies r WHERE r.run_id=d.id AND (r.draft_json IS NOT NULL OR r.response_id IS NOT NULL))) LIMIT 1`);
  for (const [table, owner] of [["thought_sources", "thought_id"], ["connection_sources", "connection_id"], ["response_thoughts", "response_id"],
    ["run_steps", "run_id"], ["run_issued_thoughts", "run_id"], ["import_document_parts", "document_id"], ["markdown_import_files", "import_id"],
    ["search_turns", "session_id"], ["search_messages", "session_id"], ["search_discoveries", "session_id"]]) ordered(db, table, owner);
  ordered(db, "import_document_parts", "document_id", "thought_ordinal", "WHERE kind='thought'");
  ordered(db,"run_screening_pairs","run_id");
  noRows(db,`SELECT 1 FROM main.run_screening_passes p JOIN main.runs r ON r.id=p.run_id
    JOIN main.thoughts t ON t.id=p.subject_id JOIN main.run_steps s ON s.run_id=r.id AND s.position=0
    WHERE r.kind!='weave' OR r.weave_subject_id IS NOT p.subject_id OR t.kind='media-original'
      OR p.candidate_count!=(SELECT count(*) FROM main.run_screening_pairs j WHERE j.run_id=p.run_id)
      OR (p.status='collecting' AND s.input IS NOT NULL)
      OR (p.status='complete' AND (s.input IS NULL OR EXISTS(SELECT 1 FROM main.run_screening_pairs j WHERE j.run_id=p.run_id AND j.judgment_json IS NULL))) LIMIT 1`);
  noRows(db,`SELECT 1 FROM main.run_screening_pairs j JOIN main.run_screening_passes p ON p.run_id=j.run_id
    JOIN main.thoughts t ON t.id=j.candidate_id WHERE t.kind='media-original' OR j.candidate_id=p.subject_id
      OR (j.judgment_json IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM main.run_context c WHERE c.run_id=j.run_id AND c.kind='thought' AND c.ref_id=j.candidate_id)
        OR NOT EXISTS(SELECT 1 FROM main.run_context c WHERE c.run_id=j.run_id AND c.kind='thought' AND c.ref_id=p.subject_id))) LIMIT 1`);
  for (const [table, kind, id] of [["run_context", "kind", "ref_id"], ["search_content_dependencies", "ref_kind", "ref_id"],
    ["search_composer_dependencies", "ref_kind", "ref_id"]]) polymorphic(db, table, kind, id);
  noRows(db, `SELECT 1 FROM main.thoughts t WHERE
    NOT EXISTS(SELECT 1 FROM main.thought_titles m WHERE m.thought_id=t.id) OR
    NOT EXISTS(SELECT 1 FROM main.thought_source_seals s WHERE s.thought_id=t.id) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.responses r WHERE NOT EXISTS(SELECT 1 FROM main.response_seals s WHERE s.response_id=r.id) OR
    (SELECT count(*) FROM main.response_thoughts a WHERE a.response_id=r.id)=0 OR
    (r.role='fallback' AND (SELECT count(*) FROM main.response_thoughts a WHERE a.response_id=r.id)!=1) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.runs r WHERE NOT EXISTS(SELECT 1 FROM main.run_steps s WHERE s.run_id=r.id AND s.position=0 AND s.prompt_id=r.prompt_id) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.run_operation_receipts r WHERE r.format='step' AND NOT EXISTS(
    SELECT 1 FROM main.run_steps s WHERE s.run_id=r.run_id AND s.prompt_id=r.operation_id) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.export_reports e WHERE NOT EXISTS(SELECT 1 FROM main.run_steps s WHERE s.run_id=e.run_id AND s.prompt_id=e.prompt_id) LIMIT 1`);
  // Deleting is an uncommitted purge capability, never a portable or committed lifecycle state.
  noRows(db, `SELECT 1 FROM main.export_intents i JOIN main.runs r ON r.id=i.run_id WHERE r.kind!='export'
    OR i.local_disposition NOT IN ('retained','local-stopped')
    OR (i.local_disposition='local-stopped' AND (r.status NOT IN ('completed','interrupted','failed') OR NOT EXISTS(
      SELECT 1 FROM main.restore_fences f WHERE f.entity_kind='run' AND f.entity_id=r.id))) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.media_sources m JOIN main.thoughts t ON t.id=m.source_thought_id
    WHERE t.kind!='media-original' OR t.created_at!=m.created_at LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.thoughts t WHERE (t.kind='media-original')!=EXISTS(SELECT 1 FROM main.media_sources m WHERE m.source_thought_id=t.id) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.thought_sources s JOIN main.thoughts t ON t.id=s.thought_id WHERE t.kind IN ('media-original','imported-original') LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.import_documents d WHERE NOT EXISTS(SELECT 1 FROM main.import_document_seals s WHERE s.document_id=d.id) OR
    (d.byte_length=0 AND EXISTS(SELECT 1 FROM main.import_document_parts p WHERE p.document_id=d.id)) OR
    (d.byte_length>0 AND (NOT EXISTS(SELECT 1 FROM main.import_document_parts p WHERE p.document_id=d.id AND p.position=0 AND p.start_byte=0) OR
      d.byte_length IS NOT (SELECT p.end_byte FROM main.import_document_parts p WHERE p.document_id=d.id ORDER BY p.position DESC LIMIT 1))) OR
    ((d.segmentation_method='not-needed')!=(NOT EXISTS(SELECT 1 FROM main.import_document_parts p WHERE p.document_id=d.id AND p.kind='thought'))) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.import_document_parts p JOIN main.import_documents d ON d.id=p.document_id
    WHERE p.end_byte>d.byte_length OR (p.position>0 AND p.start_byte IS NOT
      (SELECT q.end_byte FROM main.import_document_parts q WHERE q.document_id=p.document_id AND q.position=p.position-1)) OR
    (p.kind='bom' AND (p.position!=0 OR p.start_byte!=0 OR p.end_byte!=3 OR substr(d.original_bytes,1,3)!=x'efbbbf')) OR
    (p.kind='frontmatter' AND (p.start_byte!=CASE WHEN substr(d.original_bytes,1,3)=x'efbbbf' THEN 3 ELSE 0 END OR
      (substr(d.original_bytes,p.start_byte+1,4)!=x'2d2d2d0a' AND substr(d.original_bytes,p.start_byte+1,4)!=x'2d2d2d0d'))) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.import_documents d WHERE
    (substr(d.original_bytes,1,3)=x'efbbbf' AND NOT EXISTS(SELECT 1 FROM main.import_document_parts p WHERE p.document_id=d.id AND p.kind='bom')) OR
    (SELECT count(*) FROM main.import_document_parts p WHERE p.document_id=d.id AND p.kind='frontmatter')>1 LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.import_document_parts p JOIN main.thoughts t ON t.id=p.thought_id
    JOIN main.import_documents d ON d.id=p.document_id WHERE p.kind='thought' AND
    (t.import_document_id IS NOT d.id OR t.kind!='imported-original' OR CAST(t.text AS BLOB)!=substr(d.original_bytes,p.start_byte+1,p.end_byte-p.start_byte)) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.thoughts t WHERE t.kind='imported-original' AND NOT EXISTS(
    SELECT 1 FROM main.import_document_parts p WHERE p.document_id=t.import_document_id AND p.thought_id=t.id AND p.kind='thought') LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.import_documents d JOIN main.import_namespaces n ON n.id=d.original_namespace_id
    WHERE n.kind!='loose-markdown' AND NOT EXISTS(SELECT 1 FROM main.import_locations l WHERE l.document_id=d.id AND l.namespace_id=n.id AND l.relative_path=d.original_path) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.markdown_import_files f LEFT JOIN main.runs r ON r.id=f.run_id
    WHERE (f.run_id IS NOT NULL AND r.kind!='import') OR (f.outcome IS NULL AND NOT EXISTS(SELECT 1 FROM main.markdown_import_payloads p WHERE p.file_id=f.id)) OR
    (f.waiting_on_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM main.markdown_import_files h WHERE h.id=f.waiting_on_file_id AND h.run_id IS NOT NULL AND h.waiting_on_file_id IS NULL)) LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.markdown_import_payloads p JOIN main.markdown_import_files f ON f.id=p.file_id WHERE length(p.bytes)!=f.byte_length LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.search_turns t JOIN main.runs r ON r.id=t.run_id WHERE r.kind!='search' OR
    t.open_slot IS NOT (r.status IN ('queued','submitting','running','uncertain')) OR
    NOT EXISTS(SELECT 1 FROM main.search_messages m WHERE m.run_id=t.run_id AND m.role='user') LIMIT 1`);
  noRows(db, `SELECT 1 FROM main.search_discoveries d JOIN main.run_steps s ON s.prompt_id=d.added_prompt_id WHERE s.run_id!=d.added_run_id LIMIT 1`);
}

function readTable(db: Database, shape: TableShape): CapturedTable {
  const columns = db.query<{ name: string; type: string; required: bigint }, [string]>(
    `SELECT name,type,"notnull" AS required FROM pragma_table_xinfo(?,'main')`).all(shape.name);
  const types = new Map(columns.map(column => [column.name, column]));
  const projections = shape.columns.flatMap((column, position) => [`typeof(${quote(column)}) AS ${quote(`type_${position}`)}`,
    `CASE WHEN typeof(${quote(column)})='text' THEN CAST(${quote(column)} AS BLOB) ELSE ${quote(column)} END AS ${quote(`value_${position}`)}`]);
  const rows: RawRow[] = [];
  for (const raw of db.query<Record<string, SqlValue>, []>(`SELECT ${shape.preserveRowid ? 'rowid AS preserved_rowid,' : ''}${projections.join(',')} FROM main.${quote(shape.name)}`).iterate()) {
    const values: Record<string, RawCell> = Object.create(null);
    for (const [position, column] of shape.columns.entries()) {
      const storage = raw[`type_${position}`], value = raw[`value_${position}`], declared = types.get(column);
      check(declared !== undefined && (storage === declared.type.toLowerCase() || (storage === "null" && declared.required === 0n)), "invalid-storage-class");
      if (storage === "null") { check(value === null); values[column] = { storage: "null" }; }
      else if (storage === "integer") { check(typeof value === "bigint"); values[column] = { storage, value }; }
      else { check((storage === "text" || storage === "blob") && value instanceof Uint8Array); values[column] = { storage, bytes: new Uint8Array(value) }; }
    }
    const rowid = shape.preserveRowid ? raw.preserved_rowid : null;
    check(rowid === null || typeof rowid === "bigint"); rows.push({ rowid, values });
  }
  check(db.query<{ n: bigint }, []>(`SELECT count(*) AS n FROM main.${quote(shape.name)}`).get()?.n === BigInt(rows.length), "inconsistent-source");
  return { shape, rows };
}

/** Caller owns a safe-integer connection and a stable SQL transaction; WAL is capture's separate responsibility. */
export function readSqlSnapshot(db: Database, guard: Guard, inventory: readonly TableShape[] = validateSourceSchema(db)): SqlSnapshot {
  guard(); validateRecords(db);
  const tables = inventory.map(shape => { guard(); return readTable(db, shape); });
  const sequences = db.query<{ name: string; seq: bigint }, []>("SELECT name,seq FROM main.sqlite_sequence ORDER BY name").all().map(row => {
    check(["import_documents", "markdown_imports", "search_sessions"].includes(row.name) && typeof row.seq === "bigint" && row.seq >= 0n);
    const maximum = db.query<{ n: bigint }, []>(`SELECT coalesce(max(sequence),0) AS n FROM main.${quote(row.name)}`).get()?.n;
    check(maximum !== undefined && row.seq >= maximum, "inconsistent-source");
    return { name: row.name, value: row.seq };
  });
  for (const name of ["import_documents","markdown_imports","search_sessions"]) {
    check(sequences.some(entry => entry.name === name) || db.query(`SELECT 1 FROM main.${quote(name)} LIMIT 1`).get() === null,"inconsistent-source");
  }
  guard(); return { tables, sequences, rowCount: tables.reduce((total, table) => total + BigInt(table.rows.length), 0n).toString() };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function text(row: RawRow, column: string): string {
  const cell = row.values[column]; check(cell?.storage === "text"); return decoder.decode(cell.bytes);
}
export function bytes(row: RawRow, column: string): Uint8Array {
  const cell = row.values[column]; check(cell?.storage === "blob"); return cell.bytes;
}
export function integer(row: RawRow, column: string): bigint {
  const cell = row.values[column]; check(cell?.storage === "integer"); return cell.value;
}
export function table(snapshot: SqlSnapshot, name: string): CapturedTable {
  const result = snapshot.tables.find(value => value.shape.name === name); check(result !== undefined); return result;
}
function validateApplicationIntegers(snapshot: SqlSnapshot): void {
  // Match existing revision/cursor guards, not a blanket limit on SQLite integers or future increment capacity.
  const safe = (value: bigint | null): void => {
    check(typeof value === "bigint" && value >= 0n && value <= 9007199254740991n, "inconsistent-source");
  };
  for (const [name, columns] of [
    ["search_revisions", ["eligibility", "retrieval", "catalog"]],
    ["search_sessions", ["revision", "sequence"]],
    ["search_composer_contexts", ["revision"]],
    ["import_documents", ["sequence"]],
    ["markdown_imports", ["sequence"]],
  ] as const) {
    for (const row of table(snapshot, name).rows) for (const column of columns) safe(integer(row, column));
  }
  for (const name of ["markdown_import_files", "response_thoughts"]) {
    for (const row of table(snapshot, name).rows) safe(row.rowid);
  }
  for (const row of table(snapshot, "runs").rows) if (text(row, "kind") === "search") safe(integer(row, "generation"));
}
/** TEXT payloads are extensible; old receipt encodings and all frozen inventories remain byte-exact. */
function validateConnectionReceipts(snapshot: SqlSnapshot): void {
  const key = (runId: string, id: string): string => JSON.stringify([runId,id]);
  const steps = new Map(table(snapshot,"run_steps").rows.map(row => [key(text(row,"run_id"),text(row,"prompt_id")),row]));
  const connections = new Map(table(snapshot,"connections").rows.map(row => [text(row,"id"),row]));
  const sources = new Map<string,RawRow[]>();
  for (const row of table(snapshot,"connection_sources").rows) {
    const id = text(row,"connection_id"), list = sources.get(id) ?? [];
    list.push(row); sources.set(id,list);
  }
  const context = new Map(table(snapshot,"run_context").rows.map(row => [
    JSON.stringify([text(row,"run_id"),text(row,"kind"),text(row,"ref_id")]),integer(row,"full_read") === 1n,
  ]));
  const object = (input: unknown): Record<string,unknown> | null =>
    typeof input === "object" && input !== null && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : null;
  const json = (row: RawRow, column: string): unknown => {
    if (row.values[column]?.storage !== "text") return null;
    try { return JSON.parse(text(row,column)); } catch { return null; }
  };
  for (const receipt of table(snapshot,"run_operation_receipts").rows) {
    if (text(receipt,"format") !== "step") continue;
    const runId = text(receipt,"run_id"), step = steps.get(key(runId,text(receipt,"operation_id")));
    const operationValue = json(receipt,"operation_json"), resultValue = json(receipt,"result_json");
    const request = step ? object(object(json(step,"envelope_json"))?.request) : null;
    // Do not reinterpret unrelated historical receipt payloads (including pre-media interpretations).
    if (object(operationValue)?.type !== "connection" && object(resultValue)?.type !== "connection" && request?.capability !== "connection") continue;
    try {
      const operation = parseStepOperation(operationValue);
      check(operation.type === "connection" && receipt.values.thought_id.storage === "null" && step !== undefined,"inconsistent-source");
      const result = parseConnectionOperationResult(operation,resultValue);
      check(protocolJson(parseEnvelope(text(step,"envelope_json"))) === protocolJson(stepOperationEnvelope(operation)),"inconsistent-source");
      if (step.values.result_json.storage !== "null") check(protocolJson(json(step,"result_json")) === protocolJson(resultValue),"inconsistent-source");
      if (result.status !== "not-created") {
        const row = connections.get(result.connection.id);
        check(row !== undefined,"inconsistent-source");
        const sourceIds = (sources.get(result.connection.id) ?? []).toSorted((a,b) => Number(integer(a,"position") - integer(b,"position"))).map(row => text(row,"source_id"));
        assertConnectionOperationRecord(result,createConnection({id:text(row,"id"),fromId:text(row,"from_id"),toId:text(row,"to_id"),
          category:text(row,"category"),proposedBy:text(row,"proposed_by"),explanation:text(row,"explanation"),sourceIds}));
      }
      // Older trusted aggregate callers predate full-read enforcement. Do not invent or rewrite their witnesses.
      if (result.status !== undefined) {
        const witness = (kind: string,id: string,full = false): void => {
          const read = context.get(JSON.stringify([runId,kind,id]));
          check(read !== undefined && (!full || read),"inconsistent-source");
        };
        for (const id of [operation.fromId,operation.toId,...operation.sourceIds]) witness("thought",id,true);
        if (result.status !== "not-created") {
          witness("connection",result.connection.id,true);
          for (const id of result.connection.sourceIds) witness("thought",id);
        }
      }
    } catch { check(false,"inconsistent-source"); }
  }
}
/** Shared content checks. Capture calls these only after releasing its live source transaction/connection. */
export function validateBytes(snapshot: SqlSnapshot): void {
  validateApplicationIntegers(snapshot);
  validateConnectionReceipts(snapshot);
  const screening = snapshot.tables.find(value => value.shape.name === "run_screening_passes");
  if (screening) {
    const pairs = table(snapshot,"run_screening_pairs").rows, context = table(snapshot,"run_context").rows;
    const fullReads = new Set(context.filter(row => text(row,"kind") === "thought" && integer(row,"full_read") === 1n)
      .map(row => JSON.stringify([text(row,"run_id"),text(row,"ref_id")])));
    const policies = new Map<string,ReturnType<typeof parseScreeningPolicy>>();
    for (const pass of screening.rows) {
      try { policies.set(text(pass,"run_id"),parseScreeningPolicy(text(pass,"policy_json"))); }
      catch { check(false,"inconsistent-source"); }
    }
    const complete = new Set(screening.rows.filter(row => text(row,"status") === "complete").map(row => text(row,"run_id")));
    for (const pair of pairs) {
      if (pair.values.judgment_json.storage === "null") continue;
      let score: number;
      try { score = parseScreeningJudgment(text(pair,"judgment_json")); }
      catch { check(false,"inconsistent-source"); }
      const runId = text(pair,"run_id"), policy = policies.get(runId);
      check(policy !== undefined,"inconsistent-source");
      if (complete.has(runId) && score >= policy.threshold) {
        const witness = JSON.stringify([runId,text(pair,"candidate_id")]);
        check(fullReads.has(witness),"inconsistent-source");
      }
    }
  }
  const settings = snapshot.tables.find(value => value.shape.name === "agent_instructions");
  if (settings) {
    check(settings.rows.length <= 1,"inconsistent-source");
    for (const row of settings.rows) {
      check(integer(row,"singleton") === 1n && integer(row,"revision") >= 1n && integer(row,"revision") <= 9007199254740991n,"inconsistent-source");
      for (const field of ["weaver","evolve","search","export"]) {
        const cell = row.values[field];
        check(cell?.storage === "text" && cell.bytes.length <= 16*1024,"inconsistent-source");
        text(row,field);
      }
    }
    for (const row of table(snapshot,"run_steps").rows) {
      const guidance = row.values.guidance;
      check(guidance !== undefined,"inconsistent-source");
      if (guidance.storage !== "null") {
        check(guidance.storage === "text" && guidance.bytes.length <= 16*1024 && integer(row,"position") === 0n && row.values.input.storage === "text","inconsistent-source");
        text(row,"guidance");
      }
    }
  }
  const thoughts = table(snapshot, "thoughts"), parents = new Map<string, string | null>();
  for (const row of thoughts.rows) parents.set(text(row, "id"), row.values.parent_id.storage === "null" ? null : text(row, "parent_id"));
  const visited = new Set<string>();
  for (const id of parents.keys()) {
    const path = new Set<string>(); let current: string | null = id;
    while (current !== null && !visited.has(current)) {
      check(!path.has(current) && parents.has(current), "inconsistent-source"); path.add(current); current = parents.get(current) ?? null;
    }
    for (const item of path) visited.add(item);
  }
  const files = new Map(table(snapshot, "markdown_import_files").rows.map(row => [text(row, "id"), row]));
  function payloads(rows: readonly RawRow[], dataColumn: string, lookup: (row: RawRow) => RawRow | undefined): void {
    for (const row of rows) {
      const metadata = lookup(row); check(metadata !== undefined);
      const original = bytes(row, dataColumn), digest = bytes(metadata, "sha256");
      check(integer(metadata, "byte_length") === BigInt(original.length) && digest.length === 32 &&
        Buffer.compare(digest, createHash("sha256").update(original).digest()) === 0, "inconsistent-source");
      check(!decoder.decode(original).includes("\0"), "inconsistent-source");
    }
  }
  payloads(table(snapshot, "import_documents").rows, "original_bytes", row => row);
  payloads(table(snapshot, "markdown_import_payloads").rows, "bytes", row => files.get(text(row, "file_id")));
}
