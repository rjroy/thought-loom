import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { createHash } from "node:crypto";
import type { Content, Root, RootContent } from "mdast";
import { importManifest, importPartition, ImportPreservationError, sourceText } from "./markdown-import-contract";
import type { ByteRange, ImportManifest, ImportPartition, ImportPartRange, Segmentation } from "./markdown-import-contract";
import { uniqueKeys } from "./run-protocol";
import { record, ValidationError } from "./validation";

export interface PreparedMarkdown {
  readonly manifest: ImportManifest;
  readonly fallbackCuts: readonly string[];
}

export interface MarkdownParser {
  prepareMarkdown(bytes: Uint8Array): PreparedMarkdown;
  partitionMarkdown(bytes: Uint8Array, prepared: PreparedMarkdown, cuts: readonly string[], segmentation: Segmentation): ImportPartition;
}

const parserVersion = "mdast-util-from-markdown@2.1.0+gfm@3.0.0+mdast-gfm@3.1.0;frontmatter-v1";

/** Advance only through requested UTF-16 boundaries in the unchanged input. */
function byteCursor(text: string): (offset: number) => number {
  let utf16 = 0, bytes = 0;
  return (offset: number): number => {
    if (!Number.isSafeInteger(offset) || offset < utf16 || offset > text.length) throw new ImportPreservationError("Invalid Markdown source position");
    while (utf16 < offset) {
      const unit = text.charCodeAt(utf16);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (utf16 + 2 > offset) throw new ImportPreservationError("Markdown position is not a scalar boundary");
        utf16 += 2; bytes += 4;
      } else {
        utf16++;
        bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
      }
    }
    return bytes;
  };
}

function metadataEnd(text: string, start: number): number {
  const first = /^(?:---)(?:\r\n|\n|\r)/.exec(text.slice(start));
  if (!first) return start;
  const lines = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  lines.lastIndex = start + first[0].length;
  for (let match = lines.exec(text); match && match[0].length; match = lines.exec(text)) {
    if (match[1] === "---" || match[1] === "...") return lines.lastIndex;
  }
  return start;
}

function nodeOffsets(node: RootContent): [number, number] {
  const start = node.position?.start.offset, end = node.position?.end.offset;
  if (start === undefined || end === undefined || start >= end) throw new ImportPreservationError("Invalid Markdown source positions");
  return [start, end];
}

function visit(node: Content, callback: (node: Content) => void): void {
  const pending: Content[] = [node];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    callback(current);
    if ("children" in current) for (let i = current.children.length - 1; i >= 0; i--) {
      const child = current.children[i];
      if (child) pending.push(child);
    }
  }
}

function possibleFootnote(text: string): boolean {
  let labelStart = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n" || char === "\r") labelStart = -1;
    else if (char === "]") {
      if (labelStart >= 0 && i > labelStart) return true;
      labelStart = -1;
    } else if (labelStart < 0 && char === "[" && text[i + 1] === "^") {
      labelStart = i + 2;
      i++;
    }
  }
  return false;
}

