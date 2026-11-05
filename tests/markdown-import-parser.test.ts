import { describe, expect, test } from "bun:test";
import { importManifest, importPartition, partitionMarkdown, prepareMarkdown, validateMarkdownSelection, type ImportManifest, type ImportPartition, type Segmentation } from "../src/domain/markdown-import";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const structural: Segmentation = { method: "structural", reason: "ai-invalid" };
const ai: Segmentation = { method: "ai", reason: null };

function prepared(bytes: Uint8Array) {
  const raw = prepareMarkdown(bytes);
  const manifest = importManifest(bytes, raw.manifest);
  return { raw, manifest, fallbackCuts: raw.fallbackCuts };
}

function partition(bytes: Uint8Array, p: ReturnType<typeof prepared>, cuts: readonly string[], segmentation: Segmentation = structural): ImportPartition {
  return importPartition(bytes, partitionMarkdown(bytes, p.raw, cuts, segmentation));
}

function select(manifest: ImportManifest, raw: string): readonly string[] {
  return validateMarkdownSelection(manifest, raw);
}

function slices(bytes: Uint8Array, part: ImportPartition): string[] {
  let end = 0;
  for (const range of part.parts) {
    expect(range.startByte).toBe(end);
    expect(range.endByte).toBeGreaterThan(range.startByte);
    end = range.endByte;
  }
  expect(end).toBe(bytes.length);
  expect(Buffer.concat(part.parts.map(range => Buffer.from(bytes.slice(range.startByte, range.endByte))))).toEqual(Buffer.from(bytes));
  return part.parts.filter(range => range.kind === "thought").map(range => decode(bytes.slice(range.startByte, range.endByte)));
}

function cutOffsets(manifest: ImportManifest): number[] { return manifest.cuts.map(cut => cut.offset); }
function byteOffset(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`Fixture missing ${needle}`);
  return encode(text.slice(0, index)).length;
}

