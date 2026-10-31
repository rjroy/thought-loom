import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchResult, Source } from "@thoughtloom/contracts";
import { createApp } from "../src/app";
import { KnowledgeService } from "../src/knowledge";
import { rebuildSearchIndex } from "../src/storage";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-retrieval-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const app = createApp({ databasePath: path });
  const capture = async (key: string, text: string): Promise<Source> => {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text, provenance: "manual" }) });
    expect(response.status).toBe(201);
    return await response.json() as Source;
  };
  const search = async (query: string): Promise<SearchResult[]> => {
    const response = await createApp({ databasePath: path }).request(`/search?q=${encodeURIComponent(query)}`);
    expect(response.status).toBe(200);
    return (await response.json() as { results: SearchResult[] }).results;
  };
  return { path, app, capture, search, knowledge: new KnowledgeService(path) };
}

test("search returns source display context without replacing the original", async () => {
  const { capture, search } = await fixture();
  const source = await capture("display", "A lantern illuminates the original thought.");
  const results = await search("lantern");
  expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: source.id, matchOrigin: "source", source: expect.objectContaining({ provenance: source.provenance, createdAt: source.createdAt, excerpt: expect.stringContaining("lantern") }) })]));
});

test("a recorded acronym expands both directions across distinct sources", async () => {
  const { capture, search, knowledge } = await fixture();
  const short = await capture("short", "The SDK simplifies integration.");
  const long = await capture("long", "A software development kit helps builders.");
  const unrelated = await capture("other", "Rain settles on a quiet garden.");
  const alias = knowledge.recordAlias({ actor: "user", operationId: "sdk-alias" }, { alias: "SDK", expansion: "software development kit", evidenceSourceIds: [long.id] });
  expect(alias).toMatchObject({ alias: "SDK", expansion: "software development kit", author: "user", evidenceSourceIds: [long.id] });
  const acronymResults = await search("SDK");
  const expansionResults = await search("software development kit");
  expect(acronymResults).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: short.id }), expect.objectContaining({ sourceId: long.id, matchOrigin: "alias" })]));
  expect(expansionResults).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: long.id }), expect.objectContaining({ sourceId: short.id, matchOrigin: "alias" })]));
  expect(acronymResults.map((result) => result.sourceId)).not.toContain(unrelated.id);
});

test("one typo can retrieve a source without matching an unrelated term", async () => {
  const { capture, search } = await fixture();
  const relevant = await capture("relevant", "A telescope reveals distant stars.");
  const other = await capture("other", "A tomato ripens in the garden.");
  const results = await search("telescoppe");
  expect(results.map((result) => result.sourceId)).toContain(relevant.id);
  expect(results.map((result) => result.sourceId)).not.toContain(other.id);
  expect(await search("xylophonically")).toEqual([]);
});

test("current AI interpretation is searchable through its source even when the original lacks the term", async () => {
  const { capture, search, knowledge } = await fixture();
  const source = await capture("original", "The original mentions a winding river.");
  const item = knowledge.createItem({ actor: "ai", operationId: "interpret", runId: "fixture-run" }, { kind: "interpretation", sourceId: source.id, text: "This suggests resilience under pressure.", evidenceSourceIds: [source.id] });
  const results = await search("resilience");
  expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: source.id, matchOrigin: "interpretation", item: expect.objectContaining({ id: item.id, formulationId: item.current.id, text: item.current.text, author: "ai" }), source: expect.objectContaining({ provenance: source.provenance, createdAt: source.createdAt }) })]));
  knowledge.reviseItem({ actor: "ai", operationId: "revision", runId: "fixture-run" }, { itemId: item.id, expectedVersionId: item.current.id, text: "An evolving adaptation.", evidenceSourceIds: [source.id] });
  expect((await search("resilience")).map((result) => result.sourceId)).not.toContain(source.id);
  expect((await search("adaptation")).map((result) => result.sourceId)).toContain(source.id);
});

test("ambiguous aliases expand retrieval without manufacturing relationships", async () => {
  const { path, capture, search, knowledge } = await fixture();
  const software = await capture("software", "An application programming interface serves clients.");
  const medicine = await capture("medicine", "An active pharmaceutical ingredient has an effect.");
  const shorthand = await capture("shorthand", "API is an ambiguous abbreviation.");
  knowledge.recordAlias({ actor: "user", operationId: "api-software" }, { alias: "API", expansion: "application programming interface", evidenceSourceIds: [software.id] });
  knowledge.recordAlias({ actor: "user", operationId: "api-medicine" }, { alias: "API", expansion: "active pharmaceutical ingredient", evidenceSourceIds: [medicine.id] });
  const results = await search("API");
  expect(results.map((result) => result.sourceId)).toEqual(expect.arrayContaining([software.id, medicine.id, shorthand.id]));
  const db = new Database(path, { readonly: true });
  try { expect(db.query("SELECT id FROM relationships").all()).toEqual([]); } finally { db.close(); }
});

test("rebuilding a discarded projection restores source and interpretation search", async () => {
  const { path, capture, search, knowledge } = await fixture();
  const source = await capture("rebuild", "A compass points north.");
  const item = knowledge.createItem({ actor: "ai", operationId: "annotation", runId: "fixture-run" }, { kind: "interpretation", sourceId: source.id, text: "Orientation can reduce uncertainty.", evidenceSourceIds: [source.id] });
  const db = new Database(path);
  try { db.run("DELETE FROM source_search"); } finally { db.close(); }
  rebuildSearchIndex(path);
  expect((await search("compass")).map((result) => result.sourceId)).toContain(source.id);
  expect(await search("uncertainty")).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: source.id, item: expect.objectContaining({ id: item.id }) })]));
});

test("version 2 database migration preserves original, queued job and idempotent receipt and backfills search", async () => {
  const { path } = await fixture();
  const db = new Database(path);
  const text = "A preserved observatory note.";
  const createdAt = "2025-02-03T04:05:06.000Z";
  const hash = createHash("sha256").update(JSON.stringify([text, "manual"])).digest("hex");
  try {
    db.run("CREATE TABLE sources (id TEXT PRIMARY KEY NOT NULL, text TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.run("CREATE TABLE jobs (id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), status TEXT NOT NULL)");
    db.run("CREATE TABLE capture_receipts (idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id))");
    db.run("INSERT INTO sources VALUES (?,?,?,?)", ["old-source", text, "manual", createdAt]);
    db.run("INSERT INTO jobs VALUES (?,?,?)", ["old-job", "old-source", "queued"]);
    db.run("INSERT INTO capture_receipts VALUES (?,?,?)", ["old-key", hash, "old-source"]);
    db.run("PRAGMA user_version = 2");
  } finally { db.close(); }
  const app = createApp({ databasePath: path });
  const replay = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "old-key" }, body: JSON.stringify({ text, provenance: "manual" }) });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id: "old-source", text, provenance: "manual", createdAt });
  const search = await app.request("/search?q=observatory");
  expect(search.status).toBe(200);
  expect((await search.json() as { results: SearchResult[] }).results).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: "old-source" })]));
  const reopened = new Database(path, { readonly: true });
  try { expect(reopened.query("SELECT id, source_id, status FROM jobs").all()).toEqual([{ id: "old-job", source_id: "old-source", status: "queued" }]); } finally { reopened.close(); }
});
