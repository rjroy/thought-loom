import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app";
import { ownedSearchTransport, searchFixture } from "./search-fixture";
import { openDatabase } from "../src/storage";
import { rebuildSearchProjection } from "../src/search-projection";
import { DialogueService } from "../src/dialogue";
import { typoVariants } from "../src/search-query";
import { writeTitle } from "../src/title-write";
import { readTitle } from "../src/title-projection";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(rootText = "Unrelated fixture root for the owned search grant.") {
  const f = await searchFixture(rootText, cleanup);
  const get = (query: string, limit = 50) => f.app.request(`/search?${new URLSearchParams({ q: query, limit: String(limit) })}`);
  const attachTool = async () => {
    const request = await ownedSearchTransport(f, cleanup);
    return (query: string, limit = 50) => request({ query, limit });
  };
  return { ...f, get, attachTool };
}

type Result = { sourceId: string; item?: { id: string; formulationId: string; author: string }; source: { provenance: string }; match: { kind: string; correctedTerms: Array<{ from: string; to: string }> }; passage: { fragments: Array<{ text: string }> } };
async function results(response: Response) {
  expect(response.status).toBe(200);
  return await response.json() as { results: Result[]; searchTruncated: boolean; aliasExpansionTruncated: boolean };
}

test.each([["typoi", "typo"], ["softwsre", "software"], ["develpment", "software"], ["softw", "software"], ["softwsre development kit", "software"], ["my softwsre development kit", "software"], ["DEVELOPMENT software", "software"]] as const)("indexed search %s finds %s across both transports without writes", async (query, label) => {
  const f = await fixture(), software = await f.capture("My useful software development kit for building tools."), typo = await f.capture("A typo can obscure an intended word."), other = await f.capture("A quiet garden after rainfall.");
  const requestTool = await f.attachTool();
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const tables = ["sources", "knowledge_items", "formulations", "relationships", "search_aliases", "tool_reads", "jobs"];
    const snapshot = () => tables.map((name) => db.query(`SELECT * FROM ${name}`).all());
    const before = snapshot();
    const wanted = label === "typo" ? typo : software;
    const get = await f.get(query), tool = await requestTool(query); expect(tool.status).toBe(200);
    const result = await results(get); expect(await tool.json()).toEqual(result);
    const found = result.results.find((entry) => entry.sourceId === wanted.id && !entry.item);
    expect(found).toBeDefined(); expect(found?.source.provenance).toBe(wanted.provenance);
    expect(result.results.some((entry) => entry.sourceId === other.id)).toBe(false);
    expect(snapshot()).toEqual(before);
  } finally { db.close(); }
});

test("FTS-01 ordinary typo survives an alphabetically crowded same-initial vocabulary on GET and tool", async () => {
  // Controlled ordinary words in one source, not 150 synthetic rows or live data.
  const decoys = `table tackle tactics tailor talent talk taller tango tank target task taste teach teacher team teapot tear technical technique telephone television temper temple tenant tennis tent term terrace terrible test texture theater theory therapy thermal thick thief thing think third thirsty thought thread threat three thrive throat throw thumb thunder ticket tide tiger tight timber time timer tiny tired title toast tobacco today together tomato tomorrow tone tongue tonight tool topic torch tornado total touch tourist tower town trace track trade traffic tragedy train transfer travel treasure treat tree trend trial triangle tribe trick trip trophy trouble truck trumpet trust truth tunnel turkey turn turtle tutor twelve twenty twice twist twin twilight typical taboo tablet tailor talentless talking tangible tangled tapestry taxation teacup teardown teaspoon teamwork tedious teenager telephone telescope temperate tenacity tender tension textual thankful theme thickly thickness thirty thorough threshold thrilling thunderstorm tighten timely timetable tinder tissue tolerant tomorrow tornado tortoise towel tractor trailer training transaction transit transmit transparent trapped traveler treasury treatment tremble tribal tribute trilogy tropical trousers trusted`;
  const terms = [...new Set(decoys.split(/\s+/))];
  expect(terms.length).toBeGreaterThan(128);
  expect(terms.every((term) => term.startsWith("t") && term < "typo")).toBe(true);
  const f = await fixture(decoys), target = await f.capture("A typo can obscure an intended word.");
  const requestTool = await f.attachTool();
  const db = new Database(f.databasePath, { readonly: true });
  try {
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM sources").get()?.count).toBe(2);
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM search_vocabulary WHERE term >= 't' AND term < 'typo'").get()?.count).toBeGreaterThan(128);
    const before = ["sources", "knowledge_items", "formulations", "relationships", "search_aliases", "tool_reads", "jobs"].map((name) => db.query(`SELECT * FROM ${name}`).all());
    const get = await f.get("typoi"), tool = await requestTool("typoi");
    expect(get.status).toBe(200); expect(tool.status).toBe(200);
    const actual = await get.json() as { results: Array<{ sourceId: string; match: { kind: string; correctedTerms: Array<{ from: string; to: string }> } }>; searchTruncated: boolean };
    expect(await tool.json()).toEqual(actual);
    expect(typeof actual.searchTruncated).toBe("boolean");
    expect(actual.results.length).toBeLessThanOrEqual(50);
    expect(["sources", "knowledge_items", "formulations", "relationships", "search_aliases", "tool_reads", "jobs"].map((name) => db.query(`SELECT * FROM ${name}`).all())).toEqual(before);
    expect(actual.results.find((entry) => entry.sourceId === target.id)).toMatchObject({ match: { kind: "typo", correctedTerms: [{ from: "typoi", to: "typo" }] } });
    expect(actual.results.some((entry) => entry.sourceId === f.root.id)).toBe(false);
  } finally { db.close(); }
});

