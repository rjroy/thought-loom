import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInquiryView, parseRecentThoughts } from "@thoughtloom/contracts";
import { createApp } from "../src/app";
import { DialogueService } from "../src/dialogue";
import { KnowledgeService } from "../src/knowledge";
import { openDatabase } from "../src/storage";
import { refreshItemSearch, refreshSourceSearch } from "../src/search-projection";
import { WeavingWorker } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function entries(value: unknown): Record<string, unknown>[] {
  if (!record(value) || !Array.isArray(value.items) || !value.items.every(record)) throw new Error("Invalid combined springboard fixture response");
  return value.items;
}
async function fixture(populate = true) {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-random-")); directories.push(directory);
  const databasePath = join(directory, "test.sqlite"), app = createApp({ databasePath });
  if (!populate) return { databasePath, app };
  const db = openDatabase(databasePath);
  try {
    db.transaction(() => {
      for (const [id, text, date] of [["old-source", "Original old source", "2001-01-01T00:00:00.000Z"], ["new-source", "Original later source", "2002-01-01T00:00:00.000Z"]]) {
        db.run("INSERT INTO sources(id,text,provenance,created_at) VALUES (?,?,?,?)", [id, text, "fixture", date]);
        refreshSourceSearch(db, id);
      }
      // This deliberately reconstructed legacy item has no known created_at.
      db.run("INSERT INTO knowledge_items(id,kind,source_id) VALUES ('legacy-item','interpretation','old-source')");
      db.run("INSERT INTO formulations(id,item_id,text,author,operation_id) VALUES ('legacy-formulation','legacy-item','Unknown-date legacy reading','ai','legacy-op')");
      db.run("INSERT INTO formulation_evidence(formulation_id,source_id,position) VALUES ('legacy-formulation','old-source',0)");
      refreshItemSearch(db, "legacy-item");
    }).immediate();
  } finally { db.close(); }
  const knowledge = new KnowledgeService(databasePath), clock = spyOn(Date, "now");
  try {
    clock.mockReturnValue(Date.parse("2030-01-01T00:00:00.000Z"));
    const initial = knowledge.createItem({ actor: "ai", operationId: "fixture-create-reading", runId: "fixture-seed" },
      { kind: "interpretation", sourceId: "old-source", text: "AI initial reading", evidenceSourceIds: ["old-source"] });
    const corrected = knowledge.reviseItem({ actor: "user", operationId: "fixture-user-reading" },
      { itemId: initial.id, expectedVersionId: initial.current.id, text: "User corrected reading", evidenceSourceIds: ["old-source"] });
    const dialogues = new DialogueService(databasePath), dialogue = dialogues.create("old-source", { selection: { kind: "source", id: "old-source" } }, "fixture-dialogue");
    const turn = dialogues.submit(dialogue.id, "fixture-turn", { text: "Raw discussion input, not a standalone card" }).receipt;
    const worker = new WeavingWorker({ databasePath, adapter: { async prepareSession() {}, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; } } });
    try {
      const started = await worker.startNext();
      if (started.kind !== "started" || started.run.jobId !== turn.jobId) throw new Error("Expected owned fixture dialogue run");
      clock.mockReturnValue(Date.parse("2031-01-01T00:00:00.000Z"));
      const idea = knowledge.recordIdea({ actor: "ai", operationId: "fixture-create-idea", runId: started.run.runId },
        { rootSourceId: "old-source", turnSourceId: turn.sourceId, dialogueId: dialogue.id, turnId: turn.id, text: "Developing fixture idea", evidenceSourceIds: ["old-source", turn.sourceId] });
      return { databasePath, app, corrected, idea, turn };
    } finally { await worker.close(); }
  } finally { clock.mockRestore(); }
}

