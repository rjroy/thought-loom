import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { CaptureInput, Source, SearchResult } from "@thoughtloom/contracts";

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  try {
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
      if (version?.user_version === 0) {
        db.run(`CREATE TABLE sources (
          id TEXT PRIMARY KEY NOT NULL,
          text TEXT NOT NULL,
          provenance TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`);
        db.run(`CREATE TABLE jobs (
          id TEXT PRIMARY KEY NOT NULL,
          source_id TEXT NOT NULL REFERENCES sources(id),
          status TEXT NOT NULL
        )`);
        db.run("PRAGMA user_version = 1");
      } else if (!version || version.user_version < 1 || version.user_version > 11) {
        throw new Error("Unsupported database schema version");
      }
      if (version?.user_version === 0 || version?.user_version === 1) {
        db.run(`CREATE TABLE capture_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL,
          payload_hash TEXT NOT NULL,
          source_id TEXT NOT NULL UNIQUE REFERENCES sources(id)
        )`);
        db.run("PRAGMA user_version = 2");
      }
      if (version && version.user_version < 3) {
        db.run("CREATE VIRTUAL TABLE source_search USING fts5(source_id UNINDEXED, text)");
        db.run("INSERT INTO source_search (source_id, text) SELECT id, text FROM sources");
        db.run("PRAGMA user_version = 3");
      }
      if (version && version.user_version < 4) {
        db.run(`CREATE TRIGGER sources_immutable_update BEFORE UPDATE ON sources BEGIN SELECT RAISE(ABORT, 'immutable source'); END`);
        db.run(`CREATE TRIGGER sources_immutable_delete BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT, 'immutable source'); END`);
        db.run(`CREATE TABLE knowledge_items (
          id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('interpretation', 'developing-idea')),
          source_id TEXT NOT NULL REFERENCES sources(id)
        )`);
        db.run(`CREATE TABLE formulations (
          id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES knowledge_items(id), text TEXT NOT NULL,
          author TEXT NOT NULL CHECK(author IN ('user', 'ai')), operation_id TEXT NOT NULL, run_id TEXT,
          restored_from TEXT REFERENCES formulations(id)
        )`);
        db.run(`CREATE TABLE formulation_evidence (
          formulation_id TEXT NOT NULL REFERENCES formulations(id), source_id TEXT NOT NULL REFERENCES sources(id),
          position INTEGER NOT NULL, PRIMARY KEY(formulation_id, position), UNIQUE(formulation_id, source_id)
        )`);
        db.run(`CREATE TABLE relationships (
          id TEXT PRIMARY KEY NOT NULL, from_item_id TEXT NOT NULL REFERENCES knowledge_items(id),
          to_item_id TEXT NOT NULL REFERENCES knowledge_items(id), type TEXT NOT NULL CHECK(type IN ('supports','challenges','suggests')),
          CHECK(from_item_id <> to_item_id)
        )`);
        db.run(`CREATE TABLE relationship_revisions (
          id TEXT PRIMARY KEY NOT NULL, relationship_id TEXT NOT NULL REFERENCES relationships(id),
          status TEXT NOT NULL CHECK(status IN ('active', 'rejected')), rationale TEXT NOT NULL,
          author TEXT NOT NULL CHECK(author IN ('user', 'ai')), operation_id TEXT NOT NULL, run_id TEXT,
          restored_from TEXT REFERENCES relationship_revisions(id)
        )`);
        db.run(`CREATE TABLE relationship_evidence (
          revision_id TEXT NOT NULL REFERENCES relationship_revisions(id), source_id TEXT NOT NULL REFERENCES sources(id),
          position INTEGER NOT NULL, PRIMARY KEY(revision_id, position), UNIQUE(revision_id, source_id)
        )`);
        for (const table of ["formulations", "formulation_evidence", "relationship_revisions", "relationship_evidence"]) {
          db.run(`CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable history'); END`);
          db.run(`CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable history'); END`);
        }
        db.run("PRAGMA user_version = 4");
      }
      if (version && version.user_version < 5) {
        db.run(`CREATE TABLE knowledge_receipts (
          operation_id TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
          result_id TEXT NOT NULL, revision_id TEXT
        )`);
        db.run(`CREATE TABLE search_aliases (
          id TEXT PRIMARY KEY NOT NULL, alias TEXT NOT NULL, expansion TEXT NOT NULL,
          author TEXT NOT NULL CHECK(author IN ('user','ai')), operation_id TEXT NOT NULL, run_id TEXT
        )`);
        db.run(`CREATE TABLE alias_evidence (
          alias_id TEXT NOT NULL REFERENCES search_aliases(id), source_id TEXT NOT NULL REFERENCES sources(id),
          position INTEGER NOT NULL, PRIMARY KEY(alias_id, position), UNIQUE(alias_id, source_id)
        )`);
        db.run("CREATE INDEX alias_lookup ON search_aliases(lower(alias))");
        db.run("CREATE INDEX expansion_lookup ON search_aliases(lower(expansion))");
        db.run("CREATE VIRTUAL TABLE formulation_search USING fts5(item_id UNINDEXED, text)");
        db.run(`INSERT INTO formulation_search(item_id,text)
          SELECT f.item_id,f.text FROM formulations f WHERE f.rowid =
          (SELECT MAX(f2.rowid) FROM formulations f2 WHERE f2.item_id=f.item_id)`);
        db.run("CREATE VIRTUAL TABLE source_vocabulary USING fts5vocab(source_search, 'row')");
        db.run("CREATE VIRTUAL TABLE formulation_vocabulary USING fts5vocab(formulation_search, 'row')");
        db.run("PRAGMA user_version = 5");
      }
      if (version && version.user_version < 6) {
        db.run("CREATE INDEX knowledge_source ON knowledge_items(source_id)");
        db.run("CREATE INDEX relationship_from ON relationships(from_item_id)");
        db.run("CREATE INDEX relationship_to ON relationships(to_item_id)");
        db.run("CREATE INDEX formulation_item ON formulations(item_id)");
        db.run("CREATE INDEX relationship_revision_parent ON relationship_revisions(relationship_id)");
        db.run("PRAGMA user_version = 6");
      }
      if (version && version.user_version < 7) {
        const duplicates = db.query<{ present: number }, []>(
          "SELECT 1 AS present FROM relationships GROUP BY from_item_id, to_item_id, type HAVING COUNT(*) > 1 LIMIT 1",
        ).get();
        if (duplicates) throw new Error("Cannot migrate: duplicate directed relationship claims require reconciliation");
        db.run("CREATE UNIQUE INDEX relationship_claim_identity ON relationships(from_item_id, to_item_id, type)");
        db.run("PRAGMA user_version = 7");
      }
      if (version && version.user_version < 8) {
        db.run(`CREATE TABLE weaving_runs (
          id TEXT PRIMARY KEY NOT NULL,
          job_id TEXT NOT NULL REFERENCES jobs(id),
          attempt INTEGER NOT NULL CHECK(attempt > 0),
          session_id TEXT NOT NULL UNIQUE,
          prompt_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('preparing','admitting','admitted','uncertain','completed','not_admitted')),
          lease_owner TEXT,
          lease_until INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          recorded_changes INTEGER CHECK(recorded_changes >= 0),
          last_error TEXT CHECK(last_error IN ('preparation_failed','admission_unknown','inspection_failed','invalid_adapter_result')),
          UNIQUE(job_id, attempt),
          CHECK((lease_owner IS NULL) = (lease_until IS NULL)),
          CHECK((state = 'completed') = (recorded_changes IS NOT NULL))
        )`);
        db.run(`CREATE UNIQUE INDEX weaving_active_job ON weaving_runs(job_id)
          WHERE state IN ('preparing','admitting','admitted','uncertain')`);
        db.run("CREATE INDEX weaving_recovery ON weaving_runs(state, lease_until, updated_at)");
        db.run("CREATE INDEX jobs_queue ON jobs(status)");
        db.run(`CREATE TRIGGER weaving_identity_immutable
          BEFORE UPDATE OF id, job_id, attempt, session_id, prompt_id, created_at ON weaving_runs
          BEGIN SELECT RAISE(ABORT, 'immutable weaving identity'); END`);
        db.run(`CREATE TRIGGER weaving_receipt_retained BEFORE DELETE ON weaving_runs
          BEGIN SELECT RAISE(ABORT, 'retained weaving attempt'); END`);
        db.run(`CREATE TRIGGER jobs_identity_immutable BEFORE UPDATE OF id, source_id ON jobs
          BEGIN SELECT RAISE(ABORT, 'immutable job identity'); END`);
        db.run("PRAGMA user_version = 8");
      }
      if (version && version.user_version < 9) {
        db.run(`CREATE TABLE owned_grants (
          session_id TEXT PRIMARY KEY NOT NULL REFERENCES weaving_runs(session_id),
          run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id),
          location TEXT NOT NULL, agent TEXT NOT NULL,
          source_ids TEXT NOT NULL, operations TEXT NOT NULL, scope_hash TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
        )`);
        db.run(`CREATE TRIGGER grant_identity_immutable BEFORE UPDATE OF
          session_id,run_id,location,agent,source_ids,operations,scope_hash ON owned_grants
          BEGIN SELECT RAISE(ABORT, 'immutable owned grant'); END`);
        db.run(`CREATE TRIGGER grant_revocation_final BEFORE UPDATE OF revoked ON owned_grants
          WHEN OLD.revoked=1 AND NEW.revoked<>1 BEGIN SELECT RAISE(ABORT, 'revoked owned grant'); END`);
        db.run(`CREATE TRIGGER grant_receipt_retained BEFORE DELETE ON owned_grants
          BEGIN SELECT RAISE(ABORT, 'retained owned grant'); END`);
        db.run(`CREATE TRIGGER grant_run_settled AFTER UPDATE OF state ON weaving_runs
          WHEN NEW.state IN ('completed','not_admitted') BEGIN
            UPDATE owned_grants SET revoked=1 WHERE run_id=NEW.id;
          END`);
        db.run(`CREATE TRIGGER grant_job_inactive AFTER UPDATE OF status ON jobs
          WHEN NEW.status NOT IN ('running','uncertain') BEGIN
            UPDATE owned_grants SET revoked=1 WHERE run_id IN (SELECT id FROM weaving_runs WHERE job_id=NEW.id);
          END`);
        db.run(`CREATE TABLE native_commands (
          run_id TEXT PRIMARY KEY NOT NULL REFERENCES weaving_runs(id),
          payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
          attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1))
        )`);
        db.run(`CREATE TRIGGER native_command_immutable BEFORE UPDATE OF run_id,payload,payload_hash ON native_commands
          BEGIN SELECT RAISE(ABORT, 'immutable native command'); END`);
        db.run(`CREATE TRIGGER native_admission_final BEFORE UPDATE OF attempted ON native_commands
          WHEN OLD.attempted=1 AND NEW.attempted<>1 BEGIN SELECT RAISE(ABORT, 'retained admission attempt'); END`);
        db.run(`CREATE TRIGGER native_command_retained BEFORE DELETE ON native_commands
          BEGIN SELECT RAISE(ABORT, 'retained native command'); END`);
        db.run("PRAGMA user_version = 9");
      }
      if (version && version.user_version < 10) {
        // Admission state and execution outcome are distinct facts. Failure or
        // interruption does not undo admission or erase earlier domain writes.
        db.run("ALTER TABLE weaving_runs ADD COLUMN outcome TEXT CHECK(outcome IN ('succeeded','failed','interrupted'))");
        db.run("UPDATE weaving_runs SET outcome='succeeded' WHERE state='completed'");
        db.run("DROP INDEX weaving_active_job");
        db.run(`CREATE UNIQUE INDEX weaving_active_job ON weaving_runs(job_id)
          WHERE outcome IS NULL AND state IN ('preparing','admitting','admitted','uncertain')`);
        db.run(`CREATE TRIGGER grant_execution_settled AFTER UPDATE OF outcome ON weaving_runs WHEN NEW.outcome IS NOT NULL
          BEGIN UPDATE owned_grants SET revoked=1 WHERE run_id=NEW.id; END`);
        db.run(`CREATE TRIGGER weaving_outcome_final BEFORE UPDATE OF outcome ON weaving_runs
          WHEN OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome BEGIN SELECT RAISE(ABORT, 'settled execution outcome'); END`);
        db.run("ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0)");
        db.run("DROP INDEX jobs_queue");
        db.run("CREATE INDEX jobs_queue ON jobs(status,priority)");
        db.run(`CREATE TABLE tool_reads (
          run_id TEXT NOT NULL REFERENCES weaving_runs(id), kind TEXT NOT NULL CHECK(kind IN ('source','item','relationship')),
          record_id TEXT NOT NULL, version_id TEXT, PRIMARY KEY(run_id,kind,record_id)
        )`);
        db.run("PRAGMA user_version = 10");
      }
      if (version && version.user_version < 11) {
        db.run(`CREATE TABLE weaving_retry_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
          id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL REFERENCES sources(id),
          job_id TEXT NOT NULL REFERENCES jobs(id), expected_run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id)
        )`);
        db.run(`CREATE TRIGGER weaving_retry_immutable BEFORE UPDATE ON weaving_retry_receipts
          BEGIN SELECT RAISE(ABORT, 'immutable retry command'); END`);
        db.run(`CREATE TRIGGER weaving_retry_retained BEFORE DELETE ON weaving_retry_receipts
          BEGIN SELECT RAISE(ABORT, 'retained retry command'); END`);
        db.run("CREATE INDEX formulation_run ON formulations(run_id)");
        db.run("CREATE INDEX relationship_revision_run ON relationship_revisions(run_id)");
        db.run("CREATE INDEX alias_run ON search_aliases(run_id)");
        db.run("CREATE INDEX jobs_source ON jobs(source_id)");
        db.run("PRAGMA user_version = 11");
      }
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

type CaptureResult =
  | { kind: "created" | "replayed"; source: Source }
  | { kind: "conflict" };

export function saveCapture(path: string, key: string, input: CaptureInput): CaptureResult {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify([input.text, input.provenance]), "utf8")
    .digest("hex");
  const db = openDatabase(path);
  try {
    return db.transaction((): CaptureResult => {
      const receipt = db.query<{ payload_hash: string; source_id: string }, [string]>(
        "SELECT payload_hash, source_id FROM capture_receipts WHERE idempotency_key = ?",
      ).get(key);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) return { kind: "conflict" };
        const source = db.query<Source, [string]>(
          "SELECT id, text, provenance, created_at AS createdAt FROM sources WHERE id = ?",
        ).get(receipt.source_id);
        if (!source) throw new Error("Capture receipt references a missing source");
        return { kind: "replayed", source };
      }
      const source: Source = {
        id: crypto.randomUUID(),
        text: input.text,
        provenance: input.provenance,
        createdAt: new Date().toISOString(),
      };
      db.run("INSERT INTO sources (id, text, provenance, created_at) VALUES (?, ?, ?, ?)",
        [source.id, source.text, source.provenance, source.createdAt]);
      db.run("INSERT INTO source_search (source_id, text) VALUES (?, ?)", [source.id, source.text]);
      db.run("INSERT INTO jobs (id, source_id, status) VALUES (?, ?, ?)",
        [crypto.randomUUID(), source.id, "queued"]);
      db.run("INSERT INTO capture_receipts (idempotency_key, payload_hash, source_id) VALUES (?, ?, ?)",
        [key, payloadHash, source.id]);
      return { kind: "created", source };
    }).immediate();
  } finally {
    db.close();
  }
}