test("indexed exact and prefix results precede typo-only results and short misses stay bounded", async () => {
  const f = await fixture(), exact = await f.capture("software"), prefix = await f.capture("softwares"), typo = await f.capture("softwore"), irrelevant = await f.capture("axolotl garden");
  const body = await results(await f.get("software"));
  const ids = body.results.filter((entry) => !entry.item).map((entry) => entry.sourceId);
  expect(ids.indexOf(exact.id)).toBeGreaterThanOrEqual(0); expect(ids.indexOf(prefix.id)).toBeGreaterThanOrEqual(0); expect(ids.indexOf(typo.id)).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf(exact.id)).toBeLessThan(ids.indexOf(typo.id)); expect(ids.indexOf(prefix.id)).toBeLessThan(ids.indexOf(typo.id));
  expect((await results(await f.get("az"))).results.some((entry) => entry.sourceId === irrelevant.id)).toBe(false);
});

test("indexed typo search preserves current item identity and full read", async () => {
  const f = await fixture(), source = await f.capture("Original fixture lacks the sought term.");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "indexed-item", runId: "fixture" }, { kind: "interpretation", sourceId: source.id, text: "Previous version mentions observatory.", evidenceSourceIds: [source.id] });
  const current = f.knowledge.reviseItem({ actor: "user", operationId: "indexed-edit" }, { itemId: item.id, expectedVersionId: item.current.id, text: "Current software development idea.", evidenceSourceIds: [source.id] });
  const body = await results(await f.get("softwsre development"));
  const hit = body.results.find((entry) => entry.item?.id === item.id);
  expect(hit).toMatchObject({ sourceId: source.id, source: { provenance: source.provenance }, item: { id: item.id, formulationId: current.current.id, author: "user" } });
  expect(hit?.passage.fragments.map((fragment) => fragment.text).join(" ").toLowerCase()).toContain("software");
  expect((await results(await f.get("observatory"))).results.some((entry) => entry.item?.id === item.id)).toBe(false);
  const full = await f.app.request(`/sources/${source.id}/inquiry?${new URLSearchParams({ itemId: item.id, versionId: current.current.id })}`);
  expect(full.status).toBe(200); expect(await full.json()).toMatchObject({ source: { text: source.text }, selectedTarget: { id: item.id, versionId: current.current.id, text: current.current.text, author: "user" } });
});

test("indexed queries quote FTS operators without widening the result set", async () => {
  const f = await fixture(), source = await f.capture("software development kit"), unrelated = await f.capture("garden lantern");
  for (const query of ['" OR *', 'software" OR "garden', "NEAR(software, garden)"]) {
    const result = await results(await f.get(query));
    expect(result.results.some((entry) => entry.sourceId === unrelated.id)).toBe(false);
  }
  expect((await results(await f.get("software"))).results.some((entry) => entry.sourceId === source.id)).toBe(true);
  expect((await results(await f.get("software,"))).results.some((entry) => entry.sourceId === source.id)).toBe(true);
});

