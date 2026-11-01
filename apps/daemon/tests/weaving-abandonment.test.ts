import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDialogueView, parseFollowUpStatusView, parseWeavingStatusView } from "@thoughtloom/contracts";
import { createApp } from "../src/app";
import { createToolApp, OwnedGrants } from "../src/tool-boundary";
import { ABANDONMENT_ACKNOWLEDGEMENT, WeavingAbandonmentService, type AbandonUncertainInput } from "../src/weaving-abandonment";
import { NativeWeavingAdapter, type NativeClientPort, type NativeSession } from "../src/native-adapter";
import { openDatabase } from "../src/storage";
import { WeavingWorker, type WeavingAdapter } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-abandon-")); directories.push(directory);
  const databasePath = join(directory, "test.sqlite"), app = createApp({ databasePath });
  async function capture(key: string) {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text: `Test-owned original ${key}`, provenance: "manual" }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; text: string };
  }
  const first = await capture("first"), second = await capture("second");
  const adapter: WeavingAdapter = { async prepareSession(run) { new OwnedGrants(databasePath).bind({ run, location: directory, agent: "weaver", sourceIds: [run.sourceId], operations: ["record_interpretation"] }); }, async admit() { return { kind: "uncertain" }; }, async inspect() { return { kind: "pending" }; } };
  const worker = new WeavingWorker({ databasePath, adapter });
  const started = await worker.startNext();
  if (started.kind !== "started") throw new Error("Expected controlled uncertain run");
  expect((await worker.getJob(first.id))?.status).toBe("uncertain");
  expect(await worker.startNext()).toEqual({ kind: "empty" });
  return { directory, databasePath, first, second, run: started.run, worker };
}

test("capture contract represents local abandonment without retry or a native outcome", () => {
  const worker = { configured: true, state: "waiting" }, run = { id: "run-fixture" };
  const capture = { sourceId: "source-fixture", worker, job: { id: "job-fixture", status: "abandoned", attempts: 1, recordedChanges: 0 }, run, actions: { retry: false } };
  const uncertain = { ...capture, job: { ...capture.job, status: "uncertain" } };
  expect<unknown>(parseWeavingStatusView(uncertain)).toEqual(uncertain);
  expect<unknown>(parseWeavingStatusView(capture)).toEqual(capture);
  expect(parseWeavingStatusView({ ...capture, actions: { retry: true } })).toBeNull();
});

test("follow-up contract represents local abandonment without retry", () => {
  const worker = { configured: true, state: "waiting" }, run = { id: "run-fixture" };
  const follow = { sourceId: "source-fixture", worker, truncated: false, jobs: [{ id: "follow-fixture", status: "abandoned", attempts: 1, run, recordedChanges: 0,
    origins: [], originsTruncated: false, targets: [], targetsTruncated: false, changes: [], changesTruncated: false, actions: { retry: false } }] };
  const uncertain = { ...follow, jobs: [{ ...follow.jobs[0], status: "uncertain" }] };
  expect<unknown>(parseFollowUpStatusView(uncertain)).toEqual(uncertain);
  expect<unknown>(parseFollowUpStatusView(follow)).toEqual(follow);
  expect(parseFollowUpStatusView({ ...follow, jobs: [{ ...follow.jobs[0], actions: { retry: true } }] })).toBeNull();
});

test("dialogue contract shows an abandoned turn without inventing interruption or retaining a live preview", () => {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const source = { id: "source-fixture", text: "Original", provenance: "manual", createdAt };
  const turn = { id: "turn-fixture", jobId: "job-fixture", source: { id: "turn-source", text: "My question", provenance: "discussion-turn", createdAt }, createdAt,
    status: "abandoned", changes: [], actions: { stop: { eligible: false, expectedRunId: null }, retry: false } };
  const view = { id: "dialogue-fixture", sourceId: source.id, selection: { kind: "source", id: source.id }, selectedContext: { ...source, kind: "source" }, createdAt, turns: [turn], turnsTruncated: false };
  const uncertain = { ...view, turns: [{ ...turn, status: "uncertain" }] };
  expect<unknown>(parseDialogueView(uncertain)).toEqual(uncertain);
  expect<unknown>(parseDialogueView(view)).toEqual(view);
  expect(parseDialogueView({ ...view, turns: [{ ...turn, actions: { stop: { eligible: true, expectedRunId: "run-fixture" }, retry: false } }] })).toBeNull();
  const withPreview = { ...view, turns: [{ ...turn, preview: { runId: "run-fixture", messageId: "msg_fixture", text: "transient", truncated: false } }] };
  expect<unknown>(parseDialogueView(withPreview)).toEqual(view);
});

