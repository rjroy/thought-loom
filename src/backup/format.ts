import { shapesForSchema, type BackupAppSchema } from "./schema";

export interface TableShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly preserveRowid: boolean;
}

export type RawCell =
  | { readonly storage: "null" }
  | { readonly storage: "text" | "blob"; readonly bytes: Uint8Array }
  | { readonly storage: "integer"; readonly value: bigint }
  | { readonly storage: "real"; readonly value: number };

export interface RawRow {
  readonly rowid: bigint | null;
  readonly values: Readonly<Record<string, RawCell>>;
}

export interface BackupManifest {
  /** Omitted only by older internal callers; their historical encoding remains logical-1. */
  readonly appSchema?: BackupAppSchema;
  readonly mediaStoreId: string | null;
  readonly tables: readonly { readonly name: string; readonly path: string; readonly rowCount: string; readonly byteLength: string; readonly sha256: string }[];
  readonly sequences: readonly { readonly name: string; readonly value: bigint }[];
  readonly mediaMarker: { readonly path: string; readonly byteLength: string; readonly sha256: string } | null;
  readonly originals: readonly { readonly sourceId: string; readonly path: string; readonly byteLength: string; readonly sha256: string }[];
}

export class BackupFormatError extends Error {
  constructor() { super("Invalid backup format"); }
}

interface IntegerCell { readonly $integer: string }
type EncodedCell = null | string | IntegerCell | { readonly $blob: string };
type KeyCell = Extract<RawCell, { readonly storage: "integer" }> | { readonly storage: "text"; readonly bytes: Uint8Array };
interface PreparedRow {
  readonly order: bigint | null;
  readonly key: readonly KeyCell[];
  readonly rowid: IntegerCell | null;
  readonly values: readonly EncodedCell[];
}

const utf8 = new TextEncoder();
// ignoreBOM means decode the BOM as a character, rather than consuming it.
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const minimumInteger = -9223372036854775808n, maximumInteger = 9223372036854775807n;
const identifier = /^[a-z][a-z0-9_]*$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sequenceTables = new Set(["import_documents", "markdown_imports", "search_sessions"]);
function invalid(): never { throw new BackupFormatError(); }
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const compareInteger = (left: bigint, right: bigint): number => left < right ? -1 : left > right ? 1 : 0;

/** Closed internal input shapes; never invoke caller toJSON methods in the output. */
function closed(value: unknown, keys: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype: object | null = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}

function integer(value: bigint): IntegerCell {
  if (typeof value !== "bigint" || value < minimumInteger || value > maximumInteger) invalid();
  return { $integer: value.toString() };
}

function encodeCell(cell: RawCell): EncodedCell {
  if (typeof cell !== "object" || cell === null) invalid();
  switch (cell.storage) {
    case "null": closed(cell, ["storage"]); return null;
    case "integer": closed(cell, ["storage", "value"]); return integer(cell.value);
    case "blob":
      closed(cell, ["storage", "bytes"]);
      if (!(cell.bytes instanceof Uint8Array)) invalid();
      return { $blob: Buffer.from(cell.bytes).toString("base64") };
    case "text": {
      closed(cell, ["storage", "bytes"]);
      if (!(cell.bytes instanceof Uint8Array)) invalid();
      try { return textDecoder.decode(cell.bytes); }
      catch { return invalid(); }
    }
    default: return invalid(); // REAL and unknown storage classes are never coerced.
  }
}

function keyCell(cell: RawCell): KeyCell {
  if (cell.storage === "integer") return cell;
  if (cell.storage === "text") return { storage: "text", bytes: cell.bytes };
  return invalid(); // Supported primary keys contain only non-null TEXT/INTEGER.
}

function compareKeys(left: readonly KeyCell[], right: readonly KeyCell[]): number {
  for (let position = 0; position < left.length; position++) {
    const a = left[position], b = right[position];
    let order: number;
    if (a.storage === "integer" && b.storage === "integer") order = compareInteger(a.value, b.value);
    else if (a.storage === "text" && b.storage === "text") order = Buffer.compare(a.bytes, b.bytes);
    else return invalid(); // A key column must not mix SQLite storage classes.
    if (order !== 0) return order;
  }
  return 0;
}

function dense(values: readonly unknown[]): void {
  if (!Array.isArray(values) || Object.keys(values).length !== values.length) invalid();
  for (let position = 0; position < values.length; position++) if (!Object.hasOwn(values, position)) invalid();
}

function uniqueNames(names: readonly string[], valid: (name: string) => boolean): void {
  dense(names);
  if (names.some(name => typeof name !== "string" || !valid(name)) || new Set(names).size !== names.length) invalid();
}

function jsonBytes(value: object): Uint8Array {
  return utf8.encode(`${JSON.stringify(value)}\n`);
}

