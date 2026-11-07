import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { immediate } from "../src/storage/transaction";
import { initializeSqlMediaStore, insertMediaSource, mediaDigest, mediaStoreId, mediaThought, mediaTime,
  requireMediaSchema, requireMediaWriter } from "./fixtures/media-source";

const frozenTables = ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "import_namespaces",
  "import_documents", "import_document_seals", "import_document_parts", "import_locations", "responses", "response_thoughts",
  "response_seals", "rejected_thoughts", "runs", "run_steps", "run_context", "run_operation_receipts", "run_issued_thoughts",
  "run_replies", "agent_bindings", "execution_owners", "search_sessions", "search_turns", "search_messages", "fixture_incoming"];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const frozenBytes = new Uint8Array(Buffer.from("efbbbf436166c3a90d0ae6bca2e5ad970d0a", "hex"));

function seedFrozen(db: Database): void {
  db.exec(readFileSync(new URL("./fixtures/pre-media-schema.sql", import.meta.url), "utf8"));
  immediate(db, () => {
    db.exec(`INSERT INTO import_namespaces VALUES ('loose-fixture','loose-markdown','Fixture','2030');
      INSERT INTO thoughts(rowid,id,text,author,kind,created_at,origin,parent_id,import_document_id) VALUES
        (7,'legacy-root','original zircon','user','captured-original','2030','capture',NULL,NULL),
        (19,'legacy-import',CAST(x'436166c3a90d0ae6bca2e5ad970d0a' AS TEXT),'source','imported-original','2030','markdown-import',NULL,'legacy-document'),
        (29,'legacy-child','interpretation wording','ai','ai-interpretation','2031','weave','legacy-root',NULL);
      INSERT INTO thought_titles VALUES ('legacy-root','Original title','user'),('legacy-import',NULL,NULL),('legacy-child',NULL,NULL);
      INSERT INTO thought_sources VALUES ('legacy-child',0,'legacy-import');
      INSERT INTO thought_source_seals VALUES ('legacy-root'),('legacy-import'),('legacy-child');`);
    db.run(`INSERT INTO import_documents(sequence,id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,
      created_at,parser_version,segmentation_method,segmentation_reason) VALUES (13,'legacy-document',?,?,?,'utf-8','loose-fixture',
      'markdownfilenamevault.md','2030','frozen-parser','structural','ai-unconfigured')`,
    [frozenBytes, new Uint8Array(createHash("sha256").update(frozenBytes).digest()), frozenBytes.length]);
    db.exec(`INSERT INTO import_document_parts(rowid,document_id,position,kind,start_byte,end_byte,thought_id,thought_ordinal) VALUES
      (41,'legacy-document',0,'bom',0,3,NULL,NULL),(47,'legacy-document',1,'thought',3,18,'legacy-import',0);
      INSERT INTO import_document_seals VALUES ('legacy-document');
      INSERT INTO import_locations VALUES ('loose-fixture','legacy/path.md','legacy-document');
      INSERT INTO responses(rowid,id,text,role,state) VALUES (53,'legacy-reply','reply café','addendum','complete');
      INSERT INTO response_thoughts VALUES ('legacy-reply','legacy-child',0);
      INSERT INTO response_seals VALUES ('legacy-reply');
      INSERT INTO rejected_thoughts VALUES ('legacy-root');
      INSERT INTO runs(rowid,id,kind,status,session_id,prompt_id,created_at,generation,weave_subject_id,weave_trigger_id) VALUES
        (61,'legacy-weave','weave','completed','native-weave','prompt-weave','2030',3,'legacy-root','capture:legacy-root');
      INSERT INTO runs(rowid,id,kind,status,session_id,prompt_id,created_at,generation) VALUES
        (67,'legacy-search','search','completed','native-search','prompt-search','2030',2);
      INSERT INTO run_steps(rowid,run_id,position,prompt_id,input,state,native_state,envelope_json,result_json) VALUES
        (71,'legacy-weave',0,'prompt-weave','exact input café','processed','completed','{"version":1,"kind":"complete","reply":"reply"}','{"receipt":"café"}'),
        (73,'legacy-search',0,'prompt-search','retained search input','completed','completed','{"version":1,"kind":"search-reply","reply":"found","disposition":"done","sourceThoughtIds":[]}',NULL);
      INSERT INTO run_context VALUES ('legacy-weave','thought','legacy-root',1);
      INSERT INTO run_operation_receipts VALUES ('legacy-weave','prompt-weave','{"type":"interpretation"}','legacy-child','{"retained":"café"}','step');
      INSERT INTO run_issued_thoughts VALUES ('legacy-weave','prompt-weave','legacy-child',0);
      INSERT INTO run_replies VALUES ('legacy-weave',NULL,'legacy-reply');
      INSERT INTO execution_owners VALUES ('old-owner','{"path":"/owned/frozen.sqlite","dev":"1","ino":"2"}','sqlite-sidecar-v1');
      INSERT INTO agent_bindings VALUES ('legacy-weave','native-weave','https://fixture.invalid','/owned',
        '{"providerID":"fixture","id":"fixture"}','[{"action":"*","resource":"*","effect":"allow"}]',1,NULL);
      INSERT INTO search_sessions(sequence,id,create_request_key,title,created_at,last_activity_at) VALUES (79,'saved-search','create-key','Saved label','2030','2031');
      INSERT INTO search_turns VALUES ('legacy-search','saved-search',0,'turn-key','2030','standard','continue','{"text":"frozen intent"}',0,NULL);
      INSERT INTO search_messages(rowid,id,session_id,run_id,position,role,text,created_at,disposition,evidence_json) VALUES
        (83,'saved-user','saved-search','legacy-search',0,'user','exact saved conversation','2030',NULL,'[]');
      INSERT INTO fixture_incoming VALUES ('private-reference','legacy-import',x'00ffefbbbf0d0a');`);
  });
}

