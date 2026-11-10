import { expect, test } from "bun:test";
import { Database, SQLiteError, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentBindingError, AgentUncertainError, OpenCodeAdapter, type AgentBinding, type InboxItem, type NativeMessage, type NativeSession, type PublicClient } from "../src/agent/opencode-adapter";
import { normalizeBinding } from "../src/agent/binding";
import { AgentSessionMissingError } from "../src/agent/errors";
import { importBusy, MarkdownImportWorker } from "../src/agent/import-worker";
import { partitionMarkdown, prepareMarkdown } from "../src/domain/markdown-import";
import { RunFenceError, RunService, type NativeDispatcher } from "../src/domain/run";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteAgenticExports } from "../src/storage/agentic-export";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const quiet = { verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };
const binding: AgentBinding = { sessionId: "fixture-session", serviceUrl: "http://127.0.0.1:44999", location: { directory: "/owned" }, model: { providerID: "fixture", id: "fixture" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 };
const encode = (text: string) => new TextEncoder().encode(text);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

class ProofFaultDatabase extends Database {
  proofFailure: SQLiteError | null = null;
  override query<ReturnType, ParamsType extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) {
    if (this.proofFailure && sql === "SELECT bytes FROM markdown_import_payloads WHERE file_id=?") {
      const failure = this.proofFailure;
      this.proofFailure = null;
      throw failure;
    }
    return super.query<ReturnType, ParamsType>(sql);
  }
}

