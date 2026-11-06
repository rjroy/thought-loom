import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { RunSupervisor } from "../src/agent/supervisor";
import type { SearchSessionSources, SearchSessions } from "../src/domain/agentic-search";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { parseSearchCleanupManifest } from "../src/storage/search-cleanup-manifest";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient, candidateFromSuccessor, config, discovery, find, knowledge, logger, now, request, setup } from "./agentic-search-capability-fixture";

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)),4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function fixture(script: (index:number,input:string) => object,
  action: (db:Database,store:SqliteStore,worker:ConfiguredRunWorker,client:ScriptedClient,id:() => string,lease:ExecutionOwnerLease) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join("/tmp/opencode","owned-retention-runtime-")), path = join(dir,"owned.sqlite");
  const lease = await ExecutionOwnerLease.acquire(path,logger), db = new Database(path);
  let worker: ConfiguredRunWorker | undefined;
  try {
    migrate(db,logger); lease.register(db); let sequence = 0;
    const id = () => `fixture${String(++sequence).padStart(24,"0")}`;
    const store = new SqliteStore(db), client = new ScriptedClient(script);
    worker = new ConfiguredRunWorker({ db,config,id,now,logger,executionOwner:lease,
      resolve: async () => ({ url:"http://127.0.0.1:44991" }),client:() => client });
    await action(db,store,worker,client,id,lease);
  } finally {
    if (worker) { worker.pause(); await bounded(worker.drain(),"owned worker drain"); }
    db.close(); lease.release(); rmSync(dir,{ recursive:true,force:true });
  }
}

function retainedSessions(store: SqliteStore, worker: ConfiguredRunWorker, sources: SearchSessionSources): SearchSessions {
  const controller = worker.searchRetention();
  expect(controller).not.toBeNull();
  if (!controller) throw new Error("configured worker has no trusted search retention controller");
  return store.searchSessions(sources,controller);
}
async function poll(worker: ConfiguredRunWorker, runId: string, done: () => boolean): Promise<void> {
  for (let i=0;i<96 && !done();i++) { await bounded(worker.tick(runId),"worker tick"); await Bun.sleep(1); }
}
function rows(db: Database, runId: string, sessionId: string): unknown {
  return [
    ...["search_sessions","search_turns","search_messages","search_discoveries","search_content_dependencies","search_composer_contexts","search_composer_dependencies","search_native_cleanup","runs","run_steps","run_context","agent_bindings","run_operation_receipts","run_issued_thoughts","run_replies"]
      .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()),
    db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(runId),
    db.query("SELECT id,title,deleted_at,revision FROM search_sessions WHERE id=?").get(sessionId),
  ];
}
function control(db:Database,runId:string): { status:string } | null { return db.query("SELECT status FROM runs WHERE id=?").get(runId) as { status:string } | null; }

test("an explicitly configured controller purges a completed bound session, while the ordinary repository still refuses", async () => {
  let candidate = "";
  await fixture((index,input) => {
    if (index === 0) return find();
    if (index === 1) { candidate = candidateFromSuccessor(input); return request("readThought",{ id:candidate }); }
    if (index === 2) return discovery(candidate);
    if (index === 3) return { version:1,kind:"search-reply",reply:"PRIVATE-RETAINED-REPLY",disposition:"done",sourceThoughtIds:[candidate] };
    throw new Error("unexpected extra prompt");
  },async (db,store,worker,client,id,lease) => {
    const { runId,session,sessions } = setup(db,store,id), library = knowledge(db);
    await poll(worker,runId,() => control(db,runId)?.status === "completed");
    expect(control(db,runId)?.status).toBe("completed"); expect(client.prompts).toHaveLength(4);
    expect(db.query("SELECT count(*) AS n FROM search_discoveries WHERE session_id=?").get(session.id)).toEqual({ n:1 });
    expect(db.query("SELECT execution_owner_id FROM agent_bindings WHERE run_id=?").get(runId)).toEqual({ execution_owner_id:lease.id });
    const before = rows(db,runId,session.id);
    expect(() => sessions.delete("user",session.id)).toThrow(/native-cleanup-required/);
    expect(rows(db,runId,session.id)).toEqual(before);
    const retention = retainedSessions(store,worker,{ id,now,logger });
    expect(() => retention.delete("ai",session.id)).toThrow();
    expect(rows(db,runId,session.id)).toEqual(before);
    retention.delete("user",session.id);
    expect(db.query("SELECT title,deleted_at FROM search_sessions WHERE id=?").get(session.id)).toEqual({ title:null,deleted_at:now() });
    expect(() => retention.create("user","session",{})).toThrow(/session-deleted/);
    expect(retention.turnByKey("user",session.id,"turn")).toBeNull();
    for (const table of ["search_turns","search_messages","search_discoveries","search_content_dependencies","search_composer_contexts"]) {
      expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(session.id)).toEqual({ n:0 });
    }
    for (const table of ["runs","run_steps","run_context","agent_bindings","run_operation_receipts","run_issued_thoughts","run_replies"]) {
      const column = table === "runs" ? "id" : "run_id";
      expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(runId)).toEqual({ n:0 });
    }
    expect(db.query("SELECT count(*) AS n FROM search_composer_dependencies").get()).toEqual({ n:0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(knowledge(db)).toEqual(library); expect(client.prompts).toHaveLength(4);
  });
});

