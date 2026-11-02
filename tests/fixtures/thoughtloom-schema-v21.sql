-- Frozen schema 21 captured from the pre-FTS-restoration migration, without data.
PRAGMA foreign_keys=OFF;
CREATE TABLE sources (
          id TEXT PRIMARY KEY NOT NULL,
          text TEXT NOT NULL,
          provenance TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
CREATE TABLE capture_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL,
          payload_hash TEXT NOT NULL,
          source_id TEXT NOT NULL UNIQUE REFERENCES sources(id)
        , response_version INTEGER NOT NULL DEFAULT 1 CHECK(response_version IN (1,2)));
CREATE TRIGGER sources_immutable_update BEFORE UPDATE ON sources BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER sources_immutable_delete BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TABLE knowledge_items (
          id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('interpretation', 'developing-idea')),
          source_id TEXT NOT NULL REFERENCES sources(id)
        , created_at TEXT);
CREATE TABLE formulations (
          id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES knowledge_items(id), text TEXT NOT NULL,
          author TEXT NOT NULL CHECK(author IN ('user', 'ai')), operation_id TEXT NOT NULL, run_id TEXT,
          restored_from TEXT REFERENCES formulations(id)
        );
CREATE TABLE formulation_evidence (
          formulation_id TEXT NOT NULL REFERENCES formulations(id), source_id TEXT NOT NULL REFERENCES sources(id),
          position INTEGER NOT NULL, PRIMARY KEY(formulation_id, position), UNIQUE(formulation_id, source_id)
        );
CREATE TABLE relationships (
          id TEXT PRIMARY KEY NOT NULL, from_item_id TEXT NOT NULL REFERENCES knowledge_items(id),
          to_item_id TEXT NOT NULL REFERENCES knowledge_items(id), type TEXT NOT NULL CHECK(type IN ('supports','challenges','suggests')),
          CHECK(from_item_id <> to_item_id)
        );
CREATE TABLE relationship_revisions (
          id TEXT PRIMARY KEY NOT NULL, relationship_id TEXT NOT NULL REFERENCES relationships(id),
          status TEXT NOT NULL CHECK(status IN ('active', 'rejected')), rationale TEXT NOT NULL,
          author TEXT NOT NULL CHECK(author IN ('user', 'ai')), operation_id TEXT NOT NULL, run_id TEXT,
          restored_from TEXT REFERENCES relationship_revisions(id)
        );
CREATE TABLE relationship_evidence (
          revision_id TEXT NOT NULL REFERENCES relationship_revisions(id), source_id TEXT NOT NULL REFERENCES sources(id),
          position INTEGER NOT NULL, PRIMARY KEY(revision_id, position), UNIQUE(revision_id, source_id)
        );
CREATE TRIGGER formulations_immutable_update BEFORE UPDATE ON formulations BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TRIGGER formulations_immutable_delete BEFORE DELETE ON formulations BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TRIGGER formulation_evidence_immutable_update BEFORE UPDATE ON formulation_evidence BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TRIGGER formulation_evidence_immutable_delete BEFORE DELETE ON formulation_evidence BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TRIGGER relationship_revisions_immutable_update BEFORE UPDATE ON relationship_revisions BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TRIGGER relationship_revisions_immutable_delete BEFORE DELETE ON relationship_revisions BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TRIGGER relationship_evidence_immutable_update BEFORE UPDATE ON relationship_evidence BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TRIGGER relationship_evidence_immutable_delete BEFORE DELETE ON relationship_evidence BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TABLE knowledge_receipts (
          operation_id TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
          result_id TEXT NOT NULL, revision_id TEXT
        );
CREATE TABLE search_aliases (
          id TEXT PRIMARY KEY NOT NULL, alias TEXT NOT NULL, expansion TEXT NOT NULL,
          author TEXT NOT NULL CHECK(author IN ('user','ai')), operation_id TEXT NOT NULL, run_id TEXT
        );
CREATE TABLE alias_evidence (
          alias_id TEXT NOT NULL REFERENCES search_aliases(id), source_id TEXT NOT NULL REFERENCES sources(id),
          position INTEGER NOT NULL, PRIMARY KEY(alias_id, position), UNIQUE(alias_id, source_id)
        );
CREATE INDEX knowledge_source ON knowledge_items(source_id);
CREATE INDEX relationship_from ON relationships(from_item_id);
CREATE INDEX relationship_to ON relationships(to_item_id);
CREATE INDEX formulation_item ON formulations(item_id);
CREATE INDEX relationship_revision_parent ON relationship_revisions(relationship_id);
CREATE UNIQUE INDEX relationship_claim_identity ON relationships(from_item_id, to_item_id, type);
CREATE TABLE weaving_runs (
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
          last_error TEXT CHECK(last_error IN ('preparation_failed','admission_unknown','inspection_failed','invalid_adapter_result')), outcome TEXT CHECK(outcome IN ('succeeded','failed','interrupted')),
          UNIQUE(job_id, attempt),
          CHECK((lease_owner IS NULL) = (lease_until IS NULL)),
          CHECK((state = 'completed') = (recorded_changes IS NOT NULL))
        );
CREATE INDEX weaving_recovery ON weaving_runs(state, lease_until, updated_at);
CREATE TRIGGER weaving_identity_immutable
          BEFORE UPDATE OF id, job_id, attempt, session_id, prompt_id, created_at ON weaving_runs
          BEGIN SELECT RAISE(ABORT, 'immutable weaving identity'); END;
CREATE TRIGGER weaving_receipt_retained BEFORE DELETE ON weaving_runs
          BEGIN SELECT RAISE(ABORT, 'retained weaving attempt'); END;
CREATE TABLE owned_grants (
          session_id TEXT PRIMARY KEY NOT NULL REFERENCES weaving_runs(session_id),
          run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id),
          location TEXT NOT NULL, agent TEXT NOT NULL,
          source_ids TEXT NOT NULL, operations TEXT NOT NULL, scope_hash TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
        );
