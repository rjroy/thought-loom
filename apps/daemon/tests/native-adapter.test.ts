import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createToolApp } from "../src/tool-boundary";
import { NativeWeavingAdapter, type NativeClientPort, type NativeSession } from "../src/native-adapter";
import { WeavingWorker, type WeavingRun } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

const run: WeavingRun = { jobId: "job-1", sourceId: "source-1", runId: "run-1", sessionId: "ses_fixture_1", promptId: "msg_fixture_prompt" };
const model = { providerID: "fixture-provider", id: "fixture-model" };
const config = { registrationFile: "/fixture/registration.json", location: "/fixture/thoughtloom", agent: "weaver", model };

class ScriptedClient implements NativeClientPort {
  discovered: Array<{ file: string; version: string }> = [];
  prompts: WeavingRun[] = [];
  pages: Array<{ sessionId: string; cursor?: string }> = [];
  identityResult = { version: "2.2.2", pid: 42 };
  session: NativeSession = { id: run.sessionId, location: config.location, agent: config.agent, ownerRunId: run.runId, model: { ...model, variant: "default" }, permissionActions: ["deny:*:*", "allow:record_interpretation"] };
  async discover(file: string, version: string) { this.discovered.push({ file, version }); return { url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }; }
  async identity() { return this.identityResult; }
  async createSession() { return this.session; }
  async getSession() { return this.session; }
  async prompt(value: WeavingRun) { this.prompts.push(value); return { promptId: value.promptId }; }
  observation: "succeeded" | "failed" | "interrupted" = "succeeded";
  async activity(): Promise<{ active: boolean; outcome: "succeeded" | "failed" | "interrupted" | null }> { return { active: false, outcome: this.observation }; }
  async history(sessionId: string, cursor?: string): ReturnType<NativeClientPort["history"]> {
    this.pages.push({ sessionId, ...(cursor ? { cursor } : {}) });
    return cursor ? { messages: [{ id: "assistant-1", parentId: run.promptId, state: "completed" as const, text: "No connections found." }] } : { messages: [], next: "page-2" };
  }
}

test("explicit discovery and verified owned session accept native default model variant before admission", async () => {
  const client = new ScriptedClient();
  const adapter = new NativeWeavingAdapter({ client, ...config });
  await adapter.prepareSession(run);
  expect(client.discovered).toEqual([{ file: config.registrationFile, version: "2.2.2" }]);
  expect(await adapter.admit(run)).toEqual({ kind: "admitted" });
  expect(client.prompts).toEqual([run]);
});

test("authoritative correlated failed and interrupted executions are not treated as pending or completed", async () => {
  for (const outcome of ["failed", "interrupted"] as const) {
    const client = new ScriptedClient();
    client.observation = outcome;
    client.history = async (sessionId: string, cursor?: string) => {
      client.pages.push({ sessionId, ...(cursor ? { cursor } : {}) });
      return { messages: [{ id: "assistant-failed", parentId: run.promptId, state: outcome }] };
    };
    const adapter = new NativeWeavingAdapter({ client, ...config });
    await adapter.prepareSession(run);
    await adapter.admit(run);
    expect(await adapter.inspect(run)).toEqual({ kind: outcome });
    expect(client.prompts).toEqual([run]);
  }
});

test("mismatched native identity or session location fails before prompt admission", async () => {
  const client = new ScriptedClient();
  client.identityResult = { version: "2.2.1", pid: 42 };
  const adapter = new NativeWeavingAdapter({ client, ...config });
  await expect(adapter.prepareSession(run)).rejects.toMatchObject({ code: "service_identity_mismatch" });
  expect(client.prompts).toEqual([]);
  client.identityResult = { version: "2.2.2", pid: 42 };
  client.session = { ...client.session, location: "/fixture/other" };
  await expect(adapter.prepareSession(run)).rejects.toMatchObject({ code: "session_ownership_mismatch" });
  expect(client.prompts).toEqual([]);
});

test("missing operator registration fails closed before discovery or prompt", async () => {
  const client = new ScriptedClient();
  const adapter = new NativeWeavingAdapter({ client, ...config, registrationFile: "" });
  await expect(adapter.prepareSession(run)).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(client.discovered).toEqual([]);
  expect(client.prompts).toEqual([]);
});

test("recovery pages canonical owned history without re-admitting the prompt", async () => {
  const client = new ScriptedClient();
  const adapter = new NativeWeavingAdapter({ client, ...config });
  await adapter.prepareSession(run);
  await adapter.admit(run);
  expect(await adapter.inspect(run)).toEqual({ kind: "completed", recordedChanges: 0 });
  expect(client.pages).toEqual([{ sessionId: run.sessionId }, { sessionId: run.sessionId, cursor: "page-2" }]);
  expect(client.prompts).toEqual([run]);
});

