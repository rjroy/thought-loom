import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createDialogueApp } from "../src/dialogue-http";
import { KnowledgeService } from "../src/knowledge";
import { WeavingWorker, type WeavingAdapter, type WeavingRun } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

type Selection = { kind: "item"; id: string; versionId: string };
type Dialogue = { id: string; sourceId: string; selection: Selection };
type Turn = { id: string; sourceId: string; jobId: string; createdAt: string; status: string };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-dialogue-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const captureApp = createApp({ databasePath });
  const capture = async (key: string, text: string) => {
    const response = await captureApp.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text, provenance: "manual" }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; text: string; provenance: string; createdAt: string };
  };
  const source = await capture("dialogue-root", "Original thought about coordination.");
  const background = await capture("dialogue-background", "Another unrelated captured thought.");
  const knowledge = new KnowledgeService(databasePath);
  const item = knowledge.createItem({ actor: "ai", operationId: "fixture-interpretation", runId: "fixture-background-run" }, { kind: "interpretation", sourceId: source.id, text: "Perhaps intent is lost during handoffs.", evidenceSourceIds: [source.id] });
  const selection: Selection = { kind: "item", id: item.id, versionId: item.current.id };
  const dialogueApp = createDialogueApp({ databasePath });
  const create = () => dialogueApp.request(`/sources/${source.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection }) });
  const submit = (id: string, key: string, text: string) => createDialogueApp({ databasePath }).request(`/dialogues/${id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text }) });
  const open = async (): Promise<Dialogue> => {
    const response = await create();
    expect(response.status).toBe(201);
    return await response.json() as Dialogue;
  };
  return { databasePath, captureApp, source, background, item, knowledge, selection, create, submit, open };
}

test("dialogue pins the exact selected source-backed formulation through later revisions and reopen", async () => {
  const { databasePath, source, item, knowledge, selection, open } = await fixture();
  const dialogue = await open();
  expect(dialogue).toMatchObject({ sourceId: source.id, selection });
  knowledge.reviseItem({ actor: "user", operationId: "fixture-correction" }, { itemId: item.id, expectedVersionId: item.current.id, text: "A later correction", evidenceSourceIds: [source.id] });
  const reopened = await createDialogueApp({ databasePath }).request(`/dialogues/${dialogue.id}`);
  expect(reopened.status).toBe(200);
  expect(await reopened.json()).toMatchObject({ id: dialogue.id, sourceId: source.id, selection, selectedContext: { text: item.current.text, author: "ai" }, turns: [] });
});

