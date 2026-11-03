import { describe, expect, test } from "bun:test";
import { createThought, displayTitle } from "../src/domain/thought";
import { createConnection } from "../src/domain/connection";
import { ValidationError } from "../src/domain/validation";

const input = {
  id: "t1", text: "  One  two\nthree four five six ", title: null,
  author: "user", kind: "captured-original", createdAt: "2026-01-01T00:00:00.000Z",
  origin: "journal", parentId: null, sourceIds: [],
} as const;

describe("thought data boundary", () => {
  test("retains actual content and provenance and makes the five-word fallback", () => {
    const thought = createThought(input);
    expect(thought).toEqual(input);
    expect(displayTitle(thought)).toBe("One two three four five");
    expect(displayTitle({ text: "one two", title: null })).toBe("one two");
    expect(displayTitle({ text: "one two", title: "My title" })).toBe("My title");
  });

  test("accepts distinct authors and material kinds independently", () => {
    for (const kind of ["captured-original", "user-contribution", "ai-interpretation", "developing-idea"] as const) {
      for (const author of ["user", "ai"] as const) {
        expect(createThought({ ...input, kind, author }).author).toBe(author);
        expect(createThought({ ...input, kind, author }).kind).toBe(kind);
      }
    }
  });

  test("constructed thoughts retain their supporting references independently of input mutation", () => {
    const sourceIds = ["source"];
    const thought = createThought({ ...input, sourceIds });
    sourceIds.push("later");
    expect(thought.sourceIds).toEqual(["source"]);
    expect(thought.text).toBe(input.text);
    expect(thought.parentId).toBeNull();
  });

  test("rejects malformed identity, text, author, kind, and parent shapes", () => {
    for (const bad of [
      { id: "" }, { text: "" }, { author: "robot" }, { kind: "other" },
      { parentId: ["one", "two"] }, { sourceIds: "other" },
    ]) expect(() => createThought({ ...input, ...bad })).toThrow(ValidationError);
  });
});

describe("connection data boundary", () => {
  const connection = { id: "c", fromId: "a", toId: "b", category: "supports", proposedBy: "ai", explanation: "reason", sourceIds: ["s"] } as const;
  test("preserves directed endpoints, rationale and sources across categories", () => {
    for (const category of ["supports", "contradicts", "extends", "related"] as const) {
      expect(createConnection({ ...connection, category })).toEqual({ ...connection, category });
    }
  });
  test("rejects invalid category and endpoints", () => {
    for (const bad of [{ category: "similar" }, { fromId: "" }, { toId: null }]) {
      expect(() => createConnection({ ...connection, ...bad })).toThrow(ValidationError);
    }
  });
});
