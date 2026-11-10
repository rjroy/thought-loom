import { expect, test } from "bun:test";
import { BackupFormatError, encodeManifest, encodeTable, type BackupManifest, type RawRow, type TableShape } from "../src/backup/format";

const utf8 = new TextEncoder();
const text = (value: string) => ({ storage: "text" as const, bytes: utf8.encode(value) });
const integer = (value: bigint) => ({ storage: "integer" as const, value });
const shape: TableShape = { name: "fixture", columns: ["value", "id", "digest", "optional"], primaryKey: ["id"], preserveRowid: false };
const rows: RawRow[] = [
  { rowid: null, values: { id: text("é"), value: text("\uFEFFfirst\r\n{\"nested\": 1}\n"), digest: { storage: "blob", bytes: new Uint8Array([0, 1, 254, 255]) }, optional: { storage: "null" } } },
  { rowid: null, values: { id: text("z"), value: text("second"), digest: { storage: "blob", bytes: new Uint8Array() }, optional: integer(-9223372036854775808n) } },
];
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// Frozen logical-1 inventory; do not derive the expected list from the encoder.
const legacyNames = [
  "thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources",
  "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections",
  "runs", "run_steps", "agent_bindings", "run_context", "run_operation_receipts", "run_issued_thoughts", "run_replies", "execution_owners",
  "export_intents", "export_reports", "import_namespaces", "import_documents", "import_locations", "import_document_parts", "import_document_seals",
  "markdown_imports", "markdown_import_files", "markdown_import_payloads", "media_store", "media_sources", "search_sessions", "search_turns",
  "search_messages", "search_discoveries", "search_content_dependencies", "search_composer_contexts", "search_composer_dependencies",
  "search_revisions", "search_native_cleanup", "restore_fences",
].sort();
const fixtureTables = () => legacyNames.map(name => ({name,path:`tables/${name}.json`,rowCount:"0",byteLength:"2",sha256:"b".repeat(64)}));

test("table bytes retain exact text and typed cells, sorted by UTF-8 key and ASCII column name", () => {
  const expected = '{"columns":["digest","id","optional","value"],"rows":[' +
    '{"rowid":null,"values":[{"$blob":""},"z",{"$integer":"-9223372036854775808"},"second"]},' +
    '{"rowid":null,"values":[{"$blob":"AAH+/w=="},"é",null,"\uFEFFfirst\\r\\n{\\"nested\\": 1}\\n"]}]}\n';
  const encoded = encodeTable(shape, rows);
  expect(encoded).toEqual(utf8.encode(expected));
  expect(encodeTable(shape, [...rows].reverse())).toEqual(encoded);
});

test("integer keys sort numerically and rowid-sensitive tables preserve numeric rowid order", () => {
  const byKey: TableShape = { name: "import_documents", columns: ["sequence"], primaryKey: ["sequence"], preserveRowid: false };
  const numbered: RawRow[] = [
    { rowid: null, values: { sequence: integer(9223372036854775807n) } },
    { rowid: null, values: { sequence: integer(-2n) } },
    { rowid: null, values: { sequence: integer(10n) } },
  ];
  expect(decode(encodeTable(byKey, numbered))).toBe('{"columns":["sequence"],"rows":[{"rowid":null,"values":[{"$integer":"-2"}]},{"rowid":null,"values":[{"$integer":"10"}]},{"rowid":null,"values":[{"$integer":"9223372036854775807"}]}]}\n');
  const byRowid: TableShape = { name: "runs", columns: ["id"], primaryKey: ["id"], preserveRowid: true };
  const runs: RawRow[] = [
    { rowid: 20n, values: { id: text("a") } },
    { rowid: 3n, values: { id: text("z") } },
  ];
  expect(decode(encodeTable(byRowid, runs))).toBe('{"columns":["id"],"rows":[{"rowid":{"$integer":"3"},"values":["z"]},{"rowid":{"$integer":"20"},"values":["a"]}]}\n');
  expect(() => encodeTable(byRowid, [{ rowid: null, values: { id: text("missing") } }])).toThrow(BackupFormatError);
});

test("table encoding refuses invalid UTF-8, REAL, out-of-range integers and incomplete rows", () => {
  const one: TableShape = { name: "fixture", columns: ["id"], primaryKey: ["id"], preserveRowid: false };
  const invalid: RawRow[] = [
    { rowid: null, values: { id: { storage: "text", bytes: new Uint8Array([0xc3, 0x28]) } } },
    { rowid: null, values: { id: { storage: "real", value: 1.5 } } },
    { rowid: null, values: { id: integer(9223372036854775808n) } },
    { rowid: null, values: {} },
  ];
  for (const row of invalid) expect(() => encodeTable(one, [row])).toThrow(BackupFormatError);
});