test("indexed user title follows the current formulation without altering its author or original", async () => {
  const f = await fixture(), source = await f.capture("Original source for a titled thought.");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "fts-title-item", runId: "fixture" }, { kind: "interpretation", sourceId: source.id, text: "Earlier fixture idea.", evidenceSourceIds: [source.id] });
  const edit = await f.app.request(`/sources/${source.id}/title`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "fts-user-title" }, body: JSON.stringify({ target: { kind: "item", itemId: item.id, versionId: item.current.id }, text: "Orchard telescope", expectedTitleRevisionId: null }) });
  expect([200, 201]).toContain(edit.status);
  const revised = f.knowledge.reviseItem({ actor: "ai", operationId: "fts-title-revision", runId: "fixture" }, { itemId: item.id, expectedVersionId: item.current.id, text: "Later fixture idea.", evidenceSourceIds: [source.id] });
  const hit = (await results(await f.get("orchard"))).results.find((entry) => entry.item?.id === item.id);
  expect(hit).toMatchObject({ sourceId: source.id, title: { text: "Orchard telescope", author: "user" }, item: { id: item.id, formulationId: revised.current.id, author: "ai" }, source: { provenance: source.provenance } });
  const full = await f.app.request(`/sources/${source.id}/inquiry?${new URLSearchParams({ itemId: item.id, versionId: revised.current.id })}`);
  expect(full.status).toBe(200);
  expect(await full.json()).toMatchObject({ source: { text: source.text }, selectedTarget: { id: item.id, versionId: revised.current.id, text: revised.current.text, author: "ai", title: { text: "Orchard telescope", author: "user" } } });
});

test("indexed generated title is version-bound, while edited user title remains effective after revision", async () => {
  const f = await fixture(), source = await f.capture("Original source for generated title.");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "fts-generated-item", runId: "fixture" }, { kind: "interpretation", sourceId: source.id, text: "Initial interpretation.", evidenceSourceIds: [source.id] });
  const db = openDatabase(f.databasePath);
  try {
    const generated = db.transaction(() => writeTitle(db, { sourceId: source.id, target: { kind: "item", itemId: item.id, versionId: item.current.id }, author: "ai", text: "Quincunx lantern", key: "fts-ai-title", payloadHash: "fts-ai-title", expectedTitleRevisionId: null })).immediate();
    expect((await results(await f.get("quincunx"))).results.find((entry) => entry.item?.id === item.id)).toMatchObject({ title: { text: "Quincunx lantern", author: "ai" } });
    const revised = f.knowledge.reviseItem({ actor: "ai", operationId: "fts-generated-revision", runId: "fixture" }, { itemId: item.id, expectedVersionId: item.current.id, text: "New interpretation.", evidenceSourceIds: [source.id] });
    expect((await results(await f.get("quincunx"))).results.some((entry) => entry.item?.id === item.id)).toBe(false);
    const user = db.transaction(() => writeTitle(db, { sourceId: source.id, target: { kind: "item", itemId: item.id, versionId: revised.current.id }, author: "user", text: "Orchard lantern", key: "fts-user-override", payloadHash: "fts-user-override", expectedTitleRevisionId: generated.revisionId })).immediate();
    db.transaction(() => writeTitle(db, { sourceId: source.id, target: { kind: "item", itemId: item.id, versionId: revised.current.id }, author: "user", text: "Revised orchard", key: "fts-user-edit", payloadHash: "fts-user-edit", expectedTitleRevisionId: user.revisionId })).immediate();
    const next = f.knowledge.reviseItem({ actor: "ai", operationId: "fts-generated-next", runId: "fixture" }, { itemId: item.id, expectedVersionId: revised.current.id, text: "Another interpretation.", evidenceSourceIds: [source.id] });
    expect((await results(await f.get("orchard"))).results.find((entry) => entry.item?.id === item.id)).toMatchObject({ title: { text: "Revised orchard", author: "user" }, item: { id: item.id, formulationId: next.current.id, author: "ai" } });
    expect((await results(await f.get("lantern"))).results.some((entry) => entry.item?.id === item.id)).toBe(false);
  } finally { db.close(); }
});