CREATE TRIGGER grant_identity_immutable BEFORE UPDATE OF
          session_id,run_id,location,agent,source_ids,operations,scope_hash ON owned_grants
          BEGIN SELECT RAISE(ABORT, 'immutable owned grant'); END;
CREATE TRIGGER grant_revocation_final BEFORE UPDATE OF revoked ON owned_grants
          WHEN OLD.revoked=1 AND NEW.revoked<>1 BEGIN SELECT RAISE(ABORT, 'revoked owned grant'); END;
CREATE TRIGGER grant_receipt_retained BEFORE DELETE ON owned_grants
          BEGIN SELECT RAISE(ABORT, 'retained owned grant'); END;
CREATE TRIGGER grant_run_settled AFTER UPDATE OF state ON weaving_runs
          WHEN NEW.state IN ('completed','not_admitted') BEGIN
            UPDATE owned_grants SET revoked=1 WHERE run_id=NEW.id;
          END;
CREATE TABLE native_commands (
          run_id TEXT PRIMARY KEY NOT NULL REFERENCES weaving_runs(id),
          payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
          attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1))
        );
CREATE TRIGGER native_command_immutable BEFORE UPDATE OF run_id,payload,payload_hash ON native_commands
          BEGIN SELECT RAISE(ABORT, 'immutable native command'); END;
CREATE TRIGGER native_admission_final BEFORE UPDATE OF attempted ON native_commands
          WHEN OLD.attempted=1 AND NEW.attempted<>1 BEGIN SELECT RAISE(ABORT, 'retained admission attempt'); END;
CREATE TRIGGER native_command_retained BEFORE DELETE ON native_commands
          BEGIN SELECT RAISE(ABORT, 'retained native command'); END;
CREATE UNIQUE INDEX weaving_active_job ON weaving_runs(job_id)
          WHERE outcome IS NULL AND state IN ('preparing','admitting','admitted','uncertain');
CREATE TRIGGER grant_execution_settled AFTER UPDATE OF outcome ON weaving_runs WHEN NEW.outcome IS NOT NULL
          BEGIN UPDATE owned_grants SET revoked=1 WHERE run_id=NEW.id; END;
CREATE TRIGGER weaving_outcome_final BEFORE UPDATE OF outcome ON weaving_runs
          WHEN OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome BEGIN SELECT RAISE(ABORT, 'settled execution outcome'); END;
CREATE TABLE tool_reads (
          run_id TEXT NOT NULL REFERENCES weaving_runs(id), kind TEXT NOT NULL CHECK(kind IN ('source','item','relationship')),
          record_id TEXT NOT NULL, version_id TEXT, PRIMARY KEY(run_id,kind,record_id)
        );
CREATE TABLE weaving_retry_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
          id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL REFERENCES sources(id),
          job_id TEXT NOT NULL REFERENCES jobs(id), expected_run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id)
        );
CREATE TRIGGER weaving_retry_immutable BEFORE UPDATE ON weaving_retry_receipts
          BEGIN SELECT RAISE(ABORT, 'immutable retry command'); END;
CREATE TRIGGER weaving_retry_retained BEFORE DELETE ON weaving_retry_receipts
          BEGIN SELECT RAISE(ABORT, 'retained retry command'); END;
CREATE INDEX formulation_run ON formulations(run_id);
CREATE INDEX relationship_revision_run ON relationship_revisions(run_id);
CREATE INDEX alias_run ON search_aliases(run_id);
CREATE TABLE dialogue_turns (
          id TEXT PRIMARY KEY NOT NULL, dialogue_id TEXT NOT NULL REFERENCES dialogues(id),
          source_id TEXT NOT NULL UNIQUE REFERENCES sources(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
          position INTEGER NOT NULL CHECK(position > 0), created_at TEXT NOT NULL, UNIQUE(dialogue_id,position)
        );
CREATE TABLE dialogue_turn_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
          turn_id TEXT NOT NULL UNIQUE REFERENCES dialogue_turns(id), command TEXT NOT NULL
        );
CREATE TRIGGER dialogue_turns_immutable BEFORE UPDATE ON dialogue_turns
            BEGIN SELECT RAISE(ABORT, 'immutable dialogue command context'); END;
CREATE TRIGGER dialogue_turns_retained BEFORE DELETE ON dialogue_turns
            BEGIN SELECT RAISE(ABORT, 'retained dialogue context'); END;
CREATE TRIGGER dialogue_turn_receipts_immutable BEFORE UPDATE ON dialogue_turn_receipts
            BEGIN SELECT RAISE(ABORT, 'immutable dialogue command context'); END;
CREATE TRIGGER dialogue_turn_receipts_retained BEFORE DELETE ON dialogue_turn_receipts
            BEGIN SELECT RAISE(ABORT, 'retained dialogue context'); END;
CREATE TABLE "dialogues" (
          id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
          selection_kind TEXT NOT NULL CHECK(selection_kind IN ('source','item','relationship')),
          item_id TEXT REFERENCES knowledge_items(id), version_id TEXT REFERENCES formulations(id),
          relationship_id TEXT REFERENCES relationships(id), relationship_version_id TEXT REFERENCES relationship_revisions(id),
          from_version_id TEXT REFERENCES formulations(id), to_version_id TEXT REFERENCES formulations(id),
          context TEXT NOT NULL, created_at TEXT NOT NULL,
          CHECK((selection_kind='source' AND item_id IS NULL AND version_id IS NULL AND relationship_id IS NULL AND relationship_version_id IS NULL AND from_version_id IS NULL AND to_version_id IS NULL)
            OR (selection_kind='item' AND item_id IS NOT NULL AND version_id IS NOT NULL AND relationship_id IS NULL AND relationship_version_id IS NULL AND from_version_id IS NULL AND to_version_id IS NULL)
            OR (selection_kind='relationship' AND item_id IS NULL AND version_id IS NULL AND relationship_id IS NOT NULL AND relationship_version_id IS NOT NULL AND from_version_id IS NOT NULL AND to_version_id IS NOT NULL))
        );
