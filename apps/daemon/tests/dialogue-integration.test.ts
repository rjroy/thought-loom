import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import type { OpenCodeClient } from "@opencode/client";
import { createApp } from "../src/app";
import { KnowledgeService } from "../src/knowledge";
import { NativeWeavingAdapter, createMaintainedClient, type MaintainedClientHooks, type NativeClientPort, type NativeSession } from "../src/native-adapter";
import { createToolApp, OwnedGrants } from "../src/tool-boundary";
import { WeavingWorker, type WeavingAdapter, type WeavingRun } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-dialogue-integration-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const app = createApp({ databasePath });
  const capture = async (key: string, text: string) => {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text, provenance: "manual" }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; text: string; createdAt: string; provenance: string };
  };
  const root = await capture("root", "Handoffs might distort an original request.");
  const other = await capture("other", "Explicit contracts preserve intent.");
  const knowledge = new KnowledgeService(databasePath);
  const item = knowledge.createItem({ actor: "ai", operationId: "root-item", runId: "fixture-weave" }, { kind: "interpretation", sourceId: root.id, text: "Coordination alone may not preserve intent.", evidenceSourceIds: [root.id] });
  const neighbor = knowledge.createItem({ actor: "user", operationId: "other-item" }, { kind: "developing-idea", sourceId: other.id, text: "Contracts hold meaning.", evidenceSourceIds: [other.id] });
  const relationship = knowledge.createRelationship({ actor: "ai", operationId: "fixture-link", runId: "fixture-weave" }, { fromItemId: item.id, toItemId: neighbor.id, type: "suggests", rationale: "Both address handoff fidelity.", evidenceSourceIds: [root.id, other.id] });
  const itemSelection = { kind: "item", id: item.id, versionId: item.current.id };
  const create = (selection: object, key?: string) => app.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify({ selection }) });
  const open = async () => { const response = await create(itemSelection); expect(response.status).toBe(201); return await response.json() as { id: string }; };
  const send = (id: string, key: string, text: string) => app.request(`/dialogues/${id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text }) });
  return { directory, databasePath, app, root, other, item, neighbor, relationship, knowledge, itemSelection, create, open, send };
}

test("an original with no AI annotations can be selected directly as dialogue context", async () => {
  const { app } = await fixture();
  const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "plain" }, body: JSON.stringify({ text: "An unannotated original", provenance: "manual" }) });
  expect(response.status).toBe(201);
  const source = await response.json() as { id: string; text: string };
  const created = await app.request(`/sources/${source.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: source.id } }) });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ sourceId: source.id, selection: { kind: "source", id: source.id }, selectedContext: { text: source.text } });
});

test("relationship target pins directed rationale and both endpoint versions across later revisions", async () => {
  const { databasePath, app, root, item, neighbor, relationship, knowledge, create } = await fixture();
  const selection = { kind: "relationship", id: relationship.id, versionId: relationship.current.id, fromVersionId: item.current.id, toVersionId: neighbor.current.id };
  const response = await create(selection);
  expect(response.status).toBe(201);
  const dialogue = await response.json() as { id: string };
  knowledge.reviseRelationship({ actor: "user", operationId: "reject-later" }, { relationshipId: relationship.id, expectedVersionId: relationship.current.id, status: "rejected", rationale: "Not convincing", evidenceSourceIds: [root.id] });
  const read = await createApp({ databasePath }).request(`/dialogues/${dialogue.id}`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ selection, selectedContext: { rationale: relationship.current.rationale, status: "active", fromItemId: item.id, toItemId: neighbor.id } });
  expect((await app.request(`/sources/${root.id}`)).status).toBe(200);
});

test("optional dialogue creation idempotency key replays the same identity and conflicts on changed context", async () => {
  const { create, itemSelection, root } = await fixture();
  const first = await create(itemSelection, "create-dialogue-key");
  expect(first.status).toBe(201);
  const saved = await first.json();
  const replay = await create(itemSelection, "create-dialogue-key");
  expect([200, 201]).toContain(replay.status);
  expect(await replay.json()).toEqual(saved);
  expect((await create({ kind: "source", id: root.id }, "create-dialogue-key")).status).toBe(409);
});

