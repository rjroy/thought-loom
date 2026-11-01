import { describe, expect, test } from "bun:test";
import { compileQuery, createFieldMatcher, reconstructAlignment, compareRanks } from "../src/fuzzy-matcher";

// Field chunks are split only at original grapheme boundaries, as required by
// the projection. A pending chunk is fully stepped before the next is offered.
function scan(query: string, chunks: string[], budget = 3) {
  const compiled = compileQuery(query);
  if (!compiled) return null;
  const matcher = createFieldMatcher(compiled);
  const input = chunks.length ? chunks : [""];
  for (let i = 0; i < input.length; i++) {
    matcher.append(input[i], i === input.length - 1);
    let state: { done: boolean; updates: number };
    do {
      state = matcher.step(budget);
      expect(state.updates).toBeGreaterThanOrEqual(0);
      expect(state.updates).toBeLessThanOrEqual(budget);
    } while (!state.done);
  }
  const match = matcher.result();
  return match && { match, ranges: reconstructAlignment(compiled, input.join(""), match) };
}

describe("phase1-basic", () => {
  test("ordered sdk finds camel and spaced examples without aliases", () => {
    for (const field of ["SoftwareDevelopmentKit", "shoulD Know", "Software Development Kit"]) {
      const result = scan("sdk", [field]);
      expect(result).not.toBeNull();
      expect(result?.ranges.map(({ start, end }) => field.slice(start, end).toLowerCase())).toEqual(["s", "d", "k"]);
    }
  });

  test("spaces are required and literal punctuation is not syntax", () => {
    expect(scan("s k", ["Software\tKit"])).not.toBeNull();
    expect(scan("s k", ["SoftwareKit"])).toBeNull();
    expect(scan("s*k", ["Software Kit"])).toBeNull();
    expect(scan("s*k", ["s**k"])).not.toBeNull();
    expect(scan("telescoppe", ["telescope"])).toBeNull();
    expect(scan("telscope", ["telescope"])).not.toBeNull();
    expect(scan("aa", ["a"])).toBeNull();
    expect(compileQuery(" \t\n\u00a0")).toBeNull();
    expect(compileQuery("")).toBeNull();
  });

  test("normalizes graphemes independently and maps complete original intervals", () => {
    const field = "X e\u0301\t\u00a0👩‍💻 Y";
    const result = scan("É 👩‍💻", [field]);
    expect(result).not.toBeNull();
    expect(result?.ranges.map(({ start, end }) => field.slice(start, end))).toEqual(["e\u0301", "\t\u00a0", "👩‍💻"]);
    expect(scan("e", ["é"])).toBeNull();
    expect(scan("i", ["İ"])).toBeNull();
    expect(scan("ß", ["ẞ"])).not.toBeNull();
    expect(scan("ss", ["ß"])).toBeNull();
    expect(scan("猫🐈", ["猫 and 🐈"])).not.toBeNull();
  });
});

