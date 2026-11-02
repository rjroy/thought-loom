import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseSearchResponse } from "@thoughtloom/contracts";
import { createApp } from "../src/app";
import { KnowledgeService } from "../src/knowledge";
import { createToolApp, OwnedGrants } from "../src/tool-boundary";
import { WeavingWorker, type WeavingRun } from "../src/weaving";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const dir = await mkdtemp("/tmp/opencode/search-contract-test-"), databasePath = join(dir, "fixture.sqlite"), app = createApp({ databasePath });
  let n = 0;
  async function capture(text: string) {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `search-capture-${++n}` }, body: JSON.stringify({ text, provenance: "controlled fixture" }) });
    expect(response.status).toBe(201); return await response.json() as { id: string; text: string };
  }
  const root = await capture("Fixture owned root without matching terms.");
  let enter = (_run: WeavingRun) => {}, release = () => {};
  const entered = new Promise<WeavingRun>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  const worker = new WeavingWorker({ databasePath, adapter: { async prepareSession(run) { enter(run); await gate; }, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; } } });
  const done = worker.startNext();
  cleanup.push(async () => { release(); await done; await worker.close(); await rm(dir, { recursive: true, force: true }); });
  const run = await Promise.race([entered, done.then(() => { throw new Error("Owned fixture run did not enter preparation"); })]);
  new OwnedGrants(databasePath).bind({ run, location: "/fixture/search", agent: "fixture-search", sourceIds: [root.id], operations: ["search"] });
  release(); expect((await done).kind).toBe("started");
  const tools = createToolApp({ databasePath, transportCredential: "fixture-search-credential", location: "/fixture/search" });
  const native = { sessionID: run.sessionId, agent: "fixture-search", messageID: "msg_fixture_search", callID: "call_fixture_search" };
  const tool = (input: unknown) => tools.request("/internal/tools/search", { method: "POST", headers: { authorization: "Bearer fixture-search-credential", "content-type": "application/json" }, body: JSON.stringify({ action: "search", native, input }) });
  const get = (query: string, extra = "") => app.request(`/search?q=${encodeURIComponent(query)}${extra}`);
  return { databasePath, root, capture, knowledge: new KnowledgeService(databasePath), get, tool };
}

const wireResult = {
  sourceId: "fixture-source", matchOrigin: "source", source: { excerpt: "typo", provenance: "fixture", createdAt: "2001-01-01T00:00:00.000Z", origin: { kind: "capture" } },
  match: { kind: "typo", field: "source-body", fieldRevisionId: "fixture-source", correctedTerms: [{ from: "typoi", to: "typo" }] },
  passage: { fragments: [{ text: "typo", highlights: [{ start: 0, end: 4 }] }], leadingEllipsis: false, trailingEllipsis: false, omitted: false },
};
const wire = { engineVersion: 2, results: [wireResult], hasMore: false, searchTruncated: false, aliasExpansionTruncated: false };

test("v2 parser requires version and bounded-search metadata", () => {
  expect(parseSearchResponse(wire)).not.toBeNull();
  expect(parseSearchResponse({ ...wire, engineVersion: 1 })).toBeNull();
  expect(parseSearchResponse({ ...wire, searchTruncated: undefined })).toBeNull();
  expect(parseSearchResponse({ ...wire, hasMore: "false" })).toBeNull();
});

test("v2 parser checks snippet bounds, grapheme edges, corrections and immutable identities", () => {
  const withResult = (result: object) => ({ ...wire, results: [result] });
  const preview = (fragment: object) => ({ ...wireResult, passage: { ...wireResult.passage, fragments: [fragment] } });
  expect(parseSearchResponse(withResult(preview({ text: "typo", highlights: [{ start: 0, end: 5 }] })))).toBeNull();
  expect(parseSearchResponse(withResult(preview({ text: "🌱", highlights: [{ start: 0, end: 1 }] })))).toBeNull();
  expect(parseSearchResponse(withResult({ ...wireResult, match: { ...wireResult.match, correctedTerms: [] } }))).toBeNull();
  const item = { ...wireResult, matchOrigin: "interpretation", item: { id: "fixture-item", kind: "interpretation", formulationId: "fixture-version", author: "ai" }, title: { revisionId: "fixture-title", text: "Label", author: "user" }, match: { kind: "exact", field: "formulation-body", fieldRevisionId: "fixture-version", correctedTerms: [] } };
  expect(parseSearchResponse(withResult(item))).not.toBeNull();
  expect(parseSearchResponse(withResult({ ...item, match: { ...item.match, fieldRevisionId: "wrong-version" } }))).toBeNull();
  expect(parseSearchResponse(withResult({ ...item, title: { ...item.title, author: "unknown" } }))).toBeNull();
});

