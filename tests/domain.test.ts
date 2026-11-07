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

  const imported = {
    ...input,
    text: "  Café 漢字\r\n  second line  \r\n",
    author: "source", kind: "imported-original", origin: "markdown-import",
    parentId: null, sourceIds: [],
  } as const;

  test("retains imported source wording and provenance exactly", () => {
    expect(createThought(imported)).toEqual(imported);
  });

  test("allows a later user or AI title on imported wording", () => {
    for (const titleAuthor of ["user", "ai"] as const) {
      const titled = { ...imported, title: "A later title", titleAuthor };
      expect(createThought(titled)).toEqual(titled);
    }
  });

  test.each([
    ["source with a non-import kind", { kind: "captured-original" }],
    ["user with an import kind", { author: "user" }],
    ["AI with an import kind", { author: "ai" }],
    ["a different origin", { origin: "journal" }],
    ["an evolution parent", { parentId: "parent" }],
    ["supporting sources", { sourceIds: ["support"] }],
  ])("rejects imported source with %s", (_description, bad) => {
    expect(() => createThought({ ...imported, ...bad })).toThrow(ValidationError);
  });

  test("does not allow source as a title author", () => {
    expect(() => createThought({ ...input, title: "Title", titleAuthor: "source" })).toThrow(ValidationError);
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

  const mediaSource = {
    id: "media-1", name: "Sketch.png", mimeType: "image/png", byteLength: 123,
    fileAuthorship: "unverified", clarification: null, clarificationAuthor: null,
  } as const;
  const media = {
    ...input, text: null, titleAuthor: null, author: "source", kind: "media-original",
    origin: "media-import", parentId: null, sourceIds: [], mediaSource,
  } as const;

  test("retains a media root without invented text and uses its filename as fallback", () => {
    const thought = createThought(media);
    expect(thought).toEqual(media);
    expect(displayTitle(thought)).toBe("Sketch.png");
    const titled = createThought({ ...media, title: "My title", titleAuthor: "user" });
    expect(displayTitle(titled)).toBe("My title");
  });

  test("retains exact user clarification separately from unverified file authorship", () => {
    const clarification = "  Please examine this\r\n  detail.  ";
    const source = { ...mediaSource, clarification, clarificationAuthor: "user" };
    const thought = createThought({ ...media, mediaSource: source });
    expect(thought).toMatchObject({ text: null, author: "source", mediaSource: source });
    source.clarification = "changed after construction";
    expect(thought).toMatchObject({ mediaSource: { clarification, clarificationAuthor: "user", fileAuthorship: "unverified" } });
  });

  test.each([
    ["text", { text: "invented content" }],
    ["user authorship", { author: "user" }],
    ["AI authorship", { author: "ai" }],
    ["origin", { origin: "capture" }],
    ["parent", { parentId: "parent" }],
    ["supporting source", { sourceIds: ["support"] }],
    ["missing descriptor", { mediaSource: undefined }],
    ["empty descriptor id", { mediaSource: { ...mediaSource, id: "" } }],
    ["empty filename", { mediaSource: { ...mediaSource, name: "" } }],
    ["empty MIME", { mediaSource: { ...mediaSource, mimeType: "" } }],
    ["zero byte length", { mediaSource: { ...mediaSource, byteLength: 0 } }],
    ["unverified file authorship replaced", { mediaSource: { ...mediaSource, fileAuthorship: "user" } }],
    ["blank clarification", { mediaSource: { ...mediaSource, clarification: " \n", clarificationAuthor: "user" } }],
    ["unattributed clarification", { mediaSource: { ...mediaSource, clarification: "Look here", clarificationAuthor: null } }],
    ["attributed absent clarification", { mediaSource: { ...mediaSource, clarificationAuthor: "user" } }],
    ["AI clarification", { mediaSource: { ...mediaSource, clarification: "Look here", clarificationAuthor: "ai" } }],
  ])("rejects media root with invalid %s", (_description, bad) => {
    expect(() => createThought({ ...media, ...bad })).toThrow(ValidationError);
  });

  test("every existing text kind still rejects null and blank text", () => {
    for (const kind of ["captured-original", "user-contribution", "ai-interpretation", "developing-idea", "imported-original"] as const) {
      const base = kind === "imported-original" ? imported : { ...input, kind };
      for (const text of [null, "", " \n"]) expect(() => createThought({ ...base, text })).toThrow(ValidationError);
    }
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
  test("does not allow source as a connection proposer", () => {
    expect(() => createConnection({ ...connection, proposedBy: "source" })).toThrow(ValidationError);
  });
});