test("manifest bytes have closed canonical keys, sorted entries and exact sequence high-water values", () => {
  const manifest: BackupManifest = {
    mediaStoreId: null, tables: fixtureTables().map(table => table.name === "runs"
      ? { ...table, rowCount:"1", byteLength:"8", sha256:"a".repeat(64) } : table),
    sequences: [{ name: "search_sessions", value: 9223372036854775807n }, { name: "import_documents", value: 2n }],
    mediaMarker: null, originals: [],
  };
  const encoded = encodeManifest(manifest);
  const tableBytes = legacyNames.map(name => name === "runs"
    ? `{"byteLength":"8","name":"runs","path":"tables/runs.json","rowCount":"1","sha256":"${"a".repeat(64)}"}`
    : `{"byteLength":"2","name":"${name}","path":"tables/${name}.json","rowCount":"0","sha256":"${"b".repeat(64)}"}`).join(",");
  const expected = `{"appSchema":"thoughtloom-logical-1","format":"thoughtloom-backup","mediaMarker":null,"mediaStoreId":null,"originals":[],"sequences":[{"name":"import_documents","value":{"$integer":"2"}},{"name":"search_sessions","value":{"$integer":"9223372036854775807"}}],"tables":[${tableBytes}],"version":1}\n`;
  expect(encoded).toEqual(utf8.encode(expected));
  expect(encodeManifest({ ...manifest, tables: [...manifest.tables].reverse(), sequences: [...manifest.sequences].reverse() })).toEqual(encoded);
});

test("composite keys break ties in key order and duplicate keys or preserved rowids are rejected", () => {
  const composite: TableShape = { name: "thought_sources", columns: ["thought_id", "position"], primaryKey: ["thought_id", "position"], preserveRowid: false };
  const input: RawRow[] = [
    { rowid: null, values: { thought_id: text("a"), position: integer(10n) } },
    { rowid: null, values: { thought_id: text("b"), position: integer(0n) } },
    { rowid: null, values: { thought_id: text("a"), position: integer(2n) } },
  ];
  expect(decode(encodeTable(composite, input))).toBe('{"columns":["position","thought_id"],"rows":[{"rowid":null,"values":[{"$integer":"2"},"a"]},{"rowid":null,"values":[{"$integer":"10"},"a"]},{"rowid":null,"values":[{"$integer":"0"},"b"]}]}\n');
  expect(() => encodeTable(composite, [...input, input[0]])).toThrow(BackupFormatError);
  const rowidShape: TableShape = { name: "runs", columns: ["id"], primaryKey: ["id"], preserveRowid: true };
  const runs: RawRow[] = [{ rowid: 4n, values: { id: text("a") } }, { rowid: 4n, values: { id: text("b") } }];
  expect(() => encodeTable(rowidShape, runs)).toThrow(BackupFormatError);
  expect(() => encodeTable(rowidShape, [runs[0], { rowid: 5n, values: { id: text("a") } }])).toThrow(BackupFormatError);
});

test("closed manifest rejects unsafe metadata and incoherent media without inventing membership checks", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const digest = "a".repeat(64);
  const table = { name: "runs", path: "tables/runs.json", rowCount: "1", byteLength: "8", sha256: digest };
  const marker = { path: "media/store.json", byteLength: "10", sha256: digest };
  const original = { sourceId: id, path: `media/objects/${id}`, byteLength: "1", sha256: digest };
  const tables = fixtureTables().map(entry => entry.name === "runs" ? table : entry);
  const valid: BackupManifest = { mediaStoreId: id, mediaMarker: marker, originals: [original], tables, sequences: [{ name: "search_sessions", value: 5n }] };
  expect(encodeManifest(valid).byteLength).toBeGreaterThan(0);
  const extraTable = { ...table, timestamp: "2030" };
  const extraManifest = { ...valid, timestamp: "2030" };
  const invalid: BackupManifest[] = [
    { ...valid, sequences: [...valid.sequences, { name: "search_sessions", value: 6n }] },
    { ...valid, sequences: [{ name: "unexpected_table", value: 1n }] },
    { ...valid, tables: [...tables, table] },
    { ...valid, tables: tables.filter(entry => entry.name !== "runs") },
    { ...valid, tables: tables.map(entry => entry.name === "runs" ? { ...table, path: "tables/../runs.json" } : entry) },
    { ...valid, tables: tables.map(entry => entry.name === "runs" ? { ...table, path: "tables/thoughts.json" } : entry) },
    { ...valid, tables: tables.map(entry => entry.name === "runs" ? { ...table, rowCount: "01" } : entry) },
    { ...valid, tables: tables.map(entry => entry.name === "runs" ? { ...table, byteLength: "-1" } : entry) },
    { ...valid, tables: tables.map(entry => entry.name === "runs" ? { ...table, sha256: "A".repeat(64) } : entry) },
    { ...valid, tables: tables.map(entry => entry.name === "runs" ? extraTable : entry) }, extraManifest,
    { ...valid, mediaMarker: null },
    { ...valid, mediaStoreId: null },
    { ...valid, mediaMarker: { ...marker, path: "media/../store.json" } },
    { ...valid, originals: [{ ...original, path: "media/objects/other" }] },
    { ...valid, originals: [original, original] },
  ];
  for (const manifest of invalid) expect(() => encodeManifest(manifest)).toThrow(BackupFormatError);
});
