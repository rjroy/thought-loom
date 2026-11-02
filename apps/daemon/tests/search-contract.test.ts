import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseSearchResponse } from "@thoughtloom/contracts";
import { createApp } from "../src/app";
import { KnowledgeService } from "../src/knowledge";
import { createToolApp, OwnedGrants, type OwnedGrant } from "../src/tool-boundary";
import { WeavingWorker, type WeavingAdapter, type WeavingRun } from "../src/weaving";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const dir = await mkdtemp("/tmp/opencode/fuzzy-contract-test-"), databasePath = join(dir, "fixture.sqlite");
  const app = createApp({ databasePath });
  let n = 0;
  async function capture(text: string) {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `search-capture-${++n}` }, body: JSON.stringify({ text, provenance: "controlled fixture" }) });
    expect(response.status).toBe(201); return await response.json() as { id: string; text: string };
  }
  const root = await capture("Fixture owned root without matching terms.");
  let enter = (_run: WeavingRun) => {}, release = () => {};
  const entered = new Promise<WeavingRun>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter: WeavingAdapter = { async prepareSession(run) { enter(run); await gate; }, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; } };
  const worker = new WeavingWorker({ databasePath, adapter }), done = worker.startNext();
  cleanup.push(async () => { release(); await done; await worker.close(); await rm(dir, { recursive: true, force: true }); });
  const run = await Promise.race([entered, done.then(() => { throw new Error("Owned fixture run did not enter preparation"); })]);
  const grant: OwnedGrant = { run, location: "/fixture/search", agent: "fixture-search", sourceIds: [root.id], operations: ["search"] };
  new OwnedGrants(databasePath).bind(grant); release(); expect((await done).kind).toBe("started");
  const tools = createToolApp({ databasePath, transportCredential: "fixture-search-credential", location: grant.location });
  const native = { sessionID: run.sessionId, agent: grant.agent, messageID: "msg_fixture_search", callID: "call_fixture_search" };
  const tool = (input: unknown) => tools.request("/internal/tools/search", { method: "POST", headers: { authorization: "Bearer fixture-search-credential", "content-type": "application/json" }, body: JSON.stringify({ action: "search", native, input }) });
  const get = (query: string, extra = "") => app.request(`/search?q=${encodeURIComponent(query)}${extra}`);
  return { databasePath, root, capture, knowledge: new KnowledgeService(databasePath), get, tool };
}

// Proposed versioned wire shape mirrors the actual internal match and passage
// contract; the production contract owner may settle field naming before GREEN.
const wireResult = {
  sourceId: "fixture-source", matchOrigin: "source", source: { excerpt: "sdk", provenance: "fixture", createdAt: "2001-01-01T00:00:00.000Z", origin: { kind: "capture" } },
  match: { route: "direct", field: "source-body", class: "whole-word", skipped: 0, start: 0, end: 3, fieldRevisionId: "fixture-source" },
  passage: { matchStart: 0, matchEnd: 3, matchedKeyCount: 3, omittedMatchedCharacters: false, fragments: [{ start: 0, end: 3, text: "sdk", highlights: [{ start: 0, end: 3 }] }] },
};
const wire = { engineVersion: 1, results: [wireResult], hasMore: false, aliasExpansionTruncated: false };

test("phase3-contract parser requires versioned result and truncation metadata", () => {
  expect(parseSearchResponse({ results: [] })).toBeNull();
  expect(parseSearchResponse({ engineVersion: 1, results: [], hasMore: false, aliasExpansionTruncated: false })).toEqual({ engineVersion: 1, results: [], hasMore: false, aliasExpansionTruncated: false });
  expect(parseSearchResponse({ engineVersion: 999, results: [], hasMore: false, aliasExpansionTruncated: false })).toBeNull();
  expect(parseSearchResponse({ engineVersion: 1, results: [], hasMore: "false", aliasExpansionTruncated: false })).toBeNull();
});

