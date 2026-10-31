import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app";
import { NativeWeavingAdapter, type NativeClientPort, type NativeSession } from "../src/native-adapter";
import { WeavingWorker, type WeavingRun } from "../src/weaving";

// Narrow proposed maintained-client port: each event models the pinned V2
// session.text fields, not a copied SDK emulator. Subscribe must be established
// before prompt admission; the existing short settlement watcher is separate.
type TextBody = { type: "session.text.started" } | { type: "session.text.delta"; delta: string } | { type: "session.text.ended"; text: string };
type TextEvent = { id: string; sessionID: string; assistantMessageID: string; ordinal: number } & TextBody;
type TextInput = { id: string; ordinal: number; sessionID?: string; assistantMessageID?: string } & TextBody;
type PreviewPort = NativeClientPort & { subscribeText(sessionId: string, onEvent: (event: TextEvent) => void, onGap: () => void): Promise<{ close(): Promise<void> }> };
const directories: string[] = [];
const workers: WeavingWorker[] = [];
afterEach(async () => { for (const worker of workers.splice(0)) await worker.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(limits?: { maxCharacters: number; maxFragments: number; maxEventIds: number; ttlMs: number }) {
  const directory = await mkdtemp("/tmp/opencode/thoughtloom-preview-test-"); directories.push(directory);
  const databasePath = join(directory, "fixture.sqlite"), setup = createApp({ databasePath });
  const captured = await setup.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "preview-root" }, body: JSON.stringify({ text: "A controlled original.", provenance: "test fixture" }) });
  expect(captured.status).toBe(201);
  const root = await captured.json() as { id: string };
  const opened = await setup.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: root.id } }) });
  expect(opened.status).toBe(201);
  const dialogue = await opened.json() as { id: string };
  const submitted = await setup.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "preview-turn" }, body: JSON.stringify({ text: "A controlled challenge." }) });
  expect(submitted.status).toBe(201);
  const turn = await submitted.json() as { id: string; jobId: string };
  const sessions = new Map<string, NativeSession>(), listeners = new Map<string, (event: TextEvent) => void>(), gaps = new Map<string, () => void>(), prompts: WeavingRun[] = [], lifecycle: string[] = [];
  const messageId = "msg_fixture_assistant";
  let outcome: "pending" | "succeeded" | "failed" = "pending", canonical = "", now = 1_000, messageAgent = "weaver", messageModel = "model";
  const client: PreviewPort = {
    async discover() { return { url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }; },
    async identity() { return { version: "2.2.2", pid: 42 }; },
    async createSession(run) { const session: NativeSession = { id: run.sessionId, ownerRunId: run.runId, location: "/fixture/location", agent: "weaver", model: { providerID: "fixture", id: "model", variant: "default" }, permissionActions: ["deny:*:*", "allow:record_interpretation"] }; sessions.set(run.sessionId, session); return session; },
    async getSession(id) { const result = sessions.get(id); if (!result) throw new Error("Unknown fixture session"); return result; },
    async subscribeText(sessionId, onEvent, onGap) { lifecycle.push("subscribe"); listeners.set(sessionId, onEvent); gaps.set(sessionId, onGap); return { async close() { lifecycle.push("close"); listeners.delete(sessionId); gaps.delete(sessionId); } }; },
    async prompt(run) { lifecycle.push("prompt"); prompts.push(run); return { promptId: run.promptId }; },
    async activity() { return { active: outcome === "pending", outcome: outcome === "pending" ? null : outcome }; },
    async history(sessionId) {
      const run = prompts.find((entry) => entry.sessionId === sessionId); if (!run) throw new Error("Unknown fixture prompt");
      // Ordinary history has no accumulated delta while the message is open.
      return { messages: [{ id: run.promptId, type: "user", state: "completed" }, { id: messageId, parentId: run.promptId, type: "assistant", agent: messageAgent, model: { providerID: "fixture", id: messageModel }, state: outcome === "pending" ? "pending" : outcome === "succeeded" ? "completed" : "failed", text: outcome === "pending" ? "" : canonical }] };
    },
    async cancelUndelivered() {}, async interrupt() {},
  };
  const options = { client, databasePath, registrationFile: "/fixture/registration", location: "/fixture/location", agent: "weaver", model: { providerID: "fixture", id: "model" }, operations: ["record_interpretation" as const], ...(limits ? { previewLimits: limits, now: () => now } : {}) };
  const adapter = new NativeWeavingAdapter(options);
  const worker = new WeavingWorker({ databasePath, adapter }), app = createApp({ databasePath, weavingWorker: worker });
  workers.push(worker);
  const result = await worker.startNext(); expect(result.kind).toBe("started");
  if (result.kind !== "started") throw new Error("Expected owned dialogue admission");
  expect(result.run.jobId).toBe(turn.jobId);
  const run = result.run;
  const event = (value: TextInput) => {
    const sessionID = value.sessionID ?? run.sessionId;
    const payload = { ...value, sessionID, assistantMessageID: value.assistantMessageID ?? messageId };
    // Simulate an untrusted foreign envelope arriving on the owned subscription.
    listeners.get(run.sessionId)?.(payload);
  };
  const read = async () => { const response = await app.request(`/dialogues/${dialogue.id}`); expect(response.status).toBe(200); return await response.json(); };
  const outcomes = () => { const db = new Database(databasePath, { readonly: true }); try { return db.query("SELECT COUNT(*) AS count FROM dialogue_outcomes").get(); } finally { db.close(); } };
  return { app, databasePath, dialogue, turn, run, messageId, worker, adapter, prompts, event, read, outcomes, lifecycle,
    gap() { gaps.get(run.sessionId)?.(); }, tick(ms: number) { now += ms; },
    setAgent(agent: string) { const session = sessions.get(run.sessionId); if (!session) throw new Error("Missing fixture session"); session.agent = agent; },
    setMessageIdentity(agent: string, model: string) { messageAgent = agent; messageModel = model; },
    setOutcome(value: typeof outcome, text = "") { outcome = value; canonical = text; } };
}

