import type { Database } from "bun:sqlite";
import { compileQuery } from "./fuzzy-matcher";
import { readTitle, readTitleIdentity } from "./title-projection";

export const FUZZY_PROJECTION_FORMAT_VERSION = 1;
export const FUZZY_PROJECTION_CHUNK_SIZE = 16_384;
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

export type ProjectionTarget = Readonly<
  { kind: "source"; sourceId: string; titleRevisionId?: string } |
  { kind: "item"; sourceId: string; itemId: string; formulationId: string; titleRevisionId?: string }
>;
export type ProjectionFieldKind = "source-body" | "formulation-body" | "title";
export type ProjectionChunk = Readonly<{ ordinal: number; start: number; utf16Length: number; text: string }>;
export type ProjectionField = Readonly<{
  target: ProjectionTarget;
  kind: ProjectionFieldKind;
  originalLength: number;
  chunkCount: number;
  chunks: Iterable<ProjectionChunk>;
}>;

type FieldIdentity = Readonly<{ targetKind: "source" | "item"; targetId: string; fieldKind: ProjectionFieldKind }>;
type FieldRow = FieldIdentity & {
  sourceId: string; itemId: string | null; formulationId: string | null; titleRevisionId: string | null;
  originalLength: number; chunkCount: number;
};

class ProjectionIntegrityError extends Error {}

type CanonicalRow = {
  sourceId: string; itemId: string | null; formulationId: string | null;
  projectedId: string | null; projectedSourceId: string | null; projectedItemId: string | null;
  projectedFormulationId: string | null; projectedTitleRevisionId: string | null;
};

// LIMIT 1 selects an item's authoritative current formulation, never search
// candidates. Canonical enumeration itself has no candidate gate or text load.
const canonicalQueries = {
  source: `SELECT s.id AS sourceId,NULL AS itemId,NULL AS formulationId,
    t.target_id AS projectedId,t.source_id AS projectedSourceId,t.item_id AS projectedItemId,
    t.formulation_id AS projectedFormulationId,t.title_revision_id AS projectedTitleRevisionId
    FROM sources s LEFT JOIN fuzzy_targets t ON t.target_kind='source' AND t.target_id=s.id
    ORDER BY s.id COLLATE BINARY`,
  item: `SELECT i.source_id AS sourceId,i.id AS itemId,f.id AS formulationId,
    t.target_id AS projectedId,t.source_id AS projectedSourceId,t.item_id AS projectedItemId,
    t.formulation_id AS projectedFormulationId,t.title_revision_id AS projectedTitleRevisionId
    FROM knowledge_items i LEFT JOIN formulations f ON f.rowid=(
      SELECT current.rowid FROM formulations current WHERE current.item_id=i.id ORDER BY current.rowid DESC LIMIT 1)
    LEFT JOIN fuzzy_targets t ON t.target_kind='item' AND t.target_id=i.id
    ORDER BY i.id COLLATE BINARY`,
} as const;

// Preserve original text and offsets. Oversized single graphemes stay intact;
// the read-side resource policy, not a destructive split/truncation, handles them.
function* splitField(text: string): Generator<ProjectionChunk> {
  let start = 0, ordinal = 0;
  for (const part of segmenter.segment(text)) {
    if (part.index > start && part.index + part.segment.length - start > FUZZY_PROJECTION_CHUNK_SIZE) {
      const chunk = text.slice(start, part.index);
      yield { ordinal: ordinal++, start, utf16Length: chunk.length, text: chunk };
      start = part.index;
    }
  }
  if (start < text.length) {
    const chunk = text.slice(start);
    yield { ordinal, start, utf16Length: chunk.length, text: chunk };
  }
}

function writeField(db: Database, target: ProjectionTarget, kind: ProjectionFieldKind, text: string): void {
  const id = target.kind === "source" ? target.sourceId : target.itemId;
  db.run(`INSERT INTO fuzzy_fields(target_kind,target_id,field_kind,original_length,chunk_count)
    VALUES (?,?,?,?,0)`, [target.kind, id, kind, text.length]);
  const insert = db.query<never, [string, string, string, number, number, number, string]>(`
    INSERT INTO fuzzy_chunks(target_kind,target_id,field_kind,ordinal,start_offset,utf16_length,text)
    VALUES (?,?,?,?,?,?,?)`);
  let count = 0;
  for (const chunk of splitField(text)) {
    insert.run(target.kind, id, kind, chunk.ordinal, chunk.start, chunk.utf16Length, chunk.text);
    count++;
  }
  db.run("UPDATE fuzzy_fields SET chunk_count=? WHERE target_kind=? AND target_id=? AND field_kind=?",
    [count, target.kind, id, kind]);
}

