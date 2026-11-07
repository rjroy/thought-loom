import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BranchConfirmationError, RejectionService } from "../src/domain/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { links, responses, thoughts } from "./rejection-fixtures";

const databases: Database[] = [];
const directories: string[] = [];
const user = { actor: "user", mode: "normal" } as const;
const inspect = { actor: "user", mode: "show-rejected" } as const;
const ai = { actor: "ai", mode: "normal" } as const;
const sorted = (ids: readonly string[]) => [...ids].sort();
function open(path = ":memory:") {
  const db = new Database(path);
  databases.push(db);
  migrate(db);
  return { db, store: new SqliteStore(db), service: new RejectionService(new SqliteRejectionRepository(db)) };
}
function seed(store: SqliteStore) {
  // The child supports itself with a separate root, so referenced thoughts must exist first.
  for (const index of [0, 4, 1, 2, 3]) {
    const thought = thoughts[index];
    if (thought === undefined) throw new Error("invalid test fixture");
    store.saveThought(thought);
  }
  for (const link of links) store.saveConnection(link);
  for (const response of responses) store.saveResponse(response);
}
function close(db: Database) {
  db.close();
  const index = databases.indexOf(db);
  if (index >= 0) databases.splice(index, 1);
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close(false);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("rejection and independent connection state survive reopen without modifying recorded content", () => {
  const dir = mkdtempSync(join("/tmp/opencode", "thought-loom-rejection-"));
  directories.push(dir);
  const path = join(dir, "thoughts.sqlite");
  const first = open(path);
  seed(first.store);
  first.service.rejectConnection("user", "cross");
  first.service.rejectThought("user", "root");
  expect(first.service.listThoughts(user).map(t => t.id)).not.toContain("root");
  close(first.db);

  const second = open(path);
  expect(second.service.listThoughts(user).map(t => t.id)).not.toContain("root");
  expect(sorted(second.service.listThoughts(inspect).map(t => t.id))).toEqual(["child", "grandchild", "outside", "root", "sibling"]);
  expect(second.service.getResponse(ai, "root-response")).toBeNull();
  expect(second.service.getResponse(inspect, "root-response")?.text).toBe("private root response");
  expect(second.service.listThoughts(ai).find(t => t.id === "child")?.sourceIds).toEqual(["outside"]);
  expect(second.store.getThought("child")?.sourceIds).toEqual(["root", "outside"]);
  expect(() => second.db.run("UPDATE thoughts SET text = 'rewritten' WHERE id = 'root'")).toThrow(/immutable/i);
  second.service.restoreThought("user", "root");
  expect(second.service.listConnections(user).map(c => c.id)).not.toContain("cross");
  second.service.restoreConnection("user", "cross");
  expect(sorted(second.service.listConnections(user).map(c => c.id))).toEqual(["cross", "within"]);
  close(second.db);
  const third = open(path);
  expect(sorted(third.service.listConnections(user).map(c => c.id))).toEqual(["cross", "within"]);
  expect(third.store.getThought("root")?.text).toBe("private text root");
});

test("a new descendant invalidates a preview and rejection is all-or-nothing", () => {
  const { store, service } = open();
  seed(store);
  const preview = service.previewBranch("user", "child");
  const original = thoughts[1];
  if (original === undefined || original.kind === "media-original") throw new Error("invalid text test fixture");
  store.saveThought({ ...original, id: "new-child", parentId: "child", sourceIds: [] });
  expect(() => service.rejectBranch("user", preview)).toThrow(BranchConfirmationError);
  expect(sorted(service.listThoughts(user).map(t => t.id))).toEqual(["child", "grandchild", "new-child", "outside", "root", "sibling"]);
  const fresh = service.previewBranch("user", "child");
  expect(sorted(fresh.affectedIds)).toEqual(["child", "grandchild", "new-child"]);
  expect(fresh.count).toBe(3);
  service.rejectBranch("user", fresh);
  expect(sorted(service.listThoughts(user).map(t => t.id))).toEqual(["outside", "root", "sibling"]);
});

test("outer SQLite transaction rollback leaves no partial branch rejection", () => {
  const { db, store, service } = open();
  seed(store);
  const preview = service.previewBranch("user", "root");
  expect(() => db.transaction(() => {
    service.rejectBranch("user", preview);
    throw new Error("rollback test");
  })()).toThrow("rollback test");
  expect(sorted(service.listThoughts(user).map(t => t.id))).toEqual(["child", "grandchild", "outside", "root", "sibling"]);
  expect(sorted(service.listConnections(user).map(c => c.id))).toEqual(["cross", "within"]);
});
