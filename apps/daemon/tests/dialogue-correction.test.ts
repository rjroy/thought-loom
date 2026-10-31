import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KnowledgeError, KnowledgeService } from "../src/knowledge";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("user correction and restore are version-fenced idempotent revisions with retained turn evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-correction-")); directories.push(directory);
  const databasePath = join(directory, "test.sqlite"), app = createApp({ databasePath });
  const captured = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "correction-root" }, body: JSON.stringify({ text: "Original source", provenance: "manual" }) });
  expect(captured.status).toBe(201);
  const root = await captured.json() as { id: string; text: string };
  const service = new KnowledgeService(databasePath);
  const item = service.createItem({ actor: "ai", operationId: "interpret", runId: "fixture-run" }, { kind: "interpretation", sourceId: root.id, text: "AI formulation", evidenceSourceIds: [root.id] });
  const created = await app.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "item", id: item.id, versionId: item.current.id } }) });
  expect(created.status).toBe(201);
  const dialogue = await created.json() as { id: string };
  const text = "  My exact correction.\n";
  const submitted = await app.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "correction-turn" }, body: JSON.stringify({ text }) });
  expect(submitted.status).toBe(201);
  const turn = await submitted.json() as { sourceId: string };
  const post = (action: "correct" | "restore", key: string, body: object) => app.request(`/items/${item.id}/${action}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
  const correction = { expectedVersionId: item.current.id, text, sourceId: turn.sourceId };
  expect((await post("correct", "spoof-actor", { ...correction, actor: "ai" })).status).toBe(400);
  const first = await post("correct", "user-correction", correction);
  expect(first.status).toBe(200);
  const corrected = await first.json() as { current: { id: string }; history: Array<{ id: string }> };
  expect(corrected).toMatchObject({ current: { text, author: "user", evidenceSourceIds: [turn.sourceId] } });
  expect(await (await post("correct", "user-correction", correction)).json()).toEqual(corrected);
  expect((await post("correct", "user-correction", { ...correction, text: "different" })).status).toBe(409);
  expect((await post("correct", "stale", correction)).status).toBe(409);
  const restoredResponse = await post("restore", "user-restore", { expectedVersionId: corrected.current.id, restoreVersionId: item.current.id });
  expect(restoredResponse.status).toBe(200);
  const restored = await restoredResponse.json() as { current: { id: string }; history: Array<{ id: string }> };
  expect(restored).toMatchObject({ current: { text: "AI formulation", author: "user" } });
  expect(restored.history.map((version) => version.id)).toEqual([item.current.id, corrected.current.id, restored.current.id]);
  let denial: unknown;
  try { service.reviseItem({ actor: "ai", operationId: "background-overwrite", runId: "fixture-run" }, { itemId: item.id, expectedVersionId: restored.current.id, text: "Overwrite", evidenceSourceIds: [root.id] }); } catch (error) { denial = error; }
  expect(denial).toBeInstanceOf(KnowledgeError);
  if (denial instanceof KnowledgeError) expect(denial.code).toBe("forbidden");
  expect(await (await app.request(`/sources/${turn.sourceId}`)).json()).toMatchObject({ id: turn.sourceId, text });
  expect(await (await app.request(`/sources/${root.id}`)).json()).toMatchObject(root);
});
