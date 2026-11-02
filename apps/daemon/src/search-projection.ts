import type { Database } from "bun:sqlite";
import { searchTerms } from "@thoughtloom/contracts";
import { readTitle } from "./title-projection";

type Target = { kind: "source"; id: string; sourceId: string } |
  { kind: "item"; id: string; sourceId: string; formulationId: string };

function createFts(db: Database): void {
  db.exec(`CREATE VIRTUAL TABLE search_fts USING fts5(text, content='search_fields', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');
    CREATE VIRTUAL TABLE search_vocabulary USING fts5vocab(search_fts,'row');
    CREATE TRIGGER search_fields_insert AFTER INSERT ON search_fields BEGIN
      INSERT INTO search_fts(rowid,text) VALUES (new.id,new.text); END;
    CREATE TRIGGER search_fields_delete AFTER DELETE ON search_fields BEGIN
      INSERT INTO search_fts(search_fts,rowid,text) VALUES ('delete',old.id,old.text); END;
    CREATE TRIGGER search_fields_update AFTER UPDATE OF text ON search_fields BEGIN
      INSERT INTO search_fts(search_fts,rowid,text) VALUES ('delete',old.id,old.text);
      INSERT INTO search_fts(rowid,text) VALUES (new.id,new.text); END;`);
}

function writeField(db: Database, target: Target, field: "source-body" | "formulation-body" | "title", text: string, titleId?: string): void {
  db.run(`INSERT INTO search_fields(target_kind,target_id,source_id,item_id,formulation_id,title_revision_id,field_kind,text)
    VALUES (?,?,?,?,?,?,?,?)`, [target.kind, target.id, target.sourceId, target.kind === "item" ? target.id : null,
    target.kind === "item" ? target.formulationId : null, titleId ?? null, field, text]);
}
function refreshTarget(db: Database, target: Target, body: string): void {
  const title = readTitle(db, target.sourceId, target.kind === "item" ? target.id : undefined,
    target.kind === "item" ? target.formulationId : undefined).title;
  db.run("DELETE FROM search_fields WHERE target_kind=? AND target_id=?", [target.kind, target.id]);
  writeField(db, target, target.kind === "source" ? "source-body" : "formulation-body", body, title?.revisionId);
  if (title) writeField(db, target, "title", title.text, title.revisionId);
}

// All refresh functions enlist in the EXISTING canonical write transaction.
// Source/history/receipts/jobs are never changed by projection maintenance.
export function refreshSourceSearch(db: Database, sourceId: string): void {
  const row = db.query<{ text: string }, [string]>("SELECT text FROM sources WHERE id=?").get(sourceId);
  if (!row) throw new Error("Search source missing");
  refreshTarget(db, { kind: "source", id: sourceId, sourceId }, row.text);
}
export function refreshItemSearch(db: Database, itemId: string): void {
  const row = db.query<{ sourceId: string; formulationId: string; text: string }, [string]>(`
    SELECT i.source_id AS sourceId,f.id AS formulationId,f.text FROM knowledge_items i JOIN formulations f ON f.item_id=i.id
    WHERE i.id=? ORDER BY f.rowid DESC LIMIT 1`).get(itemId);
  if (!row) throw new Error("Search current item missing");
  refreshTarget(db, { kind: "item", id: itemId, sourceId: row.sourceId, formulationId: row.formulationId }, row.text);
}
export function refreshTitleSearch(db: Database, sourceId: string, itemId?: string): void {
  let target: Target = { kind: "source", id: sourceId, sourceId };
  if (itemId !== undefined) {
    const row = db.query<{ sourceId: string; formulationId: string }, [string]>(`
      SELECT i.source_id AS sourceId,f.id AS formulationId FROM knowledge_items i JOIN formulations f ON f.item_id=i.id
      WHERE i.id=? ORDER BY f.rowid DESC LIMIT 1`).get(itemId);
    if (!row || row.sourceId !== sourceId) throw new Error("Search title owner missing");
    target = { kind: "item", id: itemId, sourceId, formulationId: row.formulationId };
  }
  const title = readTitle(db, sourceId, itemId, target.kind === "item" ? target.formulationId : undefined).title;
  const body = db.query<{ formulationId: string | null }, [string, string]>(`
    SELECT formulation_id AS formulationId FROM search_fields WHERE target_kind=? AND target_id=? AND field_kind<>'title'`).get(target.kind, target.id);
  if (!body || body.formulationId !== (target.kind === "item" ? target.formulationId : null)) throw new Error("Search title projection stale");
  db.run("DELETE FROM search_fields WHERE target_kind=? AND target_id=? AND field_kind='title'", [target.kind, target.id]);
  db.run("UPDATE search_fields SET title_revision_id=? WHERE target_kind=? AND target_id=?", [title?.revisionId ?? null, target.kind, target.id]);
  if (title) writeField(db, target, "title", title.text, title.revisionId);
}
export function refreshAliasSearch(db: Database, aliasId: string): void {
  const row = db.query<{ alias: string; expansion: string }, [string]>("SELECT alias,expansion FROM search_aliases WHERE id=?").get(aliasId);
  if (!row) throw new Error("Search alias missing");
  db.run("DELETE FROM search_alias_keys WHERE alias_id=?", [aliasId]);
  for (const side of ["alias", "expansion"] as const) {
    const terms = searchTerms(row[side]);
    if (terms.length) db.run("INSERT INTO search_alias_keys(alias_id,side,lookup_key) VALUES (?,?,?)", [aliasId, side, JSON.stringify(terms)]);
  }
}
function backfill(db: Database): void {
  for (const row of db.query<{ id: string }, []>("SELECT id FROM sources ORDER BY id").iterate()) refreshSourceSearch(db, row.id);
  for (const row of db.query<{ id: string }, []>("SELECT id FROM knowledge_items ORDER BY id").iterate()) refreshItemSearch(db, row.id);
  for (const row of db.query<{ id: string }, []>("SELECT id FROM search_aliases ORDER BY id").iterate()) refreshAliasSearch(db, row.id);
}

