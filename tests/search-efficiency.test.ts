import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RejectionService } from "../src/domain/rejection";
import { SearchService } from "../src/domain/search";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteSearchRepository } from "../src/storage/search";
import { migrate, SqliteStore } from "../src/storage/sqlite";

describe("indexed scope query shape", () => {
  test("matching many replies uses indexed batches without whole-graph snapshots", () => {
    const dir = mkdtempSync(join("/tmp/opencode", "search-batch-"));
    const db = new Database(join(dir, "owned.sqlite"));
    try {
      migrate(db);
      const store = new SqliteStore(db);
      for (let i = 0; i < 24; i++) {
        const id = `thought-${i}`;
        store.saveThought({ id, text: `ordinary text ${i}`, title: null, author: "user", kind: "captured-original", createdAt: "2030", origin: "fixture", parentId: null, sourceIds: [] });
        store.saveResponse({ id: `reply-${i}`, text: `matchingword ${i}`, role: "addendum", state: "complete", thoughtIds: [id] });
      }
      const search = new SearchService(new SqliteSearchRepository(db));
      const snapshot = spyOn(SqliteRejectionRepository.prototype, "snapshot");
      try {
        const hits = search.search({ actor: "ai", mode: "normal" }, "matchingword");
        expect(hits).toHaveLength(24);
        expect(new Set(hits.map(item => item.id)).size).toBe(24);
        expect(snapshot).toHaveBeenCalledTimes(0);
      } finally { snapshot.mockRestore(); }
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("repeated spelling requests avoid corpus rebuild and invalidate visibility after rejection", () => {
    const dir = mkdtempSync(join("/tmp/opencode", "search-vocab-"));
    const db = new Database(join(dir, "owned.sqlite"));
    try {
      migrate(db);
      const store = new SqliteStore(db);
      for (let i = 0; i < 18; i++) {
        const id = `thought-${i}`;
        store.saveThought({ id, text: i === 0 ? "luminarium" : `filler${i}`, title: null, author: "user", kind: "captured-original", createdAt: "2030", origin: "fixture", parentId: null, sourceIds: [] });
        store.saveResponse({ id: `reply-${i}`, text: `replyword${i}`, role: "addendum", state: "complete", thoughtIds: [id] });
      }
      const scope = { actor: "ai", mode: "normal" } as const;
      const search = new SearchService(new SqliteSearchRepository(db));
      const rejection = new RejectionService(new SqliteRejectionRepository(db));
      expect(search.suggest(scope, "luminariu")).toContain("luminarium");
      const snapshot = spyOn(SqliteRejectionRepository.prototype, "snapshot");
      const exec = spyOn(Database.prototype, "exec");
      const query = spyOn(Database.prototype, "query");
      try {
        expect(search.suggest(scope, "luminariu")).toContain("luminarium");
        expect(snapshot).toHaveBeenCalledTimes(0);
        expect(exec.mock.calls.some(args => /create\s+virtual\s+table[\s\S]*?using\s+fts5\s*\(/i.test(String(args[0])))).toBe(false);
        expect(query.mock.calls.some(args => /^\s*select\s+id\s+from\s+responses\s*;?\s*$/i.test(String(args[0])))).toBe(false);
        rejection.rejectThought("user", "thought-0");
        snapshot.mockClear(); exec.mockClear(); query.mockClear();
        expect(search.suggest(scope, "luminariu")).not.toContain("luminarium");
        expect(snapshot).toHaveBeenCalledTimes(0);
        expect(exec.mock.calls.some(args => /create\s+virtual\s+table[\s\S]*?using\s+fts5\s*\(/i.test(String(args[0])))).toBe(false);
        rejection.restoreThought("user", "thought-0");
        expect(search.suggest(scope, "luminariu")).toContain("luminarium");
      } finally { query.mockRestore(); exec.mockRestore(); snapshot.mockRestore(); }
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