function writeTarget(db: Database, target: ProjectionTarget, text: string, titleText?: string): void {
  const id = target.kind === "source" ? target.sourceId : target.itemId;
  db.run("DELETE FROM fuzzy_targets WHERE target_kind=? AND target_id=?", [target.kind, id]);
  db.run(`INSERT INTO fuzzy_targets(target_kind,target_id,source_id,item_id,formulation_id,title_revision_id)
    VALUES (?,?,?,?,?,?)`, [target.kind, id, target.sourceId, target.kind === "item" ? target.itemId : null,
    target.kind === "item" ? target.formulationId : null, target.titleRevisionId ?? null]);
  writeField(db, target, target.kind === "source" ? "source-body" : "formulation-body", text);
  if (titleText !== undefined) writeField(db, target, "title", titleText);
}

// The caller owns each canonical write transaction. This module never opens or
// migrates a database and does not change canonical records, jobs or receipts.
export function refreshSourceProjection(db: Database, sourceId: string): void {
  const source = db.query<{ text: string }, [string]>("SELECT text FROM sources WHERE id=?").get(sourceId);
  if (!source) throw new Error("Projection source is missing");
  const title = readTitle(db, sourceId).title;
  const target: ProjectionTarget = { kind: "source", sourceId, ...(title ? { titleRevisionId: title.revisionId } : {}) };
  writeTarget(db, target, source.text, title?.text);
}

export function refreshItemProjection(db: Database, itemId: string): void {
  const item = db.query<{ sourceId: string; formulationId: string; text: string }, [string]>(`
    SELECT i.source_id AS sourceId,f.id AS formulationId,f.text
    FROM knowledge_items i JOIN formulations f ON f.item_id=i.id
    WHERE i.id=? ORDER BY f.rowid DESC LIMIT 1`).get(itemId);
  if (!item) throw new Error("Projection current formulation is missing");
  const title = readTitle(db, item.sourceId, itemId, item.formulationId).title;
  const target: ProjectionTarget = { kind: "item", sourceId: item.sourceId, itemId, formulationId: item.formulationId,
    ...(title ? { titleRevisionId: title.revisionId } : {}) };
  writeTarget(db, target, item.text, title?.text);
}

// A label edit does not change the body. Resolve against the canonical CURRENT
// formulation, even when a user edited the entity-wide label from an older view.
export function refreshTitleProjection(db: Database, sourceId: string, itemId?: string): void {
  let target: ProjectionTarget;
  if (itemId === undefined) target = { kind: "source", sourceId };
  else {
    const current = db.query<{ sourceId: string; formulationId: string }, [string]>(`
      SELECT i.source_id AS sourceId,f.id AS formulationId FROM knowledge_items i
      JOIN formulations f ON f.item_id=i.id WHERE i.id=? ORDER BY f.rowid DESC LIMIT 1`).get(itemId);
    if (!current || current.sourceId !== sourceId) throw new Error("Projection title target is missing");
    target = { kind: "item", sourceId, itemId, formulationId: current.formulationId };
  }
  const id = target.kind === "source" ? target.sourceId : target.itemId;
  const formulationId = target.kind === "item" ? target.formulationId : undefined;
  const projected = db.query<{ sourceId: string; formulationId: string | null; titleRevisionId: string | null }, [string, string]>(`
    SELECT source_id AS sourceId,formulation_id AS formulationId,title_revision_id AS titleRevisionId
    FROM fuzzy_targets WHERE target_kind=? AND target_id=?`).get(target.kind, id);
  if (!projected || projected.sourceId !== sourceId || projected.formulationId !== (formulationId ?? null)) {
    throw new Error("Projection title target is stale or missing");
  }
  const title = readTitle(db, sourceId, itemId, formulationId).title;
  if (projected.titleRevisionId === (title?.revisionId ?? null)) return;
  db.run("DELETE FROM fuzzy_fields WHERE target_kind=? AND target_id=? AND field_kind='title'", [target.kind, id]);
  db.run("UPDATE fuzzy_targets SET title_revision_id=? WHERE target_kind=? AND target_id=?",
    [title?.revisionId ?? null, target.kind, id]);
  if (title) writeField(db, target, "title", title.text);
}