// Schema 22 is published by storage's owning migration transaction only AFTER
// canonical backfill. Older experimental schemas added derived data only; no
// canonical migration depends on their matcher, chunk format or backfill code.
export function migrateIndexedSearch(db: Database): void {
  db.exec(`CREATE TABLE search_fields (
    id INTEGER PRIMARY KEY, target_kind TEXT NOT NULL CHECK(target_kind IN ('source','item')), target_id TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources(id), item_id TEXT REFERENCES knowledge_items(id),
    formulation_id TEXT REFERENCES formulations(id), title_revision_id TEXT REFERENCES title_revisions(id),
    field_kind TEXT NOT NULL CHECK(field_kind IN ('source-body','formulation-body','title')), text TEXT NOT NULL,
    UNIQUE(target_kind,target_id,field_kind),
    CHECK((target_kind='source' AND target_id=source_id AND item_id IS NULL AND formulation_id IS NULL) OR
      (target_kind='item' AND target_id=item_id AND item_id IS NOT NULL AND formulation_id IS NOT NULL)));
    CREATE TABLE search_alias_keys(alias_id TEXT NOT NULL REFERENCES search_aliases(id), side TEXT NOT NULL CHECK(side IN ('alias','expansion')),
      lookup_key TEXT NOT NULL, PRIMARY KEY(alias_id,side)) WITHOUT ROWID;
    CREATE INDEX search_alias_lookup ON search_alias_keys(lookup_key,alias_id,side);`);
  createFts(db);
  backfill(db);
  // Only abandoned derived objects. No canonical table, trigger, receipt,
  // relationship, user override or alias record is deleted or rewritten.
  for (const name of ["fuzzy_chunks", "fuzzy_fields", "fuzzy_targets", "fuzzy_alias_keys", "fuzzy_projection_state",
    "source_vocabulary", "formulation_vocabulary", "item_vocabulary", "title_vocabulary",
    "source_search", "formulation_search", "item_search", "title_search"]) db.run(`DROP TABLE IF EXISTS "${name}"`);
  for (const name of ["alias_lookup", "expansion_lookup"]) db.run(`DROP INDEX IF EXISTS "${name}"`);
}

export function rebuildSearchProjection(db: Database): void {
  console.info("search.projection.rebuild attempt");
  try {
    if (db.inTransaction) throw new Error("Search rebuild requires no active transaction");
    db.transaction(() => {
      // Recreate even a damaged external-content index, rather than relying on
      // its delete postings being healthy enough to remove old field rows.
      db.exec(`DROP TRIGGER search_fields_insert; DROP TRIGGER search_fields_delete; DROP TRIGGER search_fields_update;
        DROP TABLE search_vocabulary; DROP TABLE search_fts; DELETE FROM search_fields; DELETE FROM search_alias_keys;`);
      createFts(db);
      backfill(db);
    }).immediate();
    console.info("search.projection.rebuild succeeded");
  } catch (error) { console.warn("search.projection.rebuild failed", { category: "storage_error" }); throw error; }
}
