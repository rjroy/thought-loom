import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RejectionService } from "../src/domain/rejection";
import type { SharedResponse } from "../src/domain/shared-response";
import { SqliteSharedResponses } from "../src/storage/shared-response";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteRejectionRepository } from "../src/storage/rejection";

// Frozen pre-shared-response schemas: legacy inline titles and current separate title metadata.
const commonSchema = `
 CREATE TRIGGER thoughts_immutable_update BEFORE UPDATE ON thoughts BEGIN SELECT RAISE(ABORT,'thoughts are immutable'); END;
 CREATE TRIGGER thoughts_immutable_delete BEFORE DELETE ON thoughts BEGIN SELECT RAISE(ABORT,'thoughts are immutable'); END;
 CREATE TABLE thought_sources (thought_id TEXT NOT NULL REFERENCES thoughts(id), position INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES thoughts(id), PRIMARY KEY(thought_id,position));
 CREATE TABLE thought_source_seals (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id));
 CREATE TRIGGER thought_source_seals_immutable_update BEFORE UPDATE ON thought_source_seals BEGIN SELECT RAISE(ABORT,'thought source seals are immutable'); END;
 CREATE TRIGGER thought_source_seals_immutable_delete BEFORE DELETE ON thought_source_seals BEGIN SELECT RAISE(ABORT,'thought source seals are immutable'); END;
 CREATE TRIGGER thought_sources_immutable_insert BEFORE INSERT ON thought_sources WHEN EXISTS(SELECT 1 FROM thought_source_seals WHERE thought_id=NEW.thought_id) BEGIN SELECT RAISE(ABORT,'thought sources are immutable'); END;
 CREATE TRIGGER thought_sources_immutable_update BEFORE UPDATE ON thought_sources BEGIN SELECT RAISE(ABORT,'thought sources are immutable'); END;
 CREATE TRIGGER thought_sources_immutable_delete BEFORE DELETE ON thought_sources BEGIN SELECT RAISE(ABORT,'thought sources are immutable'); END;
 CREATE TABLE connections (id TEXT PRIMARY KEY NOT NULL, from_id TEXT NOT NULL REFERENCES thoughts(id), to_id TEXT NOT NULL REFERENCES thoughts(id), category TEXT NOT NULL CHECK(category IN ('supports','contradicts','extends','related')), proposed_by TEXT NOT NULL CHECK(proposed_by IN ('user','ai')), explanation TEXT NOT NULL);
 CREATE TABLE connection_sources (connection_id TEXT NOT NULL REFERENCES connections(id), position INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES thoughts(id), PRIMARY KEY(connection_id,position));
 CREATE TABLE responses (id TEXT PRIMARY KEY NOT NULL, thought_id TEXT NOT NULL REFERENCES thoughts(id), text TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('addendum','fallback')));
 CREATE TRIGGER responses_immutable_update BEFORE UPDATE ON responses BEGIN SELECT RAISE(ABORT,'responses are immutable'); END;
 CREATE TRIGGER responses_immutable_delete BEFORE DELETE ON responses BEGIN SELECT RAISE(ABORT,'responses are immutable'); END;
 CREATE TABLE rejected_thoughts (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id));
 CREATE TABLE rejected_connections (connection_id TEXT PRIMARY KEY NOT NULL REFERENCES connections(id));
`;
const oldThoughts = `CREATE TABLE thoughts (id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,title TEXT,author TEXT NOT NULL CHECK(author IN ('user','ai')),kind TEXT NOT NULL CHECK(kind IN ('captured-original','user-contribution','ai-interpretation','developing-idea')),created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id),CHECK(parent_id IS NULL OR parent_id != id));`;
const currentThoughts = `CREATE TABLE thoughts (id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,author TEXT NOT NULL CHECK(author IN ('user','ai')),kind TEXT NOT NULL CHECK(kind IN ('captured-original','user-contribution','ai-interpretation','developing-idea')),created_at TEXT NOT NULL,origin TEXT NOT NULL,parent_id TEXT REFERENCES thoughts(id),CHECK(parent_id IS NULL OR parent_id != id));
 CREATE TABLE thought_titles (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id), title TEXT, title_author TEXT CHECK(title_author IN ('user','ai')),CHECK((title IS NULL AND title_author IS NULL) OR (title IS NOT NULL AND title_author IS NOT NULL)));`;