test("historical generated title retains its text while the latest head remains the CAS fence", async () => {
  const f = await fixture(), source = await f.capture("Historical title fixture.");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "historical-title-item", runId: "fixture" }, { kind: "interpretation", sourceId: source.id, text: "First reading.", evidenceSourceIds: [source.id] });
  const db = openDatabase(f.databasePath);
  try {
    const first = db.transaction(() => writeTitle(db, { sourceId: source.id, target: { kind: "item", itemId: item.id, versionId: item.current.id }, author: "ai", text: "First label", key: "historical-title-first", payloadHash: "historical-title-first", expectedTitleRevisionId: null })).immediate();
    const revised = f.knowledge.reviseItem({ actor: "ai", operationId: "historical-title-revise", runId: "fixture" }, { itemId: item.id, expectedVersionId: item.current.id, text: "Second reading.", evidenceSourceIds: [source.id] });
    const second = db.transaction(() => writeTitle(db, { sourceId: source.id, target: { kind: "item", itemId: item.id, versionId: revised.current.id }, author: "ai", text: "Second label", key: "historical-title-second", payloadHash: "historical-title-second", expectedTitleRevisionId: first.revisionId })).immediate();
    expect(readTitle(db, source.id, item.id, item.current.id)).toEqual({ headRevisionId: second.revisionId, title: { revisionId: first.revisionId, author: "ai", text: "First label" } });
    expect(readTitle(db, source.id, item.id)).toEqual({ headRevisionId: second.revisionId, title: null });
  } finally { db.close(); }
});

test("indexed fresh database has an FTS5 projection", async () => {
  const f = await fixture(), source = await f.capture("A distinct indexed lantern note.");
  const db = new Database(f.databasePath);
  try {
    const fts = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND lower(sql) LIKE '%using fts5(%'").all();
    expect(fts.length).toBeGreaterThan(0);
  } finally { db.close(); }
  expect((await results(await f.get("lantern"))).results.some((entry) => entry.sourceId === source.id)).toBe(true);
});

