import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { parseSourceOrigin, parseSourceRecord, type CaptureInput, type Source, type SourceOrigin, type SearchResult } from "@thoughtloom/contracts";
import { migrateWeavingAbandonment } from "./weaving-abandonment-schema";
import { migrateTitles } from "./title-schema";
import { readTitle } from "./title-projection";

export const CURRENT_DATABASE_VERSION = 19;

function migrateFollowUpJobs(db: Database) {
  // Rebuild only jobs to widen its kind constraint. Preserve rowids (queue
  // order), indexes and every existing trigger attached to/referencing jobs.
  // Foreign keys are disabled on this migration connection and checked before
  // commit; no other writer can observe the intermediate schema.
  const triggers = db.query<{ name: string; sql: string; tableName: string }, []>(
    "SELECT name,sql,tbl_name AS tableName FROM sqlite_schema WHERE type='trigger' AND sql IS NOT NULL",
  ).all().filter((trigger) => trigger.tableName === "jobs" || /\bjobs\b/i.test(trigger.sql));
  const indexes = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='jobs' AND sql IS NOT NULL").all();
  for (const trigger of triggers) db.run(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  db.run(`CREATE TABLE jobs_next (
    id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0),
    kind TEXT NOT NULL DEFAULT 'capture' CHECK(kind IN ('capture','dialogue','follow_up'))
  )`);
  db.run("INSERT INTO jobs_next(rowid,id,source_id,status,priority,kind) SELECT rowid,id,source_id,status,priority,kind FROM jobs");
  db.run("DROP TABLE jobs");
  db.run("ALTER TABLE jobs_next RENAME TO jobs");
  for (const index of indexes) db.run(index.sql);
  for (const trigger of triggers) db.run(trigger.sql);
}

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  try {
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    const migrating = (db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0) < 15;
    if (migrating) db.run("PRAGMA foreign_keys = OFF");
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
      } else if (!version || version.user_version < 1 || version.user_version > CURRENT_DATABASE_VERSION) {
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
      if (version && version.user_version < 12) {
        db.run("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'capture' CHECK(kind IN ('capture','dialogue'))");
        db.run(`CREATE TRIGGER jobs_kind_immutable BEFORE UPDATE OF kind ON jobs
          BEGIN SELECT RAISE(ABORT, 'immutable job kind'); END`);
        db.run("DROP INDEX jobs_source");
        db.run("CREATE INDEX jobs_source ON jobs(source_id,kind)");
        db.run(`CREATE TABLE dialogues (
          id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
          item_id TEXT NOT NULL REFERENCES knowledge_items(id), version_id TEXT NOT NULL REFERENCES formulations(id),
          context TEXT NOT NULL, created_at TEXT NOT NULL
        )`);
        db.run("CREATE INDEX dialogues_source ON dialogues(source_id)");
        db.run(`CREATE TRIGGER dialogue_selection_scope BEFORE INSERT ON dialogues WHEN NOT EXISTS (
          SELECT 1 FROM knowledge_items i JOIN formulations f ON f.item_id=i.id
          WHERE i.id=NEW.item_id AND i.source_id=NEW.source_id AND f.id=NEW.version_id
        ) BEGIN SELECT RAISE(ABORT, 'invalid dialogue selection'); END`);
        db.run(`CREATE TABLE dialogue_turns (
          id TEXT PRIMARY KEY NOT NULL, dialogue_id TEXT NOT NULL REFERENCES dialogues(id),
          source_id TEXT NOT NULL UNIQUE REFERENCES sources(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
          position INTEGER NOT NULL CHECK(position > 0), created_at TEXT NOT NULL, UNIQUE(dialogue_id,position)
        )`);
        db.run(`CREATE TRIGGER dialogue_turn_scope BEFORE INSERT ON dialogue_turns WHEN NOT EXISTS (
          SELECT 1 FROM dialogues d JOIN jobs j ON j.id=NEW.job_id JOIN sources s ON s.id=NEW.source_id
          WHERE d.id=NEW.dialogue_id AND j.kind='dialogue' AND j.source_id=d.source_id
            AND s.id<>d.source_id AND s.provenance='discussion-turn' AND s.created_at=NEW.created_at
        ) BEGIN SELECT RAISE(ABORT, 'invalid dialogue turn scope'); END`);
        db.run(`CREATE TABLE dialogue_turn_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
          turn_id TEXT NOT NULL UNIQUE REFERENCES dialogue_turns(id), command TEXT NOT NULL
        )`);
        for (const table of ["dialogues", "dialogue_turns", "dialogue_turn_receipts"]) {
          db.run(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table}
            BEGIN SELECT RAISE(ABORT, 'immutable dialogue command context'); END`);
          db.run(`CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
            BEGIN SELECT RAISE(ABORT, 'retained dialogue context'); END`);
        }
        db.run("PRAGMA user_version = 12");
      }
      if (version && version.user_version < 13) {
        // Preserve the response shape of already-issued capture commands while
        // new captures carry structured origin metadata on acknowledgment/read.
        db.run("ALTER TABLE capture_receipts ADD COLUMN response_version INTEGER NOT NULL DEFAULT 1 CHECK(response_version IN (1,2))");
        // Foreign keys are checked before commit and re-enabled below. Rebuild
        // only this parent to allow source/relationship targets without fake items.
        db.run("DROP TRIGGER dialogue_turn_scope");
        db.run("DROP TRIGGER dialogue_selection_scope");
        db.run("DROP TRIGGER dialogues_immutable"); db.run("DROP TRIGGER dialogues_retained");
        db.run(`CREATE TABLE dialogues_next (
          id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
          selection_kind TEXT NOT NULL CHECK(selection_kind IN ('source','item','relationship')),
          item_id TEXT REFERENCES knowledge_items(id), version_id TEXT REFERENCES formulations(id),
          relationship_id TEXT REFERENCES relationships(id), relationship_version_id TEXT REFERENCES relationship_revisions(id),
          from_version_id TEXT REFERENCES formulations(id), to_version_id TEXT REFERENCES formulations(id),
          context TEXT NOT NULL, created_at TEXT NOT NULL,
          CHECK((selection_kind='source' AND item_id IS NULL AND version_id IS NULL AND relationship_id IS NULL AND relationship_version_id IS NULL AND from_version_id IS NULL AND to_version_id IS NULL)
            OR (selection_kind='item' AND item_id IS NOT NULL AND version_id IS NOT NULL AND relationship_id IS NULL AND relationship_version_id IS NULL AND from_version_id IS NULL AND to_version_id IS NULL)
            OR (selection_kind='relationship' AND item_id IS NULL AND version_id IS NULL AND relationship_id IS NOT NULL AND relationship_version_id IS NOT NULL AND from_version_id IS NOT NULL AND to_version_id IS NOT NULL))
        )`);
        db.run(`INSERT INTO dialogues_next(id,source_id,selection_kind,item_id,version_id,context,created_at)
          SELECT id,source_id,'item',item_id,version_id,context,created_at FROM dialogues`);
        db.run("DROP TABLE dialogues"); db.run("ALTER TABLE dialogues_next RENAME TO dialogues");
        db.run("CREATE INDEX dialogues_source ON dialogues(source_id)");
        db.run(`CREATE TRIGGER dialogue_selection_scope BEFORE INSERT ON dialogues WHEN
          (NEW.selection_kind='item' AND NOT EXISTS (SELECT 1 FROM knowledge_items i JOIN formulations f ON f.item_id=i.id
            WHERE i.id=NEW.item_id AND i.source_id=NEW.source_id AND f.id=NEW.version_id)) OR
          (NEW.selection_kind='relationship' AND NOT EXISTS (SELECT 1 FROM relationships r
            JOIN relationship_revisions v ON v.relationship_id=r.id JOIN knowledge_items a ON a.id=r.from_item_id JOIN knowledge_items b ON b.id=r.to_item_id
            JOIN formulations af ON af.item_id=a.id JOIN formulations bf ON bf.item_id=b.id
            WHERE r.id=NEW.relationship_id AND v.id=NEW.relationship_version_id AND af.id=NEW.from_version_id AND bf.id=NEW.to_version_id
              AND (a.source_id=NEW.source_id OR b.source_id=NEW.source_id)))
          BEGIN SELECT RAISE(ABORT, 'invalid dialogue selection'); END`);
        db.run(`CREATE TRIGGER dialogue_turn_scope BEFORE INSERT ON dialogue_turns WHEN NOT EXISTS (
          SELECT 1 FROM dialogues d JOIN jobs j ON j.id=NEW.job_id JOIN sources s ON s.id=NEW.source_id
          WHERE d.id=NEW.dialogue_id AND j.kind='dialogue' AND j.source_id=d.source_id
            AND s.id<>d.source_id AND s.provenance='discussion-turn' AND s.created_at=NEW.created_at
        ) BEGIN SELECT RAISE(ABORT, 'invalid dialogue turn scope'); END`);
        db.run(`CREATE TABLE dialogue_creation_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
          dialogue_id TEXT NOT NULL UNIQUE REFERENCES dialogues(id), response TEXT NOT NULL
        )`);
        db.run(`CREATE TABLE dialogue_outcomes (
          turn_id TEXT PRIMARY KEY NOT NULL REFERENCES dialogue_turns(id), run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id),
          outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','interrupted')),
          assistant_message_id TEXT, assistant_text TEXT,
          CHECK((assistant_message_id IS NULL)=(assistant_text IS NULL)),
          CHECK(outcome<>'succeeded' OR assistant_text IS NOT NULL)
        )`);
        db.run(`CREATE TRIGGER dialogue_outcome_scope BEFORE INSERT ON dialogue_outcomes WHEN NOT EXISTS (
          SELECT 1 FROM dialogue_turns t JOIN weaving_runs r ON r.job_id=t.job_id
          WHERE t.id=NEW.turn_id AND r.id=NEW.run_id AND r.outcome=NEW.outcome
        ) BEGIN SELECT RAISE(ABORT, 'invalid dialogue outcome'); END`);
        db.run(`CREATE TABLE idea_derivations (
          item_id TEXT PRIMARY KEY NOT NULL REFERENCES knowledge_items(id),
          dialogue_id TEXT NOT NULL REFERENCES dialogues(id), turn_id TEXT NOT NULL REFERENCES dialogue_turns(id),
          root_source_id TEXT NOT NULL REFERENCES sources(id), turn_source_id TEXT NOT NULL REFERENCES sources(id),
          from_item_id TEXT REFERENCES knowledge_items(id), from_version_id TEXT REFERENCES formulations(id),
          CHECK((from_item_id IS NULL)=(from_version_id IS NULL))
        )`);
        db.run(`CREATE TRIGGER idea_derivation_scope BEFORE INSERT ON idea_derivations WHEN NOT EXISTS (
          SELECT 1 FROM dialogue_turns t JOIN dialogues d ON d.id=t.dialogue_id JOIN knowledge_items i ON i.id=NEW.item_id
          WHERE t.id=NEW.turn_id AND d.id=NEW.dialogue_id AND d.source_id=NEW.root_source_id AND t.source_id=NEW.turn_source_id
            AND i.source_id=d.source_id AND i.kind='developing-idea'
        ) OR (NEW.from_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM formulations f WHERE f.id=NEW.from_version_id AND f.item_id=NEW.from_item_id))
          BEGIN SELECT RAISE(ABORT, 'invalid idea derivation'); END`);
        for (const table of ["dialogues", "dialogue_creation_receipts", "dialogue_outcomes", "idea_derivations"]) {
          db.run(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable dialogue evidence'); END`);
          db.run(`CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'retained dialogue evidence'); END`);
        }
        db.run("PRAGMA user_version = 13");
      }
      if (version && version.user_version < 14) {
        db.run(`CREATE TABLE dialogue_stop_requests (
          id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
          dialogue_id TEXT NOT NULL REFERENCES dialogues(id), turn_id TEXT NOT NULL UNIQUE REFERENCES dialogue_turns(id),
          job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), expected_run_id TEXT REFERENCES weaving_runs(id), created_at TEXT NOT NULL
        )`);
        db.run(`CREATE TRIGGER dialogue_stop_scope BEFORE INSERT ON dialogue_stop_requests WHEN NOT EXISTS (
          SELECT 1 FROM dialogue_turns t WHERE t.id=NEW.turn_id AND t.dialogue_id=NEW.dialogue_id AND t.job_id=NEW.job_id
        ) OR (NEW.expected_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.id=NEW.expected_run_id AND r.job_id=NEW.job_id))
          BEGIN SELECT RAISE(ABORT, 'invalid dialogue stop scope'); END`);
        db.run(`CREATE TABLE dialogue_stop_dispatch (
          stop_id TEXT PRIMARY KEY NOT NULL REFERENCES dialogue_stop_requests(id),
          state TEXT NOT NULL CHECK(state IN ('queued','attempted','requested','uncertain'))
        )`);
        db.run(`CREATE TRIGGER dialogue_stop_dispatch_identity BEFORE UPDATE OF stop_id ON dialogue_stop_dispatch
          BEGIN SELECT RAISE(ABORT, 'immutable stop identity'); END`);
        db.run(`CREATE TRIGGER dialogue_stop_dispatch_forward BEFORE UPDATE OF state ON dialogue_stop_dispatch WHEN NOT
          ((OLD.state='queued' AND NEW.state='attempted') OR (OLD.state='attempted' AND NEW.state IN ('requested','uncertain')))
          BEGIN SELECT RAISE(ABORT, 'retained stop attempt'); END`);
        db.run(`CREATE TRIGGER dialogue_stop_revoke AFTER INSERT ON dialogue_stop_requests BEGIN
          UPDATE owned_grants SET revoked=1 WHERE run_id IN (SELECT id FROM weaving_runs WHERE job_id=NEW.job_id);
        END`);
        db.run(`CREATE TRIGGER dialogue_stopped_grant BEFORE INSERT ON owned_grants WHEN EXISTS (
          SELECT 1 FROM dialogue_stop_requests s JOIN weaving_runs r ON r.job_id=s.job_id WHERE r.id=NEW.run_id
        ) BEGIN SELECT RAISE(ABORT, 'stopped dialogue grant'); END`);
        db.run(`CREATE TRIGGER dialogue_stopped_requeue BEFORE UPDATE OF status ON jobs WHEN NEW.status='queued' AND EXISTS (
          SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=NEW.id
        ) BEGIN SELECT RAISE(ABORT, 'stopped dialogue job'); END`);
        db.run(`CREATE TRIGGER dialogue_stopped_run BEFORE INSERT ON weaving_runs WHEN EXISTS (
          SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=NEW.job_id
        ) BEGIN SELECT RAISE(ABORT, 'stopped dialogue run'); END`);
        db.run(`CREATE TRIGGER dialogue_stop_immutable BEFORE UPDATE ON dialogue_stop_requests
          BEGIN SELECT RAISE(ABORT, 'immutable stop command'); END`);
        for (const table of ["dialogue_stop_requests", "dialogue_stop_dispatch"]) db.run(`CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
          BEGIN SELECT RAISE(ABORT, 'retained stop command'); END`);
        db.run("PRAGMA user_version = 14");
      }
      if (version && version.user_version < 15) {
        migrateFollowUpJobs(db);
        db.run(`CREATE TABLE follow_up_origins (
          run_id TEXT PRIMARY KEY NOT NULL REFERENCES weaving_runs(id), job_id TEXT NOT NULL REFERENCES jobs(id),
          turn_id TEXT NOT NULL UNIQUE REFERENCES dialogue_turns(id)
        )`);
        db.run("CREATE INDEX follow_up_origin_job ON follow_up_origins(job_id)");
        db.run(`CREATE TABLE follow_up_targets (
          origin_run_id TEXT NOT NULL REFERENCES follow_up_origins(run_id),
          item_id TEXT REFERENCES knowledge_items(id), formulation_id TEXT REFERENCES formulations(id),
          relationship_id TEXT REFERENCES relationships(id), revision_id TEXT REFERENCES relationship_revisions(id),
          CHECK((item_id IS NOT NULL AND formulation_id IS NOT NULL AND relationship_id IS NULL AND revision_id IS NULL)
            OR (item_id IS NULL AND formulation_id IS NULL AND relationship_id IS NOT NULL AND revision_id IS NOT NULL)),
          UNIQUE(origin_run_id,formulation_id), UNIQUE(origin_run_id,revision_id)
        )`);
        db.run(`CREATE TRIGGER follow_up_origin_scope BEFORE INSERT ON follow_up_origins WHEN NOT EXISTS (
          SELECT 1 FROM jobs target JOIN weaving_runs r ON r.id=NEW.run_id JOIN jobs origin ON origin.id=r.job_id
          JOIN dialogue_turns t ON t.job_id=origin.id JOIN dialogues d ON d.id=t.dialogue_id
          JOIN dialogue_outcomes o ON o.turn_id=t.id AND o.run_id=r.id
          WHERE target.id=NEW.job_id AND target.kind='follow_up' AND target.status='queued'
            AND origin.kind='dialogue' AND origin.status='completed' AND target.source_id=origin.source_id AND d.source_id=origin.source_id
            AND t.id=NEW.turn_id AND r.state='completed' AND r.outcome='succeeded' AND o.outcome='succeeded'
            AND NOT EXISTS (SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=origin.id)
            AND NOT EXISTS (SELECT 1 FROM weaving_runs claimed WHERE claimed.job_id=target.id)
        ) BEGIN SELECT RAISE(ABORT, 'invalid follow-up origin'); END`);
        db.run(`CREATE TRIGGER follow_up_target_scope BEFORE INSERT ON follow_up_targets WHEN NOT EXISTS (
          SELECT 1 FROM follow_up_origins o JOIN jobs j ON j.id=o.job_id WHERE o.run_id=NEW.origin_run_id
            AND j.kind='follow_up' AND j.status='queued' AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.job_id=j.id)
        ) OR (NEW.item_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM formulations f JOIN knowledge_items i ON i.id=f.item_id
          JOIN knowledge_receipts k ON k.operation_id=f.operation_id AND k.result_id=i.id AND k.revision_id=f.id
          JOIN follow_up_origins o ON o.run_id=f.run_id JOIN jobs j ON j.id=o.job_id
          WHERE o.run_id=NEW.origin_run_id AND f.id=NEW.formulation_id AND i.id=NEW.item_id AND f.author='ai' AND i.source_id=j.source_id
        )) OR (NEW.relationship_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM relationship_revisions v JOIN relationships rel ON rel.id=v.relationship_id
          JOIN knowledge_items a ON a.id=rel.from_item_id JOIN knowledge_items b ON b.id=rel.to_item_id
          JOIN knowledge_receipts k ON k.operation_id=v.operation_id AND k.result_id=rel.id AND k.revision_id=v.id
          JOIN follow_up_origins o ON o.run_id=v.run_id JOIN jobs j ON j.id=o.job_id
          WHERE o.run_id=NEW.origin_run_id AND v.id=NEW.revision_id AND rel.id=NEW.relationship_id AND v.author='ai'
            AND (a.source_id=j.source_id OR b.source_id=j.source_id)
        )) BEGIN SELECT RAISE(ABORT, 'invalid follow-up target'); END`);
        for (const table of ["follow_up_origins", "follow_up_targets"]) {
          db.run(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable follow-up input'); END`);
          db.run(`CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'retained follow-up input'); END`);
        }
        db.run("PRAGMA user_version = 15");
      }
      if (version && version.user_version < 16) {
        // v15 dialogue origins/targets remain byte-for-byte historical facts.
        // USER commands have receipt identity rather than a fictitious AI run.
        db.run(`CREATE TABLE follow_up_user_origins (
          job_id TEXT NOT NULL REFERENCES jobs(id), operation_id TEXT NOT NULL REFERENCES knowledge_receipts(operation_id),
          PRIMARY KEY(job_id,operation_id)
        )`);
        db.run(`CREATE TABLE follow_up_user_targets (
          job_id TEXT NOT NULL, operation_id TEXT NOT NULL,
          item_id TEXT REFERENCES knowledge_items(id), formulation_id TEXT REFERENCES formulations(id),
          relationship_id TEXT REFERENCES relationships(id), revision_id TEXT REFERENCES relationship_revisions(id),
          FOREIGN KEY(job_id,operation_id) REFERENCES follow_up_user_origins(job_id,operation_id),
          CHECK((item_id IS NOT NULL AND formulation_id IS NOT NULL AND relationship_id IS NULL AND revision_id IS NULL)
            OR (item_id IS NULL AND formulation_id IS NULL AND relationship_id IS NOT NULL AND revision_id IS NOT NULL)),
          UNIQUE(job_id,operation_id,formulation_id), UNIQUE(job_id,operation_id,revision_id)
        )`);
        db.run(`CREATE TABLE follow_up_inputs (
          job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id), payload TEXT NOT NULL, payload_hash TEXT NOT NULL
        )`);
        db.run(`CREATE TRIGGER follow_up_input_scope BEFORE INSERT ON follow_up_inputs WHEN NOT EXISTS (
          SELECT 1 FROM jobs j WHERE j.id=NEW.job_id AND j.kind='follow_up' AND j.status='queued'
            AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.job_id=j.id)
        ) BEGIN SELECT RAISE(ABORT, 'invalid follow-up freeze'); END`);
        db.run(`CREATE TRIGGER follow_up_user_origin_scope BEFORE INSERT ON follow_up_user_origins WHEN NOT EXISTS (
          SELECT 1 FROM jobs j JOIN knowledge_receipts k ON k.operation_id=NEW.operation_id
          WHERE j.id=NEW.job_id AND j.kind='follow_up' AND j.status='queued'
            AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.job_id=j.id)
            AND NOT EXISTS (SELECT 1 FROM follow_up_inputs frozen WHERE frozen.job_id=j.id)
            AND (EXISTS (SELECT 1 FROM formulations f JOIN knowledge_items i ON i.id=f.item_id
              WHERE f.id=k.revision_id AND i.id=k.result_id AND f.operation_id=k.operation_id AND f.author='user' AND i.source_id=j.source_id)
            OR EXISTS (SELECT 1 FROM relationship_revisions v JOIN relationships rel ON rel.id=v.relationship_id
              JOIN knowledge_items a ON a.id=rel.from_item_id JOIN knowledge_items b ON b.id=rel.to_item_id
              WHERE v.id=k.revision_id AND rel.id=k.result_id AND v.operation_id=k.operation_id AND v.author='user' AND (a.source_id=j.source_id OR b.source_id=j.source_id)))
        ) BEGIN SELECT RAISE(ABORT, 'invalid user follow-up origin'); END`);
        db.run(`CREATE TRIGGER follow_up_user_target_scope BEFORE INSERT ON follow_up_user_targets WHEN NOT EXISTS (
          SELECT 1 FROM follow_up_user_origins o JOIN jobs j ON j.id=o.job_id JOIN knowledge_receipts k ON k.operation_id=o.operation_id
          WHERE o.job_id=NEW.job_id AND o.operation_id=NEW.operation_id AND j.status='queued'
            AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.job_id=j.id)
            AND NOT EXISTS (SELECT 1 FROM follow_up_inputs frozen WHERE frozen.job_id=j.id)
            AND ((NEW.item_id IS NOT NULL AND EXISTS (SELECT 1 FROM formulations f JOIN knowledge_items i ON i.id=f.item_id
              WHERE f.id=NEW.formulation_id AND i.id=NEW.item_id AND f.id=k.revision_id AND i.id=k.result_id AND f.author='user' AND f.operation_id=k.operation_id AND i.source_id=j.source_id))
            OR (NEW.relationship_id IS NOT NULL AND EXISTS (SELECT 1 FROM relationship_revisions v JOIN relationships rel ON rel.id=v.relationship_id
              JOIN knowledge_items a ON a.id=rel.from_item_id JOIN knowledge_items b ON b.id=rel.to_item_id
              WHERE v.id=NEW.revision_id AND rel.id=NEW.relationship_id AND v.id=k.revision_id AND rel.id=k.result_id AND v.author='user' AND v.operation_id=k.operation_id AND (a.source_id=j.source_id OR b.source_id=j.source_id))))
        ) BEGIN SELECT RAISE(ABORT, 'invalid user follow-up target'); END`);
        for (const table of ["follow_up_origins", "follow_up_targets"]) {
          const column = table === "follow_up_origins" ? "NEW.job_id" : "(SELECT job_id FROM follow_up_origins WHERE run_id=NEW.origin_run_id)";
          db.run(`CREATE TRIGGER ${table}_frozen BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM follow_up_inputs WHERE job_id=${column})
            BEGIN SELECT RAISE(ABORT, 'frozen follow-up input'); END`);
        }
        db.run(`CREATE VIEW follow_up_origin_refs AS
          SELECT o.job_id,'dialogue' AS kind,o.run_id,t.dialogue_id,o.turn_id,t.source_id AS turn_source_id,NULL AS operation_id
          FROM follow_up_origins o JOIN dialogue_turns t ON t.id=o.turn_id
          UNION ALL SELECT job_id,'user',NULL,NULL,NULL,NULL,operation_id FROM follow_up_user_origins`);
        db.run(`CREATE VIEW follow_up_target_refs AS
          SELECT o.job_id,CASE WHEN t.item_id IS NOT NULL THEN 'item' ELSE 'relationship' END AS kind,
            COALESCE(t.item_id,t.relationship_id) AS id,COALESCE(t.formulation_id,t.revision_id) AS version_id
          FROM follow_up_targets t JOIN follow_up_origins o ON o.run_id=t.origin_run_id
          UNION SELECT job_id,CASE WHEN item_id IS NOT NULL THEN 'item' ELSE 'relationship' END,
            COALESCE(item_id,relationship_id),COALESCE(formulation_id,revision_id) FROM follow_up_user_targets`);
        db.run(`CREATE TABLE follow_up_retry_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL, id TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL REFERENCES sources(id), job_id TEXT NOT NULL REFERENCES jobs(id),
          expected_run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id)
        )`);
        db.run(`CREATE TRIGGER follow_up_retry_scope BEFORE INSERT ON follow_up_retry_receipts WHEN NOT EXISTS (
          SELECT 1 FROM jobs j JOIN weaving_runs r ON r.job_id=j.id WHERE j.id=NEW.job_id AND j.source_id=NEW.source_id
            AND j.kind='follow_up' AND r.id=NEW.expected_run_id
        ) BEGIN SELECT RAISE(ABORT, 'invalid follow-up retry'); END`);
        for (const table of ["follow_up_user_origins", "follow_up_user_targets", "follow_up_inputs", "follow_up_retry_receipts"]) {
          db.run(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable follow-up receipt'); END`);
          db.run(`CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'retained follow-up receipt'); END`);
        }
        db.run("PRAGMA user_version = 16");
      }
      if (version && version.user_version < 17) {
        migrateWeavingAbandonment(db);
        db.run("PRAGMA user_version = 17");
      }
      if (version && version.user_version < 18) {
        db.run("ALTER TABLE knowledge_items ADD COLUMN created_at TEXT");
        db.run("CREATE INDEX knowledge_created_at ON knowledge_items(created_at, id) WHERE created_at IS NOT NULL");
        db.run("CREATE INDEX sources_created_at ON sources(created_at DESC, id)");
        db.run(`CREATE TRIGGER knowledge_creation_time_immutable BEFORE UPDATE OF created_at ON knowledge_items
          BEGIN SELECT RAISE(ABORT, 'immutable item creation time'); END`);
        db.run("PRAGMA user_version = 18");
      }
      if (version && version.user_version < 19) {
        migrateTitles(db);
        db.run("PRAGMA user_version = 19");
      }
      if (migrating && db.query("PRAGMA foreign_key_check").get()) throw new Error("Database foreign key check failed");
    }).immediate();
    db.run("PRAGMA foreign_keys = ON");
    if (db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 1) throw new Error("Foreign keys unavailable");
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
      const receipt = db.query<{ payload_hash: string; source_id: string; response_version: number }, [string]>(
        "SELECT payload_hash, source_id,response_version FROM capture_receipts WHERE idempotency_key = ?",
      ).get(key);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) return { kind: "conflict" };
        const source = db.query<Source, [string]>(
          "SELECT id, text, provenance, created_at AS createdAt FROM sources WHERE id = ?",
        ).get(receipt.source_id);
        if (!source) throw new Error("Capture receipt references a missing source");
        return { kind: "replayed", source: receipt.response_version === 1 ? source : { ...source, origin: sourceOrigin(db, source.id) } };
      }
      const source: Source = {
        id: crypto.randomUUID(),
        text: input.text,
        provenance: input.provenance,
        createdAt: new Date().toISOString(),
        origin: { kind: "capture" },
      };
      db.run("INSERT INTO sources (id, text, provenance, created_at) VALUES (?, ?, ?, ?)",
        [source.id, source.text, source.provenance, source.createdAt]);
      db.run("INSERT INTO source_search (source_id, text) VALUES (?, ?)", [source.id, source.text]);
      db.run("INSERT INTO jobs (id, source_id, status) VALUES (?, ?, ?)",
        [crypto.randomUUID(), source.id, "queued"]);
      db.run("INSERT INTO capture_receipts (idempotency_key, payload_hash, source_id,response_version) VALUES (?, ?, ?,2)",
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
    return db.transaction(() => {
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
    type TitleRow = SourceRow & { itemId: string | null; kind: "interpretation" | "developing-idea" | null; formulationId: string | null; formulationText: string | null; author: "user" | "ai" | null; titleRevisionId: string; titleText: string; titleAuthor: "user" | "ai" };
    const titleStatement = db.query<TitleRow, [string, number]>(`SELECT s.id AS sourceId,s.text,s.provenance,s.created_at AS createdAt,
      i.id AS itemId,i.kind,f.id AS formulationId,f.text AS formulationText,f.author,
      r.id AS titleRevisionId,r.text AS titleText,r.author AS titleAuthor
      FROM title_search JOIN title_entities e ON e.id=title_search.entity_id
      JOIN title_heads h ON h.entity_id=e.id JOIN title_revisions r ON r.id=COALESCE(h.user_revision_id,h.revision_id)
      LEFT JOIN knowledge_items i ON i.id=e.item_id
      LEFT JOIN formulations f ON f.rowid=(SELECT MAX(f2.rowid) FROM formulations f2 WHERE f2.item_id=i.id)
      JOIN sources s ON s.id=COALESCE(e.source_id,i.source_id)
      WHERE title_search MATCH ? AND (r.author='user' OR i.id IS NULL OR r.formulation_id=f.id)
      ORDER BY bm25(title_search),e.id LIMIT ?`);
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
      for (const row of titleStatement.all(expression, limits.results)) {
        const key = row.itemId ? `item:${row.itemId}` : `source:${row.sourceId}`;
        if (seen.has(key) || results.length >= limits.results) continue;
        if (row.itemId && (!row.kind || !row.formulationId || !row.formulationText || !row.author)) continue;
        seen.add(key);
        results.push({ sourceId: row.sourceId, matchOrigin: "title", title: { revisionId: row.titleRevisionId, text: row.titleText, author: row.titleAuthor }, source: { excerpt: row.text.slice(0, 240), provenance: row.provenance, createdAt: row.createdAt },
          ...(row.itemId && row.kind && row.formulationId && row.formulationText && row.author ? { item: { id: row.itemId, kind: row.kind, formulationId: row.formulationId, text: row.formulationText, author: row.author } } : {}) });
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
      const candidates = db.query<{ term: string }, [string, string, number, number, string, string, number, number, string, string, number, number, number]>(
        `SELECT term FROM source_vocabulary WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?
         UNION SELECT term FROM formulation_vocabulary WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?
         UNION SELECT term FROM title_vocabulary WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ? LIMIT ?`,
      ).all(word[0] ?? "", `${word[0]}\uffff`, word.length - 1, word.length + 1, word[0] ?? "", `${word[0]}\uffff`, word.length - 1, word.length + 1, word[0] ?? "", `${word[0]}\uffff`, word.length - 1, word.length + 1, limits.typoCandidates);
      for (const { term } of candidates) if (oneEditAway(word, term)) add([term], false, false);
    }
    return results.map((result) => {
      const title = readTitle(db, result.sourceId, result.item?.id, result.item?.formulationId).title;
      return { ...result, ...(title ? { title } : {}), source: { ...result.source, origin: sourceOrigin(db, result.sourceId) } };
    });
    }).deferred();
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
      opened.run("DELETE FROM title_search");
      opened.run(`INSERT INTO title_search(entity_id,text) SELECT h.entity_id,r.text FROM title_heads h JOIN title_revisions r ON r.id=COALESCE(h.user_revision_id,h.revision_id)`);
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
    return sourceRecord(db, id);
  } finally {
    db.close();
  }
}