function writeAliasKeys(db: Database, aliasId: string, alias: { alias: string; expansion: string }): void {
  const insert = db.query<never, [string, string, string]>(
    "INSERT INTO fuzzy_alias_keys(alias_id,side,normalized_key) VALUES (?,?,?)");
  for (const side of ["alias", "expansion"] as const) {
    const compiled = compileQuery(alias[side]);
    if (compiled) insert.run(aliasId, side, JSON.stringify(compiled.keys));
  }
}

export function refreshAliasProjection(db: Database, aliasId: string): void {
  const alias = db.query<{ alias: string; expansion: string }, [string]>(
    "SELECT alias,expansion FROM search_aliases WHERE id=?").get(aliasId);
  if (!alias) throw new Error("Projection alias is missing");
  db.run("DELETE FROM fuzzy_alias_keys WHERE alias_id=?", [aliasId]);
  writeAliasKeys(db, aliasId, alias);
}

// Populate empty projection tables inside the migration/rebuild transaction.
// Canonical IDs are streamed; only the current field's full SQLite TEXT is read.
export function backfillFuzzyProjection(db: Database): void {
  for (const { id } of db.query<{ id: string }, []>("SELECT id FROM sources ORDER BY id").iterate()) {
    refreshSourceProjection(db, id);
  }
  for (const { id } of db.query<{ id: string }, []>("SELECT id FROM knowledge_items ORDER BY id").iterate()) {
    refreshItemProjection(db, id);
  }
  for (const row of db.query<{ id: string; alias: string; expansion: string }, []>(
    "SELECT id,alias,expansion FROM search_aliases ORDER BY id").iterate()) {
    writeAliasKeys(db, row.id, row);
  }
}

// Shared by retrieval and explicit integrity checking. Canonical rows drive LEFT
// JOINs so absent/stale heads fail closed instead of disappearing from the scan.
// The caller owns the connection and read snapshot, including iterator cleanup.
export function* iterateCanonicalProjectionTargets(db: Database): Generator<ProjectionTarget> {
  const state = db.query<{ version: number }, []>(
    "SELECT format_version AS version FROM fuzzy_projection_state WHERE singleton=1").get();
  if (state?.version !== FUZZY_PROJECTION_FORMAT_VERSION) throw new ProjectionIntegrityError("Unsupported search projection");
  for (const kind of ["source", "item"] as const) {
    const statement = db.prepare<CanonicalRow, []>(canonicalQueries[kind]);
    try {
      for (const row of statement.iterate()) {
        if (row.projectedId !== (kind === "source" ? row.sourceId : row.itemId) ||
            row.projectedSourceId !== row.sourceId || row.projectedItemId !== row.itemId ||
            row.projectedFormulationId !== row.formulationId ||
            (kind === "item" && (row.itemId === null || row.formulationId === null))) {
          throw new ProjectionIntegrityError("Missing or stale search target");
        }
        const title = readTitleIdentity(db, row.sourceId, row.itemId ?? undefined, row.formulationId ?? undefined).title;
        if ((title?.revisionId ?? null) !== row.projectedTitleRevisionId) throw new ProjectionIntegrityError("Stale effective search title");
        const label = title ? { titleRevisionId: title.revisionId } : {};
        if (kind === "source") yield { kind, sourceId: row.sourceId, ...label };
        else if (row.itemId !== null && row.formulationId !== null) {
          yield { kind, sourceId: row.sourceId, itemId: row.itemId, formulationId: row.formulationId, ...label };
        }
      }
    } finally { statement.finalize(); }
  }
}

