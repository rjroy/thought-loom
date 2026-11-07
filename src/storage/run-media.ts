import type { Database } from "bun:sqlite";
import { RunConflictError, RunForbiddenError } from "../domain/run";
import { protocolJson, uniqueKeys, type OriginalMediaPart, type OriginalMediaManifest } from "../domain/run-protocol";
import { record } from "../domain/validation";

export type { OriginalMediaPart, OriginalMediaManifest } from "../domain/run-protocol";

interface SourceFingerprint {
  readonly sourceId: string;
  readonly thoughtId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
}
interface OriginalPartRow extends SourceFingerprint {
  readonly position: number;
  readonly representation: string;
  readonly preparedKey: string | null;
  readonly recipe: string | null;
  readonly observed: number;
}

function originalFingerprint(source: SourceFingerprint, position: number): OriginalMediaPart {
  return Object.freeze({position,sourceId:source.sourceId,representation:"original",mimeType:source.mimeType,
    byteLength:source.byteLength,sha256:source.sha256,preparedKey:null,recipe:null});
}

/** Whole-field comparison rejects extra authority/observation fields as well as changed fingerprints and order. */
export function confirmOriginalMediaManifest(input: unknown, expected: OriginalMediaManifest): void {
  try {
    if (protocolJson(input) === protocolJson(expected)) return;
  } catch { /* A non-JSON value cannot describe prepared original parts. */ }
  throw new RunConflictError("Media manifest differs from its immutable original fingerprints");
}

/** Short SQL phase only. Copy authoritative source fingerprints, never caller byte data or a hash-only source alias. */
export function insertOriginalMediaParts(db: Database, promptId: string, input: OriginalMediaManifest): void {
  if (!db.inTransaction) throw new RunConflictError("Media parts require their successor transaction");
  let data: Record<string,unknown>;
  try { data = record(JSON.parse(protocolJson(input))); }
  catch { throw new RunConflictError("Invalid prepared media manifest"); }
  if (!Array.isArray(data.parts) || data.parts.length === 0) throw new RunConflictError("Prepared original parts required");
  const parts = data.parts.map((value: unknown,index): OriginalMediaPart => {
    const part = record(value);
    if (typeof part.sourceId !== "string" || part.sourceId.length === 0) throw new RunConflictError("Original source identity required");
    const source = db.query<SourceFingerprint, [string]>(`SELECT id AS sourceId,source_thought_id AS thoughtId,
      mime_type AS mimeType,byte_length AS byteLength,lower(hex(sha256)) AS sha256 FROM media_sources WHERE id=?`).get(part.sourceId);
    if (!source) throw new RunConflictError("Prepared original source unavailable");
    return originalFingerprint(source,index);
  });
  confirmOriginalMediaManifest(data,{version:1,parts});
  for (const part of parts) db.run(`INSERT INTO run_media_parts(prompt_id,position,source_id,representation,mime_type,byte_length,sha256)
    SELECT ?,?,id,'original',mime_type,byte_length,sha256 FROM media_sources WHERE id=?`,[promptId,part.position,part.sourceId]);
}

/** One canonical projection for preparation, submission comparison and retained audit. Never reads file bytes. */
export function readOriginalMediaParts(db: Database, promptId: string): {
  readonly manifest: OriginalMediaManifest; readonly thoughtIds: readonly string[];
} {
  const rows = db.query<OriginalPartRow, [string]>(`SELECT part.position,part.source_id AS sourceId,
    source.source_thought_id AS thoughtId,part.representation,part.mime_type AS mimeType,part.byte_length AS byteLength,
    lower(hex(part.sha256)) AS sha256,part.prepared_key AS preparedKey,part.recipe_json AS recipe,part.observed
    FROM run_media_parts part JOIN media_sources source ON source.id=part.source_id
    WHERE part.prompt_id=? ORDER BY part.position`).all(promptId);
  const parts = rows.map((row,index): OriginalMediaPart => {
    if (row.position !== index || row.representation !== "original" || row.preparedKey !== null || row.recipe !== null || row.observed !== 0) {
      throw new RunConflictError("Original unobserved media parts required");
    }
    return originalFingerprint(row,row.position);
  });
  return {manifest:Object.freeze({version:1,parts:Object.freeze(parts)}),thoughtIds:[...new Set(rows.map(row => row.thoughtId))]};
}

/** Input claims no authority: compare its entire reserved field against the ordered immutable SQL fingerprints. */
export function mediaInputSources(db: Database, promptId: string, input: string): readonly string[] {
  const {manifest,thoughtIds} = readOriginalMediaParts(db,promptId);
  let value: unknown;
  try { value = JSON.parse(input); }
  catch {
    if (manifest.parts.length !== 0) throw new RunConflictError("Exact media input manifest required");
    return []; // Existing text-only protocol callers need not supply JSON prompts.
  }
  const hasManifest = typeof value === "object" && value !== null && Object.hasOwn(value,"media");
  if (manifest.parts.length === 0) {
    if (hasManifest) throw new RunConflictError("Media input has no persisted parts");
    return [];
  }
  try {
    uniqueKeys(input);
    const data = record(value);
    confirmOriginalMediaManifest(data.media,manifest);
  } catch {
    throw new RunConflictError("Input differs from its persisted media manifest");
  }
  return thoughtIds;
}

/** The current native protocol is text-only. Neither binding nor a sealed fingerprint licenses binary execution. */
export function requireMediaDelivery(db: Database, runId: string): void {
  if (db.query(`SELECT 1 FROM run_media_parts part JOIN run_steps step ON step.prompt_id=part.prompt_id
    WHERE step.run_id=? LIMIT 1`).get(runId)) {
    throw new RunForbiddenError("Media execution requires verified native delivery authority");
  }
}