function prepareSnapshot(bytes: Uint8Array, parse: (body: string) => Root): { prepared: PreparedMarkdown; frontByte: number } {
  const text = sourceText(bytes);
  const bomEnd = text.startsWith("\ufeff") ? 1 : 0;
  const bodyStart = metadataEnd(text, bomEnd);
  const body = text.slice(bodyStart);
  const root = parse(body);
  const nodes = root.children;
  const byte = byteCursor(text);
  const ranges = nodes.map(node => {
    const [start, end] = nodeOffsets(node);
    if (end > body.length) throw new ImportPreservationError("Markdown position exceeds source");
    return { startByte: byte(bodyStart + start), endByte: byte(bodyStart + end) };
  });
  // Every gap must be whitespace. Otherwise a parser position mismatch would lose source prose.
  let prior = bodyStart;
  for (const node of nodes) {
    const [start, end] = nodeOffsets(node);
    if (start + bodyStart < prior || text.slice(prior, bodyStart + start).trim()) throw new ImportPreservationError("Unclassified Markdown source");
    prior = bodyStart + end;
  }
  if (text.slice(prior).trim()) throw new ImportPreservationError("Unclassified Markdown source");

  // Store interval endings at their first blocked boundary; the later sweep
  // unions overlaps without revisiting every boundary of every interval.
  const through = new Uint32Array(nodes.length);
  const close = (first: number, last: number): void => {
    if (first < last) through[first + 1] = Math.max(through[first + 1] ?? 0, last);
  };
  const block = (boundary: number): void => close(boundary - 1, boundary);
  const definitions = new Map<string, number[]>();
  const references = new Map<string, { first: number; last: number }>();
  let footnotes = false;
  nodes.forEach((node, index) => visit(node, child => {
    if (child.type === "footnoteDefinition" || child.type === "footnoteReference") footnotes = true;
    if (child.type === "text" && possibleFootnote(child.value)) footnotes = true;
    if (child.type === "definition" || child.type === "linkReference" || child.type === "imageReference") {
      const key = child.identifier.toUpperCase();
      if (child.type === "definition") {
        const positions = definitions.get(key);
        if (positions) positions.push(index);
        else definitions.set(key, [index]);
      } else {
        const interval = references.get(key);
        if (interval) interval.last = index;
        else references.set(key, { first: index, last: index });
      }
    }
  }));
  const unusedDefinitions = new Set<number>();
  for (const [key, positions] of definitions) {
    const uses = references.get(key);
    if (uses) {
      let first = uses.first, last = uses.last;
      for (const index of positions) { first = Math.min(first, index); last = Math.max(last, index); }
      close(first, last);
    } else for (const index of positions) {
      if (nodes[index]?.type === "definition") unusedDefinitions.add(index);
    }
  }
  // A run of unused top-level definitions is not content of its own. Attach
  // the complete run to its predecessor, or to the next block at the start.
  for (let start = 0; start < nodes.length;) {
    if (!unusedDefinitions.has(start)) { start++; continue; }
    let end = start + 1;
    while (unusedDefinitions.has(end)) end++;
    close(start, end - 1);
    if (start > 0) block(start);
    else if (end < nodes.length) block(end);
    start = end;
  }
  nodes.forEach((node, index) => {
    if (node.type === "heading") {
      if (index + 1 < nodes.length) block(index + 1);
      else if (index > 0) block(index);
    }
  });
  // The whole terminal heading-only run belongs to preceding content, not
  // merely its final heading. A headings-only document is already joined.
  let terminalHeading = nodes.length;
  while (terminalHeading > 0 && nodes[terminalHeading - 1]?.type === "heading") terminalHeading--;
  if (terminalHeading > 0 && terminalHeading < nodes.length) block(terminalHeading);
  if (footnotes && nodes.length > 1) close(0, nodes.length - 1);
  const atoms: ByteRange[] = [];
  const starts: number[] = [];
  let closedThrough = 0;
  ranges.forEach((range, index) => {
    closedThrough = Math.max(closedThrough, through[index] ?? 0);
    if (index > 0 && index <= closedThrough) {
      const last = atoms.pop();
      if (!last) throw new ImportPreservationError("Invalid atom closure");
      atoms.push({ startByte: last.startByte, endByte: range.endByte });
    } else { atoms.push(range); starts.push(index); }
  });
  const cuts = [...atoms.map((atom, index) => ({ id: `b${index}`, offset: atom.startByte })),
    { id: `b${atoms.length}`, offset: atoms.at(-1)?.endByte ?? bytes.length }];
  const manifest = importManifest(bytes, { version: 1, parserVersion, atoms, cuts });
  const fallbackCuts = cuts.filter((_cut, index) => index === 0 || index === atoms.length || nodes[starts[index] ?? -1]?.type === "heading").map(cut => cut.id);
  for (const atom of manifest.atoms) Object.freeze(atom);
  for (const cut of manifest.cuts) Object.freeze(cut);
  Object.freeze(manifest.atoms); Object.freeze(manifest.cuts); Object.freeze(manifest);
  Object.freeze(fallbackCuts);
  return { prepared: Object.freeze({ manifest, fallbackCuts }), frontByte: byteCursor(text)(bodyStart) };
}