test("two separately opened dialogues cannot admit overlapping turns on the same root", async () => {
  const { open, send } = await fixture();
  const first = await open(), second = await open();
  expect(first.id).not.toBe(second.id);
  expect((await send(first.id, "turn-one", "First challenge")).status).toBe(201);
  expect((await send(second.id, "turn-two", "Second challenge")).status).toBe(409);
});

test("user rejection and restoration append attributed versions and reject model-supplied actor fields", async () => {
  const { app, root, relationship, knowledge } = await fixture();
  const post = (action: "reject" | "restore", key: string, body: object) => app.request(`/relationships/${relationship.id}/${action}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
  const reject = { expectedVersionId: relationship.current.id, rationale: "The evidence does not support this", evidenceSourceIds: [root.id] };
  expect((await post("reject", "forged-user-action", { ...reject, actor: "ai" })).status).toBe(400);
  const first = await post("reject", "reject-claim", reject);
  expect(first.status).toBe(200);
  const rejected = await first.json() as { current: { id: string } };
  expect(rejected).toMatchObject({ current: { status: "rejected", author: "user" } });
  expect(await (await post("reject", "reject-claim", reject)).json()).toEqual(rejected);
  expect((await post("reject", "reject-claim", { ...reject, rationale: "Changed" })).status).toBe(409);
  const restore = await post("restore", "restore-claim", { expectedVersionId: rejected.current.id, restoreVersionId: relationship.current.id });
  expect(restore.status).toBe(200);
  const restored = await restore.json() as { current: { id: string }; history: Array<{ id: string }> };
  expect(restored).toMatchObject({ current: { status: "active", author: "user" } });
  expect(restored.history.map((revision) => revision.id)).toEqual([relationship.current.id, rejected.current.id, restored.current.id]);
  expect(knowledge.getRelationship(relationship.id).history.map((revision) => revision.id)).toEqual(restored.history.map((revision) => revision.id));
});

test("discussion source read and search expose structured origin linking its actual dialogue and turn", async () => {
  const { app, root, open, send } = await fixture();
  const dialogue = await open();
  const response = await send(dialogue.id, "origin-turn", "Can intent survive a zirconium handoff?");
  expect(response.status).toBe(201);
  const turn = await response.json() as { id: string; sourceId: string };
  const origin = { kind: "discussion-turn", dialogueId: dialogue.id, turnId: turn.id, rootSourceId: root.id };
  const read = await app.request(`/sources/${turn.sourceId}`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ id: turn.sourceId, origin });
  const search = await app.request("/search?q=zirconium");
  expect(search.status).toBe(200);
  expect((await search.json() as { results: unknown[] }).results).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: turn.sourceId, source: expect.objectContaining({ origin }) })]));
});

test("background grant cannot use dialogue-only idea authority", async () => {
  const { databasePath, root } = await fixture();
  const adapter: WeavingAdapter = {
    async prepareSession(run) { new OwnedGrants(databasePath).bind({ run, location: "/fixture/thoughtloom", agent: "weaver", sourceIds: [root.id], operations: ["record_interpretation"] }); },
    async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; },
  };
  const started = await new WeavingWorker({ databasePath, adapter }).startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected background run");
  const tools = createToolApp({ databasePath, transportCredential: "fixture-only-credential", location: "/fixture/thoughtloom" });
  const response = await tools.request("/internal/tools/record-idea", { method: "POST", headers: { authorization: "Bearer fixture-only-credential", "content-type": "application/json" }, body: JSON.stringify({ native: { sessionID: started.run.sessionId, agent: "weaver", messageID: "msg_fixture", callID: "call_fixture" }, input: { rootSourceId: root.id, text: "Developed idea", evidenceSourceIds: [root.id] } }) });
  expect(response.status).toBe(403);
});

test("a dialogue-scoped tool records a developing idea with original and turn derivation once", async () => {
  const { databasePath, app, root, item, open, send } = await fixture();
  const dialogue = await open();
  const response = await send(dialogue.id, "idea-turn", "Preserve intent explicitly.");
  expect(response.status).toBe(201);
  const turn = await response.json() as { id: string; sourceId: string; jobId: string };
  const adapter: WeavingAdapter = {
    async prepareSession(run) { new OwnedGrants(databasePath).bind({ run, location: "/fixture/thoughtloom", agent: "weaver", sourceIds: [root.id, turn.sourceId], operations: ["record_idea"] }); },
    async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; },
  };
  const started = await new WeavingWorker({ databasePath, adapter }).startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected dialogue run");
  expect(started.run.jobId).toBe(turn.jobId);
  const tools = createToolApp({ databasePath, transportCredential: "fixture-only-credential", location: "/fixture/thoughtloom" });
  const native = { sessionID: started.run.sessionId, agent: "weaver", messageID: "msg_fixture_idea", callID: "call_fixture_idea" };
  const input = { rootSourceId: root.id, turnSourceId: turn.sourceId, dialogueId: dialogue.id, turnId: turn.id, text: "An explicit intent-preservation contract", evidenceSourceIds: [root.id, turn.sourceId], derivedFrom: { itemId: item.id, versionId: item.current.id } };
  const post = (body: object) => tools.request("/internal/tools/record-idea", { method: "POST", headers: { authorization: "Bearer fixture-only-credential", "content-type": "application/json" }, body: JSON.stringify({ native, input: body }) });
  const first = await post(input);
  expect(first.status).toBe(200);
  const saved = await first.json();
  expect(saved).toMatchObject({ kind: "developing-idea", sourceId: root.id, current: { text: input.text, author: "ai", evidenceSourceIds: input.evidenceSourceIds }, derivation: { dialogueId: dialogue.id, turnId: turn.id, turnSourceId: turn.sourceId, itemId: item.id, versionId: item.current.id } });
  expect(await (await post(input)).json()).toEqual(saved);
  expect((await post({ ...input, text: "Different payload" })).status).toBe(409);
  const search = await app.request("/search?q=intent-preservation");
  expect((await search.json() as { results: unknown[] }).results).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: root.id, item: expect.objectContaining({ text: input.text }) })]));
  const view = await app.request(`/dialogues/${dialogue.id}`);
  expect(await view.json()).toMatchObject({ turns: [{ id: turn.id, changes: [expect.objectContaining({ kind: "developing-idea" })] }] });
});

test("canonical and empty assistant text survive daemon recreation without a second prompt", async () => {
 for (const canonicalText of ["The intended meaning, not just coordination.", ""]) {
  const { databasePath, open, send } = await fixture();
  const dialogue = await open();
  const response = await send(dialogue.id, "canonical-turn", "What is being preserved?");
  expect(response.status).toBe(201);
  const turn = await response.json() as { id: string; jobId: string };
  const sessions = new Map<string, NativeSession>();
  const prompts: WeavingRun[] = [];
  const client: NativeClientPort = {
    async discover() { return { url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }; },
    async identity() { return { version: "2.2.2", pid: 42 }; },
    async createSession(run) {
      const session: NativeSession = { id: run.sessionId, ownerRunId: run.runId, location: "/fixture/thoughtloom", agent: "weaver", model: { providerID: "fixture", id: "model", variant: "default" }, permissionActions: ["deny:*:*", "allow:record_interpretation"] };
      sessions.set(run.sessionId, session);
      return session;
    },
    async getSession(id) { const session = sessions.get(id); if (!session) throw new Error("Unknown fixture session"); return session; },
    async prompt(run) { prompts.push(run); return { promptId: run.promptId }; },
    async activity() { return { active: false, outcome: "succeeded" }; },
    async history(sessionId) {
      const run = prompts.find((entry) => entry.sessionId === sessionId);
      if (!run) throw new Error("Unknown fixture prompt");
      return { messages: [{ id: run.promptId, type: "user", state: "completed" }, { id: "msg_fixture_answer", type: "assistant", state: "completed", text: canonicalText }] };
    },
  };
  const options = { client, databasePath, registrationFile: "/fixture/registration.json", location: "/fixture/thoughtloom", agent: "weaver", model: { providerID: "fixture", id: "model" } };
  const worker = new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter(options) });
  const started = await worker.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected dialogue run");
  expect(started.run.jobId).toBe(turn.jobId);
  await new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter(options) }).recover();
  const read = await createApp({ databasePath }).request(`/dialogues/${dialogue.id}`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ turns: [{ id: turn.id, status: "completed", assistant: { text: canonicalText }, changes: [] }] });
  await new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter(options) }).recover();
  expect(prompts).toEqual([started.run]);
  const secondResponse = await send(dialogue.id, "next-turn", "What follows from that?");
  expect(secondResponse.status).toBe(201);
  const secondTurn = await secondResponse.json() as { jobId: string };
  const second = await new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter(options) }).startNext();
  expect(second.kind).toBe("started");
  if (second.kind !== "started") throw new Error("Expected second dialogue run");
  expect(second.run.jobId).toBe(secondTurn.jobId);
  expect(second.run.sessionId).not.toBe(started.run.sessionId);
  expect(second.run.runId).not.toBe(started.run.runId);
 }
});

test("real maintained-client mapping receives persisted selected context and exact user turn before prompt", async () => {
  const { databasePath, directory, app, root, item, knowledge, open, send } = await fixture();
  const dialogue = await open();
  const response = await send(dialogue.id, "prompt-turn", "Challenge this claim, please.");
  expect(response.status).toBe(201);
  const turn = await response.json() as { id: string; jobId: string; sourceId: string };
  knowledge.reviseItem({ actor: "user", operationId: "later-revision" }, { itemId: item.id, expectedVersionId: item.current.id, text: "Later revision must not replace selected snapshot.", evidenceSourceIds: [root.id] });
  const registrationFile = join(directory, "registration.json");
  await writeFile(registrationFile, JSON.stringify({ url: "http://127.0.0.1:4321", version: "2.2.2", pid: 42, password: "fixture-only" }), { mode: 0o600 });
  let created: Record<string, unknown> | undefined;
  let nativePrompt: { sessionID: string; id: string; text: string } | undefined;
  const sdk = {
    server: { async info() { return { version: "2.2.2", pid: 42 }; } },
    plugin: { async list() { return { data: [{ id: "thoughtloom", state: { status: "active" } }] }; } },
    session: {
      async create(input: Record<string, unknown>) { created = input; return input; },
      async get() { if (!created) throw new Error("Missing fixture session"); return created; },
      async prompt(input: { sessionID: string; id: string; text: string }) { nativePrompt = input; return { id: input.id, sessionID: input.sessionID, payload: { text: input.text } }; },
    },
  } as unknown as OpenCodeClient;
  const hooks: MaintainedClientHooks = {
    async discover() { return { url: "http://127.0.0.1:4321", auth: { type: "basic", username: "fixture", password: "fixture-only" } }; },
    headers: Service.headers, make() { return sdk; },
  };
  const options = { databasePath, registrationFile, location: directory, agent: "weaver", model: { providerID: "fixture", id: "model" }, operations: ["record_interpretation" as const] };
  const client = createMaintainedClient(options, hooks);
  const worker = new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter({ ...options, client }) });
  const started = await worker.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected dialogue admission");
  expect(started.run.jobId).toBe(turn.jobId);
  expect(nativePrompt).toMatchObject({ sessionID: started.run.sessionId, id: started.run.promptId });
  expect(nativePrompt?.text).toContain(root.text);
  expect(nativePrompt?.text).toContain(item.current.text);
  expect(nativePrompt?.text).toContain("Challenge this claim, please.");
  expect(nativePrompt?.text).not.toContain("Later revision must not replace selected snapshot.");
  expect((await app.request(`/sources/${turn.sourceId}`)).status).toBe(200);
});
