import type { Database } from "bun:sqlite";

/** Table phase for the FK-closure rebuild; migrate installs all guards before returning. */
export function createImportTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_namespaces (
      id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS import_loose_namespace ON import_namespaces(kind) WHERE kind='loose-markdown';
    CREATE TABLE IF NOT EXISTS import_documents (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL
        REFERENCES import_document_seals(document_id) DEFERRABLE INITIALLY DEFERRED,
      original_bytes BLOB NOT NULL CHECK(typeof(original_bytes)='blob'),
      sha256 BLOB NOT NULL CHECK(typeof(sha256)='blob' AND length(sha256)=32),
      byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length>=0 AND byte_length<=9007199254740991 AND length(original_bytes)=byte_length),
      encoding TEXT NOT NULL CHECK(encoding='utf-8'),
      original_namespace_id TEXT NOT NULL REFERENCES import_namespaces(id), original_path TEXT NOT NULL,
      created_at TEXT NOT NULL, parser_version TEXT NOT NULL,
      segmentation_method TEXT NOT NULL CHECK(segmentation_method IN ('ai','structural','not-needed')),
      segmentation_reason TEXT,
      UNIQUE(sha256,byte_length),
      CHECK((segmentation_method='structural')=(segmentation_reason IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS import_locations (
      namespace_id TEXT NOT NULL REFERENCES import_namespaces(id), relative_path TEXT NOT NULL,
      document_id TEXT NOT NULL REFERENCES import_documents(id), PRIMARY KEY(namespace_id,relative_path)
    );
    CREATE INDEX IF NOT EXISTS import_locations_document ON import_locations(document_id);
    CREATE TABLE IF NOT EXISTS import_document_parts (
      document_id TEXT NOT NULL REFERENCES import_documents(id),
      position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0 AND position<=9007199254740991),
      kind TEXT NOT NULL CHECK(kind IN ('thought','separator','frontmatter','bom')),
      start_byte INTEGER NOT NULL CHECK(typeof(start_byte)='integer' AND start_byte>=0 AND start_byte<=9007199254740991),
      end_byte INTEGER NOT NULL CHECK(typeof(end_byte)='integer' AND end_byte>start_byte AND end_byte<=9007199254740991),
      thought_id TEXT UNIQUE REFERENCES thoughts(id), thought_ordinal INTEGER,
      PRIMARY KEY(document_id,position), UNIQUE(document_id,thought_ordinal),
      FOREIGN KEY(document_id,thought_id) REFERENCES thoughts(import_document_id,id),
      CHECK((kind='thought' AND thought_id IS NOT NULL AND typeof(thought_ordinal)='integer' AND thought_ordinal>=0 AND thought_ordinal<=9007199254740991)
        OR (kind!='thought' AND thought_id IS NULL AND thought_ordinal IS NULL))
    );
    CREATE TABLE IF NOT EXISTS import_document_seals (
      document_id TEXT PRIMARY KEY NOT NULL REFERENCES import_documents(id)
    );
    CREATE TABLE IF NOT EXISTS markdown_imports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, request_key TEXT UNIQUE NOT NULL,
      namespace_id TEXT NOT NULL REFERENCES import_namespaces(id), created_at TEXT NOT NULL, sealed_at TEXT,
      UNIQUE(id,namespace_id)
    );
    CREATE TABLE IF NOT EXISTS markdown_import_files (
      id TEXT PRIMARY KEY NOT NULL, import_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0 AND position<=9007199254740991),
      request_key TEXT NOT NULL, relative_path TEXT NOT NULL,
      sha256 BLOB NOT NULL CHECK(typeof(sha256)='blob' AND length(sha256)=32),
      byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length>=0 AND byte_length<=9007199254740991),
      created_at TEXT NOT NULL, run_id TEXT UNIQUE REFERENCES runs(id),
      waiting_on_file_id TEXT REFERENCES markdown_import_files(id),
      outcome TEXT CHECK(outcome IN ('imported','skipped-identical','skipped-changed','failed','interrupted')),
      document_id TEXT REFERENCES import_documents(id), reason_code TEXT,
      FOREIGN KEY(import_id,namespace_id) REFERENCES markdown_imports(id,namespace_id),
      UNIQUE(import_id,position), UNIQUE(import_id,request_key),
      CHECK(waiting_on_file_id IS NULL OR (waiting_on_file_id!=id AND run_id IS NULL)),
      CHECK(outcome IS NOT NULL OR run_id IS NOT NULL OR waiting_on_file_id IS NOT NULL),
      CHECK(COALESCE(outcome IN ('imported','skipped-identical','skipped-changed'),0)=(document_id IS NOT NULL)),
      CHECK(COALESCE(outcome IN ('failed','interrupted'),0)=(reason_code IS NOT NULL)),
      CHECK(outcome!='imported' OR run_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS import_pending_locator_lookup ON markdown_import_files(namespace_id,relative_path)
      WHERE outcome IS NULL AND waiting_on_file_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS import_pending_digest ON markdown_import_files(sha256,byte_length)
      WHERE outcome IS NULL AND waiting_on_file_id IS NULL;
    CREATE INDEX IF NOT EXISTS import_waiters ON markdown_import_files(waiting_on_file_id) WHERE outcome IS NULL;
    CREATE TABLE IF NOT EXISTS markdown_import_payloads (
      file_id TEXT PRIMARY KEY NOT NULL REFERENCES markdown_import_files(id), bytes BLOB NOT NULL CHECK(typeof(bytes)='blob')
    );
  `);
}

/** Canonical source artifacts and subordinate admission receipts; no worker or HTTP initialization. */
export function createImportSchema(db: Database): void {
  createImportTables(db);
  for (const [table,key] of [
    ["import_namespaces","id"], ["import_documents","id"], ["import_document_seals","document_id"],
  ] as const) immutable(db,table,`${key}=NEW.${key}`);
  immutable(db,"import_locations","namespace_id=NEW.namespace_id AND relative_path=NEW.relative_path");
  immutable(db,"import_document_parts","document_id=NEW.document_id AND position=NEW.position");
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS imports_thought_not_late BEFORE INSERT ON thoughts
    WHEN NEW.import_document_id IS NOT NULL AND EXISTS(SELECT 1 FROM import_document_seals WHERE document_id=NEW.import_document_id)
    BEGIN SELECT RAISE(ABORT,'import membership sealed'); END;
    CREATE TRIGGER IF NOT EXISTS imports_no_supporting_sources BEFORE INSERT ON thought_sources
    WHEN EXISTS(SELECT 1 FROM thoughts WHERE id=NEW.thought_id AND kind='imported-original')
    BEGIN SELECT RAISE(ABORT,'imported original cannot have supporting sources'); END;
    CREATE TRIGGER IF NOT EXISTS imports_parts_not_late BEFORE INSERT ON import_document_parts
    WHEN EXISTS(SELECT 1 FROM import_document_seals WHERE document_id=NEW.document_id)
    BEGIN SELECT RAISE(ABORT,'import parts sealed'); END;
    CREATE TRIGGER IF NOT EXISTS imports_parts_bounds BEFORE INSERT ON import_document_parts
    WHEN NEW.end_byte>(SELECT byte_length FROM import_documents WHERE id=NEW.document_id)
    BEGIN SELECT RAISE(ABORT,'import part outside original bytes'); END;
    CREATE TRIGGER IF NOT EXISTS imports_seal_complete BEFORE INSERT ON import_document_seals BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM import_documents d JOIN import_namespaces n ON n.id=d.original_namespace_id
        WHERE d.id=NEW.document_id AND n.kind!='loose-markdown') AND NOT EXISTS(SELECT 1 FROM import_documents d JOIN import_locations l
        ON l.document_id=d.id AND l.namespace_id=d.original_namespace_id AND l.relative_path=d.original_path
        WHERE d.id=NEW.document_id) THEN RAISE(ABORT,'import original locator missing') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM import_documents d WHERE d.id=NEW.document_id AND
        ((d.byte_length=0 AND EXISTS(SELECT 1 FROM import_document_parts WHERE document_id=d.id)) OR
        (d.byte_length>0 AND NOT EXISTS(SELECT 1 FROM import_document_parts WHERE document_id=d.id AND position=0 AND start_byte=0)) OR
        (d.byte_length>0 AND d.byte_length IS NOT (SELECT end_byte FROM import_document_parts WHERE document_id=d.id ORDER BY position DESC LIMIT 1))))
        THEN RAISE(ABORT,'import map must cover original bytes') END;
      SELECT CASE WHEN (SELECT count(*) FROM import_document_parts WHERE document_id=NEW.document_id)!=
          (SELECT COALESCE(MAX(position)+1,0) FROM import_document_parts WHERE document_id=NEW.document_id)
        OR EXISTS(SELECT 1 FROM import_document_parts p WHERE p.document_id=NEW.document_id AND
          p.position>0 AND p.start_byte IS NOT (SELECT end_byte FROM import_document_parts q WHERE q.document_id=p.document_id AND q.position=p.position-1))
        THEN RAISE(ABORT,'import map has gaps or overlaps') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM import_document_parts p JOIN import_documents d ON d.id=p.document_id
        WHERE d.id=NEW.document_id AND ((p.kind='bom' AND (p.position!=0 OR p.start_byte!=0 OR p.end_byte!=3 OR substr(d.original_bytes,1,3)!=x'efbbbf'))
          OR (p.kind='frontmatter' AND (p.start_byte!=CASE WHEN substr(d.original_bytes,1,3)=x'efbbbf' THEN 3 ELSE 0 END
            OR (substr(d.original_bytes,p.start_byte+1,4)!=x'2d2d2d0a' AND substr(d.original_bytes,p.start_byte+1,4)!=x'2d2d2d0d')))))
        THEN RAISE(ABORT,'import BOM or frontmatter placement invalid') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM import_documents d WHERE d.id=NEW.document_id AND substr(d.original_bytes,1,3)=x'efbbbf'
        AND NOT EXISTS(SELECT 1 FROM import_document_parts p WHERE p.document_id=d.id AND p.kind='bom'))
        OR (SELECT count(*) FROM import_document_parts WHERE document_id=NEW.document_id AND kind='frontmatter')>1
        THEN RAISE(ABORT,'import metadata map invalid') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM (SELECT *,row_number() OVER (ORDER BY position)-1 AS expected_ordinal
        FROM import_document_parts WHERE document_id=NEW.document_id AND kind='thought') p JOIN thoughts t ON t.id=p.thought_id
        JOIN import_documents d ON d.id=p.document_id LEFT JOIN thought_titles m ON m.thought_id=t.id
        WHERE p.document_id=NEW.document_id AND p.kind='thought' AND
          (t.import_document_id IS NOT d.id OR t.author!='source' OR t.kind!='imported-original' OR t.origin!='markdown-import' OR t.parent_id IS NOT NULL
          OR m.thought_id IS NULL OR m.title IS NOT NULL OR m.title_author IS NOT NULL
          OR NOT EXISTS(SELECT 1 FROM thought_source_seals WHERE thought_id=t.id)
          OR EXISTS(SELECT 1 FROM thought_sources WHERE thought_id=t.id)
          OR CAST(t.text AS BLOB)!=substr(d.original_bytes,p.start_byte+1,p.end_byte-p.start_byte)
          OR p.thought_ordinal!=p.expected_ordinal))
        THEN RAISE(ABORT,'import thought mapping invalid') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM thoughts t WHERE t.import_document_id=NEW.document_id
        AND NOT EXISTS(SELECT 1 FROM import_document_parts p WHERE p.document_id=NEW.document_id AND p.thought_id=t.id AND p.kind='thought'))
        THEN RAISE(ABORT,'import thought missing mapping') END;
      SELECT CASE WHEN (SELECT segmentation_method='not-needed' FROM import_documents WHERE id=NEW.document_id)!=
        (NOT EXISTS(SELECT 1 FROM import_document_parts WHERE document_id=NEW.document_id AND kind='thought'))
        THEN RAISE(ABORT,'import segmentation method disagrees with thought count') END;
    END;
    CREATE TRIGGER IF NOT EXISTS imports_batch_identity BEFORE UPDATE OF id,request_key,namespace_id,created_at,sequence ON markdown_imports
    BEGIN SELECT RAISE(ABORT,'import batch identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS imports_batch_seal_once BEFORE UPDATE OF sealed_at ON markdown_imports
    WHEN OLD.sealed_at IS NOT NULL OR NEW.sealed_at IS NULL
    BEGIN SELECT RAISE(ABORT,'import batch seal immutable'); END;
    CREATE TRIGGER IF NOT EXISTS imports_batch_no_delete BEFORE DELETE ON markdown_imports
    BEGIN SELECT RAISE(ABORT,'import batch immutable'); END;
    CREATE TRIGGER IF NOT EXISTS imports_batch_no_replace BEFORE INSERT ON markdown_imports
    WHEN EXISTS(SELECT 1 FROM markdown_imports WHERE id=NEW.id OR request_key=NEW.request_key)
    BEGIN SELECT RAISE(ABORT,'import batch immutable'); END;
    CREATE TRIGGER IF NOT EXISTS imports_file_admission BEFORE INSERT ON markdown_import_files BEGIN
      SELECT CASE WHEN (SELECT sealed_at FROM markdown_imports WHERE id=NEW.import_id) IS NOT NULL
        THEN RAISE(ABORT,'import batch sealed') END;
      SELECT CASE WHEN NEW.position!=COALESCE((SELECT MAX(position)+1 FROM markdown_import_files WHERE import_id=NEW.import_id),0)
        THEN RAISE(ABORT,'import files must follow admission order') END;
    END;
    CREATE TRIGGER IF NOT EXISTS imports_pending_locator_insert BEFORE INSERT ON markdown_import_files
    WHEN NEW.outcome IS NULL AND NEW.waiting_on_file_id IS NULL
      AND (SELECT kind FROM import_namespaces WHERE id=NEW.namespace_id)!='loose-markdown'
      AND EXISTS(SELECT 1 FROM markdown_import_files WHERE namespace_id=NEW.namespace_id AND relative_path=NEW.relative_path AND outcome IS NULL AND waiting_on_file_id IS NULL)
    BEGIN SELECT RAISE(ABORT,'import pending locator reserved'); END;
    CREATE TRIGGER IF NOT EXISTS imports_pending_locator_update BEFORE UPDATE OF run_id,waiting_on_file_id,outcome ON markdown_import_files
    WHEN NEW.outcome IS NULL AND NEW.waiting_on_file_id IS NULL
      AND (SELECT kind FROM import_namespaces WHERE id=NEW.namespace_id)!='loose-markdown'
      AND EXISTS(SELECT 1 FROM markdown_import_files WHERE id!=NEW.id AND namespace_id=NEW.namespace_id AND relative_path=NEW.relative_path AND outcome IS NULL AND waiting_on_file_id IS NULL)
    BEGIN SELECT RAISE(ABORT,'import pending locator reserved'); END;
    CREATE TRIGGER IF NOT EXISTS imports_file_identity BEFORE UPDATE OF id,import_id,namespace_id,position,request_key,relative_path,sha256,byte_length,created_at ON markdown_import_files
    BEGIN SELECT RAISE(ABORT,'import file identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS imports_file_transition BEFORE UPDATE OF run_id,waiting_on_file_id,outcome,document_id,reason_code ON markdown_import_files
    WHEN OLD.outcome IS NOT NULL OR (OLD.run_id IS NOT NULL AND (NEW.run_id IS NOT OLD.run_id OR NEW.waiting_on_file_id IS NOT NULL))
      OR (OLD.run_id IS NULL AND NEW.run_id IS NULL AND NEW.outcome IS NULL AND NEW.waiting_on_file_id IS NULL)
    BEGIN SELECT RAISE(ABORT,'invalid import file transition'); END;
    CREATE TRIGGER IF NOT EXISTS imports_file_no_delete BEFORE DELETE ON markdown_import_files
    BEGIN SELECT RAISE(ABORT,'import file immutable'); END;
    CREATE TRIGGER IF NOT EXISTS imports_file_no_replace BEFORE INSERT ON markdown_import_files
    WHEN EXISTS(SELECT 1 FROM markdown_import_files WHERE id=NEW.id OR (import_id=NEW.import_id AND (position=NEW.position OR request_key=NEW.request_key)))
    BEGIN SELECT RAISE(ABORT,'import file immutable'); END;
    CREATE TRIGGER IF NOT EXISTS imports_payload_valid BEFORE INSERT ON markdown_import_payloads
    WHEN NOT EXISTS(SELECT 1 FROM markdown_import_files WHERE id=NEW.file_id AND outcome IS NULL AND byte_length=length(NEW.bytes))
      OR EXISTS(SELECT 1 FROM markdown_import_payloads WHERE file_id=NEW.file_id)
    BEGIN SELECT RAISE(ABORT,'invalid import staging payload'); END;
    CREATE TRIGGER IF NOT EXISTS imports_payload_immutable BEFORE UPDATE ON markdown_import_payloads
    BEGIN SELECT RAISE(ABORT,'import staging payload immutable'); END;
    CREATE TRIGGER IF NOT EXISTS imports_payload_terminal_delete BEFORE DELETE ON markdown_import_payloads
    WHEN EXISTS(SELECT 1 FROM markdown_import_files WHERE id=OLD.file_id AND outcome IS NULL)
    BEGIN SELECT RAISE(ABORT,'pending import staging payload required'); END;
    CREATE TRIGGER IF NOT EXISTS imports_step_result_insert BEFORE INSERT ON run_steps
    WHEN NEW.result_json IS NOT NULL AND (json_extract(NEW.result_json,'$.type')='import-partition' OR (SELECT kind FROM runs WHERE id=NEW.run_id)='import')
    BEGIN SELECT RAISE(ABORT,'import partition requires an existing owned initial step'); END;
    CREATE TRIGGER IF NOT EXISTS imports_step_result_update BEFORE UPDATE OF result_json ON run_steps
    WHEN NEW.result_json IS NOT NULL AND ((json_extract(NEW.result_json,'$.type')='import-partition' AND NOT EXISTS(
      SELECT 1 FROM runs r JOIN markdown_import_files f ON f.run_id=r.id WHERE r.id=NEW.run_id AND r.kind='import'
        AND f.outcome IS NULL AND f.waiting_on_file_id IS NULL AND NEW.position=0 AND NEW.input IS NOT NULL
        AND json_extract(NEW.result_json,'$.fileId')=f.id)) OR
      ((SELECT kind FROM runs WHERE id=NEW.run_id)='import' AND json_extract(NEW.result_json,'$.type') IS NOT 'import-partition'))
    BEGIN SELECT RAISE(ABORT,'import partition requires its owning import file'); END;
    CREATE TRIGGER IF NOT EXISTS imports_no_context BEFORE INSERT ON run_context
    WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='import'
    BEGIN SELECT RAISE(ABORT,'import cannot access library context'); END;
    CREATE TRIGGER IF NOT EXISTS imports_no_receipts BEFORE INSERT ON run_operation_receipts
    WHEN (SELECT kind FROM runs WHERE id=NEW.run_id)='import'
    BEGIN SELECT RAISE(ABORT,'import cannot issue developments'); END;
  `);
  for (const event of ["INSERT","UPDATE OF envelope_json"] as const) db.exec(`
    CREATE TRIGGER IF NOT EXISTS imports_envelope_${event === 'INSERT' ? 'insert' : 'update'} BEFORE ${event} ON run_steps
    WHEN NEW.envelope_json IS NOT NULL AND (((SELECT kind FROM runs WHERE id=NEW.run_id)='import') !=
      COALESCE(json_extract(NEW.envelope_json,'$.kind')='segmentation',0))
    BEGIN SELECT RAISE(ABORT,'segmentation envelope requires import authority only'); END;`);
  for (const event of ["INSERT","UPDATE OF run_id,waiting_on_file_id"] as const) db.exec(`
    CREATE TRIGGER IF NOT EXISTS imports_file_owner_${event === 'INSERT' ? 'insert' : 'update'} BEFORE ${event} ON markdown_import_files BEGIN
      SELECT CASE WHEN NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND kind='import' AND input_thought_id IS NULL AND weave_subject_id IS NULL)
        THEN RAISE(ABORT,'import file requires import run') END;
      SELECT CASE WHEN NEW.waiting_on_file_id IS NOT NULL AND ${event === "INSERT" ? "1" : "NEW.waiting_on_file_id IS NOT OLD.waiting_on_file_id"}
        AND NOT EXISTS(SELECT 1 FROM markdown_import_files WHERE id=NEW.waiting_on_file_id AND outcome IS NULL AND run_id IS NOT NULL AND waiting_on_file_id IS NULL)
        THEN RAISE(ABORT,'import waiter requires pending holder') END;
    END;`);
}

function immutable(db: Database, table: string, conflict: string): void {
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_insert BEFORE INSERT ON ${table}
    WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${conflict}) BEGIN SELECT RAISE(ABORT,'import artifact immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'import artifact immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'import artifact immutable'); END;`);
}
