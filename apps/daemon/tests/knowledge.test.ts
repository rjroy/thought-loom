import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KnowledgeError, KnowledgeService, type KnowledgeContext } from "../src/knowledge";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const ai = (operationId: string): KnowledgeContext => ({ actor: "ai", operationId, runId: "test-run" });
const user = (operationId: string): KnowledgeContext => ({ actor: "user", operationId });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-knowledge-"));
  directories.push(directory);
  const databasePath = join(directory, "thoughtloom.sqlite");
  const app = createApp({ databasePath });
  const capture = async (key: string, text: string) => {
    const response = await app.request("/captures", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ text, provenance: "manual" }),
    });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; text: string; createdAt: string; provenance: string };
  };
  const source = await capture("original", "Original thought, exactly as written.");
  const evidence = await capture("evidence", "Another source of evidence.");
  return { databasePath, app, source, evidence, service: new KnowledgeService(databasePath) };
}

function expectCode(operation: () => unknown, code: KnowledgeError["code"]) {
  let caught: unknown;
  try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(KnowledgeError);
  if (caught instanceof KnowledgeError) expect(caught.code).toBe(code);
}

test("interpretations and developing ideas have distinct source-backed identities, authorship and real evidence", async () => {
  const { databasePath, source, evidence, service, app } = await fixture();
  const interpretation = service.createItem(ai("interpret"), { kind: "interpretation", sourceId: source.id, text: "An interpretation", evidenceSourceIds: [evidence.id] });
  const idea = service.createItem(user("develop"), { kind: "developing-idea", sourceId: source.id, text: "A developed idea", evidenceSourceIds: [source.id] });
  expect(new Set([source.id, interpretation.id, idea.id]).size).toBe(3);
  expect(new KnowledgeService(databasePath).getItem(interpretation.id)).toMatchObject({
    kind: "interpretation", sourceId: source.id, current: { text: "An interpretation", author: "ai", operationId: "interpret", evidenceSourceIds: [evidence.id] },
  });
  expect(idea.current.author).toBe("user");
  expect(await (await app.request(`/sources/${source.id}`)).json()).toEqual(source);
  expectCode(() => service.createItem(ai("bad-evidence"), { kind: "interpretation", sourceId: source.id, text: "Unsupported", evidenceSourceIds: ["missing-source"] }), "invalid_reference");
  expectCode(() => service.createItem(ai("bad-source"), { kind: "interpretation", sourceId: "missing-source", text: "Orphan", evidenceSourceIds: [evidence.id] }), "invalid_reference");
});

test("original source content cannot be updated, even through direct SQL", async () => {
  const { databasePath, source, app } = await fixture();
  const db = new Database(databasePath);
  try {
    expect(() => db.run("UPDATE sources SET text = ? WHERE id = ?", ["rewritten", source.id])).toThrow();
  } finally { db.close(); }
  expect(await (await app.request(`/sources/${source.id}`)).json()).toEqual(source);
});

test("AI revisions require current version, cannot overwrite user corrections, and user restore appends history", async () => {
  const { source, service } = await fixture();
  const first = service.createItem(ai("create"), { kind: "interpretation", sourceId: source.id, text: "First", evidenceSourceIds: [source.id] });
  const second = service.reviseItem(ai("revise"), { itemId: first.id, expectedVersionId: first.current.id, text: "Second", evidenceSourceIds: [source.id] });
  expectCode(() => service.reviseItem(ai("stale"), { itemId: first.id, expectedVersionId: first.current.id, text: "Stale", evidenceSourceIds: [source.id] }), "version_conflict");
  const corrected = service.reviseItem(user("correct"), { itemId: first.id, expectedVersionId: second.current.id, text: "User correction", evidenceSourceIds: [source.id] });
  expectCode(() => service.reviseItem(ai("overwrite"), { itemId: first.id, expectedVersionId: corrected.current.id, text: "Overwrite", evidenceSourceIds: [source.id] }), "forbidden");
  const restored = service.restoreItem(user("restore"), { itemId: first.id, expectedVersionId: corrected.current.id, restoreVersionId: first.current.id });
  expect(restored.current).toMatchObject({ text: "First", author: "user", operationId: "restore" });
  expect(restored.current.id).not.toBe(first.current.id);
  expect(restored.history.map((version) => version.id)).toEqual([first.current.id, second.current.id, corrected.current.id, restored.current.id]);
});

test("directed relationships require real distinct endpoints and evidence", async () => {
  const { source, evidence, service } = await fixture();
  const a = service.createItem(ai("item-a"), { kind: "interpretation", sourceId: source.id, text: "A", evidenceSourceIds: [source.id] });
  const b = service.createItem(ai("item-b"), { kind: "developing-idea", sourceId: evidence.id, text: "B", evidenceSourceIds: [evidence.id] });
  const input = { fromItemId: a.id, toItemId: b.id, type: "suggests" as const, rationale: "Shared implication", evidenceSourceIds: [evidence.id] };
  const relationship = service.createRelationship(ai("link"), input);
  expect(service.getRelationship(relationship.id)).toMatchObject({ fromItemId: a.id, toItemId: b.id, type: "suggests", current: { status: "active", rationale: input.rationale, evidenceSourceIds: [evidence.id], author: "ai", operationId: "link" } });
  expectCode(() => service.createRelationship(ai("missing-end"), { ...input, toItemId: "missing" }), "invalid_reference");
  expectCode(() => service.createRelationship(ai("self"), { ...input, toItemId: a.id }), "invalid_reference");
  expectCode(() => service.createRelationship(ai("missing-evidence"), { ...input, evidenceSourceIds: ["missing"] }), "invalid_reference");
});

