import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/daemon/app";
import { CreationService } from "../src/domain/creation";
import { RejectionService, type ThoughtRead } from "../src/domain/rejection";
import { TitleService } from "../src/domain/title";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";
import { initializeSqlMediaStore, insertMediaSource, mediaThought } from "./fixtures/media-source";

const credentials = { user: "browse-user-token", ai: "browse-ai-token" };
type Page = { items: ThoughtRead[]; nextCursor: string | null };

async function fixture(action: (fixture: {
  db: Database;
  store: SqliteStore;
  rejection: RejectionService;
  request: (path: string, actor?: "user" | "ai") => Promise<Response>;
  snapshots: () => number;
}) => Promise<void>): Promise<void> {
  const db = new Database(":memory:");
  try {
    migrate(db);
    initializeSqlMediaStore(db);
    const store = new SqliteStore(db);
    let snapshotCount = 0;
    const repository = new class extends SqliteRejectionRepository {
      override snapshot() { snapshotCount++; return super.snapshot(); }
    }(db);
    const rejection = new RejectionService(repository);
    const creation = new CreationService({ rejection, writes: {
      createThought: thought => store.saveThought(thought),
      createConnection: connection => store.saveConnection(connection),
    }, id: () => "unused", now: () => "2030-01-01T00:00:00.000Z" });
    const titles = new TitleService(new SqliteTitleRepository(db));
    const app = createApp({ rejection, creation, titles, credentials, logger: () => {} });
    await action({ db, store, rejection, snapshots: () => snapshotCount,
      request: async (path, actor = "user") => app.request(path, { headers: { authorization: `Bearer ${credentials[actor]}` } }) });
  } finally { db.close(); }
}

function seed(db: Database, store: SqliteStore): void {
  store.saveThought({ id: "a", text: "Root", title: "Root title", titleAuthor: "user", author: "user",
    kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "capture", parentId: null, sourceIds: [] });
  store.saveThought({ id: "b", text: "Development", title: "Edited title", titleAuthor: "user", author: "ai",
    kind: "ai-interpretation", createdAt: "2030-01-02T00:00:00.000Z", origin: "weave", parentId: "a", sourceIds: ["a"] });
  // Mirror the sealed import-document fixture used by agentic-search-retrieval.test.ts.
  const bytes = new TextEncoder().encode("Imported wording");
  const namespace = db.query<{ id: string }, []>("SELECT id FROM import_namespaces WHERE kind='loose-markdown'").get();
  if (!namespace) throw new Error("Missing test import namespace");
  db.transaction(() => {
    db.run(`INSERT INTO import_documents(id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,created_at,parser_version,segmentation_method,segmentation_reason)
      VALUES ('browse-doc',?,zeroblob(32),?,'utf-8',?,'fixture.md','2030-01-02T00:00:00.000Z','test','structural','fixture')`, [bytes, bytes.length, namespace.id]);
    db.run("INSERT INTO import_locations VALUES (?,'fixture.md','browse-doc')", [namespace.id]);
    db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,import_document_id) VALUES ('c',?,'source','imported-original','2030-01-02T00:00:00.000Z','markdown-import','browse-doc')", ["Imported wording"]);
    db.run("INSERT INTO thought_titles VALUES ('c',NULL,NULL)");
    db.run("INSERT INTO thought_source_seals VALUES ('c')");
    db.run("INSERT INTO import_document_parts VALUES ('browse-doc',0,'thought',0,?,'c',0)", [bytes.length]);
    db.run("INSERT INTO import_document_seals VALUES ('browse-doc')");
  }).immediate();
  store.saveThought({ id: "d", text: "Later user idea", title: null, titleAuthor: null, author: "user",
    kind: "captured-original", createdAt: "2030-01-03T00:00:00.000Z", origin: "capture", parentId: null, sourceIds: [] });
  store.saveResponse({ id: "response", text: "Not a browse thought", role: "addendum", state: "complete", thoughtIds: ["d"] });
}

async function page(request: (path: string, actor?: "user" | "ai") => Promise<Response>, path: string, actor?: "user" | "ai"): Promise<Page> {
  const response = await request(path, actor);
  expect(response.status).toBe(200);
  return await response.json() as Page;
}