test("fixed schema 21 upgrades and backfills current sources, formulations and user titles without losing history", async () => {
  const dir = await mkdtemp("/tmp/opencode/fts-schema21-test-"), databasePath = join(dir, "legacy.sqlite");
  cleanup.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const legacy = new Database(databasePath, { create: true });
  const sourceText = "Preserved software original.", oldText = "Earlier observatory formulation.", currentText = "Current development formulation.", titleText = "User orchard label";
  try {
    legacy.exec(await readFile(new URL("../../../tests/fixtures/thoughtloom-schema-v21.sql", import.meta.url), "utf8"));
    legacy.run("PRAGMA foreign_keys=ON");
    expect(legacy.query("PRAGMA user_version").get()).toEqual({ user_version: 21 });
    legacy.run("INSERT INTO sources VALUES (?,?,?,?)", ["legacy-source", sourceText, "historical fixture", "2001-01-01T00:00:00.000Z"]);
    legacy.run("INSERT INTO capture_receipts(idempotency_key,payload_hash,source_id,response_version) VALUES ('legacy-receipt','fixture-hash','legacy-source',2)");
    legacy.run("INSERT INTO knowledge_items(id,kind,source_id) VALUES ('legacy-item','interpretation','legacy-source')");
    legacy.run("INSERT INTO formulations(id,item_id,text,author,operation_id) VALUES ('legacy-old','legacy-item',?,'ai','legacy-old-op')", [oldText]);
    legacy.run("INSERT INTO formulations(id,item_id,text,author,operation_id) VALUES ('legacy-current','legacy-item',?,'user','legacy-current-op')", [currentText]);
    legacy.run("INSERT INTO formulation_evidence(formulation_id,source_id,position) VALUES ('legacy-old','legacy-source',0),('legacy-current','legacy-source',0)");
    legacy.run("INSERT INTO title_entities(id,item_id) VALUES ('legacy-title-entity','legacy-item')");
    legacy.run("INSERT INTO title_revisions(id,entity_id,text,author,formulation_id,created_at) VALUES ('legacy-title','legacy-title-entity',?,'user','legacy-old','2001-01-01T00:00:00.000Z')", [titleText]);
    legacy.run("INSERT INTO title_heads(entity_id,revision_id,user_revision_id) VALUES ('legacy-title-entity','legacy-title','legacy-title')");
    legacy.run("INSERT INTO fuzzy_projection_state VALUES (1,1)");
    legacy.run("INSERT INTO fuzzy_targets VALUES ('source','legacy-source','legacy-source',NULL,NULL,NULL),('item','legacy-item','legacy-source','legacy-item','legacy-current','legacy-title')");
    for (const [kind, id, field, text] of [["source", "legacy-source", "source-body", sourceText], ["item", "legacy-item", "formulation-body", currentText], ["item", "legacy-item", "title", titleText]]) {
      legacy.run("INSERT INTO fuzzy_fields VALUES (?,?,?,?,1)", [kind, id, field, text.length]);
      legacy.run("INSERT INTO fuzzy_chunks VALUES (?,?,?,0,0,?,?)", [kind, id, field, text.length, text]);
    }
    expect(legacy.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { legacy.close(); }
  const upgraded = openDatabase(databasePath);
  try {
    const version = upgraded.query<{ user_version: number }, []>("PRAGMA user_version").get();
    expect(version?.user_version).toBeGreaterThan(21);
    expect(upgraded.query("SELECT name FROM sqlite_master WHERE type='table' AND lower(sql) LIKE '%using fts5(%'").all().length).toBeGreaterThan(0);
    expect(upgraded.query("SELECT text,provenance FROM sources WHERE id='legacy-source'").get()).toEqual({ text: sourceText, provenance: "historical fixture" });
    expect(upgraded.query("SELECT id,text,author FROM formulations WHERE item_id='legacy-item' ORDER BY rowid").all()).toEqual([{ id: "legacy-old", text: oldText, author: "ai" }, { id: "legacy-current", text: currentText, author: "user" }]);
    expect(upgraded.query("SELECT payload_hash,source_id FROM capture_receipts WHERE idempotency_key='legacy-receipt'").get()).toEqual({ payload_hash: "fixture-hash", source_id: "legacy-source" });
    expect(upgraded.query("SELECT name FROM sqlite_master WHERE name IN ('fuzzy_targets','fuzzy_fields','fuzzy_chunks','fuzzy_projection_state')").all()).toEqual([]);
    expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { upgraded.close(); }
  const app = createApp({ databasePath });
  for (const query of ["software", "development", "orchard"]) expect((await results(await app.request(`/search?${new URLSearchParams({ q: query })}`))).results.some((entry) => entry.sourceId === "legacy-source")).toBe(true);
  expect((await results(await app.request("/search?q=observatory"))).results.some((entry) => entry.item?.id === "legacy-item")).toBe(false);
  const inquiry = await app.request("/sources/legacy-source/inquiry?itemId=legacy-item&versionId=legacy-current");
  expect(inquiry.status).toBe(200); expect(await inquiry.json()).toMatchObject({ selectedTarget: { id: "legacy-item", versionId: "legacy-current", text: currentText, author: "user", title: { text: titleText, author: "user" } } });
});

test("indexed projection failure rolls back the canonical item, receipt and search fields", async () => {
  const f = await fixture(), source = await f.capture("Immutable indexed transaction source.");
  const db = openDatabase(f.databasePath);
  const tables = ["sources", "knowledge_items", "formulations", "formulation_evidence", "knowledge_receipts", "search_fields"];
  const snapshot = () => tables.map((name) => db.query(`SELECT * FROM ${name}`).all());
  try {
    db.exec("CREATE TRIGGER fixture_abort_index BEFORE INSERT ON search_fields WHEN NEW.target_kind='item' BEGIN SELECT RAISE(ABORT,'fixture search failure'); END");
    const before = snapshot();
    expect(() => f.knowledge.createItem({ actor: "ai", operationId: "fts-rollback-item", runId: "fixture" }, { kind: "interpretation", sourceId: source.id, text: "Rollback unique body.", evidenceSourceIds: [source.id] })).toThrow();
    expect(snapshot()).toEqual(before);
    const indexed = db.query("SELECT rowid FROM search_fts WHERE search_fts MATCH 'rollback'").all();
    expect(indexed).toEqual([]);
  } finally { db.close(); }
});

test("indexed alias projection failure rolls back alias and receipt", async () => {
  const f = await fixture(), source = await f.capture("Alias evidence source."), db = openDatabase(f.databasePath);
  try {
    db.exec("CREATE TRIGGER fixture_abort_alias BEFORE INSERT ON search_alias_keys BEGIN SELECT RAISE(ABORT,'fixture alias failure'); END");
    expect(() => f.knowledge.recordAlias({ actor: "user", operationId: "fts-rollback-alias" }, { alias: "SDK", expansion: "software kit", evidenceSourceIds: [source.id] })).toThrow();
    expect(db.query("SELECT id FROM search_aliases WHERE operation_id='fts-rollback-alias'").all()).toEqual([]);
    expect(db.query("SELECT operation_id FROM knowledge_receipts WHERE operation_id='fts-rollback-alias'").all()).toEqual([]);
    expect(db.query("SELECT * FROM search_alias_keys").all()).toEqual([]);
  } finally { db.close(); }
});

test("discussion input and correction/restore update search while preserving exact formulation history", async () => {
  const f = await fixture(), source = await f.capture("Discussion original source.");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "fts-history-initial", runId: "fixture" }, { kind: "interpretation", sourceId: source.id, text: "Initial observatory interpretation", evidenceSourceIds: [source.id] });
  const dialogue = new DialogueService(f.databasePath).create(source.id, { selection: { kind: "source", id: source.id } }, "fts-history-dialogue");
  const turn = new DialogueService(f.databasePath).submit(dialogue.id, "fts-history-turn", { text: "Corrected marina interpretation" });
  expect((await results(await f.get("marina"))).results.some((entry) => entry.sourceId === turn.receipt.sourceId)).toBe(true);
  const corrected = f.knowledge.correctItem({ actor: "user", operationId: "fts-history-correction" }, { itemId: item.id, expectedVersionId: item.current.id, sourceId: turn.receipt.sourceId, text: "Corrected marina interpretation" });
  expect((await results(await f.get("marina"))).results.find((entry) => entry.item?.id === item.id)?.item?.formulationId).toBe(corrected.current.id);
  const restored = f.knowledge.restoreItem({ actor: "user", operationId: "fts-history-restore" }, { itemId: item.id, expectedVersionId: corrected.current.id, restoreVersionId: item.current.id });
  expect((await results(await f.get("observatory"))).results.find((entry) => entry.item?.id === item.id)?.item?.formulationId).toBe(restored.current.id);
  expect((await results(await f.get("marina"))).results.some((entry) => entry.item?.id === item.id)).toBe(false);
  expect(f.knowledge.getItem(item.id).history.map((entry) => entry.text)).toEqual([item.current.text, corrected.current.text, restored.current.text]);
});

test("indexed rebuild restores deleted projections without changing canonical data or receipts", async () => {
  const f = await fixture(), source = await f.capture("Rebuild compass source.");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "fts-rebuild-item", runId: "fixture" }, { kind: "interpretation", sourceId: source.id, text: "Orientation reduces uncertainty.", evidenceSourceIds: [source.id] });
  const db = openDatabase(f.databasePath), tables = ["sources", "knowledge_items", "formulations", "formulation_evidence", "knowledge_receipts", "capture_receipts"];
  const snapshot = () => tables.map((name) => db.query(`SELECT * FROM ${name}`).all());
  try {
    const before = snapshot();
    db.run("DELETE FROM search_fields WHERE source_id=?", [source.id]);
    expect((await results(await f.get("compass"))).results.some((entry) => entry.sourceId === source.id)).toBe(false);
    rebuildSearchProjection(db);
    expect(snapshot()).toEqual(before);
    expect((await results(await f.get("compass"))).results.some((entry) => entry.sourceId === source.id)).toBe(true);
    expect((await results(await f.get("uncertainty"))).results.some((entry) => entry.item?.id === item.id)).toBe(true);
  } finally { db.close(); }
});

