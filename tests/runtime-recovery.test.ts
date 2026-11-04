import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "../src/daemon/agent-config";
import { startDaemon, type RunningDaemon, type RuntimeDependencies } from "../src/daemon/runtime";

const user = "test-runtime-user-0123456789-abcdef0123";
const ai = "test-runtime-agent-0123456789-abcdef012";
const oldToken = "test-owned-old-service-token";
const newToken = "test-owned-new-service-token";
const config = (url: string, token: string, model = "old-model"): AgentConfig => ({ service: { url, token }, directory: "/tmp/opencode/owned-runtime", model: { providerID: "fixture", id: model }, effort: { quick: null, standard: "standard", thorough: null } });
const envelope = (capability: string, args: Record<string, unknown>) => JSON.stringify({ version: 1, kind: "request", request: { capability, arguments: args } });
const complete = JSON.stringify({ version: 1, kind: "complete", reply: "no more findings" });

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Expected string"); return value; }
function deferred() {
  let release: () => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release() };
}
async function bound<T>(value: Promise<T>, label: string): Promise<T> {
  return Promise.race([value, Bun.sleep(3000).then(() => { throw new Error(`${label} timed out`); })]);
}
function manualTimer() {
  let callback: (() => void) | undefined;
  const deps: RuntimeDependencies = { startTimer(poll) { callback = poll; return () => { callback = undefined; }; } };
  return { deps, tick() { if (!callback) throw new Error("Timer not started"); callback(); } };
}
async function http(daemon: RunningDaemon, path: string, method = "GET", value?: unknown) {
  const response = await fetch(new URL(path, daemon.url), { method, signal: AbortSignal.timeout(1500), headers: { authorization: `Bearer ${user}`, ...(value === undefined ? {} : { "content-type": "application/json" }) }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, value: await bound(response.json() as Promise<unknown>, "daemon JSON") };
}
function query(path: string, sql: string, ...params: string[]) {
  const db = new Database(path, { readonly: true });
  try { return db.query(sql).all(...params); } finally { db.close(); }
}
async function drive(daemon: RunningDaemon, timer: ReturnType<typeof manualTimer>, predicate: () => boolean) {
  for (let i = 0; i < 80; i++) { timer.tick(); await http(daemon, "/thoughts"); if (predicate()) return; }
  throw new Error("Owned runtime did not reach expected durable state");
}

/** Owned wire fixture shaped like the maintained SDK's actual decoded API. */
function serviceFixture() {
  const sessions = new Map<string, Record<string, unknown>>();
  const inputs = new Map<string, { id: string; text: string }[]>();
  const calls: { path: string; method: string; authorization: string | null; body: unknown }[] = [];
  const historyEntered = deferred(); const historyRelease = deferred();
  let blockHistory = false, failFirstAdmission = false, finishFirst = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const raw = await req.text(); const body: unknown = raw ? JSON.parse(raw) : null;
    calls.push({ path, method: req.method, authorization: req.headers.get("authorization"), body });
    if (path === "/api/info") return Response.json({ version: "99.0.0-fixture", pid: 1, urls: [], paths: { tmp: "/owned" } });
    if (path === "/api/session" && req.method === "POST") {
      const data = record(body); const id = text(data.id);
      const session = { ...data, projectID: "fixture-project", cost: 0, tokens: {}, time: { created: 1, updated: 1 } };
      sessions.set(id, session); inputs.set(id, []); return Response.json({ data: session });
    }
    if (path === "/api/session/active") return Response.json({ data: {} });
    const parts = path.split("/"); const id = parts[3] ?? ""; const session = sessions.get(id);
    if (!session) return Response.json({ _tag: "SessionNotFoundError", sessionID: id, message: "Native session is absent" }, { status: 404 });
    const items = inputs.get(id);
    if (!items) return new Response("fixture history missing", { status: 500 });
    if (parts.length === 4 && req.method === "GET") return Response.json({ data: session });
    if (parts[4] === "prompt" && req.method === "POST") {
      const data = record(body); const item = { id: text(data.id), text: text(data.text) }; items.push(item);
      if (failFirstAdmission) { failFirstAdmission = false; return new Response("admitted before acknowledgement loss", { status: 503 }); }
      return Response.json({ data: { id: item.id, sessionID: id, type: "user", payload: { text: item.text }, delivery: "queue", time: { created: items.length * 10 } } });
    }
    if (parts[4] === "message") {
      if (blockHistory) { historyEntered.release(); await historyRelease.promise; }
      const messages = items.flatMap((item, index) => {
        if (index === 0 && !finishFirst) return [];
        const created = index * 10 + 10;
        const output = index === 0 ? envelope("title-fill", { title: "Recovered title" }) : complete;
        return [
          { id: item.id, type: "user", text: item.text, time: { created } },
          { id: `assistant-${item.id}`, type: "assistant", time: { created: created + 1, streamed: created + 1, completed: created + 2 }, agent: "build", model: session.model, content: [{ type: "text", text: output }], finish: "stop", rawFinish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
          { id: `idle-${item.id}`, type: "idle", time: { created: created + 3 }, outcome: "succeeded" },
        ];
      });
      return Response.json({ data: messages, cursor: {} });
    }
    if (parts[4] === "inbox" && req.method === "GET") {
      return Response.json({ data: !finishFirst && items.length ? [{ id: items[0]?.id, sessionID: id, type: "user", payload: { text: items[0]?.text }, delivery: "queue", time: { created: 10 } }] : [] });
    }
    return new Response("unexpected fixture route", { status: 404 });
  } });
  return { server, calls, historyEntered, historyRelease, setBlocked(value: boolean) { blockHistory = value; }, loseFirstAck() { failFirstAdmission = true; }, completeFirst() { finishFirst = true; } };
}

