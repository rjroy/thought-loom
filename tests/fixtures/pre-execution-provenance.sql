-- Frozen selected knowledge/run/Search closure from 189f4d1dd350d419f2555259525b8504a52ef63f,
-- the parent of c5a70cb (execution-owner provenance). Definitions come from sqlite.ts,
-- import-schema.ts/import-migration.ts, run-schema.ts and search-schema.ts/search-migration.ts.
-- Runs include Search's historical kind widening; steps include its TEXT submit_owner addition.
-- Keep the original columns, checks, FK cycles, indexes and selected input/binding/owner guards.
-- Unused export/import-admission/cleanup machinery is deliberately outside this selected fixture.
-- Rows are synthetic retained history, not qualified execution, delivery or publication authority.
-- Do not rebuild this predecessor with the current migrator or add future attribution columns.
PRAGMA foreign_keys=ON;
PRAGMA recursive_triggers=ON;
BEGIN IMMEDIATE;
CREATE TABLE thoughts (
  id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('user','ai','source')),
  kind TEXT NOT NULL CHECK(kind IN ('captured-original','user-contribution','ai-interpretation','developing-idea','imported-original')),
  created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id),
  import_document_id TEXT REFERENCES import_document_seals(document_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(import_document_id,id),CHECK(parent_id IS NULL OR parent_id!=id),
  CHECK((kind='imported-original')=(author='source')),
  CHECK((kind='imported-original')=(import_document_id IS NOT NULL)),
  CHECK(kind!='imported-original' OR (origin='markdown-import' AND parent_id IS NULL))
);
CREATE TABLE thought_titles (
  thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id),title TEXT,
  title_author TEXT CHECK(title_author IN ('user','ai')),
  CHECK((title IS NULL AND title_author IS NULL) OR (title IS NOT NULL AND title_author IS NOT NULL))
);
CREATE TABLE thought_sources (thought_id TEXT NOT NULL REFERENCES thoughts(id),position INTEGER NOT NULL,
  source_id TEXT NOT NULL REFERENCES thoughts(id),PRIMARY KEY(thought_id,position));
