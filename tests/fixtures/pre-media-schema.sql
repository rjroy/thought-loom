-- Frozen pre-media definitions from bb2de6e: selected populated knowledge/run/search
-- closure, including the real import-document/seal and thought/part FK cycles.
-- Do not regenerate this fixture through the migration under test.
PRAGMA foreign_keys=ON;
PRAGMA recursive_triggers=ON;
CREATE TABLE thoughts (
  id TEXT PRIMARY KEY NOT NULL, text TEXT NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('user','ai','source')),
  kind TEXT NOT NULL CHECK(kind IN ('captured-original','user-contribution','ai-interpretation','developing-idea','imported-original')),
  created_at TEXT NOT NULL, origin TEXT NOT NULL, parent_id TEXT REFERENCES thoughts(id),
  import_document_id TEXT REFERENCES import_document_seals(document_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(import_document_id,id), CHECK(parent_id IS NULL OR parent_id!=id),
  CHECK((kind='imported-original')=(author='source')),
  CHECK((kind='imported-original')=(import_document_id IS NOT NULL)),
  CHECK(kind!='imported-original' OR (origin='markdown-import' AND parent_id IS NULL))
);
CREATE TABLE thought_titles (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id),title TEXT,
  title_author TEXT CHECK(title_author IN ('user','ai')),
  CHECK((title IS NULL AND title_author IS NULL) OR (title IS NOT NULL AND title_author IS NOT NULL)));
CREATE TABLE thought_sources (thought_id TEXT NOT NULL REFERENCES thoughts(id),position INTEGER NOT NULL,
  source_id TEXT NOT NULL REFERENCES thoughts(id),PRIMARY KEY(thought_id,position));
CREATE TABLE thought_source_seals (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id));
CREATE TABLE import_namespaces (id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE import_documents (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL REFERENCES import_document_seals(document_id) DEFERRABLE INITIALLY DEFERRED,
  original_bytes BLOB NOT NULL CHECK(typeof(original_bytes)='blob'),sha256 BLOB NOT NULL CHECK(typeof(sha256)='blob' AND length(sha256)=32),
  byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length>=0 AND byte_length<=9007199254740991 AND length(original_bytes)=byte_length),
  encoding TEXT NOT NULL CHECK(encoding='utf-8'),original_namespace_id TEXT NOT NULL REFERENCES import_namespaces(id),original_path TEXT NOT NULL,
  created_at TEXT NOT NULL,parser_version TEXT NOT NULL,segmentation_method TEXT NOT NULL CHECK(segmentation_method IN ('ai','structural','not-needed')),
  segmentation_reason TEXT,UNIQUE(sha256,byte_length),CHECK((segmentation_method='structural')=(segmentation_reason IS NOT NULL))
);
CREATE TABLE import_document_seals (document_id TEXT PRIMARY KEY NOT NULL REFERENCES import_documents(id));
CREATE TABLE import_locations (namespace_id TEXT NOT NULL REFERENCES import_namespaces(id),relative_path TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES import_documents(id),PRIMARY KEY(namespace_id,relative_path));
CREATE TABLE import_document_parts (
  document_id TEXT NOT NULL REFERENCES import_documents(id),position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0 AND position<=9007199254740991),
  kind TEXT NOT NULL CHECK(kind IN ('thought','separator','frontmatter','bom')),
  start_byte INTEGER NOT NULL CHECK(typeof(start_byte)='integer' AND start_byte>=0 AND start_byte<=9007199254740991),
  end_byte INTEGER NOT NULL CHECK(typeof(end_byte)='integer' AND end_byte>start_byte AND end_byte<=9007199254740991),
  thought_id TEXT UNIQUE REFERENCES thoughts(id),thought_ordinal INTEGER,PRIMARY KEY(document_id,position),UNIQUE(document_id,thought_ordinal),
  FOREIGN KEY(document_id,thought_id) REFERENCES thoughts(import_document_id,id),
  CHECK((kind='thought' AND thought_id IS NOT NULL AND typeof(thought_ordinal)='integer' AND thought_ordinal>=0 AND thought_ordinal<=9007199254740991)
    OR (kind!='thought' AND thought_id IS NULL AND thought_ordinal IS NULL))
);
CREATE TABLE responses (id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('addendum','fallback')),
  state TEXT NOT NULL CHECK(state IN ('complete','interrupted')));
CREATE TABLE response_thoughts (response_id TEXT NOT NULL REFERENCES responses(id),thought_id TEXT NOT NULL REFERENCES thoughts(id),
  position INTEGER NOT NULL CHECK(position>=0),PRIMARY KEY(response_id,position),UNIQUE(response_id,thought_id));
