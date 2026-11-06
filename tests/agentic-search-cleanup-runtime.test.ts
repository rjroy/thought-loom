import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { RunService } from "../src/domain/run";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { parseSearchCleanupManifest } from "../src/storage/search-cleanup-manifest";
import { SqliteSearchCleanup } from "../src/storage/search-cleanup";
import { createHash } from "node:crypto";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient, candidateFromSuccessor, config, discovery, find, knowledge, logger, now, request, setup } from "./agentic-search-capability-fixture";

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function fixture(script: (index: number, input: string) => object,
  action: (db: Database, store: SqliteStore, worker: ConfiguredRunWorker, client: ScriptedClient, id: () => string, lease: ExecutionOwnerLease) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join("/tmp/opencode", "owned-cleanup-runtime-")), path = join(dir, "owned.sqlite");
  const lease = await ExecutionOwnerLease.acquire(path,logger), db = new Database(path);
  let worker: ConfiguredRunWorker | undefined;
  try {
    migrate(db,logger); lease.register(db); lease.assertRegistered(db);
    let seq = 0; const id = () => `fixture${String(++seq).padStart(24,"0")}`;
    const store = new SqliteStore(db), client = new ScriptedClient(script);
    worker = new ConfiguredRunWorker({ db, config, id, now, logger, executionOwner: lease,
      resolve: async () => ({ url: "http://127.0.0.1:44991" }), client: () => client });
    await action(db,store,worker,client,id,lease);
  } finally {
    if (worker) { worker.pause(); await bounded(worker.drain(),"owned worker drain"); }
    db.close(); lease.release(); rmSync(dir,{ recursive: true, force: true });
  }
}
function stopService(db: Database, id: () => string): RunService {
  return new RunService({ repository: new SqliteRunRepository(db,{ id,now,logger }),id,now,logger,
    dispatcher: { submit: async () => { throw new Error("unused by Stop"); }, observe: async () => { throw new Error("unused by Stop"); } } });
}
type Cleanup = { run_id: string; session_id: string; binding_json: string; last_prompt_id: string; submit_owner: string | null;
  prompt_manifest_json: string; drain_state: string; admission_state: string; state: string; evidence_json: string | null };
function cleanup(db: Database, runId: string): Cleanup | null {
  return db.query("SELECT run_id,session_id,binding_json,last_prompt_id,submit_owner,prompt_manifest_json,drain_state,admission_state,state,evidence_json FROM search_native_cleanup WHERE run_id=?").get(runId) as Cleanup | null;
}
// Bounded technical polls only. Passing run identity explicitly avoids any new
// controller or fake cleanup operation standing in for the actual worker.
async function poll(worker: ConfiguredRunWorker, runId: string, done: () => boolean): Promise<void> {
  for (let i = 0; i < 48 && !done(); i++) { await bounded(worker.tick(runId),"worker tick"); await Bun.sleep(1); }
}

