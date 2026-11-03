import { describe, expect, test } from "bun:test";
import { TitleConflictError, TitleForbiddenError, TitleNotFoundError, TitleService, type TitleRecord, type TitleRepository, type TitleState, type TitleTransaction } from "../src/domain/title";

class MemoryTitles implements TitleRepository {
  readonly records = new Map<string, TitleRecord>([
    ["ai-thought", { title: "AI label", titleAuthor: "ai", rejected: false }],
    ["empty", { title: null, titleAuthor: null, rejected: false }],
    ["rejected", { title: "private rejected title", titleAuthor: "user", rejected: true }],
  ]);
  beforeTransaction?: () => void;
  writes = 0;
  transaction<T>(action: (tx: TitleTransaction) => T): T {
    this.beforeTransaction?.();
    const result = action({
      get: id => this.records.get(id) ?? null,
      set: (id, state: TitleState) => {
        const old = this.records.get(id);
        if (!old) throw new Error("Fixture record missing");
        this.records.set(id, { ...state, rejected: old.rejected });
        this.writes++;
      },
    });
    return result;
  }
}

describe("title domain", () => {
  test("user may replace an AI title, clear and invite later AI fill", () => {
    const repository = new MemoryTitles();
    const service = new TitleService(repository);
    expect(service.setUser("user", "ai-thought", "Human title")).toEqual({ title: "Human title", titleAuthor: "user" });
    expect(service.get({ actor: "user", mode: "normal" }, "ai-thought")).toEqual({ title: "Human title", titleAuthor: "user" });
    expect(service.setUser("user", "ai-thought", null)).toEqual({ title: null, titleAuthor: null });
    expect(service.fillAi("ai", "ai-thought", "Regenerated")).toEqual({ title: "Regenerated", titleAuthor: "ai" });
  });

  test("AI cannot overwrite titles or impersonate a user; late generation sees current title", () => {
    const repository = new MemoryTitles();
    const service = new TitleService(repository);
    expect(() => service.setUser("ai", "ai-thought", "spoof")).toThrow(TitleForbiddenError);
    expect(() => service.fillAi("ai", "ai-thought", "overwrite")).toThrow(TitleConflictError);
    repository.beforeTransaction = () => { repository.records.set("empty", { title: "Concurrent human", titleAuthor: "user", rejected: false }); };
    expect(() => service.fillAi("ai", "empty", "late AI")).toThrow(TitleConflictError);
    expect(repository.records.get("empty")).toEqual({ title: "Concurrent human", titleAuthor: "user", rejected: false });
    expect(repository.writes).toBe(0);
  });

  test("only explicit user history can inspect rejected titles; user edits rejected material, AI cannot fill it", () => {
    const repository = new MemoryTitles();
    const service = new TitleService(repository);
    expect(() => service.get({ actor: "ai", mode: "normal" }, "rejected")).toThrow(TitleNotFoundError);
    expect(() => service.get({ actor: "user", mode: "normal" }, "rejected")).toThrow(TitleNotFoundError);
    expect(service.get({ actor: "user", mode: "history" }, "rejected")).toEqual({ title: "private rejected title", titleAuthor: "user" });
    expect(service.get({ actor: "user", mode: "show-rejected" }, "rejected")).toEqual({ title: "private rejected title", titleAuthor: "user" });
    expect(service.setUser("user", "rejected", null)).toEqual({ title: null, titleAuthor: null });
    expect(() => service.fillAi("ai", "rejected", "no access")).toThrow(TitleNotFoundError);
    expect(() => service.get({ actor: "ai", mode: "normal" }, "missing")).toThrow(TitleNotFoundError);
  });
});