test("daemon file reopen observes ambiguous admission and replays committed result without duplicate effect", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "runtime-recovery-"));
  const path = join(dir, "owned.sqlite"); const service = serviceFixture();
  let daemon: RunningDaemon | undefined;
  try {
    service.loseFirstAck();
    let timer = manualTimer();
    daemon = await bound(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: config(service.server.url.origin, oldToken) }, () => {}, timer.deps), "start");
    const capture = await http(daemon, "/thoughts", "POST", { text: "restart-owned thought" });
    expect(capture.status).toBe(201);
    const subjectId = text(record(capture.value).id);
    const rows = query(path, "SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=?", subjectId) as { id: string }[];
    const runId = rows[0]?.id;
    if (!runId) throw new Error("Expected durable capture job");
    const promptCalls = () => service.calls.filter(call => call.method === "POST" && call.path.endsWith("/prompt"));
    await drive(daemon, timer, () => promptCalls().length === 1 && record(query(path, "SELECT status FROM runs WHERE id=?", runId)[0]).status === "uncertain");
    const before = query(path, "SELECT r.status,r.session_id,s.prompt_id,s.input FROM runs r JOIN run_steps s ON s.run_id=r.id WHERE r.id=?", runId);
    const original = record(before[0]);
    expect(original.status).toBe("uncertain");
    const binding = query(path, "SELECT * FROM agent_bindings WHERE run_id=?", runId);
    expect(binding).toHaveLength(1);
    const firstBody = record(promptCalls()[0]?.body);
    expect(firstBody.id).toBe(original.prompt_id);
    expect(firstBody.text).toBe(original.input);
    await bound(daemon.stop(), "first daemon stop"); daemon = undefined;

    const reopened = new Database(path);
    try {
      reopened.exec("PRAGMA foreign_keys=ON");
      expect(reopened.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
    timer = manualTimer();
    daemon = await bound(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: config(service.server.url.origin, oldToken, "changed-model") }, () => {}, timer.deps), "restart");
    for (let i = 0; i < 6; i++) { timer.tick(); await http(daemon, "/thoughts"); }
    expect(promptCalls()).toHaveLength(1);
    expect(query(path, "SELECT * FROM agent_bindings WHERE run_id=?", runId)).toEqual(binding);
    expect(query(path, "SELECT prompt_id,input FROM run_steps WHERE run_id=?", runId)).toEqual([{ prompt_id: original.prompt_id, input: original.input }]);
    service.completeFirst();
    await drive(daemon, timer, () => query(path, "SELECT result_json FROM run_steps WHERE run_id=? AND position=0 AND result_json IS NOT NULL", runId).length === 1);
    expect(query(path, "SELECT operation_id,thought_id,result_json FROM run_operation_receipts WHERE run_id=?", runId)).toHaveLength(1);
    expect(query(path, "SELECT title,title_author FROM thought_titles WHERE thought_id=?", subjectId)).toEqual([{ title: "Recovered title", title_author: "ai" }]);
    expect(promptCalls()).toHaveLength(1);
    const receipt = query(path, "SELECT operation_id,thought_id,result_json FROM run_operation_receipts WHERE run_id=?", runId);
    await bound(daemon.stop(), "second daemon stop"); daemon = undefined;

    timer = manualTimer();
    daemon = await bound(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: config(service.server.url.origin, oldToken, "another-model") }, () => {}, timer.deps), "second restart");
    await drive(daemon, timer, () => record(query(path, "SELECT status FROM runs WHERE id=?", runId)[0]).status === "completed");
    expect(promptCalls()).toHaveLength(2);
    expect(query(path, "SELECT operation_id,thought_id,result_json FROM run_operation_receipts WHERE run_id=?", runId)).toEqual(receipt);
    expect(query(path, "SELECT title,title_author FROM thought_titles WHERE thought_id=?", subjectId)).toEqual([{ title: "Recovered title", title_author: "ai" }]);
    expect(query(path, "SELECT * FROM agent_bindings WHERE run_id=?", runId)).toEqual(binding);
    expect(service.calls.every(call => call.authorization === `Bearer ${oldToken}`)).toBe(true);
    const creates = service.calls.filter(call => call.path === "/api/session" && call.method === "POST");
    expect(creates).toHaveLength(1);
    expect(record(record(creates[0]?.body).model)).toEqual({ providerID: "fixture", id: "old-model", variant: "standard" });
  } finally {
    service.historyRelease.release();
    try { if (daemon) await bound(daemon.stop(), "daemon cleanup"); }
    finally { try { await bound(service.server.stop(true), "service cleanup"); } finally { await rm(dir, { recursive: true, force: true }); } }
  }
}, 20000);

