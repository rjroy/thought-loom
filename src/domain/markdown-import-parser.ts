import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Content, RootContent } from "mdast";
import { importManifest, importPartition, ImportPreservationError, sourceText } from "./markdown-import-contract";
import type { ByteRange, ImportManifest, ImportPartition, ImportPartRange, Segmentation } from "./markdown-import-contract";
import { uniqueKeys } from "./run-protocol";
import { record, ValidationError } from "./validation";

export interface PreparedMarkdown {
  readonly manifest: ImportManifest;
  readonly fallbackCuts: readonly string[];
}

const parserVersion = "mdast-util-from-markdown@2.1.0+gfm@3.0.0+mdast-gfm@3.1.0;frontmatter-v1";

/** Offsets reported by mdast are UTF-16 positions in the exact input, not bytes. */
function byteOffsets(text: string): Map<number, number> {
  const result = new Map<number, number>([[0, 0]]);
  let utf16 = 0, bytes = 0;
  for (const scalar of text) {
    utf16 += scalar.length;
    bytes += new TextEncoder().encode(scalar).length;
    result.set(utf16, bytes);
  }
  return result;
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
  callback(node);
  if ("children" in node) for (const child of node.children) visit(child, callback);
}

export function prepareMarkdown(bytes: Uint8Array): PreparedMarkdown {
  const text = sourceText(bytes);
  const bomEnd = text.startsWith("\ufeff") ? 1 : 0;
  const bodyStart = metadataEnd(text, bomEnd);
  const body = text.slice(bodyStart);
  const root = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const nodes = root.children;
  const map = byteOffsets(text);
  const byte = (offset: number): number => {
    const value = map.get(offset);
    if (value === undefined) throw new ImportPreservationError("Markdown position is not a scalar boundary");
    return value;
  };
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

  const blocked = new Set<number>(); // boundary before node index
  const definitions = new Map<string, number[]>(), references = new Map<string, number[]>();
  let footnotes = false;
  nodes.forEach((node, index) => visit(node, child => {
    if (child.type === "footnoteDefinition" || child.type === "footnoteReference") footnotes = true;
    if (child.type === "text" && /\[\^[^\]\r\n]+\]/.test(child.value)) footnotes = true;
    if (child.type === "definition" || child.type === "linkReference" || child.type === "imageReference") {
      const target = child.type === "definition" ? definitions : references;
      const key = child.identifier.toUpperCase();
      target.set(key, [...(target.get(key) ?? []), index]);
    }
  }));
  const close = (first: number, last: number): void => { for (let i = first + 1; i <= last; i++) blocked.add(i); };
  const unusedDefinitions = new Set<number>();
  for (const [key, positions] of definitions) {
    const uses = references.get(key);
    if (uses?.length) {
      const all = [...positions, ...uses]; close(Math.min(...all), Math.max(...all));
    } else for (const index of positions) {
      if (nodes[index]?.type === "definition") unusedDefinitions.add(index);
      else if (index > 0) blocked.add(index);
      else if (index + 1 < nodes.length) blocked.add(index + 1);
    }
  }
  // A run of unused top-level definitions is not content of its own. Attach
  // the complete run to its predecessor, or to the next block at the start.
  for (let start = 0; start < nodes.length;) {
    if (!unusedDefinitions.has(start)) { start++; continue; }
    let end = start + 1;
    while (unusedDefinitions.has(end)) end++;
    close(start, end - 1);
    if (start > 0) blocked.add(start);
    else if (end < nodes.length) blocked.add(end);
    start = end;
  }
  nodes.forEach((node, index) => {
    if (node.type === "heading") {
      if (index + 1 < nodes.length) blocked.add(index + 1);
      else if (index > 0) blocked.add(index);
    }
  });
  // The whole terminal heading-only run belongs to preceding content, not
  // merely its final heading. A headings-only document is already joined.
  let terminalHeading = nodes.length;
  while (terminalHeading > 0 && nodes[terminalHeading - 1]?.type === "heading") terminalHeading--;
  if (terminalHeading > 0 && terminalHeading < nodes.length) blocked.add(terminalHeading);
  if (footnotes && nodes.length > 1) close(0, nodes.length - 1);
  const atoms: ByteRange[] = [];
  const starts: number[] = [];
  ranges.forEach((range, index) => {
    if (index > 0 && blocked.has(index)) {
      const last = atoms.pop();
      if (!last) throw new ImportPreservationError("Invalid atom closure");
      atoms.push({ startByte: last.startByte, endByte: range.endByte });
    } else { atoms.push(range); starts.push(index); }
  });
  const cuts = [...atoms.map((atom, index) => ({ id: `b${index}`, offset: atom.startByte })),
    { id: `b${atoms.length}`, offset: atoms.at(-1)?.endByte ?? bytes.length }];
  const manifest = importManifest(bytes, { version: 1, parserVersion, atoms, cuts });
  const fallbackCuts = cuts.filter((_cut, index) => index === 0 || index === atoms.length || nodes[starts[index] ?? -1]?.type === "heading").map(cut => cut.id);
  return { manifest, fallbackCuts };
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

export function partitionMarkdown(bytes: Uint8Array, prepared: PreparedMarkdown, cuts: readonly string[], segmentation: Segmentation): ImportPartition {
  // Reparse to ensure neither a stale manifest nor fabricated cuts can authorize unsafe ranges.
  const expected = prepareMarkdown(bytes);
  if (JSON.stringify(prepared.manifest) !== JSON.stringify(expected.manifest)) throw new ImportPreservationError("Markdown manifest does not match source");
  const manifest = expected.manifest;
  const selected = selectedCuts(manifest, cuts);
  const text = sourceText(bytes), bom = text.startsWith("\ufeff") ? 1 : 0;
  const frontEnd = metadataEnd(text, bom);
  const offsets = byteOffsets(text);
  const frontByte = offsets.get(frontEnd);
  if (frontByte === undefined) throw new ImportPreservationError("Invalid metadata boundary");
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