// Produce SQLite's own BUSY error using two test-owned connections; inject it once at the
// owned-input proof query, because BEGIN IMMEDIATE normally encounters a writer lock first.
function actualBusy(): SQLiteError {
  const dir = mkdtempSync(join("/tmp/opencode", "import-proof-lock-"));
  const path = join(dir, "lock.sqlite"), holder = new Database(path), contender = new Database(path);
  try {
    holder.exec("CREATE TABLE fixture (id INTEGER)");
    contender.exec("PRAGMA busy_timeout=1");
    holder.exec("BEGIN IMMEDIATE");
    try { contender.exec("INSERT INTO fixture VALUES (1)"); }
    catch (error) { if (error instanceof SQLiteError && importBusy(error)) return error; throw error; }
    throw new Error("Expected SQLite lock contention");
  } finally { if (holder.inTransaction) holder.exec("ROLLBACK"); contender.close(); holder.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function owned(action: (fixture: { db: ProofFaultDatabase; imports: SqliteMarkdownImports; bindings: SqliteAgentBindings; runs: SqliteRunRepository; sources: { id: () => string; now: () => string; logger: typeof quiet } }) => Promise<void>) {
  const dir = mkdtempSync(join("/tmp/opencode", "import-authority-"));
  const db = new ProofFaultDatabase(join(dir, "owned.sqlite"));
  let sequence = 0;
  const sources = { id: () => `authority-${++sequence}`, now: () => "2030-01-02T03:04:05.000Z", logger: quiet };
  try {
    migrate(db, quiet);
    await action({ db, imports: new SqliteMarkdownImports(db, sources), bindings: new SqliteAgentBindings(db, quiet), runs: new SqliteRunRepository(db, sources), sources });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function prepared(imports: SqliteMarkdownImports, text = "Owned café source") {
  const bytes = encode(text), batch = imports.createBatch("user", `batch-${text.length}`);
  const file = imports.admitFile("user", batch.id, "file", `fixture-${text.length}.md`, bytes);
  const claim = imports.claim(file.id), parsed = prepareMarkdown(bytes);
  imports.prepare(claim, parsed.manifest);
  const input = imports.privateInput(claim);
  if (input.input === null) throw new Error("Expected prepared input");
  return { bytes, batch, file, claim, parsed, prompt: { promptId: input.promptId, input: input.input } };
}

test("native-tool bindings allow Weaver/Evolve but storage refuses allow for Search, export and import", async () => owned(async ({ db, imports, bindings, runs, sources }) => {
  // The positive control must succeed first: global rejection of every allow binding is not a restricted-kind guard.
  const allowed = normalizeBinding({ ...binding, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  expect(allowed.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  const store = new SqliteStore(db);
  store.saveThought({ id: "policy-root", text: "test-owned policy context", title: null, author: "user", kind: "captured-original", createdAt: sources.now(), origin: "fixture", parentId: null, sourceIds: [] });
  const service = new RunService({ repository: runs, dispatcher: { submit: async () => {}, observe: async () => "running" }, ...sources });
  const weave = new SqliteRunOperations(db, sources).admitWeave("user", { subjectId: "policy-root", triggerId: "policy-trigger" });
  const evolve = service.admit("user", "evolve", { parentId: "policy-root", text: "test-owned contribution" }).run;
  for (const run of [weave, evolve]) {
    const actual = { ...allowed, sessionId: run.sessionId };
    bindings.bind(run.id, actual, service.claim(run.id));
    expect(bindings.get(run.id)).toEqual(actual);
  }
  const sessions = store.searchSessions(sources), session = sessions.create("user", "policy-session", {}).session;
  const composer = sessions.openComposer("user", session.id);
  const search = sessions.admitTurn("user", session.id, "policy-turn", { text: "find existing thinking", startingThoughtIds: [],
    requestClock: { at: sources.now(), timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken }).run;
  const exported = new SqliteAgenticExports(db, sources).admit("user", { request: "test-owned report request" });
  for (const runId of [search.id, exported.id]) {
    const run = runs.get(runId);
    if (!run) throw new Error("Expected owned restricted run");
    const claim = service.claim(run.id);
    expect(() => bindings.bind(run.id, { ...allowed, sessionId: run.sessionId }, claim)).toThrow(AgentBindingError);
    expect(bindings.get(run.id)).toBeNull();
    const denied = { ...binding, sessionId: run.sessionId };
    bindings.bind(run.id, denied, claim);
    expect(bindings.get(run.id)).toEqual(denied);
  }
  const item = prepared(imports), run = runs.get(item.claim.runId);
  if (!run) throw new Error("Expected owned import run");
  expect(() => bindings.bindImport(item.claim, { ...allowed, sessionId: run.sessionId })).toThrow(AgentBindingError);
  expect(bindings.get(run.id)).toBeNull();
  const denied = { ...binding, sessionId: run.sessionId };
  bindings.bindImport(item.claim, denied);
  expect(bindings.get(run.id)).toEqual(denied);
}));

function fakeClient(runId: string, nativeBinding: AgentBinding, messages: readonly NativeMessage[]): PublicClient {
  const session: NativeSession = { id: nativeBinding.sessionId, location: nativeBinding.location, model: nativeBinding.model, permissions: nativeBinding.permissions, metadata: { owner: "thoughtloom", runId, protocolVersion: "1" } };
  return {
    instructionList: async () => { throw new Error("Unexpected instruction list"); },
    instructionPut: async () => { throw new Error("Unexpected instruction put"); },
    instructionRemove: async () => { throw new Error("Unexpected instruction remove"); },
    serverInfo: async () => ({ version: "fixture" }), sessionCreate: async () => session, sessionGet: async () => session,
    prompt: async () => { throw new Error("Unexpected native submission"); }, inbox: async () => [],
    history: async () => ({ data: messages, cursor: {} }), active: async () => ({}),
    cancelInbox: async () => {}, interrupt: async () => ({ interrupted: false }),
  };
}

class TrackedClient implements PublicClient {
  async instructionList(): Promise<never> { throw new Error("Unexpected instruction list"); }
  async instructionPut(): Promise<never> { throw new Error("Unexpected instruction put"); }
  async instructionRemove(): Promise<never> { throw new Error("Unexpected instruction remove"); }
  calls: string[] = [];
  session: NativeSession | null = null;
  queue: InboxItem[] = [];
  loseAck = false;
  async serverInfo() { this.calls.push("info"); return { version: "fixture" }; }
  async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
    this.calls.push("create");
    this.session = { id: input.id, location: input.location, model: input.model, permissions: input.permissions, metadata: input.metadata };
    return this.session;
  }
  async sessionGet(): Promise<NativeSession> { this.calls.push("get"); if (!this.session) throw new AgentSessionMissingError(); return this.session; }
  async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
    this.calls.push("prompt");
    const receipt: InboxItem = { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: 1 } };
    this.queue.push(receipt);
    if (this.loseAck) throw new Error("fixture lost acknowledgement");
    return receipt;
  }
  async inbox() { this.calls.push("inbox"); return this.queue; }
  async history() { this.calls.push("history"); return { data: [], cursor: {} }; }
  async active() { this.calls.push("active"); return {}; }
  async cancelInbox() { this.calls.push("cancel"); this.queue = []; }
  async interrupt() { this.calls.push("interrupt"); return { interrupted: true }; }
}

test("persisted import authority gates read-only terminal observation and denies altered identities", async () => owned(async ({ db, imports, bindings, runs, sources }) => {
  const item = prepared(imports);
  const run = runs.get(item.claim.runId);
  if (!run) throw new Error("Expected admitted run");
  const nativeBinding = { ...binding, sessionId: run.sessionId };
  expect(() => bindings.assertImportOwnership(item.claim, [item.prompt])).toThrow(RunFenceError);
  bindings.bindImport(item.claim, nativeBinding);
  expect(() => bindings.assertImportOwnership(item.claim, [item.prompt])).toThrow(RunFenceError);
  expect(() => bindings.recordImportSubmission(item.claim, { ...item.prompt, input: item.prompt.input + " " })).toThrow(RunFenceError);
  bindings.recordImportSubmission(item.claim, item.prompt);
  expect(() => bindings.assertImportOwnership(item.claim, [item.prompt])).not.toThrow();
  for (const prompts of [[], [{ ...item.prompt, promptId: "foreign" }], [{ ...item.prompt, input: item.prompt.input + " " }], [item.prompt, item.prompt]]) {
    expect(() => bindings.assertImportOwnership(item.claim, prompts)).toThrow(RunFenceError);
  }
  expect(() => bindings.assertImportOwnership({ ...item.claim, generation: item.claim.generation + 1 }, [item.prompt])).toThrow(RunFenceError);
  expect(() => bindings.assertImportOwnership({ ...item.claim, runId: "foreign-run" }, [item.prompt])).toThrow();
  expect(() => bindings.bind(item.claim.runId, nativeBinding, item.claim)).toThrow();
  const capabilities = new SqliteCapabilityDispatcher(db, sources);
  expect(() => capabilities.dispatch(item.claim, item.prompt.promptId, { capability: "search", arguments: { query: "source" } })).toThrow();
  const before = db.query("SELECT state,native_state,envelope_json,result_json,input FROM run_steps WHERE run_id=?").get(item.claim.runId);
  const messages: NativeMessage[] = [{ id: item.prompt.promptId, type: "user", text: item.prompt.input, time: { created: 1 } }, { id: "assistant", type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text: "" }], finish: "stop" }, { id: "idle", type: "idle", time: { created: 4 }, outcome: "succeeded" }];
  const adapter = new OpenCodeAdapter(fakeClient(item.claim.runId, nativeBinding, messages), bindings, { ordinary: bindings.assertActive.bind(bindings), import: () => {} }, quiet);
  expect(await adapter.observeImport(item.claim, nativeBinding, [item.prompt])).toMatchObject({ state: "terminal-completion", output: "" });
  await expect(adapter.observeImport(item.claim, { ...nativeBinding, location: { directory: "/foreign" } }, [item.prompt])).rejects.toThrow();
  const unsafeMessages: NativeMessage[] = [{ id: item.prompt.promptId, type: "user", text: item.prompt.input, time: { created: 1 }, unsafe: true }, { id: "idle", type: "idle", time: { created: 4 }, outcome: "failed" }];
  const unsafe = new OpenCodeAdapter(fakeClient(item.claim.runId, nativeBinding, unsafeMessages), bindings, { ordinary: bindings.assertActive.bind(bindings), import: () => {} }, quiet);
  expect(await unsafe.observeImport(item.claim, nativeBinding, [item.prompt])).toEqual({ state: "quarantined" });
  expect(db.query("SELECT state,native_state,envelope_json,result_json,input FROM run_steps WHERE run_id=?").get(item.claim.runId)).toEqual(before);
  expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
  runs.stop(item.claim.runId);
  expect(() => bindings.assertImportOwnership(item.claim, [item.prompt])).toThrow(RunFenceError);
  await expect(adapter.observeImport(item.claim, nativeBinding, [item.prompt])).rejects.toThrow(RunFenceError);
}));

test("ordinary runs and post-selection claims cannot acquire import observation authority", async () => owned(async ({ imports, bindings, runs, sources }) => {
  const dispatcher: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
  const service = new RunService({ repository: runs, dispatcher, ...sources });
  const ordinary = service.admit("user", "weave").run;
  const ordinaryClaim = service.claim(ordinary.id);
  expect(() => bindings.bindImport(ordinaryClaim, binding)).toThrow(RunFenceError);
  expect(() => bindings.assertImportOwnership(ordinaryClaim, [{ promptId: ordinary.promptId, input: "foreign" }])).toThrow(RunFenceError);
  const adapter = new OpenCodeAdapter(fakeClient(ordinary.id, binding, []), bindings, () => {}, quiet);
  await expect(adapter.observeImport(ordinaryClaim, binding, [{ promptId: ordinary.promptId, input: "foreign" }])).rejects.toThrow(RunFenceError);

  const item = prepared(imports, "A different selected source");
  bindings.bindImport(item.claim, binding);
  const choice = imports.choose(item.claim, partitionMarkdown(item.bytes, item.parsed, item.parsed.fallbackCuts, { method: "structural", reason: "ai-unconfigured" }), { state: "not-submitted", promptId: item.prompt.promptId, inputSha256: hash(item.prompt.input) });
  expect(() => bindings.assertImportOwnership(item.claim, [item.prompt])).toThrow(RunFenceError);
  expect(() => bindings.assertImportOwnership(choice, [item.prompt])).toThrow(RunFenceError);
}));

test("reclaim and corrupted file ownership revoke persisted authority", async () => owned(async ({ db, imports, bindings }) => {
  const item = prepared(imports, "Staged source for corruption");
  const other = prepared(imports, "A separate source owned by another file");
  bindings.bindImport(item.claim, binding);
  bindings.recordImportSubmission(item.claim, item.prompt);
  bindings.bindImport(other.claim, { ...binding, sessionId: "other-session" });
  bindings.recordImportSubmission(other.claim, other.prompt);
  expect(() => bindings.assertImportOwnership(item.claim, [other.prompt])).toThrow(RunFenceError);
  expect(() => bindings.assertImportOwnership(item.claim, [other.prompt, item.prompt])).toThrow(RunFenceError);
  const renewed = imports.claim(item.file.id);
  expect(() => bindings.assertImportOwnership(item.claim, [item.prompt])).toThrow(RunFenceError);
  expect(() => bindings.assertImportOwnership(renewed, [item.prompt])).not.toThrow();
  db.exec("DROP TRIGGER imports_payload_immutable");
  db.run("UPDATE markdown_import_payloads SET bytes=? WHERE file_id=?", [encode("Forged source for corruption"), item.file.id]);
  expect(() => bindings.assertImportOwnership(renewed, [item.prompt])).toThrow(RunFenceError);
}));

test("preparation retains exact owned bytes and manifest without ordinary capabilities", async () => owned(async ({ imports, runs, sources }) => {
  const item = prepared(imports, "Café 🧵\n\nSecond paragraph\n");
  const parsed: unknown = JSON.parse(item.prompt.input);
  expect(parsed).toMatchObject({ version: 1, kind: "import-job", document: new TextDecoder().decode(item.bytes), manifest: item.parsed.manifest, capabilities: [] });
  expect(() => imports.prepare(item.claim, item.parsed.manifest)).not.toThrow();
  expect(() => imports.prepare(item.claim, { ...item.parsed.manifest, parserVersion: "foreign-parser" })).toThrow();
  expect(() => imports.prepare(item.claim, { ...item.parsed.manifest, cuts: [] })).toThrow();
  const other = prepared(imports, "Other file has unrelated text");
  expect(() => imports.prepare(item.claim, other.parsed.manifest)).toThrow();
  const dispatcher: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
  const service = new RunService({ repository: runs, dispatcher, ...sources });
  const ordinary = service.admit("user", "weave").run;
  const ordinaryClaim = service.claim(ordinary.id);
  expect(() => imports.privateInput(ordinaryClaim)).toThrow(RunFenceError);
  expect(() => imports.prepare(ordinaryClaim, item.parsed.manifest)).toThrow(RunFenceError);
}));

test("real preparation fences native dispatch; lost acknowledgement keeps one durable attempt", async () => owned(async ({ db, imports, bindings, runs, sources }) => {
  const item = prepared(imports, "One paid native attempt"), run = runs.get(item.claim.runId);
  if (!run) throw new Error("Run missing");
  const nativeBinding = { ...binding, sessionId: run.sessionId }, client = new TrackedClient();
  bindings.bindImport(item.claim, nativeBinding);
  const adapter = new OpenCodeAdapter(client, bindings, { ordinary: bindings.assertActive.bind(bindings), import: () => {} }, quiet);
  const other = prepared(imports, "A separate unrelated import request");
  const dispatcher: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
  const service = new RunService({ repository: runs, dispatcher, ...sources });
  const ordinary = service.admit("user", "weave").run, ordinaryClaim = service.claim(ordinary.id);
  for (const [claim, candidate] of [
    [item.claim, { ...item.prompt, input: item.prompt.input + " " }],
    [item.claim, { ...item.prompt, promptId: "foreign" }],
    [item.claim, other.prompt],
    [{ ...item.claim, generation: item.claim.generation + 1 }, item.prompt],
    [ordinaryClaim, item.prompt],
  ] as const) {
    await expect(adapter.ensureImportSession(claim, nativeBinding, candidate)).rejects.toThrow();
    await expect(adapter.submitImport(claim, nativeBinding, candidate)).rejects.toThrow();
  }
  expect(client.calls).toEqual([]);
  await adapter.ensureImportSession(item.claim, nativeBinding, item.prompt);
  expect(client.calls.filter(call => call === "create")).toHaveLength(1);
  client.loseAck = true;
  await expect(adapter.submitImport(item.claim, nativeBinding, item.prompt)).rejects.toThrow(AgentUncertainError);
  expect(db.query("SELECT status FROM runs WHERE id=?").get(run.id)).toEqual({ status: "submitting" });
  expect(db.query("SELECT state,native_state,envelope_json,result_json FROM run_steps WHERE run_id=?").get(run.id)).toEqual({ state: "submitting", native_state: "unknown", envelope_json: null, result_json: null });
  expect(imports.admitFile("user", item.batch.id, "file", item.file.relativePath, item.bytes)).toMatchObject({ id: item.file.id, runId: run.id, state: "submitting" });
  const calls = client.calls.length;
  await expect(adapter.ensureImportSession(item.claim, nativeBinding, item.prompt)).rejects.toThrow(RunFenceError);
  await expect(adapter.submitImport(item.claim, nativeBinding, item.prompt)).rejects.toThrow(RunFenceError);
  expect(client.calls).toHaveLength(calls);
  expect(await adapter.observeImport(item.claim, nativeBinding, [item.prompt])).toEqual({ state: "pending" });
  expect(client.calls.filter(call => call === "prompt")).toHaveLength(1);
  expect(client.calls.filter(call => call === "create")).toHaveLength(1);
  runs.stop(run.id);
  const stoppedCalls = client.calls.length;
  await expect(adapter.submitImport(item.claim, nativeBinding, item.prompt)).rejects.toThrow(RunFenceError);
  expect(client.calls).toHaveLength(stoppedCalls);
}));

test("terminal choice fences dispatch and preserves observed failure through completed cleanup", async () => owned(async ({ db, imports, bindings, runs }) => {
  const item = prepared(imports, "Owned failure fallback source"), run = runs.get(item.claim.runId);
  if (!run) throw new Error("Run missing");
  const nativeBinding = { ...binding, sessionId: run.sessionId }, client = new TrackedClient();
  bindings.bindImport(item.claim, nativeBinding);
  const adapter = new OpenCodeAdapter(client, bindings, { ordinary: bindings.assertActive.bind(bindings), import: () => {} }, quiet);
  await adapter.ensureImportSession(item.claim, nativeBinding, item.prompt);
  await adapter.submitImport(item.claim, nativeBinding, item.prompt);
  const messages: NativeMessage[] = [{ id: item.prompt.promptId, type: "user", text: item.prompt.input, time: { created: 1 } }, { id: "idle-failed", type: "idle", time: { created: 3 }, outcome: "failed" }];
  const observer = new OpenCodeAdapter(fakeClient(item.claim.runId, nativeBinding, messages), bindings, { ordinary: bindings.assertActive.bind(bindings), import: () => {} }, quiet);
  const observed = await observer.observeImport(item.claim, nativeBinding, [item.prompt]);
  if (observed.state !== "terminal-failure") throw new Error("Expected correlated terminal failure");
  const partition = partitionMarkdown(item.bytes, item.parsed, item.parsed.fallbackCuts, { method: "structural", reason: "ai-failed" });
  const witness = { state: "terminal-failure" as const, ...observed.evidence };
  expect(() => imports.choose(item.claim, partition, { ...witness, sessionId: "foreign" })).toThrow();
  expect(() => imports.choose(item.claim, partition, { ...witness, inputSha256: hash("foreign") })).toThrow();
  expect(() => imports.choose(item.claim, partition, { ...witness, idleOutcome: "succeeded" })).toThrow();
  expect(db.query("SELECT result_json FROM run_steps WHERE run_id=?").get(run.id)).toEqual({ result_json: null });
  const choice = imports.choose(item.claim, partition, witness);
  const stored = db.query("SELECT state,native_state,envelope_json,result_json FROM run_steps WHERE run_id=?").get(run.id);
  expect(stored).toMatchObject({ state: "uncertain", native_state: "unknown", envelope_json: null, result_json: expect.any(String) });
  const saved = db.query<{ evidence: string }, [string]>("SELECT json_extract(result_json,'$.evidence') AS evidence FROM run_steps WHERE run_id=?").get(run.id);
  if (!saved) throw new Error("Evidence missing");
  expect(JSON.parse(saved.evidence)).toEqual(witness);
  expect(() => imports.choose(choice, partition, { ...witness, idleMessageId: "forged" })).toThrow();
  expect(db.query("SELECT state,native_state,envelope_json,result_json FROM run_steps WHERE run_id=?").get(run.id)).toEqual(stored);
  const calls = client.calls.length;
  await expect(adapter.submitImport(choice, nativeBinding, item.prompt)).rejects.toThrow(RunFenceError);
  await expect(adapter.ensureImportSession(choice, nativeBinding, item.prompt)).rejects.toThrow(RunFenceError);
  expect(client.calls).toHaveLength(calls);
  await expect(adapter.cancelImport(choice, nativeBinding, item.prompt)).rejects.toThrow(RunFenceError);
  const final = imports.finalize(choice);
  expect(final.state).toBe("imported");
  const finished = runs.get(run.id);
  if (!finished) throw new Error("Completed run missing");
  const cleanup = { runId: run.id, generation: finished.generation };
  const deniedAt = client.calls.length;
  await expect(adapter.cancelImport({ ...cleanup, generation: cleanup.generation - 1 }, nativeBinding, item.prompt)).rejects.toThrow(RunFenceError);
  await expect(adapter.cancelImport(cleanup, nativeBinding, { ...item.prompt, input: item.prompt.input + " " })).rejects.toThrow(RunFenceError);
  await expect(adapter.cancelImport(cleanup, { ...nativeBinding, sessionId: "foreign" }, item.prompt)).rejects.toThrow();
  expect(client.calls).toHaveLength(deniedAt);
  expect(await adapter.cancelImport(cleanup, nativeBinding, item.prompt)).toBe("settled");
  expect(client.calls.filter(call => call === "cancel")).toHaveLength(1);
  expect(client.calls.filter(call => call === "interrupt")).toHaveLength(1);
  expect(db.query("SELECT state,native_state,envelope_json,result_json FROM run_steps WHERE run_id=?").get(run.id)).toEqual(stored);
  new SqliteRunProtocolRepository(db, quiet).settleCancellation(run.id);
  const settledCalls = client.calls.length;
  await expect(adapter.cancelImport(cleanup, nativeBinding, item.prompt)).rejects.toThrow(RunFenceError);
  expect(client.calls).toHaveLength(settledCalls);
}));

test("terminal witness must identify the exact correlated user message", async () => owned(async ({ db, imports, bindings }) => {
  const item = prepared(imports, "Reject manufactured terminal evidence");
  bindings.bindImport(item.claim, binding);
  bindings.recordImportSubmission(item.claim, item.prompt);
  const partition = partitionMarkdown(item.bytes, item.parsed, item.parsed.fallbackCuts, { method: "structural", reason: "ai-failed" });
  const evidence = { state: "terminal-failure" as const, sessionId: binding.sessionId, promptId: item.prompt.promptId, inputSha256: hash(item.prompt.input), userMessageId: "foreign-user", assistantMessageId: null, idleMessageId: "idle-failed", idleOutcome: "failed" as const, completedAt: null, finish: null, assistantError: false, idleError: false, outputByteLength: 0, outputSha256: hash("") };
  expect(() => imports.choose(item.claim, partition, evidence)).toThrow();
  expect(db.query("SELECT result_json FROM run_steps WHERE run_id=?").get(item.claim.runId)).toEqual({ result_json: null });
}));

test("operational SQLite busy during owned-input proof remains retryable and does not dispatch", async () => owned(async ({ db, imports, bindings, runs }) => {
  const item = prepared(imports, "Transient proof database contention"), run = runs.get(item.claim.runId);
  if (!run) throw new Error("Missing run");
  const nativeBinding = { ...binding, sessionId: run.sessionId }, client = new TrackedClient();
  bindings.bindImport(item.claim, nativeBinding);
  const adapter = new OpenCodeAdapter(client, bindings, { ordinary: bindings.assertActive.bind(bindings), import: () => {} }, quiet);
  await adapter.ensureImportSession(item.claim, nativeBinding, item.prompt);
  await adapter.submitImport(item.claim, nativeBinding, item.prompt);
  const saved = db.query("SELECT status FROM runs WHERE id=?").get(run.id);
  const journal = db.query("SELECT state,native_state,result_json FROM run_steps WHERE run_id=?").get(run.id);
  const before = client.calls.length;
  const busy = actualBusy();
  expect(busy.code).toMatch(/^SQLITE_(BUSY|LOCKED)/);
  db.proofFailure = busy;
  let error: unknown;
  try { await adapter.observeImport(item.claim, nativeBinding, [item.prompt]); } catch (caught) { error = caught; }
  expect(client.calls).toHaveLength(before);
  expect(db.query("SELECT status FROM runs WHERE id=?").get(run.id)).toEqual(saved);
  expect(db.query("SELECT state,native_state,result_json FROM run_steps WHERE run_id=?").get(run.id)).toEqual(journal);
  expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
  expect(await adapter.observeImport(item.claim, nativeBinding, [item.prompt])).toEqual({ state: "pending" });
  expect(client.calls.filter(call => call === "prompt")).toHaveLength(1);
  const recoveredCalls = client.calls.length;
  await expect(adapter.observeImport(item.claim, nativeBinding, [{ ...item.prompt, input: "foreign" }])).rejects.toThrow(RunFenceError);
  expect(client.calls).toHaveLength(recoveredCalls);
  expect(error).toBe(busy);
  expect(importBusy(error)).toBe(true);
}));

test("worker retries SQLite busy during submitted import proof without terminal settlement or redispatch", async () => owned(async ({ db, imports, bindings, runs, sources }) => {
  const item = prepared(imports, "Worker transient proof contention"), run = runs.get(item.claim.runId);
  if (!run) throw new Error("Missing run");
  const nativeBinding = { ...binding, sessionId: run.sessionId }, client = new TrackedClient();
  bindings.bindImport(item.claim, nativeBinding);
  const setup = new OpenCodeAdapter(client, bindings, { ordinary: bindings.assertActive.bind(bindings), import: () => {} }, quiet);
  await setup.ensureImportSession(item.claim, nativeBinding, item.prompt);
  await setup.submitImport(item.claim, nativeBinding, item.prompt);
  const busy = actualBusy();
  let inject = true;
  const worker = new MarkdownImportWorker({ db, ...sources, native: (store, localFence) => {
    const adapter = new OpenCodeAdapter(client, store, { ordinary: store.assertActive.bind(store), import: localFence }, quiet);
    return {
      bindingFor: async () => nativeBinding,
      ensureSession: (claim, binding, prompt) => adapter.ensureImportSession(claim, binding, prompt),
      submit: (claim, binding, prompt) => adapter.submitImport(claim, binding, prompt),
      observe: (claim, binding, prompts) => { if (inject) { inject = false; db.proofFailure = busy; } return adapter.observeImport(claim, binding, prompts); },
      cancel: (claim, binding, prompt) => adapter.cancelImport(claim, binding, prompt),
    };
  } });
  const work = worker.candidates(0, null, 10).items.find(value => value.runId === run.id);
  if (!work) throw new Error("Submitted import candidate missing");
  const beforeCalls = client.calls.length;
  await worker.tick(work);
  expect(client.calls).toHaveLength(beforeCalls);
  expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
  expect(imports.file("user", item.batch.id, item.file.id)).toMatchObject({ state: "submitting", error: null });
  await worker.tick(work);
  expect(imports.file("user", item.batch.id, item.file.id)).toMatchObject({ state: "uncertain", error: null });
  expect(client.calls.filter(call => call === "prompt")).toHaveLength(1);
}));