test("daemon shutdown pauses actual SDK preflight, drains it before closing SQLite and never posts", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "runtime-preflight-"));
  const path = join(dir, "owned.sqlite"); const service = serviceFixture();
  service.setBlocked(true);
  let daemon: RunningDaemon | undefined;
  const closeSpy = spyOn(Database.prototype, "close");
  try {
    const timer = manualTimer();
    daemon = await bound(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: config(service.server.url.origin, oldToken) }, () => {}, timer.deps), "start");
    expect((await http(daemon, "/thoughts", "POST", { text: "preflight-owned thought" })).status).toBe(201);
    for (let i = 0; i < 20 && !service.calls.some(call => call.path.endsWith("/message")); i++) { timer.tick(); await http(daemon, "/thoughts"); }
    await bound(service.historyEntered.promise, "SDK history request");
    expect(service.calls.filter(call => call.path.endsWith("/message"))).toHaveLength(1);
    expect(service.calls.every(call => call.authorization === `Bearer ${oldToken}`)).toBe(true);
    expect(service.calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(0);
    const closesBefore = closeSpy.mock.calls.length;
    let stopped = false;
    const stopping = daemon.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(false);
    expect(closeSpy.mock.calls.length).toBe(closesBefore);
    service.historyRelease.release();
    await bound(stopping, "drained daemon stop"); daemon = undefined;
    expect(closeSpy.mock.calls.length).toBe(closesBefore + 1);
    expect(service.calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(0);
    expect(service.calls.filter(call => /interrupt|cancel/.test(call.path))).toHaveLength(0);
    const reopened = new Database(path, { readonly: true });
    try {
      expect(reopened.query("SELECT status FROM runs WHERE kind='weave'").all()).toEqual([{ status: "queued" }]);
      expect(reopened.query("SELECT cancellation_state FROM runs WHERE kind='weave'").all()).toEqual([{ cancellation_state: "none" }]);
    } finally { reopened.close(); }
  } finally {
    service.historyRelease.release();
    try { if (daemon) await bound(daemon.stop(), "daemon cleanup"); }
    finally { closeSpy.mockRestore(); try { await bound(service.server.stop(true), "service cleanup"); } finally { await rm(dir, { recursive: true, force: true }); } }
  }
}, 15000);

