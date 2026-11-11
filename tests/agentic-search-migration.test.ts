import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../src/storage/sqlite";
import { readSearchCleanupSnapshot } from "../src/storage/search-cleanup-snapshot";
import { SqliteRunRepository } from "../src/storage/run";

const bindingProjection = "SELECT rowid,run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version FROM agent_bindings ORDER BY rowid";

// Build the immediate predecessor with the existing bootstrap and import migrations,
// intercepting only the search foundation during fixture setup. The migration under
// test below always receives the real connection, never this proxy.
function preSearch(db: Database): void {
  let search = false;
  const fixture = new Proxy(db, {
    get(target, property) {
      if (property === "query") return (sql: string) => {
        if (sql === "SELECT sql FROM sqlite_schema WHERE type='table' AND name='runs'") {
          search = true;
          const row = target.query(sql).get() as { sql: string };
          return { get: () => ({ sql: row.sql.replace("'import'", "'import','search'") }) };
        }
        return target.query(sql);
      };
      if (property === "exec") return (sql: string) => {
        if (search && (sql.startsWith("ALTER TABLE run_steps ADD COLUMN submit_owner") || sql.includes("CREATE TABLE IF NOT EXISTS search_sessions") || sql.startsWith("CREATE INDEX \""))) return;
        return target.exec(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  migrate(fixture);
  expect(search).toBe(true);
  expect(db.query("SELECT sql FROM sqlite_schema WHERE name='runs'").get()).not.toEqual(expect.objectContaining({ sql: expect.stringContaining("'search'") }));
  expect(db.query("PRAGMA table_info(run_steps)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "submit_owner" })]));
}

const searchTables = [
  "search_sessions", "search_turns", "search_messages", "search_discoveries",
  "search_content_dependencies", "search_composer_contexts", "search_composer_dependencies",
  "search_revisions", "search_native_cleanup",
];

function expectSearchSchema(db: Database): void {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name);
  expect(tables).toEqual(expect.arrayContaining(searchTables));
  expect(db.query("PRAGMA table_info(run_steps)").all()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "submit_owner", notnull: 0 }),
  ]));
  expect(db.query("SELECT eligibility,retrieval,catalog FROM search_revisions WHERE id=1").get())
    .toEqual({ eligibility: 0, retrieval: 0, catalog: 0 });
}

test("empty migration creates separate search persistence and accepts a search run without a thought", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    expectSearchSchema(db);
    db.run("INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES ('search-run','search','queued','native','prompt','2030',0)");
    expect(db.query("SELECT kind,input_thought_id,weave_subject_id FROM runs WHERE id='search-run'").get())
      .toEqual({ kind: "search", input_thought_id: null, weave_subject_id: null });
    expect(() => db.run("INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation,input_thought_id) VALUES ('invalid','search','queued','other','other-prompt','2030',0,'missing')")).toThrow();
    expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("discovery membership is unique only while unremoved and content ownership uses composite foreign keys", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    expectSearchSchema(db);
    const indexes = db.query("PRAGMA index_list(search_discoveries)").all() as { name: string; unique: number; partial: number }[];
    const membership = indexes.filter(index => index.unique === 1 && index.partial === 1).find(index => {
      const columns = db.query(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all() as { name: string }[];
      return columns.map(column => column.name).join(",") === "session_id,thought_id";
    });
    expect(membership).toBeDefined();
    const sql = db.query("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(membership?.name ?? "") as { sql: string };
    expect(sql.sql).toMatch(/WHERE\s+removed_at\s+IS\s+NULL/i);
    for (const [table, parent, first, second] of [
      ["search_messages", "search_turns", "run_id", "session_id"],
      ["search_discoveries", "search_turns", "added_run_id", "session_id"],
      ["search_content_dependencies", "search_messages", "message_id", "session_id"],
      ["search_content_dependencies", "search_discoveries", "discovery_id", "session_id"],
    ]) {
      const fks = db.query(`PRAGMA foreign_key_list(${table})`).all() as { id: number; table: string; from: string }[];
      expect(fks.some(fk => fk.table === parent && fk.from === first && fks.some(other => other.id === fk.id && other.from === second))).toBe(true);
    }
  } finally { db.close(); }
});

test("legacy knowledge and execution survive migration and repeated file reopen", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "search-migration-"));
  const path = join(dir, "owned.sqlite");
  const db = new Database(path);
  try {
    // Frozen predecessor, not generated from the current schema under test.
    db.exec(`CREATE TABLE thoughts (id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,author TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id));
      CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,session_id TEXT UNIQUE NOT NULL,prompt_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,generation INTEGER NOT NULL,input_thought_id TEXT REFERENCES thoughts(id),weave_subject_id TEXT REFERENCES thoughts(id),weave_trigger_id TEXT,cancellation_state TEXT NOT NULL DEFAULT 'none');
      INSERT INTO thoughts(rowid,id,text,author,kind,created_at,origin,parent_id) VALUES (17,'root','fixture café','user','captured-original','2030','capture',NULL),(23,'child','child','ai','ai-interpretation','2031','weave','root');
      INSERT INTO runs(rowid,id,kind,status,session_id,prompt_id,created_at,generation,input_thought_id,weave_subject_id,weave_trigger_id,cancellation_state) VALUES (41,'old-run','weave','uncertain','old-native','old-prompt','2030',3,NULL,'root','trigger','pending');`);
    migrate(db);
    db.exec(`INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES ('old-run','old-native','https://fixture.invalid','/owned','{"model":"fixture"}','[]',1);
      INSERT INTO import_namespaces VALUES ('fixture-namespace','fixture','Fixture','2030');
      INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES ('import-run','import','queued','import-native','import-prompt','2032',0);
      INSERT INTO markdown_imports(id,request_key,namespace_id,created_at) VALUES ('batch','batch-key','fixture-namespace','2032');
      INSERT INTO markdown_import_files(id,import_id,namespace_id,position,request_key,relative_path,sha256,byte_length,created_at,run_id)
        VALUES ('file','batch','fixture-namespace',0,'file-key','fixture.md',zeroblob(32),3,'2032','import-run');
      INSERT INTO markdown_import_payloads VALUES ('file',x'616263');`);
    const retained = ["agent_bindings", "run_steps", "markdown_imports", "markdown_import_files", "markdown_import_payloads"]
      .map(table => db.query(table === "agent_bindings" ? bindingProjection : `SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
    expect(db.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }]);
    const expectedThoughts = db.query("SELECT rowid,id,text,author,kind,created_at,origin,parent_id FROM thoughts ORDER BY rowid").all();
    const expectedRun = db.query("SELECT rowid,* FROM runs WHERE id='old-run'").get();
    expect(expectedThoughts).toEqual([
      { rowid: 17, id: "root", text: "fixture café", author: "user", kind: "captured-original", created_at: "2030", origin: "capture", parent_id: null },
      { rowid: 23, id: "child", text: "child", author: "ai", kind: "ai-interpretation", created_at: "2031", origin: "weave", parent_id: "root" },
    ]);
    expect(expectedRun).toEqual(expect.objectContaining({ rowid: 41, id: "old-run", status: "uncertain", generation: 3, cancellation_state: "pending" }));
    migrate(db);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      expect(reopened.query("SELECT rowid,id,text,author,kind,created_at,origin,parent_id FROM thoughts ORDER BY rowid").all()).toEqual(expectedThoughts);
      expect(reopened.query("SELECT rowid,* FROM runs WHERE id='old-run'").get()).toEqual(expectedRun);
      expect(["agent_bindings", "run_steps", "markdown_imports", "markdown_import_files", "markdown_import_payloads"]
        .map(table => reopened.query(table === "agent_bindings" ? bindingProjection : `SELECT rowid,* FROM ${table} ORDER BY rowid`).all())).toEqual(retained);
      expect(reopened.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }]);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => reopened.run("UPDATE thoughts SET text='changed' WHERE id='root'")).toThrow();
      expect(() => reopened.run("DELETE FROM runs WHERE id='old-run'")).toThrow();
      expectSearchSchema(reopened);
    } finally { reopened.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("search rebuild preserves mixed-case cascading incoming foreign keys", () => {
  const db = new Database(":memory:");
  try {
    preSearch(db);
    db.exec(`INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation)
        VALUES ('owned-run','weave','queued','owned-session','owned-prompt','2030',0);
      CREATE TABLE "Fixture_Ä" (id TEXT PRIMARY KEY, run_id TEXT REFERENCES RuNs(id) ON DELETE CASCADE, payload TEXT);
      CREATE TABLE "Fixture_child" (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES "fIXTURE_Ä"(id) ON DELETE CASCADE);
      CREATE INDEX fixture_incoming_idx ON "Fixture_Ä"(run_id);
      INSERT INTO "Fixture_Ä"(rowid,id,run_id,payload) VALUES (81,'incoming','owned-run','café');
      INSERT INTO "Fixture_child"(rowid,id,parent_id) VALUES (82,'child','incoming');`);
    const schema = () => db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('Fixture_Ä','Fixture_child') ORDER BY type,name").all();
    const rows = () => [db.query('SELECT rowid,* FROM "Fixture_Ä"').all(), db.query('SELECT rowid,* FROM "Fixture_child"').all()];
    const fks = () => [db.query('PRAGMA foreign_key_list("Fixture_Ä")').all(), db.query('PRAGMA foreign_key_list("Fixture_child")').all()];
    const before = { schema: schema(), rows: rows(), fks: fks() };
    expect(before.rows).toEqual([[{ rowid: 81, id: 'incoming', run_id: 'owned-run', payload: 'café' }], [{ rowid: 82, id: 'child', parent_id: 'incoming' }]]);
    migrate(db);
    expect({ schema: schema(), rows: rows(), fks: fks() }).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("first search upgrade preserves populated import-era closure, and rolls back a failed copy", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "search-current-"));
  const path = join(dir, "owned.sqlite"), db = new Database(path);
  try {
    preSearch(db);
    db.exec(`INSERT INTO thoughts(rowid,id,text,author,kind,created_at,origin,parent_id) VALUES
      (17,'root','original','user','captured-original','2030','capture',NULL),
      (23,'child','developed','ai','ai-interpretation','2031','weave','root');
      INSERT INTO thought_titles VALUES ('root','Title','user'),('child',NULL,NULL);
      INSERT INTO thought_source_seals VALUES ('root'),('child');
      INSERT INTO rejected_thoughts VALUES ('child');
      INSERT INTO responses VALUES ('reply','shared text','addendum','complete');
      INSERT INTO response_thoughts VALUES ('reply','root',0),('reply','child',1);
      INSERT INTO response_seals VALUES ('reply');
      INSERT INTO runs(rowid,id,kind,status,session_id,prompt_id,created_at,generation) VALUES
        (41,'weave','weave','uncertain','native','prompt','2030',2),
        (42,'import','import','queued','import-native','import-prompt','2030',0);
      UPDATE run_steps SET input='exact input' WHERE run_id='weave';
      INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES ('weave','native','https://fixture.invalid','/owned','{}','[]',1);
      INSERT INTO run_context VALUES ('weave','thought','root',1);
      INSERT INTO run_operation_receipts VALUES ('weave','prompt','{"fixture":1}','child','{"fixture":2}','step');
      INSERT INTO run_issued_thoughts VALUES ('weave','prompt','child',0);
      INSERT INTO import_namespaces VALUES ('fixture-namespace','fixture','Fixture','2030');
      INSERT INTO markdown_imports(id,request_key,namespace_id,created_at) VALUES ('batch','batch-key','fixture-namespace','2030');
      INSERT INTO markdown_import_files(id,import_id,namespace_id,position,request_key,relative_path,sha256,byte_length,created_at,run_id)
        VALUES ('file','batch','fixture-namespace',0,'file-key','pending.md',zeroblob(32),3,'2030','import');
      INSERT INTO markdown_import_payloads VALUES ('file',x'616263');`);
    db.exec(`BEGIN;
      INSERT INTO import_documents(id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,created_at,parser_version,segmentation_method,segmentation_reason)
        VALUES ('doc',x'616263',zeroblob(32),3,'utf-8','fixture-namespace','source.md','2030','fixture','structural','fixture');
      INSERT INTO import_locations VALUES ('fixture-namespace','source.md','doc');
      INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id,import_document_id) VALUES ('source','abc','source','imported-original','2030','markdown-import',NULL,'doc');
      INSERT INTO thought_titles VALUES ('source',NULL,NULL);
      INSERT INTO thought_source_seals VALUES ('source');
      INSERT INTO import_document_parts VALUES ('doc',0,'thought',0,3,'source',0);
      INSERT INTO import_document_seals VALUES ('doc'); COMMIT;`);
    const tables = ["thoughts", "thought_titles", "thought_source_seals", "rejected_thoughts", "responses", "response_thoughts", "response_seals", "runs", "agent_bindings", "run_context", "run_operation_receipts", "run_issued_thoughts", "import_documents", "import_locations", "import_document_parts", "import_document_seals", "markdown_imports", "markdown_import_files", "markdown_import_payloads"];
    const snapshot = () => [...tables.map(table => db.query(table === "agent_bindings" ? bindingProjection : `SELECT rowid,* FROM ${table} ORDER BY rowid`).all()), db.query("SELECT rowid,run_id,position,prompt_id,input,state,native_state,envelope_json,result_json FROM run_steps ORDER BY rowid").all()];
    const before = snapshot();
    expect(db.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }]);
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
    const fks = tables.map(table => db.query(`PRAGMA foreign_key_list(${table})`).all());
    let injected = false;
    const failing = new Proxy(db, { get(target, property) {
      if (property === "exec") return (sql: string) => {
        const result = target.exec(sql);
        if (/^INSERT INTO "runs"\s/i.test(sql) && sql.includes("__preserved_rowid")) { injected = true; throw new Error("search copy fault"); }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(() => migrate(failing)).toThrow("search copy fault");
    expect(injected).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()).toEqual(schema);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrate(db);
    expect(snapshot()).toEqual(before);
    expect(db.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }]);
    expect(db.query("SELECT submit_owner FROM run_steps ORDER BY rowid").all()).toEqual([{ submit_owner: null }, { submit_owner: null }]);
    expect(tables.map(table => db.query(`PRAGMA foreign_key_list(${table})`).all())).toEqual(fks);
    const replaced = ["runs_immutable_delete", "run_steps_immutable_delete", "run_context_immutable_delete", "agent_bindings_immutable_delete", "run_receipts_immutable_delete", "run_issued_immutable_delete"];
    const guards = (schema as {type: string; name: string}[]).filter(row => (row.type === "trigger" || row.type === "index") && !replaced.includes(row.name));
    const after = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all() as {type: string; name: string; tbl_name: string; sql: string}[];
    expect(after).toEqual(expect.arrayContaining(guards));
    for (const name of replaced) {
      expect(schema).toEqual(expect.arrayContaining([expect.objectContaining({ type: "trigger", name })]));
      const trigger = after.find(row => row.type === "trigger" && row.name === name);
      expect(trigger).toBeDefined();
    }
    // Every migrated populated non-search execution remains protected. The owned
    // tombstoned-search purge test below exercises the corresponding allowed path.
    for (const [table,column] of [["runs","id"],["run_steps","run_id"],["run_context","run_id"],
      ["agent_bindings","run_id"],["run_operation_receipts","run_id"],["run_issued_thoughts","run_id"]]) {
      expect(() => db.run(`DELETE FROM ${table} WHERE ${column}='weave'`)).toThrow(/immutable/i);
    }
    expect(snapshot()).toEqual(before);
    const reopened = new Database(path);
    try {
      migrate(reopened); migrate(reopened);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(reopened.query("SELECT rowid,id,text,parent_id,import_document_id FROM thoughts ORDER BY rowid").all()).toEqual(db.query("SELECT rowid,id,text,parent_id,import_document_id FROM thoughts ORDER BY rowid").all());
      expect(() => reopened.run("DELETE FROM runs WHERE id='weave'")).toThrow();
      expect(() => reopened.run("UPDATE import_documents SET original_path='changed' WHERE id='doc'")).toThrow();
    } finally { reopened.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

function guardFixture(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.exec(`INSERT INTO search_sessions(id,create_request_key,title,created_at,last_activity_at)
      VALUES ('session','create-key','Search','2030','2030');
    INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES
      ('search-run','search','queued','search-native','search-prompt','2030',0),
      ('weave-run','weave','queued','weave-native','weave-prompt','2030',0);`);
  return db;
}

function insertTurn(db: Database, runId: string): void {
  db.run(`INSERT INTO search_turns(run_id,session_id,position,request_key,admitted_at,effort,context_mode,intent_json)
    VALUES (?,'session',0,'request','2030','standard','continue','{}')`, [runId]);
}

test("search turn ownership rejects a non-search run", () => {
  const db = guardFixture();
  try {
    expect(() => insertTurn(db, "weave-run")).toThrow();
    expect(db.query("SELECT count(*) AS n FROM search_turns").get()).toEqual({ n: 0 });
    insertTurn(db, "search-run");
    expect(db.query("SELECT run_id FROM search_turns").get()).toEqual({ run_id: "search-run" });
  } finally { db.close(); }
});

test("retained search message content cannot be rewritten or replaced", () => {
  const db = guardFixture();
  try {
    insertTurn(db, "search-run");
    db.run(`INSERT INTO search_messages(id,session_id,run_id,position,role,text,created_at,evidence_json)
      VALUES ('message','session','search-run',0,'user','original','2030','[]')`);
    expect(() => db.run("UPDATE search_messages SET text='changed' WHERE id='message'")).toThrow();
    expect(() => db.run(`INSERT OR REPLACE INTO search_messages(id,session_id,run_id,position,role,text,created_at,evidence_json)
      VALUES ('message','session','search-run',0,'user','changed','2030','[]')`)).toThrow();
    expect(db.query("SELECT text FROM search_messages WHERE id='message'").get()).toEqual({ text: "original" });
  } finally { db.close(); }
});

test("message ownership is session-local and purge removes dependencies before content and turn", () => {
  const db = guardFixture();
  try {
    insertTurn(db, "search-run");
    db.run("INSERT INTO search_sessions(id,create_request_key,title,created_at,last_activity_at) VALUES ('other','other-key','Other','2030','2030')");
    const message = (session: string) => db.run(`INSERT INTO search_messages(id,session_id,run_id,position,role,text,created_at,evidence_json)
      VALUES ('message',?,'search-run',0,'user','content','2030','[]')`, [session]);
    expect(() => message("other")).toThrow(/foreign key/i);
    message("session");
    expect(() => db.run("INSERT INTO search_content_dependencies(session_id,message_id,ref_kind,ref_id) VALUES ('other','message','thought','source')")).toThrow(/foreign key/i);
    db.run("INSERT INTO search_content_dependencies(session_id,message_id,ref_kind,ref_id) VALUES ('session','message','thought','source')");
    expect(() => db.run("DELETE FROM search_content_dependencies WHERE message_id='message'")).toThrow();
    db.run("UPDATE search_sessions SET title=NULL,deleted_at='2031' WHERE id='session'");
    expect(() => db.run("DELETE FROM search_messages WHERE id='message'")).toThrow();
    expect(() => db.run("DELETE FROM search_turns WHERE run_id='search-run'")).toThrow();
    db.run("DELETE FROM search_content_dependencies WHERE message_id='message'");
    db.run("DELETE FROM search_messages WHERE id='message'");
    db.run("DELETE FROM run_steps WHERE run_id='search-run'");
    db.run("DELETE FROM runs WHERE id='search-run'");
    expect(db.query("SELECT count(*) AS n FROM search_turns").get()).toEqual({ n: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("only a tombstoned search session permits its owned execution purge", () => {
  const db = guardFixture();
  try {
    insertTurn(db, "search-run");
    db.exec(`INSERT INTO run_context VALUES ('search-run','thought','source',0),('weave-run','thought','source',0);
      INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES ('search-run','search-native','https://fixture.invalid','/owned','{}','[]',1),('weave-run','weave-native','https://fixture.invalid','/owned','{}','[]',1);
      INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('thought','text','user','captured-original','2030','capture');
      INSERT INTO run_operation_receipts VALUES ('weave-run','weave-prompt','{}','thought','{}','step');
      INSERT INTO run_issued_thoughts VALUES ('weave-run','weave-prompt','thought',0);
      INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES ('orphan','search','queued','orphan-native','orphan-prompt','2030',0);`);
    expect(() => db.run("DELETE FROM run_steps WHERE run_id='search-run'")).toThrow();
    expect(() => db.run("DELETE FROM runs WHERE id='weave-run'")).toThrow();
    expect(() => db.run("DELETE FROM run_steps WHERE run_id='orphan'")).toThrow(/immutable/i);
    expect(() => db.run("DELETE FROM runs WHERE id='orphan'")).toThrow(/immutable/i);
    db.run("UPDATE search_sessions SET title=NULL,deleted_at='2031' WHERE id='session'");
    expect(() => db.run("DELETE FROM search_turns WHERE run_id='search-run'")).toThrow();
    expect(() => db.run("DELETE FROM run_steps WHERE run_id='weave-run'")).toThrow();
    expect(() => db.run("DELETE FROM runs WHERE id='weave-run'")).toThrow();
    expect(() => db.run("DELETE FROM run_context WHERE run_id='weave-run'")).toThrow(/immutable/i);
    expect(() => db.run("DELETE FROM agent_bindings WHERE run_id='weave-run'")).toThrow(/immutable/i);
    expect(() => db.run("DELETE FROM run_issued_thoughts WHERE run_id='weave-run'")).toThrow(/immutable/i);
    expect(() => db.run("DELETE FROM run_operation_receipts WHERE run_id='weave-run'")).toThrow(/immutable/i);
    db.run("DELETE FROM run_context WHERE run_id='search-run'");
    db.run("DELETE FROM agent_bindings WHERE run_id='search-run'");
    db.run("DELETE FROM run_steps WHERE run_id='search-run'");
    db.run("DELETE FROM runs WHERE id='search-run'");
    expect(db.query("SELECT count(*) AS n FROM search_turns").get()).toEqual({ n: 0 });
    expect(db.query("SELECT id FROM runs WHERE id='weave-run'").get()).toEqual({ id: "weave-run" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("composer coverage cannot shrink or reset after invalidation", () => {
  const db = guardFixture();
  try {
    db.exec(`INSERT INTO search_composer_contexts(id,session_id,state,created_at) VALUES ('composer','session','active','2030');
      INSERT INTO search_composer_dependencies VALUES ('composer','thought','source');`);
    expect(() => db.run("DELETE FROM search_composer_dependencies WHERE composer_id='composer'")).toThrow();
    db.run("UPDATE search_composer_contexts SET revision=1 WHERE id='composer'");
    expect(() => db.run("UPDATE search_composer_contexts SET revision=0 WHERE id='composer'")).toThrow();
    db.run("UPDATE search_composer_contexts SET state='invalidated' WHERE id='composer'");
    expect(() => db.run("UPDATE search_composer_contexts SET state='active' WHERE id='composer'")).toThrow();
    expect(() => db.run("DELETE FROM search_composer_dependencies WHERE composer_id='composer'")).toThrow();
    expect(() => db.run("INSERT INTO search_composer_dependencies VALUES ('composer','thought','other')")).toThrow();
    expect(db.query("SELECT ref_id FROM search_composer_dependencies").all()).toEqual([{ ref_id: "source" }]);
  } finally { db.close(); }
});

test("discovery receipt ownership and occurrence uniqueness preserve removed history", () => {
  const db = guardFixture();
  try {
    insertTurn(db, "search-run");
    db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('thought','fixture','user','captured-original','2030','capture')");
    const completeStep = (prompt: string, entry: string, why: string) => {
      const envelope = { kind: "request", request: { capability: "addDiscovery", arguments: { thoughtId: "thought", why, evidenceThoughtIds: [] } } };
      const result = { type: "discovery-add", outcome: "added", entryId: entry };
      db.run("UPDATE run_steps SET state='completed',native_state='completed',envelope_json=?,result_json=? WHERE prompt_id=?", [JSON.stringify(envelope), JSON.stringify(result), prompt]);
    };
    const add = (id: string, position: number, why: string, prompt: string) => db.run(`INSERT INTO search_discoveries(id,session_id,thought_id,position,why,evidence_json,added_run_id,added_prompt_id,added_at)
      VALUES (?,'session','thought',?,?,'[]','search-run',?,'2030')`, [id, position, why, prompt]);
    completeStep("search-prompt", "one", "first");
    expect(() => add("wrong", 0, "first", "search-prompt")).toThrow();
    add("one", 0, "first", "search-prompt");
    expect(() => db.run("UPDATE search_discoveries SET why='rewritten' WHERE id='one'")).toThrow();
    db.run("INSERT INTO run_steps(run_id,position,prompt_id,state,native_state) VALUES ('search-run',1,'second-prompt','prepared','unknown')");
    completeStep("second-prompt", "two", "second");
    expect(() => add("two", 1, "second", "second-prompt")).toThrow(/unique/i);
    db.run("UPDATE search_discoveries SET removed_at='2031' WHERE id='one'");
    expect(() => db.run("UPDATE search_discoveries SET removed_at=NULL WHERE id='one'")).toThrow();
    add("two", 1, "second", "second-prompt");
    expect(db.query("SELECT id,why,removed_at FROM search_discoveries ORDER BY position").all()).toEqual([
      { id: "one", why: "first", removed_at: "2031" }, { id: "two", why: "second", removed_at: null },
    ]);
  } finally { db.close(); }
});

test("cleanup records require the tombstoned owning search turn and matching prompt", () => {
  const db = guardFixture();
  try {
    insertTurn(db, "search-run");
    db.run(`INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version)
      VALUES ('search-run','search-native','https://fixture.invalid','/owned','{"providerID":"fixture","id":"model"}','[{"action":"*","resource":"*","effect":"deny"}]',1)`);
    expect(() => db.transaction(() => readSearchCleanupSnapshot(db,"search-run"))()).toThrow();
    new SqliteRunRepository(db, { id: () => "unused", now: () => "2030-01-01T00:00:00.000Z" }).stop("search-run");
    db.exec(`INSERT INTO search_sessions(id,create_request_key,title,created_at,last_activity_at) VALUES ('other','other-key','Other','2030','2030');
      UPDATE search_sessions SET title=NULL,deleted_at='2031' WHERE id='session';
      UPDATE search_sessions SET title=NULL,deleted_at='2031' WHERE id='other';`);
    const snap = db.transaction(() => readSearchCleanupSnapshot(db,"search-run"))();
    const insert = (run: string, session: string, prompt: string) => db.run(`INSERT INTO search_native_cleanup
      (run_id,session_id,binding_json,last_prompt_id,submit_owner,drain_state,admission_state,prompt_sha256,evidence_json,state,prompt_manifest_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [run,session,snap.bindingJson,prompt,snap.submitOwner,snap.drainState,snap.admissionState,snap.promptSha256,snap.evidenceJson,snap.state,snap.promptManifestJson]);
    expect(() => insert("weave-run", "session", "weave-prompt")).toThrow();
    expect(() => insert("search-run", "other", "search-prompt")).toThrow();
    expect(() => insert("search-run", "session", "weave-prompt")).toThrow();
    insert("search-run", "session", "search-prompt");
    expect(() => db.run("DELETE FROM search_native_cleanup WHERE run_id='search-run'")).toThrow();
    db.run("DELETE FROM agent_bindings WHERE run_id='search-run'");
    db.run("DELETE FROM run_steps WHERE run_id='search-run'");
    db.run("DELETE FROM runs WHERE id='search-run'");
    expect(db.query("SELECT run_id,session_id FROM search_native_cleanup").get()).toEqual({ run_id: "search-run", session_id: "session" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