describe("phase1-ranking-and-chunks", () => {
  test("whole word, contiguous, initials and scattered are ordered by class", () => {
    const cases = [
      ["the sdk!", "whole-word"], ["xsdkz", "contiguous"],
      ["SoftwareDevelopmentKit", "initials"], ["sxdxk", "scattered"],
    ] as const;
    for (const [field, expected] of cases) expect(scan("sdk", [field])?.match.class).toBe(expected);
  });

  test("later stronger and more compact matches beat earlier weak alignments", () => {
    const exact = scan("abc", ["a---b---c abc"]);
    expect(exact?.match).toMatchObject({ class: "whole-word", start: 10, end: 13, skipped: 0 });
    const compact = scan("ac", ["axxxc axc"]);
    expect(compact?.match).toMatchObject({ class: "scattered", start: 6, end: 9, skipped: 1 });
    const tie = scan("ac", ["axc axc"]);
    expect(tie?.match).toMatchObject({ class: "scattered", start: 0, end: 3, skipped: 1 });
  });

  test("rank tuple respects route, class, skipped keys, field, position and binary identity", () => {
    const base = { route: "direct", class: "contiguous", skipped: 0, field: "body", start: 4, targetKind: "source", sourceId: "b", itemId: "", revisionId: "", aliasId: "" } as const;
    expect(compareRanks(base, { ...base, route: "alias", class: "whole-word" })).toBeLessThan(0);
    expect(compareRanks(base, { ...base, class: "initials", field: "title" })).toBeLessThan(0);
    expect(compareRanks({ ...base, skipped: 1, field: "title" }, { ...base, skipped: 0 })).toBeGreaterThan(0);
    expect(compareRanks({ ...base, field: "title", start: 100 }, base)).toBeLessThan(0);
    expect(compareRanks({ ...base, start: 3 }, base)).toBeLessThan(0);
    expect(compareRanks({ ...base, sourceId: "A" }, base)).toBeLessThan(0);
    expect(compareRanks(base, base)).toBe(0);
  });

  test("grapheme-aligned chunk partitions preserve match, casing, whitespace and original ranges", () => {
    const field = "x e\u0301\t\u00a0👩‍💻 shoulD Know\r\nend";
    const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    const segments = [...segmenter.segment(field)].map((part) => part.segment);
    for (const query of ["É 👩‍💻", "sdk", "Know end", "x end"]) {
      const expected = scan(query, [field], 2);
      expect(expected).not.toBeNull();
      for (let split = 0; split <= segments.length; split++) {
        expect(scan(query, [segments.slice(0, split).join(""), segments.slice(split).join("")], 1)).toEqual(expected);
      }
      expect(scan(query, segments, 1)).toEqual(expected);
    }
  });

  test("small exhaustive oracle agrees on admission and best canonical alignment", () => {
    // Enumerate candidate alignments directly, not the production streaming DP.
    function strings(max: number): string[] {
      let current = [""]; const all = [...current];
      for (let n = 0; n < max; n++) { current = current.flatMap((s) => [s + "a", s + "b"]); all.push(...current); }
      return all;
    }
    function oracle(query: string, field: string) {
      const choices: number[][] = [];
      function enumerate(prefix: number[], next: number) {
        if (prefix.length === query.length) { choices.push(prefix); return; }
        for (let i = next; i < field.length; i++) if (field[i] === query[prefix.length]) enumerate([...prefix, i], i + 1);
      }
      enumerate([], 0);
      const candidates = choices.map((positions) => {
        const start = positions[0], end = positions[positions.length - 1] + 1;
        const contiguous = positions.every((position, i) => position === start + i);
        const cls: "whole-word" | "contiguous" | "scattered" = contiguous ? start === 0 && end === field.length ? "whole-word" : "contiguous" : "scattered";
        return { class: cls, start, end, skipped: end - start - query.length, positions };
      });
      const order = { "whole-word": 0, contiguous: 1, scattered: 3 };
      // Explicit lexicographic tie handling, independent of candidate generation order.
      candidates.sort((a, b) => {
        const rank = order[a.class] - order[b.class] || a.skipped - b.skipped || a.start - b.start;
        if (rank) return rank;
        for (let i = 0; i < a.positions.length; i++) if (a.positions[i] !== b.positions[i]) return a.positions[i] - b.positions[i];
        return 0;
      });
      return candidates[0] ?? null;
    }
    for (const query of strings(3).filter(Boolean)) for (const field of strings(5)) {
      const expected = oracle(query, field), actual = scan(query, [field], 2);
      if (!expected) { expect(actual).toBeNull(); continue; }
      expect(actual?.match).toMatchObject({ class: expected.class, start: expected.start, end: expected.end, skipped: expected.skipped });
      expect(actual?.ranges).toEqual(expected.positions.map((start) => ({ start, end: start + 1 })));
    }
  });
});
