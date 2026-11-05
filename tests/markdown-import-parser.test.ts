import { describe, expect, test } from "bun:test";
import { importManifest, importPartition, partitionMarkdown, prepareMarkdown, validateMarkdownSelection, type ImportManifest, type ImportPartition, type Segmentation } from "../src/domain/markdown-import";
import * as parserModule from "../src/domain/markdown-import-parser";
import type { PreparedMarkdown } from "../src/domain/markdown-import-parser";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Root } from "mdast";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const structural: Segmentation = { method: "structural", reason: "ai-invalid" };
const ai: Segmentation = { method: "ai", reason: null };

// Proposed internal seam: a parser instance owns its private preparation proofs.
// The AST dependency accepts the body and returns an actual mdast Root, never a manifest.
interface ParserInstance {
  prepareMarkdown(bytes: Uint8Array): PreparedMarkdown;
  partitionMarkdown(bytes: Uint8Array, prepared: PreparedMarkdown, cuts: readonly string[], segmentation: Segmentation): ImportPartition;
}
function parserInstance(parse: (body: string) => Root): ParserInstance {
  const factory: unknown = Reflect.get(parserModule, "createMarkdownParser");
  if (typeof factory !== "function") throw new Error("Missing parser capability: createMarkdownParser");
  const value: unknown = Reflect.apply(factory, undefined, [parse]);
  if (!isParserInstance(value)) throw new Error("Invalid parser factory result");
  return value;
}
function isParserInstance(value: unknown): value is ParserInstance {
  return typeof value === "object" && value !== null && "prepareMarkdown" in value && typeof value.prepareMarkdown === "function"
    && "partitionMarkdown" in value && typeof value.partitionMarkdown === "function";
}
const realParse = (body: string): Root => fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

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

  test("maps Unicode scalar widths to original byte offsets across mixed line endings", () => {
    const text = "\ufeff---\r\nopaque: ✓\n---\r\n\r\n# First\r\nA é 漢 😀 e\u0301\n\r\n# Next\n\ufeffvalue\r\n";
    const bytes = encode(text), p = prepared(bytes), next = byteOffset(text, "# Next");
    const boundary = p.manifest.cuts.find(cut => cut.offset === next);
    if (!boundary) throw new Error("Missing second section boundary");
    const last = p.manifest.cuts.at(-1);
    if (!last) throw new Error("Missing endpoint");
    const parts = partition(bytes, p, ["b0", boundary.id, last.id], ai);
    const thoughts = slices(bytes, parts);
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0]).toContain("A é 漢 😀 e\u0301");
    expect(thoughts[1]).toContain("\ufeffvalue");
    expect(parts.parts.filter(part => part.kind === "thought")[1]?.startByte).toBe(next);
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

  test("closes repeated link and image uses across hundreds of blocks and duplicate definitions", () => {
    const uses = Array.from({ length: 300 }, (_, i) => `Use ${i} [link][ref] ![image][ref]`).join("\n\n");
    const text = `[ref]: /before\n\n${uses}\n\n[ref]: /duplicate\n\nOutside\n`;
    const bytes = encode(text), p = prepared(bytes), offsets = cutOffsets(p.manifest);
    expect(offsets.some(offset => offset > 0 && offset <= byteOffset(text, "[ref]: /duplicate"))).toBe(false);
    const thoughts = slices(bytes, partition(bytes, p, p.manifest.cuts.map(cut => cut.id), ai));
    expect(thoughts[0]).toContain("Use 299 [link][ref] ![image][ref]");
    expect(thoughts[0]).toContain("[ref]: /duplicate");
    expect(thoughts.at(-1)).toContain("Outside");
  });

  test("intersecting intervals sharing a block close transitively but disjoint intervals stay separate", () => {
    const text = "[a]: /a\n\n[a]\n\n[a] and [b]\n\n[b]\n\n[b]: /b\n\nMiddle\n\n[c]: /c\n\n[c]\n\nOutside\n";
    const bytes = encode(text), p = prepared(bytes), offsets = cutOffsets(p.manifest);
    const end = byteOffset(text, "[b]: /b"), second = byteOffset(text, "[c]: /c");
    expect(offsets.some(offset => offset > 0 && offset <= end)).toBe(false);
    expect(offsets).toContain(second);
    const thoughts = slices(bytes, partition(bytes, p, p.manifest.cuts.map(cut => cut.id), ai));
    expect(thoughts[0]).toContain("[b]: /b");
    expect(thoughts.some(thought => thought.includes("[c]: /c") && thought.includes("[c]"))).toBe(true);
    expect(thoughts.some(thought => thought.trim() === "Middle")).toBe(true);
  });

  test("unrelated unused definitions inside separate containers do not merge the whole document", () => {
    const text = "> first\n>\n> [unused-a]: /a\n\nMiddle\n\n- second\n\n  [unused-b]: /b\n\nAfter\n";
    const bytes = encode(text), p = prepared(bytes);
    expect(cutOffsets(p.manifest)).toContain(byteOffset(text, "Middle"));
    expect(cutOffsets(p.manifest)).toContain(byteOffset(text, "- second"));
    const thoughts = slices(bytes, partition(bytes, p, p.manifest.cuts.map(cut => cut.id), ai));
    expect(thoughts.some(thought => thought.includes("unused-a") && !thought.includes("unused-b"))).toBe(true);
    expect(thoughts.some(thought => thought.includes("unused-b") && !thought.includes("unused-a"))).toBe(true);
  });

  test("rejects fabricated scalar-aligned cuts inside a container or dependency atom", () => {
    for (const [text, marker] of [["- one\n  - nested\n\nAfter\n", "  - nested"], ["[a]: /a\n\nUse [a]\n\nAfter\n", "Use [a]"]] as const) {
      const bytes = encode(text), p = prepared(bytes), split = byteOffset(text, marker);
      const first = p.manifest.atoms[0];
      if (!first || split <= first.startByte || split >= first.endByte) throw new Error("Fixture split must be inside atom");
      const atoms = [{ startByte: first.startByte, endByte: split }, { startByte: split, endByte: first.endByte }, ...p.manifest.atoms.slice(1)];
      const cuts = [...atoms.map((atom, index) => ({ id: `b${index}`, offset: atom.startByte })), { id: `b${atoms.length}`, offset: atoms.at(-1)?.endByte ?? bytes.length }];
      const forged = { ...p.raw, manifest: { ...p.manifest, atoms, cuts } };
      expect(() => partitionMarkdown(bytes, forged, cuts.map(cut => cut.id), ai)).toThrow();
    }
  });

  test("one real AST parse serves preparation, repeated selections and partitions", () => {
    let calls = 0;
    const parser = parserInstance(body => { calls++; return realParse(body); });
    const bytes = encode("\ufeff---\r\nmeta: ✓\r\n---\r\n\r\n# A\nFirst 😀\n\n# B\nSecond\n");
    const p = parser.prepareMarkdown(bytes), all = p.manifest.cuts.map(cut => cut.id);
    const last = all.at(-1);
    if (!last) throw new Error("Missing endpoint");
    for (const cuts of [["b0", last], all, p.fallbackCuts]) {
      const selected = validateMarkdownSelection(p.manifest, JSON.stringify({ version: 1, kind: "segmentation", cuts }));
      const result = importPartition(bytes, parser.partitionMarkdown(bytes, p, selected, ai));
      expect(slices(bytes, result).join("")).toContain("Second");
    }
    expect(calls).toBe(1);
  });

  test("only the exact prepared object is authorized, not spread or structured clones", () => {
    const bytes = encode("First\n\nSecond\n"), p = prepareMarkdown(bytes);
    const clones = [{ ...p }, { ...p, manifest: { ...p.manifest } }, structuredClone(p)];
    for (const clone of clones) expect(() => partitionMarkdown(bytes, clone, p.fallbackCuts, structural)).toThrow();
    expect(slices(bytes, partitionMarkdown(bytes, p, p.fallbackCuts, structural))).toHaveLength(1);
  });

  test("freezes preparation and all nested ranges, cuts and fallback IDs", () => {
    const bytes = encode("# A\nOne\n\n# B\nTwo\n"), p = prepareMarkdown(bytes);
    const atom = p.manifest.atoms[0], cut = p.manifest.cuts[0];
    if (!atom || !cut) throw new Error("Fixture requires an atom and cut");
    for (const value of [p, p.manifest, p.manifest.atoms, atom, p.manifest.cuts, cut, p.fallbackCuts]) expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(atom, "endByte", atom.startByte + 1)).toBe(false);
    expect(Reflect.set(cut, "offset", cut.offset + 1)).toBe(false);
    expect(Reflect.set(p.fallbackCuts, "0", "foreign")).toBe(false);
    expect(slices(bytes, partitionMarkdown(bytes, p, p.fallbackCuts, structural))).toHaveLength(2);
  });

  test("fingerprints source bytes without freezing or retaining the caller's mutable buffer", () => {
    const bytes = encode("Alpha\n\nBeta\n"), original = bytes.slice(), p = prepareMarkdown(bytes);
    bytes[0] = "Z".charCodeAt(0);
    expect(bytes[0]).toBe("Z".charCodeAt(0));
    expect(() => partitionMarkdown(bytes, p, p.fallbackCuts, structural)).toThrow();
    expect(slices(original, partitionMarkdown(original, p, p.fallbackCuts, structural))[0]).toContain("Alpha");
    const swapped = encode("Alpha\n\nZeta\n");
    expect(swapped.length).toBe(original.length);
    expect(() => partitionMarkdown(swapped, p, p.fallbackCuts, structural)).toThrow();
  });

  test("parses and fingerprints the same owned snapshot when the caller changes bytes during parsing", () => {
    const bytes = encode("Alpha\n\nBeta\n"), original = bytes.slice();
    let calls = 0;
    const parser = parserInstance(body => { calls++; bytes[0] = "Z".charCodeAt(0); return realParse(body); });
    const p = parser.prepareMarkdown(bytes);
    expect(bytes[0]).toBe("Z".charCodeAt(0));
    expect(() => parser.partitionMarkdown(bytes, p, p.fallbackCuts, structural)).toThrow();
    expect(slices(original, parser.partitionMarkdown(original, p, p.fallbackCuts, structural))[0]).toContain("Alpha");
    expect(calls).toBe(1);
  });

  test("proofs are private to each parser instance and cannot authorize the default facade", () => {
    const first = parserInstance(realParse), second = parserInstance(realParse);
    const bytes = encode("one\n\ntwo\n"), p = first.prepareMarkdown(bytes), q = second.prepareMarkdown(bytes), defaultPrepared = prepareMarkdown(bytes);
    expect(slices(bytes, first.partitionMarkdown(bytes, p, p.fallbackCuts, structural))).toHaveLength(1);
    expect(slices(bytes, second.partitionMarkdown(bytes, q, q.fallbackCuts, structural))).toHaveLength(1);
    expect(() => second.partitionMarkdown(bytes, p, p.fallbackCuts, structural)).toThrow();
    expect(() => first.partitionMarkdown(bytes, q, q.fallbackCuts, structural)).toThrow();
    expect(() => partitionMarkdown(bytes, p, p.fallbackCuts, structural)).toThrow();
    expect(() => first.partitionMarkdown(bytes, defaultPrepared, defaultPrepared.fallbackCuts, structural)).toThrow();
  });

  test("footnote marker detection requires a nonempty label closed on the same line", () => {
    for (const [marker, whole] of [["[^x]", true], ["[^]", false], ["[^x\ny]", false], ["[^unclosed", false], ["[^x\ry]", false]] as const) {
      const bytes = encode(`First ${marker}\n\n# Next\nSecond\n`), p = prepared(bytes);
      expect(p.manifest.atoms.length).toBe(whole ? 1 : 2);
      slices(bytes, partition(bytes, p, p.fallbackCuts));
    }
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
