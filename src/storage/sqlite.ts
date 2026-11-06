import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { createThought, type Thought } from "../domain/thought";
import { createConnection, type Connection } from "../domain/connection";
import type { ResponseRecord } from "../domain/response";
import { SqliteSharedResponses } from "./shared-response";
import { migrateRunSchema } from "./run-schema";
import { nonEmpty } from "../domain/validation";
import { captureWeaveIntent } from "../domain/weave-scheduling";
import { admitWeave, type WeaveSources } from "./weave-admission";
import { migrateImportFoundation } from "./import-migration";
import { migrateSearchFoundation } from "./search-migration";
import { migrateExecutionOwners } from "./execution-owner-schema";
import { migrateSearchCleanup } from "./search-cleanup-migration";
import { immediate } from "./transaction";
import { ValidationError } from "../domain/validation";
import { randomUUID } from "node:crypto";
import { SearchSessionService, type SearchSessionSources, type SearchSessions } from "../domain/agentic-search";
import { SqliteSearchSessions } from "./search-sessions";
import type { SearchPublication } from "../domain/search-publication";
import { SqliteSearchPublication } from "./search-publication";
import type { SearchInvestigation } from "../domain/investigative-retrieval";
import { SqliteSearchInvestigation } from "./investigative-retrieval";
import { SqliteSearchRepository } from "./search";
import type { SqliteSearchRetention } from "./search-retention";

function boundary<T>(logger: Logger, operation: string, action: () => T): T {
  logger.verbose(`[storage] ${operation} attempt`);
  try {
    const result = action();
    logger.verbose(`[storage] ${operation} succeeded`);
    return result;
  } catch (error) {
    logger.verbose(`[storage] ${operation} failed`);
    throw error;
  }
}

