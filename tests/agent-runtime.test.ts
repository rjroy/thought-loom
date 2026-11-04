import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentSessionMissingError, AgentUncertainError } from "../src/agent/errors";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import type { InboxItem, NativeMessage, NativeSession, PublicClient, ResolvedAgentService } from "../src/agent/opencode-adapter";
import type { AgentConfig } from "../src/daemon/agent-config";
import { startDaemon, type DaemonEvent, type RunningDaemon, type RuntimeDependencies } from "../src/daemon/runtime";
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
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, NativeMessage[]>();
  readonly prompts: { sessionID: string; id: string; text: string }[] = [];
  readonly models: NativeSession["model"][] = [];
  cancellations = 0;
  unavailable = false;
  completeFirst = false;
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
    const output = turn > 1 || this.completeFirst ? { version: 1, kind: "complete", reply: job.kind === "evolve" ? "fixture human reply" : "no further findings" } :
      job.kind === "evolve" ? { version: 1, kind: "request", request: { capability: "development", arguments: { parentId: string(job.contributionId), text: "fixture development", sourceIds: [] } } } :
        { version: 1, kind: "request", request: { capability: "title-fill", arguments: { title: "Fixture generated title" } } };
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
      expect(runs.reply(run.id)).toBeNull();
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
