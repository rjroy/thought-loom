import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import type { SearchInvestigation, RelatedItem, RelatedRelation, RelatedResult } from "../src/domain/investigative-retrieval";
import { SearchService } from "../src/domain/search";
import { SqliteSearchRepository } from "../src/storage/search";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

function fixture(action: (db: Database, related: SearchInvestigation, rejection: RejectionService) => void, path = ":memory:"): void {
  const db = new Database(path);
  try {
    migrate(db);
    const store = new SqliteStore(db);
    for (const [id, parentId, sourceIds] of [
      ["root", null, []], ["source", null, []], ["hidden", null, []],
      ["child-a", "root", ["source", "hidden"]], ["child-b", "root", []], ["grandchild", "child-a", []],
    ] as const) store.saveThought({ id, text: `private-${id}`, title: `Title ${id}`, titleAuthor: "user", author: "user",
      kind: parentId ? "user-contribution" : "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "fixture", parentId, sourceIds });
    store.saveConnection({ id: "link-a", fromId: "root", toId: "child-a", category: "supports", proposedBy: "user", explanation: "fixture link", sourceIds: [] });
    store.saveConnection({ id: "link-b", fromId: "child-a", toId: "root", category: "contradicts", proposedBy: "user", explanation: "fixture second link", sourceIds: [] });
    store.saveConnection({ id: "link-hidden", fromId: "root", toId: "hidden", category: "related", proposedBy: "user", explanation: "fixture hidden", sourceIds: [] });
    store.saveResponse({ id: "safe-response", text: "private-safe-response", role: "addendum", state: "complete", thoughtIds: ["root", "child-a"] });
    store.saveResponse({ id: "mixed-response", text: "private-mixed-response", role: "addendum", state: "complete", thoughtIds: ["root", "hidden"] });
    action(db, store.searchInvestigation(), new RejectionService(new SqliteRejectionRepository(db)));
  } finally { db.close(); }
}
function page(related: SearchInvestigation, thoughtId: string, relation: RelatedRelation, options: { limit?: number; cursor?: string | null } = {}): Extract<RelatedResult, { type: "page" }> {
  const result = related.related({ thoughtId, relation, ...options });
  expect(result.type).toBe("page");
  if (result.type !== "page") throw new Error("unexpected related retrieval invalidation");
  return result;
}
function knowledge(db: Database): unknown {
  return ["thoughts", "thought_titles", "thought_sources", "connections", "connection_sources", "responses", "response_thoughts", "run_context"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
}

test("all direct relation kinds retain identities and never synthesize knowledge or full reads", () => fixture((db, related) => {
  const before = knowledge(db);
  const children = page(related, "root", "children").items;
  expect(children.map(item => item.id).sort()).toEqual(["child-a", "child-b"]);
  expect(children.some(item => item.id === "grandchild")).toBe(false);
  expect(page(related, "child-a", "parent").items.map(item => item.id)).toEqual(["root"]);
  expect(page(related, "root", "parent").items).toEqual([]);
  expect(page(related, "child-a", "sources").items.map(item => item.id).sort()).toEqual(["hidden", "source"]);
  expect(page(related, "source", "children").items).toEqual([]);
  const connections = page(related, "root", "connections").items;
  const directed = connections.filter((item): item is Extract<RelatedItem, { kind: "connection" }> => item.kind === "connection");
  expect(directed).toHaveLength(connections.length);
  expect(directed.map(item => [item.id, item.fromId, item.toId, item.category])).toEqual(expect.arrayContaining([
    ["link-a", "root", "child-a", "supports"], ["link-b", "child-a", "root", "contradicts"],
  ]));
  expect(connections).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "connection", id: "link-a", fromId: "root", toId: "child-a", category: "supports" }),
    expect.objectContaining({ kind: "connection", id: "link-b", fromId: "child-a", toId: "root", category: "contradicts" }),
  ]));
  expect(connections.map(item => item.id).sort()).toEqual(["link-a", "link-b", "link-hidden"]);
  const responses = page(related, "root", "responses").items;
  expect(responses.map(item => item.id).sort()).toEqual(["mixed-response", "safe-response"]);
  expect(JSON.stringify([children, connections, responses])).not.toContain("private-root");
  expect(JSON.stringify(responses)).not.toContain("private-safe-response");
  expect(knowledge(db)).toEqual(before);
}));