function preserved(db: Database, excludeNewMedia = false) {
  return frozenTables.map(table => {
    const where = !excludeNewMedia ? "" : table === "thoughts" ? " WHERE id!='media-root'" :
      ["thought_titles", "thought_source_seals"].includes(table) ? " WHERE thought_id!='media-root'" : "";
    return { table, rows: db.query(`SELECT rowid,* FROM ${quote(table)}${where} ORDER BY rowid`).all(),
      fks: db.query(`PRAGMA foreign_key_list(${quote(table)})`).all() };
  });
}

function fileFixture(action: (db: Database, path: string) => void): void {
  const dir = mkdtempSync(join("/tmp/opencode", "media-migration-")), path = join(dir, "owned.sqlite"), db = new Database(path);
  try { action(db, path); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe("media source migration and immutable metadata", () => {
  test("core migration creates empty media identity/source tables and accepts null text only for an associated media root", () => {
    const db = new Database(":memory:");
    try {
      migrate(db); requireMediaSchema(db);
      expect(db.query("SELECT * FROM media_store").all()).toEqual([]);
      const columns = db.query<{ name: string }, []>("PRAGMA table_info(media_sources)").all().map(column => column.name);
      for (const name of ["original_bytes", "bytes", "extracted_text"]) expect(columns).not.toContain(name);
      initializeSqlMediaStore(db); insertMediaSource(db);
      expect(new SqliteStore(db).getThought(mediaThought.id)).toEqual(mediaThought);
      expect(db.query("SELECT text,author,kind,import_document_id FROM thoughts WHERE id=?").get(mediaThought.id))
        .toEqual({ text: null, author: "source", kind: "media-original", import_document_id: null });
      expect(() => db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('bad-text',NULL,'user','captured-original','2030','capture')`)).toThrow();
      expect(() => db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('unassociated',NULL,'source','media-original','2030','media-import')`)).toThrow();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });

  test("a populated frozen cyclic predecessor preserves bytes, rowids, incoming FKs and sealed associations through repeated reopen", () => fileFixture((db, path) => {
    seedFrozen(db); const before = preserved(db);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrate(db); requireMediaSchema(db);
    expect(preserved(db)).toEqual(before);
    expect(db.query("SELECT original_bytes FROM import_documents WHERE id='legacy-document'").get()).toEqual({ original_bytes: frozenBytes });
    expect(db.query("SELECT * FROM media_store").all()).toEqual([]);
    initializeSqlMediaStore(db); insertMediaSource(db);
    const reopened = new Database(path);
    try {
      migrate(reopened); migrate(reopened);
      expect(preserved(reopened, true)).toEqual(before);
      expect(new SqliteStore(reopened).getThought(mediaThought.id)).toEqual(mediaThought);
      expect(reopened.query("SELECT * FROM media_store").all()).toEqual([{ singleton: 1, store_id: mediaStoreId }]);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => reopened.exec("UPDATE thoughts SET text='changed' WHERE id='legacy-root'")).toThrow(/immutable/);
      expect(() => reopened.exec("INSERT INTO thought_sources VALUES ('legacy-child',1,'legacy-root')")).toThrow();
      expect(() => reopened.exec("INSERT INTO import_document_parts VALUES ('legacy-document',2,'separator',18,19,NULL,NULL)")).toThrow();
    } finally { reopened.close(); }
  }));

  test("mixed-case cascading incoming FK preserves its populated row across media migration and reopen", () => fileFixture((db, path) => {
    seedFrozen(db);
    db.exec(`CREATE TABLE fixture_cascading_incoming (
      id TEXT PRIMARY KEY NOT NULL,thought_id TEXT NOT NULL REFERENCES Thoughts(id) ON DELETE CASCADE,payload BLOB NOT NULL
    );
    CREATE INDEX fixture_cascading_incoming_thought ON fixture_cascading_incoming(thought_id);
    INSERT INTO fixture_cascading_incoming(rowid,id,thought_id,payload)
      VALUES (101,'mixed-case-reference','legacy-import',x'00ffefbbbf0d0a');`);
    const rows = (connection: Database) => connection.query("SELECT rowid,* FROM fixture_cascading_incoming ORDER BY rowid").all();
    const schema = (connection: Database) => connection.query(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE tbl_name='fixture_cascading_incoming' ORDER BY type,name`).all();
    const expectedRows = [{ rowid: 101, id: "mixed-case-reference", thought_id: "legacy-import",
      payload: new Uint8Array([0,255,239,187,191,13,10]) }];
    const beforeSchema = schema(db), beforeFks = db.query("PRAGMA foreign_key_list(fixture_cascading_incoming)").all();
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(beforeFks).toEqual([expect.objectContaining({ table: "Thoughts", from: "thought_id", to: "id", on_delete: "CASCADE" })]);
    expect(rows(db)).toEqual(expectedRows);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.exec(`INSERT INTO fixture_cascading_incoming(id,thought_id,payload)
      VALUES ('invalid-reference','missing-thought',x'00')`)).toThrow();

    migrate(db); requireMediaSchema(db);
    expect(db.inTransaction).toBe(false);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT id FROM thoughts WHERE id='legacy-import'").get()).toEqual({ id: "legacy-import" });
    // A clean FK check cannot detect rows silently removed by DROP TABLE's cascading delete.
    expect(rows(db)).toEqual(expectedRows);
    expect(schema(db)).toEqual(beforeSchema);
    expect(db.query("PRAGMA foreign_key_list(fixture_cascading_incoming)").all()).toEqual(beforeFks);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      expect(rows(reopened)).toEqual(expectedRows);
      expect(schema(reopened)).toEqual(beforeSchema);
      expect(reopened.query("PRAGMA foreign_key_list(fixture_cascading_incoming)").all()).toEqual(beforeFks);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
  }));

  test("failure after real destructive closure DDL rolls back the complete frozen schema/data and permits a clean retry", () => fileFixture(db => {
    seedFrozen(db); const before = preserved(db);
    const schema = () => db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
    const oldSchema = schema(); let injected = false;
    const failingDb = new Proxy(db, { get(target, key) {
      if (key === "exec") return (sql: string) => {
        const result = target.exec(sql);
        // Execute real DDL first. Do not depend on the migrator's temporary-table names.
        const unquoted = sql.replace(/["`\[\]]/g, "");
        if (frozenTables.some(table => new RegExp(`\\b(?:DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?|ALTER\\s+TABLE)\\s+${table}\\b`, "i").test(unquoted))) {
          injected = true; throw new Error("injected after destructive media closure DDL");
        }
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(() => migrate(failingDb)).toThrow("injected after destructive media closure DDL");
    expect(injected).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(schema()).toEqual(oldSchema); expect(preserved(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrate(db); requireMediaSchema(db); expect(preserved(db)).toEqual(before);
  }));

  test("the dedicated writer requires explicit store initialization and commits source/root/title/seal atomically", () => {
    const db = new Database(":memory:");
    try {
      migrate(db); requireMediaSchema(db); const store = new SqliteStore(db); requireMediaWriter(store);
      const input = { thought: mediaThought, requestKey: "writer-key", sha256: new Uint8Array(mediaDigest) };
      expect(store.mediaStoreId()).toBeNull();
      expect(() => store.saveMediaSource(input)).toThrow();
      expect(db.query("SELECT * FROM media_sources").all()).toEqual([]);
      expect(() => store.initializeMediaStore("")).toThrow();
      expect(store.initializeMediaStore(mediaStoreId)).toBe(mediaStoreId);
      expect(store.initializeMediaStore(mediaStoreId)).toBe(mediaStoreId);
      expect(() => store.initializeMediaStore("00000000-0000-4000-8000-000000000099")).toThrow();
      expect(store.mediaStoreId()).toBe(mediaStoreId);
      expect(() => store.saveMediaSource({ ...input, sha256: new Uint8Array(31) })).toThrow();
      expect(db.query("SELECT * FROM media_sources").all()).toEqual([]);
      db.exec(`CREATE TRIGGER media_test_title_failure BEFORE INSERT ON thought_titles
        WHEN NEW.thought_id='media-root' BEGIN SELECT RAISE(ABORT,'injected title failure'); END;`);
      expect(() => store.saveMediaSource(input)).toThrow("injected title failure");
      for (const table of ["media_sources", "thoughts", "thought_titles", "thought_source_seals"]) expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(db.inTransaction).toBe(false); db.exec("DROP TRIGGER media_test_title_failure");
      store.saveMediaSource(input); input.sha256.fill(0);
      expect(store.getThought(mediaThought.id)).toEqual(mediaThought);
      expect(db.query("SELECT sha256,request_key FROM media_sources").get()).toEqual({ sha256: mediaDigest, request_key: "writer-key" });
      expect(db.query("SELECT * FROM thought_source_seals").all()).toEqual([{ thought_id: mediaThought.id }]);
      expect(db.query("SELECT * FROM thought_sources").all()).toEqual([]);
      expect(db.query("SELECT * FROM runs").all()).toEqual([]); // Attempt admission belongs to dkx.4.
      const second = { ...mediaThought, id: "media-root-two", mediaSource: { ...mediaThought.mediaSource,
        id: "00000000-0000-4000-8000-000000000003" } };
      store.saveMediaSource({ thought: second, requestKey: "another-import", sha256: mediaDigest });
      expect(store.getThought(second.id)).toEqual(second);
      expect(db.query("SELECT count(*) AS n FROM media_sources WHERE sha256=?").get(mediaDigest)).toEqual({ n: 2 });
    } finally { db.close(); }
  });

  test("source association, clarification, original identity and store identity cannot mutate or be replaced", () => {
    const db = new Database(":memory:");
    try {
      migrate(db); initializeSqlMediaStore(db); insertMediaSource(db);
      const before = db.query("SELECT * FROM media_sources").all();
      for (const sql of [
        "UPDATE media_sources SET clarification='rewritten'", "UPDATE media_sources SET source_thought_id='elsewhere'",
        "UPDATE media_sources SET display_name='renamed.png'", "UPDATE media_sources SET sha256=zeroblob(32)",
        "DELETE FROM media_sources", "INSERT OR REPLACE INTO media_sources SELECT * FROM media_sources",
        "UPDATE media_store SET store_id='replacement'", "DELETE FROM media_store",
        "INSERT OR REPLACE INTO media_store VALUES (1,'replacement')", "INSERT INTO media_store VALUES (2,'another')",
        "UPDATE thoughts SET text='invented user text' WHERE kind='media-original'", "DELETE FROM thoughts WHERE kind='media-original'",
      ]) expect(() => db.exec(sql)).toThrow();
      expect(db.query("SELECT * FROM media_sources").all()).toEqual(before);
      expect(() => immediate(db, () => db.run(`INSERT INTO media_sources(id,source_thought_id,request_key,display_name,mime_type,byte_length,sha256,clarification,created_at)
        VALUES ('00000000-0000-4000-8000-000000000003','missing','orphan','x.png','image/png',1,?,NULL,?)`, [mediaDigest, mediaTime]))).toThrow();
      expect(db.inTransaction).toBe(false);
      expect(db.query("SELECT * FROM media_sources").all()).toEqual(before);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });

  test("ordinary thought saves cannot create media roots or infer source authorship as a title author", () => {
    const db = new Database(":memory:");
    try {
      migrate(db); const store = new SqliteStore(db);
      expect(() => store.saveThought(mediaThought)).toThrow();
      expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM thought_titles").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  test("source metadata cannot attach to an existing thought and rejects invalid MIME/length before canonical admission", () => {
    const db = new Database(":memory:");
    try {
      migrate(db); initializeSqlMediaStore(db);
      new SqliteStore(db).saveThought({ id: "already-there", text: "Actual user wording", title: null, author: "user",
        kind: "captured-original", createdAt: mediaTime, origin: "fixture", parentId: null, sourceIds: [] });
      expect(() => db.run(`INSERT INTO media_sources(id,source_thought_id,request_key,display_name,mime_type,byte_length,sha256,clarification,created_at)
        VALUES (?,'already-there','late','late.png','image/png',1,?,NULL,?)`, [mediaThought.mediaSource.id, mediaDigest, mediaTime])).toThrow();
      for (const change of [{ mimeType: "audio/wav" }, { byteLength: 0 }, { byteLength: 1.5 }]) {
        expect(() => insertMediaSource(db, { ...mediaThought, mediaSource: { ...mediaThought.mediaSource, ...change } })).toThrow();
        expect(db.inTransaction).toBe(false);
        expect(db.query("SELECT * FROM media_sources").all()).toEqual([]);
        expect(db.query("SELECT id FROM thoughts ORDER BY id").all()).toEqual([{ id: "already-there" }]);
      }
    } finally { db.close(); }
  });

  test("source-first SQL cannot commit invented media text, mismatched attribution/time or supporting sources before sealing", () => {
    const db = new Database(":memory:");
    try {
      migrate(db); initializeSqlMediaStore(db);
      new SqliteStore(db).saveThought({ id: "support", text: "Independent source", title: null, author: "user", kind: "captured-original",
        createdAt: mediaTime, origin: "fixture", parentId: null, sourceIds: [] });
      for (const violation of ["text", "author", "time", "supporting-source"] as const) {
        expect(() => immediate(db, () => {
          db.run(`INSERT INTO media_sources(id,source_thought_id,request_key,display_name,mime_type,byte_length,sha256,clarification,created_at)
            VALUES (?,'media-root','guard-key','guard.png','image/png',1,?,NULL,?)`, [mediaThought.mediaSource.id, mediaDigest, mediaTime]);
          db.run(`INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id)
            VALUES ('media-root',?,?,'media-original',?,'media-import',NULL)`,
          [violation === "text" ? "invented" : null, violation === "author" ? "user" : "source", violation === "time" ? "2031" : mediaTime]);
          db.run("INSERT INTO thought_titles(thought_id,title,title_author) VALUES ('media-root',NULL,NULL)");
          if (violation === "supporting-source") db.exec("INSERT INTO thought_sources VALUES ('media-root',0,'support')");
          db.exec("INSERT INTO thought_source_seals VALUES ('media-root')");
        })).toThrow();
        expect(db.inTransaction).toBe(false);
        expect(db.query("SELECT * FROM media_sources").all()).toEqual([]);
        expect(db.query("SELECT id FROM thoughts ORDER BY id").all()).toEqual([{ id: "support" }]);
      }
    } finally { db.close(); }
  });
});