async function abandonedFixture() {
  const f = await fixture();
  const db = new Database(f.databasePath);
  // Seed only the proposed job marker, not a fake abandonment command/receipt.
  db.run("PRAGMA ignore_check_constraints=ON");
  db.run("UPDATE jobs SET status='abandoned' WHERE id=?", [f.run.jobId]);
  db.run("PRAGMA ignore_check_constraints=OFF");
  return { ...f, db };
}

function serviceInput(f: Awaited<ReturnType<typeof fixture>>): AbandonUncertainInput {
  return { expectedJobId: f.run.jobId, expectedRunId: f.run.runId, expectedSessionId: f.run.sessionId, expectedPromptId: f.run.promptId,
    expectedStatus: "uncertain", acknowledgement: ABANDONMENT_ACKNOWLEDGEMENT };
}

test("real abandonment atomically revokes the grant, preserves knowledge and makes its audit immutable and replayable", async () => {
  const f = await fixture(), service = new WeavingAbandonmentService({ databasePath: f.databasePath, now: () => 12345 });
  const input = serviceInput(f), key = "fixture-service-receipt";
  const tools = createToolApp({ databasePath: f.databasePath, transportCredential: "fixture-only-credential", location: f.directory });
  const call = (callID: string) => tools.request("/internal/tools/record-interpretation", { method: "POST", headers: { authorization: "Bearer fixture-only-credential", "content-type": "application/json" },
    body: JSON.stringify({ native: { sessionID: f.run.sessionId, agent: "weaver", messageID: "msg_fixture", callID }, input: { sourceId: f.first.id, text: "Fixture interpretation", evidenceSourceIds: [f.first.id] } }) });
  try {
    expect((await call("call_original")).status).toBe(200);
    const payload = JSON.stringify({ text: "Test-owned source and command" });
    const seed = new Database(f.databasePath);
    try { seed.run("INSERT INTO native_commands(run_id,payload,payload_hash,attempted) VALUES (?,?,?,1)", [f.run.runId, payload, createHash("sha256").update(payload).digest("hex")]); }
    finally { seed.close(); }
    const before = snapshot(f.databasePath);
    expect(service.preview(input, key).kind).toBe("eligible");
    const receipt = service.abandon(input, key);
    expect(receipt).toMatchObject({ status: "abandoned", nativeSettlement: "unconfirmed", runId: f.run.runId, createdAt: 12345 });
    expect(service.abandon(input, key)).toEqual(receipt);
    expect(() => service.abandon({ ...input, expectedPromptId: "msg_wrong" }, key)).toThrow();
    expect(() => service.abandon({ ...input, expectedRunId: "wrong_run" }, "different-key")).toThrow();
    const after = snapshot(f.databasePath);
    expect(after.sources).toEqual(before.sources);
    expect(after.commands).toEqual(before.commands);
    expect(after.knowledgeReceipts).toEqual(before.knowledgeReceipts);
    const db = new Database(f.databasePath);
    try {
      expect(db.query("SELECT status FROM jobs WHERE id=?").get(f.run.jobId)).toEqual({ status: "abandoned" });
      expect(db.query("SELECT state,outcome,lease_owner,lease_until FROM weaving_runs WHERE id=?").get(f.run.runId)).toEqual({ state: "uncertain", outcome: null, lease_owner: null, lease_until: null });
      expect(db.query("SELECT revoked FROM owned_grants WHERE run_id=?").get(f.run.runId)).toEqual({ revoked: 1 });
      expect(db.query("SELECT state FROM weaving_abandonment_dispatch WHERE abandonment_id=?").get(receipt.id)).toEqual({ state: "queued" });
      expect(() => db.run("UPDATE weaving_abandonments SET prompt_id='changed' WHERE id=?", [receipt.id])).toThrow();
      expect(() => db.run("DELETE FROM weaving_abandonments WHERE id=?", [receipt.id])).toThrow();
      expect(() => db.run("UPDATE weaving_runs SET lease_owner='old-owner',lease_until=999999 WHERE id=?", [f.run.runId])).toThrow("abandoned run lifecycle is frozen");
      expect(() => db.run("INSERT INTO weaving_runs(id,job_id,attempt,session_id,prompt_id,state,created_at,updated_at) VALUES (?,?,2,'ses_new_fixture','msg_new_fixture','preparing',1,1)", ["new-run-fixture", f.run.jobId])).toThrow("abandoned job cannot acquire a run");
    } finally { db.close(); }
    expect((await call("call_original")).status).toBe(403);
    expect((await call("call_new")).status).toBe(403);
    expect(() => new OwnedGrants(f.databasePath).bind({ run: f.run, location: f.directory, agent: "weaver", sourceIds: [f.first.id], operations: ["record_interpretation"] })).toThrow();
  } finally { await f.worker.close(); }
});

