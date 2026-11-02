import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseThoughtTitle } from "@thoughtloom/contracts";
import { createApp } from "../src/app";
import { KnowledgeService } from "../src/knowledge";
import { openDatabase } from "../src/storage";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-title-test-")); directories.push(directory);
  const databasePath = join(directory, "test.sqlite"), app = createApp({ databasePath });
  const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "title-fixture-capture" }, body: JSON.stringify({ text: "Original fixture text remains unchanged.", provenance: "fixture" }) });
  expect(response.status).toBe(201);
  const source = await response.json() as { id: string; text: string };
  const knowledge = new KnowledgeService(databasePath);
  const item = knowledge.createItem({ actor: "ai", operationId: "title-fixture-item", runId: "fixture-run" }, { kind: "interpretation", sourceId: source.id, text: "An AI fixture reading", evidenceSourceIds: [source.id] });
  return { app, databasePath, source, item, knowledge };
}

type Target = { kind: "source" } | { kind: "item"; itemId: string; versionId: string };
async function edit(f: Awaited<ReturnType<typeof fixture>>, key: string, target: Target, text: string, expectedTitleRevisionId: string | null, extra: object = {}) {
  return f.app.request(`/sources/${f.source.id}/title`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ target, text, expectedTitleRevisionId, ...extra }) });
}
async function saved(response: Response) {
  expect([200, 201]).toContain(response.status);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("revisionId" in body) || typeof body.revisionId !== "string" || !("text" in body) || typeof body.text !== "string") throw new Error("Expected title revision receipt");
  return { ...body, revisionId: body.revisionId, text: body.text };
}

test("source label edit is idempotent and compare-and-swap fenced without changing original or scheduling work", async () => {
  const f = await fixture(), db = new Database(f.databasePath, { readonly: true });
  try {
    const jobs = db.query("SELECT * FROM jobs ORDER BY rowid").all();
    const first = await saved(await edit(f, "title-source-key", { kind: "source" }, "A clear label", null));
    expect(first).toMatchObject({ text: "A clear label", author: "user" });
    expect(await saved(await edit(f, "title-source-key", { kind: "source" }, "A clear label", null))).toEqual(first);
    expect((await edit(f, "title-source-key", { kind: "source" }, "Different label", null)).status).toBe(409);
    await saved(await edit(f, "title-second-key", { kind: "source" }, "New label", first.revisionId));
    expect((await edit(f, "title-stale-key", { kind: "source" }, "Stale edit", first.revisionId)).status).toBe(409);
    expect(db.query("SELECT * FROM jobs ORDER BY rowid").all()).toEqual(jobs);
    expect(await (await f.app.request(`/sources/${f.source.id}`)).json()).toMatchObject({ id: f.source.id, text: f.source.text, title: { text: "New label", author: "user" } });
  } finally { db.close(); }
});

test("item label survives formulation changes without changing thought authorship or creation time", async () => {
  const f = await fixture(), target = { kind: "item" as const, itemId: f.item.id, versionId: f.item.current.id };
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const before = db.query("SELECT created_at FROM knowledge_items WHERE id=?").get(f.item.id);
    await saved(await edit(f, "title-item-key", target, "Orchard lantern", null));
    const revised = f.knowledge.reviseItem({ actor: "ai", operationId: "title-fixture-revision", runId: "fixture-run" }, { itemId: f.item.id, expectedVersionId: f.item.current.id, text: "Later AI reading", evidenceSourceIds: [f.source.id] });
    expect(revised.current.author).toBe("ai");
    expect(db.query("SELECT created_at FROM knowledge_items WHERE id=?").get(f.item.id)).toEqual(before);
    for (const path of ["/springboard/recent?limit=10", "/springboard?recent=10&random=10"]) {
      const response = await f.app.request(path); expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: f.item.id, versionId: revised.current.id, author: "ai", excerpt: revised.current.text, title: expect.objectContaining({ text: "Orchard lantern", author: "user" }) })]) });
    }
    const inquiry = await f.app.request(`/sources/${f.source.id}/inquiry?itemId=${f.item.id}&versionId=${f.item.current.id}`);
    expect(inquiry.status).toBe(200);
    expect(await inquiry.json()).toMatchObject({ selectedTarget: { id: f.item.id, versionId: f.item.current.id, text: f.item.current.text, title: expect.objectContaining({ text: "Orchard lantern", author: "user" }) } });
  } finally { db.close(); }
});

