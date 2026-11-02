import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createToolApp, OwnedGrants, type OwnedGrant } from "../src/tool-boundary";
import { WeavingWorker, type WeavingAdapter } from "../src/weaving";
import { KnowledgeService } from "../src/knowledge";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { nativePermissions, parseNativeCommand } from "../src/native-profile";

const directories: string[] = [];
const pendingWorkers: Array<{ release: () => void; done: Promise<unknown> }> = [];
afterEach(async () => {
  for (const worker of pendingWorkers.splice(0)) { worker.release(); await worker.done; }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(outcome: "completed" | "failed" | "interrupted" = "completed") {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-tool-scope-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const app = createApp({ databasePath });
  const capture = async (key: string) => {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text: `Original ${key}`, provenance: "manual" }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; text: string };
  };
  const source = await capture("owned");
  const other = await capture("other");
  let enteredResolve: (run: import("../src/weaving").WeavingRun) => void = () => {};
  const entered = new Promise<import("../src/weaving").WeavingRun>((resolve) => { enteredResolve = resolve; });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const admissions: string[] = [];
  const adapter: WeavingAdapter = {
    async prepareSession(run) { enteredResolve(run); await gate; }, async admit(run) { admissions.push(run.promptId); return { kind: "admitted" }; },
    async inspect() { return outcome === "completed" ? { kind: "completed", recordedChanges: 0 } : { kind: outcome }; },
  };
  const worker = new WeavingWorker({ databasePath, adapter });
  const done = worker.startNext();
  pendingWorkers.push({ release, done });
  const run = await Promise.race([entered, done.then(() => { throw new Error("Worker returned before session preparation"); })]);
  const grant: OwnedGrant = { run, location: "/fixture/thoughtloom", agent: "weaver", sourceIds: [source.id], operations: ["read_source", "record_interpretation"] };
  const grants = new OwnedGrants(databasePath);
  const activate = async () => { grants.bind(grant); release(); expect((await done).kind).toBe("started"); };
  const tools = createToolApp({ databasePath, transportCredential: "test-only-credential", location: grant.location });
  const native = { sessionID: run.sessionId, agent: grant.agent, messageID: "msg_fixture_assistant", callID: "call_fixture_1" };
  const input = { sourceId: source.id, text: "Tentative interpretation", evidenceSourceIds: [source.id] };
  const send = (body: unknown, credential = "test-only-credential") => tools.request("/internal/tools/record-interpretation", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body),
  });
  return { databasePath, app, source, other, grant, grants, native, input, send, tools, worker, activate, admissions };
}

test("transport credential is required even for an otherwise plausible native envelope", async () => {
  const { send, native, input } = await fixture();
  const response = await send({ native, input }, "wrong-test-credential");
  expect(response.status).toBe(401);
});

test("generated title endpoint rejects a legacy owned grant without mutating titles or run authority", async () => {
  const f = await fixture(); await f.activate();
  const read = new Database(f.databasePath, { readonly: true });
  try {
    const queries = ["SELECT * FROM sources ORDER BY id", "SELECT * FROM jobs ORDER BY id", "SELECT * FROM owned_grants ORDER BY session_id", "SELECT * FROM native_commands ORDER BY run_id", "SELECT * FROM title_entities ORDER BY id", "SELECT * FROM title_revisions ORDER BY id", "SELECT * FROM title_heads ORDER BY entity_id", "SELECT * FROM title_receipts ORDER BY idempotency_key", "SELECT * FROM search_fields ORDER BY target_kind,target_id,field_kind", "SELECT rowid,text FROM search_fts ORDER BY rowid", "SELECT * FROM search_alias_keys ORDER BY alias_id,side"];
    const before = queries.map((query) => read.query(query).all());
    const response = await f.tools.request("/internal/tools/record-title-v1", { method: "POST", headers: { authorization: "Bearer test-only-credential", "content-type": "application/json" }, body: JSON.stringify({ action: "record_title_v1", native: f.native, input: { rootSourceId: f.source.id, target: { kind: "source" }, text: "Generated title", expectedTitleRevisionId: null } }) });
    expect(response.status).toBe(403);
    expect(queries.map((query) => read.query(query).all())).toEqual(before);
  } finally { read.close(); }
});