test("repeated history cursors fail boundedly without resubmitting", async () => {
  const client = new ScriptedClient();
  client.history = async (sessionId: string, cursor?: string) => {
    client.pages.push({ sessionId, ...(cursor ? { cursor } : {}) });
    return { messages: [], next: "same-cursor" };
  };
  const adapter = new NativeWeavingAdapter({ client, ...config });
  await adapter.prepareSession(run);
  await adapter.admit(run);
  await expect(adapter.inspect(run)).rejects.toMatchObject({ code: "history_unavailable" });
  expect(client.pages).toHaveLength(2);
  expect(client.prompts).toEqual([run]);
});

test("an assistant result for another prompt is not completion of the owned command", async () => {
  const client = new ScriptedClient();
  client.history = async () => ({ messages: [{ id: "assistant-foreign", parentId: "msg_foreign", state: "completed", text: "Unrelated answer" }] });
  const adapter = new NativeWeavingAdapter({ client, ...config });
  await adapter.prepareSession(run);
  await adapter.admit(run);
  expect(await adapter.inspect(run)).toEqual({ kind: "pending" });
  expect(client.prompts).toEqual([run]);
});

test("an incomplete owned response remains pending even when the native session reports success", async () => {
  const client = new ScriptedClient();
  client.history = async () => ({ messages: [
    { id: run.promptId, type: "user", state: "completed" },
    { id: "assistant-unfinished", type: "assistant", state: "pending", text: "" },
  ] });
  const adapter = new NativeWeavingAdapter({ client, ...config });
  await adapter.prepareSession(run);
  await adapter.admit(run);
  expect(await adapter.inspect(run)).toEqual({ kind: "pending" });
  client.history = async () => ({ messages: [{ id: run.promptId, type: "user", state: "completed" }] });
  expect(await adapter.inspect(run)).toEqual({ kind: "pending" });
  expect(client.prompts).toEqual([run]);
});

test("empty completed native response settles tool-writing run, revokes grant and releases next capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-empty-terminal-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const app = createApp({ databasePath });
  const capture = async (key: string) => {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text: `Original ${key}`, provenance: "manual" }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string };
  };
  const first = await capture("empty-first");
  const next = await capture("empty-next");
  const prompts: WeavingRun[] = [];
  const sessions = new Map<string, NativeSession>();
  const client: NativeClientPort = {
    async discover() { return { url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }; },
    async identity() { return { version: "2.2.2", pid: 42 }; },
    async createSession(owned) {
      const session: NativeSession = { id: owned.sessionId, ownerRunId: owned.runId, location: config.location, agent: config.agent, model: { ...model, variant: "default" }, permissionActions: ["deny:*:*", "allow:record_interpretation"] };
      sessions.set(owned.sessionId, session);
      return session;
    },
    async getSession(id) {
      const session = sessions.get(id);
      if (!session) throw new Error("Unknown fixture session");
      return session;
    },
    async prompt(owned) { prompts.push(owned); return { promptId: owned.promptId }; },
    async activity() { return { active: false, outcome: "succeeded" }; },
    async history(sessionId) {
      const owned = prompts.find((entry) => entry.sessionId === sessionId);
      if (!owned) throw new Error("Unknown fixture prompt");
      // Pinned V2 permits a completed stop with no text parts; the mapped text is empty.
      return { messages: [{ id: owned.promptId, type: "user", state: "completed" }, { id: "msg_fixture_empty_assistant", type: "assistant", state: "completed", text: "" }] };
    },
  };
  const adapter = new NativeWeavingAdapter({ client, ...config, databasePath });
  const worker = new WeavingWorker({ databasePath, adapter });
  const started = await worker.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected started run");
  const tools = createToolApp({ databasePath, transportCredential: "test-only-credential", location: config.location });
  const native = { sessionID: started.run.sessionId, agent: config.agent, messageID: "msg_fixture_tool_assistant", callID: "call_fixture_empty" };
  const input = { sourceId: first.id, text: "An attributable interpretation", evidenceSourceIds: [first.id] };
  const send = (callID: string) => tools.request("/internal/tools/record-interpretation", { method: "POST", headers: { authorization: "Bearer test-only-credential", "content-type": "application/json" }, body: JSON.stringify({ native: { ...native, callID }, input }) });
  expect((await send(native.callID)).status).toBe(200);
  await worker.recover();
  expect(await worker.getJob(first.id)).toMatchObject({ status: "completed", run: started.run });
  const db = new Database(databasePath, { readonly: true });
  try { expect(db.query("SELECT revoked FROM owned_grants WHERE session_id = ?").get(started.run.sessionId)).toEqual({ revoked: 1 }); } finally { db.close(); }
  expect((await send("call_after_completion")).status).toBe(403);
  expect(prompts).toEqual([started.run]);
  const nextStarted = await worker.startNext();
  expect(nextStarted.kind).toBe("started");
  if (nextStarted.kind !== "started") throw new Error("Expected next started run");
  expect(nextStarted.run.sourceId).toBe(next.id);
  expect(prompts).toEqual([started.run, nextStarted.run]);
});
