import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TitleConflictError, TitleNotFoundError, TitleService } from "../src/domain/title";
import { RejectionService } from "../src/domain/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteTitleRepository } from "../src/storage/title";

// Joined snapshots gain titleAuthor in this slice; Phase 1's type is not changed by RED scaffolding.
function joined(value: unknown): unknown { return value; }

// Frozen pre-title-metadata schema, independent of the current migrate implementation.
const oldSchema = `
 PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;
 CREATE TABLE thoughts (id TEXT PRIMARY KEY NOT NULL, text TEXT NOT NULL, title TEXT, author TEXT NOT NULL CHECK(author IN ('user','ai')), kind TEXT NOT NULL CHECK(kind IN ('captured-original','user-contribution','ai-interpretation','developing-idea')), created_at TEXT NOT NULL, origin TEXT NOT NULL, parent_id TEXT REFERENCES thoughts(id), CHECK(parent_id IS NULL OR parent_id != id));
 CREATE TRIGGER thoughts_immutable_update BEFORE UPDATE ON thoughts BEGIN SELECT RAISE(ABORT,'thoughts are immutable'); END;
 CREATE TRIGGER thoughts_immutable_delete BEFORE DELETE ON thoughts BEGIN SELECT RAISE(ABORT,'thoughts are immutable'); END;
 CREATE TABLE thought_sources (thought_id TEXT NOT NULL REFERENCES thoughts(id), position INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES thoughts(id), PRIMARY KEY(thought_id, position));
 CREATE TABLE thought_source_seals (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id));
 CREATE TRIGGER thought_source_seals_immutable_update BEFORE UPDATE ON thought_source_seals BEGIN SELECT RAISE(ABORT,'thought source seals are immutable'); END;
 CREATE TRIGGER thought_source_seals_immutable_delete BEFORE DELETE ON thought_source_seals BEGIN SELECT RAISE(ABORT,'thought source seals are immutable'); END;
 CREATE TRIGGER thought_sources_immutable_insert BEFORE INSERT ON thought_sources WHEN EXISTS (SELECT 1 FROM thought_source_seals WHERE thought_id=NEW.thought_id) BEGIN SELECT RAISE(ABORT,'thought sources are immutable'); END;
 CREATE TRIGGER thought_sources_immutable_update BEFORE UPDATE ON thought_sources BEGIN SELECT RAISE(ABORT,'thought sources are immutable'); END;
 CREATE TRIGGER thought_sources_immutable_delete BEFORE DELETE ON thought_sources BEGIN SELECT RAISE(ABORT,'thought sources are immutable'); END;
 CREATE TABLE connections (id TEXT PRIMARY KEY NOT NULL, from_id TEXT NOT NULL REFERENCES thoughts(id), to_id TEXT NOT NULL REFERENCES thoughts(id), category TEXT NOT NULL CHECK(category IN ('supports','contradicts','extends','related')), proposed_by TEXT NOT NULL CHECK(proposed_by IN ('user','ai')), explanation TEXT NOT NULL);
 CREATE TABLE connection_sources (connection_id TEXT NOT NULL REFERENCES connections(id), position INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES thoughts(id), PRIMARY KEY(connection_id, position));
 CREATE TABLE responses (id TEXT PRIMARY KEY NOT NULL, thought_id TEXT NOT NULL REFERENCES thoughts(id), text TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('addendum','fallback')));
 CREATE TRIGGER responses_immutable_update BEFORE UPDATE ON responses BEGIN SELECT RAISE(ABORT,'responses are immutable'); END;
 CREATE TRIGGER responses_immutable_delete BEFORE DELETE ON responses BEGIN SELECT RAISE(ABORT,'responses are immutable'); END;
 CREATE TABLE rejected_thoughts (thought_id TEXT PRIMARY KEY NOT NULL REFERENCES thoughts(id));
 CREATE TABLE rejected_connections (connection_id TEXT PRIMARY KEY NOT NULL REFERENCES connections(id));
 INSERT INTO thoughts VALUES ('root','original words','User legacy','user','captured-original','2026-01-01','capture',NULL),('child','AI words','AI legacy','ai','developing-idea','2026-01-02','agent','root'),('empty','empty title words',NULL,'user','user-contribution','2026-01-03','capture','child');
 INSERT INTO thought_sources VALUES ('child',0,'root'),('empty',0,'root'),('empty',1,'child');
 INSERT INTO thought_source_seals VALUES ('root'),('child'),('empty');
 INSERT INTO connections VALUES ('link','root','child','supports','ai','private rationale');
 INSERT INTO connection_sources VALUES ('link',0,'root');
 INSERT INTO responses VALUES ('response','child','private addendum','addendum');
 INSERT INTO rejected_thoughts VALUES ('root');
 INSERT INTO rejected_connections VALUES ('link');
`;