test("title lexical search attributes the matching entity without turning the label into an alias", async () => {
  const f = await fixture();
  await saved(await edit(f, "title-search-key", { kind: "item", itemId: f.item.id, versionId: f.item.current.id }, "Quincunx lantern", null));
  const response = await f.app.request("/search?q=quincunx"); expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("results" in body) || !Array.isArray(body.results)) throw new Error("Expected search results");
  const matching = body.results.filter((entry: { item?: { id?: string } }) => entry.item?.id === f.item.id);
  expect(matching).toHaveLength(1);
  expect(matching[0]).toMatchObject({ sourceId: f.source.id, matchOrigin: "title", item: { id: f.item.id, formulationId: f.item.current.id, author: "ai" } });
});

test("manual title rejects invalid content, forged authority and mismatched item target", async () => {
  const f = await fixture();
  for (const [key, text, extra] of [["empty", "  ", {}], ["multiline", "one\ntwo", {}], ["oversize", "x".repeat(10000), {}], ["actor", "Fine label", { actor: "ai" }]] as const) {
    const response = await edit(f, `invalid-${key}`, { kind: "source" }, text, null, extra);
    expect([400, 403, 413, 422]).toContain(response.status);
  }
  const invalid = await edit(f, "invalid-item", { kind: "item", itemId: f.item.id, versionId: "missing-version" }, "Fine label", null);
  expect([400, 404, 409, 422]).toContain(invalid.status);
  const other = await f.app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "title-other-root" }, body: JSON.stringify({ text: "Another original", provenance: "fixture" }) });
  expect(other.status).toBe(201);
  const otherSource = await other.json() as { id: string };
  const crossRoot = await f.app.request(`/sources/${otherSource.id}/title`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "title-cross-root" }, body: JSON.stringify({ target: { kind: "item", itemId: f.item.id, versionId: f.item.current.id }, text: "Wrong root", expectedTitleRevisionId: null }) });
  expect([400, 404, 409, 422]).toContain(crossRoot.status);
  const read = await f.app.request(`/sources/${f.source.id}/title`); expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ title: null });
});

const invalidUnicodeTitles = [
  ["unpaired high surrogate", "one\uD800two"],
  ["unpaired low surrogate", "one\uDC00two"],
  ["Unicode line separator", "one\u2028two"],
  ["Unicode paragraph separator", "one\u2029two"],
] as const;

for (const [label, text] of invalidUnicodeTitles) {
  test(`TITLE-01 HTTP rejects ${label} without changing durable state`, async () => {
    const f = await fixture(), db = new Database(f.databasePath, { readonly: true });
    try {
      const queries = ["SELECT * FROM sources ORDER BY id", "SELECT * FROM jobs ORDER BY id", "SELECT * FROM title_entities ORDER BY id", "SELECT * FROM title_revisions ORDER BY id", "SELECT * FROM title_heads ORDER BY entity_id", "SELECT * FROM title_receipts ORDER BY idempotency_key", "SELECT * FROM fuzzy_targets ORDER BY target_kind,target_id", "SELECT * FROM fuzzy_fields ORDER BY target_kind,target_id,field_kind", "SELECT * FROM fuzzy_chunks ORDER BY target_kind,target_id,field_kind,ordinal"];
      const before = queries.map((query) => db.query(query).all());
      const response = await edit(f, "title-invalid-unicode", { kind: "source" }, text, null);
      expect(response.status).toBe(400);
      expect(queries.map((query) => db.query(query).all())).toEqual(before);
      const read = await f.app.request(`/sources/${f.source.id}/title`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ headRevisionId: null, title: null });
    } finally { db.close(); }
  });

  test(`TITLE-01 read validator rejects ${label}`, async () => {
    const f = await fixture();
    await saved(await edit(f, "title-validator-fixture", { kind: "source" }, "Valid title", null));
    const response = await f.app.request(`/sources/${f.source.id}/title`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("title" in body)) throw new Error("Missing title in read response");
    const title = parseThoughtTitle(body.title);
    expect(title).not.toBeNull();
    if (!title) throw new Error("Invalid fixture title");
    expect(parseThoughtTitle({ ...title, text })).toBeNull();
  });
}

