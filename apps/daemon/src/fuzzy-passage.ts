import { createAlignmentReconstructor, type AlignmentRange, type CompiledQuery, type FieldMatch, type FieldAlignment } from "./fuzzy-matcher";
import { consumeField, readFieldChunks } from "./fuzzy-field-reader";
import type { ProjectionField } from "./fuzzy-projection";
import type { FuzzySearchWork } from "./fuzzy-search-work";

// All offsets are half-open original-field UTF-16 offsets. Highlights alone are
// fragment-local. Display limits never constrain match admission or its span.
export type FuzzyPassageFragment = Readonly<{
  start: number; end: number; text: string;
  highlights: readonly Readonly<{ start: number; end: number }>[];
}>;
export type FuzzyPassage = Readonly<{
  matchStart: number; matchEnd: number; matchedKeyCount: number;
  omittedMatchedCharacters: boolean; fragments: readonly FuzzyPassageFragment[];
}>;

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const GRAPHEME_BUDGET = 240, PAYLOAD_BUDGET = 4_096;
type Window = { start: number; end: number };

function centeredWindow(start: number, end: number, budget: number, total: number): Window {
  const span = Math.min(end - start, budget), remaining = budget - span;
  return { start: Math.max(0, start - Math.floor(remaining / 2)),
    end: Math.min(total, start + span + Math.ceil(remaining / 2)) };
}

function mergeWindows(windows: Window[]): Window[] {
  const merged: Window[] = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && previous.end >= window.start) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

function passageWindows(alignment: FieldAlignment): Window[] {
  const first = alignment.ranges[0], last = alignment.ranges.at(-1);
  if (!first || !last) throw new Error("Missing alignment ranges");
  if (last.graphemeEnd - first.graphemeStart <= GRAPHEME_BUDGET) {
    return [centeredWindow(first.graphemeStart, last.graphemeEnd, GRAPHEME_BUDGET, alignment.graphemeCount)];
  }
  const middle = alignment.ranges[Math.floor(alignment.ranges.length / 2)];
  if (!middle) throw new Error("Missing middle alignment range");
  const windows = mergeWindows([first, middle, last].map((range) =>
    centeredWindow(range.graphemeStart, range.graphemeEnd, 80, alignment.graphemeCount)));
  let remaining = GRAPHEME_BUDGET - windows.reduce((sum, window) => sum + window.end - window.start, 0);
  // Overlap/field edges can leave spare context. Refill deterministically in
  // source order, never crossing the next window or exceeding the total budget.
  for (let i = 0; i < windows.length && remaining; i++) {
    const window = windows[i];
    const before = Math.min(remaining, window.start - (windows[i - 1]?.end ?? 0));
    window.start -= before;
    remaining -= before;
    const after = Math.min(remaining, (windows[i + 1]?.start ?? alignment.graphemeCount) - window.end);
    window.end += after;
    remaining -= after;
  }
  return mergeWindows(windows);
}

function highlights(ranges: readonly AlignmentRange[], start: number, end: number): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const left = Math.max(range.start, start), right = Math.min(range.end, end);
    if (left >= right) continue;
    const previous = result.at(-1);
    if (previous && previous.end === left - start) previous.end = right - start;
    else result.push({ start: left - start, end: right - start });
  }
  return result;
}

// A bounded third stream hydrates the chosen original-grapheme windows. Retained
// text is <=4096 UTF-16 units and <=240 clusters; a huge winning field is never
// concatenated. Alignment and hydration share the caller's pinned SQL snapshot.
export async function buildPassage(
  field: ProjectionField, query: CompiledQuery, match: FieldMatch, work: FuzzySearchWork,
): Promise<FuzzyPassage> {
  const reconstructor = createAlignmentReconstructor(query, match);
  await consumeField(field, reconstructor, work);
  const alignment = reconstructor.result(), windows = passageWindows(alignment);
  const displays = windows.map((window) => ({ window, start: -1, end: -1, length: 0, pieces: [] as string[], omitted: false }));
  let grapheme = 0, payload = 0, displayIndex = 0;
  for await (const chunk of readFieldChunks(field, work)) {
    for (const part of segmenter.segment(chunk.text)) {
      while (displays[displayIndex] && grapheme >= displays[displayIndex].window.end) displayIndex++;
      const display = displays[displayIndex];
      if (display && grapheme >= display.window.start && !display.omitted) {
        if (payload + part.segment.length > PAYLOAD_BUDGET) {
          payload -= display.length;
          display.length = 0;
          display.pieces.length = 0;
          display.omitted = true;
        } else {
          const start = chunk.start + part.index;
          if (display.start < 0) display.start = start;
          display.end = start + part.segment.length;
          display.length += part.segment.length;
          payload += part.segment.length;
          display.pieces.push(part.segment);
        }
      }
      grapheme++;
      if (work.record(1)) await work.yield();
    }
  }
  if (grapheme !== alignment.graphemeCount) throw new Error("Passage grapheme coverage changed");
  const fragments: FuzzyPassageFragment[] = displays.filter((display) => !display.omitted && display.start >= 0).map((display) => ({
    start: display.start, end: display.end, text: display.pieces.join(""),
    highlights: highlights(alignment.ranges, display.start, display.end),
  }));
  const first = alignment.ranges[0], last = alignment.ranges.at(-1);
  if (!first || !last) throw new Error("Missing passage bounds");
  return { matchStart: first.start, matchEnd: last.end, matchedKeyCount: alignment.ranges.length,
    omittedMatchedCharacters: alignment.ranges.some((range) => !fragments.some((fragment) =>
      fragment.start <= range.start && fragment.end >= range.end)), fragments };
}