for (const scenario of ["no-command", "missing-proof", "proof-without-title", "wrong-command-hash"] as const) {
  test(`title grant rejects ${scenario} without authority or title writes`, async () => {
    const f = await fixture();
    const actions = ["read_source", "record_interpretation", "record_title_v1"] as const;
    const proof = { protocol: 1, nonce: "test-nonce", buildId: "test-reviewed-build", setupId: "test-setup", nativePid: 42, directory: f.grant.location, actions: ["read_source", "record_title_v1"] };
    const command = { text: "fixture command", location: f.grant.location, agent: f.grant.agent, model: { providerID: "fixture", id: "model", variant: "default" }, permissions: nativePermissions(actions), profile: { version: 1, actions: [...actions], capability: proof } };
    // This proves the synthetic command is structurally valid; it is never
    // treated as an accepted proof or used to manufacture a positive grant.
    expect(parseNativeCommand(command)).not.toBeNull();
    if (scenario !== "no-command") {
      const capability = scenario === "missing-proof" ? null : scenario === "proof-without-title" ? { ...proof, actions: ["read_source"] } : proof;
      const payload = JSON.stringify({ ...command, profile: { ...command.profile, capability } });
      if (scenario !== "wrong-command-hash") expect(parseNativeCommand(JSON.parse(payload))).toBeNull();
      const hash = scenario === "wrong-command-hash" ? "0".repeat(64) : createHash("sha256").update(payload).digest("hex");
      const db = new Database(f.databasePath);
      try { db.run("INSERT INTO native_commands(run_id,payload,payload_hash) VALUES (?,?,?)", [f.grant.run.runId, payload, hash]); }
      finally { db.close(); }
    }
    const db = new Database(f.databasePath, { readonly: true });
    try {
      const queries = ["SELECT * FROM owned_grants", "SELECT * FROM title_entities", "SELECT * FROM title_revisions", "SELECT * FROM title_heads", "SELECT * FROM title_receipts", "SELECT * FROM search_fields", "SELECT rowid,text FROM search_fts", "SELECT * FROM search_alias_keys"];
      const before = queries.map((query) => db.query(query).all());
      expect(() => f.grants.bind({ ...f.grant, operations: [...actions] })).toThrow();
      expect(queries.map((query) => db.query(query).all())).toEqual(before);
      expect(f.admissions).toEqual([]);
    } finally { db.close(); }
  });
}

test("a transport credential alone cannot authorize unowned or child/fork sessions", async () => {
  const { send, native, input } = await fixture();
  for (const sessionID of ["ses_unknown_fixture", "ses_child_fixture", "ses_fork_fixture"]) {
    expect((await send({ native: { ...native, sessionID }, input })).status).toBe(403);
  }
});

test("owned active native calls write scoped interpretation and replay the call without duplicates", async () => {
  const { activate, send, native, input, app, source } = await fixture();
  await activate();
  const first = await send({ native, input });
  expect(first.status).toBe(200);
  const result = await first.json() as { id: string };
  expect(result.id).toBeTruthy();
  const replay = await send({ native, input });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  const conflict = await send({ native, input: { ...input, text: "Changed payload" } });
  expect(conflict.status).toBe(409);
  const inquiry = await app.request(`/sources/${source.id}/inquiry`);
  const view = await inquiry.json() as { items: Array<{ id: string }> };
  expect(view.items.filter((item) => item.id === result.id)).toHaveLength(1);
  expect(await (await app.request(`/sources/${source.id}`)).json()).toMatchObject(source);
});

test("native identity, run scope and evidence are checked independently of supplied arguments", async () => {
  const { activate, send, native, input, other } = await fixture();
  await activate();
  expect((await send({ native: { ...native, agent: "unowned-agent" }, input })).status).toBe(403);
  expect((await send({ native, input: { ...input, sourceId: other.id, evidenceSourceIds: [other.id] } })).status).toBe(403);
  expect((await send({ native, input: { ...input, evidenceSourceIds: [other.id] } })).status).toBe(403);
  expect((await send({ native, input: { ...input, runId: "forged-run", sessionID: "forged-session" } })).status).toBe(400);
});

test("revoked and settled grants reject mutations and cannot be rebound to another scope", async () => {
  const { activate, grants, grant, send, native, input, other } = await fixture();
  await activate();
  expect(() => grants.bind({ ...grant, sourceIds: [other.id] })).toThrow();
  grants.revoke(grant.run.sessionId);
  expect((await send({ native, input })).status).toBe(403);
});

test("a settled owned run no longer authorizes its native session", async () => {
  const { activate, send, native, input, worker } = await fixture();
  await activate();
  await worker.recover();
  expect((await send({ native, input })).status).toBe(403);
});

test("failed and interrupted runs revoke their grant, reject mutations and never resubmit", async () => {
  for (const outcome of ["failed", "interrupted"] as const) {
    const { databasePath, source, grant, native, input, send, worker, activate, admissions, app } = await fixture(outcome);
    await activate();
    expect((await send({ native, input })).status).toBe(200);
    await worker.recover();
    expect((await worker.getJob(source.id))?.status).toBe(outcome);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.query("SELECT revoked FROM owned_grants WHERE session_id = ?").get(grant.run.sessionId)).toEqual({ revoked: 1 });
      expect(db.query("SELECT COUNT(*) AS count FROM weaving_runs WHERE job_id = ?").get(grant.run.jobId)).toEqual({ count: 1 });
    } finally { db.close(); }
    expect((await send({ native: { ...native, callID: `call_after_${outcome}` }, input })).status).toBe(403);
    await worker.recover();
    expect(admissions).toEqual([grant.run.promptId]);
    expect(await (await app.request(`/sources/${source.id}`)).json()).toMatchObject(source);
  }
});