CREATE INDEX dialogues_source ON dialogues(source_id);
CREATE TRIGGER dialogue_selection_scope BEFORE INSERT ON dialogues WHEN
          (NEW.selection_kind='item' AND NOT EXISTS (SELECT 1 FROM knowledge_items i JOIN formulations f ON f.item_id=i.id
            WHERE i.id=NEW.item_id AND i.source_id=NEW.source_id AND f.id=NEW.version_id)) OR
          (NEW.selection_kind='relationship' AND NOT EXISTS (SELECT 1 FROM relationships r
            JOIN relationship_revisions v ON v.relationship_id=r.id JOIN knowledge_items a ON a.id=r.from_item_id JOIN knowledge_items b ON b.id=r.to_item_id
            JOIN formulations af ON af.item_id=a.id JOIN formulations bf ON bf.item_id=b.id
            WHERE r.id=NEW.relationship_id AND v.id=NEW.relationship_version_id AND af.id=NEW.from_version_id AND bf.id=NEW.to_version_id
              AND (a.source_id=NEW.source_id OR b.source_id=NEW.source_id)))
          BEGIN SELECT RAISE(ABORT, 'invalid dialogue selection'); END;
CREATE TABLE dialogue_creation_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
          dialogue_id TEXT NOT NULL UNIQUE REFERENCES dialogues(id), response TEXT NOT NULL
        );
CREATE TABLE dialogue_outcomes (
          turn_id TEXT PRIMARY KEY NOT NULL REFERENCES dialogue_turns(id), run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id),
          outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','interrupted')),
          assistant_message_id TEXT, assistant_text TEXT,
          CHECK((assistant_message_id IS NULL)=(assistant_text IS NULL)),
          CHECK(outcome<>'succeeded' OR assistant_text IS NOT NULL)
        );
CREATE TRIGGER dialogue_outcome_scope BEFORE INSERT ON dialogue_outcomes WHEN NOT EXISTS (
          SELECT 1 FROM dialogue_turns t JOIN weaving_runs r ON r.job_id=t.job_id
          WHERE t.id=NEW.turn_id AND r.id=NEW.run_id AND r.outcome=NEW.outcome
        ) BEGIN SELECT RAISE(ABORT, 'invalid dialogue outcome'); END;
CREATE TABLE idea_derivations (
          item_id TEXT PRIMARY KEY NOT NULL REFERENCES knowledge_items(id),
          dialogue_id TEXT NOT NULL REFERENCES dialogues(id), turn_id TEXT NOT NULL REFERENCES dialogue_turns(id),
          root_source_id TEXT NOT NULL REFERENCES sources(id), turn_source_id TEXT NOT NULL REFERENCES sources(id),
          from_item_id TEXT REFERENCES knowledge_items(id), from_version_id TEXT REFERENCES formulations(id),
          CHECK((from_item_id IS NULL)=(from_version_id IS NULL))
        );
CREATE TRIGGER idea_derivation_scope BEFORE INSERT ON idea_derivations WHEN NOT EXISTS (
          SELECT 1 FROM dialogue_turns t JOIN dialogues d ON d.id=t.dialogue_id JOIN knowledge_items i ON i.id=NEW.item_id
          WHERE t.id=NEW.turn_id AND d.id=NEW.dialogue_id AND d.source_id=NEW.root_source_id AND t.source_id=NEW.turn_source_id
            AND i.source_id=d.source_id AND i.kind='developing-idea'
        ) OR (NEW.from_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM formulations f WHERE f.id=NEW.from_version_id AND f.item_id=NEW.from_item_id))
          BEGIN SELECT RAISE(ABORT, 'invalid idea derivation'); END;
CREATE TRIGGER dialogues_immutable BEFORE UPDATE ON dialogues BEGIN SELECT RAISE(ABORT, 'immutable dialogue evidence'); END;
CREATE TRIGGER dialogues_retained BEFORE DELETE ON dialogues BEGIN SELECT RAISE(ABORT, 'retained dialogue evidence'); END;
CREATE TRIGGER dialogue_creation_receipts_immutable BEFORE UPDATE ON dialogue_creation_receipts BEGIN SELECT RAISE(ABORT, 'immutable dialogue evidence'); END;
CREATE TRIGGER dialogue_creation_receipts_retained BEFORE DELETE ON dialogue_creation_receipts BEGIN SELECT RAISE(ABORT, 'retained dialogue evidence'); END;
CREATE TRIGGER dialogue_outcomes_immutable BEFORE UPDATE ON dialogue_outcomes BEGIN SELECT RAISE(ABORT, 'immutable dialogue evidence'); END;
CREATE TRIGGER dialogue_outcomes_retained BEFORE DELETE ON dialogue_outcomes BEGIN SELECT RAISE(ABORT, 'retained dialogue evidence'); END;
CREATE TRIGGER idea_derivations_immutable BEFORE UPDATE ON idea_derivations BEGIN SELECT RAISE(ABORT, 'immutable dialogue evidence'); END;
CREATE TRIGGER idea_derivations_retained BEFORE DELETE ON idea_derivations BEGIN SELECT RAISE(ABORT, 'retained dialogue evidence'); END;
CREATE TABLE dialogue_stop_requests (
          id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
          dialogue_id TEXT NOT NULL REFERENCES dialogues(id), turn_id TEXT NOT NULL UNIQUE REFERENCES dialogue_turns(id),
          job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), expected_run_id TEXT REFERENCES weaving_runs(id), created_at TEXT NOT NULL
        );