test("phase3-contract parser validates passage bounds, grapheme-safe highlights and exact item/title identities", () => {
  expect(parseSearchResponse(wire)).not.toBeNull();
  const withPassage = (passage: object) => ({ ...wire, results: [{ ...wireResult, passage }] });
  expect(parseSearchResponse(withPassage({ ...wireResult.passage, fragments: [{ start: 0, end: 3, text: "sdk", highlights: [{ start: 0, end: 4 }] }] }))).toBeNull();
  expect(parseSearchResponse(withPassage({ ...wireResult.passage, fragments: [{ start: 0, end: 2, text: "sdk", highlights: [] }] }))).toBeNull();
  expect(parseSearchResponse(withPassage({ ...wireResult.passage, fragments: [{ start: 0, end: 3, text: "sdk", highlights: [{ start: 2, end: 1 }] }] }))).toBeNull();
  const emoji = { ...wireResult.passage, matchEnd: 2, matchedKeyCount: 1, fragments: [{ start: 0, end: 2, text: "🌱", highlights: [{ start: 0, end: 1 }] }] };
  expect(parseSearchResponse(withPassage(emoji))).toBeNull();
  const item = { ...wireResult, matchOrigin: "interpretation", item: { id: "fixture-item", kind: "interpretation", formulationId: "fixture-version", author: "ai" }, title: { revisionId: "fixture-title", text: "Label", author: "user" }, match: { ...wireResult.match, field: "formulation-body", fieldRevisionId: "fixture-version" } };
  expect(parseSearchResponse({ ...wire, results: [item] })).not.toBeNull();
  expect(parseSearchResponse({ ...wire, results: [{ ...item, item: { ...item.item, formulationId: "" } }] })).toBeNull();
  expect(parseSearchResponse({ ...wire, results: [{ ...item, title: { ...item.title, author: "unknown" } }] })).toBeNull();
  expect(parseSearchResponse({ ...wire, results: [{ ...item, match: { ...item.match, fieldRevisionId: "wrong-version" } }] })).toBeNull();
});

test("phase3-contract alias-only results require attributable expansion provenance", () => {
  const aliasResult = { ...wireResult, matchOrigin: "alias", match: { ...wireResult.match, route: "alias" } };
  expect(parseSearchResponse({ ...wire, results: [aliasResult] })).toBeNull();
  const alias = { id: "fixture-alias", alias: "SDK", expansion: "software kit", author: "user", evidenceSourceIds: ["fixture-source"], direction: "alias-to-expansion", expandedQuery: "software kit" };
  expect(parseSearchResponse({ ...wire, results: [{ ...aliasResult, alias }] })).not.toBeNull();
  expect(parseSearchResponse({ ...wire, results: [{ ...aliasResult, alias: { ...alias, evidenceSourceIds: [] } }] })).toBeNull();
});

test("phase3-route accepts raw multiword query on both GET and owned search tool", async () => {
  const f = await fixture(), query = Array.from({ length: 17 }, (_, i) => `w${i}`).join(" ");
  const source = await f.capture(query);
  const get = await f.get(query), tool = await f.tool({ query });
  expect(get.status).toBe(200); expect(tool.status).toBe(200);
  const a = await get.json() as { results: Array<{ sourceId: string }> }, b = await tool.json();
  expect(a.results.some((result) => result.sourceId === source.id)).toBe(true); expect(b).toEqual(a);
});

test("phase3-route respects exact required whitespace and literal punctuation", async () => {
  const f = await fixture(), spaced = await f.capture("Software\tKit"), joined = await f.capture("SoftwareKit"), punct = await f.capture("s*k");
  const read = async (query: string) => { const response = await f.get(query); expect(response.status).toBe(200); return await response.json() as { results: Array<{ sourceId: string }> }; };
  const spaces = await read("s k");
  expect(spaces.results.some((row) => row.sourceId === spaced.id)).toBe(true);
  expect(spaces.results.some((row) => row.sourceId === joined.id)).toBe(false);
  const literal = await read("s*k");
  expect(literal.results.some((row) => row.sourceId === punct.id)).toBe(true);
  expect(literal.results.some((row) => row.sourceId === spaced.id)).toBe(false);
});

test("phase3-route query and limit validation agrees across GET and tool", async () => {
  const f = await fixture();
  for (const query of ["a".repeat(512), " x ", "*"]) {
    expect((await f.get(query)).status).toBe(200); expect((await f.tool({ query })).status).toBe(200);
  }
  expect((await f.get("a".repeat(513))).status).toBe(400);
  expect((await f.tool({ query: "a".repeat(513) })).status).toBe(400);
  expect((await f.tool({ query: "x\ud800" })).status).toBe(400);
  for (const limit of [0, 201, -1, 1.5]) {
    expect((await f.get("sdk", `&limit=${limit}`)).status).toBe(400);
    expect((await f.tool({ query: "sdk", limit })).status).toBe(400);
  }
  for (const limit of [1, 200]) {
    expect((await f.get("sdk", `&limit=${limit}`)).status).toBe(200);
    expect((await f.tool({ query: "sdk", limit })).status).toBe(200);
  }
  expect((await f.get("sdk", "&limit=1&limit=2")).status).toBe(400);
});