test("failed indexed rebuild rolls back the old complete projection and canonical receipts", async () => {
  const f = await fixture(), source = await f.capture("Atomic rebuild lantern source.");
  const db = openDatabase(f.databasePath);
  const tables = ["sources", "knowledge_items", "formulations", "capture_receipts", "knowledge_receipts", "search_fields", "search_alias_keys"];
  const snapshot = () => tables.map((name) => db.query(`SELECT * FROM ${name}`).all());
  try {
    const before = snapshot(), hits = db.query("SELECT rowid FROM search_fts WHERE search_fts MATCH 'lantern'").all();
    expect(hits.length).toBeGreaterThan(0);
    db.exec("CREATE TRIGGER fixture_abort_rebuild BEFORE INSERT ON search_fields BEGIN SELECT RAISE(ABORT,'fixture rebuild failure'); END");
    expect(() => rebuildSearchProjection(db)).toThrow();
    expect(snapshot()).toEqual(before);
    expect(db.query("SELECT rowid FROM search_fts WHERE search_fts MATCH 'lantern'").all()).toEqual(hits);
    expect((await results(await f.get("lantern"))).results.some((entry) => entry.sourceId === source.id)).toBe(true);
  } finally { db.close(); }
});

test("more plausible corrections than the per-term cap report truncation without writes", async () => {
  const f = await fixture();
  const requestTool = await f.attachTool();
  const candidateIds: string[] = [];
  for (const word of ["tast", "tent", "text", "tist", "tost"]) candidateIds.push((await f.capture(word)).id);
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const before = ["sources", "knowledge_items", "formulations", "relationships", "search_aliases", "tool_reads", "jobs"].map((name) => db.query(`SELECT * FROM ${name}`).all());
    const response = await results(await f.get("test"));
    expect(response.searchTruncated).toBe(true);
    expect(response.results).toHaveLength(3);
    expect(response.results.every((entry) => candidateIds.includes(entry.sourceId) && entry.match.kind === "typo" && entry.match.correctedTerms.length === 1 && entry.match.correctedTerms[0].from === "test")).toBe(true);
    const tool = await requestTool("test"); expect(tool.status).toBe(200); expect(await tool.json()).toEqual(response);
    expect(["sources", "knowledge_items", "formulations", "relationships", "search_aliases", "tool_reads", "jobs"].map((name) => db.query(`SELECT * FROM ${name}`).all())).toEqual(before);
  } finally { db.close(); }
});

