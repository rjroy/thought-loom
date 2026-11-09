import { expect, test } from "bun:test";
import { decodeManifest, decodeTable } from "../src/backup/decode";
import { BackupFormatError, encodeManifest, encodeTable, type BackupManifest, type RawRow } from "../src/backup/format";
import { backupTableShapes } from "../src/backup/schema";

const encoder = new TextEncoder();
const text = (value: string) => ({ storage: "text" as const, bytes: encoder.encode(value) });
const integer = (value: bigint) => ({ storage: "integer" as const, value });
const shape = (name: string) => {
  const found = backupTableShapes.find(item => item.name === name);
  if (!found) throw new Error("Missing owned compiled fixture table");
  return found;
};
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
type EncodedCell = null | string | { readonly $integer: string } | { readonly $blob: string };
interface EncodedTable { columns: string[]; rows: { rowid: null | { $integer: string }; values: EncodedCell[] }[] }
const tableObject = (bytes: Uint8Array): EncodedTable => JSON.parse(new TextDecoder().decode(bytes)) as EncodedTable;
const document = (sequence: bigint): RawRow => ({ rowid: null, values: {
  sequence: integer(sequence), id: text("document"), original_bytes: { storage: "blob", bytes: new Uint8Array([0, 1, 254, 255]) },
  sha256: { storage: "blob", bytes: new Uint8Array(32).fill(7) }, byte_length: integer(4n), encoding: text("utf-8"),
  original_namespace_id: text("namespace"), original_path: text("\uFEFFpath\r\n{\"a\": 1}"), created_at: text("2030"),
  parser_version: text("fixture"), segmentation_method: text("structural"), segmentation_reason: { storage: "null" },
} });

test("decode preserves exact typed text, BLOBs, nulls and signed 64-bit integers", () => {
  for (const value of [-9223372036854775808n, 9223372036854775807n]) {
    const row = document(value), bytes = encodeTable(shape("import_documents"), [row]);
    expect(decodeTable("import_documents", bytes)).toEqual([row]);
    expect(encodeTable(shape("import_documents"), decodeTable("import_documents", bytes))).toEqual(bytes);
  }
  const rows: RawRow[] = [
    { rowid: 2n, values: { id: text("z"), kind: text("fixture"), label: text("\uFEFFlabel\r\n"), created_at: text("2030") } },
    { rowid: 15n, values: { id: text("a"), kind: text("fixture"), label: text("next"), created_at: text("2031") } },
  ];
  const bytes = encodeTable(shape("import_namespaces"), rows);
  expect(decodeTable("import_namespaces", bytes)).toEqual(rows);
});

test("table decoding rejects noncanonical cells, order, key/rowid violations and invalid UTF-8", () => {
  const documentBytes = encodeTable(shape("import_documents"), [document(1n)]);
  const base = tableObject(documentBytes), sequence = base.columns.indexOf("sequence"), blob = base.columns.indexOf("sha256");
  if (sequence < 0 || blob < 0) throw new Error("Fixture columns unavailable");
  const invalid: Uint8Array[] = [];
  for (const value of [{ $integer: "01" }, { $integer: "-0" }, { $integer: "+1" }, { $integer: "9223372036854775808" }, null, "1"]) {
    const changed = structuredClone(base); changed.rows[0].values[sequence] = value; invalid.push(json(changed));
  }
  for (const value of [{ $blob: "AQ" }, { $blob: "@@==" }, { $integer: "1" }]) {
    const changed = structuredClone(base); changed.rows[0].values[blob] = value; invalid.push(json(changed));
  }
  const duplicate = structuredClone(base); duplicate.rows.push(structuredClone(duplicate.rows[0])); invalid.push(json(duplicate));
  const extra = structuredClone(base); extra.columns.push("unknown"); invalid.push(json(extra));
  invalid.push(encoder.encode(` ${new TextDecoder().decode(documentBytes)}`), Uint8Array.from([0xff, 0x7b, 0x7d, 0x0a]));
  for (const bytes of invalid) expect(() => decodeTable("import_documents", bytes)).toThrow(BackupFormatError);
  expect(() => decodeTable("unknown_table", documentBytes)).toThrow(BackupFormatError);
  const rows: RawRow[] = [
    { rowid: 2n, values: { id: text("a"), kind: text("fixture"), label: text("one"), created_at: text("2030") } },
    { rowid: 7n, values: { id: text("b"), kind: text("fixture"), label: text("two"), created_at: text("2030") } },
  ];
  const ordered = tableObject(encodeTable(shape("import_namespaces"), rows));
  const reversed = structuredClone(ordered); reversed.rows.reverse();
  const sameRowid = structuredClone(ordered); sameRowid.rows[1].rowid = sameRowid.rows[0].rowid;
  const missingRowid = structuredClone(ordered); missingRowid.rows[0].rowid = null;
  const duplicateId = structuredClone(ordered), id = duplicateId.columns.indexOf("id");
  if (id < 0) throw new Error("Fixture ID column unavailable");
  duplicateId.rows[1].values[id] = duplicateId.rows[0].values[id];
  for (const value of [reversed, sameRowid, missingRowid, duplicateId]) expect(() => decodeTable("import_namespaces", json(value))).toThrow(BackupFormatError);
});

test("manifest decoding requires the complete canonical inventory and exact typed sequences", () => {
  const manifest: BackupManifest = { mediaStoreId: null, mediaMarker: null, originals: [],
    tables: backupTableShapes.map(table => ({ name: table.name, path: `tables/${table.name}.json`, rowCount: "0", byteLength: "1", sha256: "a".repeat(64) })),
    sequences: [{ name: "import_documents", value: 9223372036854775807n }],
  };
  const bytes = encodeManifest(manifest);
  expect(decodeManifest(bytes)).toEqual(manifest);
  expect(encodeManifest(decodeManifest(bytes))).toEqual(bytes);
  const root = JSON.parse(new TextDecoder().decode(bytes)) as { appSchema: string; tables: unknown[]; sequences: unknown[] };
  const missing = structuredClone(root); missing.tables.pop();
  const duplicate = structuredClone(root); duplicate.tables.push(duplicate.tables[0]);
  const unknown = structuredClone(root); unknown.appSchema = "unknown";
  const badSequence = structuredClone(root); badSequence.sequences = [{ name: "import_documents", value: { $integer: "01" } }];
  for (const value of [missing, duplicate, unknown, badSequence]) expect(() => decodeManifest(json(value))).toThrow(BackupFormatError);
  expect(() => decodeManifest(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]))).toThrow(BackupFormatError);
});