test("AI-normal visibility filters rejected endpoints, connections and shared-response members", () => fixture((db, related, rejection) => {
  rejection.rejectThought("user", "hidden");
  rejection.rejectConnection("user", "link-b");
  expect(page(related, "root", "connections").items.map(item => item.id)).toEqual(["link-a"]);
  expect(page(related, "root", "responses").items.map(item => item.id)).toEqual(["safe-response"]);
  expect(page(related, "child-a", "sources").items.map(item => item.id)).toEqual(["source"]);
  expect(() => related.related({ thoughtId: "hidden", relation: "children" })).toThrow();
  const before = knowledge(db);
  rejection.rejectThought("user", "root");
  const active = page(related, "child-a", "children");
  expect(active.items.map(item => item.id)).toEqual(["grandchild"]);
  expect(page(related, "child-a", "parent").items).toEqual([]);
  expect(page(related, "child-a", "sources").items.map(item => item.id)).toEqual(["source"]);
  expect(knowledge(db)).toEqual(before);
}));

test("relation pages bind opaque continuations to thought, relation, limit and corpus revision", () => fixture((db, related) => {
  const first = page(related, "root", "children", { limit: 1 });
  if (!first.nextCursor) throw new Error("missing relationship cursor");
  const next = page(related, "root", "children", { limit: 1, cursor: first.nextCursor });
  expect([...first.items, ...next.items].map(item => item.id).sort()).toEqual(["child-a", "child-b"]);
  expect(next.nextCursor).toBeNull();
  expect(() => related.related({ thoughtId: "root", relation: "connections", limit: 1, cursor: first.nextCursor })).toThrow();
  expect(() => related.related({ thoughtId: "child-a", relation: "children", limit: 1, cursor: first.nextCursor })).toThrow();
  expect(() => related.related({ thoughtId: "root", relation: "children", limit: 2, cursor: first.nextCursor })).toThrow();
  const [payload, signature] = first.nextCursor.split(".");
  if (!payload || !signature) throw new Error("invalid fixture cursor");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  for (const altered of [{ highWater: 0 }, { binding: '["other","children",1]' }, { id: "last-forged" }, { revision: 0 }]) {
    const forged = `${Buffer.from(JSON.stringify({ ...decoded, ...altered })).toString("base64url")}.${signature}`;
    expect(() => related.related({ thoughtId: "root", relation: "children", limit: 1, cursor: forged })).toThrow();
  }
  db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('later','fixture','user','captured-original','2030','fixture')");
  expect(related.related({ thoughtId: "root", relation: "children", limit: 1, cursor: first.nextCursor })).toEqual({ type: "retrieval-changed" });
}));

test("invalid relation input and caller-selected authority are rejected without changing ordinary Search", () => fixture((db, related) => {
  const before = knowledge(db);
  expect(() => related.related({ thoughtId: "root", relation: "children", limit: 0 })).toThrow();
  expect(() => related.related({ thoughtId: "root", relation: "children", limit: 101 })).toThrow();
  const withScope = { thoughtId: "root", relation: "children" as const, scope: "history" };
  expect(() => related.related(withScope)).toThrow();
  const extra = { thoughtId: "root", relation: "children" as const, unknown: true };
  expect(() => related.related(extra)).toThrow();
  const ordinary = new SearchService(new SqliteSearchRepository(db));
  expect(() => ordinary.query({ actor: "user", mode: "normal" }, "")).toThrow();
  expect(knowledge(db)).toEqual(before);
}));

test("default page bounds transfer without imposing a total relation count", () => fixture((db, related) => {
  const store = new SqliteStore(db);
  for (let i = 0; i < 26; i++) {
    const id = `extra-${i}`;
    store.saveThought({ id, text: "fixture", title: null, titleAuthor: null, author: "user", kind: "user-contribution", createdAt: "2030", origin: "fixture", parentId: "root", sourceIds: [] });
  }
  const first = page(related, "root", "children");
  expect(first.items).toHaveLength(25);
  if (!first.nextCursor) throw new Error("missing next relation page");
  expect(page(related, "root", "children", { cursor: first.nextCursor }).items.length).toBeGreaterThan(0);
}));

