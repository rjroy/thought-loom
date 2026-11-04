import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/daemon/app";
import { CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import { SearchService, type SearchPage } from "../src/domain/search";
import { TitleService } from "../src/domain/title";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteSearchRepository } from "../src/storage/search";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";

const user = { actor: "user", mode: "normal" } as const;
const show = { actor: "user", mode: "show-rejected" } as const;
const ai = { actor: "ai", mode: "normal" } as const;
const credentials = { user: "user-test-secret", ai: "agent-test-secret" };
const start = "2022-01-01T00:00:00.000Z";
const end = "2023-12-31T23:59:59.999Z";

function fixture<T>(action: (value: { db: Database; service: SearchService; rejection: RejectionService; app: ReturnType<typeof createApp> }) => T): T {
  const dir = mkdtempSync(join("/tmp/opencode", "search-contract-"));
  const db = new Database(join(dir, "owned.sqlite"));
  try {
    migrate(db);
    const store = new SqliteStore(db);
    const entries = [
      { id: "u1", text: "cobalt original words for exploration", title: "astronomical label", author: "user", kind: "captured-original", createdAt: "2020-01-01T00:00:00.000Z" },
      { id: "u2", text: "cobalt user question", title: null, author: "user", kind: "user-contribution", createdAt: "2023-01-01T00:00:00.000Z" },
      { id: "a1", text: "cobalt AI development", title: "AI title", author: "ai", kind: "developing-idea", createdAt: "2022-01-01T00:00:00.000Z" },
      { id: "a2", text: "cobalt rejected development", title: "hidden title", author: "ai", kind: "developing-idea", createdAt: "2024-01-01T00:00:00.000Z" },
    ] as const;
    for (const entry of entries) store.saveThought({ ...entry, origin: "test", parentId: null, sourceIds: [] });
    store.saveResponse({ id: "r1", text: "cobalt response exact original wording", role: "addendum", state: "complete", thoughtIds: ["u1", "u2"] });
    store.saveResponse({ id: "r2", text: "cobalt other retained response", role: "addendum", state: "interrupted", thoughtIds: ["a1", "a2"] });
    const rejection = new RejectionService(new SqliteRejectionRepository(db));
    rejection.rejectThought("user", "a2");
    const service = new SearchService(new SqliteSearchRepository(db));
    const creation = new CreationService({ rejection, writes: { createThought: value => store.saveThought(value), createConnection: value => store.saveConnection(value) }, id: () => "unused", now: () => "2030" });
    const titles = new TitleService(new SqliteTitleRepository(db));
    const app = createApp({ rejection, creation, titles, search: service, credentials, logger: () => {} });
    return action({ db, service, rejection, app });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe("headless search contract", () => {
  test("filters OR within groups and AND across groups; option counts omit only their own group", () => fixture(({ service }) => {
    const page = service.query(user, "cobalt", { authors: ["user"], kinds: ["user-contribution", "developing-idea"], from: start, to: end });
    expect(page.results.map(result => result.id)).toEqual(["u2"]);
    expect(page.counts).toEqual({ authors: { user: 1, ai: 3 }, kinds: { "captured-original": 0, "user-contribution": 1, "ai-interpretation": 0, "developing-idea": 0 } });
    expect(Object.keys(page.counts).sort()).toEqual(["authors", "kinds"]);
    const either = service.query(user, "cobalt", { authors: ["user", "ai"], kinds: ["user-contribution", "developing-idea"], from: start, to: end });
    expect(either.results.map(result => result.id).sort()).toEqual(["a1", "r1", "r2", "u2"]);
    expect(service.query(user, "cobalt", { authors: ["user"] }).results.map(result => result.id).sort()).toEqual(["u1", "u2"]);
  }));

  test("response matches have independent identity and AI authorship; target supplies kind and creation date", () => fixture(({ service }) => {
    const page = service.query(user, "cobalt");
    const response = page.results.find(result => result.id === "r1");
    expect(response).toMatchObject({ kind: "response", id: "r1", thoughtId: "u2", author: "ai", materialKind: "user-contribution", createdAt: "2023-01-01T00:00:00.000Z", text: "cobalt response exact original wording" });
    expect(page.results.find(result => result.id === "u2")).toMatchObject({ kind: "thought", author: "user", materialKind: "user-contribution" });
    expect(page.results.find(result => result.id === "r2")).toMatchObject({ thoughtId: "a1", author: "ai", materialKind: "developing-idea", createdAt: "2022-01-01T00:00:00.000Z" });
    expect(service.query(ai, "cobalt").results.some(result => result.id === "r2")).toBe(false);
    expect(service.query(show, "cobalt").results.find(result => result.id === "r2")).toMatchObject({ thoughtId: "a2", author: "ai", createdAt: "2024-01-01T00:00:00.000Z" });
    expect(service.query(show, "cobalt").results.some(result => result.id === "a2")).toBe(true);
  }));

  test("chronological sorting follows creation date; titles and excerpts are original text", () => fixture(({ service }) => {
    const oldest = service.query(user, "cobalt", { sort: "oldest" }).results;
    const newest = service.query(user, "cobalt", { sort: "newest" }).results;
    expect(oldest.map(item => item.createdAt)).toEqual([...oldest.map(item => item.createdAt)].sort());
    expect(newest.map(item => item.createdAt)).toEqual([...newest.map(item => item.createdAt)].sort().reverse());
    expect(service.query(user, "cobalt", { sort: "relevance" }).results.map(item => item.id).sort()).toEqual(oldest.map(item => item.id).sort());
    expect(oldest.find(item => item.id === "u1")?.title).toBe("astronomical label");
    expect(oldest.find(item => item.id === "u2")?.title).toBe("cobalt user question");
    for (const item of oldest) {
      expect(item.snippet.length).toBeGreaterThan(0);
      expect(item.text).toContain(item.snippet);
    }
  }));

  test("prefix and modest spelling corrections return scoped hits rather than suggestions alone", () => fixture(({ service, rejection }) => {
    expect(service.query(user, "astron").results.map(item => item.id)).toContain("u1");
    expect(service.query(user, "astronimical").results.map(item => item.id)).toContain("u1");
    rejection.rejectThought("user", "u1");
    expect(service.query(ai, "astronimical").results.map(item => item.id)).not.toContain("u1");
    expect(service.query(show, "astronimical").results.map(item => item.id)).toContain("u1");
  }));

  test("inspection adds rejected material without a rejected toggle count or separate rejected-only count query", () => fixture(({ service, db }) => {
    const queries = spyOn(Database.prototype, "query");
    const snapshots = spyOn(SqliteRejectionRepository.prototype, "snapshot");
    try {
      const normal = service.query(user, "cobalt");
      const inspected = service.query(show, "cobalt");
      expect(normal.results.map(item => item.id).sort()).toEqual(["a1", "r1", "r2", "u1", "u2"]);
      expect(inspected.results.map(item => item.id).sort()).toEqual(["a1", "a2", "r1", "r2", "u1", "u2"]);
      expect(normal.counts.authors).toEqual({ user: 2, ai: 3 });
      expect(inspected.counts.authors).toEqual({ user: 2, ai: 4 });
      expect(service.query(ai, "cobalt").counts.authors).toEqual({ user: 2, ai: 2 });
      expect(Object.keys(inspected.counts).sort()).toEqual(["authors", "kinds"]);
      expect(queries.mock.calls.some(args => /select\s+count\s*\([^)]*\)\s+from\s+rejected_thoughts\b/i.test(String(args[0])))).toBe(false);
      expect(snapshots).toHaveBeenCalledTimes(0);
    } finally { snapshots.mockRestore(); queries.mockRestore(); }
  }));
});

// Access the additive contract without requiring production SearchResult scaffolding.
function contextFor(page: SearchPage, id: string): unknown {
  const result = page.results.find(item => item.id === id);
  if (!result) throw new Error(`Missing search result ${id}`);
  return "context" in result ? result.context : undefined;
}

function contextFixture(db: Database) {
  const store = new SqliteStore(db);
  const save = (id: string, text: string, parentId: string | null, createdAt: string, sourceIds: string[] = [], title: string | null = null, author: "user" | "ai" = "ai") => {
    store.saveThought({ id, text, title, author, kind: author === "user" ? "user-contribution" : "developing-idea", createdAt, origin: "test", parentId, sourceIds });
  };
  save("ctx-ancestor", "old ancestry", null, "2017-01-01");
  save("ctx-parent", "recorded predecessor", "ctx-ancestor", "2018-01-01");
  save("ctx-target", "nebula target", "ctx-parent", "2023-06-01", [], null, "user");
  save("ctx-hidden", "private reference", null, "2016-01-01");
  save("ctx-best", "nebula nebula nebula", "ctx-hidden", "2020-01-01", ["ctx-hidden"]);
  save("ctx-new", "nebula with many ordinary unrelated words to dilute the matching term significantly", null, "2025-01-01");
  save("ctx-title", "unrelated words", null, "2026-01-01", [], "nebula");
  const link = (id: string, toId: string, sourceIds: string[] = []) => store.saveConnection({ id, fromId: "ctx-target", toId, category: "supports", proposedBy: "ai", explanation: `recorded rationale ${id}`, sourceIds });
  link("ctx-link-best", "ctx-best", ["ctx-hidden"]);
  link("ctx-link-new", "ctx-new");
  link("ctx-link-title", "ctx-title");
  return { store, save, link };
}

describe("search result recorded context", () => {
  test("connected own-text relevance beats recency and facets without changing result ranking or counts", () => fixture(({ db, service }) => {
    const { store } = contextFixture(db);
    const expected = { kind: "connection", thought: store.getThought("ctx-best"), connection: store.getConnection("ctx-link-best") };
    const options = { authors: ["user"], kinds: ["user-contribution"], from: "2023-01-01", to: "2023-12-31" } as const;
    for (const sort of ["newest", "oldest", "relevance"] as const) {
      const page = service.query(user, "nebula", { ...options, sort });
      expect(page.results.map(item => item.id)).toEqual(["ctx-target"]);
      expect(page.counts).toEqual({ authors: { user: 1, ai: 0 }, kinds: { "captured-original": 0, "user-contribution": 1, "ai-interpretation": 0, "developing-idea": 0 } });
      expect(contextFor(page, "ctx-target")).toEqual(expected);
    }
    // A title hit alone is not an eligible matching neighbor.
    const titleOnly = service.query(user, "nebula", { authors: ["ai"] });
    expect(titleOnly.results.map(item => item.id)).toContain("ctx-title");
  }));

  test("rejected links and neighbors never become surrounding context, including inspection; AI provenance is scoped", () => fixture(({ db, service, rejection }) => {
    const { store } = contextFixture(db);
    rejection.rejectThought("user", "ctx-hidden");
    const aiPage = service.query(ai, "nebula");
    expect(contextFor(aiPage, "ctx-target")).toEqual({ kind: "connection",
      thought: { ...store.getThought("ctx-best"), parentId: null, sourceIds: [] },
      connection: { ...store.getConnection("ctx-link-best"), sourceIds: [] } });
    expect(JSON.stringify(contextFor(aiPage, "ctx-target"))).not.toContain("ctx-hidden");
    rejection.rejectConnection("user", "ctx-link-best");
    expect(contextFor(service.query(show, "nebula"), "ctx-target")).toEqual({ kind: "connection", thought: store.getThought("ctx-new"), connection: store.getConnection("ctx-link-new") });
    rejection.rejectThought("user", "ctx-new");
    const inspected = service.query(show, "nebula");
    expect(inspected.results.map(item => item.id)).toContain("ctx-new");
    expect(contextFor(inspected, "ctx-target")).toEqual({ kind: "predecessor", thought: store.getThought("ctx-parent") });
    rejection.rejectThought("user", "ctx-parent");
    expect(contextFor(service.query(show, "nebula"), "ctx-target")).toBeNull();
    expect(contextFor(service.query(ai, "nebula"), "ctx-target")).toBeNull();
  }));

  test("equal relevance chooses the stable thought id and then connection id", () => fixture(({ db, service }) => {
    const { store, save } = contextFixture(db);
    save("tie-target", "tiequartz target", null, "2023-01-01");
    save("tie-a", "tiequartz candidate", null, "2023-01-01");
    save("tie-z", "tiequartz candidate", null, "2023-01-01");
    for (const [id, toId] of [["link-z", "tie-a"], ["link-b", "tie-z"], ["link-a", "tie-a"]]) {
      store.saveConnection({ id, fromId: "tie-target", toId, category: "related", proposedBy: "user", explanation: id, sourceIds: [] });
    }
    for (const sort of ["newest", "oldest"] as const) {
      expect(contextFor(service.query(user, "tiequartz", { sort }), "tie-target")).toEqual({ kind: "connection", thought: store.getThought("tie-a"), connection: store.getConnection("link-a") });
    }
  }));

  test("response hits use their destination's context, not another response or title hit; corrections use the effective query", () => fixture(({ db, service }) => {
    const { store, save, link } = contextFixture(db);
    save("ctx-response-neighbor", "not a matching note", null, "2024-01-01");
    link("ctx-link-response", "ctx-response-neighbor");
    store.saveResponse({ id: "ctx-response", text: "quasarneedle response", role: "addendum", state: "complete", thoughtIds: ["ctx-target"] });
    store.saveResponse({ id: "ctx-other-response", text: "quasarneedle other response", role: "fallback", state: "complete", thoughtIds: ["ctx-response-neighbor"] });
    const page = service.query(user, "quasarneedle");
    expect(page.results.find(item => item.id === "ctx-response")?.thoughtId).toBe("ctx-target");
    expect(contextFor(page, "ctx-response")).toEqual({ kind: "predecessor", thought: store.getThought("ctx-parent") });
    expect(contextFor(page, "ctx-other-response")).toBeNull();

    save("ctx-spell-target", "astronomical target", "ctx-parent", "2023-01-01", [], null, "user");
    save("ctx-spell-neighbor", "astronomical neighbor", null, "2022-01-01");
    store.saveConnection({ id: "ctx-spell-link", fromId: "ctx-spell-target", toId: "ctx-spell-neighbor", category: "related", proposedBy: "user", explanation: "recorded astronomy connection", sourceIds: [] });
    const corrected = service.query(user, "astronimical");
    expect(corrected.results.map(item => item.id)).toContain("ctx-spell-target");
    expect(contextFor(corrected, "ctx-spell-target")).toEqual({ kind: "connection", thought: store.getThought("ctx-spell-neighbor"), connection: store.getConnection("ctx-spell-link") });
  }));
});

describe("GET /search transport", () => {
  test("parses strict filter params and serves authenticated scoped results", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "search-http-"));
    // Keep the owned fixture alive across asynchronous Hono requests.
    try {
      const db = new Database(join(dir, "http.sqlite"));
      try {
        migrate(db);
        const store = new SqliteStore(db);
        store.saveThought({ id: "one", text: "cobalt idea", title: null, author: "user", kind: "captured-original", createdAt: "2023-01-01T00:00:00.000Z", origin: "test", parentId: null, sourceIds: [] });
        store.saveThought({ id: "two", text: "cobalt development", title: null, author: "ai", kind: "developing-idea", createdAt: "2023-02-01T00:00:00.000Z", origin: "test", parentId: null, sourceIds: [] });
        const rejection = new RejectionService(new SqliteRejectionRepository(db));
        const search = new SearchService(new SqliteSearchRepository(db));
        const creation = new CreationService({ rejection, writes: { createThought: value => store.saveThought(value), createConnection: value => store.saveConnection(value) }, id: () => "unused", now: () => "2030" });
        const app = createApp({ rejection, creation, titles: new TitleService(new SqliteTitleRepository(db)), search, credentials, logger: () => {} });
        const request = (path: string, token = credentials.user) => app.request(path, { headers: { authorization: `Bearer ${token}` } });
        const response = await request(`/search?q=cobalt&author=user&kind=captured-original&from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}&sort=newest`);
        expect(response.status).toBe(200);
        const page = await response.json();
        expect(page.results.map((item: { id: string }) => item.id)).toEqual(["one"]);
        expect(page.results[0].context).toBeNull();
        expect(page.counts.authors.user).toBe(1);
        const combined = await request("/search?q=cobalt&author=user&author=ai&kind=captured-original&kind=developing-idea");
        expect(combined.status).toBe(200);
        expect((await combined.json()).results.map((item: { id: string }) => item.id).sort()).toEqual(["one", "two"]);
        expect((await request("/search?q=cobalt&scope=show-rejected", credentials.ai)).status).toBe(403);
        expect((await app.request("/search?q=cobalt")).status).toBe(401);
        for (const path of ["/search", "/search?q=", "/search?q=%20", "/search?q=a&q=b", "/search?q=a&scope=normal&scope=history", "/search?q=a&author=admin", "/search?q=a&kind=unknown", "/search?q=a&sort=surprise", "/search?q=a&sort=newest&sort=oldest", "/search?q=a&from=not-a-date", `/search?q=a&from=${encodeURIComponent(end)}&to=${encodeURIComponent(start)}`, "/search?q=a&unexpected=1"]) expect((await request(path)).status).toBe(400);
        expect((await request("/thoughts?author=user")).status).toBe(400);
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