test("v2 alias results require attribution and evidence", () => {
  const hit = { ...wireResult, matchOrigin: "alias", match: { kind: "alias", field: "source-body", fieldRevisionId: "fixture-source", correctedTerms: [] } };
  const alias = { id: "fixture-alias", alias: "SDK", expansion: "software kit", author: "user", evidenceSourceIds: ["fixture-source"], direction: "alias-to-expansion", expandedQuery: "software kit" };
  expect(parseSearchResponse({ ...wire, results: [hit] })).toBeNull();
  expect(parseSearchResponse({ ...wire, results: [{ ...hit, alias }] })).not.toBeNull();
  expect(parseSearchResponse({ ...wire, results: [{ ...hit, alias: { ...alias, evidenceSourceIds: [] } }] })).toBeNull();
});

test("search GET and owned tool share tokenized results without making read witnesses or domain writes", async () => {
  const f = await fixture(), source = await f.capture("software development kit"), item = f.knowledge.createItem({ actor: "ai", operationId: "contract-item", runId: "fixture" }, { kind: "interpretation", sourceId: source.id, text: "software development kit", evidenceSourceIds: [source.id] });
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const queries = ["SELECT * FROM tool_reads", "SELECT * FROM sources", "SELECT * FROM knowledge_items", "SELECT * FROM formulations", "SELECT * FROM relationships", "SELECT * FROM search_aliases", "SELECT * FROM jobs"];
    const before = queries.map((sql) => db.query(sql).all());
    const response = await f.get("softwsre development kit", "&limit=50"), tool = await f.tool({ query: "softwsre development kit", limit: 50 });
    expect(response.status).toBe(200); expect(tool.status).toBe(200);
    const raw = await response.json(), parsed = parseSearchResponse(raw); expect(parsed).not.toBeNull(); expect(await tool.json()).toEqual(raw);
    expect(parsed?.results.some((entry) => entry.sourceId === source.id && !entry.item)).toBe(true);
    expect(parsed?.results.some((entry) => entry.item?.id === item.id && entry.item.formulationId === item.current.id && !("text" in entry.item))).toBe(true);
    expect(queries.map((sql) => db.query(sql).all())).toEqual(before);
  } finally { db.close(); }
});

test("query and limit validation agrees across GET and authorized tool", async () => {
  const f = await fixture();
  for (const query of ["a".repeat(512), " x ", "*"]) { expect((await f.get(query)).status).toBe(200); expect((await f.tool({ query })).status).toBe(200); }
  expect((await f.get("a".repeat(513))).status).toBe(400); expect((await f.tool({ query: "x\ud800" })).status).toBe(400);
  for (const limit of [0, 201, -1, 1.5]) { expect((await f.get("sdk", `&limit=${limit}`)).status).toBe(400); expect((await f.tool({ query: "sdk", limit })).status).toBe(400); }
  expect((await f.get("sdk", "&limit=1&limit=2")).status).toBe(400);
});

test("recorded aliases remain attributable, one-hop and lower priority than direct matches", async () => {
  const f = await fixture(), direct = await f.capture("zxq"), expanded = await f.capture("orange orchard"), chain = await f.capture("paper meadow");
  const alias = f.knowledge.recordAlias({ actor: "user", operationId: "alias-orange" }, { alias: "ZXQ", expansion: "orange orchard", evidenceSourceIds: [f.root.id] });
  f.knowledge.recordAlias({ actor: "user", operationId: "alias-chain" }, { alias: "orange orchard", expansion: "paper meadow", evidenceSourceIds: [f.root.id] });
  const response = await f.get("zxq"), tool = await f.tool({ query: "zxq" }); expect(response.status).toBe(200); expect(tool.status).toBe(200);
  const raw = await response.json(), body = parseSearchResponse(raw); expect(body).not.toBeNull(); expect(await tool.json()).toEqual(raw);
  expect(body?.results[0]).toMatchObject({ sourceId: direct.id, match: { kind: "exact" } });
  expect(body?.results.find((entry) => entry.sourceId === expanded.id)).toMatchObject({ matchOrigin: "alias", match: { kind: "alias" }, alias: { id: alias.id, author: "user", evidenceSourceIds: [f.root.id], direction: "alias-to-expansion", expandedQuery: "orange orchard" } });
  expect(body?.results.some((entry) => entry.sourceId === chain.id)).toBe(false);
});