test("Delete returns while an authorized native admission is held, retaining only cleanup metadata", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"LATE-PRIVATE-OUTPUT",disposition:"done",sourceThoughtIds:[] }),async (db,store,worker,client,id,lease) => {
    const { runId,session,sessions } = setup(db,store,id), library = knowledge(db);
    let enter = () => {}, release = () => {}, released = false;
    const reached = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
    client.beforePrompt = async () => { enter(); await gate; };
    let flight: Promise<void> | undefined;
    try {
      for (let i=0;i<24;i++) {
        const tick = worker.tick(runId), held = await bounded(Promise.race([reached.then(() => true),tick.then(() => false)]),"native admission entry");
        if (held) { flight = tick; break; }
      }
      expect(flight).toBeDefined(); expect(client.prompts).toHaveLength(0);
      expect(db.query("SELECT submit_owner FROM run_steps WHERE run_id=?").get(runId)).toEqual({ submit_owner:lease.id });
      const issued = db.query("SELECT input FROM run_steps WHERE run_id=?").get(runId) as { input:string } | null;
      if (!issued?.input) throw new Error("missing authorized owned input");
      const before = rows(db,runId,session.id);
      expect(() => sessions.delete("user",session.id)).toThrow(/native-cleanup-required/);
      expect(rows(db,runId,session.id)).toEqual(before);
      const retention = retainedSessions(store,worker,{ id,now,logger });
      client.historyMode = "empty";
      retention.delete("user",session.id);
      expect(released).toBe(false);
      expect(db.query("SELECT id FROM runs WHERE id=?").get(runId)).toBeNull();
      expect(db.query("SELECT count(*) AS n FROM search_messages WHERE session_id=?").get(session.id)).toEqual({ n:0 });
      const snapshot = db.query("SELECT prompt_manifest_json,state FROM search_native_cleanup WHERE run_id=?").get(runId) as { prompt_manifest_json:string; state:string } | null;
      expect(snapshot?.state).toBe("pending"); if (!snapshot) throw new Error("missing retained cleanup");
      const manifest = parseSearchCleanupManifest(snapshot.prompt_manifest_json);
      expect(manifest.setupOwnerId).toBe(lease.id); expect(manifest.steps).toHaveLength(1);
      expect(manifest.steps[0]?.authorization).toBe("authorized-uncertain");
      expect(JSON.stringify(snapshot)).not.toContain("Find cobalt");
      expect(JSON.stringify(db.query("SELECT * FROM search_native_cleanup WHERE run_id=?").get(runId))).not.toContain(issued.input);
      release(); if (flight) await bounded(flight,"admission flight");
      const prompt = client.prompts[0]; if (!prompt) throw new Error("missing late owned admission");
      const ack = db.query("SELECT admission_state,evidence_json FROM search_native_cleanup WHERE run_id=?").get(runId) as { admission_state:string; evidence_json:string|null } | null;
      expect(ack?.admission_state).toBe("admitted");
      if (!ack?.evidence_json) throw new Error("missing late admission metadata");
      expect(JSON.parse(ack.evidence_json)).toEqual(expect.objectContaining({ admissions:expect.arrayContaining([expect.objectContaining({ promptId:prompt.id,
        inputSha256:createHash("sha256").update(prompt.text).digest("hex") })]) }));
      expect(ack.evidence_json).not.toContain(issued.input);
      await poll(worker,runId,() => (db.query("SELECT drain_state FROM search_native_cleanup WHERE run_id=?").get(runId) as { drain_state:string } | null)?.drain_state === "drained");
      expect(db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(runId)).toEqual({ state:"pending" });
      expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(library);
      expect(db.query("SELECT id FROM runs WHERE id=?").get(runId)).toBeNull();
      client.historyMode = "normal";
      await poll(worker,runId,() => {
        const row = db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(runId) as { state:string } | null;
        return row === null || row.state === "settled";
      });
      const final = db.query("SELECT state,evidence_json FROM search_native_cleanup WHERE run_id=?").get(runId) as { state:string; evidence_json:string|null } | null;
      if (final) { expect(final.state).toBe("settled"); expect(final.evidence_json).not.toContain("LATE-PRIVATE-OUTPUT"); }
      expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(library);
    } finally { release(); if (flight) await bounded(flight,"held flight cleanup"); }
  });
});

