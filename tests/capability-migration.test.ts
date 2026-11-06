import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { migrate, SqliteStore } from "../src/storage/sqlite";

// Frozen predecessor schema: completed steps could not yet retain staged results,
// and exposure rows had no evidence of a full read. Do not derive this from current DDL.
const predecessor = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE thoughts (id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,author TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id));
  CREATE TABLE thought_titles (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id),title TEXT,title_author TEXT);
  CREATE TABLE responses (id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,role TEXT NOT NULL,state TEXT NOT NULL);
  CREATE TABLE response_thoughts (response_id TEXT NOT NULL REFERENCES responses(id),thought_id TEXT NOT NULL REFERENCES thoughts(id),position INTEGER NOT NULL,PRIMARY KEY(response_id,position),UNIQUE(response_id,thought_id));
  CREATE TABLE response_seals (response_id TEXT PRIMARY KEY NOT NULL REFERENCES responses(id));
  CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,session_id TEXT UNIQUE NOT NULL,prompt_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,generation INTEGER NOT NULL,input_thought_id TEXT REFERENCES thoughts(id),weave_subject_id TEXT REFERENCES thoughts(id),weave_trigger_id TEXT,cancellation_state TEXT NOT NULL DEFAULT 'none');
  CREATE TABLE run_context (run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL CHECK(kind IN ('thought','connection','response')),ref_id TEXT NOT NULL,PRIMARY KEY(run_id,kind,ref_id));
  CREATE TABLE run_steps (
    run_id TEXT NOT NULL REFERENCES runs(id),position INTEGER NOT NULL CHECK(position>=0),
    prompt_id TEXT UNIQUE NOT NULL,input TEXT CHECK(input IS NULL OR length(input)>0),
    state TEXT NOT NULL CHECK(state IN ('prepared','submitting','uncertain','completed','processed')),
    native_state TEXT NOT NULL DEFAULT 'unknown' CHECK(native_state IN ('unknown','running','completed')),
    envelope_json TEXT,result_json TEXT,PRIMARY KEY(run_id,position),
    CHECK(state!='processed' OR (envelope_json IS NOT NULL AND result_json IS NOT NULL)),
    CHECK(envelope_json IS NULL OR state IN ('completed','processed')),
    CHECK(result_json IS NULL OR state = 'processed'),
    CHECK((native_state='completed')=(state IN ('completed','processed')))
  );
  CREATE TABLE run_operation_receipts (run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT NOT NULL,operation_json TEXT NOT NULL,thought_id TEXT REFERENCES thoughts(id),result_json TEXT NOT NULL,format TEXT NOT NULL DEFAULT 'legacy' CHECK(format IN ('legacy','step')),PRIMARY KEY(run_id,operation_id),UNIQUE(run_id,operation_id,thought_id),CHECK(format!='legacy' OR thought_id IS NOT NULL));
  CREATE TABLE run_issued_thoughts (run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT NOT NULL,thought_id TEXT NOT NULL REFERENCES thoughts(id),position INTEGER NOT NULL CHECK(position>=0),PRIMARY KEY(run_id,position),UNIQUE(run_id,operation_id),UNIQUE(run_id,thought_id),FOREIGN KEY(run_id,operation_id,thought_id) REFERENCES run_operation_receipts(run_id,operation_id,thought_id));
  INSERT INTO thoughts VALUES ('subject','original','user','captured-original','2030','capture',NULL),('issued','interpretation','ai','ai-interpretation','2031','weave','subject');
  INSERT INTO thought_titles VALUES ('subject','Original title','user'),('issued',NULL,NULL);
  INSERT INTO responses VALUES ('reply','retained text','addendum','complete');
  INSERT INTO response_thoughts VALUES ('reply','issued',0);
  INSERT INTO response_seals VALUES ('reply');
  INSERT INTO runs VALUES ('run','weave','uncertain','session','prompt-0','2030',1,NULL,'subject','trigger','none');
  INSERT INTO run_context VALUES ('run','thought','subject'),('run','thought','issued'),('run','response','reply');