function rejectOrphanProjectionRows(db: Database): void {
  // These existence probes find extras even if a damaged database was written
  // with foreign keys/check constraints disabled. No corpus rows are collected.
  const probes = [
    "SELECT 1 FROM fuzzy_projection_state WHERE singleton<>1",
    `SELECT 1 FROM fuzzy_targets t
      LEFT JOIN sources s ON t.target_kind='source' AND s.id=t.target_id
      LEFT JOIN knowledge_items i ON t.target_kind='item' AND i.id=t.target_id
      WHERE (t.target_kind='source' AND s.id IS NULL) OR (t.target_kind='item' AND i.id IS NULL)
        OR t.target_kind NOT IN ('source','item')`,
    `SELECT 1 FROM fuzzy_fields f LEFT JOIN fuzzy_targets t
      ON t.target_kind=f.target_kind AND t.target_id=f.target_id WHERE t.target_id IS NULL`,
    `SELECT 1 FROM fuzzy_chunks c LEFT JOIN fuzzy_fields f
      ON f.target_kind=c.target_kind AND f.target_id=c.target_id AND f.field_kind=c.field_kind WHERE f.target_id IS NULL`,
    `SELECT 1 FROM fuzzy_alias_keys k LEFT JOIN search_aliases a ON a.id=k.alias_id
      WHERE a.id IS NULL OR k.side NOT IN ('alias','expansion')`,
  ];
  for (const sql of probes) {
    const statement = db.prepare<{ "1": number }, []>(sql);
    try { if (statement.get()) throw new ProjectionIntegrityError("Orphan projection record"); }
    finally { statement.finalize(); }
  }
}

function verifyCanonicalField(db: Database, field: ProjectionField): void {
  const target = field.target;
  let owner: string, table: "sources" | "formulations" | "title_revisions";
  if (field.kind === "title") {
    if (target.titleRevisionId === undefined) throw new ProjectionIntegrityError("Missing canonical title owner");
    owner = target.titleRevisionId; table = "title_revisions";
  } else if (target.kind === "source") { owner = target.sourceId; table = "sources"; }
  else { owner = target.formulationId; table = "formulations"; }
  // SQLite supplies one canonical full TEXT field at a time, as for backfill.
  // Compare its expected grapheme-safe chunk stream, not concatenated projected
  // bodies or a corpus-sized array. Largest-legacy-field cost remains measurable.
  const canonical = db.query<{ text: string }, [string]>(`SELECT text FROM ${table} WHERE id=?`).get(owner);
  if (!canonical || canonical.text.length !== field.originalLength) throw new ProjectionIntegrityError("Canonical field length mismatch");
  const actual = field.chunks[Symbol.iterator]();
  try {
    for (const expected of splitField(canonical.text)) {
      const next = actual.next();
      if (next.done || next.value.ordinal !== expected.ordinal || next.value.start !== expected.start ||
          next.value.utf16Length !== expected.utf16Length || next.value.text !== expected.text) {
        throw new ProjectionIntegrityError("Canonical field text or coverage mismatch");
      }
    }
    if (!actual.next().done) throw new ProjectionIntegrityError("Extra projection chunk");
  } finally { actual.return?.(); }
}

function verifyAliasKeys(db: Database): void {
  const aliases = db.prepare<{ id: string; alias: string; expansion: string }, []>("SELECT id,alias,expansion FROM search_aliases ORDER BY id");
  const keys = db.prepare<{ key: string }, [string, string]>(
    "SELECT normalized_key AS key FROM fuzzy_alias_keys WHERE alias_id=? AND side=?");
  try {
    for (const alias of aliases.iterate()) {
      for (const side of ["alias", "expansion"] as const) {
        const compiled = compileQuery(alias[side]);
        const expected = compiled ? JSON.stringify(compiled.keys) : null;
        if ((keys.get(alias.id, side)?.key ?? null) !== expected) throw new ProjectionIntegrityError("Canonical alias key mismatch");
      }
    }
  } finally { aliases.finalize(); keys.finalize(); }
}

function inspectProjection(db: Database): { valid: boolean; checkedTargets: number } {
  let checkedTargets = 0;
  try {
    rejectOrphanProjectionRows(db);
    for (const target of iterateCanonicalProjectionTargets(db)) {
      for (const field of iterateTargetProjectionFields(db, target)) verifyCanonicalField(db, field);
      checkedTargets++;
    }
    verifyAliasKeys(db);
    return { valid: true, checkedTargets };
  } catch (error) {
    if (error instanceof ProjectionIntegrityError) return { valid: false, checkedTargets };
    throw error; // I/O/SQL failures are not a successful integrity inspection.
  }
}