describe("lossless Markdown parser and grouping", () => {
  test("keeps original UTF-8 bytes, opaque metadata and exact byte ranges across selected groups", () => {
    const text = "\ufeff---\r\ntitle: !untrusted café\r\n---\r\n\r\n# Same\r\n😀 e\u0301  \r\n\r\n# Same\n\ufeffinside\t\\*literal\\*\n";
    const bytes = encode(text), p = prepared(bytes);
    expect(p.manifest.version).toBe(1);
    expect(p.manifest.parserVersion.length).toBeGreaterThan(0);
    const second = byteOffset(text, "# Same\n");
    expect(cutOffsets(p.manifest)).toContain(second);
    const middle = p.manifest.cuts.find(cut => cut.offset === second);
    if (!middle) throw new Error("Missing section cut");
    const last = p.manifest.cuts.at(-1);
    if (!last) throw new Error("Missing endpoint");
    const selected = select(p.manifest, JSON.stringify({ version: 1, kind: "segmentation", cuts: ["b0", middle.id, last.id] }));
    const result = partition(bytes, p, selected, ai);
    expect(result.parts.map(part => part.kind)).toContain("bom");
    expect(result.parts.map(part => part.kind)).toContain("frontmatter");
    const thoughts = slices(bytes, result);
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0]).toContain("😀 e\u0301");
    expect(thoughts[1]).toContain("\ufeffinside\t\\*literal\\*");
    expect(result.parts.find(part => part.kind === "thought")?.startByte).toBe(byteOffset(text, "# Same\r\n"));
  });

  test("never offers cuts inside complete containers, heading sequences or ending headings", () => {
    const text = "# First\n## Sub\n\n- one\n  - nested\n\n  continued\n\n> quoted\n>\n> more\n\n```md\n# not a heading\n\ncode\n```\n\n| a | b |\n| - | - |\n| c | d |\n\n<div>\ninside\n</div>\n\n# Last\n";
    const bytes = encode(text), p = prepared(bytes), offsets = cutOffsets(p.manifest);
    for (const inside of ["## Sub", "  - nested", "  continued", "> more", "# not a heading", "code\n```", "| c | d |", "inside\n</div>", "# Last"]) {
      expect(offsets).not.toContain(byteOffset(text, inside));
    }
    expect(slices(bytes, partition(bytes, p, p.fallbackCuts)).join("")).toContain("# Last");
  });

  test("closes intersecting reference dependencies, attaches unused definitions and permits safe outside cuts", () => {
    const text = "Outside\n\n[one][a]\n\n[a]: /a\n\n[other][b]\n\n[b]: /b\n\n[a] and [b]\n\n[unused]: /unused\n\nAfter\n";
    const bytes = encode(text), p = prepared(bytes), offsets = cutOffsets(p.manifest);
    const start = byteOffset(text, "[one][a]"), end = byteOffset(text, "[a] and [b]");
    expect(offsets.some(offset => offset > start && offset <= end)).toBe(false);
    const all = p.manifest.cuts.map(cut => cut.id);
    const thoughts = slices(bytes, partition(bytes, p, all, ai));
    expect(thoughts.some(thought => thought.includes("[one][a]") && thought.includes("[b]: /b") && thought.includes("[a] and [b]"))).toBe(true);
    expect(thoughts.map(thought => thought.trim())).not.toContain("[unused]: /unused");
    expect(thoughts.some(thought => thought.includes("Outside"))).toBe(true);
    expect(thoughts.some(thought => thought.includes("After"))).toBe(true);
  });

  test("uses whole-body fallback for unknown footnote dependencies and headingless prose", () => {
    for (const text of ["First[^x]\n\n# Section\nBody\n\n[^x]: note\n", "First paragraph\n\nSecond paragraph\n"]) {
      const bytes = encode(text), p = prepared(bytes);
      const thoughts = slices(bytes, partition(bytes, p, p.fallbackCuts));
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0]?.trimEnd()).toBe(text.trimEnd());
      if (text.includes("[^x]")) expect(p.manifest.atoms).toHaveLength(1);
    }
  });

  test("fallback retains introduction and complete repeated-heading sections", () => {
    const text = "Intro one\n\nIntro two\n\n# Repeat\nOne\n\nMore one\n\n# Repeat\nTwo\n";
    const bytes = encode(text), p = prepared(bytes);
    expect(slices(bytes, partition(bytes, p, p.fallbackCuts)).map(text => text.trimEnd())).toEqual(["Intro one\n\nIntro two", "# Repeat\nOne\n\nMore one", "# Repeat\nTwo"]);
  });

  const attachmentCases = [
    { name: "BTR-001 terminal heading run", text: "# A\n\nBody\n\n## B\n### C\n", unsafe: ["## B", "### C"] },
    { name: "BTR-002 leading unused definition run", text: "[a]: /a\n[b]: /b\n\n# Topic\nBody\n", unsafe: ["[b]: /b", "# Topic"] },
  ];

  test.each(attachmentCases)("$name stays attached in structural fallback", ({ text }) => {
    const bytes = encode(text), p = prepared(bytes);
    const thoughts = slices(bytes, partition(bytes, p, p.fallbackCuts));
    expect(thoughts.map(thought => thought.trimEnd())).toEqual([text.trimEnd()]);
  });

  test.each(attachmentCases)("$name has no offered cut that isolates the run", ({ text, unsafe }) => {
    const bytes = encode(text), p = prepared(bytes);
    // Selecting every offered boundary is the most fragmented AI result.
    const ids = p.manifest.cuts.map(cut => cut.id);
    const selected = select(p.manifest, JSON.stringify({ version: 1, kind: "segmentation", cuts: ids }));
    const thoughts = slices(bytes, partition(bytes, p, selected, ai));
    for (const marker of unsafe) expect(cutOffsets(p.manifest)).not.toContain(byteOffset(text, marker));
    expect(thoughts.map(thought => thought.trimEnd())).toEqual([text.trimEnd()]);
  });

  test("a document consisting entirely of headings remains a single whole-body thought", () => {
    const text = "# A\n## B\n### C\n", bytes = encode(text), p = prepared(bytes);
    const fallback = slices(bytes, partition(bytes, p, p.fallbackCuts));
    const allCuts = slices(bytes, partition(bytes, p, p.manifest.cuts.map(cut => cut.id), ai));
    expect(fallback.map(thought => thought.trimEnd())).toEqual([text.trimEnd()]);
    expect(allCuts.map(thought => thought.trimEnd())).toEqual([text.trimEnd()]);
  });

  test("preserves empty and metadata-only sources with no thoughts", () => {
    for (const text of ["", " \r\n\t", "\ufeff---\r\ntitle: value\r\n---\r\n"]) {
      const bytes = encode(text), p = prepared(bytes);
      expect(p.manifest.atoms).toHaveLength(0);
      const result = partition(bytes, p, p.fallbackCuts, { method: "not-needed", reason: null });
      expect(slices(bytes, result)).toEqual([]);
      expect(result.segmentation.method).toBe("not-needed");
    }
  });

  test("rejects invalid UTF-8 and NUL rather than falling back", () => {
    for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0xff, 0xfe, 0x41, 0]), encode("a\0b")]) {
      expect(() => prepareMarkdown(bytes)).toThrow();
    }
  });

  test("validates the entire model envelope, including duplicate JSON keys", () => {
    const bytes = encode("one\n\ntwo\n\nthree"), p = prepared(bytes);
    const ids = p.manifest.cuts.map(cut => cut.id), end = ids.at(-1);
    if (!end || ids.length < 4) throw new Error("Fixture needs three atoms");
    const envelope = (cuts: readonly string[]) => JSON.stringify({ version: 1, kind: "segmentation", cuts });
    expect(select(p.manifest, envelope(["b0", end]))).toEqual(["b0", end]);
    for (const raw of [envelope(["b0"]), envelope([ids[1] ?? "", end]), envelope(["b0", "b1", "b1", end]), envelope(["b0", "b2", "b1", end]), envelope(["b0", "foreign", end]),
      `{"version":1,"kind":"segmentation","cuts":["b0","${end}"],"title":"invented"}`,
      `{"version":1,"kind":"segmentation","cuts":["b0","${end}"],"cuts":["b0","${end}"]}`,
      `Here is the result: ${envelope(["b0", end])}`, "", "{}", envelope(["b0", "b99", end])]) {
      expect(() => select(p.manifest, raw)).toThrow();
    }
  });

  test("does not force durable chunks inside an oversized complete block", () => {
    const text = `\`\`\`text\n${"long line 😀\n".repeat(20000)}\`\`\`\n`;
    const bytes = encode(text), p = prepared(bytes);
    expect(p.manifest.atoms).toHaveLength(1);
    const thoughts = slices(bytes, partition(bytes, p, p.fallbackCuts));
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]?.trimEnd()).toBe(text.trimEnd());
  });
});