test("32-character correction routes honor per-term and request probe ceilings", async () => {
  const f = await fixture(), suffix = "bcdefghijklmnopqrstuvwx23456789";
  const requestTool = await f.attachTool();
  const terms = ["a", "b", "c", "d"].map((prefix) => prefix + suffix);
  expect(terms.every((term) => Array.from(term).length === 32)).toBe(true);
  await f.capture(terms.join(" ")); await f.capture(terms.map((term) => `${term}z`).join(" "));
  const db = openDatabase(f.databasePath);
  try {
    let singleChecks = 0;
    const single = typoVariants(db, [terms[0]], () => { singleChecks++; });
    expect(singleChecks).toBe(128); expect(single.truncated).toBe(true);
    let allChecks = 0;
    const all = typoVariants(db, terms, () => { allChecks++; });
    expect(allChecks).toBe(512); expect(all.truncated).toBe(true);
  } finally { db.close(); }
  const query = terms.join(" "), response = await results(await f.get(query));
  expect(response.searchTruncated).toBe(true);
  const tool = await requestTool(query); expect(tool.status).toBe(200); expect(await tool.json()).toEqual(response);
});

test("bounded correction variants report truncation and keep GET/tool results identical", async () => {
  const f = await fixture();
  const requestTool = await f.attachTool();
  for (const word of ["aaab", "aaac", "aaad", "bbba", "bbbc", "bbbd", "ccca", "cccb", "cccd", "ddda", "dddb", "dddc"]) await f.capture(word);
  const db = openDatabase(f.databasePath);
  try {
    const expanded = typoVariants(db, ["aaaa", "bbbb", "cccc", "dddd"], () => {});
    expect(expanded.truncated).toBe(true);
    expect(expanded.variants.length).toBeLessThanOrEqual(16);
    expect(expanded.variants.every((variant) => variant.correctedTerms.length <= 2)).toBe(true);
  } finally { db.close(); }
  const response = await results(await f.get("aaaa bbbb cccc dddd"));
  expect(response.searchTruncated).toBe(true);
  const tool = await requestTool("aaaa bbbb cccc dddd"); expect(tool.status).toBe(200); expect(await tool.json()).toEqual(response);
});