test("Stop records cleanup, retains content, and empty native history cannot settle an uncertain admitted prompt", async () => {
  await fixture(() => ({ version: 1, kind: "search-reply", reply: "PRIVATE-NATIVE-OUTPUT", disposition: "done", sourceThoughtIds: [] }), async (db,store,worker,client,id,lease) => {
    const { runId,session,sessions } = setup(db,store,id), before = knowledge(db);
    client.dropNextAck = true;
    await poll(worker,runId,() => client.prompts.length === 1);
    expect(client.prompts).toHaveLength(1);
    const prompt = client.prompts[0]; if (!prompt) throw new Error("missing owned native prompt");
    expect(db.query("SELECT submit_owner FROM run_steps WHERE run_id=?").get(runId)).toEqual({ submit_owner: lease.id });
    expect(client.sessions.get(prompt.sessionID)?.permissions).toEqual([{ action:"*",resource:"*",effect:"deny" }]);
    const messages = db.query("SELECT rowid,* FROM search_messages WHERE run_id=?").all(runId);
    client.historyMode = "empty";
    expect(await client.inbox()).toEqual([]); expect(await client.active()).toEqual({});
    const readsBeforeStop = client.historyRequests.length;
    stopService(db,id).stop("user",runId);
    expect(db.query("SELECT status,cancellation_state FROM runs WHERE id=?").get(runId)).toEqual({ status:"interrupted",cancellation_state:"pending" });
    expect(db.query("SELECT open_slot,outcome_reason FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot:0,outcome_reason:"stopped" });
    await poll(worker,runId,() => cleanup(db,runId) !== null);
    const pending = cleanup(db,runId);
    expect(pending).not.toBeNull();
    if (!pending) throw new Error("worker did not produce durable cleanup after Stop");
    expect(pending).toEqual(expect.objectContaining({ run_id:runId,session_id:session.id,submit_owner:lease.id,state:"pending" }));
    const manifest = parseSearchCleanupManifest(pending.prompt_manifest_json);
    expect(manifest.setupOwnerId).toBe(lease.id);
    expect(manifest.steps.map(step => step.promptId)).toEqual([prompt.id]);
    for (let i = 0; i < 8; i++) await bounded(worker.tick(runId),"empty native observation");
    expect(client.historyRequests.length).toBeGreaterThan(readsBeforeStop);
    expect(await client.inbox()).toEqual([]); expect(await client.active()).toEqual({});
    expect(cleanup(db,runId)).toEqual(expect.objectContaining({ state:"pending",drain_state:"drained",admission_state:expect.not.stringMatching(/terminal/) }));
    expect(client.prompts).toHaveLength(1); expect(db.query("SELECT rowid,* FROM search_messages WHERE run_id=?").all(runId)).toEqual(messages);
    expect(knowledge(db)).toEqual(before);
    expect(() => sessions.delete("user",session.id)).toThrow(/native-cleanup-required/);
    client.historyMode = "normal";
    await poll(worker,runId,() => (db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId) as { cancellation_state: string }).cancellation_state === "settled");
    expect(db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId)).toEqual({ cancellation_state:"settled" });
    const retained = cleanup(db,runId);
    if (retained) expect(retained.state).toBe("settled");
    const final = JSON.stringify(retained);
    expect(final).not.toContain("PRIVATE-NATIVE-OUTPUT"); expect(final).not.toContain("Find cobalt");
    for (let i = 0; i < 4; i++) await bounded(worker.tick(runId),"settled replay");
    expect(client.prompts).toHaveLength(1);
    expect(db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId)).toEqual({ cancellation_state:"settled" });
    const afterReplay = cleanup(db,runId); if (afterReplay) expect(afterReplay.state).toBe("settled");
  });
});

test("native binding drift remains an ownership conflict and never interrupts foreign work", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"FOREIGN-SECRET",disposition:"done",sourceThoughtIds:[] }), async (db,store,worker,client,id) => {
    const { runId } = setup(db,store,id), before = knowledge(db);
    client.holdOutput = true;
    await poll(worker,runId,() => client.prompts.length === 1);
    const prompt = client.prompts[0]; if (!prompt) throw new Error("missing owned prompt");
    const session = client.sessions.get(prompt.sessionID); if (!session) throw new Error("missing owned native session");
    stopService(db,id).stop("user",runId);
    client.holdOutput = false;
    client.sessions.set(prompt.sessionID,{ ...session, location:{ directory:"/tmp/opencode/foreign-fixture" } });
    await poll(worker,runId,() => cleanup(db,runId) !== null);
    expect(cleanup(db,runId)).not.toBeNull();
    await poll(worker,runId,() => cleanup(db,runId)?.state === "ownership-conflict");
    expect(cleanup(db,runId)?.state).toBe("ownership-conflict");
    expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]);
    expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(before);
    expect(JSON.stringify(cleanup(db,runId))).not.toContain("FOREIGN-SECRET");
  });
});