test("user rejection cannot be reactivated by AI; restoration creates an attributed revision", async () => {
  const { source, evidence, service } = await fixture();
  const a = service.createItem(ai("a"), { kind: "interpretation", sourceId: source.id, text: "A", evidenceSourceIds: [source.id] });
  const b = service.createItem(ai("b"), { kind: "interpretation", sourceId: evidence.id, text: "B", evidenceSourceIds: [evidence.id] });
  const first = service.createRelationship(ai("connect"), { fromItemId: a.id, toItemId: b.id, type: "challenges", rationale: "Tension", evidenceSourceIds: [source.id] });
  const rejected = service.reviseRelationship(user("reject"), { relationshipId: first.id, expectedVersionId: first.current.id, status: "rejected", rationale: "Not convincing", evidenceSourceIds: [source.id] });
  expectCode(() => service.reviseRelationship(ai("reactivate"), { relationshipId: first.id, expectedVersionId: rejected.current.id, status: "active", rationale: "Tension", evidenceSourceIds: [source.id] }), "forbidden");
  const restored = service.restoreRelationship(user("restore-link"), { relationshipId: first.id, expectedVersionId: rejected.current.id, restoreVersionId: first.current.id });
  expect(restored.current).toMatchObject({ status: "active", rationale: "Tension", author: "user", operationId: "restore-link" });
  expect(restored.current.id).not.toBe(first.current.id);
  expect(restored.history.map((version) => version.id)).toEqual([first.current.id, rejected.current.id, restored.current.id]);
});

test("AI cannot recreate a rejected directed claim under a fresh operation ID", async () => {
  const { databasePath, source, evidence, service } = await fixture();
  const a = service.createItem(ai("recreate-a"), { kind: "interpretation", sourceId: source.id, text: "First idea", evidenceSourceIds: [source.id] });
  const b = service.createItem(ai("recreate-b"), { kind: "interpretation", sourceId: evidence.id, text: "Second idea", evidenceSourceIds: [evidence.id] });
  const claim = { fromItemId: a.id, toItemId: b.id, type: "challenges" as const, rationale: "Initial rationale", evidenceSourceIds: [source.id] };
  const first = service.createRelationship(ai("recreate-original"), claim);
  const rejected = service.reviseRelationship(user("recreate-reject"), {
    relationshipId: first.id, expectedVersionId: first.current.id, status: "rejected",
    rationale: "The claim is not supported", evidenceSourceIds: [source.id],
  });

  expectCode(() => service.createRelationship(ai("recreate-same"), claim), "forbidden");
  expectCode(() => service.createRelationship(ai("recreate-different-evidence"), {
    ...claim, rationale: "A different explanation", evidenceSourceIds: [evidence.id],
  }), "forbidden");
  expect(new KnowledgeService(databasePath).getRelationship(first.id)).toEqual(rejected);

  const db = new Database(databasePath, { readonly: true });
  try {
    expect(db.query("SELECT id FROM relationships WHERE from_item_id = ? AND to_item_id = ? AND type = ?").all(a.id, b.id, claim.type)).toEqual([{ id: first.id }]);
  } finally { db.close(); }

  const reverse = service.createRelationship(ai("recreate-reverse"), { ...claim, fromItemId: b.id, toItemId: a.id });
  const differentType = service.createRelationship(ai("recreate-other-type"), { ...claim, type: "supports" });
  expect(reverse.current.status).toBe("active");
  expect(differentType.current.status).toBe("active");
});

test("knowledge operation receipts replay immutable create and revision results, and reject changed payloads", async () => {
  const { databasePath, source, service } = await fixture();
  const create = { kind: "interpretation" as const, sourceId: source.id, text: "Initial idea", evidenceSourceIds: [source.id] };
  const first = service.createItem(ai("dedupe-create"), create);
  const reopened = new KnowledgeService(databasePath);
  expect(reopened.createItem(ai("dedupe-create"), create)).toEqual(first);
  expectCode(() => reopened.createItem(ai("dedupe-create"), { ...create, text: "Changed" }), "operation_conflict");
  const revision = { itemId: first.id, expectedVersionId: first.current.id, text: "A revision", evidenceSourceIds: [source.id] };
  const revised = reopened.reviseItem(ai("dedupe-revise"), revision);
  expect(new KnowledgeService(databasePath).reviseItem(ai("dedupe-revise"), revision)).toEqual(revised);
  expectCode(() => reopened.reviseItem(ai("dedupe-revise"), { ...revision, text: "A different revision" }), "operation_conflict");
  expect(reopened.getItem(first.id).history.map((entry) => entry.id)).toEqual([first.current.id, revised.current.id]);
});

test("a user correction retains its independently captured original as explicit evidence", async () => {
  const { app, source, service } = await fixture();
  const correctionText = "  My correction, exactly as written.\n";
  const capture = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "correction" }, body: JSON.stringify({ text: correctionText, provenance: "manual" }) });
  expect(capture.status).toBe(201);
  const correction = await capture.json() as { id: string; text: string; provenance: string; createdAt: string };
  const item = service.createItem(ai("initial"), { kind: "interpretation", sourceId: source.id, text: "Original interpretation", evidenceSourceIds: [source.id] });
  const revised = service.reviseItem(user("user-correction"), { itemId: item.id, expectedVersionId: item.current.id, text: "Revised formulation", evidenceSourceIds: [correction.id] });
  expect(revised.current).toMatchObject({ author: "user", evidenceSourceIds: [correction.id] });
  expect(await (await app.request(`/sources/${correction.id}`)).json()).toEqual(correction);
  expect(correction.text).toBe(correctionText);
});