CREATE TABLE thought_source_seals (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id));
CREATE TABLE import_namespaces (id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE import_documents (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL
    REFERENCES import_document_seals(document_id) DEFERRABLE INITIALLY DEFERRED,
  original_bytes BLOB NOT NULL CHECK(typeof(original_bytes)='blob'),
  sha256 BLOB NOT NULL CHECK(typeof(sha256)='blob' AND length(sha256)=32),
  byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length>=0 AND byte_length<=9007199254740991 AND length(original_bytes)=byte_length),
  encoding TEXT NOT NULL CHECK(encoding='utf-8'),original_namespace_id TEXT NOT NULL REFERENCES import_namespaces(id),original_path TEXT NOT NULL,
  created_at TEXT NOT NULL,parser_version TEXT NOT NULL,
  segmentation_method TEXT NOT NULL CHECK(segmentation_method IN ('ai','structural','not-needed')),segmentation_reason TEXT,
  UNIQUE(sha256,byte_length),CHECK((segmentation_method='structural')=(segmentation_reason IS NOT NULL))
);
CREATE TABLE import_document_seals (document_id TEXT PRIMARY KEY NOT NULL REFERENCES import_documents(id));
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('weave','evolve','export','import','search')),
  status TEXT NOT NULL CHECK(status IN ('queued','submitting','running','uncertain','completed','interrupted','failed')),
  session_id TEXT UNIQUE NOT NULL,prompt_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),input_thought_id TEXT REFERENCES thoughts(id),
  weave_subject_id TEXT REFERENCES thoughts(id),weave_trigger_id TEXT,
  cancellation_state TEXT NOT NULL DEFAULT 'none' CHECK(cancellation_state IN ('none','pending','settled')),
  CHECK(kind='evolve' OR input_thought_id IS NULL),
  CHECK((weave_subject_id IS NULL)=(weave_trigger_id IS NULL)),CHECK(weave_subject_id IS NULL OR kind='weave')
);
CREATE TABLE run_steps (
  run_id TEXT NOT NULL REFERENCES runs(id),position INTEGER NOT NULL CHECK(position>=0),
  prompt_id TEXT UNIQUE NOT NULL,input TEXT CHECK(input IS NULL OR length(input)>0),
  state TEXT NOT NULL CHECK(state IN ('prepared','submitting','uncertain','completed','processed')),
  native_state TEXT NOT NULL DEFAULT 'unknown' CHECK(native_state IN ('unknown','running','completed')),
  envelope_json TEXT,result_json TEXT,submit_owner TEXT,PRIMARY KEY(run_id,position),
  CHECK(state!='processed' OR (envelope_json IS NOT NULL AND result_json IS NOT NULL)),
  CHECK(envelope_json IS NULL OR state IN ('completed','processed')),
  CHECK(result_json IS NULL OR (state IN ('completed','processed') AND envelope_json IS NOT NULL)
    OR (json_valid(result_json) AND COALESCE(json_extract(result_json,'$.type')='import-partition',0))),
  CHECK((native_state='completed')=(state IN ('completed','processed')))
);
CREATE TABLE run_context (
  run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL CHECK(kind IN ('thought','connection','response')),
  ref_id TEXT NOT NULL,full_read INTEGER NOT NULL DEFAULT 0 CHECK(full_read IN (0,1)),PRIMARY KEY(run_id,kind,ref_id)
);
CREATE TABLE agent_bindings (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),session_id TEXT UNIQUE NOT NULL,
  service_url TEXT NOT NULL,directory TEXT NOT NULL,model_json TEXT NOT NULL,permissions_json TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK(protocol_version=1)
);
CREATE TABLE search_sessions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,create_request_key TEXT UNIQUE NOT NULL,
  title TEXT,created_at TEXT NOT NULL,last_activity_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),deleted_at TEXT,
  CHECK((deleted_at IS NULL AND title IS NOT NULL AND length(title)>0) OR (deleted_at IS NOT NULL AND title IS NULL))
);
CREATE TABLE search_turns (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES search_sessions(id),
  position INTEGER NOT NULL CHECK(position>=0),request_key TEXT NOT NULL,admitted_at TEXT NOT NULL,
  effort TEXT NOT NULL CHECK(effort IN ('quick','standard','thorough')),context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','restart')),
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),open_slot INTEGER NOT NULL DEFAULT 1 CHECK(open_slot IN (0,1)),outcome_reason TEXT,
  UNIQUE(session_id,position),UNIQUE(session_id,request_key),UNIQUE(session_id,run_id)
);
CREATE TABLE search_messages (
  id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),text TEXT NOT NULL CHECK(length(text)>0),created_at TEXT NOT NULL,
  disposition TEXT CHECK(disposition IN ('awaiting-user','done')),evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(session_id,run_id) REFERENCES search_turns(session_id,run_id) ON DELETE CASCADE,
  UNIQUE(session_id,position),UNIQUE(run_id,role),UNIQUE(session_id,id),
  CHECK((role='user' AND disposition IS NULL) OR (role='assistant' AND disposition IS NOT NULL))
);
CREATE TABLE search_discoveries (
  id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL,thought_id TEXT NOT NULL REFERENCES thoughts(id),
  position INTEGER NOT NULL CHECK(position>=0),why TEXT NOT NULL CHECK(length(why)>0),evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  added_run_id TEXT NOT NULL,added_prompt_id TEXT NOT NULL REFERENCES run_steps(prompt_id),added_at TEXT NOT NULL,removed_at TEXT,
  FOREIGN KEY(session_id,added_run_id) REFERENCES search_turns(session_id,run_id) ON DELETE CASCADE,
  UNIQUE(added_prompt_id),UNIQUE(session_id,position),UNIQUE(session_id,id)
);
CREATE TABLE search_content_dependencies (
  sequence INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES search_sessions(id),message_id TEXT,discovery_id TEXT,
  ref_kind TEXT NOT NULL CHECK(ref_kind IN ('thought','connection','response')),ref_id TEXT NOT NULL,
  FOREIGN KEY(session_id,message_id) REFERENCES search_messages(session_id,id) ON DELETE CASCADE,
  FOREIGN KEY(session_id,discovery_id) REFERENCES search_discoveries(session_id,id) ON DELETE CASCADE,
  CHECK((message_id IS NULL)!=(discovery_id IS NULL))
);
CREATE TABLE search_composer_contexts (
  id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES search_sessions(id),revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  state TEXT NOT NULL CHECK(state IN ('active','consumed','invalidated','discarded')),created_at TEXT NOT NULL
);
CREATE TABLE search_composer_dependencies (
  composer_id TEXT NOT NULL REFERENCES search_composer_contexts(id) ON DELETE CASCADE,
  ref_kind TEXT NOT NULL CHECK(ref_kind IN ('thought','connection','response')),ref_id TEXT NOT NULL,PRIMARY KEY(composer_id,ref_kind,ref_id)
);
CREATE INDEX search_sessions_activity ON search_sessions(last_activity_at DESC,sequence DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX search_turns_one_active ON search_turns(session_id) WHERE open_slot=1;
CREATE UNIQUE INDEX search_message_dependency ON search_content_dependencies(message_id,ref_kind,ref_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX search_discovery_dependency ON search_content_dependencies(discovery_id,ref_kind,ref_id) WHERE discovery_id IS NOT NULL;
CREATE INDEX search_dependency_reverse ON search_content_dependencies(ref_kind,ref_id,session_id);
CREATE INDEX search_composer_session ON search_composer_contexts(session_id);
CREATE INDEX search_composer_dependency_reverse ON search_composer_dependencies(ref_kind,ref_id,composer_id);
CREATE INDEX run_context_reverse ON run_context(kind,ref_id,run_id);
CREATE TRIGGER thoughts_immutable_update BEFORE UPDATE ON thoughts
BEGIN SELECT RAISE(ABORT,'thoughts are immutable'); END;
CREATE TRIGGER agent_bindings_immutable_update BEFORE UPDATE ON agent_bindings
BEGIN SELECT RAISE(ABORT,'agent binding immutable'); END;
CREATE TRIGGER run_steps_identity_immutable BEFORE UPDATE OF run_id,position,prompt_id ON run_steps
BEGIN SELECT RAISE(ABORT,'step identity immutable'); END;
CREATE TRIGGER run_steps_input_immutable BEFORE UPDATE OF input ON run_steps
WHEN OLD.input IS NOT NULL OR NEW.input IS NULL OR OLD.state!='prepared' OR OLD.native_state!='unknown'
BEGIN SELECT RAISE(ABORT,'step input immutable'); END;
CREATE TRIGGER search_turns_owner BEFORE INSERT ON search_turns
WHEN NOT EXISTS (SELECT 1 FROM runs r JOIN search_sessions s ON s.id=NEW.session_id
  WHERE r.id=NEW.run_id AND r.kind='search' AND r.input_thought_id IS NULL
    AND r.weave_subject_id IS NULL AND r.weave_trigger_id IS NULL AND s.deleted_at IS NULL
    AND NEW.open_slot=(r.status IN ('queued','submitting','running','uncertain')))
  OR NEW.position!=COALESCE((SELECT MAX(position)+1 FROM search_turns WHERE session_id=NEW.session_id),0)
BEGIN SELECT RAISE(ABORT,'search turn requires its live search owner and ordered slot'); END;
CREATE TRIGGER search_bindings_live_insert BEFORE INSERT ON agent_bindings
WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='search' AND NOT EXISTS (
  SELECT 1 FROM runs r JOIN search_turns t ON t.run_id=r.id JOIN search_sessions s ON s.id=t.session_id
  WHERE r.id=NEW.run_id AND r.kind='search' AND s.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'search binding requires a live owner'); END;
CREATE TRIGGER search_submit_owner_insert BEFORE INSERT ON run_steps
WHEN NEW.submit_owner IS NOT NULL
BEGIN SELECT RAISE(ABORT,'submission owner requires existing search authorization'); END;
CREATE TRIGGER search_submit_owner_once BEFORE UPDATE OF submit_owner ON run_steps
WHEN OLD.submit_owner IS NOT NULL OR NEW.submit_owner IS NULL OR length(NEW.submit_owner)=0
  OR OLD.state!='prepared' OR NEW.state!='submitting' OR NEW.input IS NULL OR NEW.native_state!='unknown'
  OR NOT EXISTS (SELECT 1 FROM runs r JOIN search_turns t ON t.run_id=r.id JOIN search_sessions s ON s.id=t.session_id
    WHERE r.id=OLD.run_id AND r.kind='search' AND s.deleted_at IS NULL)
  OR NOT EXISTS (SELECT 1 FROM agent_bindings WHERE run_id=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'submission owner is assigned once with search authorization'); END;
CREATE TRIGGER search_messages_identity_immutable BEFORE UPDATE OF rowid,_rowid_,oid,id,session_id,run_id,position,role,text,created_at,disposition,evidence_json ON search_messages
BEGIN SELECT RAISE(ABORT,'search record immutable'); END;
CREATE TRIGGER search_composer_contexts_identity_immutable BEFORE UPDATE OF rowid,_rowid_,oid,id,session_id,created_at ON search_composer_contexts
BEGIN SELECT RAISE(ABORT,'search record immutable'); END;
INSERT INTO thoughts(rowid,id,text,author,kind,created_at,origin,parent_id,import_document_id)
  VALUES(17,'fixture-thought','owned legacy café','user','captured-original','2030-01-01T12:00:00.000Z','fixture',NULL,NULL);
INSERT INTO thought_titles(rowid,thought_id,title,title_author) VALUES(19,'fixture-thought','legacy','user');
INSERT INTO thought_source_seals(rowid,thought_id) VALUES(23,'fixture-thought');
INSERT INTO import_namespaces(rowid,id,kind,label,created_at)
  VALUES(29,'legacy-loose','loose-markdown','Legacy loose Markdown','2030-01-01T12:00:00.000Z');
INSERT INTO search_sessions(sequence,id,create_request_key,title,created_at,last_activity_at,revision)
  VALUES(31,'legacy-session','legacy-session','Legacy search','2030-01-01T12:00:00.000Z','2030-01-01T12:00:00.000Z',1);
INSERT INTO search_composer_contexts(rowid,id,session_id,revision,state,created_at)
  VALUES(37,'legacy-composer','legacy-session',0,'consumed','2030-01-01T12:00:00.000Z'),
    (38,'legacy-draft','legacy-session',1,'active','2030-01-01T12:00:00.000Z');
-- Admission consumed the first composer and removed its draft dependencies. A separate active draft retains its own.
INSERT INTO search_composer_dependencies(rowid,composer_id,ref_kind,ref_id) VALUES(39,'legacy-draft','thought','fixture-thought');
INSERT INTO runs(rowid,id,kind,status,session_id,prompt_id,created_at,generation)
  VALUES(41,'legacy-search-run','search','queued','legacy-native-session','legacy-prompt','2030-01-01T12:00:00.000Z',0);
INSERT INTO run_steps(rowid,run_id,position,prompt_id,state,native_state)
  VALUES(43,'legacy-search-run',0,'legacy-prompt','prepared','unknown');
INSERT INTO search_turns(rowid,run_id,session_id,position,request_key,admitted_at,effort,context_mode,intent_json)
  VALUES(47,'legacy-search-run','legacy-session',0,'legacy-turn','2030-01-01T12:00:00.000Z','standard','continue',
    '{"version":1,"startingThoughtIds":["fixture-thought"],"requestClock":{"at":"2030-01-01T12:00:00Z","timeZone":"UTC"},"daemonObservedAt":"2030-01-01T12:00:00.000Z","contextMode":"continue","composerId":"legacy-composer","contextToken":"fixture-retained-context-not-execution-authority","verifiedContext":{"sessionId":"legacy-session","composerId":"legacy-composer","composerRevision":0,"eligibilityRevision":0}}');
INSERT INTO search_messages(rowid,id,session_id,run_id,position,role,text,created_at,evidence_json)
  VALUES(53,'legacy-user','legacy-session','legacy-search-run',0,'user','exact legacy question','2030-01-01T12:00:00.000Z','[]');
INSERT INTO search_content_dependencies(sequence,session_id,message_id,ref_kind,ref_id)
  VALUES(59,'legacy-session','legacy-user','thought','fixture-thought');
INSERT INTO run_context(rowid,run_id,kind,ref_id,full_read) VALUES(61,'legacy-search-run','thought','fixture-thought',0);
INSERT INTO agent_bindings(rowid,run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version)
  VALUES(67,'legacy-search-run','legacy-native-session','http://127.0.0.1:44991','/owned','{}','[]',1);
-- Exercise the historical write-once authorization guard, not a modern registry or test-granted capability.
UPDATE run_steps SET input='legacy exact journal café',state='submitting',submit_owner='legacy-unqualified-owner' WHERE run_id='legacy-search-run';
UPDATE runs SET status='uncertain' WHERE id='legacy-search-run';
COMMIT;
