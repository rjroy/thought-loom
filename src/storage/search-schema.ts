import type { Database } from "bun:sqlite";

/** Separate session/control persistence. No search content enters the library or its FTS tables. */
export function createSearchSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_sessions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      create_request_key TEXT UNIQUE NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      deleted_at TEXT,
      CHECK ((deleted_at IS NULL AND title IS NOT NULL AND length(title)>0)
        OR (deleted_at IS NOT NULL AND title IS NULL))
    );
    CREATE INDEX IF NOT EXISTS search_sessions_activity
      ON search_sessions(last_activity_at DESC,sequence DESC) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS search_turns (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES search_sessions(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      request_key TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      effort TEXT NOT NULL CHECK (effort IN ('quick','standard','thorough')),
      context_mode TEXT NOT NULL CHECK (context_mode IN ('continue','restart')),
      intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
      open_slot INTEGER NOT NULL DEFAULT 1 CHECK (open_slot IN (0,1)),
      outcome_reason TEXT,
      UNIQUE(session_id,position), UNIQUE(session_id,request_key), UNIQUE(session_id,run_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS search_turns_one_active ON search_turns(session_id) WHERE open_slot=1;
    CREATE TABLE IF NOT EXISTS search_messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      text TEXT NOT NULL CHECK (length(text)>0),
      created_at TEXT NOT NULL,
      disposition TEXT CHECK (disposition IN ('awaiting-user','done')),
      evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
      FOREIGN KEY(session_id,run_id) REFERENCES search_turns(session_id,run_id) ON DELETE CASCADE,
      UNIQUE(session_id,position), UNIQUE(run_id,role), UNIQUE(session_id,id),
      CHECK ((role='user' AND disposition IS NULL) OR (role='assistant' AND disposition IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS search_discoveries (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      thought_id TEXT NOT NULL REFERENCES thoughts(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      why TEXT NOT NULL CHECK (length(why)>0),
      evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
      added_run_id TEXT NOT NULL,
      added_prompt_id TEXT NOT NULL REFERENCES run_steps(prompt_id),
      added_at TEXT NOT NULL,
      removed_at TEXT,
      FOREIGN KEY(session_id,added_run_id) REFERENCES search_turns(session_id,run_id) ON DELETE CASCADE,
      UNIQUE(added_prompt_id), UNIQUE(session_id,position), UNIQUE(session_id,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS search_discoveries_one_unremoved
      ON search_discoveries(session_id,thought_id) WHERE removed_at IS NULL;
    CREATE INDEX IF NOT EXISTS search_discoveries_visible
      ON search_discoveries(session_id,position) WHERE removed_at IS NULL;
    CREATE TABLE IF NOT EXISTS search_content_dependencies (
      sequence INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES search_sessions(id),
      message_id TEXT,
      discovery_id TEXT,
      ref_kind TEXT NOT NULL CHECK (ref_kind IN ('thought','connection','response')),
      ref_id TEXT NOT NULL,
      FOREIGN KEY(session_id,message_id) REFERENCES search_messages(session_id,id) ON DELETE CASCADE,
      FOREIGN KEY(session_id,discovery_id) REFERENCES search_discoveries(session_id,id) ON DELETE CASCADE,
      CHECK ((message_id IS NULL) != (discovery_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS search_message_dependency
      ON search_content_dependencies(message_id,ref_kind,ref_id) WHERE message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS search_discovery_dependency
      ON search_content_dependencies(discovery_id,ref_kind,ref_id) WHERE discovery_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS search_dependency_reverse
      ON search_content_dependencies(ref_kind,ref_id,session_id);
    CREATE TABLE IF NOT EXISTS search_composer_contexts (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES search_sessions(id),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      state TEXT NOT NULL CHECK (state IN ('active','consumed','invalidated','discarded')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_composer_session ON search_composer_contexts(session_id);
    CREATE TABLE IF NOT EXISTS search_composer_dependencies (
      composer_id TEXT NOT NULL REFERENCES search_composer_contexts(id) ON DELETE CASCADE,
      ref_kind TEXT NOT NULL CHECK (ref_kind IN ('thought','connection','response')),
      ref_id TEXT NOT NULL,
      PRIMARY KEY(composer_id,ref_kind,ref_id)
    );
    CREATE INDEX IF NOT EXISTS search_composer_dependency_reverse
      ON search_composer_dependencies(ref_kind,ref_id,composer_id);
    CREATE TABLE IF NOT EXISTS search_revisions (
      id INTEGER PRIMARY KEY CHECK (id=1),
      eligibility INTEGER NOT NULL CHECK (eligibility >= 0),
      retrieval INTEGER NOT NULL CHECK (retrieval >= 0),
      catalog INTEGER NOT NULL CHECK (catalog >= 0)
    );
    INSERT OR IGNORE INTO search_revisions(id,eligibility,retrieval,catalog) VALUES (1,0,0,0);
    ${sessionGuards()}
    ${contentGuards()}
    ${composerGuards()}
    ${revisionGuards()}
    ${executionGuards()}
  `);
}

const activeStatuses = "'queued','submitting','running','uncertain'";

/** All execution purge exceptions use the retained owner mapping, never only a caller's session ID. */
function purgeRun(runId: string): string {
  return `EXISTS (SELECT 1 FROM runs purge_run JOIN search_turns purge_turn ON purge_turn.run_id=purge_run.id
    JOIN search_sessions purge_session ON purge_session.id=purge_turn.session_id
    WHERE purge_run.id=${runId} AND purge_run.kind='search' AND purge_session.deleted_at IS NOT NULL)`;
}

function liveRun(runId: string): string {
  return `EXISTS (SELECT 1 FROM runs r JOIN search_turns t ON t.run_id=r.id
    JOIN search_sessions s ON s.id=t.session_id
    WHERE r.id=${runId} AND r.kind='search' AND s.deleted_at IS NULL)`;
}

function immutableFields(table: string, fields: string): string {
  return `CREATE TRIGGER IF NOT EXISTS ${table}_identity_immutable BEFORE UPDATE OF rowid,_rowid_,oid,${fields} ON ${table}
    BEGIN SELECT RAISE(ABORT,'search record immutable'); END;`;
}

function noReplace(table: string, conflict: string): string {
  return `CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
    WHEN EXISTS (SELECT 1 FROM ${table} WHERE rowid=NEW.rowid OR (${conflict}))
    BEGIN SELECT RAISE(ABORT,'search record cannot be replaced'); END;`;
}

function sessionGuards(): string {
  return `
    ${immutableFields("search_sessions", "sequence,id,create_request_key,created_at")}
    ${noReplace("search_sessions", "id=NEW.id OR create_request_key=NEW.create_request_key")}
    CREATE TRIGGER IF NOT EXISTS search_sessions_live_insert BEFORE INSERT ON search_sessions
    WHEN NEW.deleted_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'new search session must be live'); END;
    CREATE TRIGGER IF NOT EXISTS search_sessions_tombstone_immutable BEFORE UPDATE ON search_sessions
    WHEN OLD.deleted_at IS NOT NULL OR NEW.revision<OLD.revision
    BEGIN SELECT RAISE(ABORT,'search tombstone and revision are durable'); END;
    CREATE TRIGGER IF NOT EXISTS search_sessions_immutable_delete BEFORE DELETE ON search_sessions
    BEGIN SELECT RAISE(ABORT,'search session tombstone must be retained'); END;
    ${immutableFields("search_turns", "run_id,session_id,position,request_key,admitted_at,effort,context_mode,intent_json")}
    ${noReplace("search_turns", "run_id=NEW.run_id OR (session_id=NEW.session_id AND (position=NEW.position OR request_key=NEW.request_key))")}
    CREATE TRIGGER IF NOT EXISTS search_turns_owner BEFORE INSERT ON search_turns
    WHEN NOT EXISTS (SELECT 1 FROM runs r JOIN search_sessions s ON s.id=NEW.session_id
      WHERE r.id=NEW.run_id AND r.kind='search' AND r.input_thought_id IS NULL
        AND r.weave_subject_id IS NULL AND r.weave_trigger_id IS NULL AND s.deleted_at IS NULL
        AND NEW.open_slot=(r.status IN (${activeStatuses})))
      OR NEW.position!=COALESCE((SELECT MAX(position)+1 FROM search_turns WHERE session_id=NEW.session_id),0)
    BEGIN SELECT RAISE(ABORT,'search turn requires its live search owner and ordered slot'); END;
    CREATE TRIGGER IF NOT EXISTS search_turns_slot_durable BEFORE UPDATE OF open_slot ON search_turns
    WHEN (OLD.open_slot=0 AND NEW.open_slot!=0)
      OR NEW.open_slot IS NOT (SELECT status IN (${activeStatuses}) FROM runs WHERE id=OLD.run_id)
    BEGIN SELECT RAISE(ABORT,'search turn slot must follow its run'); END;
    CREATE TRIGGER IF NOT EXISTS search_turns_outcome_durable BEFORE UPDATE OF outcome_reason ON search_turns
    WHEN OLD.outcome_reason IS NOT NULL AND NEW.outcome_reason IS NOT OLD.outcome_reason
    BEGIN SELECT RAISE(ABORT,'search turn outcome immutable'); END;
    CREATE TRIGGER IF NOT EXISTS search_turns_purge BEFORE DELETE ON search_turns
    -- Only the immediate runs FK cascade may remove this final ownership proof.
    -- The parent BEFORE DELETE guard has already checked kind, mapping and tombstone.
    -- A direct turn delete while its run exists would strand/rebind its execution rows.
    WHEN EXISTS (SELECT 1 FROM runs WHERE id=OLD.run_id)
      OR NOT EXISTS (SELECT 1 FROM search_sessions WHERE id=OLD.session_id AND deleted_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM search_messages WHERE run_id=OLD.run_id)
      OR EXISTS (SELECT 1 FROM search_discoveries WHERE added_run_id=OLD.run_id)
    BEGIN SELECT RAISE(ABORT,'search turn purge requires its tombstone and empty content'); END;
    CREATE TRIGGER IF NOT EXISTS search_run_terminal_slot AFTER UPDATE OF status ON runs
    WHEN NEW.kind='search' AND NEW.status NOT IN (${activeStatuses})
    BEGIN UPDATE search_turns SET open_slot=0 WHERE run_id=NEW.id AND open_slot=1; END;
    CREATE TRIGGER IF NOT EXISTS search_run_terminal_durable BEFORE UPDATE OF status ON runs
    WHEN OLD.kind='search' AND OLD.status NOT IN (${activeStatuses}) AND NEW.status IN (${activeStatuses})
    BEGIN SELECT RAISE(ABORT,'terminal search run cannot reopen'); END;
  `;
}

function contentGuards(): string {
  return `
    ${immutableFields("search_messages", "id,session_id,run_id,position,role,text,created_at,disposition,evidence_json")}
    ${noReplace("search_messages", "id=NEW.id OR (session_id=NEW.session_id AND position=NEW.position) OR (run_id=NEW.run_id AND role=NEW.role)")}
    CREATE TRIGGER IF NOT EXISTS search_messages_live_insert BEFORE INSERT ON search_messages
    WHEN NOT ${liveRun("NEW.run_id")}
      OR NEW.position!=COALESCE((SELECT MAX(position)+1 FROM search_messages WHERE session_id=NEW.session_id),0)
    BEGIN SELECT RAISE(ABORT,'search message requires a live owner'); END;
    CREATE TRIGGER IF NOT EXISTS search_messages_purge BEFORE DELETE ON search_messages
    WHEN NOT ${purgeRun("OLD.run_id")}
      OR EXISTS (SELECT 1 FROM search_content_dependencies WHERE message_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'search message purge requires its tombstone and removed dependencies'); END;
    ${immutableFields("search_discoveries", "id,session_id,thought_id,position,why,evidence_json,added_run_id,added_prompt_id,added_at")}
    ${noReplace("search_discoveries", "id=NEW.id OR added_prompt_id=NEW.added_prompt_id OR (session_id=NEW.session_id AND position=NEW.position)")}
    CREATE TRIGGER IF NOT EXISTS search_discoveries_owner BEFORE INSERT ON search_discoveries
    WHEN NEW.removed_at IS NOT NULL OR NOT ${liveRun("NEW.added_run_id")}
      OR NOT EXISTS (SELECT 1 FROM run_steps p WHERE p.run_id=NEW.added_run_id AND p.prompt_id=NEW.added_prompt_id
        AND p.state IN ('completed','processed') AND json_extract(p.envelope_json,'$.kind')='request'
        AND json_extract(p.envelope_json,'$.request.capability')='addDiscovery'
        AND json_extract(p.envelope_json,'$.request.arguments.thoughtId')=NEW.thought_id
        AND json_extract(p.envelope_json,'$.request.arguments.why')=NEW.why
        AND json(json_extract(p.envelope_json,'$.request.arguments.evidenceThoughtIds'))=json(NEW.evidence_json)
        AND json_extract(p.result_json,'$.type')='discovery-add'
        AND json_extract(p.result_json,'$.outcome')='added'
        AND json_extract(p.result_json,'$.entryId')=NEW.id)
      OR NEW.position!=COALESCE((SELECT MAX(position)+1 FROM search_discoveries WHERE session_id=NEW.session_id),0)
    BEGIN SELECT RAISE(ABORT,'search discovery requires its completed owning add receipt'); END;
    CREATE TRIGGER IF NOT EXISTS search_discoveries_removal_durable BEFORE UPDATE OF removed_at ON search_discoveries
    WHEN OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NOT ${liveRun("OLD.added_run_id")}
    BEGIN SELECT RAISE(ABORT,'search discovery removal is write-once'); END;
    CREATE TRIGGER IF NOT EXISTS search_discoveries_purge BEFORE DELETE ON search_discoveries
    WHEN NOT ${purgeRun("OLD.added_run_id")}
      OR EXISTS (SELECT 1 FROM search_content_dependencies WHERE discovery_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'search discovery purge requires its tombstone and removed dependencies'); END;
    ${immutableFields("search_content_dependencies", "sequence,session_id,message_id,discovery_id,ref_kind,ref_id")}
    ${noReplace("search_content_dependencies", "0")}
    CREATE TRIGGER IF NOT EXISTS search_content_dependencies_live_insert BEFORE INSERT ON search_content_dependencies
    WHEN NOT EXISTS (SELECT 1 FROM search_sessions WHERE id=NEW.session_id AND deleted_at IS NULL)
    BEGIN SELECT RAISE(ABORT,'search dependency requires a live owner'); END;
    CREATE TRIGGER IF NOT EXISTS search_content_dependencies_purge BEFORE DELETE ON search_content_dependencies
    WHEN NOT EXISTS (SELECT 1 FROM search_messages m WHERE m.id=OLD.message_id AND m.session_id=OLD.session_id AND ${purgeRun("m.run_id")})
      AND NOT EXISTS (SELECT 1 FROM search_discoveries d WHERE d.id=OLD.discovery_id AND d.session_id=OLD.session_id AND ${purgeRun("d.added_run_id")})
    BEGIN SELECT RAISE(ABORT,'search dependency purge requires its retained tombstoned owner'); END;
  `;
}

function composerGuards(): string {
  return `
    ${immutableFields("search_composer_contexts", "id,session_id,created_at")}
    ${noReplace("search_composer_contexts", "id=NEW.id")}
    CREATE TRIGGER IF NOT EXISTS search_composer_contexts_live_insert BEFORE INSERT ON search_composer_contexts
    WHEN NEW.state!='active' OR NEW.revision!=0
      OR NOT EXISTS (SELECT 1 FROM search_sessions WHERE id=NEW.session_id AND deleted_at IS NULL)
    BEGIN SELECT RAISE(ABORT,'new search composer requires a live blank context'); END;
    CREATE TRIGGER IF NOT EXISTS search_composer_contexts_transition BEFORE UPDATE OF state,revision ON search_composer_contexts
    WHEN NEW.revision<OLD.revision OR (OLD.state!='active' AND (NEW.state IS NOT OLD.state OR NEW.revision!=OLD.revision))
      OR (NEW.state='active' AND NOT EXISTS (SELECT 1 FROM search_sessions WHERE id=OLD.session_id AND deleted_at IS NULL))
    BEGIN SELECT RAISE(ABORT,'search composer cannot reset'); END;
    CREATE TRIGGER IF NOT EXISTS search_composer_contexts_purge BEFORE DELETE ON search_composer_contexts
    WHEN NOT EXISTS (SELECT 1 FROM search_sessions WHERE id=OLD.session_id AND deleted_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM search_composer_dependencies WHERE composer_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'search composer purge requires its tombstone and removed dependencies'); END;
    ${immutableFields("search_composer_dependencies", "composer_id,ref_kind,ref_id")}
    CREATE TRIGGER IF NOT EXISTS search_composer_dependencies_active_insert BEFORE INSERT ON search_composer_dependencies
    WHEN NOT EXISTS (SELECT 1 FROM search_composer_contexts c JOIN search_sessions s ON s.id=c.session_id
      WHERE c.id=NEW.composer_id AND c.state='active' AND s.deleted_at IS NULL)
    BEGIN SELECT RAISE(ABORT,'search composer dependencies require an active context'); END;
    CREATE TRIGGER IF NOT EXISTS search_composer_dependencies_durable BEFORE DELETE ON search_composer_dependencies
    WHEN NOT EXISTS (SELECT 1 FROM search_composer_contexts c JOIN search_sessions s ON s.id=c.session_id
      WHERE c.id=OLD.composer_id AND (c.state IN ('consumed','discarded') OR s.deleted_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'active search composer coverage cannot shrink'); END;
  `;
}

function revisionGuards(): string {
  return `
    ${immutableFields("search_revisions", "id")}
    CREATE TRIGGER IF NOT EXISTS search_revisions_monotonic BEFORE UPDATE ON search_revisions
    WHEN NEW.eligibility<OLD.eligibility OR NEW.retrieval<OLD.retrieval OR NEW.catalog<OLD.catalog
    BEGIN SELECT RAISE(ABORT,'search revisions cannot regress'); END;
    CREATE TRIGGER IF NOT EXISTS search_revisions_immutable_delete BEFORE DELETE ON search_revisions
    BEGIN SELECT RAISE(ABORT,'search revisions cannot reset'); END;
  `;
}

function noSearchExecutionReplace(table: string, conflict: string): string {
  return `CREATE TRIGGER IF NOT EXISTS search_${table}_no_replace BEFORE INSERT ON ${table}
    WHEN EXISTS (SELECT 1 FROM ${table} e JOIN runs r ON r.id=e.run_id WHERE r.kind='search'
      AND (e.rowid=NEW.rowid OR (${conflict})))
    BEGIN SELECT RAISE(ABORT,'search execution cannot be replaced'); END;`;
}

function executionGuards(): string {
  // These are the only existing immutable-delete definitions changed by search persistence.
  const deletes = [
    ["run_steps_immutable_delete", "run_steps", "step immutable"],
    ["run_context_immutable_delete", "run_context", "exposed context immutable"],
    ["agent_bindings_immutable_delete", "agent_bindings", "agent binding immutable"],
    ["run_receipts_immutable_delete", "run_operation_receipts", "receipt immutable"],
    ["run_issued_immutable_delete", "run_issued_thoughts", "issued membership immutable"],
  ].map(([name, table, message]) => `DROP TRIGGER IF EXISTS ${name};
    CREATE TRIGGER ${name} BEFORE DELETE ON ${table} WHEN NOT ${purgeRun("OLD.run_id")}
    BEGIN SELECT RAISE(ABORT,'${message}'); END;`).join("\n");
  return `
    ${deletes}
    DROP TRIGGER IF EXISTS runs_immutable_delete;
    CREATE TRIGGER runs_immutable_delete BEFORE DELETE ON runs BEGIN
      SELECT CASE WHEN NOT ${purgeRun("OLD.id")} THEN RAISE(ABORT,'run immutable') END;
    END;
    CREATE TRIGGER IF NOT EXISTS search_runs_no_replace BEFORE INSERT ON runs
    WHEN EXISTS (SELECT 1 FROM runs WHERE kind='search' AND
      (rowid=NEW.rowid OR id=NEW.id OR session_id=NEW.session_id OR prompt_id=NEW.prompt_id))
    BEGIN SELECT RAISE(ABORT,'search execution cannot be replaced'); END;
    CREATE TRIGGER IF NOT EXISTS search_runs_live_status BEFORE UPDATE OF status ON runs
    WHEN OLD.kind='search' AND NEW.status IN (${activeStatuses}) AND NOT ${liveRun("OLD.id")}
    BEGIN SELECT RAISE(ABORT,'search execution requires a live owner'); END;
    CREATE TRIGGER IF NOT EXISTS search_steps_no_replace BEFORE INSERT ON run_steps
    WHEN EXISTS (SELECT 1 FROM run_steps p JOIN runs r ON r.id=p.run_id WHERE r.kind='search'
      AND (p.rowid=NEW.rowid OR (p.run_id=NEW.run_id AND p.position=NEW.position) OR p.prompt_id=NEW.prompt_id))
    BEGIN SELECT RAISE(ABORT,'search step cannot be replaced'); END;
    CREATE TRIGGER IF NOT EXISTS search_steps_live_insert BEFORE INSERT ON run_steps
    WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='search'
      AND ((NEW.position>0 AND NOT ${liveRun("NEW.run_id")}) OR ${purgeRun("NEW.run_id")})
    BEGIN SELECT RAISE(ABORT,'search step requires a live owner'); END;
    CREATE TRIGGER IF NOT EXISTS search_steps_live_update BEFORE UPDATE ON run_steps
    WHEN (SELECT kind FROM runs WHERE id=OLD.run_id)='search' AND NOT ${liveRun("OLD.run_id")}
    BEGIN SELECT RAISE(ABORT,'search step requires a live owner'); END;
    CREATE TRIGGER IF NOT EXISTS search_submit_owner_insert BEFORE INSERT ON run_steps
    WHEN NEW.submit_owner IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'submission owner requires existing search authorization'); END;
    CREATE TRIGGER IF NOT EXISTS search_submit_owner_once BEFORE UPDATE OF submit_owner ON run_steps
    WHEN OLD.submit_owner IS NOT NULL OR NEW.submit_owner IS NULL OR length(NEW.submit_owner)=0
      OR OLD.state!='prepared' OR NEW.state!='submitting' OR NEW.input IS NULL OR NEW.native_state!='unknown'
      OR NOT ${liveRun("OLD.run_id")} OR NOT EXISTS (SELECT 1 FROM agent_bindings WHERE run_id=OLD.run_id)
    BEGIN SELECT RAISE(ABORT,'submission owner is assigned once with search authorization'); END;
    ${noSearchExecutionReplace("run_context", "e.run_id=NEW.run_id AND e.kind=NEW.kind AND e.ref_id=NEW.ref_id")}
    ${noSearchExecutionReplace("agent_bindings", "e.run_id=NEW.run_id OR e.session_id=NEW.session_id")}
    ${noSearchExecutionReplace("run_operation_receipts", "e.run_id=NEW.run_id AND e.operation_id=NEW.operation_id")}
    ${noSearchExecutionReplace("run_issued_thoughts", "e.run_id=NEW.run_id AND (e.position=NEW.position OR e.operation_id=NEW.operation_id OR e.thought_id=NEW.thought_id)")}
    CREATE TRIGGER IF NOT EXISTS search_context_live_insert BEFORE INSERT ON run_context
    WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='search' AND NOT ${liveRun("NEW.run_id")}
    BEGIN SELECT RAISE(ABORT,'search context requires a live owner'); END;
    CREATE TRIGGER IF NOT EXISTS search_context_live_update BEFORE UPDATE ON run_context
    WHEN (SELECT kind FROM runs WHERE id=OLD.run_id)='search' AND NOT ${liveRun("OLD.run_id")}
    BEGIN SELECT RAISE(ABORT,'search context requires a live owner'); END;
    CREATE TRIGGER IF NOT EXISTS search_bindings_live_insert BEFORE INSERT ON agent_bindings
    WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='search' AND NOT ${liveRun("NEW.run_id")}
    BEGIN SELECT RAISE(ABORT,'search binding requires a live owner'); END;
    CREATE TRIGGER IF NOT EXISTS search_no_knowledge_receipts BEFORE INSERT ON run_operation_receipts
    WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='search'
    BEGIN SELECT RAISE(ABORT,'search cannot issue knowledge receipts'); END;
    CREATE TRIGGER IF NOT EXISTS search_no_issued_thoughts BEFORE INSERT ON run_issued_thoughts
    WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='search'
    BEGIN SELECT RAISE(ABORT,'search cannot issue thoughts'); END;
    CREATE TRIGGER IF NOT EXISTS search_no_library_reply_insert BEFORE INSERT ON run_replies
    WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='search'
    BEGIN SELECT RAISE(ABORT,'search cannot retain library replies'); END;
    CREATE TRIGGER IF NOT EXISTS search_no_library_reply_update BEFORE UPDATE ON run_replies
    WHEN EXISTS (SELECT 1 FROM runs WHERE id IN (OLD.run_id,NEW.run_id) AND kind='search')
    BEGIN SELECT RAISE(ABORT,'search cannot retain library replies'); END;
  `;
}
