import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createToolApp, OwnedGrants } from "../src/tool-boundary";
import { WeavingWorker, type Observation, type WeavingAdapter, type WeavingRun } from "../src/weaving";
import { NativeWeavingAdapter, type NativeClientPort, type NativeSession } from "../src/native-adapter";
import { KnowledgeService } from "../src/knowledge";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-follow-up-"));
  directories.push(directory);
  const databasePath = join(directory, "fixture.sqlite"), app = createApp({ databasePath });
  const capture = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "root" }, body: JSON.stringify({ text: "Original handoff question.", provenance: "test fixture" }) });
  expect(capture.status).toBe(201);
  const root = await capture.json() as { id: string; text: string };
  const opened = await app.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: root.id } }) });
  expect(opened.status).toBe(201);
  const dialogue = await opened.json() as { id: string };
  let turn: { id: string; sourceId: string; jobId: string };
  const submit = async (key: string) => {
    const response = await app.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text: `Test discussion ${key}` }) });
    expect(response.status).toBe(201);
    turn = await response.json() as { id: string; sourceId: string; jobId: string };
    return turn;
  };
  let observation: Observation = { kind: "pending" };
  const admitted: WeavingRun[] = [];
  const adapter: WeavingAdapter = {
    async prepareSession(run) { new OwnedGrants(databasePath).bind({ run, location: "/fixture/location", agent: "weaver", sourceIds: [root.id, turn.sourceId], operations: ["record_idea", "record_alias"] }); },
    async admit(run) { admitted.push(run); return { kind: "admitted" }; },
    async inspect() { return observation; },
    async stop() {},
  };
  const worker = new WeavingWorker({ databasePath, adapter, ...(now ? { now, leaseMs: 10 } : {}) });
  const tools = createToolApp({ databasePath, location: "/fixture/location", transportCredential: "fixture-only-credential" });
  const start = async (key: string) => {
    const turn = await submit(key);
    const result = await worker.startNext();
    expect(result.kind).toBe("started");
    if (result.kind !== "started") throw new Error("Expected dialogue admission");
    expect(result.run.jobId).toBe(turn.jobId);
    return { run: result.run, turn };
  };
  const idea = async (run: WeavingRun, current: Awaited<ReturnType<typeof submit>>, suffix: string) => {
    const response = await tools.request("/internal/tools/record-idea", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-only-credential" }, body: JSON.stringify({ native: { sessionID: run.sessionId, agent: "weaver", messageID: `msg_${suffix}`, callID: `call_${suffix}` }, input: { rootSourceId: root.id, turnSourceId: current.sourceId, dialogueId: dialogue.id, turnId: current.id, text: `Developing idea ${suffix}`, evidenceSourceIds: [root.id, current.sourceId] } }) });
    expect(response.status).toBe(200);
    return await response.json() as { id: string; current: { id: string } };
  };
  const settle = async (outcome: "completed" | "failed" | "interrupted") => {
    observation = outcome === "completed" ? { kind: "completed", recordedChanges: 0, assistant: { messageId: "msg_answer", text: "A response." } } : { kind: outcome };
    await worker.recover();
  };
  const jobs = () => {
    const db = new Database(databasePath, { readonly: true });
    try { return db.query<{ id: string; sourceId: string; status: string }, []>("SELECT id,source_id AS sourceId,status FROM jobs WHERE kind='follow_up' ORDER BY rowid").all(); }
    finally { db.close(); }
  };
  return { databasePath, app, root, dialogue, submit, start, idea, settle, jobs, worker, adapter, admitted, tools };
}

test("successful meaningful dialogue creates durable root follow-up after restart without duplicating capture", async () => {
  const f = await fixture(), first = await f.start("first");
  const saved = await f.idea(first.run, first.turn, "first");
  expect(saved.current.id).toBeTruthy();
  expect(f.jobs()).toHaveLength(0); // no hidden work before settlement
  await f.settle("completed");
  const reopened = new Database(f.databasePath, { readonly: true });
  try {
    expect(f.jobs()).toEqual([expect.objectContaining({ sourceId: f.root.id, status: "queued" })]);
    expect(reopened.query("SELECT count(*) AS count FROM jobs WHERE source_id=? AND kind='capture'").get(f.root.id)).toEqual({ count: 1 });
    expect(reopened.query("SELECT text FROM sources WHERE id=?").get(f.root.id)).toEqual({ text: f.root.text });
  } finally { reopened.close(); }
  await new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).recover();
  expect(f.jobs()).toHaveLength(1);
});

test("prose-only completion does not schedule follow-up", async () => {
  const f = await fixture(); await f.start("prose"); await f.settle("completed");
  expect(f.jobs()).toEqual([]);
});

