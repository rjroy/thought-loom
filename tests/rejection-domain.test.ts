import { describe, expect, test } from "bun:test";
import { BranchConfirmationError, ForbiddenActorError, RejectionService, type ReadScope } from "../src/domain/rejection";
import { MemoryRepository } from "./rejection-fixtures";

const user = { actor: "user", mode: "normal" } as const;
const ai = { actor: "ai", mode: "normal" } as const;
const inspect = { actor: "user", mode: "show-rejected" } as const;
const sorted = (ids: readonly string[]) => [...ids].sort();

describe("rejection domain with controlled repository", () => {
  test("user rejects either author's individual thought without rejecting descendants, then restores it", () => {
    const repo = new MemoryRepository();
    const service = new RejectionService(repo);
    service.rejectThought("user", "root");
    service.rejectThought("user", "child");
    expect(sorted(repo.snapshot().rejectedThoughtIds)).toEqual(["child", "root"]);
    expect(service.listThoughts(user).map(t => t.id)).toContain("grandchild");
    service.restoreThought("user", "root");
    service.restoreThought("user", "child");
    expect(repo.snapshot().rejectedThoughtIds).toEqual([]);
  });

  test("preview counts only active ideas to change; branch walk excludes conceptual links", () => {
    const repo = new MemoryRepository();
    const service = new RejectionService(repo);
    service.rejectThought("user", "child");
    const preview = service.previewBranch("user", "root");
    expect(sorted(preview.branchIds)).toEqual(["child", "grandchild", "root", "sibling"]);
    expect(sorted(preview.affectedIds)).toEqual(["grandchild", "root", "sibling"]);
    expect(preview.count).toBe(3);
    service.rejectBranch("user", preview);
    expect(sorted(repo.snapshot().rejectedThoughtIds)).toEqual(["child", "grandchild", "root", "sibling"]);
    expect(service.listThoughts(user).map(t => t.id)).toEqual(["outside"]);
    service.restoreBranch("user", "child");
    expect(sorted(repo.snapshot().rejectedThoughtIds)).toEqual(["root", "sibling"]);
  });

  test("unconfirmed, forged and stale branch confirmations cannot change any state", () => {
    const repo = new MemoryRepository();
    const service = new RejectionService(repo);
    const preview = service.previewBranch("user", "root");
    expect(() => service.rejectBranch("user", null)).toThrow(BranchConfirmationError);
    expect(() => service.rejectBranch("user", { ...preview, count: 0 })).toThrow(BranchConfirmationError);
    expect(repo.snapshot().rejectedThoughtIds).toEqual([]);
    service.rejectThought("user", "child");
    expect(() => service.rejectBranch("user", preview)).toThrow(BranchConfirmationError);
    expect(repo.snapshot().rejectedThoughtIds).toEqual(["child"]);
  });

  test.each([
    ["reject thought", (s: RejectionService) => s.rejectThought("ai", "root")],
    ["restore thought", (s: RejectionService) => s.restoreThought("ai", "root")],
    ["preview branch", (s: RejectionService) => s.previewBranch("ai", "root")],
    ["reject branch", (s: RejectionService) => s.rejectBranch("ai", null)],
    ["restore branch", (s: RejectionService) => s.restoreBranch("ai", "root")],
    ["reject connection", (s: RejectionService) => s.rejectConnection("ai", "cross")],
    ["restore connection", (s: RejectionService) => s.restoreConnection("ai", "cross")],
  ] as [string, (service: RejectionService) => unknown][])("AI cannot %s", (_name, operation) => {
    const repo = new MemoryRepository();
    const service = new RejectionService(repo);
    expect(() => operation(service)).toThrow(ForbiddenActorError);
    expect(repo.snapshot().rejectedThoughtIds).toEqual([]);
    expect(repo.snapshot().rejectedConnectionIds).toEqual([]);
  });

  test("connections require active endpoints and independent rejection survives subtree restoration", () => {
    const service = new RejectionService(new MemoryRepository());
    service.rejectConnection("user", "cross");
    service.rejectThought("user", "child");
    expect(service.listConnections(ai)).toEqual([]);
    expect(sorted(service.listConnections(inspect).map(c => c.id))).toEqual(["cross", "within"]);
    service.restoreBranch("user", "child");
    expect(service.listConnections(ai).map(c => c.id)).toEqual(["within"]);
    service.restoreConnection("user", "cross");
    expect(sorted(service.listConnections(ai).map(c => c.id))).toEqual(["cross", "within"]);
    service.rejectThought("user", "outside");
    expect(service.listConnections(user).map(c => c.id)).toEqual(["within"]);
    service.restoreThought("user", "outside");
    expect(sorted(service.listConnections(user).map(c => c.id))).toEqual(["cross", "within"]);
  });

  test("inspection includes active and rejected but cannot leak rejected provenance or response to AI", () => {
    const repo = new MemoryRepository();
    const service = new RejectionService(repo);
    service.rejectThought("user", "root");
    expect(sorted(service.listThoughts(inspect).map(t => t.id))).toEqual(["child", "grandchild", "outside", "root", "sibling"]);
    expect(sorted(service.listThoughts({ actor: "user", mode: "history" }).map(t => t.id))).toEqual(["child", "grandchild", "outside", "root", "sibling"]);
    expect(service.getResponse(inspect, "root-response")?.text).toBe("private root response");
    expect(service.getResponse(user, "root-response")).toBeNull();
    expect(service.listThoughts(inspect).find(t => t.id === "child")?.sourceIds).toEqual(["root", "outside"]);
    const visibleChild = service.listThoughts(ai).find(t => t.id === "child");
    expect(visibleChild?.parentId).toBeNull();
    expect(visibleChild?.sourceIds).toEqual(["outside"]);
    expect(service.listConnections(ai).find(c => c.id === "cross")?.sourceIds).toEqual(["outside"]);
    expect(service.getResponse(ai, "root-response")).toBeNull();
    expect(service.getResponse(ai, "child-response")?.text).toBe("child response");
    expect(JSON.stringify([service.listThoughts(ai), service.listConnections(ai)])).not.toContain("private text root");
    expect(repo.snapshot().thoughts.find(t => t.id === "child")?.sourceIds).toEqual(["root", "outside"]);
    const invalidScope = { actor: "ai", mode: "show-rejected" } as unknown as ReadScope;
    expect(() => service.listThoughts(invalidScope)).toThrow(ForbiddenActorError);
    expect(() => service.listConnections(invalidScope)).toThrow(ForbiddenActorError);
    expect(() => service.getResponse(invalidScope, "root-response")).toThrow(ForbiddenActorError);
    const invalidHistory = { actor: "ai", mode: "history" } as unknown as ReadScope;
    expect(() => service.listThoughts(invalidHistory)).toThrow(ForbiddenActorError);
    expect(() => service.listConnections(invalidHistory)).toThrow(ForbiddenActorError);
    expect(() => service.getResponse(invalidHistory, "root-response")).toThrow(ForbiddenActorError);
    service.rejectThought("user", "child");
    expect(service.getResponse(ai, "child-response")).toBeNull();
    expect(service.getResponse(inspect, "child-response")?.text).toBe("child response");
  });
});