test("retention rolls back the whole delete when a fault fires after the cleanup snapshot", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"PRIVATE-OUTPUT",disposition:"done",sourceThoughtIds:[] }),async (db,store,worker,client,id) => {
    const { runId,session,sessions } = setup(db,store,id); client.holdOutput = true;
    await poll(worker,runId,() => client.prompts.length === 1);
    expect(client.prompts).toHaveLength(1);
    const before = rows(db,runId,session.id), library = knowledge(db);
    expect(() => sessions.delete("user",session.id)).toThrow(/native-cleanup-required/);
    expect(rows(db,runId,session.id)).toEqual(before);
    const retention = retainedSessions(store,worker,{ id,now,logger });
    db.exec(`CREATE TEMP TRIGGER owned_retention_fault BEFORE DELETE ON main.search_messages
      WHEN EXISTS (SELECT 1 FROM search_native_cleanup WHERE run_id=OLD.run_id)
      BEGIN SELECT RAISE(ABORT,'owned-retention-after-snapshot'); END`);
    let failure: unknown;
    try { retention.delete("user",session.id); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("missing expected retention failure");
    expect(failure.message).toContain("search-persistence-failed");
    expect(failure.cause).toBeInstanceOf(Error);
    expect(String(failure.cause)).toContain("owned-retention-after-snapshot");
    expect(rows(db,runId,session.id)).toEqual(before); expect(knowledge(db)).toEqual(library);
    expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]); expect(client.prompts).toHaveLength(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

test("retention rejects wrong connection, forged controller and nested transaction without scheduling work", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"unused",disposition:"done",sourceThoughtIds:[] }),async (db,store,worker,client,id) => {
    const { runId,session } = setup(db,store,id), before = rows(db,runId,session.id);
    const owner = worker.searchRetention(); if (!owner) throw new Error("missing real retention controller");
    const second = new Database(db.filename);
    try { expect(() => new SqliteStore(second).searchSessions({ id,now,logger },owner)).toThrow(/search-retention-connection-mismatch/); }
    finally { second.close(); }
    expect(() => Reflect.apply(store.searchSessions,store,[{ id,now,logger },{ purgeInTransaction() {}, afterCommit() {} }])).toThrow(/search-retention-requires-controller/);
    const retention = store.searchSessions({ id,now,logger },owner);
    db.exec("BEGIN");
    try { expect(() => retention.delete("user",session.id)).toThrow(/search-retention-requires-root-transaction/); }
    finally { db.exec("ROLLBACK"); }
    expect(rows(db,runId,session.id)).toEqual(before);
    expect(client.prompts).toHaveLength(0); expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]);
    expect(() => owner.afterCommit([])).toThrow(/search-retention-commit-unavailable/);
  });
});

