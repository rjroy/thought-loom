import type { Database } from "bun:sqlite";
import { backfillFuzzyProjection, FUZZY_PROJECTION_FORMAT_VERSION } from "./fuzzy-projection";

// Called inside storage's migration transaction. Publish only after backfill.
export function migrateFuzzyProjection(db: Database): void {
  db.run(`CREATE TABLE fuzzy_projection_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), format_version INTEGER NOT NULL CHECK(format_version>0))`);
  db.run(`CREATE TABLE fuzzy_targets (
    target_kind TEXT NOT NULL CHECK(target_kind IN ('source','item')), target_id TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources(id), item_id TEXT REFERENCES knowledge_items(id),
    formulation_id TEXT REFERENCES formulations(id), title_revision_id TEXT REFERENCES title_revisions(id),
    PRIMARY KEY(target_kind,target_id),
    CHECK((target_kind='source' AND target_id=source_id AND item_id IS NULL AND formulation_id IS NULL) OR
      (target_kind='item' AND target_id=item_id AND item_id IS NOT NULL AND formulation_id IS NOT NULL))
  ) WITHOUT ROWID`);
  db.run(`CREATE TABLE fuzzy_fields (
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
    field_kind TEXT NOT NULL CHECK(field_kind IN ('source-body','formulation-body','title')),
    original_length INTEGER NOT NULL CHECK(original_length>=0), chunk_count INTEGER NOT NULL CHECK(chunk_count>=0),
    PRIMARY KEY(target_kind,target_id,field_kind),
    FOREIGN KEY(target_kind,target_id) REFERENCES fuzzy_targets(target_kind,target_id) ON DELETE CASCADE,
    CHECK(field_kind='title' OR (target_kind='source' AND field_kind='source-body') OR
      (target_kind='item' AND field_kind='formulation-body'))
  ) WITHOUT ROWID`);
  db.run(`CREATE TABLE fuzzy_chunks (
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL, field_kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0), start_offset INTEGER NOT NULL CHECK(start_offset>=0),
    utf16_length INTEGER NOT NULL CHECK(utf16_length>0), text TEXT NOT NULL,
    PRIMARY KEY(target_kind,target_id,field_kind,ordinal),
    FOREIGN KEY(target_kind,target_id,field_kind)
      REFERENCES fuzzy_fields(target_kind,target_id,field_kind) ON DELETE CASCADE
  ) WITHOUT ROWID`);
  db.run(`CREATE TABLE fuzzy_alias_keys (
    alias_id TEXT NOT NULL REFERENCES search_aliases(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK(side IN ('alias','expansion')), normalized_key TEXT NOT NULL,
    PRIMARY KEY(alias_id,side)
  ) WITHOUT ROWID`);
  db.run("CREATE INDEX fuzzy_alias_lookup ON fuzzy_alias_keys(normalized_key,alias_id,side)");
  backfillFuzzyProjection(db);
  db.run("INSERT INTO fuzzy_projection_state(singleton,format_version) VALUES (1,?)", [FUZZY_PROJECTION_FORMAT_VERSION]);
}

// Schema 21 runs AFTER the historical migrations/backfill, in the same owning
// transaction. Only disposable lexical-search objects are retired. Dropping an
// FTS5 virtual table also removes its own shadow tables/indexes; never glob-drop
// schema objects or canonical history/authority triggers. Historical versions
// maintained FTS explicitly in writers, not with canonical-table FTS triggers.
export function retireLexicalSearch(db: Database): void {
  for (const name of ["source_vocabulary", "formulation_vocabulary", "title_vocabulary", "item_vocabulary",
    "source_search", "formulation_search", "item_search", "title_search"]) {
    db.run(`DROP TABLE IF EXISTS "${name}"`);
  }
  // The old lowercase exact-alias path is replaced by fuzzy_alias_lookup's
  // whole normalized keys. Keep search_aliases/alias_evidence and their data.
  for (const name of ["alias_lookup", "expansion_lookup"]) db.run(`DROP INDEX IF EXISTS "${name}"`);
}