test("owned text deltas append within a fragment, deduplicate event ids and remain memory-only", async () => {
  const f = await fixture();
  f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
  f.event({ type: "session.text.delta", id: "evt_a", ordinal: 0, delta: "A" });
  f.event({ type: "session.text.delta", id: "evt_b", ordinal: 0, delta: "A" });
  f.event({ type: "session.text.delta", id: "evt_b", ordinal: 0, delta: "A" });
  await f.worker.recover();
  expect(await f.read()).toMatchObject({ turns: [{ id: f.turn.id, status: "running", preview: { runId: f.run.runId, messageId: f.messageId, text: "AA", truncated: false } }] });
  expect(f.outcomes()).toEqual({ count: 0 });
  expect(f.prompts).toEqual([f.run]);
});

test("assistant messages with a forged agent or model are not admitted as preview", async () => {
  for (const [agent, model] of [["other-agent", "model"], ["weaver", "other-model"]]) {
    const f = await fixture(); f.setMessageIdentity(agent, model);
    f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
    f.event({ type: "session.text.delta", id: "evt_secret", ordinal: 0, delta: "forged identity content" });
    await f.worker.recover();
    expect(JSON.stringify(await f.read())).not.toContain("forged identity content");
    expect(f.outcomes()).toEqual({ count: 0 });
    // A valid owned message still has to work; empty output is not a passing implementation.
    f.setMessageIdentity("weaver", "model");
    f.event({ type: "session.text.started", id: "evt_valid_start", ordinal: 1 });
    f.event({ type: "session.text.delta", id: "evt_valid", ordinal: 1, delta: "verified" });
    await f.worker.recover();
    expect(await f.read()).toMatchObject({ turns: [{ preview: { text: "verified" } }] });
  }
});

test("ended text replaces a fragment even when shorter and canonical empty completion removes preview", async () => {
  const f = await fixture();
  f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
  f.event({ type: "session.text.delta", id: "evt_delta", ordinal: 0, delta: "Long draft" });
  f.event({ type: "session.text.ended", id: "evt_end", ordinal: 0, text: "Hi" });
  await f.worker.recover();
  expect(await f.read()).toMatchObject({ turns: [{ preview: { runId: f.run.runId, messageId: f.messageId, text: "Hi", truncated: false } }] });
  f.event({ type: "session.text.ended", id: "evt_end_empty", ordinal: 0, text: "" });
  expect(await f.read()).toMatchObject({ turns: [{ preview: { runId: f.run.runId, messageId: f.messageId, text: "", truncated: false } }] });
  f.setOutcome("succeeded", ""); await f.worker.recover();
  expect(await f.read()).toMatchObject({ turns: [{ status: "completed", assistant: { text: "" } }] });
  expect(JSON.stringify(await f.read())).not.toContain('"preview"');
  expect(f.outcomes()).toEqual({ count: 1 }); expect(f.prompts).toEqual([f.run]);
});

test("Stop preserves live preview until failure settlement and recreation never persists partial text", async () => {
  const f = await fixture();
  f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
  f.event({ type: "session.text.delta", id: "evt_live", ordinal: 0, delta: "transient only" });
  await f.worker.recover();
  expect(await f.read()).toMatchObject({ turns: [{ preview: { runId: f.run.runId, text: "transient only" } }] });
  const freshApp = createApp({ databasePath: f.databasePath });
  const fresh = await freshApp.request(`/dialogues/${f.dialogue.id}`);
  expect(fresh.status).toBe(200); expect(JSON.stringify(await fresh.json())).not.toContain("transient only");
  const stopped = await f.app.request(`/dialogues/${f.dialogue.id}/turns/${f.turn.id}/stop`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "preview-stop" }, body: JSON.stringify({ expectedRunId: f.run.runId }) });
  expect(stopped.status).toBe(202);
  expect(await f.read()).toMatchObject({ turns: [{ stopRequested: true, preview: { text: "transient only" } }] });
  f.setOutcome("failed", ""); await f.worker.recover();
  const terminal = await f.read();
  expect(terminal).toMatchObject({ turns: [{ status: "failed", assistant: { text: "" } }] });
  expect(JSON.stringify(terminal)).not.toContain('"preview"');
  expect(f.prompts).toEqual([f.run]);
});

