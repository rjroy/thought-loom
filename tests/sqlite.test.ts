import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Thought } from "../src/domain/thought";
import type { Connection } from "../src/domain/connection";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const root: Thought = {
  id: "root", text: "Original words", title: null, author: "user",
  kind: "captured-original", createdAt: "2026-01-01T00:00:00.000Z",
  origin: "test capture", parentId: null, sourceIds: [],
};
const child: Thought = {
  id: "child", text: "A development", title: "Development", author: "ai",
  kind: "developing-idea", createdAt: "2026-01-02T00:00:00.000Z",
  origin: "test discussion", parentId: "root", sourceIds: [],
};
const snapshot = (thought: Thought, titleAuthor: "user" | "ai" | null) => ({ ...thought, titleAuthor });
const databases: Database[] = [];
const directories: string[] = [];
function open(path = ":memory:"): { db: Database; store: SqliteStore } {
  const db = new Database(path);
  databases.push(db);
  migrate(db);
  return { db, store: new SqliteStore(db) };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close(false);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite foundation", () => {
  test("migration bootstraps the schema and is safe to repeat without changing data", () => {
    const db = new Database(":memory:");
    databases.push(db);
    migrate(db);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    const columns = db.query("PRAGMA table_info(thoughts)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["id", "text", "author", "kind", "created_at", "origin", "parent_id"]));
    expect(columns.map(column => column.name)).not.toContain("title");
    const titleColumns = db.query("PRAGMA table_info(thought_titles)").all() as { name: string }[];
    expect(titleColumns.map(column => column.name)).toEqual(["thought_id", "title", "title_author"]);
    const store = new SqliteStore(db);
    store.saveThought(root);
    migrate(db);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(store.getThought(root.id)).toEqual(snapshot(root, null));
  });

  test("bootstraps idempotently, enables foreign keys and preserves branching and sources", () => {
    const { db, store } = open();
    store.saveThought(root);
    store.saveThought(child);
    const branch: Thought = { ...child, id: "branch", text: "Another development", author: "user", sourceIds: ["child"] };
    store.saveThought(branch);
    migrate(db);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(store.getThought("root")).toEqual(snapshot(root, null));
    expect(store.getThought("child")).toEqual(snapshot(child, "ai"));
    expect(store.getThought("branch")).toEqual(snapshot(branch, "user"));
    expect(store.getThought("missing")).toBeNull();
    expect(() => store.saveThought({ ...child, id: "orphan", parentId: "missing" })).toThrow(/foreign key constraint failed/i);
    expect(() => store.saveThought({ ...child, id: "bad-source", sourceIds: ["missing"] })).toThrow(/foreign key constraint failed/i);
  });

  test("stores categorized connections separately with direction and supporting thoughts", () => {
    const { store } = open();
    store.saveThought(root);
    store.saveThought(child);
    for (const category of ["supports", "contradicts", "extends", "related"] as const) {
      const connection: Connection = { id: category, fromId: "child", toId: "root", category, proposedBy: "ai", explanation: `Why ${category}`, sourceIds: ["root"] };
      store.saveConnection(connection);
      expect(store.getConnection(category)).toEqual(connection);
    }
    expect(store.getThought("child")).toEqual(snapshot(child, "ai"));
    expect(() => store.saveConnection({ id: "bad", fromId: "child", toId: "missing", category: "related", proposedBy: "user", explanation: "reason", sourceIds: [] })).toThrow(/foreign key constraint failed/i);
    expect(() => store.saveConnection({ id: "bad-origin", fromId: "missing", toId: "root", category: "related", proposedBy: "user", explanation: "reason", sourceIds: [] })).toThrow(/foreign key constraint failed/i);
    expect(() => store.saveConnection({ id: "bad-source", fromId: "child", toId: "root", category: "related", proposedBy: "user", explanation: "reason", sourceIds: ["missing"] })).toThrow(/foreign key constraint failed/i);
  });

  test("retains both a development addendum and a no-development fallback response", () => {
    const { store } = open();
    store.saveThought(root);
    store.saveThought(child);
    const addendum = { id: "r1", thoughtId: "child", text: "Full AI response accompanying development", role: "addendum" } as const;
    const fallback = { id: "r2", thoughtId: "root", text: "Full response where no development was recorded", role: "fallback" } as const;
    store.saveResponse(addendum);
    store.saveResponse(fallback);
    expect(store.getResponse("r1")).toEqual(addendum);
    expect(store.getResponse("r2")).toEqual(fallback);
    expect(() => store.saveResponse({ ...addendum, id: "bad", thoughtId: "missing" })).toThrow(/foreign key constraint failed/i);
  });

  test("persists data across close and reopen", () => {
    const dir = mkdtempSync(join("/tmp/opencode", "thought-loom-test-"));
    directories.push(dir);
    const path = join(dir, "thoughts.sqlite");
    const first = open(path);
    first.store.saveThought(root);
    const sourcedChild = { ...child, sourceIds: ["root"] };
    const connection: Connection = { id: "persistent-link", fromId: "child", toId: "root", category: "supports", proposedBy: "ai", explanation: "supporting context", sourceIds: ["root"] };
    const addendum = { id: "persistent-response", thoughtId: "child", text: "Full response", role: "addendum" } as const;
    first.store.saveThought(sourcedChild);
    first.store.saveConnection(connection);
    first.store.saveResponse(addendum);
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const second = open(path);
    expect(second.store.getThought("root")).toEqual(snapshot(root, null));
    expect(second.store.getThought("child")).toEqual(snapshot(sourcedChild, "ai"));
    expect(second.store.getConnection(connection.id)).toEqual(connection);
    expect(second.store.getResponse(addendum.id)).toEqual(addendum);
  });

  test.each([
    ["replace a source", "UPDATE thought_sources SET source_id = 'other' WHERE thought_id = 'child' AND position = 0"],
    ["move a source to another thought", "UPDATE thought_sources SET thought_id = 'other' WHERE thought_id = 'child' AND position = 0"],
    ["reorder a source", "UPDATE thought_sources SET position = 1 WHERE thought_id = 'child' AND position = 0"],
    ["delete a source", "DELETE FROM thought_sources WHERE thought_id = 'child' AND position = 0"],
    ["append a source after saving", "INSERT INTO thought_sources (thought_id, position, source_id) VALUES ('child', 1, 'other')"],
  ])("cannot %s on a saved thought", (_description, sql) => {
    const { db, store } = open();
    store.saveThought(root);
    const other: Thought = { ...root, id: "other", text: "Another source" };
    store.saveThought(other);
    const sourcedChild: Thought = { ...child, sourceIds: ["root"] };
    store.saveThought(sourcedChild);
    const columns = db.query("PRAGMA table_info(thought_sources)").all() as { name: string }[];
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(["thought_id", "position", "source_id"]));
    expect(db.query("SELECT thought_id, position, source_id FROM thought_sources WHERE thought_id = 'child'").all()).toEqual([
      { thought_id: "child", position: 0, source_id: "root" },
    ]);
    expect(() => db.run(sql)).toThrow(/immutable/i);
    expect(store.getThought("child")).toEqual(snapshot(sourcedChild, "ai"));
    expect(store.getThought("other")).toEqual(snapshot(other, null));
  });

  test("adding a separate connection does not alter saved thought provenance", () => {
    const { store } = open();
    store.saveThought(root);
    const sourcedChild: Thought = { ...child, sourceIds: ["root"] };
    store.saveThought(sourcedChild);
    const connection: Connection = { id: "later-link", fromId: "child", toId: "root", category: "related", proposedBy: "user", explanation: "A separate link", sourceIds: ["root"] };
    store.saveConnection(connection);
    expect(store.getConnection(connection.id)).toEqual(connection);
    expect(store.getThought("child")).toEqual(snapshot(sourcedChild, "ai"));
  });

  test.each([
    ["text", "UPDATE responses SET text = 'rewritten' WHERE id = 'response'"],
    ["owner", "UPDATE responses SET thought_id = 'child' WHERE id = 'response'"],
    ["identity", "UPDATE responses SET id = 'rewritten' WHERE id = 'response'"],
    ["role", "UPDATE responses SET role = 'addendum' WHERE id = 'response'"],
    ["deletion", "DELETE FROM responses WHERE id = 'response'"],
  ])("prevents fallback response %s changes", (_description, sql) => {
    const { db, store } = open();
    store.saveThought(root);
    store.saveThought(child);
    const fallback = { id: "response", thoughtId: "root", text: "Recorded fallback development", role: "fallback" } as const;
    store.saveResponse(fallback);
    const columns = db.query("PRAGMA table_info(responses)").all() as { name: string }[];
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(["id", "thought_id", "text", "role"]));
    expect(db.query("SELECT id, thought_id, text, role FROM responses WHERE id = 'response'").get()).toEqual({
      id: "response", thought_id: "root", text: fallback.text, role: "fallback",
    });
    expect(() => db.run(sql)).toThrow(/immutable/i);
    expect(store.getResponse("response")).toEqual(fallback);
    expect(store.getResponse("rewritten")).toBeNull();
  });

  test.each([
    ["overwrite", "UPDATE responses SET text = 'rewritten' WHERE id = 'addendum'"],
    ["delete", "DELETE FROM responses WHERE id = 'addendum'"],
  ])("cannot %s a retained response addendum", (_description, sql) => {
    const { db, store } = open();
    store.saveThought(root);
    store.saveThought(child);
    const addendum = { id: "addendum", thoughtId: "child", text: "Full retained response", role: "addendum" } as const;
    store.saveResponse(addendum);
    expect(store.getResponse("addendum")).toEqual(addendum);
    expect(() => db.run(sql)).toThrow(/immutable/i);
    expect(store.getResponse("addendum")).toEqual(addendum);
  });

  test("prevents direct SQL overwrite, reparenting and deletion of recorded thoughts", () => {
    const { db, store } = open();
    store.saveThought(root);
    store.saveThought(child);
    // The storage contract exposes the thoughts table for database-level invariants.
    const columns = db.query("PRAGMA table_info(thoughts)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["id", "text", "author", "kind", "created_at", "origin", "parent_id"]));
    expect(columns.map(column => column.name)).not.toContain("title");
    expect(db.query("SELECT thought_id, title, title_author FROM thought_titles WHERE thought_id = 'child'").get()).toEqual({ thought_id: "child", title: "Development", title_author: "ai" });
    expect(db.query("SELECT id, text, author, created_at, parent_id FROM thoughts WHERE id = ?").get("child")).toEqual({
      id: child.id, text: child.text, author: child.author, created_at: child.createdAt, parent_id: child.parentId,
    });
    for (const sql of [
      "UPDATE thoughts SET text = 'rewritten' WHERE id = 'child'",
      "UPDATE thoughts SET parent_id = NULL WHERE id = 'child'",
      "UPDATE thoughts SET author = 'user' WHERE id = 'child'",
      "UPDATE thoughts SET kind = 'user-contribution' WHERE id = 'child'",
      "UPDATE thoughts SET created_at = '2000-01-01' WHERE id = 'child'",
      "UPDATE thoughts SET origin = 'rewritten' WHERE id = 'child'",
      "UPDATE thoughts SET id = 'rewritten' WHERE id = 'child'",
      "DELETE FROM thoughts WHERE id = 'child'",
    ]) {
      // Trigger diagnostics distinguish the intended invariant from SQL or schema errors.
      expect(() => db.run(sql)).toThrow(/immutable/i);
      expect(store.getThought("child")).toEqual(snapshot(child, "ai"));
    }
    expect(() => store.saveThought({ ...child, text: "overwrite" })).toThrow(/unique constraint failed|immutable/i);
    expect(store.getThought("child")).toEqual(snapshot(child, "ai"));
  });
});