test("TITLE-01 valid supplementary, accented and CJK text round-trips exactly on read and replay", async () => {
  const f = await fixture(), text = "Café 茶 🌱 𝄞", key = "title-valid-unicode";
  const first = await saved(await edit(f, key, { kind: "source" }, text, null));
  expect(first.text).toBe(text);
  const read = await f.app.request(`/sources/${f.source.id}/title`);
  expect(read.status).toBe(200);
  const body: unknown = await read.json();
  if (typeof body !== "object" || body === null || !("title" in body)) throw new Error("Missing title in read response");
  expect(parseThoughtTitle(body.title)).toEqual({ revisionId: first.revisionId, text, author: "user" });
  expect(await saved(await edit(f, key, { kind: "source" }, text, null))).toEqual(first);
});

test("schema 18 historical data and abandonment audit survive the title migration without backfill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-title-v18-")); directories.push(directory);
  const databasePath = join(directory, "baseline.sqlite"), db = new Database(databasePath, { create: true });
  const schema = await readFile(new URL("../../../tests/fixtures/thoughtloom-schema-v18.sql", import.meta.url), "utf8");
  const projections = ["SELECT * FROM sources", "SELECT * FROM jobs", "SELECT * FROM weaving_runs", "SELECT * FROM owned_grants", "SELECT * FROM native_commands", "SELECT * FROM capture_receipts", "SELECT * FROM knowledge_items", "SELECT * FROM formulations", "SELECT * FROM formulation_evidence", "SELECT * FROM knowledge_receipts", "SELECT * FROM weaving_abandonments", "SELECT * FROM weaving_abandonment_dispatch"];
  let before: unknown[][];
  try {
    db.exec(schema); db.run("PRAGMA foreign_keys=ON");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 18 });
    db.run("INSERT INTO sources(id,text,provenance,created_at) VALUES ('title-v18-source','  Exact original\nbytes  ','fixture','2001-01-01T00:00:00.000Z')");
    db.run("INSERT INTO capture_receipts(idempotency_key,payload_hash,source_id,response_version) VALUES ('capture-v18','hash','title-v18-source',2)");
    db.run("INSERT INTO jobs(id,source_id,status,priority,kind) VALUES ('job-v18','title-v18-source','uncertain',0,'capture')");
    db.run("INSERT INTO weaving_runs(id,job_id,attempt,session_id,prompt_id,state,created_at,updated_at) VALUES ('run-v18','job-v18',1,'ses_v18','msg_v18','uncertain',1,2)");
    db.run("INSERT INTO owned_grants(session_id,run_id,location,agent,source_ids,operations,scope_hash,revoked) VALUES ('ses_v18','run-v18','/fixture','fixture','[\"title-v18-source\"]','[]','grant-hash',1)");
    db.run("INSERT INTO native_commands(run_id,payload,payload_hash,attempted) VALUES ('run-v18','fixture-command','command-hash',1)");
    db.run("INSERT INTO knowledge_items(id,kind,source_id,created_at) VALUES ('item-v18','interpretation','title-v18-source',NULL)");
    db.run("INSERT INTO formulations(id,item_id,text,author,operation_id,run_id) VALUES ('version-v18','item-v18','Original reading','ai','operation-v18','run-v18')");
    db.run("INSERT INTO formulation_evidence(formulation_id,source_id,position) VALUES ('version-v18','title-v18-source',0)");
    db.run("INSERT INTO knowledge_receipts(operation_id,payload_hash,result_id,revision_id) VALUES ('operation-v18','receipt-hash','item-v18','version-v18')");
    db.run("INSERT INTO weaving_abandonments(id,idempotency_key,payload_hash,job_id,run_id,session_id,prompt_id,created_at,acknowledgement) VALUES ('abandon-v18','abandon-key','abandon-hash','job-v18','run-v18','ses_v18','msg_v18',3,'native-may-continue-and-charge')");
    db.run("UPDATE jobs SET status='abandoned' WHERE id='job-v18'");
    db.run("INSERT INTO weaving_abandonment_dispatch(abandonment_id,state) VALUES ('abandon-v18','queued')");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    before = projections.map((sql) => db.query(sql).all());
  } finally { db.close(); }
  const migrated = openDatabase(databasePath);
  try {
    expect(projections.map((sql) => migrated.query(sql).all())).toEqual(before);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.query("SELECT created_at FROM knowledge_items WHERE id='item-v18'").get()).toEqual({ created_at: null });
  } finally { migrated.close(); }
  const response = await createApp({ databasePath }).request("/sources/title-v18-source/title");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ title: null });
  const itemTitle = await createApp({ databasePath }).request("/sources/title-v18-source/title?itemId=item-v18&versionId=version-v18");
  expect(itemTitle.status).toBe(200);
  expect(await itemTitle.json()).toMatchObject({ title: null });
});