test("dialogue refuses a nonexistent selected formulation instead of silently choosing latest", async () => {
  const { databasePath, source, item } = await fixture();
  const response = await createDialogueApp({ databasePath }).request(`/sources/${source.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "item", id: item.id, versionId: "missing-version" } }) });
  expect(response.status).toBe(400);
});

test("a turn atomically retains exact user source and one immutable receipt across retries", async () => {
  const { databasePath, captureApp, open, submit } = await fixture();
  const dialogue = await open();
  const text = "  Is this really coordination,\nor preservation of intent?  ";
  const first = await submit(dialogue.id, "turn-key", text);
  expect(first.status).toBe(201);
  const turn = await first.json() as Turn;
  expect(turn.status).toBe("queued");
  expect(Number.isNaN(Date.parse(turn.createdAt))).toBe(false);
  const sourceResponse = await captureApp.request(`/sources/${turn.sourceId}`);
  expect(sourceResponse.status).toBe(200);
  expect(await sourceResponse.json()).toMatchObject({ id: turn.sourceId, text, provenance: "discussion-turn", createdAt: turn.createdAt });
  const retry = await submit(dialogue.id, "turn-key", text);
  expect([200, 201]).toContain(retry.status);
  expect(await retry.json()).toEqual(turn);
  expect((await submit(dialogue.id, "turn-key", "Changed text")).status).toBe(409);
  const reopened = await createDialogueApp({ databasePath }).request(`/dialogues/${dialogue.id}`);
  expect(await reopened.json()).toMatchObject({ turns: [{ id: turn.id, source: { id: turn.sourceId, text }, status: "queued" }] });
});

test("a different turn cannot overlap a pending turn in the same inquiry", async () => {
  const { open, submit } = await fixture();
  const dialogue = await open();
  expect((await submit(dialogue.id, "first-turn", "First challenge")).status).toBe(201);
  expect((await submit(dialogue.id, "second-turn", "Concurrent challenge")).status).toBe(409);
});

test("turn sources do not create capture-weaving jobs or replace the root capture status", async () => {
  const { source, captureApp, open, submit } = await fixture();
  const before = await captureApp.request(`/sources/${source.id}/weaving`);
  expect(before.status).toBe(200);
  const beforeStatus = await before.json() as { job: { id: string; status: string } };
  const dialogue = await open();
  const response = await submit(dialogue.id, "no-recapture", "A retained discussion turn");
  expect(response.status).toBe(201);
  const turn = await response.json() as Turn;
  const after = await captureApp.request(`/sources/${source.id}/weaving`);
  expect(after.status).toBe(200);
  expect(await after.json()).toMatchObject({ job: beforeStatus.job });
  expect((await captureApp.request(`/sources/${turn.sourceId}/weaving`)).status).toBe(404);
});

test("a failed user-source write is not acknowledged and leaves no extra source or job", async () => {
  const { databasePath, open, submit } = await fixture();
  const dialogue = await open();
  const db = new Database(databasePath);
  const counts = () => ({ sources: db.query("SELECT COUNT(*) AS n FROM sources").get(), jobs: db.query("SELECT COUNT(*) AS n FROM jobs").get() });
  try {
    const before = counts();
    db.run(`CREATE TRIGGER fail_dialogue_source BEFORE INSERT ON sources WHEN NEW.text = 'forced write failure'
      BEGIN SELECT RAISE(ABORT, 'private-fixture-error'); END`);
    const response = await submit(dialogue.id, "failed-turn", "forced write failure");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain("private-fixture-error");
    expect(counts()).toEqual(before);
    db.run("DROP TRIGGER fail_dialogue_source");
    expect((await submit(dialogue.id, "failed-turn", "forced write failure")).status).toBe(201);
  } finally { db.close(); }
});

test("pending interactive turn is claimed before queued capture work and saved before native admission", async () => {
  const { databasePath, source, background, selection, open, submit } = await fixture();
  const dialogue = await open();
  const response = await submit(dialogue.id, "priority-turn", "Challenge this interpretation.");
  expect(response.status).toBe(201);
  const turn = await response.json() as Turn;
  const admitted: WeavingRun[] = [];
  const adapter: WeavingAdapter = {
    async prepareSession() {},
    async admit(run) {
      const view = await createDialogueApp({ databasePath }).request(`/dialogues/${dialogue.id}`);
      expect(await view.json()).toMatchObject({ sourceId: source.id, selection, turns: [{ id: turn.id, source: { id: turn.sourceId, text: "Challenge this interpretation." } }] });
      admitted.push(run);
      return { kind: "admitted" };
    },
    async inspect() { return { kind: "pending" }; },
  };
  const worker = new WeavingWorker({ databasePath, adapter });
  const result = await worker.startNext();
  expect(result.kind).toBe("started");
  if (result.kind !== "started") throw new Error("Expected interactive run");
  expect(result.run.jobId).toBe(turn.jobId);
  expect(result.run.sourceId).toBe(source.id);
  expect(admitted).toEqual([result.run]);
  expect((await worker.getJob(background.id))?.status).toBe("queued");
});

test("agent preparation failure never erases or falsely completes the saved user turn", async () => {
  const { databasePath, open, submit, captureApp } = await fixture();
  const dialogue = await open();
  const response = await submit(dialogue.id, "failure-turn", "A preserved question");
  expect(response.status).toBe(201);
  const turn = await response.json() as Turn;
  const adapter: WeavingAdapter = {
    async prepareSession() { throw new Error("fixture service unavailable"); },
    async admit() { throw new Error("Must not admit after failed preparation"); },
    async inspect() { return { kind: "pending" }; },
  };
  await new WeavingWorker({ databasePath, adapter }).startNext();
  const original = await captureApp.request(`/sources/${turn.sourceId}`);
  expect(original.status).toBe(200);
  expect(await original.json()).toMatchObject({ text: "A preserved question", provenance: "discussion-turn" });
  const view = await createDialogueApp({ databasePath }).request(`/dialogues/${dialogue.id}`);
  expect(await view.json()).toMatchObject({ turns: [{ id: turn.id, source: { id: turn.sourceId, text: "A preserved question" } }] });
  const snapshot = await createDialogueApp({ databasePath }).request(`/dialogues/${dialogue.id}`);
  const body = await snapshot.json() as { turns: Array<{ id: string; status: string; assistant?: unknown }> };
  expect(body.turns[0]?.status).not.toBe("completed");
  expect(body.turns[0]?.assistant).toBeUndefined();
});
