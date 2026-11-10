import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentSessionMissingError, AgentUncertainError } from "../src/agent/errors";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { OpenCodeAdapter, type AgentBinding, type InboxItem, type NativeMessage, type NativeSession, type PublicClient, type ResolvedAgentService } from "../src/agent/opencode-adapter";
import type { AgentConfig } from "../src/daemon/agent-config";
import { startDaemon, type DaemonEvent, type RunningDaemon, type RuntimeDependencies } from "../src/daemon/runtime";
import { RunService } from "../src/domain/run";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const user = "test-user-01234567890123456789012345";
const ai = "test-agent-0123456789012345678901234";
const secret = "test-owned-native-credential-sentinel";
const agent: AgentConfig = { service: { url: "http://127.0.0.1:44991", token: secret }, directory: "/tmp/opencode/owned-agent", model: { providerID: "fixture", id: "model" }, effort: { quick: "q", standard: "s", thorough: "t" } };
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Expected string"); return value; }
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, Bun.sleep(3000).then(() => { throw new Error(`${label} timed out`); })]);
}
async function call(daemon: RunningDaemon, path: string, method = "GET", data?: unknown, token = user) {
  const response = await fetch(new URL(path, daemon.url), { method, headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(1500) });
  return { status: response.status, data: await bounded(response.json() as Promise<unknown>, "response body") };
}

