import type { Database } from "bun:sqlite";
import type { RawCell, RawRow } from "./format";
import { check, type Guard } from "./capture-files";
import { integer, table, text, type SqlSnapshot } from "./records";

export interface RecoveryChanges {
  readonly expected: SqlSnapshot;
  readonly addedFences: number;
  readonly interruptedRuns: number;
  readonly interruptedImportFiles: number;
  readonly invalidatedComposers: number;
}
type BeforeValues = Readonly<Record<string, RawCell>>;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textCell = (value: string): RawCell => ({ storage: "text", bytes: encoder.encode(value) });
const integerCell = (value: bigint): RawCell => ({ storage: "integer", value });
function textBytes(row: RawRow, column: string): Uint8Array {
  const cell = row.values[column]; check(cell?.storage === "text", "inconsistent-source"); return cell.bytes;
}
function beforeJson(fields: BeforeValues): string {
  const encoded: Record<string, string | null | { readonly $integer: string }> = Object.create(null);
  for (const key of Object.keys(fields).sort()) {
    const cell = fields[key];
    if (cell.storage === "null") encoded[key] = null;
    else if (cell.storage === "integer") encoded[key] = { $integer: cell.value.toString() };
    else { check(cell.storage === "text", "inconsistent-source"); encoded[key] = decoder.decode(cell.bytes); }
  }
  return `${JSON.stringify(encoded)}\n`;
}

/** Trusted offline transaction only. Plan the exact raw-row delta before issuing any write; no admission/native calls. */
export function applyRestoreRecovery(db: Database, before: SqlSnapshot, snapshotSha256: string, restoredAt: string, guard: Guard): RecoveryChanges {
  check(db.inTransaction, "inconsistent-source");
  const originalFences = table(before, "restore_fences").rows, added: RawRow[] = [];
  const identities = new Set(originalFences.map(row => JSON.stringify([text(row, "entity_kind"), text(row, "entity_id")])));
  const fence = (kind: string, id: RawCell, fields: BeforeValues): void => {
    check(id.storage === "text", "inconsistent-source");
    const key = JSON.stringify([kind, decoder.decode(id.bytes)]);
    if (identities.has(key)) return; // Earlier restore provenance is immutable, even when local fields still need interruption.
    identities.add(key);
    added.push({ rowid: null, values: { entity_kind: textCell(kind), entity_id: id,
      snapshot_sha256: textCell(snapshotSha256), restored_at: textCell(restoredAt), original_state_json: textCell(beforeJson(fields)) } });
  };
  const runWrites: { readonly id: Uint8Array; readonly generation: bigint }[] = [], fileWrites: Uint8Array[] = [], composerWrites: Uint8Array[] = [];
  const changedTurns = new Map<RawRow, RawRow>(), turns = table(before, "search_turns").rows;
  const turnsByRun = new Map(turns.map(row => [text(row, "run_id"), row]));
  const runs = table(before, "runs").rows.map(row => {
    guard(); let result = row; const fields: Record<string, RawCell> = Object.create(null);
    if (["queued", "submitting", "running", "uncertain"].includes(text(row, "status"))) {
      const generation = integer(row, "generation"), maximum = text(row, "kind") === "search" ? 9007199254740991n : 9223372036854775807n;
      check(generation >= 0n && generation < maximum, "inconsistent-source");
      fields["runs.status"] = row.values.status; fields["runs.generation"] = row.values.generation;
      result = { ...row, values: { ...row.values, status: textCell("interrupted"), generation: integerCell(generation + 1n) } };
      runWrites.push({ id: textBytes(row, "id"), generation: generation + 1n });
      const turn = turnsByRun.get(text(row, "id"));
      if (turn && integer(turn, "open_slot") !== 0n) {
        fields["search_turns.open_slot"] = turn.values.open_slot;
        changedTurns.set(turn, { ...turn, values: { ...turn.values, open_slot: integerCell(0n) } });
      }
    }
    fence("run", row.values.id, fields); return result;
  });
  for (const row of table(before, "search_native_cleanup").rows) { guard(); fence("run", row.values.run_id, {}); }
  for (const row of table(before, "markdown_imports").rows) { guard(); fence("import-batch", row.values.id, {}); }
  const files = table(before, "markdown_import_files").rows.map(row => {
    guard(); let result = row; const fields: Record<string, RawCell> = Object.create(null);
    if (row.values.outcome.storage === "null") {
      fields["markdown_import_files.outcome"] = row.values.outcome; fields["markdown_import_files.reason_code"] = row.values.reason_code;
      result = { ...row, values: { ...row.values, outcome: textCell("interrupted"), reason_code: textCell("interrupted") } };
      fileWrites.push(textBytes(row, "id"));
    }
    fence("import-file", row.values.id, fields); return result;
  });
  const composers = table(before, "search_composer_contexts").rows.map(row => {
    guard(); let result = row; const fields: Record<string, RawCell> = Object.create(null);
    if (text(row, "state") === "active") {
      fields["search_composer_contexts.state"] = row.values.state;
      result = { ...row, values: { ...row.values, state: textCell("invalidated") } }; composerWrites.push(textBytes(row, "id"));
    }
    fence("composer", row.values.id, fields); return result;
  });
  const replacements = new Map<string, readonly RawRow[]>([["runs", runs], ["search_turns", turns.map(row => changedTurns.get(row) ?? row)],
    ["markdown_import_files", files], ["search_composer_contexts", composers], ["restore_fences", [...originalFences, ...added]]]);
  const expected: SqlSnapshot = { ...before, tables: before.tables.map(captured => ({ ...captured, rows: replacements.get(captured.shape.name) ?? captured.rows })),
    rowCount: (BigInt(before.rowCount) + BigInt(added.length)).toString() };

  // Every statement and column is application-owned; all restored identities use exact UTF-8 byte binding.
  // SQLite changes() counts direct rows, excluding legitimate trigger writes included in Bun's run result.
  const directChanges = db.query<{ n: bigint }, []>("SELECT changes() AS n");
  const insert = db.query(`INSERT INTO main.restore_fences(entity_kind,entity_id,snapshot_sha256,restored_at,original_state_json)
    VALUES (CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT))`);
  for (const row of added) {
    guard(); insert.run(...["entity_kind", "entity_id", "snapshot_sha256", "restored_at", "original_state_json"].map(name => textBytes(row, name)));
    check(directChanges.get()?.n === 1n, "inconsistent-source");
  }
  const interrupt = db.query("UPDATE main.runs SET status='interrupted',generation=? WHERE id=CAST(? AS TEXT)");
  for (const run of runWrites) { guard(); interrupt.run(run.generation, run.id); check(directChanges.get()?.n === 1n, "inconsistent-source"); }
  const release = db.query("UPDATE main.markdown_import_files SET outcome='interrupted',reason_code='interrupted' WHERE id=CAST(? AS TEXT)");
  for (const id of fileWrites) { guard(); release.run(id); check(directChanges.get()?.n === 1n, "inconsistent-source"); }
  const invalidate = db.query("UPDATE main.search_composer_contexts SET state='invalidated' WHERE id=CAST(? AS TEXT)");
  for (const id of composerWrites) { guard(); invalidate.run(id); check(directChanges.get()?.n === 1n, "inconsistent-source"); }
  return { expected, addedFences: added.length, interruptedRuns: runWrites.length, interruptedImportFiles: fileWrites.length, invalidatedComposers: composerWrites.length };
}