CREATE TRIGGER dialogue_stop_scope BEFORE INSERT ON dialogue_stop_requests WHEN NOT EXISTS (
          SELECT 1 FROM dialogue_turns t WHERE t.id=NEW.turn_id AND t.dialogue_id=NEW.dialogue_id AND t.job_id=NEW.job_id
        ) OR (NEW.expected_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.id=NEW.expected_run_id AND r.job_id=NEW.job_id))
          BEGIN SELECT RAISE(ABORT, 'invalid dialogue stop scope'); END;
CREATE TABLE dialogue_stop_dispatch (
          stop_id TEXT PRIMARY KEY NOT NULL REFERENCES dialogue_stop_requests(id),
          state TEXT NOT NULL CHECK(state IN ('queued','attempted','requested','uncertain'))
        );
CREATE TRIGGER dialogue_stop_dispatch_identity BEFORE UPDATE OF stop_id ON dialogue_stop_dispatch
          BEGIN SELECT RAISE(ABORT, 'immutable stop identity'); END;
CREATE TRIGGER dialogue_stop_dispatch_forward BEFORE UPDATE OF state ON dialogue_stop_dispatch WHEN NOT
          ((OLD.state='queued' AND NEW.state='attempted') OR (OLD.state='attempted' AND NEW.state IN ('requested','uncertain')))
          BEGIN SELECT RAISE(ABORT, 'retained stop attempt'); END;
CREATE TRIGGER dialogue_stop_revoke AFTER INSERT ON dialogue_stop_requests BEGIN
          UPDATE owned_grants SET revoked=1 WHERE run_id IN (SELECT id FROM weaving_runs WHERE job_id=NEW.job_id);
        END;
CREATE TRIGGER dialogue_stopped_grant BEFORE INSERT ON owned_grants WHEN EXISTS (
          SELECT 1 FROM dialogue_stop_requests s JOIN weaving_runs r ON r.job_id=s.job_id WHERE r.id=NEW.run_id
        ) BEGIN SELECT RAISE(ABORT, 'stopped dialogue grant'); END;
CREATE TRIGGER dialogue_stopped_run BEFORE INSERT ON weaving_runs WHEN EXISTS (
          SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=NEW.job_id
        ) BEGIN SELECT RAISE(ABORT, 'stopped dialogue run'); END;
CREATE TRIGGER dialogue_stop_immutable BEFORE UPDATE ON dialogue_stop_requests
          BEGIN SELECT RAISE(ABORT, 'immutable stop command'); END;
CREATE TRIGGER dialogue_stop_requests_retained BEFORE DELETE ON dialogue_stop_requests
          BEGIN SELECT RAISE(ABORT, 'retained stop command'); END;
CREATE TRIGGER dialogue_stop_dispatch_retained BEFORE DELETE ON dialogue_stop_dispatch
          BEGIN SELECT RAISE(ABORT, 'retained stop command'); END;
CREATE TABLE "jobs" (
    id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0),
    kind TEXT NOT NULL DEFAULT 'capture' CHECK(kind IN ('capture','dialogue','follow_up'))
  );
CREATE INDEX jobs_queue ON jobs(status,priority);
CREATE INDEX jobs_source ON jobs(source_id,kind);
CREATE TRIGGER jobs_identity_immutable BEFORE UPDATE OF id, source_id ON jobs
          BEGIN SELECT RAISE(ABORT, 'immutable job identity'); END;
CREATE TRIGGER grant_job_inactive AFTER UPDATE OF status ON jobs
          WHEN NEW.status NOT IN ('running','uncertain') BEGIN
            UPDATE owned_grants SET revoked=1 WHERE run_id IN (SELECT id FROM weaving_runs WHERE job_id=NEW.id);
          END;
CREATE TRIGGER jobs_kind_immutable BEFORE UPDATE OF kind ON jobs
          BEGIN SELECT RAISE(ABORT, 'immutable job kind'); END;
CREATE TRIGGER dialogue_turn_scope BEFORE INSERT ON dialogue_turns WHEN NOT EXISTS (
          SELECT 1 FROM dialogues d JOIN jobs j ON j.id=NEW.job_id JOIN sources s ON s.id=NEW.source_id
          WHERE d.id=NEW.dialogue_id AND j.kind='dialogue' AND j.source_id=d.source_id
            AND s.id<>d.source_id AND s.provenance='discussion-turn' AND s.created_at=NEW.created_at
        ) BEGIN SELECT RAISE(ABORT, 'invalid dialogue turn scope'); END;
CREATE TRIGGER dialogue_stopped_requeue BEFORE UPDATE OF status ON jobs WHEN NEW.status='queued' AND EXISTS (
          SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=NEW.id
        ) BEGIN SELECT RAISE(ABORT, 'stopped dialogue job'); END;
CREATE TABLE follow_up_origins (
          run_id TEXT PRIMARY KEY NOT NULL REFERENCES weaving_runs(id), job_id TEXT NOT NULL REFERENCES jobs(id),
          turn_id TEXT NOT NULL UNIQUE REFERENCES dialogue_turns(id)
        );
CREATE INDEX follow_up_origin_job ON follow_up_origins(job_id);
CREATE TABLE follow_up_targets (
          origin_run_id TEXT NOT NULL REFERENCES follow_up_origins(run_id),
          item_id TEXT REFERENCES knowledge_items(id), formulation_id TEXT REFERENCES formulations(id),
          relationship_id TEXT REFERENCES relationships(id), revision_id TEXT REFERENCES relationship_revisions(id),
          CHECK((item_id IS NOT NULL AND formulation_id IS NOT NULL AND relationship_id IS NULL AND revision_id IS NULL)
            OR (item_id IS NULL AND formulation_id IS NULL AND relationship_id IS NOT NULL AND revision_id IS NOT NULL)),
          UNIQUE(origin_run_id,formulation_id), UNIQUE(origin_run_id,revision_id)
        );
