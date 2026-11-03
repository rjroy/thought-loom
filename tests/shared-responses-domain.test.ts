import { describe, expect, test } from "bun:test";
import { createSharedResponse, latestEligibleDevelopment, scopeSharedResponse, type SharedResponse } from "../src/domain/shared-response";
import { RejectionService, type RejectionRepository } from "../src/domain/rejection";
import { ValidationError } from "../src/domain/validation";
import { MemoryRepository } from "./rejection-fixtures";

const reply: SharedResponse = { id: "reply", text: "canonical private reply", role: "addendum", state: "complete", thoughtIds: ["sibling", "child", "grandchild"] };
const user = { actor: "user", mode: "normal" } as const;
const history = { actor: "user", mode: "history" } as const;
const show = { actor: "user", mode: "show-rejected" } as const;
const ai = { actor: "ai", mode: "normal" } as const;

describe("shared response policy", () => {
  test("construction retains immutable ordered links and complete/interrupted state", () => {
    const result = createSharedResponse(reply);
    expect(result).toEqual(reply);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.thoughtIds)).toBe(true);
    expect(createSharedResponse({ ...reply, role: "fallback", state: "interrupted", thoughtIds: ["child"] })).toEqual({ ...reply, role: "fallback", state: "interrupted", thoughtIds: ["child"] });
    for (const value of [{ ...reply, thoughtIds: [] }, { ...reply, thoughtIds: ["child", "child"] }, { ...reply, state: "unknown" }, { ...reply, role: "fallback", thoughtIds: ["child", "sibling"] }]) {
      expect(() => createSharedResponse(value)).toThrow(ValidationError);
    }
  });

  test("human normal projects eligible associations while AI hides the entire mixed response", () => {
    expect(scopeSharedResponse(user, reply, [])).toEqual(reply);
    expect(scopeSharedResponse(ai, reply, [])).toEqual(reply);
    expect(scopeSharedResponse(user, reply, ["child"])).toEqual({ ...reply, thoughtIds: ["sibling", "grandchild"] });
    expect(scopeSharedResponse(ai, reply, ["child"])).toBeNull();
    expect(scopeSharedResponse(history, reply, ["child"])).toEqual(reply);
    expect(scopeSharedResponse(show, reply, ["child"])).toEqual(reply);
    expect(scopeSharedResponse(user, reply, reply.thoughtIds)).toBeNull();
    expect(scopeSharedResponse(ai, reply, reply.thoughtIds)).toBeNull();
    expect(reply.thoughtIds).toEqual(["sibling", "child", "grandchild"]);
  });

  test("latest eligible development follows issued association order, not IDs or timestamps", () => {
    const ordered: SharedResponse = { ...reply, thoughtIds: ["z-newest-timestamp", "a-oldest-timestamp", "m-last-issued"] };
    expect(latestEligibleDevelopment(ordered)).toBe("m-last-issued");
    const scoped = scopeSharedResponse(user, ordered, ["m-last-issued"]);
    expect(scoped).not.toBeNull();
    if (!scoped) throw new Error("Expected visible response");
    expect(latestEligibleDevelopment(scoped)).toBe("a-oldest-timestamp");
    expect(latestEligibleDevelopment({ ...ordered, role: "fallback", state: "interrupted", thoughtIds: ["a-oldest-timestamp"] })).toBeNull();
  });

  test("interrupted addendum navigates saved developments in issued order after scope filtering", () => {
    const interrupted: SharedResponse = { id: "partial", text: "partial reply remains interrupted", role: "addendum", state: "interrupted", thoughtIds: ["saved-first", "saved-last"] };
    expect(latestEligibleDevelopment(interrupted)).toBe("saved-last");
    const filtered = scopeSharedResponse(user, interrupted, ["saved-last"]);
    expect(filtered).toEqual({ ...interrupted, thoughtIds: ["saved-first"] });
    if (!filtered) throw new Error("Expected visible saved development");
    expect(latestEligibleDevelopment(filtered)).toBe("saved-first");
    expect(filtered).toEqual({ id: "partial", text: "partial reply remains interrupted", role: "addendum", state: "interrupted", thoughtIds: ["saved-first"] });
    expect(interrupted).toEqual({ id: "partial", text: "partial reply remains interrupted", role: "addendum", state: "interrupted", thoughtIds: ["saved-first", "saved-last"] });
  });

  test("public rejection service applies the same policy through repository snapshots", () => {
    const underlying = new MemoryRepository();
    const repository: RejectionRepository = {
      snapshot: () => ({ ...underlying.snapshot(), responses: [reply] }),
      transaction: action => underlying.transaction(action),
    };
    const service = new RejectionService(repository);
    const read = (scope: typeof user | typeof ai | typeof history | typeof show): unknown => service.getResponse(scope, "reply");
    expect(read(ai)).toEqual(reply);
    service.rejectThought("user", "child");
    expect(read(user)).toEqual({ ...reply, thoughtIds: ["sibling", "grandchild"] });
    expect(read(ai)).toBeNull();
    expect(read(history)).toEqual(reply);
    expect(read(show)).toEqual(reply);
    expect(service.listThoughts(ai).some(item => item.id === "grandchild")).toBe(true);
    service.rejectThought("user", "sibling");
    service.rejectThought("user", "grandchild");
    expect(read(user)).toBeNull();
    service.restoreThought("user", "child");
    expect(read(user)).toEqual({ ...reply, thoughtIds: ["child"] });
    expect(read(ai)).toBeNull();
    service.restoreThought("user", "sibling");
    service.restoreThought("user", "grandchild");
    expect(read(ai)).toEqual(reply);
  });
});