`;

// Frozen artifacts that depend on the predecessor's thought/run closure.
function seedClosure(db: Database): void {
  db.exec(predecessor);
  db.exec(`
    CREATE TABLE agent_bindings (run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),session_id TEXT UNIQUE NOT NULL,service_url TEXT NOT NULL,directory TEXT NOT NULL,model_json TEXT NOT NULL,permissions_json TEXT NOT NULL,protocol_version INTEGER NOT NULL);
    CREATE TABLE export_intents (run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),request TEXT NOT NULL,effort TEXT NOT NULL);
    CREATE TABLE export_reports (run_id TEXT PRIMARY KEY NOT NULL REFERENCES export_intents(run_id),prompt_id TEXT NOT NULL,markdown TEXT NOT NULL,sources_json TEXT NOT NULL);
    INSERT INTO runs VALUES ('export','export','completed','export-session','export-prompt','2032',2,NULL,NULL,NULL,'none');
    INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES ('run','session','https://fixture.invalid','/owned','{"model":"test"}','["read"]',1);
    INSERT INTO export_intents VALUES ('export','exact request','standard');
    INSERT INTO export_reports VALUES ('export','export-prompt','Report café\r\nline','[{"id":"issued"}]');
    INSERT INTO run_steps VALUES ('run',0,'prompt-0','journal café\r\nline','processed','completed','{"kind":"request"}','{"type":"thought"}');
    INSERT INTO run_steps VALUES ('export',0,'export-prompt','export input','completed','completed','{"kind":"report"}',NULL);
    INSERT INTO run_operation_receipts VALUES ('run','prompt-0','{"text":"café"}','issued','{"text":"result"}','step');
    INSERT INTO run_issued_thoughts VALUES ('run','prompt-0','issued',0);
  `);
}

function closureSnapshot(db: Database): unknown {
  return [
    db.query("SELECT rowid,id,hex(CAST(text AS BLOB)) AS text,author,kind,created_at,origin,parent_id FROM thoughts ORDER BY rowid").all(),
    ...["thought_titles", "responses", "response_thoughts", "response_seals", "runs", "run_operation_receipts", "run_issued_thoughts", "agent_bindings", "export_intents", "export_reports"].map(table => db.query(table === "agent_bindings"
      ? "SELECT rowid,run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version FROM agent_bindings ORDER BY rowid"
      : `SELECT rowid,* FROM ${table} ORDER BY rowid`).all()),
    db.query("SELECT rowid,run_id,position,prompt_id,input,state,native_state,envelope_json,result_json FROM run_steps ORDER BY rowid").all(),
    db.query("SELECT rowid,run_id,kind,ref_id FROM run_context ORDER BY rowid").all(),
    db.query("SELECT hex(CAST(markdown AS BLOB)) AS markdown,hex(CAST(sources_json AS BLOB)) AS sources FROM export_reports ORDER BY rowid").all(),
    db.query("SELECT hex(CAST(input AS BLOB)) AS input,hex(CAST(envelope_json AS BLOB)) AS envelope,hex(CAST(result_json AS BLOB)) AS result FROM run_steps ORDER BY rowid").all(),
  ];
}

test("populated predecessor closure and native journal bytes survive failure, retry and repeated reopen", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "closure-predecessor-"));
  const path = join(dir, "owned.sqlite"), db = new Database(path);
  try {
    seedClosure(db);
    const before = closureSnapshot(db);
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
    // Force failure inside closure staging after earlier migration work has begun.
    db.exec("CREATE TEMP TABLE import_migration_0 (sentinel TEXT)");
    expect(() => migrate(db)).toThrow(/import_migration_0|already exists/i);
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()).toEqual(schema);
    expect(closureSnapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("DROP TABLE temp.import_migration_0");
    migrate(db);
    expect(closureSnapshot(db)).toEqual(before);
    expect(db.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }]);
    expect(db.query("SELECT submit_owner FROM run_steps ORDER BY rowid").all()).toEqual([{ submit_owner: null }, { submit_owner: null }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrate(db);
    const reopened = new Database(path);
    try {
      migrate(reopened); migrate(reopened);
      expect(closureSnapshot(reopened)).toEqual(before);
      expect(reopened.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }]);
      expect(reopened.query("SELECT submit_owner FROM run_steps ORDER BY rowid").all()).toEqual([{ submit_owner: null }, { submit_owner: null }]);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failure after destructive closure rebuild and copied runs restores predecessor schema and data", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "closure-after-copy-"));
  const path = join(dir, "owned.sqlite"), db = new Database(path);
  try {
    seedClosure(db);
    db.exec("CREATE TRIGGER predecessor_thought_immutable BEFORE UPDATE ON thoughts BEGIN SELECT RAISE(ABORT,'predecessor immutable'); END");
    const before = closureSnapshot(db);
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
    const tables = ["thoughts", "thought_titles", "responses", "response_thoughts", "response_seals", "runs", "run_steps", "run_context", "run_operation_receipts", "run_issued_thoughts", "agent_bindings", "export_intents", "export_reports"];
    const foreignKeys = () => tables.map(table => db.query(`PRAGMA foreign_key_list(${table})`).all());
    const originalForeignKeys = foreignKeys();
    let injected = false;
    // Intercept only this connection, after SQLite executes the real run-row copy.
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "exec") return (sql: string) => {
          const result = target.exec(sql);
          if (/^INSERT INTO "runs"\s/i.test(sql) && sql.includes("__preserved_rowid")) {
            injected = true;
            expect(target.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 2 });
            expect(target.query("PRAGMA table_info(thoughts)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "import_document_id" })]));
            throw new Error("injected after run copy");
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => migrate(failingDb)).toThrow("injected after run copy");
    expect(injected).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()).toEqual(schema);
    expect(foreignKeys()).toEqual(originalForeignKeys);
    expect(closureSnapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.run("UPDATE thoughts SET text='changed' WHERE id='subject'")).toThrow(/predecessor immutable/);
    migrate(db);
    expect(closureSnapshot(db)).toEqual(before);
    expect(db.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }]);
    expect(db.query("SELECT submit_owner FROM run_steps ORDER BY rowid").all()).toEqual([{ submit_owner: null }, { submit_owner: null }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const reopened = new Database(path);
    try {
      migrate(reopened); migrate(reopened);
      expect(closureSnapshot(reopened)).toEqual(before);
      expect(reopened.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }]);
      expect(reopened.query("SELECT submit_owner FROM run_steps ORDER BY rowid").all()).toEqual([{ submit_owner: null }, { submit_owner: null }]);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(reopened.query("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='predecessor_thought_immutable'").get()).toEqual({ sql: "CREATE TRIGGER predecessor_thought_immutable BEFORE UPDATE ON thoughts BEGIN SELECT RAISE(ABORT,'predecessor immutable'); END" });
      expect(() => reopened.run("UPDATE thoughts SET text='changed' WHERE id='subject'")).toThrow(/immutable/);
    } finally { reopened.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("populated predecessor steps and exposure witnesses survive core migration and reopen", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "capability-predecessor-"));
  const path = join(dir, "owned.sqlite");
  const db = new Database(path);
  try {
    db.exec(predecessor);
    const thought = { id: "issued", text: "interpretation", title: null, titleAuthor: null, author: "ai", kind: "ai-interpretation", createdAt: "2031", origin: "weave", parentId: "subject", sourceIds: [] } as const;
    const operation = { type: "interpretation", text: "interpretation", sourceIds: [] } as const;
    const result = { type: "interpretation", thought } as const;
    const firstEnvelope = { version: 1, kind: "request", request: { capability: "interpretation", arguments: { text: "interpretation", sourceIds: [] } } } as const;
    const secondEnvelope = { version: 1, kind: "request", request: { capability: "readThought", arguments: { id: "subject" } } } as const;
    db.run("INSERT INTO run_steps VALUES (?,?,?,?,?,?,?,?)", ["run", 0, "prompt-0", "exact initial input", "processed", "completed", JSON.stringify(firstEnvelope), JSON.stringify(result)]);
    db.run("INSERT INTO run_steps VALUES (?,?,?,?,?,?,?,?)", ["run", 1, "prompt-1", "exact successor input", "completed", "completed", JSON.stringify(secondEnvelope), null]);
    db.run("INSERT INTO run_operation_receipts VALUES (?,?,?,?,?,?)", ["run", "prompt-0", JSON.stringify(operation), "issued", JSON.stringify(result), "step"]);
    db.run("INSERT INTO run_issued_thoughts VALUES (?,?,?,?)", ["run", "prompt-0", "issued", 0]);
    expect(() => db.run("UPDATE run_steps SET result_json='{}' WHERE prompt_id='prompt-1'")).toThrow(/CHECK constraint failed/i);
    migrate(db);
    migrate(db);
    const reopened = new Database(path);
    try {
      migrate(reopened);
      const protocol = new SqliteRunProtocolRepository(reopened);
      const operations = new SqliteRunOperations(reopened, { id: () => "unused", now: () => "unused" });
      const store = new SqliteStore(reopened);
      const expectedSteps = [
        { runId: "run", position: 0, promptId: "prompt-0", input: "exact initial input", state: "processed", envelope: firstEnvelope, result },
        { runId: "run", position: 1, promptId: "prompt-1", input: "exact successor input", state: "completed", envelope: secondEnvelope, result: null },
      ] as const;
      expect(protocol.steps("run")).toEqual(expectedSteps);
      expect(reopened.query("SELECT input,envelope_json,result_json FROM run_steps WHERE run_id='run' ORDER BY position").all()).toEqual([
        { input: "exact initial input", envelope_json: JSON.stringify(firstEnvelope), result_json: JSON.stringify(result) },
        { input: "exact successor input", envelope_json: JSON.stringify(secondEnvelope), result_json: null },
      ]);
      expect(operations.stepReceipt("run", "prompt-0")).toEqual({ operation, result });
      expect(reopened.query("SELECT operation_id,thought_id,position FROM run_issued_thoughts WHERE run_id='run'").all()).toEqual([{ operation_id: "prompt-0", thought_id: "issued", position: 0 }]);
      expect(reopened.query("SELECT kind,ref_id,full_read FROM run_context WHERE run_id='run' ORDER BY rowid").all()).toEqual([
        { kind: "thought", ref_id: "subject", full_read: 0 }, { kind: "thought", ref_id: "issued", full_read: 0 }, { kind: "response", ref_id: "reply", full_read: 0 },
      ]);
      expect(store.getThought("issued")).toEqual(thought);
      expect(store.getResponse("reply")).toEqual({ id: "reply", text: "retained text", role: "addendum", state: "complete", thoughtIds: ["issued"] });
      expect(reopened.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => reopened.run("UPDATE run_steps SET prompt_id='changed' WHERE prompt_id='prompt-0'")).toThrow(/immutable/i);
      expect(() => reopened.run("UPDATE run_steps SET input='changed' WHERE prompt_id='prompt-1'")).toThrow(/immutable/i);
      expect(() => reopened.run("DELETE FROM run_context WHERE run_id='run'")).toThrow(/immutable/i);
      expect(protocol.advance({ runId: "run", generation: 1 }, "prompt-0", result, { promptId: "prompt-1", input: "exact successor input" })).toEqual(expectedSteps[1]);
      reopened.exec("SAVEPOINT staged_result");
      reopened.run("UPDATE run_steps SET result_json=? WHERE prompt_id='prompt-1'", [JSON.stringify({ type: "thought", thought: null })]);
      reopened.exec("ROLLBACK TO staged_result; RELEASE staged_result");
      expect(protocol.steps("run")).toEqual(expectedSteps);
      // Existing rows have no import membership; the new membership is guarded by a seal FK.
      expect(reopened.query("PRAGMA table_info(thoughts)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "import_document_id", notnull: 0 }),
      ]));
      expect(reopened.query("PRAGMA foreign_key_list(thoughts)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "import_document_id", table: "import_document_seals", to: "document_id" }),
      ]));
      expect(reopened.query("SELECT id,import_document_id FROM thoughts ORDER BY id").all()).toEqual([
        { id: "issued", import_document_id: null }, { id: "subject", import_document_id: null },
      ]);
    } finally { reopened.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