test.each(["connection-insert", "connection-category", "connection-delete", "source-insert"] as const)("%s invalidates a related cursor", kind => fixture((db, related) => {
  if (kind === "source-insert") {
    db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('unsealed','fixture','user','captured-original','2030','fixture')");
    db.run("INSERT INTO thought_titles VALUES ('unsealed',NULL,NULL)");
  }
  const first = page(related, "root", "connections", { limit: 1 });
  if (!first.nextCursor) throw new Error("missing relationship continuation");
  expect(page(related, "root", "connections", { limit: 1, cursor: first.nextCursor }).items.length).toBeGreaterThan(0);
  if (kind === "connection-insert") db.run("INSERT INTO connections VALUES ('added','root','source','related','user','fixture')");
  if (kind === "connection-category") db.run("UPDATE connections SET category='extends' WHERE id='link-a'");
  if (kind === "connection-delete") db.run("DELETE FROM connections WHERE id='link-a'");
  if (kind === "source-insert") db.run("INSERT INTO thought_sources VALUES ('unsealed',0,'source')");
  expect(related.related({ thoughtId: "root", relation: "connections", limit: 1, cursor: first.nextCursor })).toEqual({ type: "retrieval-changed" });
}));

test("no-op and rolled-back relation mutations preserve revision and live cursor", () => fixture((db, related) => {
  const first = page(related, "root", "connections", { limit: 1 });
  if (!first.nextCursor) throw new Error("missing relationship continuation");
  const revision = () => (db.query("SELECT retrieval FROM search_revisions WHERE id=1").get() as { retrieval: number }).retrieval;
  const before = revision(), continuation = page(related, "root", "connections", { limit: 1, cursor: first.nextCursor });
  db.run("UPDATE connections SET category=category WHERE id='link-a'");
  expect(revision()).toBe(before);
  expect(() => db.transaction(() => {
    db.run("UPDATE connections SET category='extends' WHERE id='link-a'");
    expect(revision()).toBeGreaterThan(before);
    throw new Error("owned rollback");
  })()).toThrow("owned rollback");
  expect(revision()).toBe(before);
  expect(page(related, "root", "connections", { limit: 1, cursor: first.nextCursor })).toEqual(continuation);
}));

test("a second owned SQLite connection invalidates a first connection's relation walk", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "related-two-connections-")), path = join(dir, "fixture.sqlite");
  try {
    fixture((_db, related) => {
      const first = page(related, "root", "connections", { limit: 1 });
      if (!first.nextCursor) throw new Error("missing relationship continuation");
      expect(page(related, "root", "connections", { limit: 1, cursor: first.nextCursor }).items.length).toBeGreaterThan(0);
      const second = new Database(path);
      try {
        migrate(second);
        second.run("UPDATE connections SET category='extends' WHERE id='link-a'");
        expect(related.related({ thoughtId: "root", relation: "connections", limit: 1, cursor: first.nextCursor })).toEqual({ type: "retrieval-changed" });
      } finally { second.close(); }
    }, path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("imported related references do not expose document bytes or locator metadata", () => fixture((db, related) => {
  const bytes = Buffer.from("imported wording\nPRIVATE-DOCUMENT"), thought = "imported wording";
  const namespace = (db.query("SELECT id FROM import_namespaces WHERE kind='loose-markdown'").get() as { id: string }).id;
  db.transaction(() => {
    db.run(`INSERT INTO import_documents(id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,created_at,parser_version,segmentation_method,segmentation_reason)
      VALUES ('doc',?,zeroblob(32),?,'utf-8',?,'private-locator.md','2030','fixture','structural','fixture')`, [bytes, bytes.length, namespace]);
    db.run("INSERT INTO import_locations VALUES (?,'private-locator.md','doc')", [namespace]);
    db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,import_document_id) VALUES ('imported',?,'source','imported-original','2030','markdown-import','doc')", [thought]);
    db.run("INSERT INTO thought_titles VALUES ('imported',NULL,NULL)");
    db.run("INSERT INTO thought_source_seals VALUES ('imported')");
    db.run("INSERT INTO import_document_parts VALUES ('doc',0,'thought',0,?,'imported',0)", [thought.length]);
    db.run("INSERT INTO import_document_parts VALUES ('doc',1,'separator',?,?,NULL,NULL)", [thought.length, bytes.length]);
    db.run("INSERT INTO import_document_seals VALUES ('doc')");
  }).immediate();
  db.run("INSERT INTO connections VALUES ('import-link','root','imported','related','user','fixture')");
  const items = page(related, "root", "connections").items;
  expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "import-link" })]));
  expect(JSON.stringify(items)).not.toContain("PRIVATE-DOCUMENT");
  expect(JSON.stringify(items)).not.toContain("private-locator.md");
}));