test("owned read access can inspect a neighboring original without granting writes there", async () => {
  const { activate, tools, native, other, send, input } = await fixture();
  await activate();
  const response = await tools.request("/internal/tools/read-source", { method: "POST", headers: { authorization: "Bearer test-only-credential", "content-type": "application/json" }, body: JSON.stringify({ native, input: { sourceId: other.id } }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject(other);
  expect((await send({ native, input: { ...input, sourceId: other.id, evidenceSourceIds: [other.id] } })).status).toBe(403);
});

test("owned root alias can be recorded and replayed without permitting off-root alias evidence", async () => {
  const { activate, grant, tools, native, source, other } = await fixture();
  grant.operations.push("record_alias");
  await activate();
  const post = (callID: string, input: object) => tools.request("/internal/tools/record-alias", { method: "POST", headers: { authorization: "Bearer test-only-credential", "content-type": "application/json" }, body: JSON.stringify({ native: { ...native, callID }, input }) });
  const input = { alias: "SDK", expansion: "software development kit", evidenceSourceIds: [source.id] };
  const first = await post("call_alias", input);
  expect(first.status).toBe(200);
  const saved = await first.json();
  expect(saved).toMatchObject({ alias: "SDK", expansion: "software development kit", author: "ai" });
  expect(await (await post("call_alias", input)).json()).toEqual(saved);
  expect((await post("call_alias", { ...input, expansion: "changed" })).status).toBe(409);
  expect((await post("call_other", { ...input, evidenceSourceIds: [other.id] })).status).toBe(403);
});

test("relationship tools require a root endpoint, read candidate evidence and reject stale or foreign references", async () => {
  const { databasePath, activate, grant, tools, native, source, other, app } = await fixture();
  const service = new KnowledgeService(databasePath);
  const root = service.createItem({ actor: "user", operationId: "root-item" }, { kind: "interpretation", sourceId: source.id, text: "Root", evidenceSourceIds: [source.id] });
  const candidate = service.createItem({ actor: "user", operationId: "candidate-item" }, { kind: "interpretation", sourceId: other.id, text: "Candidate", evidenceSourceIds: [other.id] });
  const foreign = service.createItem({ actor: "user", operationId: "foreign-item" }, { kind: "developing-idea", sourceId: other.id, text: "Foreign", evidenceSourceIds: [other.id] });
  grant.operations.push("read_item", "record_relationship");
  await activate();
  const read = await tools.request("/internal/tools/read-item", { method: "POST", headers: { authorization: "Bearer test-only-credential", "content-type": "application/json" }, body: JSON.stringify({ native, input: { itemId: candidate.id } }) });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ id: candidate.id, sourceId: other.id, current: { id: candidate.current.id, evidenceSourceIds: [other.id] } });
  const sourceRead = await tools.request("/internal/tools/read-source", { method: "POST", headers: { authorization: "Bearer test-only-credential", "content-type": "application/json" }, body: JSON.stringify({ native, input: { sourceId: other.id } }) });
  expect(sourceRead.status).toBe(200);
  expect(await sourceRead.json()).toMatchObject(other);
  const post = (callID: string, input: object) => tools.request("/internal/tools/record-relationship", { method: "POST", headers: { authorization: "Bearer test-only-credential", "content-type": "application/json" }, body: JSON.stringify({ native: { ...native, callID }, input }) });
  const input = { fromItemId: root.id, toItemId: candidate.id, fromVersionId: root.current.id, toVersionId: candidate.current.id, type: "suggests", rationale: "Shared implication", evidenceSourceIds: [source.id, other.id] };
  const result = await post("call_relationship", input);
  expect(result.status).toBe(200);
  const relationship = await result.json();
  expect(await (await post("call_relationship", input)).json()).toEqual(relationship);
  expect((await post("call_stale", { ...input, toVersionId: "stale-version" })).status).toBe(409);
  expect((await post("call_unknown", { ...input, toItemId: "missing-item" })).status).toBe(400);
  expect((await post("call_cross_scope", { ...input, fromItemId: candidate.id, fromVersionId: candidate.current.id, toItemId: foreign.id, toVersionId: foreign.current.id })).status).toBe(403);
  expect(await (await app.request(`/sources/${other.id}`)).json()).toMatchObject(other);
});