function seedOld(db: Database, legacy: boolean) {
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; ${legacy ? oldThoughts : currentThoughts} ${commonSchema}`);
  if (legacy) db.exec(`INSERT INTO thoughts VALUES ('root','root words','root title','user','captured-original','2026-01-01','capture',NULL),('child','child words','child title','ai','developing-idea','2026-01-02','development','root');`);
  else db.exec(`INSERT INTO thoughts VALUES ('root','root words','user','captured-original','2026-01-01','capture',NULL),('child','child words','ai','developing-idea','2026-01-02','development','root'); INSERT INTO thought_titles VALUES ('root','root title','user'),('child','child title','ai');`);
  db.exec(`INSERT INTO thought_sources VALUES ('child',0,'root'); INSERT INTO thought_source_seals VALUES ('root'),('child');
   INSERT INTO connections VALUES ('link','root','child','supports','ai','reason'); INSERT INTO connection_sources VALUES ('link',0,'root');
   INSERT INTO responses VALUES ('response','child','legacy response','addendum'),('fallback','root','legacy fallback','fallback');
   INSERT INTO rejected_thoughts VALUES ('root'); INSERT INTO rejected_connections VALUES ('link');`);
}

function temporary(action: (path: string) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "shared-responses-"));
  try { action(join(dir, "isolated.sqlite")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const complete = (id: string, thoughtIds: readonly string[]): SharedResponse => ({ id, text: "one canonical response", role: "addendum", state: "complete", thoughtIds });
const unknownValue = (value: unknown): unknown => value;

describe("shared response SQLite", () => {
  test.each([true, false])("migrates frozen inline-title or separate-title schema without data loss (legacy=%s)", legacy => {
    temporary(path => {
      let db = new Database(path);
      try {
        seedOld(db, legacy);
        migrate(db);
        const store = new SqliteStore(db);
        const scoped = new RejectionService(new SqliteRejectionRepository(db));
        expect(store.getThought("root")).toEqual({ id: "root", text: "root words", title: "root title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2026-01-01", origin: "capture", parentId: null, sourceIds: [] });
        expect(store.getThought("child")).toEqual({ id: "child", text: "child words", title: "child title", titleAuthor: "ai", author: "ai", kind: "developing-idea", createdAt: "2026-01-02", origin: "development", parentId: "root", sourceIds: ["root"] });
        expect(store.getConnection("link")).toEqual({ id: "link", fromId: "root", toId: "child", category: "supports", proposedBy: "ai", explanation: "reason", sourceIds: ["root"] });
        expect(unknownValue(store.getResponse("response"))).toEqual({ id: "response", thoughtIds: ["child"], text: "legacy response", role: "addendum", state: "complete" });
        expect(unknownValue(store.getResponse("fallback"))).toEqual({ id: "fallback", thoughtIds: ["root"], text: "legacy fallback", role: "fallback", state: "complete" });
        expect(unknownValue(scoped.getResponse({ actor: "ai", mode: "normal" }, "response"))).toEqual({ id: "response", thoughtIds: ["child"], text: "legacy response", role: "addendum", state: "complete" });
        expect(scoped.getResponse({ actor: "ai", mode: "normal" }, "fallback")).toBeNull();
        expect(scoped.listConnections({ actor: "user", mode: "normal" })).toEqual([]);
        expect(scoped.listConnections({ actor: "user", mode: "history" }).map(item => item.id)).toEqual(["link"]);
        expect(() => db.run("INSERT OR REPLACE INTO thought_sources VALUES ('child',0,'root')")).toThrow(/immutable/i);
        expect(() => db.run("UPDATE responses SET text='overwrite' WHERE id='response'")).toThrow(/immutable/i);
        db.close();
        db = new Database(path);
        migrate(db);
        migrate(db);
        expect(unknownValue(new SqliteStore(db).getResponse("response"))).toEqual({ id: "response", thoughtIds: ["child"], text: "legacy response", role: "addendum", state: "complete" });
        expect(unknownValue(new SqliteStore(db).getResponse("fallback"))).toEqual({ id: "fallback", thoughtIds: ["root"], text: "legacy fallback", role: "fallback", state: "complete" });
      } finally { db.close(); }
    });
  });

  test("fresh saves are atomic, ordered, sealed, scoped and durable", () => {
    temporary(path => {
      let db = new Database(path);
      try {
        migrate(db);
        const store = new SqliteStore(db);
        for (const [id, createdAt] of [["z", "2030"], ["a", "2040"], ["m", "2020"]]) {
          store.saveThought({ id, text: `text ${id}`, title: null, author: "ai", kind: "developing-idea", createdAt, origin: "test", parentId: null, sourceIds: [] });
        }
        const shared = new SqliteSharedResponses(db);
        const response = complete("shared", ["z", "a", "m"]);
        shared.save(response);
        expect(shared.get("shared")).toEqual(response);
        expect(unknownValue(store.getResponse("shared"))).toEqual(response);
        expect(db.query("SELECT COUNT(*) AS n FROM responses WHERE id='shared' AND text='one canonical response'").get()).toEqual({ n: 1 });
        // Fixed schema seam for direct-SQL immutability: response_thoughts(response_id, thought_id, position).
        expect(db.query("SELECT thought_id,position FROM response_thoughts WHERE response_id='shared' ORDER BY position").all()).toEqual([{ thought_id: "z", position: 0 }, { thought_id: "a", position: 1 }, { thought_id: "m", position: 2 }]);
        for (const sql of ["UPDATE response_thoughts SET position=9 WHERE response_id='shared' AND thought_id='z'", "UPDATE response_thoughts SET thought_id='z' WHERE response_id='shared' AND thought_id='a'", "DELETE FROM response_thoughts WHERE response_id='shared' AND thought_id='z'", "INSERT INTO response_thoughts VALUES ('shared','z',3)", "INSERT OR REPLACE INTO response_thoughts VALUES ('shared','z',0)", "INSERT OR REPLACE INTO responses (id,text,role,state) VALUES ('shared','overwrite','addendum','complete')"]) {
          expect(() => db.run(sql)).toThrow(/immutable|sealed/i);
        }
        expect(() => shared.save(complete("invalid", ["z", "missing"]))).toThrow(/foreign key/i);
        expect(shared.get("invalid")).toBeNull();
        expect(db.query("SELECT COUNT(*) AS n FROM responses WHERE id='invalid'").get()).toEqual({ n: 0 });
        const interrupted: SharedResponse = { id: "partial", text: "partial text", role: "fallback", state: "interrupted", thoughtIds: ["a"] };
        shared.save(interrupted);
        expect(shared.get("partial")).toEqual(interrupted);
        const scoped = new RejectionService(new SqliteRejectionRepository(db));
        scoped.rejectThought("user", "a");
        expect(unknownValue(scoped.getResponse({ actor: "user", mode: "normal" }, "shared"))).toEqual({ ...response, thoughtIds: ["z", "m"] });
        expect(scoped.getResponse({ actor: "ai", mode: "normal" }, "shared")).toBeNull();
        expect(unknownValue(scoped.getResponse({ actor: "user", mode: "show-rejected" }, "shared"))).toEqual(response);
        scoped.restoreThought("user", "a");
        expect(unknownValue(scoped.getResponse({ actor: "ai", mode: "normal" }, "shared"))).toEqual(response);
        db.close();
        db = new Database(path);
        migrate(db);
        expect(new SqliteSharedResponses(db).get("shared")).toEqual(response);
        expect(new SqliteSharedResponses(db).get("partial")).toEqual(interrupted);
      } finally { db.close(); }
    });
  });
});
