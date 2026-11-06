import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SearchService } from "../src/domain/search";
import { SqliteSearchRepository } from "../src/storage/search";
import { SqliteSearchInvestigation } from "../src/storage/investigative-retrieval";
import type { InvestigationRequest, InvestigationResult, SearchInvestigation } from "../src/domain/investigative-retrieval";
import { createLogger } from "../src/logging";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { uniqueKeys } from "../src/domain/run-protocol";

// Proposed internal investigative retrieval facet; its exact exported type and
// placement may differ. It has no model dispatcher or caller-selected scope.
type Request = InvestigationRequest;
type Result = InvestigationResult;

function fixture(action: (db: Database, store: SqliteStore) => void): void {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const store = new SqliteStore(db);
    db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES
      ('older','cobalt old','user','captured-original','2030-01-01T00:00:00.000Z','capture'),
      ('newer','cobalt new','ai','developing-idea','2030-01-02T00:00:00.000Z','capture'),
      ('hidden','cobalt hidden','user','captured-original','2030-01-03T00:00:00.000Z','capture');
      INSERT INTO thought_titles VALUES ('older','Indigo title','user'),('newer',NULL,NULL),('hidden',NULL,NULL);
      INSERT INTO thought_source_seals VALUES ('older'),('newer'),('hidden');
      INSERT INTO responses VALUES ('eligible-response','cobalt reply','addendum','complete'),('unsafe-response','cobalt unsafe','addendum','complete');
      INSERT INTO response_thoughts VALUES ('eligible-response','older',0),('unsafe-response','older',0),('unsafe-response','hidden',1);
      INSERT INTO response_seals VALUES ('eligible-response'),('unsafe-response');
      INSERT INTO rejected_thoughts VALUES ('hidden');`);
    action(db, store);
  } finally { db.close(); }
}

function investigation(store: SqliteStore): SearchInvestigation { return store.searchInvestigation(); }
const request: Request = { query: "cobalt", authors: [], kinds: [], from: null, until: null, sort: "oldest", limit: 2 };
function page(result: Result): Extract<Result, { type: "page" }> {
  expect(result.type).toBe("page");
  if (result.type !== "page") throw new Error("expected investigative page");
  return result;
}

test("investigative candidates retain response identity and apply AI-normal rejection", () => fixture((_db, store) => {
  const search = investigation(store);
  const first = page(search.findThoughts(request));
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  const rest = page(search.findThoughts({ ...request, cursor: first.nextCursor }));
  const items = [...first.items, ...rest.items];
  expect(items.map(item => item.id).sort()).toEqual(["eligible-response", "newer", "older"]);
  expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "response", id: "eligible-response", thoughtId: "older" })]));
  expect(items.some(item => item.id === "hidden" || item.id === "unsafe-response")).toBe(false);
  expect(page(search.findThoughts({ ...request, query: "indigo", limit: 25 })).items.map(item => item.id)).toEqual(["older"]);
}));

test("date-only inventory uses bounded exclusive UTC endpoints and strict limits", () => fixture((_db, store) => {
  const search = investigation(store);
  const range: Request = { ...request, query: null, from: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z", sort: "oldest" };
  expect(page(search.findThoughts(range)).items.map(item => item.thoughtId)).toEqual(expect.arrayContaining(["older"]));
  expect(page(search.findThoughts(range)).items.some(item => item.thoughtId === "newer")).toBe(false);
  expect(() => search.findThoughts({ ...range, from: null })).toThrow();
  expect(() => search.findThoughts({ ...range, until: null })).toThrow();
  expect(() => search.findThoughts({ ...range, sort: "relevance" })).toThrow();
  expect(() => search.findThoughts({ ...range, limit: 0 })).toThrow();
  expect(() => search.findThoughts({ ...range, limit: 101 })).toThrow();
}));

test("author and kind filters apply without widening eligible candidates", () => fixture((_db, store) => {
  const search = investigation(store);
  const result = page(search.findThoughts({ ...request, authors: ["user"], kinds: ["captured-original"], limit: 100 }));
  expect(result.items.map(item => item.id)).toEqual(["older"]);
}));

test("omitted limit defaults to a 25-item transfer, not a total investigation cap", () => fixture((db, store) => {
  for (let i = 0; i < 26; i++) {
    const id = `extra-${i}`;
    db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES (?,'cobalt fixture','user','captured-original','2030-01-01T01:00:00.000Z','capture')", [id]);
    db.run("INSERT INTO thought_titles VALUES (?,NULL,NULL)", [id]);
  }
  const search = investigation(store);
  const { limit: _limit, ...unbounded } = request;
  const first = page(search.findThoughts(unbounded));
  expect(first.items).toHaveLength(25);
  expect(first.nextCursor).not.toBeNull();
  expect(page(search.findThoughts({ ...unbounded, cursor: first.nextCursor })).items.length).toBeGreaterThan(0);
}));

test("ordinary Search still requires text and keeps inclusive UTC date filtering and counts", () => fixture((db) => {
  const search = new SearchService(new SqliteSearchRepository(db));
  const scope = { actor: "user", mode: "normal" } as const;
  expect(() => search.query(scope, "")).toThrow();
  const result = search.query(scope, "cobalt", { from: "2030-01-02", to: "2030-01-02", sort: "newest" });
  expect(result.results.map(item => item.id)).toEqual(["newer"]);
  expect(result.counts).toEqual(expect.objectContaining({ authors: expect.any(Object), kinds: expect.any(Object) }));
  expect(result.results[0]).toEqual(expect.objectContaining({ context: null }));
}));

test("continuation binds filters and detects retrieval changes instead of silently shifting pages", () => fixture((db, store) => {
  const search = investigation(store), first = page(search.findThoughts({ ...request, limit: 1 }));
  expect(first.nextCursor).not.toBeNull();
  expect(() => search.findThoughts({ ...request, limit: 1, authors: ["user"], cursor: first.nextCursor })).toThrow();
  expect(() => search.findThoughts({ ...request, limit: 2, cursor: first.nextCursor })).toThrow();
  db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('new','cobalt later','user','captured-original','2030-01-04T00:00:00.000Z','capture')");
  expect(search.findThoughts({ ...request, limit: 1, cursor: first.nextCursor })).toEqual({ type: "retrieval-changed" });
}));

test.each(["thought", "title", "response", "association"] as const)("%s changes advance the retrieval corpus revision", kind => fixture((db) => {
  const before = (db.query("SELECT retrieval FROM search_revisions WHERE id=1").get() as { retrieval: number }).retrieval;
  if (kind === "thought") db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('no-title','fixture','user','captured-original','2030','capture')");
  if (kind === "title") db.run("UPDATE thought_titles SET title='Changed' WHERE thought_id='older'");
  if (kind === "response") db.run("INSERT INTO responses VALUES ('new-response','fixture','addendum','complete')");
  if (kind === "association") {
    db.run("INSERT INTO responses VALUES ('new-response','fixture','addendum','complete')");
    const afterResponse = (db.query("SELECT retrieval FROM search_revisions WHERE id=1").get() as { retrieval: number }).retrieval;
    db.run("INSERT INTO response_thoughts VALUES ('new-response','older',0)");
    expect((db.query("SELECT retrieval FROM search_revisions WHERE id=1").get() as { retrieval: number }).retrieval).toBeGreaterThan(afterResponse);
    return;
  }
  expect((db.query("SELECT retrieval FROM search_revisions WHERE id=1").get() as { retrieval: number }).retrieval).toBeGreaterThan(before);
}));

test("owned spellfix build corrects lexical queries in both investigative and ordinary Search", () => {
  const temp = mkdtempSync("/tmp/opencode/investigation-spellfix-"), workspace = join(temp, "workspace"), home = join(temp, "home");
  try {
    mkdirSync(join(workspace, "scripts"), { recursive: true });
    mkdirSync(join(workspace, "vendor/sqlite"), { recursive: true });
    mkdirSync(home);
    const root = fileURLToPath(new URL("..", import.meta.url));
    copyFileSync(join(root, "scripts/build-spellfix.sh"), join(workspace, "scripts/build-spellfix.sh"));
    copyFileSync(join(root, "vendor/sqlite/spellfix.c"), join(workspace, "vendor/sqlite/spellfix.c"));
    expect(realpathSync(workspace).startsWith(realpathSync(temp) + "/")).toBe(true);
    const build = spawnSync("bash", ["scripts/build-spellfix.sh"], { cwd: workspace, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: temp }, encoding: "utf8" });
    expect(build.status).toBe(0);
    if (build.status !== 0) throw new Error(`owned spellfix build failed: ${build.stderr}`);
    const extension = join(workspace, "build/sqlite/spellfix.so");
    fixture((db) => {
      db.run("UPDATE thought_titles SET title='astronomical label' WHERE thought_id='older'");
      const logger = createLogger("error", () => {});
      const search = new SqliteSearchRepository(db, extension, logger);
      const investigative = new SqliteSearchInvestigation(db, search, logger);
      const ordinary = new SearchService(search);
      expect(page(investigative.findThoughts({ ...request, query: "astronimical" })).items.map(item => item.id)).toEqual(["older"]);
      expect(ordinary.query({ actor: "ai", mode: "normal" }, "astronimical").results.map(item => item.id)).toEqual(["older"]);
    });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test.each(["relevance", "newest", "oldest"] as const)("%s keysets preserve tied thought and response identities without skips", sort => fixture((db, store) => {
  db.exec(`INSERT INTO responses VALUES ('older','cobalt same-id response','addendum','complete');
    INSERT INTO response_thoughts VALUES ('older','older',0); INSERT INTO response_seals VALUES ('older');
    INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('tie','cobalt tie','user','captured-original','2030-01-01T00:00:00.000Z','capture');
    INSERT INTO thought_titles VALUES ('tie',NULL,NULL);`);
  const search = investigation(store), base = { ...request, sort, limit: 1 };
  const expected = page(search.findThoughts({ ...base, limit: 100 })).items.map(item => `${item.kind}:${item.id}`);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const next = page(search.findThoughts({ ...base, cursor }));
    seen.push(...next.items.map(item => `${item.kind}:${item.id}`));
    cursor = next.nextCursor;
    expect(seen.length).toBeLessThanOrEqual(expected.length);
  } while (cursor !== null);
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(expected.length);
  expect(seen).toContain("thought:older");
  expect(seen).toContain("response:older");
}));

test("tampered cursor payloads and request-binding changes are rejected", () => fixture((_db, store) => {
  const search = investigation(store), first = page(search.findThoughts({ ...request, limit: 1 }));
  if (!first.nextCursor) throw new Error("missing fixture cursor");
  expect(page(search.findThoughts({ ...request, limit: 1, cursor: first.nextCursor })).items.length).toBeGreaterThan(0);
  const [payload, signature, extra] = first.nextCursor.split(".");
  if (!payload || !signature || extra !== undefined) throw new Error("invalid signed fixture cursor");
  const raw = Buffer.from(payload, "base64url").toString("utf8");
  const original = JSON.parse(raw) as Record<string, unknown>;
  const encode = (value: unknown) => `${Buffer.from(JSON.stringify(value)).toString("base64url")}.${signature}`;
  for (const cursor of ["!", encode({ ...original, revision: -1 }), encode({ ...original, thoughtHigh: -1 }),
    encode({ ...original, responseHigh: Number.MAX_SAFE_INTEGER + 1 }), encode({ ...original, key: null }),
    encode({ ...original, key: 0 }), encode({ ...original, binding: "different query" }),
    encode({ ...original, kind: "connection" }), encode({ ...original, extra: 1 }),
    `${Buffer.from(raw.replace(/"key":-?[0-9.eE+-]+/, '"key":1e999')).toString("base64url")}.${signature}`]) {
    expect(() => search.findThoughts({ ...request, limit: 1, cursor })).toThrow();
  }
  for (const altered of [{ query: "indigo" }, { sort: "newest" as const }, { from: "2030-01-01T00:00:00.000Z" }, { authors: ["user"] as const }]) {
    expect(() => search.findThoughts({ ...request, ...altered, limit: 1, cursor: first.nextCursor })).toThrow();
  }
}));

test("duplicate-field payload tampering fails authentication and the shared strict parser rejects duplicates", () => fixture((_db, store) => {
  const search = investigation(store), first = page(search.findThoughts({ ...request, limit: 1 }));
  if (!first.nextCursor) throw new Error("missing fixture cursor");
  expect(page(search.findThoughts({ ...request, limit: 1, cursor: first.nextCursor })).items.length).toBeGreaterThan(0);
  const [payload, signature, extra] = first.nextCursor.split(".");
  if (!payload || !signature || extra !== undefined) throw new Error("invalid signed fixture cursor");
  const raw = Buffer.from(payload, "base64url").toString("utf8");
  const duplicateJson = raw.replace(/^\{/, '{"version":2,');
  expect(() => uniqueKeys(raw)).not.toThrow();
  expect(() => uniqueKeys(duplicateJson)).toThrow();
  const duplicate = `${Buffer.from(duplicateJson).toString("base64url")}.${signature}`;
  expect(() => search.findThoughts({ ...request, limit: 1, cursor: duplicate })).toThrow();
}));

test("an inconsistent cursor high-water cannot silently truncate the retained walk", () => fixture((_db, store) => {
  const search = investigation(store), first = page(search.findThoughts({ ...request, limit: 1 }));
  if (!first.nextCursor) throw new Error("missing fixture cursor");
  expect(page(search.findThoughts({ ...request, limit: 1, cursor: first.nextCursor })).items.length).toBeGreaterThan(0);
  const [payload, signature, extra] = first.nextCursor.split(".");
  if (!payload || !signature || extra !== undefined) throw new Error("invalid signed fixture cursor");
  const fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const damaged = `${Buffer.from(JSON.stringify({ ...fields, thoughtHigh: 0 })).toString("base64url")}.${signature}`;
  expect(() => search.findThoughts({ ...request, limit: 1, cursor: damaged })).toThrow();
}));

test("retrieval exposes bounded snippets and never returns rejected shared response prose", () => fixture((db, store) => {
  db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('long',?,'user','captured-original','2030-01-01T00:00:00.000Z','capture')", ["cobalt " + "x".repeat(180) + "private-tail"]);
  db.run("INSERT INTO thought_titles VALUES ('long',NULL,NULL)");
  const items = page(investigation(store).findThoughts({ ...request, limit: 100 })).items;
  expect(items.map(item => item.id)).not.toContain("hidden");
  expect(items.map(item => item.id)).not.toContain("unsafe-response");
  expect(JSON.stringify(items)).not.toContain("cobalt unsafe");
  const long = items.find(item => item.id === "long");
  expect(long?.snippet.length).toBeLessThanOrEqual(160);
  expect(JSON.stringify(long)).not.toContain("private-tail");
  for (const item of items) expect(Object.keys(item).sort()).toEqual(["author", "createdAt", "id", "kind", "materialKind", "snippet", "thoughtId"]);
}));

test("corpus trigger writes roll back transactionally and definitions survive repeated migrate", () => fixture((db) => {
  const definitions = () => db.query("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'retrieval_%' ORDER BY name").all();
  const triggers = definitions();
  const revision = () => (db.query("SELECT retrieval FROM search_revisions WHERE id=1").get() as { retrieval: number }).retrieval;
  const initial = revision();
  db.run("UPDATE thought_titles SET title=title,title_author=title_author WHERE thought_id='older'");
  expect(revision()).toBe(initial);
  expect(() => db.transaction(() => {
    db.run("UPDATE thought_titles SET title=NULL,title_author=NULL WHERE thought_id='older'");
    db.run("INSERT INTO responses VALUES ('rolled-back','fixture','addendum','complete')");
    db.run("INSERT INTO response_thoughts VALUES ('rolled-back','older',0)");
    expect(revision()).toBeGreaterThan(initial);
    throw new Error("owned rollback");
  })()).toThrow("owned rollback");
  expect(revision()).toBe(initial);
  expect(db.query("SELECT id FROM responses WHERE id='rolled-back'").get()).toBeNull();
  db.run("UPDATE thought_titles SET title=NULL,title_author=NULL WHERE thought_id='older'");
  const cleared = revision();
  expect(cleared).toBeGreaterThan(initial);
  db.run("DELETE FROM thought_titles WHERE thought_id='older'");
  expect(revision()).toBeGreaterThan(cleared);
  migrate(db); migrate(db);
  expect(definitions()).toEqual(triggers);
}));

test.each(["title", "response", "association"] as const)("%s corpus changes invalidate an existing cursor", kind => fixture((db, store) => {
  const search = investigation(store);
  const first = page(search.findThoughts({ ...request, limit: 1 }));
  if (!first.nextCursor) throw new Error("missing fixture cursor");
  db.run("UPDATE thought_titles SET title=title,title_author=title_author WHERE thought_id='older'");
  expect(page(search.findThoughts({ ...request, limit: 1, cursor: first.nextCursor })).items.length).toBeGreaterThan(0);
  if (kind === "title") db.run("UPDATE thought_titles SET title='Changed' WHERE thought_id='older'");
  else {
    db.run("INSERT INTO responses VALUES ('new-response','cobalt fixture','addendum','complete')");
    if (kind === "association") {
      const afterResponse = page(search.findThoughts({ ...request, limit: 1 }));
      if (!afterResponse.nextCursor) throw new Error("missing post-response cursor");
      db.run("INSERT INTO response_thoughts VALUES ('new-response','older',0)");
      expect(search.findThoughts({ ...request, limit: 1, cursor: afterResponse.nextCursor })).toEqual({ type: "retrieval-changed" });
    }
  }
  expect(search.findThoughts({ ...request, limit: 1, cursor: first.nextCursor })).toEqual({ type: "retrieval-changed" });
}));

test("imported candidate does not expose retained source bytes outside its thought snippet", () => fixture((db, store) => {
  const original = Buffer.from("cobalt piece\nTOPSECRET-SOURCE"), text = "cobalt piece";
  const namespace = (db.query("SELECT id FROM import_namespaces WHERE kind='loose-markdown'").get() as { id: string }).id;
  db.transaction(() => {
    db.run(`INSERT INTO import_documents(id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,created_at,parser_version,segmentation_method,segmentation_reason)
      VALUES ('doc',?,zeroblob(32),?,'utf-8',?,'fixture.md','2030','test','structural','fixture')`, [original, original.length, namespace]);
    db.run("INSERT INTO import_locations VALUES (?,'fixture.md','doc')", [namespace]);
    db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,import_document_id) VALUES ('imported',?,'source','imported-original','2030-01-01T00:00:00.000Z','markdown-import','doc')", [text]);
    db.run("INSERT INTO thought_titles VALUES ('imported',NULL,NULL)");
    db.run("INSERT INTO thought_source_seals VALUES ('imported')");
    db.run("INSERT INTO import_document_parts VALUES ('doc',0,'thought',0,?,'imported',0)", [text.length]);
    db.run("INSERT INTO import_document_parts VALUES ('doc',1,'separator',?,?,NULL,NULL)", [text.length, original.length]);
    db.run("INSERT INTO import_document_seals VALUES ('doc')");
  }).immediate();
  const items = page(investigation(store).findThoughts({ ...request, limit: 100 })).items;
  expect(items.find(item => item.id === "imported")).toEqual(expect.objectContaining({ snippet: text, author: "source" }));
  expect(JSON.stringify(items)).not.toContain("TOPSECRET-SOURCE");
}));