test("bounded recorded alias expansion reports truncation without mutating alias evidence", async () => {
  const f = await fixture(), evidence = await f.capture("Fixture alias evidence.");
  const requestTool = await f.attachTool();
  for (let n = 0; n < 9; n++) {
    await f.capture(`orchard${n}`);
    f.knowledge.recordAlias({ actor: "user", operationId: `fts-bounded-alias-${n}` }, { alias: "ZXQ", expansion: `orchard${n}`, evidenceSourceIds: [evidence.id] });
  }
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const before = db.query("SELECT * FROM alias_evidence ORDER BY alias_id,position").all();
    const response = await results(await f.get("zxq"));
    expect(response.aliasExpansionTruncated).toBe(true);
    expect(response.results.length).toBeLessThanOrEqual(8);
    expect(db.query("SELECT * FROM alias_evidence ORDER BY alias_id,position").all()).toEqual(before);
    const tool = await requestTool("zxq"); expect(tool.status).toBe(200); expect(await tool.json()).toEqual(response);
  } finally { db.close(); }
});

test.each([19, 20])("fixed schema %i upgrades while preserving canonical history, receipts and user title", async (version) => {
  const dir = await mkdtemp("/tmp/opencode/fts-historical-test-"), databasePath = join(dir, "historical.sqlite");
  cleanup.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const db = new Database(databasePath, { create: true });
  try {
    for (const file of ["thoughtloom-schema-v18.sql", "title-schema-v19.sql", ...(version === 20 ? ["fuzzy-schema-v20.sql"] : [])]) db.exec(await readFile(new URL(`../../../tests/fixtures/${file}`, import.meta.url), "utf8"));
    db.run("PRAGMA foreign_keys=ON");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: version });
    db.run("INSERT INTO sources(id,text,provenance,created_at) VALUES ('historic-source','Preserved lantern original','fixture','2001-01-01T00:00:00.000Z')");
    db.run("INSERT INTO capture_receipts(idempotency_key,payload_hash,source_id,response_version) VALUES ('historic-receipt','fixture-hash','historic-source',2)");
    db.run("INSERT INTO knowledge_items(id,kind,source_id) VALUES ('historic-item','interpretation','historic-source')");
    db.run("INSERT INTO formulations(id,item_id,text,author,operation_id) VALUES ('historic-old','historic-item','Old observatory text','ai','historic-old-op'),('historic-current','historic-item','Current compass idea','user','historic-current-op')");
    db.run("INSERT INTO formulation_evidence(formulation_id,source_id,position) VALUES ('historic-old','historic-source',0),('historic-current','historic-source',0)");
    db.run("INSERT INTO title_entities(id,item_id) VALUES ('historic-entity','historic-item')");
    db.run("INSERT INTO title_revisions(id,entity_id,text,author,formulation_id,created_at) VALUES ('historic-title','historic-entity','Orchard title','user','historic-old','2001-01-01T00:00:00.000Z')");
    db.run("INSERT INTO title_heads VALUES ('historic-entity','historic-title','historic-title')");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
  const upgraded = openDatabase(databasePath);
  try {
    expect(upgraded.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThan(21);
    expect(upgraded.query("SELECT id,text,author FROM formulations ORDER BY rowid").all()).toEqual([{ id: "historic-old", text: "Old observatory text", author: "ai" }, { id: "historic-current", text: "Current compass idea", author: "user" }]);
    expect(upgraded.query("SELECT payload_hash,source_id FROM capture_receipts WHERE idempotency_key='historic-receipt'").get()).toEqual({ payload_hash: "fixture-hash", source_id: "historic-source" });
    expect(upgraded.query("SELECT name FROM sqlite_master WHERE name IN ('source_search','source_vocabulary','formulation_search','formulation_vocabulary','title_search','title_vocabulary','alias_lookup','expansion_lookup')").all()).toEqual([]);
    expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { upgraded.close(); }
  const app = createApp({ databasePath });
  for (const query of ["lantern", "compass", "orchard"]) expect((await results(await app.request(`/search?q=${query}`))).results.some((entry) => entry.sourceId === "historic-source")).toBe(true);
  expect((await results(await app.request("/search?q=observatory"))).results.some((entry) => entry.item?.id === "historic-item")).toBe(false);
});
