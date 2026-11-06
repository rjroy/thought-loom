import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { createLogger } from "../src/logging";
import { createHash } from "node:crypto";
import { SqliteRunRepository } from "../src/storage/run";
import { readSearchCleanupSnapshot, type SearchCleanupSnapshot } from "../src/storage/search-cleanup-snapshot";
import { encodeSearchCleanupManifest, parseSearchCleanupManifest, searchCleanupFocus, SearchCleanupJournalError, type SearchCleanupManifest } from "../src/storage/search-cleanup-manifest";

const logger = createLogger("error", () => {});
const legacyCleanup = `CREATE TABLE search_native_cleanup (
  run_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES search_sessions(id),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)), last_prompt_id TEXT NOT NULL, submit_owner TEXT NOT NULL,
  drain_state TEXT NOT NULL CHECK(drain_state IN ('waiting','drained','unknown-after-restart')),
  admission_state TEXT NOT NULL CHECK(admission_state IN ('never-submitted','uncertain','admitted','terminal')),
  prompt_sha256 BLOB, evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','settled','ownership-conflict')),
  CHECK(prompt_sha256 IS NULL OR (typeof(prompt_sha256)='blob' AND length(prompt_sha256)=32)),
  CHECK(admission_state='never-submitted' OR prompt_sha256 IS NOT NULL),
  CHECK(admission_state!='terminal' OR evidence_json IS NOT NULL),
  CHECK(state!='settled' OR (drain_state='drained' AND admission_state IN ('never-submitted','terminal')))
)`;