function continuation(base: string, cursor: string): string {
  return `${base}${base.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

describe("chronological browse API", () => {
  test("keyset pages break timestamp ties in both directions without responses or duplicates", () => fixture(async ({ db, store, request }) => {
    seed(db, store);
    for (const [sort, expected] of [["newest", ["d", "c", "b", "a"]], ["oldest", ["a", "b", "c", "d"]]] as const) {
      const base = `/browse/thoughts?sort=${sort}&limit=2`;
      const first = await page(request, base);
      expect(first.items.map(item => item.id)).toEqual(expected.slice(0, 2));
      expect(typeof first.nextCursor).toBe("string");
      if (!first.nextCursor) throw new Error("Expected continuation cursor");
      const second = await page(request, continuation(base, first.nextCursor));
      expect(second.items.map(item => item.id)).toEqual(expected.slice(2));
      expect(second.nextCursor).toBeNull();
      expect(Object.keys(first).sort()).toEqual(["items", "nextCursor"]);
    }
    const legacy = await request("/thoughts");
    expect(legacy.status).toBe(200);
    const legacyItems = await legacy.json();
    expect(Array.isArray(legacyItems)).toBe(true);
    expect(legacyItems).toHaveLength(4);
  }));

  test("default limit is 50, maximum limit is 200, and an empty result has no cursor", () => fixture(async ({ store, request }) => {
    expect(await page(request, "/browse/thoughts")).toEqual({ items: [], nextCursor: null });
    for (let i = 0; i < 51; i++) store.saveThought({ id: `t${String(i).padStart(3, "0")}`, text: `Thought ${i}`,
      title: null, author: "user", kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "test", parentId: null, sourceIds: [] });
    const first = await page(request, "/browse/thoughts");
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.id).toBe("t050");
    expect(first.nextCursor).toBeTruthy();
    const maximum = await page(request, "/browse/thoughts?limit=200");
    expect(maximum.items).toHaveLength(51);
    expect(maximum.nextCursor).toBeNull();
    expect(await page(request, "/browse/thoughts?author=ai")).toEqual({ items: [], nextCursor: null });
  }));

  test("author sets are normalized and cursors bind author, sort, limit and scope", () => fixture(async ({ db, store, request }) => {
    seed(db, store);
    const base = "/browse/thoughts?author=user&author=ai&limit=1&sort=newest&scope=normal";
    const first = await page(request, base);
    expect(first.items.map(item => item.id)).toEqual(["d"]);
    if (!first.nextCursor) throw new Error("Expected continuation cursor");
    const equivalent = continuation("/browse/thoughts?author=ai&author=user&author=ai&limit=1&sort=newest&scope=normal", first.nextCursor);
    expect((await page(request, equivalent)).items.map(item => item.id)).toEqual(["b"]);
    for (const changed of [
      "/browse/thoughts?author=user&limit=1&sort=newest&scope=normal",
      "/browse/thoughts?author=user&author=ai&limit=1&sort=oldest&scope=normal",
      "/browse/thoughts?author=user&author=ai&limit=2&sort=newest&scope=normal",
      "/browse/thoughts?author=user&author=ai&limit=1&sort=newest&scope=show-rejected",
    ]) expect((await request(continuation(changed, first.nextCursor))).status).toBe(400);
    expect((await page(request, "/browse/thoughts?author=source")).items.map(item => item.id)).toEqual(["c"]);
  }));

  test("scoped projections preserve titles, sources and media while excluding rejected AI provenance", () => fixture(async ({ db, store, rejection, request }) => {
    seed(db, store);
    insertMediaSource(db, mediaThought);
    rejection.rejectThought("user", "a");
    const user = await page(request, "/browse/thoughts");
    expect(user.items.find(item => item.id === "b")).toMatchObject({ title: "Edited title", titleAuthor: "user", parentId: "a", sourceIds: ["a"] });
    expect(user.items).toContainEqual(mediaThought);
    expect(user.items.map(item => item.id)).not.toContain("a");
    const ai = await page(request, "/browse/thoughts", "ai");
    expect(ai.items.find(item => item.id === "b")).toMatchObject({ parentId: null, sourceIds: [] });
    expect(ai.items).toContainEqual(mediaThought);
    const inspection = await page(request, "/browse/thoughts?scope=show-rejected");
    expect(inspection.items.find(item => item.id === "a")).toMatchObject({ rejected: true });
    expect(inspection.items.find(item => item.id === "b")).toMatchObject({ rejected: false, parentId: "a", sourceIds: ["a"] });
    expect(inspection.items).toContainEqual({ ...mediaThought, rejected: false });
    expect((await request("/browse/thoughts?scope=show-rejected", "ai")).status).toBe(403);
  }));

  test("rejects invalid, unknown, repeated singleton and malformed cursor parameters", () => fixture(async ({ request }) => {
    for (const query of ["limit=0", "limit=201", "limit=-1", "limit=1.5", "limit=", "limit=1&limit=2",
      "sort=", "sort=relevance", "sort=oldest&sort=newest", "author=", "author=other", "scope=bad",
      "scope=normal&scope=normal", "cursor=", "cursor=not-a-cursor", "cursor=x&cursor=y", "extra=x"]) {
      expect((await request(`/browse/thoughts?${query}`)).status).toBe(400);
    }
  }));

  test("browse does not use the full-library rejection snapshot", () => fixture(async ({ db, store, request, snapshots }) => {
    seed(db, store);
    const before = snapshots();
    const result = await page(request, "/browse/thoughts?limit=1");
    expect(result.items).toHaveLength(1);
    expect(snapshots()).toBe(before);
  }));

  test("continuation reads live changes after the keyset boundary", () => fixture(async ({ db, store, request }) => {
    seed(db, store);
    const base = "/browse/thoughts?sort=oldest&limit=2";
    const first = await page(request, base);
    expect(first.items.map(item => item.id)).toEqual(["a", "b"]);
    if (!first.nextCursor) throw new Error("Expected continuation cursor");
    store.saveThought({ id: "e", text: "Inserted after the boundary", title: null, author: "user", kind: "captured-original",
      createdAt: "2030-01-02T12:00:00.000Z", origin: "test", parentId: null, sourceIds: [] });
    const second = await page(request, continuation(base, first.nextCursor));
    expect(second.items.map(item => item.id)).toEqual(["c", "e"]);
    if (!second.nextCursor) throw new Error("Expected final continuation cursor");
    const third = await page(request, continuation(base, second.nextCursor));
    expect(third.items.map(item => item.id)).toEqual(["d"]);
    expect(third.nextCursor).toBeNull();
  }));
});
