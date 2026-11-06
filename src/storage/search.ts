import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import type { ReadScope } from "../domain/rejection";
import { searchContexts, type SearchContext, type SearchHit, type SearchOptions, type SearchPage, type SearchRepository, type SearchResult } from "../domain/search";
import { createThought, displayTitle, type ThoughtAuthor, type MaterialKind } from "../domain/thought";
import { createConnection } from "../domain/connection";

let nextRepository = 0;
type Vocabulary = { readonly documents: string; readonly terms: string; readonly spelling: string; readonly version: string };

/** Internal SQLite adapter; consumer access requires an explicit scope. */
export class SqliteSearchRepository implements SearchRepository {
  private readonly prefix = `search_cache_${++nextRepository}`;
  private readonly vocabularies = new Map<string, Vocabulary>();
  private extensionLoaded = false;
  constructor(private readonly db: Database, private readonly spellfixPath = fileURLToPath(new URL("../../build/sqlite/spellfix.so", import.meta.url)), private readonly logger: Logger = createLogger()) {}

  private flags(scope: ReadScope): { inspect: number; ai: number } {
    return { inspect: scope.actor === "user" && scope.mode !== "normal" ? 1 : 0, ai: scope.actor === "ai" ? 1 : 0 };
  }

  /** Shared lexical preparation; correction is attempted only when there are no scoped hits. */
  lexicalMatch(scope: ReadScope, query: string): string | null {
    let tokens: string[] = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!tokens.length) return null;
    const matchFor = (words: string[]) => words.map(token => `"${token}"*`).join(" AND ");
    const match = matchFor(tokens);
    const { inspect, ai } = this.flags(scope);
    const found = this.db.query(`SELECT 1 FROM thought_search_fts f JOIN thoughts t ON t.id=f.thought_id
      WHERE thought_search_fts MATCH ? AND (?=1 OR NOT EXISTS (SELECT 1 FROM rejected_thoughts WHERE thought_id=t.id))
      UNION ALL SELECT 1 FROM response_search_fts f JOIN responses r ON r.id=f.response_id
      WHERE response_search_fts MATCH ? AND EXISTS (SELECT 1 FROM response_thoughts rt LEFT JOIN rejected_thoughts x ON x.thought_id=rt.thought_id
        WHERE rt.response_id=r.id AND (?=1 OR x.thought_id IS NULL))
      AND (?=0 OR NOT EXISTS (SELECT 1 FROM response_thoughts rt JOIN rejected_thoughts x ON x.thought_id=rt.thought_id WHERE rt.response_id=r.id)) LIMIT 1`)
      .get(match, inspect, match, inspect, ai);
    if (!found) tokens = tokens.map(token => this.suggestions(scope, token).find(candidate => candidate.distance <= (token.length < 5 ? 100 : 200))?.word ?? token);
    return matchFor(tokens);
  }

  search(scope: ReadScope, query: string): readonly SearchHit[] {
    this.logger.verbose("[search storage] search attempt");
    try {
      const result = this.db.transaction(() => {
        const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
        if (!tokens.length) return [];
        const match = tokens.map(token => `"${token}"*`).join(" AND ");
        const { inspect, ai } = this.flags(scope);
        const thoughts = this.db.query(`SELECT 'thought' AS kind,t.id AS id,t.id AS thoughtId,t.text AS text
          FROM thought_search_fts f JOIN thoughts t ON t.id=f.thought_id
          LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=t.id
          WHERE thought_search_fts MATCH ? AND (?=1 OR rejected.thought_id IS NULL)`).all(match,inspect) as SearchHit[];
        const responses = this.db.query(`SELECT 'response' AS kind,r.id AS id,r.text AS text,
          (SELECT rt.thought_id FROM response_thoughts rt
            LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=rt.thought_id
            WHERE rt.response_id=r.id AND (?=1 OR rejected.thought_id IS NULL)
            ORDER BY rt.position DESC LIMIT 1) AS thoughtId
          FROM response_search_fts f JOIN responses r ON r.id=f.response_id
          WHERE response_search_fts MATCH ?
            AND EXISTS (SELECT 1 FROM response_thoughts rt LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=rt.thought_id
              WHERE rt.response_id=r.id AND (?=1 OR rejected.thought_id IS NULL))
            AND (?=0 OR NOT EXISTS (SELECT 1 FROM response_thoughts rt JOIN rejected_thoughts rejected ON rejected.thought_id=rt.thought_id WHERE rt.response_id=r.id))`).all(inspect,match,inspect,ai) as SearchHit[];
        return [...thoughts, ...responses];
      })();
      this.logger.verbose("[search storage] search succeeded");
      return result;
    } catch (error) { this.logger.verbose("[search storage] search failed"); throw error; }
  }

  query(scope: ReadScope, query: string, options: SearchOptions): SearchPage {
    this.logger.verbose("[search storage] query attempt");
    try {
      const page = this.db.transaction(() => {
        const match = this.lexicalMatch(scope, query) ?? '""';
        const { inspect, ai } = this.flags(scope);
        const params = { $match: match, $inspect: inspect, $ai: ai, $from: options.from ?? null, $to: options.to ?? null,
          $authors: JSON.stringify(options.authors ?? []), $kinds: JSON.stringify(options.kinds ?? []) };
        const cte = `WITH matched AS MATERIALIZED (
          SELECT 'thought' AS kind,t.id AS id,t.id AS thoughtId,t.text AS text,t.author AS author,bm25(thought_search_fts) AS score
          FROM thought_search_fts JOIN thoughts t ON t.id=thought_search_fts.thought_id
          LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=t.id
          WHERE thought_search_fts MATCH $match AND ($inspect=1 OR rejected.thought_id IS NULL)
          UNION ALL
          SELECT 'response' AS kind,r.id AS id,
            (SELECT rt.thought_id FROM response_thoughts rt LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=rt.thought_id
              WHERE rt.response_id=r.id AND ($inspect=1 OR rejected.thought_id IS NULL) ORDER BY rt.position DESC LIMIT 1) AS thoughtId,
            r.text AS text,'ai' AS author,bm25(response_search_fts) AS score
          FROM response_search_fts JOIN responses r ON r.id=response_search_fts.response_id
          WHERE response_search_fts MATCH $match
            AND EXISTS (SELECT 1 FROM response_thoughts rt LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=rt.thought_id
              WHERE rt.response_id=r.id AND ($inspect=1 OR rejected.thought_id IS NULL))
            AND ($ai=0 OR NOT EXISTS (SELECT 1 FROM response_thoughts rt JOIN rejected_thoughts rejected ON rejected.thought_id=rt.thought_id WHERE rt.response_id=r.id))
        ), candidates AS MATERIALIZED (
          SELECT matched.*,t.kind AS materialKind,t.created_at AS createdAt,t.text AS thoughtText,m.title AS title
          FROM matched JOIN thoughts t ON t.id=matched.thoughtId JOIN thought_titles m ON m.thought_id=t.id
          WHERE ($from IS NULL OR julianday(t.created_at)>=julianday($from)) AND ($to IS NULL OR julianday(t.created_at)<=julianday($to))
        ) `;
        const authorFilter = `(json_array_length($authors)=0 OR author IN (SELECT value FROM json_each($authors)))`;
        const kindFilter = `(json_array_length($kinds)=0 OR materialKind IN (SELECT value FROM json_each($kinds)))`;
        const ordering = options.sort === "newest" ? "julianday(createdAt) DESC, id, kind" : options.sort === "oldest" ? "julianday(createdAt) ASC, id, kind" : "score ASC, id, kind";
        type Row = SearchHit & { author: ThoughtAuthor; materialKind: MaterialKind; createdAt: string; thoughtText: string; title: string | null };
        const rows = this.db.query(`${cte} SELECT * FROM candidates WHERE ${authorFilter} AND ${kindFilter} ORDER BY ${ordering}`).all(params) as Row[];
        const authorRows = this.db.query(`${cte} SELECT author AS value, count(*) AS n FROM candidates WHERE ${kindFilter} GROUP BY author`).all(params) as { value: ThoughtAuthor; n: number }[];
        const kindRows = this.db.query(`${cte} SELECT materialKind AS value, count(*) AS n FROM candidates WHERE ${authorFilter} GROUP BY materialKind`).all(params) as { value: MaterialKind; n: number }[];
        const authors: Record<ThoughtAuthor, number> = { user: 0, ai: 0, source: 0 };
        const kinds: Record<MaterialKind, number> = { "captured-original": 0, "user-contribution": 0, "ai-interpretation": 0, "developing-idea": 0, "imported-original": 0 };
        for (const row of authorRows) authors[row.value] = row.n;
        for (const row of kindRows) kinds[row.value] = row.n;
        const contexts = this.contexts(scope, match, rows.map(row => row.thoughtId));
        const results: SearchResult[] = rows.map(row => ({ kind: row.kind, id: row.id, thoughtId: row.thoughtId,
          text: row.text, title: displayTitle({ text: row.thoughtText, title: row.title }), author: row.author,
          materialKind: row.materialKind, createdAt: row.createdAt, snippet: row.text.slice(0, 160), context: contexts.get(row.thoughtId) ?? null }));
        return { results, counts: { authors, kinds } };
      })();
      this.logger.verbose("[search storage] query succeeded");
      return page;
    } catch (error) { this.logger.verbose("[search storage] query failed"); throw error; }
  }

  private contexts(scope: ReadScope, match: string, ids: readonly string[]): ReadonlyMap<string, SearchContext> {
    if (!ids.length) return new Map();
    const targetIds = JSON.stringify([...new Set(ids)]);
    const targets = this.db.query(`SELECT id,parent_id AS parentId FROM thoughts WHERE id IN (SELECT value FROM json_each(?))`)
      .all(targetIds) as { id: string; parentId: string | null }[];
    // One FTS pass for the entire page, restricted to the thought's own text column.
    const candidates = this.db.query(`WITH matching AS MATERIALIZED (
        SELECT thought_id AS id,bm25(thought_search_fts,0,1,0) AS score
        FROM thought_search_fts WHERE thought_search_fts MATCH ?
      ), targets AS MATERIALIZED (SELECT value AS id FROM json_each(?))
      SELECT targets.id AS targetId, matching.id AS thoughtId, c.id AS connectionId
      FROM targets JOIN connections c ON c.from_id=targets.id OR c.to_id=targets.id
      JOIN matching ON matching.id=CASE WHEN c.from_id=targets.id THEN c.to_id ELSE c.from_id END
      WHERE matching.id != targets.id
      ORDER BY targets.id, matching.score, matching.id, c.id`).all(`text : (${match})`, targetIds) as { targetId: string; thoughtId: string; connectionId: string }[];
    const thoughtIds = JSON.stringify([...new Set([...targets.flatMap(target => target.parentId === null ? [] : [target.parentId]), ...candidates.map(item => item.thoughtId)])]);
    const connectionIds = JSON.stringify([...new Set(candidates.map(item => item.connectionId))]);
    const sourceMap = (rows: { ownerId: string; sourceId: string }[]) => {
      const result = new Map<string, string[]>();
      for (const row of rows) {
        const sources = result.get(row.ownerId) ?? [];
        sources.push(row.sourceId);
        result.set(row.ownerId, sources);
      }
      return result;
    };
    const thoughtSources = sourceMap(this.db.query(`SELECT thought_id AS ownerId,source_id AS sourceId FROM thought_sources
      WHERE thought_id IN (SELECT value FROM json_each(?)) ORDER BY thought_id,position`).all(thoughtIds) as { ownerId: string; sourceId: string }[]);
    const connectionSources = sourceMap(this.db.query(`SELECT connection_id AS ownerId,source_id AS sourceId FROM connection_sources
      WHERE connection_id IN (SELECT value FROM json_each(?)) ORDER BY connection_id,position`).all(connectionIds) as { ownerId: string; sourceId: string }[]);
    const thoughtRows = this.db.query(`SELECT t.id,t.text,m.title,m.title_author AS titleAuthor,t.author,t.kind,t.created_at AS createdAt,t.origin,t.parent_id AS parentId
      FROM thoughts t JOIN thought_titles m ON m.thought_id=t.id WHERE t.id IN (SELECT value FROM json_each(?))`).all(thoughtIds) as { id: string }[];
    const connectionRows = this.db.query(`SELECT id,from_id AS fromId,to_id AS toId,category,proposed_by AS proposedBy,explanation FROM connections
      WHERE id IN (SELECT value FROM json_each(?))`).all(connectionIds) as { id: string }[];
    const thoughts = new Map(thoughtRows.map(row => [row.id, createThought({ ...row, sourceIds: thoughtSources.get(row.id) ?? [] })]));
    const connections = new Map(connectionRows.map(row => [row.id, createConnection({ ...row, sourceIds: connectionSources.get(row.id) ?? [] })]));
    const rejected = new Set((this.db.query("SELECT thought_id AS id FROM rejected_thoughts").all() as { id: string }[]).map(row => row.id));
    const rejectedConnections = new Set((this.db.query("SELECT connection_id AS id FROM rejected_connections").all() as { id: string }[]).map(row => row.id));
    return searchContexts(scope, targets, candidates, thoughts, connections, rejected, rejectedConnections);
  }

  private vocabulary(scope: ReadScope): Vocabulary {
    const key = scope.actor === "ai" ? "ai" : scope.mode === "normal" ? "normal" : "inspection";
    const existing = this.vocabularies.get(key);
    if (existing && this.db.query("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?").get(existing.version)) return existing;
    if (!this.extensionLoaded) {
      try { this.db.loadExtension(this.spellfixPath, "sqlite3_spellfix_init"); }
      catch { throw new Error("Unable to load spellfix1; run bun run build:spellfix and verify compatible SQLite headers and runtime"); }
      this.extensionLoaded = true;
    }
    const documents = `${this.prefix}_${key}_documents`;
    const terms = `${this.prefix}_${key}_terms`;
    const spelling = `${this.prefix}_${key}_spelling`;
    const version = `${this.prefix}_${key}_version`;
    this.db.exec(`CREATE VIRTUAL TABLE temp.${documents} USING fts5(text);
      CREATE VIRTUAL TABLE temp.${terms} USING fts5vocab('temp', '${documents}', 'row');
      CREATE VIRTUAL TABLE temp.${spelling} USING spellfix1;
      CREATE TABLE temp.${version}(revision INTEGER);
      INSERT INTO temp.${version}(revision) VALUES (NULL);`);
    const vocabulary: Vocabulary = { documents, terms, spelling, version };
    this.vocabularies.set(key, vocabulary);
    return vocabulary;
  }

  suggest(scope: ReadScope, term: string): readonly string[] {
    return this.suggestions(scope, term).map(row => row.word);
  }

  private suggestions(scope: ReadScope, term: string): readonly { word: string; distance: number }[] {
    this.logger.verbose("[search storage] suggest attempt");
    try {
      const vocabulary = this.vocabulary(scope);
      const { inspect, ai } = this.flags(scope);
      const result = this.db.transaction(() => {
        const version = this.db.query("SELECT revision FROM search_revision WHERE id=1").get() as { revision: number };
        const cached = this.db.query(`SELECT revision FROM temp.${vocabulary.version}`).get() as { revision: number | null };
        if (cached.revision !== version.revision) {
          this.db.exec(`DELETE FROM temp.${vocabulary.documents}; DELETE FROM temp.${vocabulary.spelling};`);
          this.db.query(`INSERT INTO temp.${vocabulary.documents}(text)
            SELECT t.text FROM thoughts t LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=t.id
            WHERE ?=1 OR rejected.thought_id IS NULL`).run(inspect);
          this.db.query(`INSERT INTO temp.${vocabulary.documents}(text)
            SELECT m.title FROM thought_titles m LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=m.thought_id
            WHERE m.title IS NOT NULL AND (?=1 OR rejected.thought_id IS NULL)`).run(inspect);
          this.db.query(`INSERT INTO temp.${vocabulary.documents}(text)
            SELECT r.text FROM responses r
            WHERE EXISTS (SELECT 1 FROM response_thoughts rt LEFT JOIN rejected_thoughts rejected ON rejected.thought_id=rt.thought_id
                WHERE rt.response_id=r.id AND (?=1 OR rejected.thought_id IS NULL))
              AND (?=0 OR NOT EXISTS (SELECT 1 FROM response_thoughts rt JOIN rejected_thoughts rejected ON rejected.thought_id=rt.thought_id WHERE rt.response_id=r.id))`).run(inspect,ai);
          this.db.exec(`INSERT INTO temp.${vocabulary.spelling}(word,rank) SELECT term,doc FROM temp.${vocabulary.terms}`);
          this.db.query(`UPDATE temp.${vocabulary.version} SET revision=?`).run(version.revision);
        }
        return this.db.query(`SELECT word, distance FROM temp.${vocabulary.spelling} WHERE word MATCH ? ORDER BY distance, rank DESC, word`).all(term) as { word: string; distance: number }[];
      })();
      this.logger.verbose("[search storage] suggest succeeded");
      return result;
    } catch (error) { this.logger.verbose("[search storage] suggest failed"); throw error; }
  }
}