/** Bootstrap an existing connection. Safe to call on each opening. */
export function migrate(db: Database, logger: Logger = createLogger()): void {
  boundary(logger, "migrate", () => {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (foreignKeys.foreign_keys !== 1) throw new Error("SQLite foreign keys could not be enabled");
    immediate(db, () => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS thoughts (
        id TEXT PRIMARY KEY NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('user', 'ai')),
        kind TEXT NOT NULL CHECK (kind IN ('captured-original', 'user-contribution', 'ai-interpretation', 'developing-idea')),
        created_at TEXT NOT NULL,
        origin TEXT NOT NULL,
        parent_id TEXT REFERENCES thoughts(id),
        CHECK (parent_id IS NULL OR parent_id != id)
      );
      CREATE TRIGGER IF NOT EXISTS thoughts_immutable_update BEFORE UPDATE ON thoughts
      BEGIN SELECT RAISE(ABORT, 'thoughts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS thoughts_immutable_delete BEFORE DELETE ON thoughts
      BEGIN SELECT RAISE(ABORT, 'thoughts are immutable'); END;
      CREATE TABLE IF NOT EXISTS thought_titles (
        thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id),
        title TEXT,
        title_author TEXT CHECK (title_author IN ('user', 'ai')),
        CHECK ((title IS NULL AND title_author IS NULL) OR (title IS NOT NULL AND title_author IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS thought_sources (
        thought_id TEXT NOT NULL REFERENCES thoughts(id),
        position INTEGER NOT NULL,
        source_id TEXT NOT NULL REFERENCES thoughts(id),
        PRIMARY KEY (thought_id, position)
      );
      CREATE TABLE IF NOT EXISTS thought_source_seals (
        thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id)
      );
      -- Thoughts saved by an earlier schema already have their complete source sets.
      INSERT OR IGNORE INTO thought_source_seals (thought_id) SELECT id FROM thoughts;
      CREATE TRIGGER IF NOT EXISTS thought_source_seals_immutable_update BEFORE UPDATE ON thought_source_seals
      BEGIN SELECT RAISE(ABORT, 'thought source seals are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS thought_source_seals_immutable_delete BEFORE DELETE ON thought_source_seals
      BEGIN SELECT RAISE(ABORT, 'thought source seals are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS thought_sources_immutable_insert BEFORE INSERT ON thought_sources
      WHEN EXISTS (SELECT 1 FROM thought_source_seals WHERE thought_id = NEW.thought_id)
      BEGIN SELECT RAISE(ABORT, 'thought sources are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS thought_sources_immutable_update BEFORE UPDATE ON thought_sources
      BEGIN SELECT RAISE(ABORT, 'thought sources are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS thought_sources_immutable_delete BEFORE DELETE ON thought_sources
      BEGIN SELECT RAISE(ABORT, 'thought sources are immutable'); END;
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY NOT NULL,
        from_id TEXT NOT NULL REFERENCES thoughts(id),
        to_id TEXT NOT NULL REFERENCES thoughts(id),
        category TEXT NOT NULL CHECK (category IN ('supports', 'contradicts', 'extends', 'related')),
        proposed_by TEXT NOT NULL CHECK (proposed_by IN ('user', 'ai')),
        explanation TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connection_sources (
        connection_id TEXT NOT NULL REFERENCES connections(id),
        position INTEGER NOT NULL,
        source_id TEXT NOT NULL REFERENCES thoughts(id),
        PRIMARY KEY (connection_id, position)
      );
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY NOT NULL,
        text TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('addendum', 'fallback')),
        state TEXT NOT NULL CHECK (state IN ('complete', 'interrupted'))
      );
      CREATE TRIGGER IF NOT EXISTS responses_immutable_update BEFORE UPDATE ON responses
      BEGIN SELECT RAISE(ABORT, 'responses are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS responses_immutable_delete BEFORE DELETE ON responses
      BEGIN SELECT RAISE(ABORT, 'responses are immutable'); END;
      CREATE TABLE IF NOT EXISTS rejected_thoughts (
        thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id)
      );
      CREATE TABLE IF NOT EXISTS rejected_connections (
        connection_id TEXT PRIMARY KEY NOT NULL REFERENCES connections(id)
      );
      `);
      const columns = db.query("PRAGMA table_info(thoughts)").all() as { name: string }[];
      if (columns.some(column => column.name === "title")) {
        db.exec(`INSERT INTO thought_titles (thought_id, title, title_author)
          SELECT id, title, CASE WHEN title IS NULL THEN NULL ELSE author END FROM thoughts;
          ALTER TABLE thoughts DROP COLUMN title;`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS response_thoughts (
        response_id TEXT NOT NULL REFERENCES responses(id),
        thought_id TEXT NOT NULL REFERENCES thoughts(id),
        position INTEGER NOT NULL CHECK (position >= 0),
        PRIMARY KEY (response_id, position), UNIQUE (response_id, thought_id)
      );
      CREATE TABLE IF NOT EXISTS response_seals (
        response_id TEXT PRIMARY KEY NOT NULL REFERENCES responses(id)
      );`);
      const responseColumns = db.query("PRAGMA table_info(responses)").all() as { name: string }[];
      if (responseColumns.some(column => column.name === "thought_id")) {
        db.exec(`ALTER TABLE responses ADD COLUMN state TEXT NOT NULL DEFAULT 'complete' CHECK (state IN ('complete', 'interrupted'));
          INSERT INTO response_thoughts (response_id, thought_id, position) SELECT id, thought_id, 0 FROM responses;
          INSERT INTO response_seals (response_id) SELECT id FROM responses;
          ALTER TABLE responses DROP COLUMN thought_id;`);
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS response_thoughts_sealed_insert BEFORE INSERT ON response_thoughts
        WHEN EXISTS (SELECT 1 FROM response_seals WHERE response_id = NEW.response_id)
        BEGIN SELECT RAISE(ABORT, 'response associations are sealed'); END;
        CREATE TRIGGER IF NOT EXISTS response_thoughts_immutable_update BEFORE UPDATE ON response_thoughts
        BEGIN SELECT RAISE(ABORT, 'response associations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS response_thoughts_immutable_delete BEFORE DELETE ON response_thoughts
        BEGIN SELECT RAISE(ABORT, 'response associations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS response_seals_immutable_update BEFORE UPDATE ON response_seals
        BEGIN SELECT RAISE(ABORT, 'response seals are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS response_seals_immutable_delete BEFORE DELETE ON response_seals
        BEGIN SELECT RAISE(ABORT, 'response seals are immutable'); END;
      `);
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS thought_search_fts USING fts5(thought_id UNINDEXED, text, title);
        CREATE VIRTUAL TABLE IF NOT EXISTS response_search_fts USING fts5(response_id UNINDEXED, text);
        CREATE TRIGGER IF NOT EXISTS thought_search_title_insert AFTER INSERT ON thought_titles BEGIN
          INSERT INTO thought_search_fts(thought_id,text,title)
            SELECT t.id,t.text,NEW.title FROM thoughts t WHERE t.id=NEW.thought_id;
        END;
        CREATE TRIGGER IF NOT EXISTS thought_search_title_update AFTER UPDATE ON thought_titles BEGIN
          DELETE FROM thought_search_fts WHERE thought_id=OLD.thought_id;
          INSERT INTO thought_search_fts(thought_id,text,title)
            SELECT t.id,t.text,NEW.title FROM thoughts t WHERE t.id=NEW.thought_id;
        END;
        CREATE TRIGGER IF NOT EXISTS thought_search_title_delete AFTER DELETE ON thought_titles BEGIN
          DELETE FROM thought_search_fts WHERE thought_id=OLD.thought_id;
        END;
        CREATE TRIGGER IF NOT EXISTS response_search_insert AFTER INSERT ON responses BEGIN
          INSERT INTO response_search_fts(response_id,text) VALUES (NEW.id,NEW.text);
        END;
        DELETE FROM thought_search_fts;
        INSERT INTO thought_search_fts(thought_id,text,title)
          SELECT t.id,t.text,m.title FROM thoughts t JOIN thought_titles m ON m.thought_id=t.id;
        DELETE FROM response_search_fts;
        INSERT INTO response_search_fts(response_id,text) SELECT id,text FROM responses;
        CREATE TABLE IF NOT EXISTS search_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO search_revision(id,revision) VALUES (1,0);
        CREATE TRIGGER IF NOT EXISTS search_revision_title_insert AFTER INSERT ON thought_titles BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS search_revision_title_update AFTER UPDATE ON thought_titles BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS search_revision_title_delete AFTER DELETE ON thought_titles BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS search_revision_response_insert AFTER INSERT ON responses BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS search_revision_link_insert AFTER INSERT ON response_thoughts BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS search_revision_link_update AFTER UPDATE ON response_thoughts BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS search_revision_link_delete AFTER DELETE ON response_thoughts BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS search_revision_reject_insert AFTER INSERT ON rejected_thoughts BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS search_revision_reject_delete AFTER DELETE ON rejected_thoughts BEGIN UPDATE search_revision SET revision=revision+1 WHERE id=1; END;
      `);
      migrateRunSchema(db);
      migrateImportFoundation(db);
      migrateSearchFoundation(db);
      migrateExecutionOwners(db);
      migrateSearchCleanup(db);
      if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_revisions'").get()) db.exec(`
        CREATE TRIGGER IF NOT EXISTS retrieval_thought_insert AFTER INSERT ON thoughts BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_title_insert AFTER INSERT ON thought_titles BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_title_update AFTER UPDATE ON thought_titles WHEN OLD.title IS NOT NEW.title OR OLD.title_author IS NOT NEW.title_author BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_title_delete AFTER DELETE ON thought_titles BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_response_insert AFTER INSERT ON responses BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_association_insert AFTER INSERT ON response_thoughts BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_source_insert AFTER INSERT ON thought_sources BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_connection_insert AFTER INSERT ON connections BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_connection_update AFTER UPDATE ON connections WHEN OLD.id IS NOT NEW.id OR OLD.from_id IS NOT NEW.from_id OR OLD.to_id IS NOT NEW.to_id OR OLD.category IS NOT NEW.category BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS retrieval_connection_delete AFTER DELETE ON connections BEGIN UPDATE search_revisions SET retrieval=retrieval+1 WHERE id=1; END;
      `);
      if (!db.query("SELECT 1 FROM import_namespaces WHERE kind='loose-markdown'").get()) {
        db.run("INSERT INTO import_namespaces(id,kind,label,created_at) VALUES (?,'loose-markdown','Loose Markdown',?)",[randomUUID(),new Date().toISOString()]);
      }
    });
    if ((db.query("PRAGMA foreign_keys").get() as {foreign_keys:number}).foreign_keys !== 1) throw new Error("SQLite foreign keys could not be retained");
  });
}

/** Internal raw persistence; future routes and agents must use scoped RejectionService reads. */
export class SqliteStore {
  constructor(private readonly db: Database, private readonly scheduling?: WeaveSources, private readonly logger: Logger = scheduling?.logger ?? createLogger()) {}

  searchSessions(sources: SearchSessionSources, retention?: SqliteSearchRetention): SearchSessions {
    return new SearchSessionService(new SqliteSearchSessions(this.db, sources.logger ?? this.logger,retention), { ...sources, logger: sources.logger ?? this.logger });
  }

  /** Internal AI-normal candidate retrieval; not a full-read witness. */
  searchInvestigation(): SearchInvestigation {
    return new SqliteSearchInvestigation(this.db, new SqliteSearchRepository(this.db, undefined, this.logger), this.logger);
  }

  /** Trusted dispatcher integration only; never expose this facet as user/model-selected authority. */
  searchPublication(sources: SearchSessionSources): SearchPublication {
    return new SqliteSearchPublication(this.db, { ...sources, logger: sources.logger ?? this.logger });
  }

  saveThought(input: Thought): void {
    boundary(this.logger, "save thought", () => {
      const thought = createThought(input);
      if (thought.author === "source" || thought.kind === "imported-original") throw new ValidationError("Imported originals require the dedicated import writer");
      this.db.transaction(() => {
        // Bun string binding consumes an initial U+FEFF; bind exact UTF-8 bytes and let SQLite cast them to TEXT.
        this.db.run("INSERT INTO thoughts (id, text, author, kind, created_at, origin, parent_id) VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?, ?)",
          [thought.id, new TextEncoder().encode(thought.text), thought.author, thought.kind, thought.createdAt, thought.origin, thought.parentId]);
        this.db.run("INSERT INTO thought_titles (thought_id, title, title_author) VALUES (?, ?, ?)",
          [thought.id, thought.title, thought.title === null ? null : thought.titleAuthor ?? thought.author]);
        const insert = this.db.query("INSERT INTO thought_sources (thought_id, position, source_id) VALUES (?, ?, ?)");
        thought.sourceIds.forEach((id, index) => insert.run(thought.id, index, id));
        this.db.run("INSERT INTO thought_source_seals (thought_id) VALUES (?)", [thought.id]);
        const intent = captureWeaveIntent(thought);
        if (this.scheduling && intent) admitWeave(this.db,this.scheduling,intent);
      }).immediate();
    });
  }

  getThought(id: string): Thought | null {
    return boundary(this.logger, "get thought", () => {
      nonEmpty(id, "id");
      const row = this.db.query(`SELECT t.id, t.text, m.title, m.title_author AS titleAuthor, t.author, t.kind, t.created_at AS createdAt,
        t.origin, t.parent_id AS parentId FROM thoughts t JOIN thought_titles m ON m.thought_id = t.id WHERE t.id = ?`).get(id);
      if (!row) return null;
      const sources = this.db.query("SELECT source_id AS id FROM thought_sources WHERE thought_id = ? ORDER BY position").all(id) as { id: string }[];
      return createThought({ ...row, sourceIds: sources.map(source => source.id) });
    });
  }

  saveConnection(input: Connection): void {
    boundary(this.logger, "save connection", () => {
      const connection = createConnection(input);
      this.db.transaction(() => {
        this.db.run("INSERT INTO connections (id, from_id, to_id, category, proposed_by, explanation) VALUES (?, ?, ?, ?, ?, ?)",
          [connection.id, connection.fromId, connection.toId, connection.category, connection.proposedBy, connection.explanation]);
        const insert = this.db.query("INSERT INTO connection_sources (connection_id, position, source_id) VALUES (?, ?, ?)");
        connection.sourceIds.forEach((id, index) => insert.run(connection.id, index, id));
      })();
    });
  }

  getConnection(id: string): Connection | null {
    return boundary(this.logger, "get connection", () => {
      nonEmpty(id, "id");
      const row = this.db.query(`SELECT id, from_id AS fromId, to_id AS toId, category,
        proposed_by AS proposedBy, explanation FROM connections WHERE id = ?`).get(id);
      if (!row) return null;
      const sources = this.db.query("SELECT source_id AS id FROM connection_sources WHERE connection_id = ? ORDER BY position").all(id) as { id: string }[];
      return createConnection({ ...row, sourceIds: sources.map(source => source.id) });
    });
  }

  saveResponse(input: ResponseRecord): void {
    boundary(this.logger, "save response", () => {
      new SqliteSharedResponses(this.db,this.logger).save(input);
    });
  }

  getResponse(id: string): ResponseRecord | null {
    return boundary(this.logger, "get response", () => {
      return new SqliteSharedResponses(this.db,this.logger).get(id);
    });
  }
}