describe("title migration and SQLite boundary", () => {
  test("legacy data migrates once, survives reopen and keeps immutable core and rejection projections", () => {
    const dir = mkdtempSync(join("/tmp/opencode", "thoughtloom-titles-"));
    const path = join(dir, "legacy.sqlite");
    let db: Database | undefined;
    try {
      db = new Database(path);
      db.exec(oldSchema);
      migrate(db);
      const store = new SqliteStore(db);
      const title = new TitleService(new SqliteTitleRepository(db));
      const rejection = new RejectionService(new SqliteRejectionRepository(db));
      expect(joined(store.getThought("root"))).toEqual({ id: "root", text: "original words", title: "User legacy", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2026-01-01", origin: "capture", parentId: null, sourceIds: [] });
      expect(joined(store.getThought("child"))).toEqual({ id: "child", text: "AI words", title: "AI legacy", titleAuthor: "ai", author: "ai", kind: "developing-idea", createdAt: "2026-01-02", origin: "agent", parentId: "root", sourceIds: ["root"] });
      expect(joined(store.getThought("empty"))).toEqual({ id: "empty", text: "empty title words", title: null, titleAuthor: null, author: "user", kind: "user-contribution", createdAt: "2026-01-03", origin: "capture", parentId: "child", sourceIds: ["root", "child"] });
      expect(store.getConnection("link")).toEqual({ id: "link", fromId: "root", toId: "child", category: "supports", proposedBy: "ai", explanation: "private rationale", sourceIds: ["root"] });
      expect(store.getResponse("response")).toEqual({ id: "response", thoughtIds: ["child"], state: "complete", role: "addendum", text: "private addendum" });
      expect(rejection.getResponse({ actor: "ai", mode: "normal" }, "response")?.text).toBe("private addendum");
      expect(rejection.listConnections({ actor: "user", mode: "normal" })).toEqual([]);
      expect(rejection.listConnections({ actor: "user", mode: "history" }).map(item => item.id)).toEqual(["link"]);
      const ai = rejection.listThoughts({ actor: "ai", mode: "normal" });
      expect(ai.map(item => item.id).sort()).toEqual(["child", "empty"]);
      expect(joined(ai.find(item => item.id === "child"))).toMatchObject({ parentId: null, sourceIds: [], title: "AI legacy", titleAuthor: "ai" });
      expect(JSON.stringify(ai)).not.toContain("User legacy");
      expect(title.setUser("user", "child", "Human revision")).toEqual({ title: "Human revision", titleAuthor: "user" });
      expect(joined(rejection.listThoughts({ actor: "user", mode: "history" }).find(item => item.id === "child"))).toMatchObject({ title: "Human revision", titleAuthor: "user", author: "ai", text: "AI words", parentId: "root", sourceIds: ["root"] });
      expect(title.setUser("user", "root", null)).toEqual({ title: null, titleAuthor: null });
      expect(() => title.fillAi("ai", "root", "rejected title")).toThrow(TitleNotFoundError);
      expect(() => title.fillAi("ai", "child", "late generation")).toThrow(TitleConflictError);
      const cols = db.query("PRAGMA table_info(thoughts)").all() as { name: string }[];
      expect(cols.map(column => column.name)).not.toContain("title");
      expect(() => db?.run("UPDATE thoughts SET text='changed' WHERE id='child'")).toThrow();
      expect(() => db?.run("UPDATE thoughts SET parent_id=NULL WHERE id='child'")).toThrow();
      expect(() => db?.run("INSERT OR REPLACE INTO thought_sources VALUES ('child',0,'empty')")).toThrow();
      expect(() => db?.run("INSERT OR REPLACE INTO responses (id,text,role,state) VALUES ('response','replace','addendum','complete')")).toThrow(/immutable/i);
      db.close();
      db = new Database(path);
      migrate(db);
      migrate(db);
      const reopened = new SqliteStore(db);
      expect(joined(reopened.getThought("root"))).toMatchObject({ title: null, titleAuthor: null });
      expect(joined(reopened.getThought("child"))).toMatchObject({ title: "Human revision", titleAuthor: "user", text: "AI words", parentId: "root", sourceIds: ["root"] });
      const again = new TitleService(new SqliteTitleRepository(db));
      expect(again.setUser("user", "child", null)).toEqual({ title: null, titleAuthor: null });
      const secondDb = new Database(path);
      try {
        migrate(secondDb);
        const other = new TitleService(new SqliteTitleRepository(secondDb));
        expect(again.setUser("user", "child", "New human title")).toEqual({ title: "New human title", titleAuthor: "user" });
        expect(() => other.fillAi("ai", "child", "Stale AI title")).toThrow(TitleConflictError);
        expect(other.setUser("user", "child", null)).toEqual({ title: null, titleAuthor: null });
        expect(other.fillAi("ai", "child", "New AI title")).toEqual({ title: "New AI title", titleAuthor: "ai" });
      } finally { secondDb.close(); }
      expect(joined(new RejectionService(new SqliteRejectionRepository(db)).listThoughts({ actor: "ai", mode: "normal" }).find(item => item.id === "child"))).toMatchObject({ title: "New AI title", titleAuthor: "ai" });
      expect(new RejectionService(new SqliteRejectionRepository(db)).listThoughts({ actor: "user", mode: "history" }).map(item => item.id).sort()).toEqual(["child", "empty", "root"]);
    } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