test("dispatch attempt opens the queue even when interrupt delivery is uncertain and is never replayed on restart", async () => {
  const f = await fixture(), service = new WeavingAbandonmentService({ databasePath: f.databasePath });
  const receipt = service.abandon(serviceInput(f), "fixture-dispatch");
  const calls: string[] = [], released: string[] = [];
  let entered = () => {}, release = () => {};
  const waiting = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter: WeavingAdapter = { async prepareSession() {}, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; },
    async releasePreview(run) { released.push(run.runId); },
    async interruptAbandoned(run, receiptId) { calls.push(`${run.runId}:${receiptId}`); entered(); await gate; throw new Error("fixture unconfirmed interruption"); } };
  const worker = new WeavingWorker({ databasePath: f.databasePath, adapter });
  try {
    expect(await worker.startNext()).toEqual({ kind: "empty" });
    const dispatch = worker.dispatchAbandonments();
    await waiting;
    expect(released).toEqual([f.run.runId]);
    expect(calls).toEqual([`${f.run.runId}:${receipt.id}`]);
    const next = await worker.startNext(); expect(next.kind).toBe("started");
    release(); await dispatch;
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query("SELECT state,category FROM weaving_abandonment_dispatch WHERE abandonment_id=?").get(receipt.id)).toEqual({ state: "uncertain", category: "request_failed" }); }
    finally { db.close(); }
    await new WeavingWorker({ databasePath: f.databasePath, adapter }).recover();
    expect(calls).toHaveLength(1);
  } finally { release(); await worker.close(); await f.worker.close(); }
});

test("a claimed interrupt surviving a crash is not automatically attempted again", async () => {
  const f = await fixture(), service = new WeavingAbandonmentService({ databasePath: f.databasePath });
  const receipt = service.abandon(serviceInput(f), "fixture-crash");
  expect(service.claimInterrupt()).toMatchObject({ receiptId: receipt.id, run: { runId: f.run.runId } });
  const calls: string[] = [];
  const adapter: WeavingAdapter = { async prepareSession() {}, async admit() { calls.push("prompt"); return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; },
    async interruptAbandoned() { calls.push("interrupt"); return { state: "requested" }; } };
  const restarted = new WeavingWorker({ databasePath: f.databasePath, adapter });
  try {
    await restarted.recover();
    expect(calls).toEqual([]);
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query("SELECT state FROM weaving_abandonment_dispatch WHERE abandonment_id=?").get(receipt.id)).toEqual({ state: "attempted" }); }
    finally { db.close(); }
  } finally { await restarted.close(); await f.worker.close(); }
});

test("owned abandoned interrupt uses the exact receipt and session with resume false, without prompt or session creation", async () => {
  const f = await fixture(), service = new WeavingAbandonmentService({ databasePath: f.databasePath });
  const receipt = service.abandon(serviceInput(f), "fixture-native-interrupt");
  const claim = service.claimInterrupt(); if (!claim) throw new Error("Expected queued interrupt");
  const calls: string[] = [], model = { providerID: "fixture", id: "model" };
  const session: NativeSession = { id: f.run.sessionId, ownerRunId: f.run.runId, location: f.directory, agent: "weaver", model,
    permissionActions: ["deny:*:*", "allow:record_interpretation"] };
  const client: NativeClientPort = {
    async discover() { return { url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }; },
    async identity() { return { version: "2.2.2", pid: 42 }; },
    async createSession() { calls.push("create"); return session; }, async getSession() { return session; },
    async prompt(run) { calls.push("prompt"); return { promptId: run.promptId }; },
    async interrupt(sessionId, options) { calls.push(`${sessionId}:${options.resume}`); },
    async activity() { return { active: false, outcome: null }; }, async history() { return { messages: [] }; },
  };
  const adapter = new NativeWeavingAdapter({ client, databasePath: f.databasePath, registrationFile: join(f.directory, "registration.json"), location: f.directory, agent: "weaver", model });
  try {
    expect(await adapter.interruptAbandoned(f.run, "wrong-receipt")).toEqual({ state: "not_requested", category: "ownership_unverified" });
    expect(calls).toEqual([]);
    expect(await adapter.interruptAbandoned(f.run, receipt.id)).toEqual({ state: "requested" });
    expect(calls).toEqual([`${f.run.sessionId}:false`]);
    service.finishInterrupt(receipt.id, { state: "requested" });
    expect(service.abandon(serviceInput(f), "fixture-native-interrupt").nativeSettlement).toBe("unconfirmed");
  } finally { await adapter.close(); await f.worker.close(); }
});

