import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { dialoguePrompt } from "../src/dialogue-data";
import { openDatabase } from "../src/storage";
import { WeavingWorker, type WeavingAdapter } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-dialogue-history-")); directories.push(directory);
  const databasePath = join(directory, "test.sqlite"), app = createApp({ databasePath });
  const capture = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "history-root" }, body: JSON.stringify({ text: "Original selected source", provenance: "manual" }) });
  expect(capture.status).toBe(201);
  const root = await capture.json() as { id: string; text: string };
  const created = await app.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: root.id } }) });
  expect(created.status).toBe(201);
  const dialogue = await created.json() as { id: string };
  const send = async (key: string, text: string) => {
    const response = await app.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; jobId: string };
  };
  const complete = async (text: string, messageId: string) => {
    const adapter: WeavingAdapter = { async prepareSession() {}, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "completed", recordedChanges: 0, assistant: { messageId, text } }; } };
    const worker = new WeavingWorker({ databasePath, adapter });
    expect((await worker.startNext()).kind).toBe("started");
    await worker.recover();
  };
  return { databasePath, app, root, dialogue, send, complete };
}

test("prompt preserves full current input and selected original while bounding whole prior turns", async () => {
  const { databasePath, root, send, complete } = await fixture();
  await send("earliest", "EARLIEST_FULL_USER_TURN"); await complete("EARLIEST_FULL_ANSWER", "msg_history_1");
  await send("newest", "NEWEST_FULL_USER_TURN"); await complete("NEWEST_FULL_ANSWER", "msg_history_2");
  const current = "  EXACT_CURRENT_USER_INPUT\nwith newline  ";
  const turn = await send("current", current);
  const db = openDatabase(databasePath);
  try {
    const prompt = dialoguePrompt(db, turn.jobId, { pastTurns: 1, pastCharacters: 1000 });
    expect(prompt).not.toBeNull();
    expect(prompt?.text).toContain(root.text);
    expect(prompt?.text).toContain(current);
    expect(prompt?.text).toContain("NEWEST_FULL_USER_TURN");
    expect(prompt?.text).toContain("NEWEST_FULL_ANSWER");
    expect(prompt?.text).not.toContain("EARLIEST_FULL_USER_TURN");
    expect(prompt?.text).not.toContain("EARLIEST_FULL_ANSWER");
    expect(prompt?.text).toContain("truncated: true");
  } finally { db.close(); }
});

test("a large canonical assistant response remains intact in durable readable dialogue", async () => {
  const { app, dialogue, send, complete } = await fixture();
  const turn = await send("long-response", "A question needing an extended response");
  const text = `begin-${"x".repeat(85_123)}-end`;
  await complete(text, "msg_history_large");
  const response = await app.request(`/dialogues/${dialogue.id}`);
  expect(response.status).toBe(200);
  const view = await response.json() as { turns: Array<{ id: string; assistant?: { text: string } }> };
  expect(view.turns.find((entry) => entry.id === turn.id)?.assistant?.text).toBe(text);
});