test("phase3-route GET and owned tool share ranked full-field results without creating evidence", async () => {
  const f = await fixture(), camel = await f.capture("SoftwareDevelopmentKit"), spaced = await f.capture("shoulD Know"), late = await f.capture(`${"q".repeat(300)} SoftwareDevelopmentKit`);
  const item = f.knowledge.createItem({ actor: "ai", operationId: "contract-item", runId: "fixture-run" }, { kind: "interpretation", sourceId: camel.id, text: "sdk", evidenceSourceIds: [camel.id] });
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const queries = ["SELECT * FROM tool_reads", "SELECT * FROM sources", "SELECT * FROM knowledge_items", "SELECT * FROM formulations", "SELECT * FROM relationships", "SELECT * FROM search_aliases", "SELECT * FROM jobs"];
    const before = queries.map((sql) => db.query(sql).all());
    const response = await f.get("sdk", "&limit=50"), tool = await f.tool({ query: "sdk", limit: 50 });
    expect(response.status).toBe(200); expect(tool.status).toBe(200);
    const a = await response.json(), b = await tool.json(); expect(b).toEqual(a);
    const parsed = parseSearchResponse(a); expect(parsed).not.toBeNull();
    const body = a as { engineVersion: number; hasMore: boolean; aliasExpansionTruncated: boolean; results: Array<{ sourceId: string; item?: { id: string; formulationId: string; text?: string }; passage: { matchStart: number; fragments: Array<{ text: string }> } }> };
    expect(body).toMatchObject({ engineVersion: 1, hasMore: false, aliasExpansionTruncated: false });
    for (const source of [camel, spaced, late]) expect(body.results.some((entry) => entry.sourceId === source.id && !entry.item)).toBe(true);
    expect(body.results.some((entry) => entry.item?.id === item.id && entry.item.formulationId === item.current.id && !("text" in entry.item))).toBe(true);
    const lateHit = body.results.find((entry) => entry.sourceId === late.id && !entry.item);
    expect(lateHit?.passage.matchStart).toBeGreaterThan(240);
    expect(lateHit?.passage.fragments.some((fragment) => fragment.text.includes("SoftwareDevelopmentKit"))).toBe(true);
    expect(queries.map((sql) => db.query(sql).all())).toEqual(before);
  } finally { db.close(); }
});

test("phase3-route inserted query character is not repaired as a typo", async () => {
  const f = await fixture(), source = await f.capture("A telescope reveals distant stars.");
  const response = await f.get("telescoppe"); expect(response.status).toBe(200);
  const body = await response.json() as { results: Array<{ sourceId: string }> };
  expect(body.results.some((row) => row.sourceId === source.id)).toBe(false);
});

test("phase3-route default limit is 50 with honest hasMore for both transports", async () => {
  const f = await fixture();
  for (let n = 0; n < 51; n++) await f.capture(`sdk fixture ${n}`);
  const response = await f.get("sdk"), tool = await f.tool({ query: "sdk" });
  expect(response.status).toBe(200); expect(tool.status).toBe(200);
  const result = await response.json() as { results: unknown[]; hasMore: boolean };
  expect(result.results).toHaveLength(50); expect(result.hasMore).toBe(true);
  expect(await tool.json()).toEqual(result);
});

test("phase3-alias SDK finds both spellings directly even when an alias exists", async () => {
  const f = await fixture(), short = await f.capture("SDK"), long = await f.capture("software development kit");
  f.knowledge.recordAlias({ actor: "user", operationId: "alias-sdk" }, { alias: "SDK", expansion: "software development kit", evidenceSourceIds: [f.root.id] });
  const response = await f.get("sdk"), tool = await f.tool({ query: "sdk" });
  expect(response.status).toBe(200); expect(tool.status).toBe(200);
  const body = parseSearchResponse(await response.json()); expect(body).not.toBeNull();
  if (!body) throw new Error("Invalid search response");
  for (const source of [short, long]) {
    const hit = body.results.find((entry) => entry.sourceId === source.id && !entry.item);
    expect(hit?.match.route).toBe("direct"); expect(hit?.matchOrigin).toBe("source"); expect(hit?.alias).toBeUndefined();
  }
  expect(await tool.json()).toEqual(body);
});

