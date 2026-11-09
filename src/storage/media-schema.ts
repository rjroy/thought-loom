import type { Database } from "bun:sqlite";
import { rebuildThoughtSearch } from "./search-projections";

/** Metadata only. Store identity is explicitly initialized by its daemon owner, never by migration. */
export function createMediaTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_store (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      store_id TEXT UNIQUE NOT NULL CHECK(length(trim(store_id))>0)
    );
    CREATE TABLE IF NOT EXISTS media_sources (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
      source_thought_id TEXT UNIQUE NOT NULL REFERENCES thoughts(id) DEFERRABLE INITIALLY DEFERRED,
      request_key TEXT UNIQUE NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128 AND request_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      display_name TEXT NOT NULL CHECK(length(display_name)>0),
      mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/gif','image/webp','application/pdf')),
      byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length>0 AND byte_length<=9007199254740991),
      sha256 BLOB NOT NULL CHECK(typeof(sha256)='blob' AND length(sha256)=32),
      clarification TEXT CHECK(clarification IS NULL OR length(trim(clarification,
        char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0),
      created_at TEXT NOT NULL CHECK(length(created_at)>0),
      FOREIGN KEY(source_thought_id) REFERENCES thought_titles(thought_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(source_thought_id) REFERENCES thought_source_seals(thought_id) DEFERRABLE INITIALLY DEFERRED
    );
  `);
}

export function createMediaGuards(db: Database): void {
  for (const table of ["media_store", "media_sources"]) db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'media metadata immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'media metadata immutable'); END;`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS media_store_no_replace BEFORE INSERT ON media_store
    WHEN EXISTS(SELECT 1 FROM media_store)
    BEGIN SELECT RAISE(ABORT,'media store identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS media_sources_no_replace BEFORE INSERT ON media_sources
    WHEN EXISTS(SELECT 1 FROM media_sources WHERE id=NEW.id OR source_thought_id=NEW.source_thought_id OR request_key=NEW.request_key)
    BEGIN SELECT RAISE(ABORT,'media source identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS media_sources_not_late BEFORE INSERT ON media_sources
    WHEN EXISTS(SELECT 1 FROM thoughts WHERE id=NEW.source_thought_id)
    BEGIN SELECT RAISE(ABORT,'media cannot attach to an existing thought'); END;
    CREATE TRIGGER IF NOT EXISTS media_sources_store_required BEFORE INSERT ON media_sources
    WHEN NOT EXISTS(SELECT 1 FROM media_store WHERE singleton=1)
    BEGIN SELECT RAISE(ABORT,'media store identity is not initialized'); END;
    CREATE TRIGGER IF NOT EXISTS media_thought_association BEFORE INSERT ON thoughts
    WHEN (NEW.kind='media-original') != EXISTS(SELECT 1 FROM media_sources WHERE source_thought_id=NEW.id)
      OR (NEW.kind='media-original' AND NOT EXISTS(SELECT 1 FROM media_sources WHERE source_thought_id=NEW.id AND created_at=NEW.created_at))
    BEGIN SELECT RAISE(ABORT,'media root requires its source-first association'); END;
    CREATE TRIGGER IF NOT EXISTS media_no_supporting_sources BEFORE INSERT ON thought_sources
    WHEN EXISTS(SELECT 1 FROM thoughts WHERE id=NEW.thought_id AND kind='media-original')
    BEGIN SELECT RAISE(ABORT,'media root cannot have supporting sources'); END;
  `);
}

/** Existing title mutations still own indexing. A filename fallback is not indexed title metadata. */
export function indexMediaClarification(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS thought_search_title_insert;
    DROP TRIGGER IF EXISTS thought_search_title_update;
    CREATE TRIGGER thought_search_title_insert AFTER INSERT ON thought_titles BEGIN
      INSERT INTO thought_search_fts(thought_id,text,title)
        SELECT t.id,CASE WHEN t.kind='media-original' THEN coalesce(s.clarification,'') ELSE t.text END,NEW.title
        FROM thoughts t LEFT JOIN media_sources s ON s.source_thought_id=t.id WHERE t.id=NEW.thought_id;
    END;
    CREATE TRIGGER thought_search_title_update AFTER UPDATE ON thought_titles BEGIN
      DELETE FROM thought_search_fts WHERE thought_id=OLD.thought_id;
      INSERT INTO thought_search_fts(thought_id,text,title)
        SELECT t.id,CASE WHEN t.kind='media-original' THEN coalesce(s.clarification,'') ELSE t.text END,NEW.title
        FROM thoughts t LEFT JOIN media_sources s ON s.source_thought_id=t.id WHERE t.id=NEW.thought_id;
    END;
  `);
  rebuildThoughtSearch(db);
}