test("foreign session and uncorrelated message text cannot enter the owned preview", async () => {
  const f = await fixture();
  f.event({ type: "session.text.started", id: "evt_foreign_start", ordinal: 0, sessionID: "ses_foreign" });
  f.event({ type: "session.text.delta", id: "evt_foreign", ordinal: 0, sessionID: "ses_foreign", delta: "foreign secret" });
  f.event({ type: "session.text.started", id: "evt_unknown_start", ordinal: 0, assistantMessageID: "msg_unowned" });
  f.event({ type: "session.text.delta", id: "evt_unknown", ordinal: 0, assistantMessageID: "msg_unowned", delta: "unowned secret" });
  f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
  f.event({ type: "session.text.delta", id: "evt_good", ordinal: 0, delta: "owned text" });
  await f.worker.recover();
  const view = await f.read();
  expect(view).toMatchObject({ turns: [{ preview: { runId: f.run.runId, messageId: f.messageId, text: "owned text" } }] });
  expect(JSON.stringify(view)).not.toMatch(/foreign secret|unowned secret/);
  expect(f.outcomes()).toEqual({ count: 0 });
});

test("preview subscription is ready before admission, survives inspections and closes with the worker", async () => {
  const f = await fixture();
  expect(f.lifecycle.slice(0, 2)).toEqual(["subscribe", "prompt"]);
  f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
  f.event({ type: "session.text.delta", id: "evt_a", ordinal: 0, delta: "before" });
  await f.worker.recover(); await f.worker.recover();
  f.event({ type: "session.text.delta", id: "evt_b", ordinal: 0, delta: " after" });
  expect(await f.read()).toMatchObject({ turns: [{ preview: { text: "before after" } }] });
  expect(f.lifecycle.filter((entry) => entry === "subscribe")).toHaveLength(1);
  await f.worker.close(); expect(f.lifecycle).toContain("close");
});

test("a stream gap suppresses missed-prefix deltas until an ended repair or newly observed start", async () => {
  const f = await fixture();
  f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
  f.event({ type: "session.text.delta", id: "evt_prefix", ordinal: 0, delta: "prefix" });
  await f.worker.recover();
  expect(await f.read()).toMatchObject({ turns: [{ preview: { text: "prefix" } }] });
  f.gap();
  f.event({ type: "session.text.delta", id: "evt_missed", ordinal: 0, delta: "suffix" });
  expect(JSON.stringify(await f.read())).not.toContain("prefixsuffix");
  f.event({ type: "session.text.ended", id: "evt_repair", ordinal: 0, text: "complete" });
  expect(await f.read()).toMatchObject({ turns: [{ preview: { text: "complete" } }] });
  f.gap(); f.event({ type: "session.text.started", id: "evt_restart", ordinal: 1 });
  f.event({ type: "session.text.delta", id: "evt_new", ordinal: 1, delta: "fresh" });
  expect(await f.read()).toMatchObject({ turns: [{ preview: { text: "fresh" } }] });
  expect(f.outcomes()).toEqual({ count: 0 });
});

test("identity failure clears an owned preview instead of exposing it under another agent", async () => {
  const f = await fixture();
  f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
  f.event({ type: "session.text.delta", id: "evt_text", ordinal: 0, delta: "owned only" });
  await f.worker.recover();
  expect(await f.read()).toMatchObject({ turns: [{ preview: { text: "owned only" } }] });
  f.setAgent("other-agent"); await f.worker.recover();
  expect(JSON.stringify(await f.read())).not.toContain("owned only");
  expect(f.outcomes()).toEqual({ count: 0 }); expect(f.prompts).toEqual([f.run]);
});

test("preview size and age are bounded by controlled limits without durable partials", async () => {
  const f = await fixture({ maxCharacters: 4, maxFragments: 2, maxEventIds: 8, ttlMs: 100 });
  f.event({ type: "session.text.started", id: "evt_start", ordinal: 0 });
  f.event({ type: "session.text.delta", id: "evt_text", ordinal: 0, delta: "ABCDEFG" });
  await f.worker.recover();
  expect(await f.read()).toMatchObject({ turns: [{ preview: { text: "ABCD", truncated: true } }] });
  f.tick(101);
  expect(JSON.stringify(await f.read())).not.toContain('"preview"');
  expect(f.outcomes()).toEqual({ count: 0 }); expect(f.prompts).toEqual([f.run]);
});