test("Delete joins already-started native setup without authorizing a new prompt", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"unused",disposition:"done",sourceThoughtIds:[] }),async (db,store,worker,client,id) => {
    const { runId,session } = setup(db,store,id), library = knowledge(db);
    let enter = () => {}, release = () => {};
    const reached = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    client.beforeCreate = async () => { enter(); await gate; };
    let flight: Promise<void> | undefined;
    try {
      for (let i=0;i<24;i++) {
        const tick = worker.tick(runId);
        if (await bounded(Promise.race([reached.then(() => true),tick.then(() => false)]),"setup entry")) { flight = tick; break; }
      }
      expect(flight).toBeDefined(); expect(client.prompts).toHaveLength(0);
      const retention = retainedSessions(store,worker,{ id,now,logger });
      retention.delete("user",session.id);
      expect(control(db,runId)).toBeNull(); expect(client.prompts).toHaveLength(0);
      const row = db.query("SELECT prompt_manifest_json,state FROM search_native_cleanup WHERE run_id=?").get(runId) as { prompt_manifest_json:string; state:string } | null;
      expect(row?.state).toBe("pending"); if (!row) throw new Error("missing pending setup cleanup");
      expect(parseSearchCleanupManifest(row.prompt_manifest_json).steps.every(step => step.authorization === "never-authorized")).toBe(true);
      release(); if (flight) await bounded(flight,"setup flight");
      await poll(worker,runId,() => {
        const entry = db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(runId) as {state:string} | null;
        return entry === null || entry.state === "settled";
      });
      const final = db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(runId) as {state:string} | null;
      if (final) expect(final.state).toBe("settled");
      expect(client.prompts).toHaveLength(0); expect(knowledge(db)).toEqual(library);
    } finally { release(); if (flight) await bounded(flight,"setup cleanup"); }
  });
});

test("Delete during held Stop cleanup reuses the sealed snapshot and does not resurrect local content", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"PRIVATE-HELD-REPLY",disposition:"done",sourceThoughtIds:[] }),async (db,store,worker,client,id) => {
    const { runId,session } = setup(db,store,id), library = knowledge(db);
    client.dropNextAck = true;
    await poll(worker,runId,() => client.prompts.length === 1);
    expect(client.prompts).toHaveLength(1); client.historyMode = "empty";
    new SqliteRunRepository(db,{ id,now,logger }).stop(runId);
    await poll(worker,runId,() => db.query("SELECT 1 FROM search_native_cleanup WHERE run_id=?").get(runId) !== null);
    const before = db.query("SELECT run_id,session_id,binding_json,last_prompt_id,submit_owner,prompt_sha256,prompt_manifest_json FROM search_native_cleanup WHERE run_id=?").get(runId);
    expect(before).not.toBeNull();
    let enter = () => {}, release = () => {};
    const reached = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    client.beforeHistory = async () => { enter(); await gate; };
    const flight = worker.tick(runId);
    try {
      await bounded(reached,"held cleanup history");
      const retention = retainedSessions(store,worker,{ id,now,logger });
      retention.delete("user",session.id);
      expect(db.query("SELECT run_id,session_id,binding_json,last_prompt_id,submit_owner,prompt_sha256,prompt_manifest_json FROM search_native_cleanup WHERE run_id=?").get(runId)).toEqual(before);
      expect(control(db,runId)).toBeNull();
      expect(db.query("SELECT count(*) AS n FROM search_messages WHERE session_id=?").get(session.id)).toEqual({ n:0 });
      release(); await bounded(flight,"held cleanup completion");
      await poll(worker,runId,() => (db.query("SELECT drain_state FROM search_native_cleanup WHERE run_id=?").get(runId) as {drain_state:string}|null)?.drain_state === "drained");
      expect(db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(runId)).toEqual({ state:"pending" });
      expect(JSON.stringify(db.query("SELECT * FROM search_native_cleanup WHERE run_id=?").get(runId))).not.toContain("PRIVATE-HELD-REPLY");
      expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(library);
    } finally { release(); await bounded(flight,"held cleanup release"); }
  });
});

