import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { RunService } from "../src/domain/run";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { initialWorkerPrompt } from "../src/agent/worker-prompts";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient, config, knowledge, logger, now, setup } from "./agentic-search-capability-fixture";

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise,new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)),4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function stop(db: Database, id: () => string): RunService {
  return new RunService({ repository:new SqliteRunRepository(db,{ id,now,logger }),id,now,logger,
    dispatcher:{ submit:async () => { throw new Error("unused by Stop"); },observe:async () => { throw new Error("unused by Stop"); } } });
}
function unbound(db: Database, runId: string): void {
  expect(db.query("SELECT count(*) AS n FROM agent_bindings WHERE run_id=?").get(runId)).toEqual({ n:0 });
  expect(db.query("SELECT state,native_state,input,submit_owner,envelope_json,result_json FROM run_steps WHERE run_id=? AND position=0").get(runId))
    .toEqual({ state:"prepared",native_state:"unknown",input:null,submit_owner:null,envelope_json:null,result_json:null });
  expect(db.query("SELECT count(*) AS n FROM search_native_cleanup WHERE run_id=?").get(runId)).toEqual({ n:0 });
}
function assertPurged(db: Database, runId: string, sessionId: string): void {
  expect(db.query("SELECT id FROM runs WHERE id=?").get(runId)).toBeNull();
  for (const table of ["search_turns","search_messages","search_discoveries","search_content_dependencies","search_composer_contexts"]) {
    expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(sessionId)).toEqual({ n:0 });
  }
  expect(db.query("SELECT title,deleted_at FROM search_sessions WHERE id=?").get(sessionId)).toEqual({ title:null,deleted_at:now() });
  expect(db.query("SELECT count(*) AS n FROM search_native_cleanup WHERE run_id=?").get(runId)).toEqual({ n:0 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

for (const scenario of ["before-first-tick","held-service-resolution"] as const) test(`user Stop then Delete succeeds for an untouched unbound run: ${scenario}`, async () => {
  const dir = mkdtempSync(join("/tmp/opencode","unbound-stop-owned-")), path = join(dir,"owned.sqlite");
  const lease = await ExecutionOwnerLease.acquire(path,logger), db = new Database(path);
  let worker: ConfiguredRunWorker | undefined, flight: Promise<void> | undefined;
  let enter = () => {}, release = () => {}, resolverCalls = 0, clientCalls = 0;
  const reached = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    migrate(db,logger); lease.register(db); let sequence = 0;
    const id = () => `fixture${String(++sequence).padStart(24,"0")}`;
    const store = new SqliteStore(db), client = new ScriptedClient(() => ({ version:1,kind:"search-reply",reply:"unused",disposition:"done",sourceThoughtIds:[] }));
    worker = new ConfiguredRunWorker({ db,config,id,now,logger,executionOwner:lease,
      resolve:async () => { resolverCalls++; if (scenario === "held-service-resolution") { enter(); await gate; } return {url:"http://127.0.0.1:44991"}; },
      client:() => { clientCalls++; return client; } });
    const { runId,session } = setup(db,store,id), library = knowledge(db);
    const owner = worker.searchRetention(); if (!owner) throw new Error("missing actual retention controller");
    const sessions = store.searchSessions({ id,now,logger },owner);
    expect(db.query("SELECT role,text FROM search_messages WHERE run_id=?").all(runId)).toEqual([{ role:"user",text:"Find cobalt" }]);
    unbound(db,runId);
    if (scenario === "held-service-resolution") {
      flight = worker.tick(runId); await bounded(reached,"owned resolver entry");
      expect(resolverCalls).toBe(1); expect(clientCalls).toBe(0); unbound(db,runId);
    }
    const service = stop(db,id);
    // @ts-expect-error Verify the actual user-only runtime guard.
    expect(() => service.stop("ai",runId)).toThrow();
    service.stop("user",runId);
    expect(db.query("SELECT status FROM runs WHERE id=?").get(runId)).toEqual({ status:"interrupted" });
    expect(db.query("SELECT open_slot,outcome_reason FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot:0,outcome_reason:"stopped" });
    expect(db.query("SELECT role,text FROM search_messages WHERE run_id=?").all(runId)).toEqual([{ role:"user",text:"Find cobalt" }]);
    unbound(db,runId);
    if (scenario === "before-first-tick") await bounded(worker.tick(runId),"unbound cleanup tick");
    // Whether safe local classification is 'none' or 'settled', a pristine
    // unbound run must not remain undeletable or need fabricated native proof.
    sessions.delete("user",session.id);
    assertPurged(db,runId,session.id);
    expect(() => sessions.create("user","session",{})).toThrow(/session-deleted/);
    expect(knowledge(db)).toEqual(library);
    expect(clientCalls).toBe(0); expect(client.sessions.size).toBe(0); expect(client.prompts).toHaveLength(0);
    if (scenario === "held-service-resolution") {
      let drained = false; worker.pause(); const drain = worker.drain().then(() => { drained = true; });
      await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
      release(); await bounded(Promise.all([...(flight ? [flight] : []),drain]),"resolver joined drain");
      expect(drained).toBe(true); expect(clientCalls).toBe(0); expect(client.sessions.size).toBe(0); expect(client.prompts).toHaveLength(0);
      expect(db.query("SELECT count(*) AS n FROM agent_bindings WHERE run_id=?").get(runId)).toEqual({ n:0 });
      expect(db.query("SELECT count(*) AS n FROM search_native_cleanup WHERE run_id=?").get(runId)).toEqual({ n:0 });
      expect(knowledge(db)).toEqual(library);
    } else expect(resolverCalls).toBe(0);
  } finally {
    release(); if (flight) await bounded(flight,"resolver cleanup");
    if (worker) { worker.pause(); await bounded(worker.drain(),"worker cleanup"); }
    db.close(); lease.release(); rmSync(dir,{ recursive:true,force:true });
  }
});

for (const scenario of ["prepared-input","later-prepared-step","failed-not-stopped"] as const) test(`retention refuses an ambiguous unbound journal atomically: ${scenario}`, async () => {
  const dir = mkdtempSync(join("/tmp/opencode","unbound-stop-negative-")), path = join(dir,"owned.sqlite");
  const lease = await ExecutionOwnerLease.acquire(path,logger), db = new Database(path);
  let worker: ConfiguredRunWorker | undefined, clientCalls = 0, resolverCalls = 0;
  try {
    migrate(db,logger); lease.register(db); let sequence = 0;
    const id = () => `fixture${String(++sequence).padStart(24,"0")}`;
    const store = new SqliteStore(db), client = new ScriptedClient(() => ({ version:1,kind:"search-reply",reply:"unused",disposition:"done",sourceThoughtIds:[] }));
    worker = new ConfiguredRunWorker({ db,config,id,now,logger,executionOwner:lease,
      resolve:async () => { resolverCalls++; return {url:"http://127.0.0.1:44991"}; },client:() => { clientCalls++; return client; } });
    const { runId,session } = setup(db,store,id), library = knowledge(db);
    const owner = worker.searchRetention(); if (!owner) throw new Error("missing actual retention controller");
    const sessions = store.searchSessions({ id,now,logger },owner), repo = new SqliteRunRepository(db,{ id,now,logger });
    if (scenario === "prepared-input") {
      const claim = repo.claim(runId);
      const prepared = new SqliteRunWorkerState(db,{ id,now,logger }).prepareInitial(claim,initialWorkerPrompt);
      stop(db,id).stop("user",runId);
      expect(prepared.input).toContain("Find cobalt");
      expect(db.query("SELECT input,state FROM run_steps WHERE run_id=? AND position=0").get(runId)).toEqual({ input:prepared.input,state:"prepared" });
    } else if (scenario === "later-prepared-step") {
      // Ordered extra prepared row is accepted by the current SQL guards. It is
      // a defensive storage fixture, not a claim of native execution/completion.
      db.run("INSERT INTO run_steps(run_id,position,prompt_id,state,native_state) VALUES (?,1,'msg_extra_fixture','prepared','unknown')",[runId]);
      stop(db,id).stop("user",runId);
      expect(db.query("SELECT position,state FROM run_steps WHERE run_id=? ORDER BY position").all(runId)).toEqual([{ position:0,state:"prepared" },{ position:1,state:"prepared" }]);
    } else {
      const claim = repo.claim(runId);
      new SqliteRunOperations(db,{ id,now,logger }).fail(claim);
      expect(db.query("SELECT status FROM runs WHERE id=?").get(runId)).toEqual({ status:"failed" });
      expect(db.query("SELECT open_slot,outcome_reason FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot:0,outcome_reason:"failed" });
    }
    expect(db.query("SELECT count(*) AS n FROM agent_bindings WHERE run_id=?").get(runId)).toEqual({ n:0 });
    const tables = ["search_sessions","search_turns","search_messages","search_discoveries","search_content_dependencies","search_composer_contexts","search_composer_dependencies","search_revisions","search_native_cleanup","runs","run_steps","run_context","agent_bindings"];
    const snapshot = () => tables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    expect(() => sessions.delete("user",session.id)).toThrow(/native-cleanup-required/);
    expect(snapshot()).toEqual(before); expect(knowledge(db)).toEqual(library);
    expect(db.query("SELECT count(*) AS n FROM search_native_cleanup WHERE run_id=?").get(runId)).toEqual({ n:0 });
    expect(clientCalls).toBe(0); expect(resolverCalls).toBe(0); expect(client.sessions.size).toBe(0); expect(client.prompts).toHaveLength(0);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    if (worker) { worker.pause(); await bounded(worker.drain(),"negative worker cleanup"); }
    db.close(); lease.release(); rmSync(dir,{ recursive:true,force:true });
  }
});
