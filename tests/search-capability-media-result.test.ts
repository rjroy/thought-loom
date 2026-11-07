import { describe, expect, test } from "bun:test";
import { RunConflictError } from "../src/domain/run";
import type { SearchCapabilityResult } from "../src/domain/search-capability";
import { readSearchCapabilityResult } from "../src/domain/search-capability-result";
import { mediaThought } from "./fixtures/media-source";

const request = { capability: "readThought", arguments: { id: mediaThought.id } } as const;

describe("retained search media-result decoding", () => {
  test("decodes an exact media projection without inventing text or changing clarification attribution", () => {
    const result = { type: "thought", thought: mediaThought } satisfies SearchCapabilityResult;
    expect(readSearchCapabilityResult(request, result)).toEqual(result);
    const unclarified = { ...mediaThought, mediaSource: { ...mediaThought.mediaSource, clarification: null, clarificationAuthor: null } };
    expect(readSearchCapabilityResult(request, { type: "thought", thought: unclarified })).toEqual({ type: "thought", thought: unclarified });
  });

  test.each([
    ["extra file path", { ...mediaThought.mediaSource, path: "/private/not-authorized" }],
    ["extra binary content", { ...mediaThought.mediaSource, bytes: "not a source descriptor" }],
    ["missing name", { id: mediaThought.mediaSource.id, mimeType: "image/png", byteLength: 3, fileAuthorship: "unverified", clarification: null, clarificationAuthor: null }],
    ["wrong clarification attribution", { ...mediaThought.mediaSource, clarificationAuthor: "ai" }],
    ["absent clarification attributed to user", { ...mediaThought.mediaSource, clarification: null }],
    ["fractional length", { ...mediaThought.mediaSource, byteLength: 1.5 }],
    ["claimed file authorship", { ...mediaThought.mediaSource, fileAuthorship: "user" }],
  ])("rejects a retained media descriptor with %s", (_name, mediaSource) => {
    expect(() => readSearchCapabilityResult(request, { type: "thought", thought: { ...mediaThought, mediaSource } })).toThrow(RunConflictError);
  });

  test("rejects extra thought fields, wrong requested identity and a fabricated media body", () => {
    for (const changed of [{ ...mediaThought, privateSource: "hidden" }, { ...mediaThought, id: "another" }, { ...mediaThought, text: "invented" }]) {
      expect(() => readSearchCapabilityResult(request, { type: "thought", thought: changed })).toThrow(RunConflictError);
    }
  });
});