function selectedCuts(manifest: ImportManifest, input: unknown): string[] {
  if (!Array.isArray(input)) throw new ValidationError("Invalid selected cuts");
  const indices = new Map(manifest.cuts.map((cut, index) => [cut.id, index]));
  let previous = -1;
  const cuts = input.map((id: unknown) => {
    const index = typeof id === "string" ? indices.get(id) : undefined;
    if (index === undefined || index <= previous) throw new ValidationError("Invalid selected cuts");
    previous = index;
    return id as string;
  });
  if (cuts[0] !== "b0" || previous !== manifest.atoms.length) throw new ValidationError("Missing selected endpoints");
  return cuts;
}

export function validateMarkdownSelection(manifest: ImportManifest, rawJSON: string): readonly string[] {
  try {
    const data = record(JSON.parse(rawJSON));
    uniqueKeys(rawJSON);
    if (Object.keys(data).length !== 3 || data.version !== 1 || data.kind !== "segmentation" || !Object.hasOwn(data, "cuts")) throw new ValidationError("Invalid segmentation envelope");
    return selectedCuts(manifest, data.cuts);
  } catch { throw new ValidationError("Invalid segmentation envelope"); }
}

function partitionSnapshot(bytes: Uint8Array, prepared: PreparedMarkdown, frontByte: number, cuts: readonly string[], segmentation: Segmentation): ImportPartition {
  const manifest = prepared.manifest;
  const selected = selectedCuts(manifest, cuts);
  const text = sourceText(bytes), bom = text.startsWith("\ufeff") ? 1 : 0;
  const parts: ImportPartRange[] = [];
  let cursor = 0;
  const add = (kind: ImportPartRange["kind"], endByte: number): void => {
    if (endByte > cursor) { parts.push({ kind, startByte: cursor, endByte }); cursor = endByte; }
  };
  if (bom) add("bom", 3);
  add("frontmatter", frontByte);
  const indices = new Map(manifest.cuts.map((cut, index) => [cut.id, index]));
  for (let i = 0; i + 1 < selected.length; i++) {
    const startIndex = indices.get(selected[i] ?? ""), endIndex = indices.get(selected[i + 1] ?? "");
    const first = manifest.atoms[startIndex ?? -1], last = manifest.atoms[(endIndex ?? 0) - 1];
    if (!first || !last) throw new ValidationError("Invalid selected cuts");
    add("separator", first.startByte);
    add("thought", last.endByte);
  }
  add("separator", bytes.length);
  return importPartition(bytes, { manifest, cuts: selected, parts, segmentation });
}

/** Internal injection seam; each instance recognizes only its own frozen preparations. */
export function createMarkdownParser(parse: (body: string) => Root): MarkdownParser {
  const proofs = new WeakMap<PreparedMarkdown, { readonly digest: string; readonly length: number; readonly frontByte: number }>();
  const snapshot = (bytes: Uint8Array): Uint8Array => {
    if (!(bytes instanceof Uint8Array)) throw new ImportPreservationError("Unsupported source content");
    return new Uint8Array(bytes);
  };
  const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  return {
    prepareMarkdown(bytes) {
      const owned = snapshot(bytes);
      const hash = digest(owned);
      const { prepared, frontByte } = prepareSnapshot(owned, parse);
      proofs.set(prepared, { digest: hash, length: owned.length, frontByte });
      return prepared;
    },
    partitionMarkdown(bytes, prepared, cuts, segmentation) {
      const proof = proofs.get(prepared);
      if (!proof) throw new ImportPreservationError("Unknown Markdown preparation");
      const owned = snapshot(bytes);
      if (owned.length !== proof.length || digest(owned) !== proof.digest) throw new ImportPreservationError("Markdown source differs from preparation");
      return partitionSnapshot(owned, prepared, proof.frontByte, cuts, segmentation);
    },
  };
}

const defaultParser = createMarkdownParser(body => fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
export const prepareMarkdown = defaultParser.prepareMarkdown;
export const partitionMarkdown = defaultParser.partitionMarkdown;