CREATE TRIGGER follow_up_origin_scope BEFORE INSERT ON follow_up_origins WHEN NOT EXISTS (
          SELECT 1 FROM jobs target JOIN weaving_runs r ON r.id=NEW.run_id JOIN jobs origin ON origin.id=r.job_id
          JOIN dialogue_turns t ON t.job_id=origin.id JOIN dialogues d ON d.id=t.dialogue_id
          JOIN dialogue_outcomes o ON o.turn_id=t.id AND o.run_id=r.id
          WHERE target.id=NEW.job_id AND target.kind='follow_up' AND target.status='queued'
            AND origin.kind='dialogue' AND origin.status='completed' AND target.source_id=origin.source_id AND d.source_id=origin.source_id
            AND t.id=NEW.turn_id AND r.state='completed' AND r.outcome='succeeded' AND o.outcome='succeeded'
            AND NOT EXISTS (SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=origin.id)
            AND NOT EXISTS (SELECT 1 FROM weaving_runs claimed WHERE claimed.job_id=target.id)
        ) BEGIN SELECT RAISE(ABORT, 'invalid follow-up origin'); END;
CREATE TRIGGER follow_up_target_scope BEFORE INSERT ON follow_up_targets WHEN NOT EXISTS (
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
        )) BEGIN SELECT RAISE(ABORT, 'invalid follow-up target'); END;
CREATE TRIGGER follow_up_origins_immutable BEFORE UPDATE ON follow_up_origins BEGIN SELECT RAISE(ABORT, 'immutable follow-up input'); END;
CREATE TRIGGER follow_up_origins_retained BEFORE DELETE ON follow_up_origins BEGIN SELECT RAISE(ABORT, 'retained follow-up input'); END;
CREATE TRIGGER follow_up_targets_immutable BEFORE UPDATE ON follow_up_targets BEGIN SELECT RAISE(ABORT, 'immutable follow-up input'); END;
CREATE TRIGGER follow_up_targets_retained BEFORE DELETE ON follow_up_targets BEGIN SELECT RAISE(ABORT, 'retained follow-up input'); END;
CREATE TABLE follow_up_user_origins (
          job_id TEXT NOT NULL REFERENCES jobs(id), operation_id TEXT NOT NULL REFERENCES knowledge_receipts(operation_id),
          PRIMARY KEY(job_id,operation_id)
        );
CREATE TABLE follow_up_user_targets (
          job_id TEXT NOT NULL, operation_id TEXT NOT NULL,
          item_id TEXT REFERENCES knowledge_items(id), formulation_id TEXT REFERENCES formulations(id),
          relationship_id TEXT REFERENCES relationships(id), revision_id TEXT REFERENCES relationship_revisions(id),
          FOREIGN KEY(job_id,operation_id) REFERENCES follow_up_user_origins(job_id,operation_id),
          CHECK((item_id IS NOT NULL AND formulation_id IS NOT NULL AND relationship_id IS NULL AND revision_id IS NULL)
            OR (item_id IS NULL AND formulation_id IS NULL AND relationship_id IS NOT NULL AND revision_id IS NOT NULL)),
          UNIQUE(job_id,operation_id,formulation_id), UNIQUE(job_id,operation_id,revision_id)
        );
CREATE TABLE follow_up_inputs (
          job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id), payload TEXT NOT NULL, payload_hash TEXT NOT NULL
        );
CREATE TRIGGER follow_up_input_scope BEFORE INSERT ON follow_up_inputs WHEN NOT EXISTS (
          SELECT 1 FROM jobs j WHERE j.id=NEW.job_id AND j.kind='follow_up' AND j.status='queued'
            AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.job_id=j.id)
        ) BEGIN SELECT RAISE(ABORT, 'invalid follow-up freeze'); END;
CREATE TRIGGER follow_up_user_origin_scope BEFORE INSERT ON follow_up_user_origins WHEN NOT EXISTS (
          SELECT 1 FROM jobs j JOIN knowledge_receipts k ON k.operation_id=NEW.operation_id
          WHERE j.id=NEW.job_id AND j.kind='follow_up' AND j.status='queued'
            AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.job_id=j.id)
            AND NOT EXISTS (SELECT 1 FROM follow_up_inputs frozen WHERE frozen.job_id=j.id)
            AND (EXISTS (SELECT 1 FROM formulations f JOIN knowledge_items i ON i.id=f.item_id
              WHERE f.id=k.revision_id AND i.id=k.result_id AND f.operation_id=k.operation_id AND f.author='user' AND i.source_id=j.source_id)
            OR EXISTS (SELECT 1 FROM relationship_revisions v JOIN relationships rel ON rel.id=v.relationship_id
              JOIN knowledge_items a ON a.id=rel.from_item_id JOIN knowledge_items b ON b.id=rel.to_item_id
              WHERE v.id=k.revision_id AND rel.id=k.result_id AND v.operation_id=k.operation_id AND v.author='user' AND (a.source_id=j.source_id OR b.source_id=j.source_id)))
        ) BEGIN SELECT RAISE(ABORT, 'invalid user follow-up origin'); END;
CREATE TRIGGER follow_up_user_target_scope BEFORE INSERT ON follow_up_user_targets WHEN NOT EXISTS (
          SELECT 1 FROM follow_up_user_origins o JOIN jobs j ON j.id=o.job_id JOIN knowledge_receipts k ON k.operation_id=o.operation_id
          WHERE o.job_id=NEW.job_id AND o.operation_id=NEW.operation_id AND j.status='queued'
            AND NOT EXISTS (SELECT 1 FROM weaving_runs r WHERE r.job_id=j.id)
            AND NOT EXISTS (SELECT 1 FROM follow_up_inputs frozen WHERE frozen.job_id=j.id)
            AND ((NEW.item_id IS NOT NULL AND EXISTS (SELECT 1 FROM formulations f JOIN knowledge_items i ON i.id=f.item_id
              WHERE f.id=NEW.formulation_id AND i.id=NEW.item_id AND f.id=k.revision_id AND i.id=k.result_id AND f.author='user' AND f.operation_id=k.operation_id AND i.source_id=j.source_id))
            OR (NEW.relationship_id IS NOT NULL AND EXISTS (SELECT 1 FROM relationship_revisions v JOIN relationships rel ON rel.id=v.relationship_id
              JOIN knowledge_items a ON a.id=rel.from_item_id JOIN knowledge_items b ON b.id=rel.to_item_id
              WHERE v.id=NEW.revision_id AND rel.id=NEW.relationship_id AND v.id=k.revision_id AND rel.id=k.result_id AND v.author='user' AND v.operation_id=k.operation_id AND (a.source_id=j.source_id OR b.source_id=j.source_id))))
        ) BEGIN SELECT RAISE(ABORT, 'invalid user follow-up target'); END;
