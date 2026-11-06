import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import type { InvestigationRequest, InvestigationResult } from "../src/domain/investigative-retrieval";

function page(result: InvestigationResult): Extract<InvestigationResult, { type: "page" }> {
  expect(result.type).toBe("page");
  if (result.type !== "page") throw new Error("unexpected retrieval revision change");
  return result;
}

test("an accepted long lexical query can continue its own nonempty result walk", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const store = new SqliteStore(db);
    for (const id of ["one", "two", "three"]) {
      store.saveThought({ id, text: `cobalt fixture ${id}`, title: null, titleAuthor: null, author: "user",
        kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "fixture", parentId: null, sourceIds: [] });
    }
    const search = store.searchInvestigation();
    const request: InvestigationRequest = { query: "cobalt", authors: [], kinds: [], from: null, until: null, sort: "oldest", limit: 1 };
    const shortFirst = page(search.findThoughts(request));
    expect(shortFirst.items).toHaveLength(1);
    expect(shortFirst.nextCursor).not.toBeNull();
    if (!shortFirst.nextCursor) throw new Error("missing short-query continuation");
    const shortSecond = page(search.findThoughts({ ...request, cursor: shortFirst.nextCursor }));
    expect(shortSecond.items).toHaveLength(1);
    expect(shortSecond.items[0]?.id).not.toBe(shortFirst.items[0]?.id);

    const longQuery = "cobalt" + " ".repeat(7000);
    const longRequest = { ...request, query: longQuery };
    const longFirst = page(search.findThoughts(longRequest));
    expect(longFirst.items).toHaveLength(1);
    expect(longFirst.items[0]?.id).toBe(shortFirst.items[0]?.id);
    expect(longFirst.nextCursor).not.toBeNull();
    if (!longFirst.nextCursor) throw new Error("missing long-query continuation");
    console.info(`owned cursor regression: query length=${longQuery.length}, cursor length=${longFirst.nextCursor.length}`);
    const longSecond = page(search.findThoughts({ ...longRequest, cursor: longFirst.nextCursor }));
    expect(longSecond.items).toHaveLength(1);
    expect(longSecond.items[0]?.id).toBe(shortSecond.items[0]?.id);
    expect(longSecond.nextCursor).not.toBeNull();
    if (!longSecond.nextCursor) throw new Error("missing second long-query continuation");
    const longThird = page(search.findThoughts({ ...longRequest, cursor: longSecond.nextCursor }));
    expect(longThird.items).toHaveLength(1);
    expect(longThird.nextCursor).toBeNull();
    const ids = [...longFirst.items, ...longSecond.items, ...longThird.items].map(item => item.id);
    expect(ids).toEqual(["one", "three", "two"]);
    expect(new Set(ids).size).toBe(3);
  } finally { db.close(); }
});
