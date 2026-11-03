import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ForbiddenActorError, RejectionService, type ReadScope } from "../src/domain/rejection";
import { SearchService } from "../src/domain/search";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteSearchRepository } from "../src/storage/search";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { latestEligibleDevelopment } from "../src/domain/shared-response";

const user = { actor: "user", mode: "normal" } as const;
const history = { actor: "user", mode: "history" } as const;
const show = { actor: "user", mode: "show-rejected" } as const;
const ai = { actor: "ai", mode: "normal" } as const;

function fixture(action: (service: SearchService, rejection: RejectionService) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "thoughtloom-search-scope-"));
  const db = new Database(join(dir, "fixture.sqlite"));
  try {
    migrate(db);
    const store = new SqliteStore(db);
    for (const [id, text] of [["active", "luminary visible"], ["rejected", "xylophonic hidden"], ["third", "third active"]]) {
      store.saveThought({ id, text, title: null, author: "user", kind: "captured-original", createdAt: "2030-01-01", origin: "test", parentId: null, sourceIds: [] });
    }
    store.saveResponse({ id: "mixed", text: "quasarresponse complete", role: "addendum", state: "complete", thoughtIds: ["rejected", "active"] });
    store.saveResponse({ id: "partial", text: "interruptedword partial", role: "addendum", state: "interrupted", thoughtIds: ["active", "third"] });
    store.saveResponse({ id: "partial-fallback", text: "zephyrretained unfinished", role: "fallback", state: "interrupted", thoughtIds: ["active"] });
    const rejection = new RejectionService(new SqliteRejectionRepository(db));
    const service = new SearchService(new SqliteSearchRepository(db));
    action(service, rejection);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe("scoped retrieval", () => {
  test("interrupted fallback text remains searchable and navigates its eligible input without promotion", () => fixture((service, rejection) => {
    const expected = [{ kind: "response", id: "partial-fallback", thoughtId: "active", text: "zephyrretained unfinished" }] as const;
    for (const scope of [user, ai] as const) {
      expect(service.search(scope, "zephyrretained")).toEqual(expected);
      expect(service.suggest(scope, "zephyrretaine")).toContain("zephyrretained");
    }
    const response = rejection.getResponse(ai, "partial-fallback");
    expect(response).toEqual({ id: "partial-fallback", text: "zephyrretained unfinished", role: "fallback", state: "interrupted", thoughtIds: ["active"] });
    if (!response) throw new Error("Expected retained fallback");
    expect(latestEligibleDevelopment(response)).toBeNull();
    rejection.rejectThought("user", "active");
    expect(service.search(user, "zephyrretained")).toEqual([]);
    expect(service.search(ai, "zephyrretained")).toEqual([]);
    expect(service.suggest(ai, "zephyrretaine")).not.toContain("zephyrretained");
    expect(service.search(show, "zephyrretained")).toEqual(expected);
    rejection.restoreThought("user", "active");
    expect(service.search(ai, "zephyrretained")).toEqual(expected);
    expect(service.suggest(ai, "zephyrretaine")).toContain("zephyrretained");
    expect(rejection.getResponse(ai, "partial-fallback")).toEqual(response);
  }));
  test("normal and deliberate user scopes and AI visibility follow current rejection state", () => fixture((service, rejection) => {
    expect(service.search(ai, "luminary")).toEqual([{ kind: "thought", id: "active", thoughtId: "active", text: "luminary visible" }]);
    expect(service.search(ai, "lumin")).toEqual([{ kind: "thought", id: "active", thoughtId: "active", text: "luminary visible" }]);
    expect(service.search(ai, "quasarresponse")).toEqual([{ kind: "response", id: "mixed", thoughtId: "active", text: "quasarresponse complete" }]);
    expect(service.search(ai, "interruptedword")).toEqual([{ kind: "response", id: "partial", thoughtId: "third", text: "interruptedword partial" }]);
    rejection.rejectThought("user", "rejected");
    expect(service.search(ai, "xylophonic")).toEqual([]);
    expect(service.search(user, "xylophonic")).toEqual([]);
    expect(service.search(show, "xylophonic")).toEqual([{ kind: "thought", id: "rejected", thoughtId: "rejected", text: "xylophonic hidden" }]);
    expect(service.search(history, "xylophonic")).toEqual(service.search(show, "xylophonic"));
    expect(service.search(ai, "quasarresponse")).toEqual([]);
    expect(service.search(user, "quasarresponse")).toEqual([{ kind: "response", id: "mixed", thoughtId: "active", text: "quasarresponse complete" }]);
    expect(service.search(show, "quasarresponse")).toEqual([{ kind: "response", id: "mixed", thoughtId: "active", text: "quasarresponse complete" }]);
    rejection.rejectThought("user", "third");
    expect(service.search(ai, "interruptedword")).toEqual([]);
    expect(service.search(user, "interruptedword")).toEqual([{ kind: "response", id: "partial", thoughtId: "active", text: "interruptedword partial" }]);
    rejection.rejectThought("user", "active");
    expect(service.search(user, "quasarresponse")).toEqual([]);
    expect(service.search(user, "interruptedword")).toEqual([]);
    rejection.restoreThought("user", "active");
    expect(service.search(user, "quasarresponse")).toHaveLength(1);
    expect(service.search(ai, "quasarresponse")).toEqual([]);
    rejection.restoreThought("user", "rejected");
    expect(service.search(ai, "quasarresponse")).toEqual([{ kind: "response", id: "mixed", thoughtId: "active", text: "quasarresponse complete" }]);
  }));

  test("typo vocabulary never suggests rejected thought or hidden shared-response words", () => fixture((service, rejection) => {
    expect(service.suggest(ai, "luminar")).toContain("luminary");
    rejection.rejectThought("user", "rejected");
    expect(service.suggest(ai, "xylophonix")).not.toContain("xylophonic");
    expect(service.suggest(user, "xylophonix")).not.toContain("xylophonic");
    expect(service.suggest(show, "xylophonix")).toContain("xylophonic");
    expect(service.suggest(ai, "quasarrespons")).not.toContain("quasarresponse");
    expect(service.suggest(user, "quasarrespons")).toContain("quasarresponse");
    rejection.rejectThought("user", "active");
    expect(service.suggest(user, "quasarrespons")).not.toContain("quasarresponse");
    rejection.restoreThought("user", "rejected");
    rejection.restoreThought("user", "active");
    expect(service.suggest(ai, "quasarrespons")).toContain("quasarresponse");
  }));

  test("invalid AI inspection scopes fail closed for search and spelling", () => fixture(service => {
    const invalid = { actor: "ai", mode: "show-rejected" } as unknown as ReadScope;
    expect(() => service.search(invalid, "xylophonic")).toThrow(ForbiddenActorError);
    expect(() => service.suggest(invalid, "xylophonix")).toThrow(ForbiddenActorError);
  }));
});