/** Decoded public-client fixture; no service discovery, HTTP or process outside this test. */
class Client implements PublicClient {
  async instructionList(): Promise<never> { throw new Error("Unexpected instruction list"); }
  async instructionPut(): Promise<never> { throw new Error("Unexpected instruction put"); }
  async instructionRemove(): Promise<never> { throw new Error("Unexpected instruction remove"); }
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, NativeMessage[]>();
  readonly prompts: { sessionID: string; id: string; text: string }[] = [];
  readonly models: NativeSession["model"][] = [];
  cancellations = 0;
  unavailable = false;
  completeFirst = false;
  exportSourceId = "";
  exportWrite: { capability: string; arguments: Record<string, unknown> } | null = null;
  readonly exportProposals: string[] = [];
  async serverInfo() { if (this.unavailable) throw new Error(`offline ${secret}`); return { version: "99.0.0-fixture" }; }
  async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
    const session: NativeSession = { id: input.id, location: input.location, model: input.model, permissions: input.permissions, metadata: input.metadata };
    this.sessions.set(input.id, session); this.messages.set(input.id, []); this.models.push(input.model); return session;
  }
  async sessionGet(input: { readonly sessionID: string }): Promise<NativeSession> {
    const session = this.sessions.get(input.sessionID);
    if (!session) throw new AgentSessionMissingError("Native session is absent");
    return session;
  }
  async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
    this.prompts.push(input);
    const messages = this.messages.get(input.sessionID);
    if (!messages) throw new Error("missing fixture history");
    const firstPrompt = this.prompts.filter(p => p.sessionID === input.sessionID)[0];
    if (!firstPrompt) throw new Error("missing first prompt");
    const initial = object(JSON.parse(firstPrompt.text));
    const context = object(initial.context);
    const job = object(context.job);
    const turn = this.prompts.filter(p => p.sessionID === input.sessionID).length;
    const output = job.kind === "export" ? (turn === 1 ? { version: 1, kind: "request", request: this.exportWrite ?? { capability: "search", arguments: { query: "cobalt" } } } :
      turn === 2 ? { version: 1, kind: "request", request: { capability: "readThought", arguments: { id: this.exportSourceId } } } :
        { version: 1, kind: "report", markdown: "# Fixture report\n\nExisting thinking, not new knowledge.", sourceThoughtIds: [this.exportSourceId] }) :
      turn > 1 || this.completeFirst ? { version: 1, kind: "complete", reply: job.kind === "evolve" ? "fixture human reply" : "no further findings" } :
      job.kind === "evolve" ? { version: 1, kind: "request", request: { capability: "development", arguments: { parentId: string(job.contributionId), text: "fixture development", sourceIds: [] } } } :
        { version: 1, kind: "request", request: { capability: "title-fill", arguments: { title: "Fixture generated title" } } };
    if (job.kind === "export" && turn === 1 && this.exportWrite) this.exportProposals.push(this.exportWrite.capability);
    const n = messages.length * 10 + 10;
    messages.push({ id: input.id, type: "user", time: { created: n }, text: input.text },
      { id: `assistant-${input.id}`, type: "assistant", time: { created: n + 1, completed: n + 2 }, content: [{ type: "text", text: JSON.stringify(output) }], finish: "stop" },
      { id: `idle-${input.id}`, type: "idle", time: { created: n + 3 }, outcome: "succeeded" });
    return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: n } };
  }
  async inbox() { return []; }
  async history(input: Parameters<PublicClient["history"]>[0]) { return { data: this.messages.get(input.sessionID) ?? [], cursor: {} }; }
  async active() { return {}; }
  async cancelInbox() { this.cancellations++; }
  async interrupt() { this.cancellations++; return { interrupted: true }; }
}
function controlled(client: Client) {
  let callback: (() => void) | undefined;
  let cancels = 0;
  const services: ResolvedAgentService[] = [];
  const deps: RuntimeDependencies = {
    async resolveAgentService(config) { return "url" in config.service ? { url: config.service.url, token: config.service.token } : { url: "http://127.0.0.1:44991", headers: { authorization: `Basic ${secret}` } }; },
    createPublicClient(service) { services.push(service); return client; },
    startTimer(poll) { callback = poll; return () => { cancels++; }; },
  };
  return { deps, services, pulse() { if (!callback) throw new Error("Supervisor timer was not installed"); callback(); }, cancels: () => cancels };
}
async function fixture(action: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join("/tmp/opencode", "agent-runtime-owned-"));
  try { await action(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function progress(daemon: RunningDaemon, timer: ReturnType<typeof controlled>, predicate: () => Promise<boolean>) {
  for (let i = 0; i < 40; i++) { timer.pulse(); if (await predicate()) return; }
  throw new Error("Owned fixture did not reach expected durable state");
}

function seedExport(path: string) {
  const db = new Database(path);
  try {
    migrate(db);
    const store = new SqliteStore(db);
    store.saveThought({ id: "export-source", text: "cobalt existing human thinking", title: "Owned source", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2030", origin: "fixture", parentId: null, sourceIds: [] });
    store.saveThought({ id: "export-ai", text: "an AI hypothesis", title: null, titleAuthor: null, author: "ai", kind: "ai-interpretation", createdAt: "2031", origin: "fixture", parentId: "export-source", sourceIds: ["export-source"] });
  } finally { db.close(); }
}
function snapshot(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources", "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections", "thought_search_fts", "response_search_fts"].map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
  } finally { db.close(); }
}
async function markdown(daemon: RunningDaemon, path: string, token = user) {
  const response = await fetch(new URL(path, daemon.url), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
  return { status: response.status, contentType: response.headers.get("content-type"), text: await bounded(response.text(), "Markdown body") };
}

test("agentic export searches, fully reads and downloads cited Markdown without changing knowledge", async () => fixture(async dir => {
  const path = join(dir, "export.sqlite"); seedExport(path);
  const client = new Client(); client.exportSourceId = "export-source";
  const timer = controlled(client); const events: DaemonEvent[] = [];
  const configured: AgentConfig = { ...agent, effort: { quick: "brief", standard: null, thorough: "deep" } };
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: configured }, event => events.push(event), timer.deps), "start");
  try {
    const before = snapshot(path);
    const admitted = await call(daemon, "/exports/agentic", "POST", { request: "Connect existing cobalt thinking" });
    expect(admitted.status).toBe(201);
    const run = object(object(admitted.data).run); const runId = string(run.id);
    expect(run).toMatchObject({ kind: "export", status: "queued", confirmedThoughtIds: [], responseId: null });
    expect((await markdown(daemon, `/exports/agentic/${runId}`)).status).toBe(409);
    await progress(daemon, timer, async () => object((await call(daemon, `/runs/${runId}`)).data).status === "completed");
    const final = object((await call(daemon, `/runs/${runId}`)).data);
    expect(final).toMatchObject({ id: runId, kind: "export", status: "completed", confirmedThoughtIds: [], responseId: null });
    const report = await markdown(daemon, `/exports/agentic/${runId}`);
    expect(report.status).toBe(200);
    expect(report.contentType).toMatch(/^text\/markdown\b/i);
    expect(report.text).toContain("# Fixture report");
    expect(report.text).toContain("Existing thinking, not new knowledge.");
    expect(report.text).toContain("export-source");
    expect(report.text).toContain("Owned source");
    expect(report.text).toContain("user");
    expect(snapshot(path)).toEqual(before);
    const first = client.prompts[0];
    if (!first) throw new Error("Expected export prompt");
    expect(client.sessions.get(first.sessionID)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    const initial = object(JSON.parse(first.text));
    expect(JSON.stringify(initial)).toContain("Connect existing cobalt thinking");
    if (!Array.isArray(initial.capabilities)) throw new Error("Expected explicit capability list");
    expect(initial.capabilities.map(item => string(object(item).capability)).sort()).toEqual(["readConnection", "readResponse", "readThought", "search"].sort());
    expect(client.models[0]).toEqual({ providerID: "fixture", id: "model" });
    expect((await markdown(daemon, `/exports/agentic/${runId}`, ai)).status).toBe(403);
    const evolve = await call(daemon, "/thoughts/export-source/evolve", "POST", { text: "a normal conversation" });
    expect(evolve.status).toBe(201);
    expect((await markdown(daemon, `/exports/agentic/${string(object(object(evolve.data).run).id)}`)).status).toBe(404);
    const rejected = await fetch(new URL("/thoughts/export-source/reject", daemon.url), { method: "POST", headers: { authorization: `Bearer ${user}` }, signal: AbortSignal.timeout(1500) });
    expect(rejected.status).toBe(204);
    await bounded(rejected.text(), "rejection body");
    const historical = await markdown(daemon, `/exports/agentic/${runId}`);
    expect(historical.status).toBe(200);
    expect(historical.text).toBe(report.text);
    expect((await markdown(daemon, `/exports/agentic/${runId}`, ai)).status).toBe(403);
    expect(JSON.stringify(events)).not.toContain(secret);
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test("malicious export model write requests cannot mutate knowledge or publish reports", async () => fixture(async dir => {
  const path = join(dir, "forged-export.sqlite"); seedExport(path);
  const client = new Client(); client.exportSourceId = "export-source"; const timer = controlled(client);
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent }, () => {}, timer.deps), "start");
  try {
    const before = snapshot(path);
    for (const request of [
      { capability: "development", arguments: { parentId: "export-source", text: "forged development", sourceIds: [] } },
      { capability: "interpretation", arguments: { text: "forged interpretation", sourceIds: [] } },
      { capability: "title-fill", arguments: { title: "forged title" } },
      { capability: "connection", arguments: { fromId: "export-source", toId: "export-ai", category: "related", explanation: "forged link", sourceIds: [] } },
    ]) {
      client.exportWrite = request;
      const admitted = await call(daemon, "/exports/agentic", "POST", { request: `Attempt ${request.capability}` });
      expect(admitted.status).toBe(201);
      const runId = string(object(object(admitted.data).run).id);
      await progress(daemon, timer, async () => ["failed", "interrupted"].includes(string(object((await call(daemon, `/runs/${runId}`)).data).status)));
      expect(client.exportProposals.at(-1)).toBe(request.capability);
      expect((await markdown(daemon, `/exports/agentic/${runId}`)).status).toBe(409);
    }
    expect(snapshot(path)).toEqual(before);
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test("agentic export validates user-only admission and unavailable/not-ready download without partial writes", async () => fixture(async dir => {
  const path = join(dir, "unconfigured-export.sqlite"); seedExport(path);
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai } }, () => {}), "start");
  try {
    const before = snapshot(path);
    const unavailable = await call(daemon, "/exports/agentic", "POST", { request: "my question" });
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(unavailable.data)).toMatch(/unavailable|not configured/i);
    expect((await call(daemon, "/exports/agentic", "POST", { request: "forged" }, ai)).status).toBe(403);
    expect((await markdown(daemon, "/exports/agentic/missing")).status).toBe(404);
    expect((await markdown(daemon, "/exports/agentic/missing", ai)).status).toBe(403);
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT COUNT(*) AS n FROM runs WHERE kind='export'").get()).toEqual({ n: 0 }); } finally { db.close(); }
    expect(snapshot(path)).toEqual(before);
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test.each([
  { effort: "quick", variant: "brief" }, { effort: "standard", variant: null }, { effort: "thorough", variant: "deep" },
] as const)("export $effort binds only its configured native variant", async ({ effort, variant }) => fixture(async dir => {
  const path = join(dir, "effort.sqlite"); seedExport(path);
  const client = new Client(); client.exportSourceId = "export-source"; const timer = controlled(client);
  const configured: AgentConfig = { ...agent, effort: { quick: "brief", standard: null, thorough: "deep" } };
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: configured }, () => {}, timer.deps), "start");
  try {
    const admitted = await call(daemon, "/exports/agentic", "POST", { request: `Question ${effort}`, effort });
    expect(admitted.status).toBe(201);
    const runId = string(object(object(admitted.data).run).id);
    await progress(daemon, timer, async () => { await call(daemon, `/runs/${runId}`); return client.models.length > 0; });
    expect(client.models[0]).toEqual({ providerID: "fixture", id: "model", ...(variant === null ? {} : { variant }) });
    expect((await call(daemon, "/exports/agentic", "POST", { request: "bad effort", effort: "maximum" })).status).toBe(400);
    expect((await call(daemon, "/exports/agentic", "POST", { request: "bad authority", model: "forged" })).status).toBe(400);
    expect((await call(daemon, "/exports/agentic?scope=history", "POST", { request: "bad query" })).status).toBe(400);
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test("Stop after native report completion but before publication forbids partial download", async () => fixture(async dir => {
  const path = join(dir, "stopped-export.sqlite"); seedExport(path);
  const client = new Client(); client.exportSourceId = "export-source"; const timer = controlled(client);
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent }, () => {}, timer.deps), "start");
  try {
    const before = snapshot(path);
    const admitted = await call(daemon, "/exports/agentic", "POST", { request: "Stop before publishing" });
    expect(admitted.status).toBe(201);
    const runId = string(object(object(admitted.data).run).id);
    await progress(daemon, timer, async () => {
      await call(daemon, `/runs/${runId}`);
      const db = new Database(path, { readonly: true });
      try { return db.query("SELECT 1 FROM run_steps WHERE run_id=? AND state='completed' AND json_extract(envelope_json,'$.kind')='report'").get(runId) !== null; }
      finally { db.close(); }
    });
    expect((await markdown(daemon, `/exports/agentic/${runId}`)).status).toBe(409);
    const stopped = await call(daemon, `/runs/${runId}/stop`, "POST", {});
    expect(stopped.status).toBe(200);
    expect(object(stopped.data).status).toBe("interrupted");
    for (let i = 0; i < 5; i++) { timer.pulse(); await call(daemon, `/runs/${runId}`); }
    expect(object((await call(daemon, `/runs/${runId}`)).data).status).toBe("interrupted");
    expect((await markdown(daemon, `/exports/agentic/${runId}`)).status).toBe(409);
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT COUNT(*) AS n FROM export_reports WHERE run_id=?").get(runId)).toEqual({ n: 0 }); } finally { db.close(); }
    expect(snapshot(path)).toEqual(before);
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test("rejection after a source was read fences an uncommitted export report", async () => fixture(async dir => {
  const path = join(dir, "rejected-export.sqlite"); seedExport(path);
  const client = new Client(); client.exportSourceId = "export-source"; const timer = controlled(client);
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent }, () => {}, timer.deps), "start");
  try {
    const admitted = await call(daemon, "/exports/agentic", "POST", { request: "Investigate cobalt" });
    expect(admitted.status).toBe(201);
    const runId = string(object(object(admitted.data).run).id);
    await progress(daemon, timer, async () => {
      await call(daemon, `/runs/${runId}`);
      const db = new Database(path, { readonly: true });
      try { return db.query("SELECT 1 FROM run_context WHERE run_id=? AND kind='thought' AND ref_id='export-source' AND full_read=1").get(runId) !== null; }
      finally { db.close(); }
    });
    const rejected = await fetch(new URL("/thoughts/export-source/reject", daemon.url), { method: "POST", headers: { authorization: `Bearer ${user}` }, signal: AbortSignal.timeout(1500) });
    expect(rejected.status).toBe(204); await bounded(rejected.text(), "rejection body");
    await progress(daemon, timer, async () => object((await call(daemon, `/runs/${runId}`)).data).status === "interrupted");
    expect((await markdown(daemon, `/exports/agentic/${runId}`)).status).toBe(409);
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT COUNT(*) AS n FROM export_reports WHERE run_id=?").get(runId)).toEqual({ n: 0 }); } finally { db.close(); }
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test("bound export effort and model survive daemon restart with changed configuration", async () => fixture(async dir => {
  const path = join(dir, "bound-export.sqlite"); seedExport(path);
  const client = new Client(); client.exportSourceId = "export-source";
  let timer = controlled(client);
  const first: AgentConfig = { ...agent, effort: { quick: "brief", standard: null, thorough: "deep" } };
  const second: AgentConfig = { ...agent, model: { providerID: "other", id: "changed" }, effort: { quick: "changed-quick", standard: "changed-standard", thorough: "changed-thorough" } };
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: first }, () => {}, timer.deps), "start");
    const admitted = await call(daemon, "/exports/agentic", "POST", { request: "Restart this export", effort: "thorough" });
    expect(admitted.status).toBe(201);
    const runId = string(object(object(admitted.data).run).id);
    await progress(daemon, timer, async () => { if (!daemon) throw new Error("Missing daemon"); await call(daemon, `/runs/${runId}`); return client.models.length > 0; });
    expect(client.models).toEqual([{ providerID: "fixture", id: "model", variant: "deep" }]);
    const before = new Database(path, { readonly: true }); let binding: unknown;
    try { binding = before.query("SELECT * FROM agent_bindings WHERE run_id=?").get(runId); expect(binding).not.toBeNull(); } finally { before.close(); }
    await bounded(daemon.stop(), "first stop"); daemon = undefined;
    timer = controlled(client);
    daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: second }, () => {}, timer.deps), "restart");
    await progress(daemon, timer, async () => { if (!daemon) throw new Error("Missing daemon"); return object((await call(daemon, `/runs/${runId}`)).data).status === "completed"; });
    const after = new Database(path, { readonly: true });
    try { expect(after.query("SELECT * FROM agent_bindings WHERE run_id=?").get(runId)).toEqual(binding); } finally { after.close(); }
    expect(client.models).toEqual([{ providerID: "fixture", id: "model", variant: "deep" }]);
    expect((await markdown(daemon, `/exports/agentic/${runId}`)).status).toBe(200);
  } finally { if (daemon) await bounded(daemon.stop(), "stop"); }
}));

for (const kind of ["weave", "evolve"] as const) test(`persisted legacy deny ${kind} recovers after lost acknowledgement without upgrading or resubmitting`, async () => fixture(async dir => {
  const path = join(dir, "legacy-deny.sqlite");
  let db = new Database(path), worker: ConfiguredRunWorker | undefined;
  let sequence = 0;
  const sources = { id: () => `legacy-${++sequence}`, now: () => "2030-01-02T03:04:05.000Z" };
  class LostAckClient extends Client {
    override async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
      await super.prompt(input);
      throw new AgentUncertainError("fixture admitted before acknowledgement loss");
    }
  }
  const client = new LostAckClient(); client.completeFirst = true;
  try {
    migrate(db);
    new SqliteStore(db).saveThought({ id: "legacy-root", text: "test-owned legacy context", title: null, author: "user", kind: "captured-original", createdAt: sources.now(), origin: "fixture", parentId: null, sourceIds: [] });
    const runs = new SqliteRunRepository(db, sources);
    const run = kind === "weave" ? new SqliteRunOperations(db, sources).admitWeave("user", { subjectId: "legacy-root", triggerId: "legacy-trigger" })
      : new RunService({ repository: runs, dispatcher: { submit: async () => {}, observe: async () => "running" }, ...sources }).admit("user", "evolve", { parentId: "legacy-root", text: "legacy contribution" }).run;
    const claim = runs.claim(run.id), bindings = new SqliteAgentBindings(db);
    const legacy: AgentBinding = { sessionId: run.sessionId, serviceUrl: "http://127.0.0.1:44991", location: { directory: agent.directory },
      model: { ...agent.model, variant: "legacy-variant" }, permissions: [{ action: "read", resource: "/legacy/*", effect: "deny" }, { action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 };
    // Frozen test-owned predecessor bytes: never regenerate historical inputs using today's renderer.
    const input = JSON.stringify({ version: 1, kind: "job", instructions: ["LEGACY: no native tools; use application capabilities only"],
      context: { job: { kind, ...(kind === "evolve" ? { contributionId: run.inputThoughtId } : { subjectId: "legacy-root" }) } } });
    new SqliteRunProtocolRepository(db).prepare(claim, { promptId: run.promptId, input });
    const adapter = new OpenCodeAdapter(client, bindings, bindings.assertActive.bind(bindings));
    await adapter.ensureSession(claim, legacy);
    await expect(adapter.submit(claim, legacy, { promptId: run.promptId, input })).rejects.toThrow(AgentUncertainError);
    expect(runs.get(run.id)?.status).toBe("uncertain");
    const saved = db.query("SELECT * FROM agent_bindings WHERE run_id=?").get(run.id);
    expect(saved).not.toBeNull();
    db.close(); db = new Database(path); migrate(db);
    worker = new ConfiguredRunWorker({ db, ...sources, config: { ...agent, directory: "/tmp/opencode/new-config-directory", model: { providerID: "new-provider", id: "new-model" } },
      resolve: async () => ({ url: legacy.serviceUrl }), client: () => client });
    const reopened = new SqliteRunRepository(db, sources);
    for (let i = 0; i < 12 && reopened.get(run.id)?.status !== "completed"; i++) await worker.tick(run.id);
    expect(reopened.get(run.id)?.status).toBe("completed");
    expect(db.query("SELECT * FROM agent_bindings WHERE run_id=?").get(run.id)).toEqual(saved);
    expect(new SqliteAgentBindings(db).get(run.id)).toEqual(legacy);
    expect(new SqliteRunProtocolRepository(db).steps(run.id).map(step => ({ promptId: step.promptId, input: step.input }))).toEqual([{ promptId: run.promptId, input }]);
    expect(client.prompts).toEqual([{ sessionID: legacy.sessionId, id: run.promptId, text: input }]);
    expect(client.models).toEqual([legacy.model]);
    expect(client.sessions.get(legacy.sessionId)?.permissions).toEqual(legacy.permissions);
  } finally { if (worker) { worker.pause(); await worker.drain(); } db.close(); }
}));

test("configured but unreachable export remains durable without a fabricated report", async () => fixture(async dir => {
  const path = join(dir, "unreachable-export.sqlite"); seedExport(path);
  const client = new Client(); client.unavailable = true; const timer = controlled(client);
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent }, () => {}, timer.deps), "start");
  try {
    const before = snapshot(path);
    const admitted = await call(daemon, "/exports/agentic", "POST", { request: "Retain while unavailable" });
    expect(admitted.status).toBe(201);
    const runId = string(object(object(admitted.data).run).id);
    for (let i = 0; i < 8; i++) { timer.pulse(); await call(daemon, `/runs/${runId}`); }
    const status = object((await call(daemon, `/runs/${runId}`)).data);
    expect(["queued", "submitting", "running", "uncertain"]).toContain(string(status.status));
    expect((await markdown(daemon, `/exports/agentic/${runId}`)).status).toBe(409);
    expect(client.prompts).toEqual([]);
    expect(snapshot(path)).toEqual(before);
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test("a failed pre-dispatch history read retries the same persisted prompt without becoming uncertain", async () => fixture(async dir => {
  class PreflightClient extends Client {
    historyCalls = 0;
    failures = 0;
    override async history(input: Parameters<PublicClient["history"]>[0]) {
      this.historyCalls++;
      if (this.failures === 0) { this.failures++; throw new AgentUncertainError("test-owned preflight transport failure"); }
      return super.history(input);
    }
  }
  const db = new Database(join(dir, "preflight.sqlite"));
  try {
    migrate(db);
    new SqliteStore(db).saveThought({ id: "preflight-subject", text: "test-owned context", title: null, author: "user", kind: "captured-original", createdAt: "2031", origin: "fixture", parentId: null, sourceIds: [] });
    let sequence = 0;
    const sources = { id: () => `preflight-${++sequence}`, now: () => "2031" };
    const operations = new SqliteRunOperations(db, sources);
    const runs = new SqliteRunRepository(db, sources);
    const steps = new SqliteRunProtocolRepository(db);
    const run = operations.admitWeave("user", { subjectId: "preflight-subject", triggerId: "preflight-trigger" });
    const client = new PreflightClient(); client.completeFirst = true;
    const worker = new ConfiguredRunWorker({ db, config: agent, ...sources,
      resolve: async () => ({ url: "http://127.0.0.1:44991", token: secret }), client: () => client });
    try {
      for (let i = 0; i < 8 && client.failures === 0; i++) await worker.tick(run.id);
      expect(client.failures).toBe(1);
      expect(client.prompts).toEqual([]);
      const afterFailure = runs.get(run.id);
      expect(afterFailure?.status).toBe("queued");
      if (!afterFailure) throw new Error("Expected retained run");
      const prepared = steps.steps(run.id)[0];
      if (!prepared || prepared.input === null) throw new Error("Expected persisted initial prompt input");
      expect(prepared.state).toBe("prepared");
      const input = prepared.input;
      const promptId = prepared.promptId;
      const sessionId = afterFailure.sessionId;
      expect(sessionId).toEqual(expect.any(String));
      for (let i = 0; i < 20 && client.prompts.length === 0; i++) await worker.tick(run.id);
      expect(client.prompts).toEqual([{ sessionID: sessionId, id: promptId, text: input }]);
      expect(runs.get(run.id)?.generation).toBe(afterFailure.generation);
      expect(runs.get(run.id)?.status).toBe("running");
      for (let i = 0; i < 20 && runs.get(run.id)?.status !== "completed"; i++) await worker.tick(run.id);
      expect(runs.get(run.id)?.status).toBe("completed");
      expect(client.historyCalls).toBeGreaterThanOrEqual(2);
      expect(client.prompts).toEqual([{ sessionID: sessionId, id: promptId, text: input }]);
      expect(steps.steps(run.id)).toHaveLength(1);
      expect(steps.steps(run.id)[0]).toMatchObject({ promptId, input });
      expect(runs.get(run.id)?.sessionId).toBe(sessionId);
      const finished = runs.get(run.id);
      if (!finished) throw new Error("Expected completed run");
      expect(finished.generation).toBeGreaterThan(afterFailure.generation);
      expect(runs.reply(run.id)).toMatchObject({ text: "no further findings", state: "complete", thoughtIds: ["preflight-subject"] });
    } finally { worker.pause(); }
  } finally { db.close(); }
}));

test("unconfigured Evolve is unavailable before contribution admission and user routes are role-restricted", async () => fixture(async dir => {
  const path = join(dir, "owned.sqlite");
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai } }, () => {}), "start");
  try {
    const captured = await call(daemon, "/thoughts", "POST", { text: "retained offline" });
    expect(captured.status).toBe(201);
    const root = string(object(captured.data).id);
    const evolve = await call(daemon, `/thoughts/${root}/evolve`, "POST", { text: "not admitted" });
    expect(evolve.status).toBe(503);
    expect(JSON.stringify(evolve.data)).toMatch(/unavailable|not configured/i);
    const thoughts = await call(daemon, "/thoughts");
    expect(thoughts.status).toBe(200);
    expect(Array.isArray(thoughts.data) ? thoughts.data.length : -1).toBe(1);
    expect((await call(daemon, `/thoughts/${root}/evolve`, "POST", { text: "forged" }, ai)).status).toBe(403);
    expect((await call(daemon, "/runs/unknown", "GET", undefined, ai)).status).toBe(403);
    expect((await call(daemon, "/runs/unknown/stop", "POST", {}, ai)).status).toBe(403);
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test("configured runtime drives scoped weave and Evolve, exposes honest user status and stops locally", async () => fixture(async dir => {
  const path = join(dir, "owned.sqlite");
  const client = new Client(); const timer = controlled(client); const events: DaemonEvent[] = [];
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent }, event => events.push(event), timer.deps), "start");
  try {
    expect(timer.services).toEqual([]); // Attaching remains lazy until work is polled.
    const captured = await call(daemon, "/thoughts", "POST", { text: "owned original" });
    expect(captured.status).toBe(201);
    const root = string(object(captured.data).id);
    await progress(daemon, timer, async () => object((await call(daemon, `/thoughts/${root}`)).data).title === "Fixture generated title");
    expect(timer.services).toEqual([{ url: agent.service && "url" in agent.service ? agent.service.url : "", token: secret }]);
    expect(client.models[0]).toEqual({ providerID: "fixture", id: "model", variant: "s" });
    const admitted = await call(daemon, `/thoughts/${root}/evolve`, "POST", { text: "owned question" });
    expect(admitted.status).toBe(201);
    const admission = object(admitted.data); const contribution = object(admission.contribution); const run = object(admission.run);
    const runId = string(run.id); const contributionId = string(contribution.id);
    expect(contribution).toMatchObject({ text: "owned question", author: "user", parentId: root });
    await progress(daemon, timer, async () => object((await call(daemon, `/runs/${runId}`)).data).status === "completed");
    const status = await call(daemon, `/runs/${runId}`);
    expect(status.status).toBe(200);
    const view = object(status.data);
    // Bun's asymmetric matchers can mutate the received object; retain real IDs for HTTP reads.
    expect(structuredClone(view)).toMatchObject({ id: runId, kind: "evolve", status: "completed", confirmedThoughtIds: [expect.any(String)], responseId: expect.any(String) });
    const response = await call(daemon, `/responses/${string(view.responseId)}`);
    expect(response.data).toMatchObject({ text: "fixture human reply", role: "addendum", state: "complete", thoughtIds: view.confirmedThoughtIds });
    const ids = view.confirmedThoughtIds;
    if (!Array.isArray(ids) || typeof ids[0] !== "string") throw new Error("Expected issued development");
    expect((await call(daemon, `/thoughts/${ids[0]}`)).data).toMatchObject({ parentId: contributionId, author: "ai", text: "fixture development" });
    const evolveSession = [...client.sessions.values()].find(session => session.metadata.runId === runId);
    expect(evolveSession?.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    expect((await call(daemon, `/runs/${runId}?scope=history`)).status).toBe(400);
    expect((await call(daemon, `/thoughts/${root}/evolve`, "POST", { text: "bad", id: "model-owned" })).status).toBe(400);
    const pending = await call(daemon, `/thoughts/${root}/evolve`, "POST", { text: "stop me" });
    const pendingId = string(object(object(pending.data).run).id);
    expect(pending.status).toBe(201);
    const stopped = await call(daemon, `/runs/${pendingId}/stop`, "POST", {});
    expect(stopped.status).toBe(200);
    expect(object(stopped.data).status).toBe("interrupted");
    expect(object((await call(daemon, `/runs/${pendingId}`)).data).status).toBe("interrupted");
    for (const payload of [JSON.stringify(events), JSON.stringify(status.data), JSON.stringify(admitted.data)]) {
      expect(payload).not.toContain(secret); expect(payload).not.toContain(user); expect(payload).not.toContain(ai); expect(payload).not.toContain("requestCapability");
    }
  } finally { await bounded(daemon.stop(), "stop"); }
  expect(timer.cancels()).toBe(1);
  expect(client.cancellations).toBe(0); // Daemon shutdown is not user Stop on unrelated work.
  const db = new Database(path, { readonly: true });
  try { expect(JSON.stringify(db.query("SELECT * FROM agent_bindings").all())).not.toContain(secret); } finally { db.close(); }
}));

test("a captured URL exposes the completed controlled Weaver outcome as a Full reply", async () => fixture(async dir => {
  const path = join(dir, "weave-outcome.sqlite");
  const client = new Client(); client.completeFirst = true;
  const timer = controlled(client);
  const daemon = await bounded(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent }, () => {}, timer.deps), "start");
  try {
    const captured = await call(daemon, "/thoughts", "POST", { text: "https://example.test/unavailable" });
    expect(captured.status).toBe(201);
    const root = string(object(captured.data).id);
    const db = new Database(path, { readonly: true });
    let runId: string;
    try { runId = string(object(db.query("SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=?").get(root)).id); }
    finally { db.close(); }
    await progress(daemon, timer, async () => object((await call(daemon, `/runs/${runId}`)).data).status === "completed");
    const replies = await call(daemon, `/thoughts/${root}/responses`);
    expect(replies.status).toBe(200);
    if (!Array.isArray(replies.data)) throw new Error("Expected response list");
    expect(replies.data).toHaveLength(1);
    const reply = object(replies.data[0]);
    expect(reply).toMatchObject({ text: "no further findings", state: "complete", thoughtIds: [root] });
    expect((await call(daemon, `/responses/${string(reply.id)}`)).data).toEqual(reply);
  } finally { await bounded(daemon.stop(), "stop"); }
}));

test("configured but unreachable native service leaves admitted work honest and durable", async () => fixture(async dir => {
  const client = new Client(); client.unavailable = true; const timer = controlled(client);
  const daemon = await bounded(startDaemon({ dbPath: join(dir, "owned.sqlite"), port: 0, credentials: { user, ai }, agent }, () => {}, timer.deps), "start");
  try {
    const root = string(object((await call(daemon, "/thoughts", "POST", { text: "offline capture" })).data).id);
    const admission = await call(daemon, `/thoughts/${root}/evolve`, "POST", { text: "retained question" });
    expect(admission.status).toBe(201);
    const runId = string(object(object(admission.data).run).id);
    for (let i = 0; i < 8; i++) { timer.pulse(); await call(daemon, "/thoughts"); }
    const view = object((await call(daemon, `/runs/${runId}`)).data);
    expect(["queued", "submitting", "running", "uncertain"]).toContain(string(view.status));
    expect(view.responseId).toBeNull();
    expect(view.confirmedThoughtIds).toEqual([]);
    expect(client.prompts).toHaveLength(0);
    expect(JSON.stringify(view)).not.toContain(secret);
  } finally { await bounded(daemon.stop(), "stop"); }
}));