CREATE TABLE response_seals (response_id TEXT PRIMARY KEY NOT NULL REFERENCES responses(id));
CREATE TABLE rejected_thoughts (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id));
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('weave','evolve','export','import','search')),
  status TEXT NOT NULL CHECK(status IN ('queued','submitting','running','uncertain','completed','interrupted','failed')),
  session_id TEXT UNIQUE NOT NULL,prompt_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=0),
  input_thought_id TEXT REFERENCES thoughts(id),weave_subject_id TEXT REFERENCES thoughts(id),weave_trigger_id TEXT,
  cancellation_state TEXT NOT NULL DEFAULT 'none' CHECK(cancellation_state IN ('none','pending','settled')),
  CHECK(kind='evolve' OR input_thought_id IS NULL),CHECK((weave_subject_id IS NULL)=(weave_trigger_id IS NULL)),CHECK(weave_subject_id IS NULL OR kind='weave')
);
CREATE TABLE run_steps (
  run_id TEXT NOT NULL REFERENCES runs(id),position INTEGER NOT NULL CHECK(position>=0),prompt_id TEXT UNIQUE NOT NULL,
  input TEXT CHECK(input IS NULL OR length(input)>0),state TEXT NOT NULL CHECK(state IN ('prepared','submitting','uncertain','completed','processed')),
  native_state TEXT NOT NULL DEFAULT 'unknown' CHECK(native_state IN ('unknown','running','completed')),envelope_json TEXT,result_json TEXT,submit_owner TEXT,
  PRIMARY KEY(run_id,position),CHECK(state!='processed' OR (envelope_json IS NOT NULL AND result_json IS NOT NULL)),
  CHECK(envelope_json IS NULL OR state IN ('completed','processed')),
  CHECK(result_json IS NULL OR (state IN ('completed','processed') AND envelope_json IS NOT NULL)
    OR (json_valid(result_json) AND COALESCE(json_extract(result_json,'$.type')='import-partition',0))),
  CHECK((native_state='completed')=(state IN ('completed','processed')))
);
CREATE TABLE run_context (run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL CHECK(kind IN ('thought','connection','response')),
  ref_id TEXT NOT NULL,full_read INTEGER NOT NULL DEFAULT 0 CHECK(full_read IN (0,1)),PRIMARY KEY(run_id,kind,ref_id));
CREATE TABLE run_operation_receipts (run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT NOT NULL,operation_json TEXT NOT NULL,
  thought_id TEXT REFERENCES thoughts(id),result_json TEXT NOT NULL,format TEXT NOT NULL DEFAULT 'legacy' CHECK(format IN ('legacy','step')),
  PRIMARY KEY(run_id,operation_id),UNIQUE(run_id,operation_id,thought_id),CHECK(format!='legacy' OR thought_id IS NOT NULL));
CREATE TABLE run_issued_thoughts (run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT NOT NULL,thought_id TEXT NOT NULL REFERENCES thoughts(id),
  position INTEGER NOT NULL CHECK(position>=0),PRIMARY KEY(run_id,position),UNIQUE(run_id,operation_id),UNIQUE(run_id,thought_id),
  FOREIGN KEY(run_id,operation_id,thought_id) REFERENCES run_operation_receipts(run_id,operation_id,thought_id));
CREATE TABLE run_replies (run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),draft_json TEXT,response_id TEXT REFERENCES responses(id));
CREATE TABLE execution_owners (id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),database_identity TEXT NOT NULL CHECK(length(database_identity)>0),
  lease_protocol TEXT NOT NULL CHECK(length(lease_protocol)>0));
CREATE TABLE agent_bindings (run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),session_id TEXT UNIQUE NOT NULL,service_url TEXT NOT NULL,
  directory TEXT NOT NULL,model_json TEXT NOT NULL,permissions_json TEXT NOT NULL,protocol_version INTEGER NOT NULL CHECK(protocol_version=1),
  execution_owner_id TEXT REFERENCES execution_owners(id));
CREATE TABLE search_sessions (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,create_request_key TEXT UNIQUE NOT NULL,
  title TEXT,created_at TEXT NOT NULL,last_activity_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),deleted_at TEXT,
  CHECK((deleted_at IS NULL AND title IS NOT NULL AND length(title)>0) OR (deleted_at IS NOT NULL AND title IS NULL)));
CREATE TABLE search_turns (run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES search_sessions(id),
  position INTEGER NOT NULL CHECK(position>=0),request_key TEXT NOT NULL,admitted_at TEXT NOT NULL,effort TEXT NOT NULL CHECK(effort IN ('quick','standard','thorough')),
  context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','restart')),intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
  open_slot INTEGER NOT NULL DEFAULT 1 CHECK(open_slot IN (0,1)),outcome_reason TEXT,
  UNIQUE(session_id,position),UNIQUE(session_id,request_key),UNIQUE(session_id,run_id));
CREATE TABLE search_messages (id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),text TEXT NOT NULL CHECK(length(text)>0),created_at TEXT NOT NULL,
  disposition TEXT CHECK(disposition IN ('awaiting-user','done')),evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(session_id,run_id) REFERENCES search_turns(session_id,run_id) ON DELETE CASCADE,
  UNIQUE(session_id,position),UNIQUE(run_id,role),UNIQUE(session_id,id),
  CHECK((role='user' AND disposition IS NULL) OR (role='assistant' AND disposition IS NOT NULL)));
CREATE TABLE fixture_incoming (id TEXT PRIMARY KEY,thought_id TEXT NOT NULL REFERENCES thoughts(id),payload BLOB NOT NULL);
CREATE INDEX fixture_incoming_thought ON fixture_incoming(thought_id);
CREATE TRIGGER fixture_thought_immutable BEFORE UPDATE ON thoughts BEGIN SELECT RAISE(ABORT,'frozen thought immutable'); END;