test("an alias-only tool receipt does not schedule meaningful-change follow-up", async () => {
  const f = await fixture(), started = await f.start("alias");
  const response = await f.tools.request("/internal/tools/record-alias", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-only-credential" }, body: JSON.stringify({ native: { sessionID: started.run.sessionId, agent: "weaver", messageID: "msg_alias", callID: "call_alias" }, input: { alias: "SDK", expansion: "software development kit", evidenceSourceIds: [f.root.id] } }) });
  expect(response.status).toBe(200);
  await f.settle("completed");
  expect(f.jobs()).toEqual([]);
});

test("failed and interrupted dialogue retains changes without scheduling follow-up", async () => {
  for (const outcome of ["failed", "interrupted"] as const) {
    const f = await fixture(), started = await f.start(outcome);
    const saved = await f.idea(started.run, started.turn, outcome);
    await f.settle(outcome);
    const response = await f.app.request(`/dialogues/${f.dialogue.id}`);
    expect(await response.json()).toMatchObject({ turns: [{ status: outcome, changes: [expect.objectContaining({ id: saved.id })] }] });
    expect(f.jobs()).toEqual([]);
  }
});

test("explicit Stop prevents follow-up even when completion wins the race", async () => {
  const f = await fixture(), started = await f.start("stopped");
  const saved = await f.idea(started.run, started.turn, "stopped");
  const stop = await f.app.request(`/dialogues/${f.dialogue.id}/turns/${started.turn.id}/stop`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "stop" }, body: JSON.stringify({ expectedRunId: started.run.runId }) });
  expect(stop.status).toBe(202);
  await f.settle("completed");
  expect(await (await f.app.request(`/dialogues/${f.dialogue.id}`)).json()).toMatchObject({ turns: [{ status: "completed", changes: [expect.objectContaining({ id: saved.id })] }] });
  expect(f.jobs()).toEqual([]);
});

test("pending follow-up coalesces by root and yields to the next dialogue", async () => {
  const f = await fixture(), first = await f.start("one");
  await f.idea(first.run, first.turn, "one"); await f.settle("completed");
  expect(f.jobs()).toHaveLength(1);
  const second = await f.start("two");
  await f.idea(second.run, second.turn, "two"); await f.settle("completed");
  expect(f.jobs()).toHaveLength(1);
  const third = await f.submit("three");
  const next = await f.worker.startNext();
  expect(next.kind).toBe("started");
  if (next.kind !== "started") throw new Error("Expected foreground admission");
  expect(next.run.jobId).toBe(third.jobId);
  expect(f.jobs()).toEqual([expect.objectContaining({ status: "queued" })]);
});

test("settlement preserves exact originating turn and item version across reopen", async () => {
  const f = await fixture(), started = await f.start("origin"), saved = await f.idea(started.run, started.turn, "origin");
  await f.settle("completed");
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const rows = db.query(`SELECT o.run_id AS runId,o.turn_id AS turnId,t.item_id AS itemId,t.formulation_id AS versionId
      FROM follow_up_origins o JOIN follow_up_targets t ON t.origin_run_id=o.run_id WHERE o.job_id=?`).all(f.jobs()[0]?.id);
    expect(rows).toEqual([{ runId: started.run.runId, turnId: started.turn.id, itemId: saved.id, versionId: saved.current.id }]);
  } finally { db.close(); }
});

test("failed outbox insertion rolls back settlement and recovery retains the committed idea", async () => {
  let now = 1000;
  const f = await fixture(() => now), started = await f.start("rollback"), saved = await f.idea(started.run, started.turn, "rollback");
  const db = new Database(f.databasePath);
  try { db.run("CREATE TRIGGER fixture_block_followup BEFORE INSERT ON follow_up_origins BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"); } finally { db.close(); }
  await expect(f.settle("completed")).rejects.toThrow();
  expect(f.jobs()).toEqual([]);
  expect(await (await f.app.request(`/dialogues/${f.dialogue.id}`)).json()).toMatchObject({ turns: [{ status: "running", changes: [expect.objectContaining({ id: saved.id })] }] });
  const reopen = new Database(f.databasePath);
  try { reopen.run("DROP TRIGGER fixture_block_followup"); } finally { reopen.close(); }
  now += 11;
  await f.settle("completed");
  expect(f.jobs()).toEqual([expect.objectContaining({ sourceId: f.root.id, status: "queued" })]);
});