for (const fence of ["stop","rejection"] as const) test(`${fence} joins held native admission before cleanup without erasing confirmed discoveries`, async () => {
  let candidate = "";
  await fixture((index,input) => {
    if (index === 0) return find();
    if (index === 1) { candidate = candidateFromSuccessor(input); return request("readThought",{ id:candidate }); }
    if (index === 2) return discovery(candidate);
    if (index === 3) return { version:1,kind:"search-reply",reply:"LATE-PRIVATE-OUTPUT",disposition:"done",sourceThoughtIds:[] };
    throw new Error("unexpected extra prompt");
  }, async (db,store,worker,client,id,lease) => {
    const { runId,session } = setup(db,store,id,{ at:"2030-01-01T12:00:00Z",timeZone:"UTC" },["target"]);
    let enter = () => {}, release = () => {};
    const reached = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    client.beforePrompt = async () => { if (client.prompts.length === 3) { enter(); await gate; } };
    let flight: Promise<void> | undefined;
    try {
      for (let i = 0; i < 96; i++) {
        const tick = worker.tick(runId);
        const held = await bounded(Promise.race([reached.then(() => true),tick.then(() => false)]),"held prompt entry");
        if (held) { flight = tick; break; }
      }
      expect(flight).toBeDefined(); expect(client.prompts).toHaveLength(3);
      const discoveries = db.query("SELECT rowid,* FROM search_discoveries WHERE session_id=?").all(session.id);
      expect(discoveries).toHaveLength(1);
      const messages = db.query("SELECT rowid,* FROM search_messages WHERE run_id=?").all(runId);
      if (fence === "stop") stopService(db,id).stop("user",runId);
      else { const rejection = new RejectionService(new SqliteRejectionRepository(db,logger)); rejection.rejectThought("user","target"); rejection.restoreThought("user","target"); }
      const fenced = db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(runId);
      expect(fenced).toEqual(expect.objectContaining({ status:"interrupted",cancellation_state:"pending" }));
      expect(db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot:0 });
      const afterFence = knowledge(db), pendingPolls = [worker.tick(runId),worker.tick(runId)];
      expect(client.prompts).toHaveLength(3);
      client.historyMode = "empty"; release();
      await bounded(Promise.all([...(flight ? [flight] : []),...pendingPolls]),"joined fenced flight");
      await poll(worker,runId,() => cleanup(db,runId) !== null);
      const row = cleanup(db,runId);
      expect(row).not.toBeNull();
      if (!row) throw new Error("worker did not snapshot fenced search cleanup");
      const manifest = parseSearchCleanupManifest(row.prompt_manifest_json);
      expect(manifest.setupOwnerId).toBe(lease.id);
      expect(manifest.steps.map(step => step.promptId)).toEqual(client.prompts.map(prompt => prompt.id));
      expect(row.state).toBe("pending");
      for (let i = 0; i < 6; i++) await bounded(worker.tick(runId),"pending cleanup");
      expect(cleanup(db,runId)?.state).toBe("pending");
      expect(client.prompts).toHaveLength(4);
      expect(db.query("SELECT rowid,* FROM search_discoveries WHERE session_id=?").all(session.id)).toEqual(discoveries);
      expect(db.query("SELECT rowid,* FROM search_messages WHERE run_id=?").all(runId)).toEqual(messages);
      expect(knowledge(db)).toEqual(afterFence);
      expect(JSON.stringify(cleanup(db,runId))).not.toContain("LATE-PRIVATE-OUTPUT");
    } finally { release(); if (flight) await bounded(flight,"held flight cleanup"); }
  });
});

test("cleanup cancels the owned inbox and interrupts only owned active work, then requires terminal reobservation", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"PRIVATE-CANCEL-OUTPUT",disposition:"done",sourceThoughtIds:[] }), async (db,store,worker,client,id) => {
    const { runId } = setup(db,store,id), before = knowledge(db);
    await poll(worker,runId,() => client.prompts.length === 1);
    const prompt = client.prompts[0]; if (!prompt) throw new Error("missing owned prompt");
    const history = client.messages.get(prompt.sessionID); if (!history || history[0]?.type !== "user") throw new Error("missing user history");
    history.splice(1); // Model remains active: this is fake transport state, not a SQL terminal certificate.
    client.activeSessions.add(prompt.sessionID);
    client.queued.push({ id:prompt.id,sessionID:prompt.sessionID,type:"user",payload:{ text:prompt.text },delivery:"queue",time:{ created:10 } });
    client.afterInterrupt = sessionID => {
      client.activeSessions.delete(sessionID);
      history.push({ id:`idle-${prompt.id}`,type:"idle",time:{ created:13 },outcome:"interrupted" });
    };
    stopService(db,id).stop("user",runId);
    await poll(worker,runId,() => (db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId) as { cancellation_state:string }).cancellation_state === "settled");
    expect(client.inboxCancellations).toEqual([{ sessionID:prompt.sessionID,inboxID:prompt.id }]);
    expect(client.interrupts).toEqual([prompt.sessionID]);
    expect(await client.inbox()).toEqual([]); expect(await client.active()).toEqual({});
    expect(db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId)).toEqual({ cancellation_state:"settled" });
    const row = cleanup(db,runId); if (row) {
      expect(row.state).toBe("settled");
      expect(row.evidence_json).toContain(`idle-${prompt.id}`);
      expect(row.evidence_json).not.toContain("PRIVATE-CANCEL-OUTPUT");
    }
    expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(before);
  });
});