// Read-only even under PRAGMA query_only. Enlist in a caller's existing snapshot
// without committing/rolling it back; otherwise own an explicit read transaction.
// Fail fast with bounded, content-free diagnostics. checkedTargets counts fully
// compared targets before the first mismatch, not an estimated corpus size.
export function verifyFuzzyProjectionIntegrity(db: Database): { valid: boolean; checkedTargets: number } {
  const ownsTransaction = !db.inTransaction;
  console.info("fuzzy.projection.verify attempt", { formatVersion: FUZZY_PROJECTION_FORMAT_VERSION });
  try {
    if (ownsTransaction) db.exec("BEGIN");
    const report = inspectProjection(db);
    if (ownsTransaction) db.exec("COMMIT");
    console.info("fuzzy.projection.verify succeeded", report);
    return report;
  } catch (error) {
    if (ownsTransaction && db.inTransaction) db.exec("ROLLBACK");
    console.warn("fuzzy.projection.verify failed", { category: "read-failed" });
    throw error;
  }
}

// Rebuild is an explicit maintenance boundary, not a canonical-writer helper.
// Reject nesting rather than accidentally publish/rollback a caller's work.
// All deletes affect disposable projection tables only. Atomic publication and
// rollback retain the complete OLD projection if any backfill insert fails.
export function rebuildFuzzyProjection(db: Database): void {
  console.info("fuzzy.projection.rebuild attempt", { formatVersion: FUZZY_PROJECTION_FORMAT_VERSION });
  try {
    if (db.inTransaction) throw new Error("Projection rebuild requires no active transaction");
    db.transaction(() => {
      db.exec(`DELETE FROM fuzzy_projection_state; DELETE FROM fuzzy_alias_keys;
        DELETE FROM fuzzy_chunks; DELETE FROM fuzzy_fields; DELETE FROM fuzzy_targets;`);
      backfillFuzzyProjection(db);
      db.run("INSERT INTO fuzzy_projection_state(singleton,format_version) VALUES (1,?)", [FUZZY_PROJECTION_FORMAT_VERSION]);
    }).immediate();
    console.info("fuzzy.projection.rebuild succeeded", { formatVersion: FUZZY_PROJECTION_FORMAT_VERSION });
  } catch (error) {
    console.warn("fuzzy.projection.rebuild failed", { category: "rebuild-failed" });
    throw error;
  }
}

function targetFromRow(row: FieldRow): ProjectionTarget {
  const title = row.titleRevisionId === null ? {} : { titleRevisionId: row.titleRevisionId };
  if (row.targetKind === "source") return { kind: "source", sourceId: row.sourceId, ...title };
  if (row.itemId === null || row.formulationId === null) throw new ProjectionIntegrityError("Invalid projection item identity");
  return { kind: "item", sourceId: row.sourceId, itemId: row.itemId, formulationId: row.formulationId, ...title };
}

type ChunkManifest = Omit<ProjectionChunk, "text">;
type ChunkPreflight = (utf16Length: number) => void;

function validateFieldManifest(field: Pick<FieldRow, "originalLength" | "chunkCount">): void {
  if (!Number.isSafeInteger(field.originalLength) || field.originalLength < 0 ||
      !Number.isSafeInteger(field.chunkCount) || field.chunkCount < 0 ||
      (field.originalLength === 0) !== (field.chunkCount === 0)) throw new ProjectionIntegrityError("Invalid projection field manifest");
}

function* iterateFieldChunks(db: Database, field: FieldRow, preflight?: ChunkPreflight): Generator<ProjectionChunk> {
  // Each iterable gets its own cursor; nested field/chunk iterators must not
  // reset another caller's cached Statement. Closing/breaking finalizes it.
  const statement = db.prepare<ChunkManifest, [string, string, string]>(`
    SELECT ordinal,start_offset AS start,utf16_length AS utf16Length FROM fuzzy_chunks
    WHERE target_kind=? AND target_id=? AND field_kind=? ORDER BY ordinal`);
  const text = db.prepare<{ text: string }, [string, string, string, number]>(`
    SELECT text FROM fuzzy_chunks WHERE target_kind=? AND target_id=? AND field_kind=? AND ordinal=?`);
  try {
    let count = 0, offset = 0;
    for (const chunk of statement.iterate(field.targetKind, field.targetId, field.fieldKind)) {
      if (chunk.ordinal !== count || chunk.start !== offset || !Number.isSafeInteger(chunk.utf16Length) || chunk.utf16Length < 1 ||
          !Number.isSafeInteger(offset + chunk.utf16Length) || offset + chunk.utf16Length > field.originalLength) {
        throw new ProjectionIntegrityError("Invalid projection chunk manifest");
      }
      // Check resource admission BEFORE SQLite materializes this chunk's TEXT.
      preflight?.(chunk.utf16Length);
      const row = text.get(field.targetKind, field.targetId, field.fieldKind, chunk.ordinal);
      if (!row || row.text.length !== chunk.utf16Length) throw new ProjectionIntegrityError("Invalid projection chunk text");
      count++;
      offset += chunk.utf16Length;
      yield { ...chunk, text: row.text };
    }
    if (count !== field.chunkCount || offset !== field.originalLength) throw new ProjectionIntegrityError("Incomplete projection field");
  } finally { statement.finalize(); text.finalize(); }
}