test("coalesced pending work retains both immutable origins and their exact versions", async () => {
  const f = await fixture(), first = await f.start("origin-one"), a = await f.idea(first.run, first.turn, "origin_one");
  await f.settle("completed");
  const second = await f.start("origin-two"), b = await f.idea(second.run, second.turn, "origin_two");
  await f.settle("completed");
  expect(f.jobs()).toHaveLength(1);
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const rows = db.query<{ runId: string; turnId: string; itemId: string; versionId: string }, [string]>(`SELECT o.run_id AS runId,o.turn_id AS turnId,t.item_id AS itemId,t.formulation_id AS versionId
      FROM follow_up_origins o JOIN follow_up_targets t ON t.origin_run_id=o.run_id WHERE o.job_id=? ORDER BY o.rowid`).all(f.jobs()[0]?.id ?? "");
    expect(rows).toEqual([{ runId: first.run.runId, turnId: first.turn.id, itemId: a.id, versionId: a.current.id }, { runId: second.run.runId, turnId: second.turn.id, itemId: b.id, versionId: b.current.id }]);
  } finally { db.close(); }
});

function scriptedNative(databasePath: string) {
  const sessions = new Map<string, NativeSession>(), prompts: WeavingRun[] = [];
  const client: NativeClientPort = {
    async discover() { return { url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }; },
    async identity() { return { version: "2.2.2", pid: 42 }; },
    async createSession(run) {
      const session: NativeSession = { id: run.sessionId, ownerRunId: run.runId, location: "/fixture/location", agent: "weaver", model: { providerID: "fixture", id: "model", variant: "default" }, permissionActions: ["deny:*:*", "allow:record_interpretation"] };
      sessions.set(run.sessionId, session); return session;
    },
    async getSession(id) { const session = sessions.get(id); if (!session) throw new Error("Unknown fixture session"); return session; },
    async prompt(run) { prompts.push(run); return { promptId: run.promptId }; },
    async activity() { return { active: false, outcome: "succeeded" }; },
    async history(id) { const run = prompts.find((entry) => entry.sessionId === id); if (!run) throw new Error("Unknown fixture prompt"); return { messages: [{ id: run.promptId, type: "user", state: "completed" }, { id: "msg_answer", type: "assistant", state: "completed", text: "" }] }; },
  };
  return { prompts, worker: new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter({ client, databasePath, registrationFile: "/fixture/registration", location: "/fixture/location", agent: "weaver", model: { providerID: "fixture", id: "model" }, operations: ["record_interpretation"] }) }) };
}

test("queued follow-up executes via native adapter and completes without recursive work", async () => {
  const f = await fixture(), first = await f.start("native");
  await f.idea(first.run, first.turn, "native"); await f.settle("completed");
  // Drain the earlier original capture before selecting the follow-up.
  const capture = new WeavingWorker({ databasePath: f.databasePath, adapter: { async prepareSession() {}, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "completed", recordedChanges: 0 }; } } });
  const original = await capture.startNext(); expect(original.kind).toBe("started"); await capture.recover();
  const native = scriptedNative(f.databasePath), next = await native.worker.startNext();
  expect(next.kind).toBe("started");
  if (next.kind !== "started") throw new Error("Expected follow-up admission");
  expect(next.run.kind).toBe("follow_up");
  expect(native.prompts).toEqual([next.run]);
  await native.worker.recover();
  expect(f.jobs()).toEqual([expect.objectContaining({ status: "completed" })]);
  expect((await native.worker.startNext()).kind).toBe("empty");
});

test("root follow-up status is separately readable with origins, targets and bounded results", async () => {
  const f = await fixture(), first = await f.start("status"), saved = await f.idea(first.run, first.turn, "status");
  await f.settle("completed");
  const response = await createApp({ databasePath: f.databasePath }).request(`/sources/${f.root.id}/follow-ups`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ jobs: [expect.objectContaining({ id: f.jobs()[0]?.id, status: "queued", origins: [expect.objectContaining({ turnId: first.turn.id, turnSourceId: first.turn.sourceId })], targets: [expect.objectContaining({ kind: "item", id: saved.id, versionId: saved.current.id })], actions: { retry: false } })], truncated: false });
});

test("trusted user correction queues its own durable change once on command replay", async () => {
  const f = await fixture(), knowledge = new KnowledgeService(f.databasePath);
  const item = knowledge.createItem({ actor: "ai", operationId: "fixture-item", runId: "fixture-run" }, { kind: "interpretation", sourceId: f.root.id, text: "Initial interpretation", evidenceSourceIds: [f.root.id] });
  const turn = await f.submit("correction"), text = "Test discussion correction";
  const post = () => f.app.request(`/items/${item.id}/correct`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "correct-once" }, body: JSON.stringify({ expectedVersionId: item.current.id, text, sourceId: turn.sourceId }) });
  const first = await post(); expect(first.status).toBe(200);
  const corrected = await first.json();
  const replay = await post(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(corrected);
  expect(f.jobs()).toEqual([expect.objectContaining({ sourceId: f.root.id, status: "queued" })]);
  expect(await (await f.app.request(`/sources/${turn.sourceId}`)).json()).toMatchObject({ text });
  expect(await (await f.app.request(`/sources/${f.root.id}`)).json()).toMatchObject(f.root);
});