test("a held recovery completion loses to an earlier committed abandonment", async () => {
  const f = await fixture(), service = new WeavingAbandonmentService({ databasePath: f.databasePath });
  let entered = () => {}, release = () => {};
  const waiting = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter: WeavingAdapter = { async prepareSession() {}, async admit() { return { kind: "admitted" }; }, async inspect() { entered(); await gate; return { kind: "completed", recordedChanges: 0 }; } };
  const worker = new WeavingWorker({ databasePath: f.databasePath, adapter });
  const recovery = worker.recover();
  try {
    await waiting;
    const receipt = service.abandon(serviceInput(f), "fixture-race");
    release(); await recovery;
    const db = new Database(f.databasePath, { readonly: true });
    try {
      expect(db.query("SELECT status FROM jobs WHERE id=?").get(f.run.jobId)).toEqual({ status: "abandoned" });
      expect(db.query("SELECT state,outcome,lease_owner FROM weaving_runs WHERE id=?").get(f.run.runId)).toEqual({ state: "uncertain", outcome: null, lease_owner: null });
      expect(db.query("SELECT state FROM weaving_abandonment_dispatch WHERE abandonment_id=?").get(receipt.id)).toEqual({ state: "queued" });
    } finally { db.close(); }
  } finally { release(); await recovery; await worker.close(); await f.worker.close(); }
});