test("full paged native history needs every authorized terminal and an earlier admission cannot promote focus", async () => {
  await fixture((index,input) => index === 0 ? find() : index === 1 ? request("readThought",{ id:candidateFromSuccessor(input) }) : { version:1,kind:"search-reply",reply:"DONE",disposition:"done",sourceThoughtIds:[] }, async (db,store,worker,client,id) => {
    const { runId } = setup(db,store,id), before = knowledge(db);
    await poll(worker,runId,() => client.prompts.length === 2);
    expect(client.prompts).toHaveLength(2);
    const second = client.prompts[1]; if (!second) throw new Error("missing second prompt");
    const full = client.messages.get(second.sessionID); if (!full || full.length !== 6) throw new Error("missing owned history");
    stopService(db,id).stop("user",runId);
    let phase = 0, pages = 0;
    client.historyPage = async input => {
      pages++;
      if (!input.cursor) return { data:full.slice(0,3),cursor:{ next:"owned-page-2" } };
      if (input.cursor !== "owned-page-2") throw new Error("unexpected cursor");
      return { data:phase === 0 ? [] : phase === 1 ? full.slice(3,4) : full.slice(3),cursor:{} };
    };
    await poll(worker,runId,() => cleanup(db,runId)?.evidence_json?.includes("admissions") === true);
    for (let i = 0; i < 3; i++) await bounded(worker.tick(runId),"partial first history");
    const first = cleanup(db,runId); expect(first).not.toBeNull();
    expect(first?.state).toBe("pending"); expect(first?.admission_state).toBe("uncertain");
    expect(pages).toBeGreaterThanOrEqual(2);
    phase = 1;
    await poll(worker,runId,() => cleanup(db,runId)?.admission_state === "admitted");
    const admitted = cleanup(db,runId); expect(admitted?.state).toBe("pending"); expect(admitted?.admission_state).toBe("admitted");
    phase = 2;
    await poll(worker,runId,() => (db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId) as { cancellation_state:string }).cancellation_state === "settled");
    expect(db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId)).toEqual({ cancellation_state:"settled" });
    expect(client.prompts).toHaveLength(2); expect(knowledge(db)).toEqual(before);
  });
});

for (const fault of ["cursor-loop","foreign-page","foreign-inbox","model-drift","permissions-drift","endpoint-drift"] as const) test(`${fault} blocks cleanup without cancelling or interrupting foreign context`, async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"PRIVATE-OUTPUT",disposition:"done",sourceThoughtIds:[] }), async (db,store,worker,client,id) => {
    const { runId } = setup(db,store,id), before = knowledge(db);
    await poll(worker,runId,() => client.prompts.length === 1);
    const prompt = client.prompts[0]; if (!prompt) throw new Error("missing prompt");
    const native = client.sessions.get(prompt.sessionID), full = client.messages.get(prompt.sessionID);
    if (!native || !full) throw new Error("missing session history");
    stopService(db,id).stop("user",runId);
    if (fault === "model-drift") client.sessions.set(prompt.sessionID,{ ...native,model:{ providerID:"fixture-provider",id:"different-model" } });
    if (fault === "permissions-drift") client.sessions.set(prompt.sessionID,{ ...native,permissions:[{ action:"*",resource:"*",effect:"allow" }] });
    if (fault === "endpoint-drift") client.serviceUrl = "http://127.0.0.1:44992";
    if (fault === "foreign-inbox") client.queued.push({ id:"foreign-prompt",sessionID:prompt.sessionID,type:"user",payload:{ text:"FOREIGN-CONTENT" },delivery:"queue",time:{ created:20 } });
    if (fault === "cursor-loop") client.historyPage = async input => input.cursor
      ? { data:[],cursor:{ next:"loop" } } : { data:full.slice(0,1),cursor:{ next:"loop" } };
    if (fault === "foreign-page") client.historyPage = async input => input.cursor
      ? { data:[{ id:"FOREIGN-ID",type:"user",time:{ created:20 },text:"FOREIGN-CONTENT" }],cursor:{} }
      : { data:full.slice(0,1),cursor:{ next:"next" } };
    await poll(worker,runId,() => cleanup(db,runId)?.state === "ownership-conflict");
    expect(cleanup(db,runId)?.state).toBe("ownership-conflict");
    expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]);
    expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(before);
    expect(JSON.stringify(cleanup(db,runId))).not.toContain("FOREIGN-CONTENT");
  });
});