CREATE TRIGGER follow_up_origins_frozen BEFORE INSERT ON follow_up_origins WHEN EXISTS (SELECT 1 FROM follow_up_inputs WHERE job_id=NEW.job_id)
            BEGIN SELECT RAISE(ABORT, 'frozen follow-up input'); END;
CREATE TRIGGER follow_up_targets_frozen BEFORE INSERT ON follow_up_targets WHEN EXISTS (SELECT 1 FROM follow_up_inputs WHERE job_id=(SELECT job_id FROM follow_up_origins WHERE run_id=NEW.origin_run_id))
            BEGIN SELECT RAISE(ABORT, 'frozen follow-up input'); END;
CREATE VIEW follow_up_origin_refs AS
          SELECT o.job_id,'dialogue' AS kind,o.run_id,t.dialogue_id,o.turn_id,t.source_id AS turn_source_id,NULL AS operation_id
          FROM follow_up_origins o JOIN dialogue_turns t ON t.id=o.turn_id
          UNION ALL SELECT job_id,'user',NULL,NULL,NULL,NULL,operation_id FROM follow_up_user_origins;
CREATE VIEW follow_up_target_refs AS
          SELECT o.job_id,CASE WHEN t.item_id IS NOT NULL THEN 'item' ELSE 'relationship' END AS kind,
            COALESCE(t.item_id,t.relationship_id) AS id,COALESCE(t.formulation_id,t.revision_id) AS version_id
          FROM follow_up_targets t JOIN follow_up_origins o ON o.run_id=t.origin_run_id
          UNION SELECT job_id,CASE WHEN item_id IS NOT NULL THEN 'item' ELSE 'relationship' END,
            COALESCE(item_id,relationship_id),COALESCE(formulation_id,revision_id) FROM follow_up_user_targets;
CREATE TABLE follow_up_retry_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL, id TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL REFERENCES sources(id), job_id TEXT NOT NULL REFERENCES jobs(id),
          expected_run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id)
        );
CREATE TRIGGER follow_up_retry_scope BEFORE INSERT ON follow_up_retry_receipts WHEN NOT EXISTS (
          SELECT 1 FROM jobs j JOIN weaving_runs r ON r.job_id=j.id WHERE j.id=NEW.job_id AND j.source_id=NEW.source_id
            AND j.kind='follow_up' AND r.id=NEW.expected_run_id
        ) BEGIN SELECT RAISE(ABORT, 'invalid follow-up retry'); END;
CREATE TRIGGER follow_up_user_origins_immutable BEFORE UPDATE ON follow_up_user_origins BEGIN SELECT RAISE(ABORT, 'immutable follow-up receipt'); END;
CREATE TRIGGER follow_up_user_origins_retained BEFORE DELETE ON follow_up_user_origins BEGIN SELECT RAISE(ABORT, 'retained follow-up receipt'); END;
CREATE TRIGGER follow_up_user_targets_immutable BEFORE UPDATE ON follow_up_user_targets BEGIN SELECT RAISE(ABORT, 'immutable follow-up receipt'); END;
CREATE TRIGGER follow_up_user_targets_retained BEFORE DELETE ON follow_up_user_targets BEGIN SELECT RAISE(ABORT, 'retained follow-up receipt'); END;
CREATE TRIGGER follow_up_inputs_immutable BEFORE UPDATE ON follow_up_inputs BEGIN SELECT RAISE(ABORT, 'immutable follow-up receipt'); END;
CREATE TRIGGER follow_up_inputs_retained BEFORE DELETE ON follow_up_inputs BEGIN SELECT RAISE(ABORT, 'retained follow-up receipt'); END;
CREATE TRIGGER follow_up_retry_receipts_immutable BEFORE UPDATE ON follow_up_retry_receipts BEGIN SELECT RAISE(ABORT, 'immutable follow-up receipt'); END;
CREATE TRIGGER follow_up_retry_receipts_retained BEFORE DELETE ON follow_up_retry_receipts BEGIN SELECT RAISE(ABORT, 'retained follow-up receipt'); END;
CREATE TABLE weaving_abandonments (
    id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id),
    session_id TEXT NOT NULL, prompt_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at>=0),
    acknowledgement TEXT NOT NULL CHECK(acknowledgement='native-may-continue-and-charge')
  );
CREATE TRIGGER weaving_abandonment_scope BEFORE INSERT ON weaving_abandonments WHEN NOT EXISTS (
    SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE j.id=NEW.job_id AND r.id=NEW.run_id
      AND r.session_id=NEW.session_id AND r.prompt_id=NEW.prompt_id AND j.status='uncertain'
      AND j.kind IN ('capture','dialogue','follow_up') AND r.state='uncertain' AND r.outcome IS NULL
      AND r.lease_owner IS NULL AND r.lease_until IS NULL
      AND NOT EXISTS (SELECT 1 FROM weaving_runs later WHERE later.job_id=j.id AND later.attempt>r.attempt)
      AND NOT EXISTS (SELECT 1 FROM owned_grants g JOIN weaving_runs owned ON owned.id=g.run_id WHERE owned.job_id=j.id AND g.revoked=0)
  ) BEGIN SELECT RAISE(ABORT,'invalid abandonment scope'); END;