// Origin is authoritative relational context, never inferred from a client-set
// provenance label. Legacy capture receipts retain their earlier wire shape.
export function sourceOrigin(db: Database, id: string): SourceOrigin {
  const turn = db.query<{ dialogueId: string; turnId: string; rootSourceId: string }, [string]>(`SELECT t.dialogue_id AS dialogueId,t.id AS turnId,d.source_id AS rootSourceId
    FROM dialogue_turns t JOIN dialogues d ON d.id=t.dialogue_id WHERE t.source_id=?`).get(id);
  const origin = parseSourceOrigin(turn ? { kind: "discussion-turn", ...turn } : { kind: "capture" });
  if (!origin) throw new Error("Invalid source origin");
  return origin;
}
export function sourceRecord(db: Database, id: string): Source | null {
  const row = db.query<Source, [string]>("SELECT id,text,provenance,created_at AS createdAt FROM sources WHERE id=?").get(id);
  if (!row) return null;
  const origin = sourceOrigin(db, id);
  const legacy = origin.kind === "capture" && db.query<{ version: number }, [string]>("SELECT response_version AS version FROM capture_receipts WHERE source_id=?").get(id)?.version === 1;
  const title = readTitle(db, id).title;
  const source = parseSourceRecord({ ...row, ...(legacy ? {} : { origin }), ...(title ? { title } : {}) });
  if (!source) throw new Error("Invalid source record");
  return source;
}