// This reproduces the immediately preceding cleanup table, not a native completion.
// Search sessions/turns are admitted through the real service; old cleanup is a
// controlled SQL storage fixture. There are no provider or model calls.
function predecessor(db: Database): { freshRun: string; freshSession: string; freshPrompt: string; freshBinding: string } {
  migrate(db, logger);
  db.exec(`DROP TABLE search_native_cleanup; ${legacyCleanup};
    CREATE INDEX fixture_cleanup_state ON search_native_cleanup(state);
    CREATE TRIGGER fixture_cleanup_guard BEFORE UPDATE OF binding_json ON search_native_cleanup
    BEGIN SELECT RAISE(ABORT,'fixture cleanup guard'); END;`);
  let sequence = 0; const id = () => `fixture-${++sequence}`, now = () => "2030-01-01T12:00:00.000Z";
  const sessions = new SqliteStore(db).searchSessions({ id, now, logger });
  function tombstoned(key: string) {
    const session = sessions.create("user", `${key}-session`, {}).session, composer = sessions.openComposer("user", session.id);
    const turn = sessions.admitTurn("user", session.id, `${key}-turn`, { text: `${key} fixture question`, startingThoughtIds: [],
      requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
    const row = db.query("SELECT prompt_id,session_id FROM runs WHERE id=?").get(turn.run.id) as { prompt_id: string; session_id: string };
    const binding = { sessionId: row.session_id, serviceUrl: "http://127.0.0.1:44991", location: { directory: "/tmp/opencode/owned" },
      model: { providerID: "fixture", id: "model" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 };
    db.run("INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES (?,?,?,?,?,?,?)",
      [turn.run.id,row.session_id,binding.serviceUrl,binding.location.directory,JSON.stringify(binding.model),JSON.stringify(binding.permissions),1]);
    db.run("UPDATE search_sessions SET title=NULL,deleted_at=?,revision=revision+1 WHERE id=?", [now(), session.id]);
    return { session: session.id, run: turn.run.id, prompt: row.prompt_id, binding: JSON.stringify(binding) };
  }
  const old = tombstoned("legacy"), fresh = tombstoned("fresh"), pending = tombstoned("pending");
  db.run(`INSERT INTO search_native_cleanup(rowid,run_id,session_id,binding_json,last_prompt_id,submit_owner,drain_state,admission_state,prompt_sha256,evidence_json,state)
    VALUES (77,?,?,?,?,'legacy-unknown-owner','drained','never-submitted',NULL,NULL,'settled')`, [old.run,old.session,old.binding,old.prompt]);
  db.run(`INSERT INTO search_native_cleanup(rowid,run_id,session_id,binding_json,last_prompt_id,submit_owner,drain_state,admission_state,prompt_sha256,evidence_json,state)
    VALUES (78,?,?,?,?,'legacy-unknown-owner','unknown-after-restart','uncertain',zeroblob(32),NULL,'pending')`, [pending.run,pending.session,pending.binding,pending.prompt]);
  return { freshRun: fresh.run, freshSession: fresh.session, freshPrompt: fresh.prompt, freshBinding: fresh.binding };
}
function snapshot(db: Database): unknown {
  return [db.query("SELECT rowid,run_id,session_id,binding_json,last_prompt_id,submit_owner,drain_state,admission_state,hex(prompt_sha256) AS hash,evidence_json,state FROM search_native_cleanup ORDER BY rowid").all(),
    ...["search_sessions", "search_turns", "search_messages", "runs", "run_steps", "agent_bindings"].map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all())];
}
function columns(db: Database): { name: string; notnull: number }[] {
  return db.query("PRAGMA table_info(search_native_cleanup)").all() as { name: string; notnull: number }[];
}

function ownedTurn(db: Database) {
  migrate(db, logger);
  let seq = 0; const id = () => `owned-${++seq}`, now = () => "2030-01-01T12:00:00.000Z";
  const sessions = new SqliteStore(db).searchSessions({ id, now, logger });
  const session = sessions.create("user", "session-key", {}).session, composer = sessions.openComposer("user", session.id);
  const turn = sessions.admitTurn("user", session.id, "turn-key", { text: "PRIVATE-QUESTION", startingThoughtIds: [],
    requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
  const row = db.query("SELECT session_id,prompt_id FROM runs WHERE id=?").get(turn.run.id) as { session_id: string; prompt_id: string };
  db.run("INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES (?,?,?,?,?,?,?)",
    [turn.run.id,row.session_id,"http://127.0.0.1:44991","/tmp/opencode/owned",'{"providerID":"fixture","id":"model"}','[{"action":"*","resource":"*","effect":"deny"}]',1]);
  const stop = () => new SqliteRunRepository(db, { id, now, logger }).stop(turn.run.id);
  return { runId: turn.run.id, sessionId: session.id, nativeId: row.session_id, promptId: row.prompt_id, stop };
}
function readSnapshot(db: Database, runId: string): SearchCleanupSnapshot {
  return db.transaction(() => readSearchCleanupSnapshot(db,runId))();
}
function insertSnapshot(db: Database, snap: SearchCleanupSnapshot): void {
  db.run(`INSERT INTO search_native_cleanup(run_id,session_id,binding_json,last_prompt_id,submit_owner,drain_state,admission_state,prompt_sha256,evidence_json,state,prompt_manifest_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [snap.runId,snap.sessionId,snap.bindingJson,snap.lastPromptId,snap.submitOwner,snap.drainState,snap.admissionState,snap.promptSha256,snap.evidenceJson,snap.state,snap.promptManifestJson]);
}

test("snapshot seals all issued prompts and focuses the last possibly authorized step without content", () => {
  const db = new Database(":memory:");
  try {
    const owner = ownedTurn(db), firstInput = "PRIVATE-FIRST-INPUT CREDENTIAL-SENTINEL SOURCE-THOUGHT-SENTINEL", nextInput = "PRIVATE-SECOND-INPUT";
    // Controlled persisted journal for storage policy only; this is not a native-completion proof.
    db.run("UPDATE run_steps SET input=? WHERE run_id=? AND position=0", [firstInput,owner.runId]);
    db.run("UPDATE run_steps SET state='submitting',submit_owner='old-unqualified' WHERE run_id=? AND position=0", [owner.runId]);
    db.run("UPDATE run_steps SET state='completed',native_state='completed',envelope_json=?,result_json=? WHERE run_id=? AND position=0",
      ['{"kind":"request","data":"PRIVATE-ENVELOPE"}','{"result":"PRIVATE-RESULT"}',owner.runId]);
    db.run("UPDATE run_steps SET state='processed' WHERE run_id=? AND position=0", [owner.runId]);
    db.run("INSERT INTO run_steps(run_id,position,prompt_id,input,state,native_state) VALUES (?,1,'next-prompt',?,'prepared','unknown')", [owner.runId,nextInput]);
    owner.stop();
    expect(() => readSearchCleanupSnapshot(db,owner.runId)).toThrow(SearchCleanupJournalError);
    const before = db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(owner.runId);
    const snap = readSnapshot(db,owner.runId), parsed = parseSearchCleanupManifest(snap.promptManifestJson);
    expect(snap).toEqual(expect.objectContaining({ runId: owner.runId, sessionId: owner.sessionId, lastPromptId: owner.promptId,
      submitOwner: "old-unqualified", drainState: "unknown-after-restart", admissionState: "uncertain", state: "pending", evidenceJson: null }));
    expect(parsed.steps).toEqual([
      { position: 0, promptId: owner.promptId, inputSha256: createHash("sha256").update(firstInput).digest("hex"), submitOwnerId: "old-unqualified", authorization: "authorized-uncertain", state: "processed", nativeState: "completed" },
      { position: 1, promptId: "next-prompt", inputSha256: createHash("sha256").update(nextInput).digest("hex"), submitOwnerId: null, authorization: "never-authorized", state: "prepared", nativeState: "unknown" },
    ]);
    expect(searchCleanupFocus(parsed)).toEqual(parsed.steps[0]);
    expect(encodeSearchCleanupManifest(parsed)).toBe(snap.promptManifestJson);
    for (const secret of ["PRIVATE-FIRST-INPUT","CREDENTIAL-SENTINEL","SOURCE-THOUGHT-SENTINEL",nextInput,"PRIVATE-QUESTION","PRIVATE-ENVELOPE","PRIVATE-RESULT","2030-01-01T12:00:00Z"]) expect(JSON.stringify(snap)).not.toContain(secret);
    expect(db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(owner.runId)).toEqual(before);
    for (const changed of [
      { ...parsed, runId: "other-run" },
      { ...parsed, searchSessionId: "other-session" },
      { ...parsed, fencedGeneration: parsed.fencedGeneration + 1 },
      { ...parsed, steps: parsed.steps.slice(0,1) },
      { ...parsed, steps: [{ ...parsed.steps[0], promptId: "other-prompt" },parsed.steps[1]] },
      { ...parsed, steps: [{ ...parsed.steps[0], inputSha256: "0".repeat(64) },parsed.steps[1]] },
      { ...parsed, unexpected: "content" },
    ]) expect(() => insertSnapshot(db,{ ...snap, promptManifestJson: JSON.stringify(changed) })).toThrow();
    insertSnapshot(db,snap);
    const persisted = JSON.stringify(db.query("SELECT binding_json,prompt_manifest_json,evidence_json FROM search_native_cleanup WHERE run_id=?").get(owner.runId));
    for (const secret of ["PRIVATE-FIRST-INPUT","CREDENTIAL-SENTINEL","SOURCE-THOUGHT-SENTINEL",nextInput,"PRIVATE-QUESTION","PRIVATE-ENVELOPE","PRIVATE-RESULT","2030-01-01T12:00:00Z"]) expect(persisted).not.toContain(secret);
    expect(() => db.run("UPDATE search_native_cleanup SET prompt_manifest_json='{}' WHERE run_id=?", [owner.runId])).toThrow();
    expect(() => db.run("UPDATE search_native_cleanup SET evidence_json='{}',drain_state='drained' WHERE run_id=?", [owner.runId])).toThrow();
    expect(() => db.run("UPDATE search_native_cleanup SET evidence_json='{}',drain_state='drained',admission_state='terminal',state='settled' WHERE run_id=?", [owner.runId])).toThrow();
  } finally { db.close(); }
});

test("manifest codec rejects duplicate keys, extras, malformed steps and invalid authorization", () => {
  const manifest: SearchCleanupManifest = { version: 1, runId: "run", searchSessionId: "search", nativeSessionId: "native", fencedGeneration: 2, setupOwnerId: null,
    steps: [{ position: 0, promptId: "prompt", inputSha256: "ab".repeat(32), submitOwnerId: null, authorization: "never-authorized", state: "prepared", nativeState: "unknown" }] };
  const canonical = encodeSearchCleanupManifest(manifest);
  expect(parseSearchCleanupManifest(canonical)).toEqual(manifest);
  const invalid: unknown[] = [
    { ...manifest, extra: true }, { ...manifest, version: 2 }, { ...manifest, steps: [] },
    { ...manifest, steps: [{ ...manifest.steps[0], position: 1 }] },
    { ...manifest, steps: [manifest.steps[0], { ...manifest.steps[0], position: 1 }] },
    { ...manifest, steps: [{ ...manifest.steps[0], inputSha256: "AB".repeat(32) }] },
    { ...manifest, steps: [{ ...manifest.steps[0], inputSha256: "abc" }] },
    { ...manifest, steps: [{ ...manifest.steps[0], authorization: "authorized-uncertain" }] },
    { ...manifest, steps: [{ ...manifest.steps[0], state: "unknown" }] },
    { ...manifest, steps: [{ ...manifest.steps[0], nativeState: "completed" }] },
    { ...manifest, steps: [{ ...manifest.steps[0], arbitrary: "unsafe" }] },
  ];
  for (const value of invalid) expect(() => parseSearchCleanupManifest(JSON.stringify(value))).toThrow(SearchCleanupJournalError);
  expect(() => parseSearchCleanupManifest(`{"version":1,${canonical.slice(1)}`)).toThrow(SearchCleanupJournalError);
});

test("missing historical input stays unattributed and cannot settle from empty evidence", () => {
  const db = new Database(":memory:");
  try {
    const owner = ownedTurn(db);
    db.run("UPDATE run_steps SET state='uncertain' WHERE run_id=?", [owner.runId]);
    owner.stop();
    const snap = readSnapshot(db,owner.runId), manifest = parseSearchCleanupManifest(snap.promptManifestJson);
    expect(manifest.steps[0]).toEqual(expect.objectContaining({ inputSha256: null, submitOwnerId: null, authorization: "unattributed" }));
    expect(snap).toEqual(expect.objectContaining({ promptSha256: null, submitOwner: null, drainState: "unknown-after-restart", admissionState: "uncertain", state: "pending" }));
    insertSnapshot(db,snap);
    expect(() => db.run("UPDATE search_native_cleanup SET evidence_json='{}',drain_state='drained',state='settled' WHERE run_id=?", [owner.runId])).toThrow();
    expect(db.query("SELECT state,drain_state FROM search_native_cleanup WHERE run_id=?").get(owner.runId)).toEqual({ state: "pending", drain_state: "unknown-after-restart" });
  } finally { db.close(); }
});

test("snapshot requires a terminal owned search run, closed slot and pending cancellation or tombstone", () => {
  const db = new Database(":memory:");
  try {
    const owner = ownedTurn(db);
    expect(() => readSnapshot(db,owner.runId)).toThrow(SearchCleanupJournalError);
    for (const kind of ["weave", "import"]) {
      const id = `${kind}-run`;
      db.run("INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation) VALUES (?,?,'queued',?,?,?,0)", [id,kind,`${kind}-native`,`${kind}-prompt`,"2030"]);
      expect(() => readSnapshot(db,id)).toThrow(SearchCleanupJournalError);
    }
    owner.stop();
    const snap = readSnapshot(db,owner.runId);
    expect(snap).toEqual(expect.objectContaining({ runId: owner.runId, submitOwner: null, admissionState: "never-submitted", state: "pending" }));
    insertSnapshot(db,snap);
    expect(db.query("SELECT run_id,state FROM search_native_cleanup").get()).toEqual({ run_id: owner.runId, state: "pending" });
  } finally { db.close(); }
});

test("a terminal search without pending cancellation requires its tombstone before snapshot", () => {
  const db = new Database(":memory:");
  try {
    const owner = ownedTurn(db);
    // Controlled SQL terminal state for this storage-guard test, not native evidence.
    db.run("UPDATE runs SET status='completed' WHERE id=?", [owner.runId]);
    expect(() => readSnapshot(db,owner.runId)).toThrow(SearchCleanupJournalError);
    db.run("UPDATE search_sessions SET title=NULL,deleted_at='2030-01-02',revision=revision+1 WHERE id=?", [owner.sessionId]);
    const snap = readSnapshot(db,owner.runId);
    expect(snap.runId).toBe(owner.runId);
    insertSnapshot(db,snap);
    expect(db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(owner.runId)).toEqual({ state: "pending" });
  } finally { db.close(); }
});

test("actual migration provides a nullable legacy manifest and honest never-authorized owner", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, logger);
    expect(columns(db)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "prompt_manifest_json", notnull: 0 })]));
    expect(columns(db)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "submit_owner", notnull: 0 })]));
    expect(db.query("PRAGMA foreign_key_list(search_native_cleanup)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ table: "search_sessions", from: "session_id", to: "id" })]));
  } finally { db.close(); }
});

test("legacy settled cleanup keeps its exact bytes, rowid and foreign keys but cannot authorize a fresh manifestless row", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "cleanup-journal-")), path = join(dir, "owned.sqlite"), db = new Database(path);
  try {
    const fresh = predecessor(db), before = snapshot(db);
    const unrelated = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('trigger','index') AND tbl_name!='search_native_cleanup' AND sql IS NOT NULL ORDER BY type,name").all();
    const cleanupArtifacts = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ('fixture_cleanup_state','fixture_cleanup_guard') ORDER BY name").all();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrate(db, logger);
    expect(snapshot(db)).toEqual(before);
    expect(columns(db)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "prompt_manifest_json", notnull: 0 })]));
    expect(db.query("SELECT rowid,prompt_manifest_json FROM search_native_cleanup ORDER BY rowid").all()).toEqual([{ rowid: 77, prompt_manifest_json: null }, { rowid: 78, prompt_manifest_json: null }]);
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('trigger','index') AND tbl_name!='search_native_cleanup' AND sql IS NOT NULL ORDER BY type,name").all()).toEqual(expect.arrayContaining(unrelated));
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ('fixture_cleanup_state','fixture_cleanup_guard') ORDER BY name").all()).toEqual(cleanupArtifacts);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.run("UPDATE search_native_cleanup SET state='pending' WHERE rowid=77")).toThrow();
    expect(() => db.run("UPDATE search_native_cleanup SET evidence_json='{}',drain_state='drained',admission_state='terminal',state='settled' WHERE rowid=78")).toThrow();
    expect(() => db.run(`INSERT INTO search_native_cleanup(run_id,session_id,binding_json,last_prompt_id,submit_owner,drain_state,admission_state,prompt_sha256,evidence_json,state,prompt_manifest_json)
      VALUES (?,?,?,?,NULL,'waiting','never-submitted',NULL,NULL,'pending',NULL)`, [fresh.freshRun,fresh.freshSession,fresh.freshBinding,fresh.freshPrompt])).toThrow();
    const reopened = new Database(path);
    try { migrate(reopened, logger); expect(snapshot(reopened)).toEqual(before); expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]); }
    finally { reopened.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cleanup-table upgrade fault after new manifest column restores legacy schema and rows", () => {
  const db = new Database(":memory:");
  try {
    predecessor(db);
    const before = snapshot(db), schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
    let injected = false;
    const failing = new Proxy(db, { get(target, key) {
      if (key === "exec" || key === "run") return (sql: string, ...params: unknown[]) => {
        const result: unknown = Reflect.apply(Reflect.get(target, key, target), target, [sql, ...params]);
        if (!injected && columns(target).some(column => column.name === "prompt_manifest_json")) {
          injected = true; throw new Error("owned-cleanup-after-manifest");
        }
        return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(() => migrate(failing, logger)).toThrow("owned-cleanup-after-manifest");
    expect(injected).toBe(true); expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all()).toEqual(schema);
    expect(snapshot(db)).toEqual(before); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrate(db, logger); expect(columns(db)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "prompt_manifest_json" })]));
    expect(snapshot(db)).toEqual(before);
  } finally { db.close(); }
});