CREATE TRIGGER weaving_abandonment_immutable BEFORE UPDATE ON weaving_abandonments
    BEGIN SELECT RAISE(ABORT,'immutable abandonment receipt'); END;
CREATE TRIGGER weaving_abandonment_retained BEFORE DELETE ON weaving_abandonments
    BEGIN SELECT RAISE(ABORT,'retained abandonment receipt'); END;
CREATE TABLE weaving_abandonment_dispatch (
    abandonment_id TEXT PRIMARY KEY NOT NULL REFERENCES weaving_abandonments(id),
    state TEXT NOT NULL CHECK(state IN ('queued','attempted','requested','uncertain','not_requested')),
    attempted_at INTEGER, finished_at INTEGER,
    category TEXT CHECK(category IN ('unsupported','ownership_unverified','request_failed')),
    CHECK((state='queued' AND attempted_at IS NULL AND finished_at IS NULL AND category IS NULL)
      OR (state='attempted' AND attempted_at IS NOT NULL AND attempted_at>=0 AND finished_at IS NULL AND category IS NULL)
      OR (state IN ('requested','uncertain','not_requested') AND attempted_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at>=attempted_at)),
    CHECK((state IN ('queued','attempted','requested') AND category IS NULL)
      OR (state='uncertain' AND category IS 'request_failed')
      OR (state='not_requested' AND category IS NOT NULL AND category IN ('unsupported','ownership_unverified')))
  );
CREATE TRIGGER abandonment_dispatch_scope BEFORE INSERT ON weaving_abandonment_dispatch WHEN NEW.state<>'queued' OR NOT EXISTS (
    SELECT 1 FROM weaving_abandonments a JOIN jobs j ON j.id=a.job_id WHERE a.id=NEW.abandonment_id AND j.status='abandoned'
  ) BEGIN SELECT RAISE(ABORT,'invalid abandonment dispatch'); END;
CREATE TRIGGER abandonment_dispatch_identity BEFORE UPDATE OF abandonment_id ON weaving_abandonment_dispatch
    BEGIN SELECT RAISE(ABORT,'immutable abandonment dispatch identity'); END;
CREATE TRIGGER abandonment_dispatch_forward BEFORE UPDATE ON weaving_abandonment_dispatch WHEN NOT (
    (OLD.state='queued' AND NEW.state='attempted' AND NEW.attempted_at IS NOT NULL AND NEW.attempted_at>=0 AND NEW.finished_at IS NULL AND NEW.category IS NULL)
    OR (OLD.state='attempted' AND NEW.state IN ('requested','uncertain','not_requested')
      AND NEW.attempted_at=OLD.attempted_at AND NEW.finished_at IS NOT NULL AND NEW.finished_at>=NEW.attempted_at)
  ) BEGIN SELECT RAISE(ABORT,'retained abandonment interrupt attempt'); END;
CREATE TRIGGER abandonment_dispatch_retained BEFORE DELETE ON weaving_abandonment_dispatch
    BEGIN SELECT RAISE(ABORT,'retained abandonment dispatch'); END;
CREATE TRIGGER abandoned_job_final BEFORE UPDATE OF status ON jobs WHEN OLD.status='abandoned' AND NEW.status<>'abandoned'
    BEGIN SELECT RAISE(ABORT,'abandoned job is terminal'); END;
CREATE TRIGGER abandoned_job_retained BEFORE DELETE ON jobs WHEN OLD.status='abandoned'
    BEGIN SELECT RAISE(ABORT,'retained abandoned job'); END;
CREATE TRIGGER abandoned_run_frozen BEFORE UPDATE ON weaving_runs WHEN
    EXISTS (SELECT 1 FROM jobs j WHERE j.id=OLD.job_id AND j.status='abandoned')
    OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.run_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'abandoned run lifecycle is frozen'); END;
CREATE TRIGGER abandoned_job_no_run BEFORE INSERT ON weaving_runs WHEN
    EXISTS (SELECT 1 FROM jobs j WHERE j.id=NEW.job_id AND j.status='abandoned')
    OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.job_id=NEW.job_id)
    BEGIN SELECT RAISE(ABORT,'abandoned job cannot acquire a run'); END;
CREATE TRIGGER abandoned_job_no_grant BEFORE INSERT ON owned_grants WHEN EXISTS (
    SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=NEW.run_id
      AND (j.status='abandoned' OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.job_id=j.id))
  ) BEGIN SELECT RAISE(ABORT,'abandoned job cannot acquire a grant'); END;
CREATE TRIGGER abandoned_command_insert BEFORE INSERT ON native_commands WHEN EXISTS (
      SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=NEW.run_id
        AND (j.status='abandoned' OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.run_id=r.id))
    ) BEGIN SELECT RAISE(ABORT,'abandoned native command is frozen'); END;
CREATE TRIGGER abandoned_command_update BEFORE UPDATE ON native_commands WHEN EXISTS (
      SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=NEW.run_id
        AND (j.status='abandoned' OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.run_id=r.id))
    ) BEGIN SELECT RAISE(ABORT,'abandoned native command is frozen'); END;
CREATE TRIGGER abandoned_dialogue_no_outcome BEFORE INSERT ON dialogue_outcomes WHEN EXISTS (
    SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=NEW.run_id
      AND (j.status='abandoned' OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.run_id=r.id))
  ) BEGIN SELECT RAISE(ABORT,'abandonment is not native settlement'); END;
CREATE INDEX knowledge_created_at ON knowledge_items(created_at, id) WHERE created_at IS NOT NULL;
CREATE INDEX sources_created_at ON sources(created_at DESC, id);
CREATE TRIGGER knowledge_creation_time_immutable BEFORE UPDATE OF created_at ON knowledge_items
          BEGIN SELECT RAISE(ABORT, 'immutable item creation time'); END;