// The search reader supplies a canonical, already checked target from its LEFT
// JOIN enumeration. Re-iteration opens fresh cursors in that same read snapshot.
export function* iterateTargetProjectionFields(
  db: Database, target: ProjectionTarget, preflight?: ChunkPreflight,
): Generator<ProjectionField> {
  const id = target.kind === "source" ? target.sourceId : target.itemId;
  const statement = db.prepare<Pick<FieldRow, "fieldKind" | "originalLength" | "chunkCount">, [string, string]>(`
    SELECT field_kind AS fieldKind,original_length AS originalLength,chunk_count AS chunkCount
    FROM fuzzy_fields WHERE target_kind=? AND target_id=? ORDER BY field_kind`);
  let body = false, title = false;
  try {
    for (const metadata of statement.iterate(target.kind, id)) {
      validateFieldManifest(metadata);
      if (metadata.fieldKind === "title") {
        if (title || target.titleRevisionId === undefined) throw new ProjectionIntegrityError("Unexpected projection title");
        title = true;
      } else {
        const expected = target.kind === "source" ? "source-body" : "formulation-body";
        if (body || metadata.fieldKind !== expected) throw new ProjectionIntegrityError("Unexpected projection body");
        body = true;
      }
      const row: FieldRow = { ...metadata, targetKind: target.kind, targetId: id, sourceId: target.sourceId,
        itemId: target.kind === "item" ? target.itemId : null,
        formulationId: target.kind === "item" ? target.formulationId : null, titleRevisionId: target.titleRevisionId ?? null };
      yield { target, kind: row.fieldKind, originalLength: row.originalLength, chunkCount: row.chunkCount,
        chunks: { [Symbol.iterator]: () => iterateFieldChunks(db, row, preflight) } };
    }
    if (!body || title !== (target.titleRevisionId !== undefined)) throw new ProjectionIntegrityError("Incomplete target projection");
  } finally { statement.finalize(); }
}

// Structural projection stream, not the canonical-completeness search reader.
// Caller owns the connection/snapshot. Checks complete when iterables are drained.
export function* iterateProjectionFields(db: Database): Generator<ProjectionField> {
  const state = db.query<{ version: number }, []>(
    "SELECT format_version AS version FROM fuzzy_projection_state WHERE singleton=1").get();
  if (state?.version !== FUZZY_PROJECTION_FORMAT_VERSION) throw new ProjectionIntegrityError("Unsupported projection format");
  const statement = db.prepare<FieldRow, []>(`SELECT f.target_kind AS targetKind,f.target_id AS targetId,f.field_kind AS fieldKind,
    t.source_id AS sourceId,t.item_id AS itemId,t.formulation_id AS formulationId,t.title_revision_id AS titleRevisionId,
    f.original_length AS originalLength,f.chunk_count AS chunkCount
    FROM fuzzy_fields f JOIN fuzzy_targets t ON t.target_kind=f.target_kind AND t.target_id=f.target_id
    ORDER BY f.target_kind,f.target_id,f.field_kind`);
  try {
    for (const row of statement.iterate()) {
      validateFieldManifest(row);
      if (row.fieldKind === "title" && row.titleRevisionId === null) throw new ProjectionIntegrityError("Projection title identity is missing");
      yield { target: targetFromRow(row), kind: row.fieldKind, originalLength: row.originalLength, chunkCount: row.chunkCount,
        chunks: { [Symbol.iterator]: () => iterateFieldChunks(db, row) } };
    }
  } finally { statement.finalize(); }
}