test("combined batch preserves recent order, selects disjoint random entities and includes unknown-date legacy items", async () => {
  const f = await fixture(); if (!f.corrected || !f.idea || !f.turn) throw new Error("Missing populated fixture");
  const response = await f.app.request("/springboard?recent=2&random=3"); expect(response.status).toBe(200);
  const items = entries(await response.json()); expect(items).toHaveLength(5);
  expect(items.slice(0, 2)).toEqual([
    expect.objectContaining({ selection: "recent", id: f.idea.id, sourceId: "old-source", kind: "developing-idea", versionId: f.idea.current.id, author: "ai", excerpt: "Developing fixture idea", createdAt: "2031-01-01T00:00:00.000Z" }),
    expect.objectContaining({ selection: "recent", id: f.corrected.id, sourceId: "old-source", kind: "interpretation", versionId: f.corrected.current.id, author: "user", excerpt: "User corrected reading", createdAt: "2030-01-01T00:00:00.000Z" }),
  ]);
  const random = items.slice(2);
  expect(random.every((entry) => entry.selection === "random")).toBe(true);
  expect(random).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "old-source", sourceId: "old-source", kind: "source", author: "user" }),
    expect.objectContaining({ id: "new-source", sourceId: "new-source", kind: "source", author: "user" }),
    expect.objectContaining({ id: "legacy-item", sourceId: "old-source", kind: "interpretation", versionId: "legacy-formulation", author: "ai", createdAt: null }),
  ]));
  expect(new Set(items.map((entry) => `${entry.kind === "source" ? "source" : "item"}:${entry.id}`)).size).toBe(items.length);
  expect(items.some((entry) => entry.id === f.turn?.sourceId)).toBe(false);
  // Multiple distinct representations of one root are intentional, not duplicates.
  expect(items.filter((entry) => entry.sourceId === "old-source")).toHaveLength(4);
  const inquiry = await f.app.request(`/sources/old-source/inquiry?itemId=${f.corrected.id}&versionId=${f.corrected.current.id}`);
  expect(parseInquiryView(await inquiry.json())?.selectedTarget).toMatchObject({ id: f.corrected.id, versionId: f.corrected.current.id, author: "user" });
});

test("default batch has two ordered recent and at most two distinct random cards without assuming random luck", async () => {
  const f = await fixture(); if (!f.corrected || !f.idea || !f.turn) throw new Error("Missing populated fixture");
  const response = await f.app.request("/springboard"); expect(response.status).toBe(200);
  const items = entries(await response.json()); expect(items).toHaveLength(4);
  expect(items.slice(0, 2).map((entry) => [entry.selection, entry.id])).toEqual([["recent", f.idea.id], ["recent", f.corrected.id]]);
  const random = items.slice(2); expect(random.every((entry) => entry.selection === "random")).toBe(true);
  expect(random.every((entry) => ["old-source", "new-source", "legacy-item"].includes(String(entry.id)))).toBe(true);
  expect(new Set(items.map((entry) => `${entry.kind === "source" ? "source" : "item"}:${entry.id}`)).size).toBe(4);
  const recentResponse = await f.app.request("/springboard/recent?limit=2"); expect(recentResponse.status).toBe(200);
  const oldRoute = parseRecentThoughts(await recentResponse.json());
  expect(oldRoute?.items.map((entry) => entry.id)).toEqual([f.idea.id, f.corrected.id]);
});

test("empty and scarce collections return fewer cards without duplicates", async () => {
  const f = await fixture(false);
  const empty = await f.app.request("/springboard?recent=2&random=2"); expect(empty.status).toBe(200); expect(entries(await empty.json())).toEqual([]);
  const saved = await f.app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "single-fixture" }, body: JSON.stringify({ text: "Only controlled original", provenance: "fixture" }) });
  expect(saved.status).toBe(201); const source = await saved.json() as { id: string };
  const one = await f.app.request("/springboard?recent=2&random=2"); expect(one.status).toBe(200);
  expect(entries(await one.json())).toEqual([expect.objectContaining({ selection: "recent", kind: "source", id: source.id })]);
});

test("combined batch rejects malformed or unbounded requested bucket limits", async () => {
  const f = await fixture(false);
  for (const query of ["recent=-1&random=2", "recent=2&random=1.5", "recent=999999&random=2", "recent=2&random=999999", "recent=2&recent=3&random=2", "recent=abc&random=2"]) {
    const response = await f.app.request(`/springboard?${query}`); expect(response.status, query).toBe(400);
  }
});

test("combined batch stays behind the existing hostile-host guard", async () => {
  const f = await fixture(false);
  const response = await f.app.request("http://127.0.0.1/springboard", { headers: { host: "attacker.example" } });
  expect(response.status).toBe(403); expect(await response.text()).not.toContain("Original old source");
});
