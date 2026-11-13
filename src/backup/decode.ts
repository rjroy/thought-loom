import { BackupFormatError, encodeManifest, encodeTable, type BackupManifest, type RawCell, type RawRow } from "./format";
import { definitionsForSchema, shapesForSchema, type BackupAppSchema } from "./schema";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), encoder = new TextEncoder();
function invalid(): never { throw new BackupFormatError(); }
function isObject(value: unknown): value is Record<string,unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value,key))) invalid();
  return value;
}
function string(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value; }
function integer(value: unknown): bigint {
  const raw = string(object(value,["$integer"]).$integer);
  if (!/^(0|-?[1-9][0-9]*)$/.test(raw) || raw.length > 20) invalid();
  const result = BigInt(raw);
  if (result < -9223372036854775808n || result > 9223372036854775807n) invalid();
  return result;
}
function equal(actual: Uint8Array, expected: Uint8Array): void {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) invalid();
}
function file(value: unknown): { path: string; byteLength: string; sha256: string } {
  const entry = object(value,["path","byteLength","sha256"]);
  return { path: string(entry.path), byteLength: string(entry.byteLength), sha256: string(entry.sha256) };
}

export function decodeManifest(bytes: Uint8Array): BackupManifest {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    const root = object(parsed,["appSchema","format","mediaMarker","mediaStoreId","originals","sequences","tables","version"]);
    if ((root.appSchema !== "thoughtloom-logical-1" && root.appSchema !== "thoughtloom-logical-2" && root.appSchema !== "thoughtloom-logical-3" && root.appSchema !== "thoughtloom-logical-4" && root.appSchema !== "thoughtloom-logical-5") || root.format !== "thoughtloom-backup" || root.version !== 1) invalid();
    const schema = root.appSchema;
    const tables = array(root.tables).map(value => {
      const entry = object(value,["name","path","rowCount","byteLength","sha256"]);
      return { name: string(entry.name), path: string(entry.path), rowCount: string(entry.rowCount),
        byteLength: string(entry.byteLength), sha256: string(entry.sha256) };
    });
    const shapes = shapesForSchema(schema);
    if (tables.length !== shapes.length || tables.some((entry,index) => entry.name !== shapes[index].name)) invalid();
    const manifest: BackupManifest = {
      ...(schema !== "thoughtloom-logical-1" ? {appSchema:schema} : {}),
      tables,
      originals: array(root.originals).map(value => {
        const entry = object(value,["sourceId","path","byteLength","sha256"]);
        return { sourceId: string(entry.sourceId), path: string(entry.path), byteLength: string(entry.byteLength), sha256: string(entry.sha256) };
      }),
      sequences: array(root.sequences).map(value => {
        const entry = object(value,["name","value"]); return { name: string(entry.name), value: integer(entry.value) };
      }),
      mediaStoreId: root.mediaStoreId === null ? null : string(root.mediaStoreId),
      mediaMarker: root.mediaMarker === null ? null : file(root.mediaMarker),
    };
    equal(encodeManifest(manifest),bytes); return manifest;
  } catch { return invalid(); }
}

export function decodeTable(tableName: string, bytes: Uint8Array, schema: BackupAppSchema = "thoughtloom-logical-5"): readonly RawRow[] {
  try {
    const definition = definitionsForSchema(schema).find(table => table.shape.name === tableName);
    if (!definition) invalid();
    const parsed: unknown = JSON.parse(decoder.decode(bytes)), root = object(parsed,["columns","rows"]);
    const columns = array(root.columns).map(string), shape = definition.shape;
    if (columns.length !== shape.columns.length || columns.some((name,index) => name !== shape.columns[index])) invalid();
    const rows: RawRow[] = array(root.rows).map(value => {
      const row = object(value,["rowid","values"]), cells = array(row.values), values: Record<string,RawCell> = Object.create(null);
      if (cells.length !== columns.length) invalid();
      for (const [index,name] of columns.entries()) {
        const cell = cells[index], spec = definition.columns[name];
        if (cell === null) { if (!spec.nullable) invalid(); values[name] = { storage: "null" }; }
        else if (spec.storage === "integer") values[name] = { storage: "integer", value: integer(cell) };
        else if (spec.storage === "text") values[name] = { storage: "text", bytes: encoder.encode(string(cell)) };
        else {
          const encoded = string(object(cell,["$blob"]).$blob), raw = Buffer.from(encoded,"base64");
          if (raw.toString("base64") !== encoded) invalid();
          values[name] = { storage: "blob", bytes: new Uint8Array(raw) };
        }
      }
      return { rowid: row.rowid === null ? null : integer(row.rowid), values };
    });
    equal(encodeTable(shape,rows),bytes); return rows;
  } catch { return invalid(); }
}
