import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { createLogger } from "../src/logging";
import { ScriptedClient, config, drive, fixture, now, setup, status } from "./agentic-search-capability-fixture";
import type { NativeSession, PublicClient } from "../src/agent/opencode-adapter";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";

const logger = createLogger("error", () => {});
const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const hasOwners = (db: Database) => db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_owners'").get();
function requireOwners(db: Database): void { expect(hasOwners(db)).toEqual({ name: "execution_owners" }); }

// Isolated legacy predecessor: no registry or setup-owner column. These are
// preserved evidence, not fabricated qualified-ownership records.
function legacy(db: Database): void {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE thoughts(id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,author TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id));
    CREATE TABLE runs(id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,session_id TEXT UNIQUE NOT NULL,prompt_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,generation INTEGER NOT NULL,input_thought_id TEXT REFERENCES thoughts(id),weave_subject_id TEXT REFERENCES thoughts(id),weave_trigger_id TEXT,cancellation_state TEXT NOT NULL DEFAULT 'none');
    CREATE TABLE agent_bindings(run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),session_id TEXT UNIQUE NOT NULL,service_url TEXT NOT NULL,directory TEXT NOT NULL,model_json TEXT NOT NULL,permissions_json TEXT NOT NULL,protocol_version INTEGER NOT NULL);
    CREATE TRIGGER legacy_thought_guard BEFORE UPDATE ON thoughts BEGIN SELECT RAISE(ABORT,'legacy guard'); END;
    CREATE INDEX legacy_binding_endpoint ON agent_bindings(service_url);
    INSERT INTO thoughts(rowid,id,text,author,kind,created_at,origin) VALUES(17,'subject','legacy café','user','captured-original','2030','fixture');
    INSERT INTO runs(rowid,id,kind,status,session_id,prompt_id,created_at,generation,weave_subject_id,weave_trigger_id) VALUES(41,'legacy-run','weave','uncertain','native-old','prompt-old','2030',3,'subject','trigger');
    INSERT INTO runs(rowid,id,kind,status,session_id,prompt_id,created_at,generation) VALUES(42,'legacy-import','import','queued','native-import','prompt-import','2030',0);
    INSERT INTO agent_bindings(rowid,run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES
      (57,'legacy-run','native-old','http://127.0.0.1:44991','/owned','{"providerID":"fixture","id":"model"}','[]',1),
      (58,'legacy-import','native-import','http://127.0.0.1:44991','/owned','{"providerID":"fixture","id":"model"}','[]',1);`);
}
function legacySnapshot(db: Database): unknown {
  return [db.query("SELECT rowid,id,hex(CAST(text AS BLOB)) AS text,author,kind,created_at,origin,parent_id FROM thoughts ORDER BY rowid").all(),
    db.query("SELECT rowid,id,kind,status,session_id,prompt_id,created_at,generation,input_thought_id,weave_subject_id,weave_trigger_id,cancellation_state FROM runs ORDER BY rowid").all(),
    db.query("SELECT rowid,run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version FROM agent_bindings ORDER BY rowid").all(),
    db.query("SELECT type,name,sql FROM sqlite_master WHERE name IN ('legacy_thought_guard','legacy_binding_endpoint') ORDER BY name").all()];
}

test("actual migration introduces registry and nullable binding FK without changing legacy bytes", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "owner-provenance-migration-")), path = join(dir, "owned.sqlite"), db = new Database(path);
  try {
    legacy(db); const before = legacySnapshot(db);
    migrate(db, logger);
    expect(legacySnapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    requireOwners(db);
    const ownerColumns = db.query("PRAGMA table_info(execution_owners)").all() as { name: string; pk: number }[];
    expect(ownerColumns).toEqual(expect.arrayContaining([expect.objectContaining({ name: "id", pk: 1 }), expect.objectContaining({ name: "database_identity" }), expect.objectContaining({ name: "lease_protocol" })]));
    expect(db.query("PRAGMA table_info(agent_bindings)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "execution_owner_id", notnull: 0 })]));
    expect(db.query("PRAGMA foreign_key_list(agent_bindings)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ table: "execution_owners", from: "execution_owner_id", to: "id" })]));
    expect(db.query("SELECT execution_owner_id FROM agent_bindings ORDER BY rowid").all()).toEqual([{ execution_owner_id: null }, { execution_owner_id: null }]);
    migrate(db, logger);
    const reopened = new Database(path);
    try { migrate(reopened, logger); expect(legacySnapshot(reopened)).toEqual(before); expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]); }
    finally { reopened.close(); }
    db.run("INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation,weave_subject_id,weave_trigger_id) VALUES ('fk-run','weave','queued','fk-native','fk-prompt','2030',0,'subject','fk-trigger')");
    expect(() => db.run("INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version,execution_owner_id) VALUES ('fk-run','fk-native','http://127.0.0.1:44991','/owned','{}','[]',1,'no-such-owner')")).toThrow(/FOREIGN KEY/i);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real runtime binds search setup to its registered owner before the native session call", async () => {
  const dir = mkdtempSync(join("/tmp/opencode", "owner-provenance-binding-")), path = join(dir, "owned.sqlite"), db = new Database(path);
  let daemon: RunningDaemon | undefined, poll: (() => void) | undefined;
  try {
    migrate(db, logger);
    let sequence = 0; const id = () => `fixture${String(++sequence).padStart(24, "0")}`;
    const store = new SqliteStore(db), { runId } = setup(db, store, id);
    const captured: ({ execution_owner_id: string | null } | null)[] = [];
    class OwnedClient extends ScriptedClient {
      override async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
        captured.push(db.query("SELECT execution_owner_id FROM agent_bindings WHERE run_id=?").get(runId) as { execution_owner_id: string | null } | null);
        return super.sessionCreate(input);
      }
    }
    const client = new OwnedClient(() => ({ version: 1, kind: "search-reply", reply: "Finished.", disposition: "done", sourceThoughtIds: [] }));
    daemon = await startDaemon({ dbPath: path, port: 0, credentials, agent: { service: { url: "http://127.0.0.1:44991" }, directory: "/tmp/opencode/owned-fixture",
      model: { providerID: "fixture", id: "fixture-model" }, effort: { quick: null, standard: null, thorough: null } } }, () => {}, {
      logSink: () => {}, startTimer(callback) { poll = callback; return () => { poll = undefined; }; },
      resolveAgentService: async () => ({ url: "http://127.0.0.1:44991" }), createPublicClient: () => client,
    });
    requireOwners(db);
    const owner = db.query("SELECT id FROM execution_owners").get() as { id: string } | null;
    if (!owner) throw new Error("missing runtime-issued owner");
    for (let i = 0; i < 100; i++) {
      if (!poll) throw new Error("missing owned polling timer"); poll();
      await Bun.sleep(2);
      if ((db.query("SELECT status FROM runs WHERE id=?").get(runId) as { status: string }).status === "completed") break;
    }
    expect(client.sessions.size).toBe(1);
    expect(captured).toEqual([{ execution_owner_id: owner.id }]);
    expect(db.query("SELECT execution_owner_id FROM agent_bindings WHERE run_id=?").get(runId)).toEqual({ execution_owner_id: owner.id });
    expect(db.query("SELECT submit_owner FROM run_steps WHERE run_id=? AND position=0").get(runId)).toEqual({ submit_owner: owner.id });
    expect(() => db.run("UPDATE agent_bindings SET execution_owner_id=NULL WHERE run_id=?", [runId])).toThrow();
    expect(db.query("SELECT status FROM runs WHERE id=?").get(runId)).toEqual({ status: "completed" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { await daemon?.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("registry migration failure after table creation rolls back schema and legacy evidence", () => {
  const db = new Database(":memory:");
  try {
    legacy(db); const before = legacySnapshot(db);
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
    let injected = false;
    // Wrap the real connection only to fail after the actual table appears inside
    // migrate's transaction, never replacing its migration implementation.
    const failing = new Proxy(db, { get(target, key) {
      if (key === "exec" || key === "run") return (sql: string, ...params: unknown[]) => {
        const method = Reflect.get(target, key, target);
        const result: unknown = Reflect.apply(method, target, [sql, ...params]);
        if (!injected && hasOwners(target)) { injected = true; throw new Error("owned-registry-after-create"); }
        return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(() => migrate(failing, logger)).toThrow("owned-registry-after-create");
    expect(injected).toBe(true); expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all()).toEqual(schema);
    expect(legacySnapshot(db)).toEqual(before); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrate(db, logger); requireOwners(db); expect(legacySnapshot(db)).toEqual(before);
  } finally { db.close(); }
});

test("populated pre-provenance search journal keeps its unqualified submit owner and schema evidence", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "owner-legacy-search-")), path = join(dir, "owned.sqlite"), db = new Database(path);
  try {
    // Construct the actual immediate predecessor with all current search migrations,
    // suppressing only the new owner DDL during fixture setup. The upgrade itself
    // below always executes the real migrate against the real connection.
    const predecessor = new Proxy(db, { get(target, key) {
      if (key === "exec") return (sql: string) => {
        if (sql.includes("execution_owners") || sql.includes("execution_owner_id")) return;
        return target.exec(sql);
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    migrate(predecessor, logger);
    expect(hasOwners(db)).toBeNull();
    let sequence = 0; const id = () => `legacy-${++sequence}`, now = () => "2030-01-01T12:00:00.000Z";
    const store = new SqliteStore(db), sessions = store.searchSessions({ id, now, logger });
    store.saveThought({ id: "fixture-thought", text: "owned legacy café", title: "legacy", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
    const session = sessions.create("user", "legacy-session", {}).session, composer = sessions.openComposer("user", session.id);
    const turn = sessions.admitTurn("user", session.id, "legacy-turn", { text: "exact legacy question", startingThoughtIds: ["fixture-thought"], requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
    const native = db.query("SELECT session_id FROM runs WHERE id=?").get(turn.run.id) as { session_id: string };
    db.run("INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES (?,?,'http://127.0.0.1:44991','/owned','{}','[]',1)", [turn.run.id,native.session_id]);
    db.run("UPDATE run_steps SET input='legacy exact journal café',state='submitting',submit_owner='legacy-unqualified-owner' WHERE run_id=?", [turn.run.id]);
    db.run("UPDATE runs SET status='uncertain' WHERE id=?", [turn.run.id]);
    const tables = ["thoughts", "thought_titles", "runs", "run_steps", "run_context", "search_sessions", "search_turns", "search_messages", "search_content_dependencies", "search_composer_contexts", "search_composer_dependencies"];
    const snapshot = (connection: Database) => [tables.map(table => connection.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()),
      connection.query("SELECT rowid,run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version FROM agent_bindings ORDER BY rowid").all()];
    const before = snapshot(db);
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
    const foreignKeys = (connection: Database) => (connection.query("PRAGMA foreign_key_list(agent_bindings)").all() as { table: string; from: string; to: string; on_update: string; on_delete: string; match: string }[])
      .map(({ table, from, to, on_update, on_delete, match }) => ({ table, from, to, on_update, on_delete, match }));
    const fks = foreignKeys(db);
    migrate(db, logger);
    expect(snapshot(db)).toEqual(before);
    expect(db.query("SELECT submit_owner FROM run_steps WHERE run_id=?").get(turn.run.id)).toEqual({ submit_owner: "legacy-unqualified-owner" });
    expect(db.query("SELECT execution_owner_id FROM agent_bindings WHERE run_id=?").get(turn.run.id)).toEqual({ execution_owner_id: null });
    expect(db.query("SELECT id FROM execution_owners WHERE id='legacy-unqualified-owner'").get()).toBeNull();
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all()).toEqual(expect.arrayContaining(schema));
    expect(foreignKeys(db)).toEqual(expect.arrayContaining(fks));
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const reopened = new Database(path);
    try { migrate(reopened, logger); expect(snapshot(reopened)).toEqual(before); expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]); }
    finally { reopened.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real configless runtime records a fresh immutable owner per lease with the owned database identity", async () => {
  const dir = mkdtempSync(join("/tmp/opencode", "owner-provenance-runtime-")), path = join(dir, "owned.sqlite");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ dbPath: path, port: 0, credentials }, () => {}, { logSink: () => {} });
    const read = new Database(path);
    let first: { id: string; database_identity: string; lease_protocol: string | number };
    try {
      requireOwners(read);
      const rows = read.query("SELECT id,database_identity,lease_protocol FROM execution_owners").all() as typeof first[];
      expect(rows).toHaveLength(1); const row = rows[0]; if (!row) throw new Error("missing owner"); first = row;
      expect(first.id.length).toBeGreaterThan(0); expect(first.database_identity.length).toBeGreaterThan(0); expect(first.lease_protocol).not.toBeNull();
      expect(() => read.run("UPDATE execution_owners SET database_identity='changed' WHERE id=?", [first.id])).toThrow();
      expect(() => read.run("DELETE FROM execution_owners WHERE id=?", [first.id])).toThrow();
    } finally { read.close(); }
    await daemon.stop(); daemon = undefined;
    const lease = await ExecutionOwnerLease.acquire(path, logger);
    try { expect(first.database_identity).toBe(lease.databaseIdentity); }
    finally { lease.release(); }
    daemon = await startDaemon({ dbPath: path, port: 0, credentials }, () => {}, { logSink: () => {} });
    const reopened = new Database(path);
    try {
      const rows = reopened.query("SELECT id,database_identity,lease_protocol FROM execution_owners").all() as typeof first[];
      expect(rows).toHaveLength(2); expect(rows).toContainEqual(first);
      const second = rows.find(row => row.id !== first.id);
      expect(second).toBeDefined(); expect(second?.database_identity).toBe(first.database_identity); expect(second?.lease_protocol).toBe(first.lease_protocol);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
  } finally { await daemon?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a real lease registers its own branded identity and rejects copied databases and release", async () => {
  const dir = mkdtempSync(join("/tmp/opencode", "owner-provenance-copy-")), path = join(dir, "owned.sqlite"), copy = join(dir, "copy.sqlite");
  const lease = await ExecutionOwnerLease.acquire(path, logger);
  let db: Database | undefined, copied: Database | undefined;
  try {
    db = new Database(path); migrate(db, logger); lease.register(db); lease.assertRegistered(db);
    expect(db.query("SELECT id,database_identity,lease_protocol FROM execution_owners WHERE id=?").get(lease.id))
      .toEqual({ id: lease.id, database_identity: lease.databaseIdentity, lease_protocol: lease.leaseProtocol });
    db.close(); db = undefined;
    copyFileSync(path, copy);
    const reopened = new Database(path), copiedDb = new Database(copy); db = reopened; copied = copiedDb;
    expect(copiedDb.query("SELECT id FROM execution_owners WHERE id=?").get(lease.id)).toEqual({ id: lease.id });
    expect(() => lease.assertRegistered(copiedDb)).toThrow();
    lease.assertRegistered(reopened);
    lease.release();
    expect(() => lease.assertRegistered(reopened)).toThrow();
  } finally { copied?.close(); db?.close(); lease.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("a real held lease supplies search setup and submission attribution before native calls", async () => {
  const dir = mkdtempSync(join("/tmp/opencode", "owner-provenance-port-")), path = join(dir, "owned.sqlite");
  const lease = await ExecutionOwnerLease.acquire(path, logger), db = new Database(path);
  let worker: ConfiguredRunWorker | undefined;
  try {
    migrate(db, logger); lease.register(db); lease.assertRegistered(db);
    let sequence = 0; const id = () => `fixture${String(++sequence).padStart(24, "0")}`;
    const { runId } = setup(db, new SqliteStore(db), id);
    const beforeSetup: ({ execution_owner_id: string | null } | null)[] = [];
    class OwnedClient extends ScriptedClient {
      override async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
        beforeSetup.push(db.query("SELECT execution_owner_id FROM agent_bindings WHERE run_id=?").get(runId) as { execution_owner_id: string | null } | null);
        return super.sessionCreate(input);
      }
    }
    const client = new OwnedClient(() => ({ version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] }));
    worker = new ConfiguredRunWorker({ db, config, id, now, logger, executionOwner: lease,
      resolve: async () => ({ url: "http://127.0.0.1:44991" }), client: () => client });
    await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    expect(beforeSetup).toEqual([{ execution_owner_id: lease.id }]);
    expect(db.query("SELECT submit_owner FROM run_steps WHERE run_id=? AND position=0").get(runId)).toEqual({ submit_owner: lease.id });
    expect(db.query("SELECT id,database_identity,lease_protocol FROM execution_owners WHERE id=?").get(lease.id))
      .toEqual({ id: lease.id, database_identity: lease.databaseIdentity, lease_protocol: lease.leaseProtocol });
  } finally { worker?.pause(); db.close(); lease.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("an isolated worker without a lease never manufactures qualified setup or submission attribution", async () => {
  await fixture(() => ({ version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] }), async (db, store, worker, _client, id) => {
    const { runId } = setup(db, store, id); await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    expect(db.query("SELECT execution_owner_id FROM agent_bindings WHERE run_id=?").get(runId)).toEqual({ execution_owner_id: null });
    const step = db.query("SELECT submit_owner FROM run_steps WHERE run_id=? AND position=0").get(runId) as { submit_owner: string | null } | null;
    expect(step?.submit_owner).toBeTruthy();
    expect(db.query("SELECT id FROM execution_owners WHERE id=?").get(step?.submit_owner ?? "")).toBeNull();
  });
});