test("changed endpoint and credential cannot retarget a persisted native session", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "runtime-binding-"));
  const path = join(dir, "owned.sqlite"); const oldService = serviceFixture(); const newService = serviceFixture();
  let daemon: RunningDaemon | undefined;
  try {
    oldService.loseFirstAck();
    let timer = manualTimer();
    daemon = await bound(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: config(oldService.server.url.origin, oldToken) }, () => {}, timer.deps), "start");
    const root = text(record((await http(daemon, "/thoughts", "POST", { text: "old bound subject" })).value).id);
    const runRows = query(path, "SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=?", root);
    const runId = text(record(runRows[0]).id);
    await drive(daemon, timer, () => oldService.calls.some(call => call.path.endsWith("/prompt")) && record(query(path, "SELECT status FROM runs WHERE id=?", runId)[0]).status === "uncertain");
    const oldBinding = query(path, "SELECT * FROM agent_bindings WHERE run_id=?", runId);
    const sessionId = text(record(oldBinding[0]).session_id);
    await bound(daemon.stop(), "first stop"); daemon = undefined;
    const oldCount = oldService.calls.length;

    newService.completeFirst();
    timer = manualTimer();
    daemon = await bound(startDaemon({ dbPath: path, port: 0, credentials: { user, ai }, agent: config(newService.server.url.origin, newToken, "new-model") }, () => {}, timer.deps), "restart");
    // Positive control: the new endpoint is live and handles a distinct newly admitted run.
    const next = await http(daemon, "/thoughts", "POST", { text: "new endpoint subject" });
    expect(next.status).toBe(201);
    await drive(daemon, timer, () => newService.calls.some(call => call.path.endsWith("/prompt")));
    for (let i = 0; i < 5; i++) { timer.tick(); await http(daemon, "/thoughts"); }
    expect(oldService.calls.length).toBe(oldCount);
    expect(oldService.calls.every(call => call.authorization === `Bearer ${oldToken}`)).toBe(true);
    expect(newService.calls.length).toBeGreaterThan(0);
    expect(newService.calls.every(call => call.authorization === `Bearer ${newToken}`)).toBe(true);
    expect(JSON.stringify(newService.calls)).not.toContain(sessionId);
    expect(query(path, "SELECT * FROM agent_bindings WHERE run_id=?", runId)).toEqual(oldBinding);
    expect(record(query(path, "SELECT status FROM runs WHERE id=?", runId)[0]).status).toBe("uncertain");
  } finally {
    oldService.historyRelease.release(); newService.historyRelease.release();
    try { if (daemon) await bound(daemon.stop(), "daemon cleanup"); }
    finally {
      try { await Promise.all([bound(oldService.server.stop(true), "old service cleanup"), bound(newService.server.stop(true), "new service cleanup")]); }
      finally { await rm(dir, { recursive: true, force: true }); }
    }
  }
}, 20000);
