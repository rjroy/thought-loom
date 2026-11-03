import { describe, expect, test } from "bun:test";
import { CreationForbiddenError, CreationNotFoundError, CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import type { Thought } from "../src/domain/thought";
import type { Connection } from "../src/domain/connection";
import { MemoryRepository } from "./rejection-fixtures";

function fixture() {
  const thoughts: Thought[] = [];
  const connections: Connection[] = [];
  const rejection = new RejectionService(new MemoryRepository());
  let sequence = 0;
  const service = new CreationService({ rejection, writes: { createThought: item => thoughts.push(item), createConnection: item => connections.push(item) }, id: () => `generated-${++sequence}`, now: () => "2030-01-02T03:04:05.000Z" });
  return { service, rejection, thoughts, connections };
}

describe("semantic creation commands", () => {
  test("owns IDs, clock, authorship, title attribution and operation provenance", () => {
    const t = fixture();
    const capture = t.service.capture("user", { text: "Original", title: "Label" });
    expect(capture).toEqual({ id: "generated-1", text: "Original", title: "Label", titleAuthor: "user", author: "user", kind: "captured-original", origin: "capture", createdAt: "2030-01-02T03:04:05.000Z", parentId: null, sourceIds: [] });
    const contribution = t.service.contribute("user", "root", { text: "Question" });
    expect(contribution).toEqual({ id: "generated-2", text: "Question", title: null, titleAuthor: null, author: "user", kind: "user-contribution", origin: "contribution", createdAt: "2030-01-02T03:04:05.000Z", parentId: "root", sourceIds: [] });
    const development = t.service.develop("ai", "child", { text: "Development", sourceIds: ["outside"] });
    expect(development).toEqual({ id: "generated-3", text: "Development", title: null, titleAuthor: null, author: "ai", kind: "developing-idea", origin: "development", createdAt: "2030-01-02T03:04:05.000Z", parentId: "child", sourceIds: ["outside"] });
    expect(t.thoughts).toEqual([capture, contribution, development]);
    const link = t.service.connect("ai", { fromId: "root", toId: "child", category: "supports", explanation: "reason" });
    expect(link).toEqual({ id: "generated-4", fromId: "root", toId: "child", category: "supports", explanation: "reason", sourceIds: [], proposedBy: "ai" });
    expect(t.connections).toEqual([link]);
  });

  test("roles and scoped references are checked before writing", () => {
    const t = fixture();
    t.rejection.rejectThought("user", "root");
    expect(() => t.service.capture("ai", { text: "spoof" })).toThrow(CreationForbiddenError);
    expect(() => t.service.contribute("ai", "child", { text: "spoof" })).toThrow(CreationForbiddenError);
    expect(() => t.service.develop("user", "child", { text: "spoof" })).toThrow(CreationForbiddenError);
    expect(() => t.service.develop("ai", "root", { text: "hidden" })).toThrow(CreationNotFoundError);
    expect(() => t.service.develop("ai", "child", { text: "hidden", sourceIds: ["root"] })).toThrow(CreationNotFoundError);
    expect(() => t.service.connect("ai", { fromId: "child", toId: "root", category: "related", explanation: "hidden" })).toThrow(CreationNotFoundError);
    expect(t.thoughts).toEqual([]);
    expect(t.connections).toEqual([]);
  });
});