test("direct worker drain retains its actual lease until a held cleanup read settles", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"DONE",disposition:"done",sourceThoughtIds:[] }), async (db,store,worker,client,id,lease) => {
    const { runId } = setup(db,store,id);
    await poll(worker,runId,() => client.prompts.length === 1);
    stopService(db,id).stop("user",runId);
    let entered = () => {}, release = () => {};
    const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    client.beforeHistory = async () => { entered(); await gate; };
    const tick = worker.tick(runId);
    try {
      await bounded(reached,"cleanup read entry");
      worker.pause(); let drained = false;
      const drain = worker.drain().then(() => { drained = true; });
      await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
      await expect(ExecutionOwnerLease.acquire(db.filename,logger)).rejects.toThrow("execution owner already held");
      release(); await bounded(Promise.all([tick,drain]),"cleanup drain");
      expect(drained).toBe(true); expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]);
      lease.release();
      const replacement = await ExecutionOwnerLease.acquire(db.filename,logger);
      replacement.release();
    } finally { release(); await bounded(tick,"cleanup tick"); }
  });
});

test("a valid late ACK records metadata only against an already sealed trusted snapshot", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"PRIVATE-LATE-OUTPUT",disposition:"done",sourceThoughtIds:[] }), async (db,store,worker,client,id,lease) => {
    const { runId } = setup(db,store,id), before = knowledge(db);
    let entered = () => {}, release = () => {};
    const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    client.beforePrompt = async () => { entered(); await gate; };
    let flight: Promise<void> | undefined;
    try {
      for (let i = 0; i < 24; i++) {
        const tick = worker.tick(runId), held = await bounded(Promise.race([reached.then(() => true),tick.then(() => false)]),"native prompt entry");
        if (held) { flight = tick; break; }
      }
      expect(flight).toBeDefined(); stopService(db,id).stop("user",runId);
      // Deliberate trusted snapshot setup isolates the pre-fence callback boundary;
      // natural producer timing is covered by the held-flight tests above.
      expect(new SqliteSearchCleanup(db,lease,logger).prepare(runId)).not.toBeNull();
      client.historyMode = "empty"; release(); if (flight) await bounded(flight,"late ACK");
      const prompt = client.prompts[0], row = cleanup(db,runId);
      if (!prompt || !row || !row.evidence_json) throw new Error("missing owned ACK evidence");
      expect(row.admission_state).toBe("admitted");
      expect(JSON.parse(row.evidence_json)).toEqual(expect.objectContaining({ admissions:expect.arrayContaining([expect.objectContaining({ promptId:prompt.id,
        inputSha256:createHash("sha256").update(prompt.text).digest("hex") })]) }));
      expect(row.evidence_json).not.toContain("PRIVATE-LATE-OUTPUT"); expect(row.evidence_json).not.toContain(prompt.text);
      expect(db.query("SELECT status FROM runs WHERE id=?").get(runId)).toEqual({ status:"interrupted" });
      expect(db.query("SELECT count(*) AS n FROM search_messages WHERE run_id=? AND role='assistant'").get(runId)).toEqual({ n:0 });
      expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(before);
    } finally { release(); if (flight) await bounded(flight,"ACK flight cleanup"); }
  });
});

test("qualified never-authorized setup settles locally without native cleanup operations", async () => {
  await fixture(() => ({ version:1,kind:"search-reply",reply:"UNUSED",disposition:"done",sourceThoughtIds:[] }), async (db,store,worker,client,id,lease) => {
    const { runId } = setup(db,store,id), before = knowledge(db);
    await poll(worker,runId,() => client.sessions.size === 1);
    expect(client.sessions.size).toBe(1); expect(client.prompts).toHaveLength(0);
    expect(db.query("SELECT execution_owner_id FROM agent_bindings WHERE run_id=?").get(runId)).toEqual({ execution_owner_id:lease.id });
    const beforeHistory = client.historyRequests.length;
    stopService(db,id).stop("user",runId);
    await poll(worker,runId,() => (db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId) as { cancellation_state:string }).cancellation_state === "settled");
    expect(db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId)).toEqual({ cancellation_state:"settled" });
    const row = cleanup(db,runId); if (row) {
      expect(row.state).toBe("settled"); expect(row.admission_state).toBe("never-submitted");
      expect(parseSearchCleanupManifest(row.prompt_manifest_json).steps.every(step => step.authorization === "never-authorized")).toBe(true);
    }
    expect(client.historyRequests).toHaveLength(beforeHistory); expect(client.interrupts).toEqual([]); expect(client.inboxCancellations).toEqual([]);
    expect(client.prompts).toHaveLength(0); expect(knowledge(db)).toEqual(before);
  });
});