test("phase3-alias ambiguous one-hop supplements retain provenance, no chains and direct priority", async () => {
  const f = await fixture(), direct = await f.capture("zxq"), orange = await f.capture("orange orchard"), violet = await f.capture("violet river"), chain = await f.capture("paper meadow");
  const a = f.knowledge.recordAlias({ actor: "user", operationId: "alias-orange" }, { alias: "ZXQ", expansion: "orange orchard", evidenceSourceIds: [f.root.id] });
  const b = f.knowledge.recordAlias({ actor: "user", operationId: "alias-violet" }, { alias: "ZXQ", expansion: "violet river", evidenceSourceIds: [f.root.id] });
  f.knowledge.recordAlias({ actor: "user", operationId: "alias-chain" }, { alias: "orange orchard", expansion: "paper meadow", evidenceSourceIds: [f.root.id] });
  const before = new Database(f.databasePath, { readonly: true });
  try {
    const snapshots = ["SELECT * FROM tool_reads", "SELECT * FROM relationships", "SELECT * FROM search_aliases"].map((sql) => before.query(sql).all());
    const response = await f.get("zxq"), tool = await f.tool({ query: "zxq" });
    expect(response.status).toBe(200); expect(tool.status).toBe(200);
    const body = parseSearchResponse(await response.json()); expect(body).not.toBeNull(); if (!body) throw new Error("Invalid search response");
    expect(await tool.json()).toEqual(body);
    expect(body.results[0]).toMatchObject({ sourceId: direct.id, match: { route: "direct" } });
    for (const [source, alias] of [[orange, a], [violet, b]] as const) {
      const hit = body.results.find((entry) => entry.sourceId === source.id && !entry.item);
      expect(hit).toMatchObject({ matchOrigin: "alias", match: { route: "alias" }, alias: { id: alias.id, alias: "ZXQ", expansion: alias.expansion, author: "user", evidenceSourceIds: [f.root.id], direction: "alias-to-expansion", expandedQuery: alias.expansion } });
      expect(hit?.passage.fragments.map((fragment) => fragment.text).join("")).toContain(alias.expansion);
    }
    expect(body.results.some((entry) => entry.sourceId === chain.id)).toBe(false);
    const reverse = await f.get("orange orchard"); expect(reverse.status).toBe(200);
    const reverseBody = parseSearchResponse(await reverse.json()); expect(reverseBody).not.toBeNull();
    expect(reverseBody?.results.find((entry) => entry.sourceId === direct.id)).toMatchObject({ match: { route: "alias" }, alias: { id: a.id, direction: "expansion-to-alias", expandedQuery: "ZXQ" } });
    for (const query of ["zxq ", "zxq!"]) {
      const changed = await f.get(query); expect(changed.status).toBe(200);
      const result = parseSearchResponse(await changed.json()); expect(result).not.toBeNull();
      expect(result?.results.some((entry) => entry.match.route === "alias")).toBe(false);
    }
    expect(["SELECT * FROM tool_reads", "SELECT * FROM relationships", "SELECT * FROM search_aliases"].map((sql) => before.query(sql).all())).toEqual(snapshots);
  } finally { before.close(); }
});

test("phase3-alias record cap is reported independently of K and deterministic by alias id", async () => {
  const f = await fixture(), target = await f.capture("orange orchard"), aliases = [];
  for (let i = 0; i < 101; i++) aliases.push(f.knowledge.recordAlias({ actor: "user", operationId: `cap-alias-${i}` }, { alias: "ZXQ", expansion: "orange orchard", evidenceSourceIds: [f.root.id] }));
  const ids = aliases.map((alias) => alias.id).sort();
  const bigResponse = await f.get("zxq", "&limit=10"), smallResponse = await f.get("zxq", "&limit=1");
  expect(bigResponse.status).toBe(200); expect(smallResponse.status).toBe(200);
  const big = parseSearchResponse(await bigResponse.json()), small = parseSearchResponse(await smallResponse.json());
  expect(big).not.toBeNull(); expect(small).not.toBeNull();
  expect(big?.aliasExpansionTruncated).toBe(true); expect(small?.aliasExpansionTruncated).toBe(true);
  expect(big?.results.find((entry) => entry.sourceId === target.id)?.alias?.id).toBe(ids[0]);
  expect(small?.results).toEqual(big?.results.slice(0, 1));
});

test("phase3-alias normalized expansion key budget truncates by sorted record order", async () => {
  const f = await fixture(), aliases = [];
  for (let i = 0; i < 10; i++) aliases.push(f.knowledge.recordAlias({ actor: "user", operationId: `budget-alias-${i}` }, { alias: "ZXQ", expansion: `${"b".repeat(460)}${i}`, evidenceSourceIds: [f.root.id] }));
  aliases.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Eight 461-key variants fit; the ninth does not. Later IDs are not skipped in.
  const included = await f.capture(aliases[7].expansion), excluded = await f.capture(aliases[8].expansion);
  const response = await f.get("zxq", "&limit=10"); expect(response.status).toBe(200);
  const body = parseSearchResponse(await response.json()); expect(body).not.toBeNull();
  expect(body?.aliasExpansionTruncated).toBe(true);
  expect(body?.results.find((entry) => entry.sourceId === included.id)).toMatchObject({ match: { route: "alias" }, alias: { id: aliases[7].id } });
  expect(body?.results.some((entry) => entry.sourceId === excluded.id)).toBe(false);
});