export type SearchLimits = { results: number; aliases: number; typoCandidates: number };

export function searchSources(path: string, query: string, overrides: Partial<SearchLimits> = {}): SearchResult[] {
  const limits: SearchLimits = { results: 50, aliases: 100, typoCandidates: 256, ...overrides };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid search limits");
  const tokens = query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  if (tokens.length === 0) return [];

  const db = openDatabase(path);
  try {
    type SourceRow = { sourceId: string; text: string; provenance: string; createdAt: string };
    type ItemRow = SourceRow & { itemId: string; kind: "interpretation" | "developing-idea"; formulationId: string; formulationText: string; author: "user" | "ai" };
    const sourceStatement = db.query<SourceRow, [string, number]>(`SELECT s.id AS sourceId, s.text, s.provenance, s.created_at AS createdAt
      FROM source_search JOIN sources s ON s.id=source_search.source_id
      WHERE source_search MATCH ? ORDER BY bm25(source_search),s.id LIMIT ?`);
    const itemStatement = db.query<ItemRow, [string, number]>(`SELECT s.id AS sourceId,s.text,s.provenance,s.created_at AS createdAt,
      i.id AS itemId,i.kind,f.id AS formulationId,f.text AS formulationText,f.author
      FROM formulation_search JOIN knowledge_items i ON i.id=formulation_search.item_id
      JOIN sources s ON s.id=i.source_id JOIN formulations f ON f.item_id=i.id
      WHERE formulation_search MATCH ? AND f.rowid=(SELECT MAX(f2.rowid) FROM formulations f2 WHERE f2.item_id=i.id)
      ORDER BY bm25(formulation_search),i.id LIMIT ?`);
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    const add = (terms: string[], prefix: boolean, alias: boolean) => {
      const expression = terms.map((token) => `"${token}"${prefix ? "*" : ""}`).join(" AND ");
      for (const row of sourceStatement.all(expression, limits.results)) {
        const key = `source:${row.sourceId}`;
        if (!seen.has(key) && results.length < limits.results) {
          seen.add(key);
          results.push({ sourceId: row.sourceId, matchOrigin: alias ? "alias" : "source", source: { excerpt: row.text.slice(0, 240), provenance: row.provenance, createdAt: row.createdAt } });
        }
      }
      for (const row of itemStatement.all(expression, limits.results)) {
        const key = `item:${row.itemId}`;
        if (!seen.has(key) && results.length < limits.results) {
          seen.add(key);
          results.push({ sourceId: row.sourceId, matchOrigin: alias ? "alias" : "interpretation", source: { excerpt: row.text.slice(0, 240), provenance: row.provenance, createdAt: row.createdAt }, item: { id: row.itemId, kind: row.kind, formulationId: row.formulationId, text: row.formulationText, author: row.author } });
        }
      }
    };
    add(tokens, false, false);
    add(tokens, true, false);
    const normalized = tokens.join(" ").toLowerCase();
    const aliases = db.query<{ alias: string; expansion: string }, [string, string, number]>(
      "SELECT alias, expansion FROM search_aliases WHERE lower(alias)=? OR lower(expansion)=? ORDER BY id LIMIT ?",
    ).all(normalized, normalized, limits.aliases);
    for (const row of aliases) {
      const other = row.alias.toLowerCase() === normalized ? row.expansion : row.alias;
      const words = other.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
      if (words.length) add(words, false, true);
    }
    if (results.length === 0 && tokens.length === 1 && tokens[0] && tokens[0].length >= 4) {
      const word = tokens[0].toLowerCase();
      const candidates = db.query<{ term: string }, [string, string, number, number, string, string, number, number, number]>(
        `SELECT term FROM source_vocabulary WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?
         UNION SELECT term FROM formulation_vocabulary WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ? LIMIT ?`,
      ).all(word[0] ?? "", `${word[0]}\uffff`, word.length - 1, word.length + 1, word[0] ?? "", `${word[0]}\uffff`, word.length - 1, word.length + 1, limits.typoCandidates);
      for (const { term } of candidates) if (oneEditAway(word, term)) add([term], false, false);
    }
    return results;
  } finally {
    db.close();
  }
}

function oneEditAway(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

export function rebuildSearchIndex(path: string): void {
  console.info("search.rebuild attempt");
  let db: Database | undefined;
  try {
    const opened = openDatabase(path);
    db = opened;
    opened.transaction(() => {
      opened.run("DELETE FROM source_search");
      opened.run("INSERT INTO source_search(source_id,text) SELECT id,text FROM sources");
      opened.run("DELETE FROM formulation_search");
      opened.run(`INSERT INTO formulation_search(item_id,text) SELECT f.item_id,f.text FROM formulations f
        WHERE f.rowid=(SELECT MAX(f2.rowid) FROM formulations f2 WHERE f2.item_id=f.item_id)`);
    }).immediate();
    console.info("search.rebuild succeeded");
  } catch {
    console.error("search.rebuild failed", { category: "storage_error" });
    throw new Error("Search index rebuild failed");
  } finally { db?.close(); }
}

export function findSource(path: string, id: string): Source | null {
  const db = openDatabase(path);
  try {
    return db.query<Source, [string]>(
      "SELECT id, text, provenance, created_at AS createdAt FROM sources WHERE id = ?",
    ).get(id);
  } finally {
    db.close();
  }
}