test("migration from controlled schema 16 preserves sources, job order, run and owned grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-schema16-")); directories.push(directory);
  const databasePath = join(directory, "baseline.sqlite");
  const schema = await readFile(new URL("../../../tests/fixtures/thoughtloom-schema-v16.sql", import.meta.url), "utf8");
  const db = new Database(databasePath, { create: true });
  const projections = ["SELECT id,CAST(text AS BLOB) AS bytes,provenance,created_at FROM sources ORDER BY rowid",
    "SELECT id,kind,source_id FROM knowledge_items ORDER BY rowid", "SELECT * FROM formulations ORDER BY rowid",
    "SELECT * FROM formulation_evidence ORDER BY formulation_id,position", "SELECT * FROM jobs ORDER BY rowid",
    "SELECT * FROM weaving_runs ORDER BY rowid", "SELECT * FROM owned_grants ORDER BY rowid", "SELECT * FROM native_commands ORDER BY rowid",
    "SELECT * FROM capture_receipts ORDER BY rowid", "SELECT * FROM knowledge_receipts ORDER BY rowid"];
  let before: unknown[][];
  try {
    db.exec(schema); db.run("PRAGMA foreign_keys=ON");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 16 });
    db.run("INSERT INTO sources(id,text,provenance,created_at) VALUES ('v16-source',?,'fixture','2002-01-01T00:00:00.000Z'),('v16-next','Queued fixture','fixture','2003-01-01T00:00:00.000Z')", ["  Preserved original\nexactly.  "]);
    db.run("INSERT INTO jobs(id,source_id,status,priority,kind) VALUES ('v16-job','v16-source','uncertain',0,'capture'),('v16-next-job','v16-next','queued',0,'capture')");
    db.run("INSERT INTO capture_receipts(idempotency_key,payload_hash,source_id,response_version) VALUES ('v16-capture','fixture-hash','v16-source',2)");
    db.run("INSERT INTO weaving_runs(id,job_id,attempt,session_id,prompt_id,state,created_at,updated_at) VALUES ('v16-run','v16-job',1,'ses_v16','msg_v16','uncertain',1,2)");
    db.run("INSERT INTO owned_grants(session_id,run_id,location,agent,source_ids,operations,scope_hash,revoked) VALUES ('ses_v16','v16-run','/fixture/location','fixture-agent','[\"v16-source\"]','[\"record_interpretation\"]','fixture-grant',0)");
    db.run("INSERT INTO native_commands(run_id,payload,payload_hash,attempted) VALUES ('v16-run','fixture-command','fixture-command-hash',1)");
    db.run("INSERT INTO knowledge_items(id,kind,source_id) VALUES ('v16-item','interpretation','v16-source')");
    db.run("INSERT INTO formulations(id,item_id,text,author,operation_id,run_id) VALUES ('v16-form-1','v16-item','Earlier reading','ai','v16-op-1','v16-run')");
    db.run("INSERT INTO formulations(id,item_id,text,author,operation_id) VALUES ('v16-form-2','v16-item','Current reading','user','v16-op-2')");
    db.run("INSERT INTO formulation_evidence(formulation_id,source_id,position) VALUES ('v16-form-1','v16-source',0),('v16-form-2','v16-source',0)");
    db.run("INSERT INTO knowledge_receipts(operation_id,payload_hash,result_id,revision_id) VALUES ('v16-op-1','fixture-hash-1','v16-item','v16-form-1'),('v16-op-2','fixture-hash-2','v16-item','v16-form-2')");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    before = projections.map((sql) => db.query(sql).all());
  } finally { db.close(); }
  const migrated = openDatabase(databasePath);
  try {
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(projections.map((sql) => migrated.query(sql).all())).toEqual(before);
    expect(migrated.query("SELECT created_at FROM knowledge_items WHERE id='v16-item'").get()).toEqual({ created_at: null });
    expect(migrated.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('weaving_abandonments','weaving_abandonment_dispatch') ORDER BY name").all())
      .toEqual([{ name: "weaving_abandonment_dispatch" }, { name: "weaving_abandonments" }]);
    expect(migrated.query("SELECT * FROM weaving_abandonments").all()).toEqual([]);
    expect(migrated.query("SELECT * FROM weaving_abandonment_dispatch").all()).toEqual([]);
    expect(migrated.query("SELECT name FROM sqlite_schema WHERE type='trigger' AND name='abandoned_run_frozen'").get()).toEqual({ name: "abandoned_run_frozen" });
  } finally { migrated.close(); }
});

test("a locally abandoned job cannot be reopened by a stale database write", async () => {
  const f = await abandonedFixture(), db = f.db;
  try {
    expect(() => db.run("UPDATE jobs SET status='running' WHERE id=?", [f.run.jobId])).toThrow();
    expect(db.query("SELECT status FROM jobs WHERE id=?").get(f.run.jobId)).toEqual({ status: "abandoned" });
  } finally { db.close(); await f.worker.close(); }
});

test("a locally abandoned run cannot acquire a fabricated later native outcome", async () => {
  const f = await abandonedFixture(), db = f.db;
  try {
    expect(() => db.run("UPDATE weaving_runs SET state='completed',outcome='succeeded',recorded_changes=0 WHERE id=?", [f.run.runId])).toThrow();
    expect(db.query("SELECT state,outcome FROM weaving_runs WHERE id=?").get(f.run.runId)).toEqual({ state: "uncertain", outcome: null });
  } finally { db.close(); await f.worker.close(); }
});

const cli = resolve(import.meta.dir, "../../../scripts/abandon-uncertain.ts");
const acknowledgement = "native-may-continue-and-charge";
async function command(args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}
function args(f: Awaited<ReturnType<typeof fixture>>) {
  return ["--database", f.databasePath, "--expected-job-id", f.run.jobId, "--expected-run-id", f.run.runId,
    "--expected-session-id", f.run.sessionId, "--expected-prompt-id", f.run.promptId, "--expected-status", "uncertain", "--idempotency-key", "fixture-abandon-key"];
}
function snapshot(databasePath: string) {
  const db = new Database(databasePath, { readonly: true });
  try {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%abandon%' ORDER BY name").all();
    const abandonment = tables.map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
    return { jobs: db.query("SELECT id,source_id,status FROM jobs ORDER BY rowid").all(), runs: db.query("SELECT id,job_id,session_id,prompt_id,state,outcome,lease_owner,lease_until FROM weaving_runs ORDER BY rowid").all(), sources: db.query("SELECT id,text FROM sources ORDER BY rowid").all(), commands: db.query("SELECT run_id,payload,payload_hash,attempted FROM native_commands ORDER BY rowid").all(), knowledgeReceipts: db.query("SELECT * FROM knowledge_receipts ORDER BY rowid").all(), abandonment };
  }
  finally { db.close(); }
}