test("unqualified historical submission stays pending after Delete without guessed native cleanup", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"PRIVATE-UNQUALIFIED",disposition:"done",sourceThoughtIds:[] }),async (db,store,worker,client,id) => {
    const { runId,session } = setup(db,store,id), library = knowledge(db);
    // An actual isolated worker without a lease represents earlier unqualified
    // ownership; it is paused and drained before the lease-owned worker acts.
    const old = new ConfiguredRunWorker({ db,config,id,now,logger,resolve:async () => ({url:"http://127.0.0.1:44991"}),client:() => client });
    try {
      client.dropNextAck = true;
      await poll(old,runId,() => client.prompts.length === 1);
      expect(client.prompts).toHaveLength(1);
      expect(db.query("SELECT execution_owner_id FROM agent_bindings WHERE run_id=?").get(runId)).toEqual({ execution_owner_id:null });
      const step = db.query("SELECT submit_owner FROM run_steps WHERE run_id=?").get(runId) as { submit_owner:string };
      expect(step.submit_owner).toBeTruthy();
      expect(db.query("SELECT id FROM execution_owners WHERE id=?").get(step.submit_owner)).toBeNull();
    } finally { old.pause(); await bounded(old.drain(),"unqualified old worker drain"); }
    client.historyMode = "empty";
    const retention = retainedSessions(store,worker,{ id,now,logger });
    retention.delete("user",session.id);
    const beforeReads = client.historyRequests.length;
    for (let i=0;i<6;i++) await bounded(worker.tick(runId),"unqualified cleanup tick");
    const row = db.query("SELECT state,drain_state,prompt_manifest_json FROM search_native_cleanup WHERE run_id=?").get(runId) as {state:string;drain_state:string;prompt_manifest_json:string}|null;
    expect(row).toEqual(expect.objectContaining({ state:"pending",drain_state:"unknown-after-restart" }));
    expect(client.historyRequests).toHaveLength(beforeReads); expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]);
    expect(client.prompts).toHaveLength(1); expect(control(db,runId)).toBeNull(); expect(knowledge(db)).toEqual(library);
  });
});

test("a coalesced wake processes a small purged backlog without synchronous Delete fanout", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"PRIVATE-BACKLOG",disposition:"done",sourceThoughtIds:[] }),async (db,store,worker,client,id) => {
    const first = setup(db,store,id), library = knowledge(db);
    const runs = [{ runId:first.runId,sessionId:first.session.id }];
    for (let i=0;i<2;i++) {
      const session = first.sessions.create("user",`backlog-session-${i}`,{}).session;
      const composer = first.sessions.openComposer("user",session.id);
      const turn = first.sessions.admitTurn("user",session.id,`backlog-turn-${i}`,{ text:`question-${i}`,startingThoughtIds:[],
        requestClock:{ at:"2030-01-01T12:00:00Z",timeZone:"UTC" },composerId:composer.composerId,contextToken:composer.contextToken });
      runs.push({ runId:turn.run.id,sessionId:session.id });
    }
    client.historyMode = "empty";
    for (const [index,run] of runs.entries()) {
      client.dropNextAck = true;
      await poll(worker,run.runId,() => client.prompts.length === index+1);
      expect(client.prompts).toHaveLength(index+1);
    }
    const supervisor = new RunSupervisor({ db,worker,logger,startTimer:() => () => {} });
    supervisor.start();
    try {
      const retention = retainedSessions(store,worker,{ id,now,logger }), historyBefore = client.historyRequests.length;
      for (const run of runs) retention.delete("user",run.sessionId);
      expect(client.historyRequests).toHaveLength(historyBefore);
      expect(client.prompts).toHaveLength(runs.length);
      for (let i=0;i<16;i++) await bounded(supervisor.poll(),"backlog scan");
      for (const run of runs) {
        expect(db.query("SELECT state,drain_state FROM search_native_cleanup WHERE run_id=?").get(run.runId)).toEqual({ state:"pending",drain_state:"drained" });
        expect(control(db,run.runId)).toBeNull();
      }
      expect(client.historyRequests.length).toBeGreaterThan(historyBefore);
      expect(client.prompts).toHaveLength(runs.length); expect(knowledge(db)).toEqual(library);
    } finally { await bounded(supervisor.stop(),"backlog supervisor stop"); }
  });
});