/** Canonical encoding only. The capture boundary supplies schema-validated raw cells. */
export function encodeTable(shape: TableShape, rows: readonly RawRow[]): Uint8Array {
  closed(shape, ["name", "columns", "primaryKey", "preserveRowid"]);
  if (typeof shape.name !== "string" || !identifier.test(shape.name) || typeof shape.preserveRowid !== "boolean") invalid();
  dense(rows);
  uniqueNames(shape.columns, name => identifier.test(name));
  uniqueNames(shape.primaryKey, name => shape.columns.includes(name));
  if (shape.columns.length === 0 || shape.primaryKey.length === 0) invalid();
  const columns = [...shape.columns].sort(compareText);
  const prepared: PreparedRow[] = rows.map(row => {
    closed(row, ["rowid", "values"]);
    closed(row.values, columns);
    const values = columns.map(name => encodeCell(row.values[name]));
    const rowid = shape.preserveRowid ? integer(row.rowid === null ? invalid() : row.rowid) : null;
    if (!shape.preserveRowid && row.rowid !== null) invalid();
    return { order: row.rowid, key: shape.primaryKey.map(name => keyCell(row.values[name])), rowid, values };
  });
  const first = prepared[0];
  if (first && prepared.some(row => row.key.some((cell, position) => cell.storage !== first.key[position].storage))) invalid();
  prepared.sort((left, right) => compareKeys(left.key, right.key));
  for (let position = 1; position < prepared.length; position++) {
    if (compareKeys(prepared[position - 1].key, prepared[position].key) === 0) invalid();
  }
  if (shape.preserveRowid) {
    prepared.sort((left, right) => compareInteger(left.order === null ? invalid() : left.order, right.order === null ? invalid() : right.order));
    for (let position = 1; position < prepared.length; position++) {
      if (prepared[position - 1].order === prepared[position].order) invalid();
    }
  }
  return jsonBytes({ columns, rows: prepared.map(({ rowid, values }) => ({ rowid, values })) });
}

function decimal(value: string): void {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
}

function file(entry: { readonly path: string; readonly byteLength: string; readonly sha256: string }, path: string): void {
  if (entry.path !== path) invalid();
  decimal(entry.byteLength);
  if (entry.byteLength === "0" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) invalid();
}

/** Validate closed manifest metadata; source/file membership and actual hashes belong to capture. */
export function encodeManifest(manifest: BackupManifest): Uint8Array {
  closed(manifest, [...(manifest.appSchema === undefined ? [] : ["appSchema"]), "mediaStoreId", "tables", "sequences", "mediaMarker", "originals"]);
  const appSchema = manifest.appSchema ?? "thoughtloom-logical-1";
  if (appSchema !== "thoughtloom-logical-1" && appSchema !== "thoughtloom-logical-2" && appSchema !== "thoughtloom-logical-3" && appSchema !== "thoughtloom-logical-4" && appSchema !== "thoughtloom-logical-5" && appSchema !== "thoughtloom-logical-6" && appSchema !== "thoughtloom-logical-7") invalid();
  dense(manifest.tables); dense(manifest.sequences); dense(manifest.originals);
  const tables = manifest.tables.map(entry => {
    closed(entry, ["name", "path", "rowCount", "byteLength", "sha256"]);
    if (typeof entry.name !== "string" || !identifier.test(entry.name)) invalid();
    file(entry, `tables/${entry.name}.json`);
    decimal(entry.rowCount);
    return { byteLength: entry.byteLength, name: entry.name, path: entry.path, rowCount: entry.rowCount, sha256: entry.sha256 };
  }).sort((left, right) => compareText(left.name, right.name));
  uniqueNames(tables.map(entry => entry.name), () => true);
  const expected = shapesForSchema(appSchema);
  if (tables.length !== expected.length || tables.some((table,index) => table.name !== expected[index]?.name)) invalid();
  const sequences = manifest.sequences.map(entry => {
    closed(entry, ["name", "value"]);
    if (!sequenceTables.has(entry.name)) invalid();
    const value = integer(entry.value);
    if (entry.value < 0n) invalid();
    return { name: entry.name, value };
  }).sort((left, right) => compareText(left.name, right.name));
  uniqueNames(sequences.map(entry => entry.name), () => true);
  const originals = manifest.originals.map(entry => {
    closed(entry, ["sourceId", "path", "byteLength", "sha256"]);
    if (typeof entry.sourceId !== "string" || !uuid.test(entry.sourceId)) invalid();
    file(entry, `media/objects/${entry.sourceId}`);
    return { byteLength: entry.byteLength, path: entry.path, sha256: entry.sha256, sourceId: entry.sourceId };
  }).sort((left, right) => compareText(left.sourceId, right.sourceId));
  uniqueNames(originals.map(entry => entry.sourceId), () => true);
  let mediaMarker: BackupManifest["mediaMarker"] = null;
  if (manifest.mediaStoreId === null) {
    if (manifest.mediaMarker !== null || originals.length !== 0) invalid();
  } else {
    if (typeof manifest.mediaStoreId !== "string" || !uuid.test(manifest.mediaStoreId) || manifest.mediaMarker === null) invalid();
    closed(manifest.mediaMarker, ["path", "byteLength", "sha256"]);
    file(manifest.mediaMarker, "media/store.json");
    mediaMarker = { byteLength: manifest.mediaMarker.byteLength, path: manifest.mediaMarker.path, sha256: manifest.mediaMarker.sha256 };
  }
  // Construct each object in ASCII key order; stored TEXT never passes a recursive JSON rewriter.
  return jsonBytes({ appSchema, format: "thoughtloom-backup", mediaMarker,
    mediaStoreId: manifest.mediaStoreId, originals, sequences, tables, version: 1 });
}
