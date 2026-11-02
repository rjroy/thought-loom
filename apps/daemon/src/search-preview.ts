import { SEARCH_PASSAGE_GRAPHEMES, SEARCH_PASSAGE_UTF16, type SearchPassage } from "@thoughtloom/contracts";

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
export function boundedExcerpt(text: string): string {
  let end = 0, count = 0;
  for (const part of segmenter.segment(text)) {
    if (++count > SEARCH_PASSAGE_GRAPHEMES || part.index + part.segment.length > SEARCH_PASSAGE_UTF16) break;
    end = part.index + part.segment.length;
  }
  return text.slice(0, end);
}

export type SnippetMarkers = { start: string; end: string; ellipsis: string };
export function snippetMarkers(): SnippetMarkers {
  const id = crypto.randomUUID();
  return { start: `\uE000${id}:start\uE001`, end: `\uE000${id}:end\uE001`, ellipsis: `\uE000${id}:gap\uE001` };
}

// The caller checks markers are absent from the stored field. FTS markup is
// decoded into plain text + numeric ranges, never forwarded as HTML. Truncated
// huge tokens/invalid marker structure fail closed to an explicitly omitted
// preview, not a fabricated global offset or a split grapheme.
export function snippetPassage(marked: string, markers: SnippetMarkers): SearchPassage {
  const omitted: SearchPassage = { fragments: [], leadingEllipsis: false, trailingEllipsis: false, omitted: true };
  if (marked.length >= 16_384) return omitted;
  const leadingEllipsis = marked.startsWith(markers.ellipsis), trailingEllipsis = marked.endsWith(markers.ellipsis);
  let input = leadingEllipsis ? marked.slice(markers.ellipsis.length) : marked;
  if (trailingEllipsis) input = input.slice(0, -markers.ellipsis.length);
  if (input.includes(markers.ellipsis)) return omitted;
  let text = "", offset = 0, active: number | null = null;
  const ranges: { start: number; end: number }[] = [];
  while (offset < input.length) {
    const start = input.indexOf(markers.start, offset), end = input.indexOf(markers.end, offset);
    const next = start < 0 ? end : end < 0 ? start : Math.min(start, end);
    if (next < 0) { text += input.slice(offset); break; }
    text += input.slice(offset, next);
    if (next === start) {
      if (active !== null) return omitted;
      active = text.length; offset = next + markers.start.length;
    } else {
      if (active === null || active === text.length) return omitted;
      ranges.push({ start: active, end: text.length }); active = null; offset = next + markers.end.length;
    }
  }
  if (active !== null || !text) return omitted;
  const preview = boundedExcerpt(text), highlights: { start: number; end: number }[] = [];
  // Extend lexical-token edges to enclosing display graphemes when necessary.
  const clusters = [...segmenter.segment(preview)];
  for (const range of ranges) {
    if (range.start >= preview.length) continue;
    const start = clusters.find((part) => part.index + part.segment.length > range.start)?.index;
    const last = clusters.find((part) => part.index + part.segment.length >= Math.min(range.end, preview.length));
    if (start === undefined || !last) continue;
    const end = last.index + last.segment.length, previous = highlights.at(-1);
    if (previous && previous.end >= start) previous.end = Math.max(previous.end, end);
    else highlights.push({ start, end });
  }
  return { fragments: preview ? [{ text: preview, highlights }] : [], leadingEllipsis,
    trailingEllipsis: trailingEllipsis || preview.length < text.length,
    omitted: preview.length < text.length || !preview };
}
