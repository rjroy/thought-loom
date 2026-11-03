import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RejectionService } from "../src/domain/rejection";
import { TitleService } from "../src/domain/title";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";

// Internal FTS test seam: searchable thought_id/text/title and response_id/text.
// Discover the FTS5 table by its columns rather than dictating its name.
function index(db: Database, columns: readonly string[]): string {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND lower(sql) LIKE '%using fts5%'").all() as { name: string }[];
  const candidates = tables.filter(({ name }) => {
    const fields = db.query(`PRAGMA table_info(${JSON.stringify(name)})`).all() as { name: string }[];
    return columns.every(column => fields.some(field => field.name === column));
  });
  expect(candidates).toHaveLength(1);
  const selected = candidates[0];
  if (!selected) throw new Error(`Missing FTS5 index with columns ${columns.join(", ")}`);
  return selected.name;
}
function matching(db: Database, table: string, idColumn: string, query: string): string[] {
  const quoted = `"${table.replaceAll('"', '""')}"`;
  const id = `"${idColumn.replaceAll('"', '""')}"`;
  const rows = db.query(`SELECT ${id} AS id FROM ${quoted} WHERE ${quoted} MATCH ? ORDER BY ${id}`).all(query) as { id: string }[];
  return rows.map(row => row.id);
}
function temporary(action: (path: string) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "thoughtloom-search-"));
  try { action(join(dir, "owned.sqlite")); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function addThought(store: SqliteStore, id: string, text: string, title: string | null = null) {
  store.saveThought({ id, text, title, author: "user", kind: "captured-original", createdAt: "2030-01-01T00:00:00Z", origin: "test", parentId: null, sourceIds: [] });
}

describe("FTS5 index maintenance", () => {
  test("core migration indexes saved text, current titles and retained replies", () => temporary(path => {
    const db = new Database(path);
    try {
      migrate(db);
      const store = new SqliteStore(db);
      addThought(store, "alpha", "observatory luminous", "firstlabel");
      addThought(store, "beta", "garden verdant");
      store.saveResponse({ id: "reply", text: "nebula discussion", role: "addendum", state: "complete", thoughtIds: ["alpha", "beta"] });
      const thoughts = index(db, ["thought_id", "text", "title"]);
      const responses = index(db, ["response_id", "text"]);
      expect(matching(db, thoughts, "thought_id", "observatory")).toEqual(["alpha"]);
      expect(matching(db, thoughts, "thought_id", "lumin*")).toEqual(["alpha"]);
      expect(matching(db, thoughts, "thought_id", "firstlabel")).toEqual(["alpha"]);
      expect(matching(db, responses, "response_id", "nebula")).toEqual(["reply"]);
      const title = new TitleService(new SqliteTitleRepository(db));
      title.setUser("user", "alpha", "secondlabel");
      expect(matching(db, thoughts, "thought_id", "firstlabel")).toEqual([]);
      expect(matching(db, thoughts, "thought_id", "secondlabel")).toEqual(["alpha"]);
      title.setUser("user", "alpha", null);
      expect(matching(db, thoughts, "thought_id", "secondlabel")).toEqual([]);
      expect(matching(db, thoughts, "thought_id", "observatory")).toEqual(["alpha"]);
      title.fillAi("ai", "alpha", "thirdlabel");
      expect(matching(db, thoughts, "thought_id", "thirdlabel")).toEqual(["alpha"]);
      migrate(db);
      expect(matching(db, responses, "response_id", "nebula")).toEqual(["reply"]);
    } finally { db.close(); }
    const reopened = new Database(path);
    try {
      migrate(reopened);
      expect(matching(reopened, index(reopened, ["thought_id", "text", "title"]), "thought_id", "thirdlabel")).toEqual(["alpha"]);
      expect(matching(reopened, index(reopened, ["response_id", "text"]), "response_id", "nebula")).toEqual(["reply"]);
    } finally { reopened.close(); }
  }));

  test("failed thought and response writes do not leave searchable orphan documents", () => temporary(path => {
    const db = new Database(path);
    try {
      migrate(db);
      const store = new SqliteStore(db);
      addThought(store, "valid", "visibleword");
      const thoughts = index(db, ["thought_id", "text", "title"]);
      const responses = index(db, ["response_id", "text"]);
      expect(() => store.saveThought({ id: "bad", text: "orphanword", title: null, author: "ai", kind: "developing-idea", createdAt: "2030", origin: "test", parentId: "missing", sourceIds: [] })).toThrow(/foreign key/i);
      expect(() => store.saveResponse({ id: "bad-reply", text: "orphanreply", role: "addendum", state: "complete", thoughtIds: ["valid", "missing"] })).toThrow(/foreign key/i);
      expect(matching(db, thoughts, "thought_id", "orphanword")).toEqual([]);
      expect(matching(db, responses, "response_id", "orphanreply")).toEqual([]);
      expect(matching(db, thoughts, "thought_id", "visibleword")).toEqual(["valid"]);
    } finally { db.close(); }
  }));

  test("core migration backfills populated frozen legacy data without changing rejection or source records", () => temporary(path => {
    const db = new Database(path);
    try {
      // Pre-title, pre-shared-response schema; independent from the current migration.
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;
        CREATE TABLE thoughts(id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,title TEXT,author TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id));
        CREATE TRIGGER thoughts_immutable_update BEFORE UPDATE ON thoughts BEGIN SELECT RAISE(ABORT,'immutable'); END;
        CREATE TRIGGER thoughts_immutable_delete BEFORE DELETE ON thoughts BEGIN SELECT RAISE(ABORT,'immutable'); END;
        CREATE TABLE thought_sources(thought_id TEXT NOT NULL REFERENCES thoughts(id),position INTEGER NOT NULL,source_id TEXT NOT NULL REFERENCES thoughts(id),PRIMARY KEY(thought_id,position));
        CREATE TABLE responses(id TEXT PRIMARY KEY NOT NULL,thought_id TEXT NOT NULL REFERENCES thoughts(id),text TEXT NOT NULL,role TEXT NOT NULL);
        CREATE TRIGGER responses_immutable_update BEFORE UPDATE ON responses BEGIN SELECT RAISE(ABORT,'immutable'); END;
        CREATE TRIGGER responses_immutable_delete BEFORE DELETE ON responses BEGIN SELECT RAISE(ABORT,'immutable'); END;
        CREATE TABLE rejected_thoughts(thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id));
        INSERT INTO thoughts VALUES ('root','legacyword','legacytitle','user','captured-original','2026','capture',NULL),('child','childword',NULL,'ai','developing-idea','2027','development','root');
        INSERT INTO thought_sources VALUES ('child',0,'root');
        INSERT INTO responses VALUES ('reply','child','legacyreplyword','addendum');
        INSERT INTO rejected_thoughts VALUES ('root');`);
      migrate(db);
      expect(matching(db, index(db, ["thought_id", "text", "title"]), "thought_id", "legacytitle")).toEqual(["root"]);
      expect(matching(db, index(db, ["response_id", "text"]), "response_id", "legacyreplyword")).toEqual(["reply"]);
      const rejection = new RejectionService(new SqliteRejectionRepository(db));
      expect(rejection.listThoughts({ actor: "ai", mode: "normal" }).find(item => item.id === "child")).toMatchObject({ parentId: null, sourceIds: [] });
      expect(rejection.listThoughts({ actor: "user", mode: "history" }).map(item => item.id).sort()).toEqual(["child", "root"]);
      expect(new SqliteStore(db).getResponse("reply")).toEqual({ id: "reply", text: "legacyreplyword", role: "addendum", state: "complete", thoughtIds: ["child"] });
      migrate(db);
      expect(matching(db, index(db, ["response_id", "text"]), "response_id", "legacyreplyword")).toEqual(["reply"]);
    } finally { db.close(); }
  }));
});