test("dry-run and denied apply leave existing database unchanged and missing path is not created", async () => {
  const f = await fixture(), before = snapshot(f.databasePath);
  try {
    expect((await command(args(f))).exit).toBe(0);
    expect(snapshot(f.databasePath)).toEqual(before);
    expect((await command([...args(f), "--apply"])).exit).not.toBe(0);
    expect(snapshot(f.databasePath)).toEqual(before);
    const missing = join(f.directory, "missing.sqlite");
    expect((await command(["--database", missing])).exit).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
  } finally { await f.worker.close(); }
});

test("fenced apply is durable and idempotent without changing the saved originals or claiming native completion", async () => {
  const f = await fixture(), before = snapshot(f.databasePath);
  try {
    const apply = [...args(f), "--risk-acknowledgement", acknowledgement, "--apply"];
    const first = await command(apply); expect(first.exit).toBe(0);
    const after = snapshot(f.databasePath);
    expect(after.sources).toEqual(before.sources);
    expect(after.jobs).toContainEqual({ id: f.run.jobId, source_id: f.first.id, status: "abandoned" });
    expect(after.jobs).toContainEqual({ id: (before.jobs[1] as { id: string }).id, source_id: f.second.id, status: "queued" });
    expect(after.runs).toContainEqual({ id: f.run.runId, job_id: f.run.jobId, session_id: f.run.sessionId, prompt_id: f.run.promptId, state: "uncertain", outcome: null, lease_owner: null, lease_until: null });
    const replay = await command(apply); expect(replay.exit).toBe(0); expect(replay.stdout).toBe(first.stdout);
    expect(snapshot(f.databasePath)).toEqual(after);
    const conflicting = [...args(f)]; conflicting[conflicting.indexOf("--expected-prompt-id") + 1] = "msg_wrong_fixture";
    expect((await command([...conflicting, "--risk-acknowledgement", acknowledgement, "--apply"])).exit).not.toBe(0);
    expect(snapshot(f.databasePath)).toEqual(after);
  } finally { await f.worker.close(); }
});

test("a wrong expected identity or status never changes the uncertain attempt", async () => {
  const f = await fixture(), before = snapshot(f.databasePath);
  try {
    for (const field of ["--expected-job-id", "--expected-run-id", "--expected-session-id", "--expected-prompt-id", "--expected-status"]) {
      const input = args(f); input[input.indexOf(field) + 1] = "wrong-fixture";
      expect((await command([...input, "--risk-acknowledgement", acknowledgement, "--apply"])).exit, field).not.toBe(0);
      expect(snapshot(f.databasePath)).toEqual(before);
    }
  } finally { await f.worker.close(); }
});

test("completion committed before apply wins without abandonment", async () => {
  const f = await fixture();
  try {
    const db = new Database(f.databasePath);
    try {
      db.run("UPDATE weaving_runs SET state='completed',outcome='succeeded',recorded_changes=0 WHERE id=?", [f.run.runId]);
      db.run("UPDATE jobs SET status='completed' WHERE id=?", [f.run.jobId]);
    } finally { db.close(); }
    const before = snapshot(f.databasePath);
    expect((await command([...args(f), "--risk-acknowledgement", acknowledgement, "--apply"])).exit).not.toBe(0);
    expect(snapshot(f.databasePath)).toEqual(before);
  } finally { await f.worker.close(); }
});

test("a storage failure rolls back the whole abandonment transition", async () => {
  const f = await fixture();
  try {
    const db = new Database(f.databasePath);
    try { db.run("CREATE TRIGGER fixture_reject_abandon BEFORE UPDATE OF status ON jobs WHEN NEW.status='abandoned' BEGIN SELECT RAISE(ABORT,'fixture failure'); END"); }
    finally { db.close(); }
    const before = snapshot(f.databasePath);
    expect((await command([...args(f), "--risk-acknowledgement", acknowledgement, "--apply"])).exit).not.toBe(0);
    expect(snapshot(f.databasePath)).toEqual(before);
  } finally { await f.worker.close(); }
});
