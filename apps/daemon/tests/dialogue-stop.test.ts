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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-dialogue-stop-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const setupApp = createApp({ databasePath });
  const capture = await setupApp.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "stop-root" }, body: JSON.stringify({ text: "An original question.", provenance: "manual" }) });
  expect(capture.status).toBe(201);
  const root = await capture.json() as { id: string; text: string };
  const created = await setupApp.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: root.id } }) });
  expect(created.status).toBe(201);
  const dialogue = await created.json() as { id: string };
  const submitted = await setupApp.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "stop-turn" }, body: JSON.stringify({ text: "  Retain this user input.\n" }) });
  expect(submitted.status).toBe(201);
  const turn = await submitted.json() as { id: string; sourceId: string; jobId: string };
  const calls: string[] = [], prompts: WeavingRun[] = [];
  const sessions = new Map<string, NativeSession>();
  let observed: "pending" | "succeeded" | "interrupted" = "pending";
  let uncertain = false;
  const client: NativeClientPort = {
    async discover() { return { url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }; },
    async identity() { return { version: "2.2.2", pid: 42 }; },
    async createSession(run) {
      const session: NativeSession = { id: run.sessionId, ownerRunId: run.runId, location: "/fixture/location", agent: "weaver", model: { providerID: "fixture", id: "model", variant: "default" }, permissionActions: ["deny:*:*", "allow:record_idea"] };
      sessions.set(run.sessionId, session); return session;
    },
    async getSession(id) { const session = sessions.get(id); if (!session) throw new Error("Unknown fixture session"); return session; },
    async prompt(run) { prompts.push(run); if (uncertain) throw new Error("fixture timeout"); return { promptId: run.promptId }; },
    async cancelUndelivered(sessionId, promptId) { calls.push(`cancel:${sessionId}:${promptId}`); },
    async interrupt(sessionId, options) { calls.push(`interrupt:${sessionId}:${String(options.resume)}`); },
    async activity() { return { active: observed === "pending", outcome: observed === "pending" ? null : observed }; },
    async history(sessionId) {
      const run = prompts.find((entry) => entry.sessionId === sessionId);
      if (!run) throw new Error("Unknown fixture prompt");
      const state = observed === "succeeded" ? "completed" : observed;
      return { messages: [{ id: run.promptId, type: "user", state: "completed" }, { id: "msg_fixture_partial", type: "assistant", state, text: observed === "interrupted" ? "Partial user-visible answer" : "Completed answer" }] };
    },
  };
  const adapter = new NativeWeavingAdapter({ client, databasePath, registrationFile: "/fixture/registration", location: "/fixture/location", agent: "weaver", model: { providerID: "fixture", id: "model" }, dialogueOperations: ["record_idea"] });
  const worker = new WeavingWorker({ databasePath, adapter });
  const app = createApp({ databasePath, weavingWorker: worker, weavingConfigured: true, weavingStatus: () => "working" });
  const stop = (key: string, expectedRunId: string | null) => app.request(`/dialogues/${dialogue.id}/turns/${turn.id}/stop`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ expectedRunId }) });
  const view = async () => await (await app.request(`/dialogues/${dialogue.id}`)).json() as { turns: Array<{ id: string; status: string; stopRequested?: boolean; assistant?: { text: string }; changes: Array<{ id: string }> }> };
  return { databasePath, app, root, dialogue, turn, worker, calls, prompts, stop, view, setOutcome(value: typeof observed) { observed = value; }, setUncertain() { uncertain = true; } };
}

test("queued Stop retains the source and prevents its native admission", async () => {
  const { app, turn, stop, view, worker, prompts } = await fixture();
  const response = await stop("queued-stop", null);
  expect(response.status).toBe(202);
  const state = await view();
  expect(state.turns[0]).toMatchObject({ id: turn.id, status: "interrupted", source: { id: turn.sourceId, text: "  Retain this user input.\n" } });
  const next = await worker.startNext();
  if (next.kind === "started") expect(next.run.jobId).not.toBe(turn.jobId);
  expect(prompts.every((run) => run.jobId !== turn.jobId)).toBe(true);
  expect(await (await app.request(`/sources/${turn.sourceId}`)).json()).toMatchObject({ text: "  Retain this user input.\n" });
});

test("admitted Stop is idempotent and fenced, requests cancellation before interrupt, and retains partial text and changes", async () => {
  const { databasePath, root, dialogue, turn, worker, calls, prompts, stop, view, setOutcome } = await fixture();
  const started = await worker.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected dialogue run");
  const tools = createToolApp({ databasePath, transportCredential: "fixture-only-credential", location: "/fixture/location" });
  const idea = await tools.request("/internal/tools/record-idea", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-only-credential" }, body: JSON.stringify({ native: { sessionID: started.run.sessionId, agent: "weaver", messageID: "msg_fixture_tool", callID: "call_fixture_idea" }, input: { rootSourceId: root.id, turnSourceId: turn.sourceId, dialogueId: dialogue.id, turnId: turn.id, text: "A durable idea", evidenceSourceIds: [root.id, turn.sourceId] } }) });
  expect(idea.status).toBe(200);
  const ideaResult = await idea.json() as { id: string };
  const first = await stop("stop-command", started.run.runId);
  expect(first.status).toBe(202);
  const receipt = await first.json();
  const replay = await stop("stop-command", started.run.runId);
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(receipt);
  expect((await stop("stop-stale", "run-stale")).status).toBe(409);
  expect(calls).toEqual([`cancel:${started.run.sessionId}:${started.run.promptId}`, `interrupt:${started.run.sessionId}:false`]);
  expect((await view()).turns[0]).toMatchObject({ id: turn.id, status: "running", stopRequested: true, actions: { stop: { eligible: false, expectedRunId: started.run.runId } } });
  setOutcome("interrupted");
  await worker.recover();
  const interrupted = (await view()).turns[0];
  expect(interrupted).toMatchObject({ id: turn.id, status: "interrupted", assistant: { text: "Partial user-visible answer" }, changes: [expect.objectContaining({ id: ideaResult.id })] });
  const db = new Database(databasePath, { readonly: true });
  try { expect(db.query("SELECT revoked FROM owned_grants WHERE session_id=?").get(started.run.sessionId)).toEqual({ revoked: 1 }); } finally { db.close(); }
  await worker.recover();
  expect(prompts).toEqual([started.run]);
});

test("completion can win a requested Stop and is not misreported as interrupted", async () => {
  const { worker, stop, setOutcome, view, prompts } = await fixture();
  const started = await worker.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected dialogue run");
  expect((await stop("race-stop", started.run.runId)).status).toBe(202);
  setOutcome("succeeded");
  await worker.recover();
  expect((await view()).turns[0]).toMatchObject({ status: "completed", assistant: { text: "Completed answer" } });
  expect(prompts).toEqual([started.run]);
});

test("uncertain admission plus Stop remains uncertain and never resubmits", async () => {
  const { worker, stop, setUncertain, view, prompts } = await fixture();
  setUncertain();
  const started = await worker.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected dialogue run");
  expect((await stop("uncertain-stop", started.run.runId)).status).toBe(202);
  await worker.recover();
  expect((await view()).turns[0]).toMatchObject({ status: "uncertain", stopRequested: true });
  expect(prompts).toEqual([started.run]);
});
