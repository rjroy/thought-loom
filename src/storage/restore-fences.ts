import type { Database } from "bun:sqlite";
import { RunFenceError } from "../domain/run";
import { assertRestoreFenceSchema } from "./restore-fences-schema";

const text = new TextEncoder();
export type RestoreEntityKind = "run" | "import-batch" | "import-file" | "composer";

/** Installation authority, independent of entity liveness. Historical identities survive content purge. */
export function isRestoreFenced(db: Database, kind: RestoreEntityKind, id: string): boolean {
  assertRestoreFenceSchema(db);
  const bytes = text.encode(id);
  const row = db.query<{ fenced: number | bigint; sameIdentity: number | bigint }, [string, Uint8Array, Uint8Array, string]>(
    `SELECT EXISTS(SELECT 1 FROM main.restore_fences WHERE entity_kind=? AND entity_id=CAST(? AS TEXT)) AS fenced,
      ?=CAST(? AS BLOB) AS sameIdentity`).get(kind,bytes,bytes,id);
  if (row === null) throw new RunFenceError("Historical identity authority is unavailable");
  // Preserve exact historical fence detection, including identities with no remaining run row.
  if (row.fenced === 1 || row.fenced === 1n) return true;
  // Downstream SQL also uses ordinary string binding. If it changes these bytes (e.g. a leading
  // BOM), it could select a different entity than the exact fence lookup. Refuse authority, not the stored ID.
  if (row.sameIdentity !== 1 && row.sameIdentity !== 1n) throw new RunFenceError("Historical identity binding is ambiguous");
  return false;
}

export function assertNotRestoreFenced(db: Database, kind: RestoreEntityKind, id: string): void {
  if (isRestoreFenced(db,kind,id)) throw new RunFenceError("Restored identity is historical only");
}

export function isRunRestoreFenced(db: Database, runId: string): boolean { return isRestoreFenced(db,"run",runId); }
export function assertRunNotRestoreFenced(db: Database, runId: string): void {
  assertNotRestoreFenced(db,"run",runId);
}