CREATE TABLE title_entities (
    id TEXT PRIMARY KEY NOT NULL, source_id TEXT REFERENCES sources(id), item_id TEXT REFERENCES knowledge_items(id),
    CHECK((source_id IS NULL) <> (item_id IS NULL)), UNIQUE(source_id), UNIQUE(item_id));
CREATE TRIGGER title_entity_immutable BEFORE UPDATE ON title_entities BEGIN SELECT RAISE(ABORT,'immutable title entity'); END;
CREATE TRIGGER title_entity_retained BEFORE DELETE ON title_entities BEGIN SELECT RAISE(ABORT,'retained title entity'); END;
CREATE TABLE title_revisions (
    id TEXT PRIMARY KEY NOT NULL, entity_id TEXT NOT NULL REFERENCES title_entities(id),
    text TEXT NOT NULL, author TEXT NOT NULL CHECK(author IN ('user','ai')),
    formulation_id TEXT REFERENCES formulations(id), created_at TEXT NOT NULL,
    UNIQUE(entity_id,id));
CREATE TRIGGER title_revision_scope BEFORE INSERT ON title_revisions WHEN
    (NEW.formulation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM title_entities e JOIN formulations f ON f.item_id=e.item_id WHERE e.id=NEW.entity_id AND f.id=NEW.formulation_id)) OR
    (NEW.author='ai' AND EXISTS (SELECT 1 FROM title_entities e WHERE e.id=NEW.entity_id AND e.item_id IS NOT NULL) AND NEW.formulation_id IS NULL)
    BEGIN SELECT RAISE(ABORT,'invalid title formulation'); END;
CREATE TRIGGER title_revision_immutable BEFORE UPDATE ON title_revisions BEGIN SELECT RAISE(ABORT,'immutable title revision'); END;
CREATE TRIGGER title_revision_retained BEFORE DELETE ON title_revisions BEGIN SELECT RAISE(ABORT,'retained title revision'); END;
CREATE TABLE title_heads (entity_id TEXT PRIMARY KEY REFERENCES title_entities(id), revision_id TEXT NOT NULL,
    user_revision_id TEXT, FOREIGN KEY(entity_id,revision_id) REFERENCES title_revisions(entity_id,id),
    FOREIGN KEY(entity_id,user_revision_id) REFERENCES title_revisions(entity_id,id));
CREATE TRIGGER title_head_user_insert BEFORE INSERT ON title_heads
    WHEN NEW.user_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM title_revisions r WHERE r.id=NEW.user_revision_id AND r.entity_id=NEW.entity_id AND r.author='user')
    BEGIN SELECT RAISE(ABORT,'invalid title user override'); END;
CREATE TRIGGER title_head_user_update BEFORE UPDATE ON title_heads
    WHEN NEW.user_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM title_revisions r WHERE r.id=NEW.user_revision_id AND r.entity_id=NEW.entity_id AND r.author='user')
    BEGIN SELECT RAISE(ABORT,'invalid title user override'); END;
CREATE TABLE title_receipts (idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
    revision_id TEXT NOT NULL REFERENCES title_revisions(id));
CREATE TRIGGER title_receipt_immutable BEFORE UPDATE ON title_receipts BEGIN SELECT RAISE(ABORT,'immutable title receipt'); END;
CREATE TRIGGER title_receipt_retained BEFORE DELETE ON title_receipts BEGIN SELECT RAISE(ABORT,'retained title receipt'); END;
CREATE TABLE fuzzy_projection_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), format_version INTEGER NOT NULL CHECK(format_version>0));
CREATE TABLE fuzzy_targets (
    target_kind TEXT NOT NULL CHECK(target_kind IN ('source','item')), target_id TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources(id), item_id TEXT REFERENCES knowledge_items(id),
    formulation_id TEXT REFERENCES formulations(id), title_revision_id TEXT REFERENCES title_revisions(id),
    PRIMARY KEY(target_kind,target_id),
    CHECK((target_kind='source' AND target_id=source_id AND item_id IS NULL AND formulation_id IS NULL) OR
      (target_kind='item' AND target_id=item_id AND item_id IS NOT NULL AND formulation_id IS NOT NULL))
  ) WITHOUT ROWID;
CREATE TABLE fuzzy_fields (
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
    field_kind TEXT NOT NULL CHECK(field_kind IN ('source-body','formulation-body','title')),
    original_length INTEGER NOT NULL CHECK(original_length>=0), chunk_count INTEGER NOT NULL CHECK(chunk_count>=0),
    PRIMARY KEY(target_kind,target_id,field_kind),
    FOREIGN KEY(target_kind,target_id) REFERENCES fuzzy_targets(target_kind,target_id) ON DELETE CASCADE,
    CHECK(field_kind='title' OR (target_kind='source' AND field_kind='source-body') OR
      (target_kind='item' AND field_kind='formulation-body'))
  ) WITHOUT ROWID;
CREATE TABLE fuzzy_chunks (
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL, field_kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0), start_offset INTEGER NOT NULL CHECK(start_offset>=0),
    utf16_length INTEGER NOT NULL CHECK(utf16_length>0), text TEXT NOT NULL,
    PRIMARY KEY(target_kind,target_id,field_kind,ordinal),
    FOREIGN KEY(target_kind,target_id,field_kind)
      REFERENCES fuzzy_fields(target_kind,target_id,field_kind) ON DELETE CASCADE
  ) WITHOUT ROWID;
CREATE TABLE fuzzy_alias_keys (
    alias_id TEXT NOT NULL REFERENCES search_aliases(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK(side IN ('alias','expansion')), normalized_key TEXT NOT NULL,
    PRIMARY KEY(alias_id,side)
  ) WITHOUT ROWID;
CREATE INDEX fuzzy_alias_lookup ON fuzzy_alias_keys(normalized_key,alias_id,side);
PRAGMA user_version=21;
