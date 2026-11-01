// Pure ordered-grapheme matching. SQL traversal and public search live elsewhere.

export type MatchClass = "whole-word" | "contiguous" | "initials" | "scattered";

export type CompiledQuery = Readonly<{ text: string; keys: readonly string[] }>;

// Half-open UTF-16 offsets into the original, unnormalized field text.
export type OriginalRange = Readonly<{ start: number; end: number }>;

// Match positions are normalized-key offsets; reconstruction supplies text ranges.
export type FieldMatch = Readonly<{
  class: MatchClass;
  start: number;
  end: number;
  skipped: number;
}>;

export type MatchRank = Readonly<{
  route: "direct" | "alias";
  class: MatchClass;
  skipped: number;
  field: "title" | "body";
  start: number;
  targetKind: "source" | "item";
  sourceId: string;
  itemId: string;
  revisionId: string;
  aliasId: string;
}>;

export type MatcherStep = Readonly<{ done: boolean; updates: number }>;

export type FieldMatcher = {
  // Chunks end at original grapheme boundaries. Drain step() before appending.
  append(chunk: string, final: boolean): void;
  // One update prepares an input grapheme/boundary or advances one prefix state.
  // Unicode built-ins still operate synchronously on that individual grapheme.
  step(maxUpdates: number): MatcherStep;
  result(): FieldMatch | null;
};

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const whitespace = /^\p{White_Space}+$/u;
const wordCharacter = /[\p{L}\p{N}\p{M}]/u;
const lowercase = /\p{Ll}/u;
const uppercase = /[\p{Lu}\p{Lt}]/u;
const loneSurrogate = /[\uD800-\uDFFF]/u;
const classOrder = { "whole-word": 0, contiguous: 1, initials: 2, scattered: 3 } as const;

type LetterContext = Readonly<{ word: boolean; lower: boolean; upper: boolean }>;
type Unit = OriginalRange & LetterContext & Readonly<{ key: string; whitespace: boolean }>;
type FieldToken = Unit & Readonly<{
  position: number;
  initial: boolean;
  startEdge: boolean;
  endEdge: boolean;
}>;

function normalizeUnit(text: string, start: number): Unit {
  const space = whitespace.test(text);
  return {
    start, end: start + text.length,
    key: space ? " " : text.normalize("NFC").toLowerCase().normalize("NFC"),
    whitespace: space, word: wordCharacter.test(text),
    lower: lowercase.test(text), upper: uppercase.test(text),
  };
}

function context(unit: Unit): LetterContext {
  // Do not retain a preceding chunk's text/key just to remember its casing.
  return { word: unit.word, lower: unit.lower, upper: unit.upper };
}

function extendWhitespace(left: Unit, right: Unit): Unit {
  return { ...left, end: right.end };
}

function token(unit: Unit, position: number, previous: LetterContext | null, next: Unit | null): FieldToken {
  return {
    ...unit, position,
    initial: unit.word && (!previous?.word || (unit.upper &&
      (previous.lower || (previous.upper && next?.lower === true)))),
    startEdge: !unit.word || !previous?.word,
    endEdge: !unit.word || !next?.word,
  };
}

// Synchronous convenience traversal for bounded query/unit-test strings. Only a
// whitespace run and one token of lookahead are retained, never a token matrix.
function* fieldTokens(text: string): Generator<FieldToken> {
  let pending: Unit | null = null, previous: LetterContext | null = null, position = 0;
  for (const part of segmenter.segment(text)) {
    const next = normalizeUnit(part.segment, part.index);
    if (pending?.whitespace && next.whitespace) pending = extendWhitespace(pending, next);
    else {
      if (pending) {
        yield token(pending, position++, previous, next);
        previous = context(pending);
      }
      pending = next;
    }
  }
  if (pending) yield token(pending, position, previous, null);
}

export function compileQuery(text: string): CompiledQuery | null {
  // In Unicode mode the surrogate range matches unpaired surrogates, not pairs.
  if (text.length > 512 || loneSurrogate.test(text)) return null;
  const keys = [...fieldTokens(text)].map((unit) => unit.key);
  if (!keys.length || keys.every((key) => key === " ")) return null;
  return Object.freeze({ text, keys: Object.freeze(keys) });
}

class StreamingFieldMatcher implements FieldMatcher {
  private readonly starts: Float64Array;
  private readonly initialStarts: Float64Array;
  private readonly contiguousStarts: Float64Array;
  private readonly contiguousEdges: Uint8Array;
  private input: Iterator<Intl.SegmentData> | null = null;
  private pending: Unit | null = null;
  private active: FieldToken | null = null;
  private previous: LetterContext | null = null;
  private originalLength = 0;
  private chunkBase = 0;
  private position = 0;
  private prefix = 0;
  private channel: 0 | 1 | 2 = 0;
  private finalChunk = false;
  private ended = false;
  private best: FieldMatch | null = null;

  constructor(private readonly query: CompiledQuery) {
    const size = query.keys.length;
    if (!size || size > 512) throw new RangeError("Invalid compiled query length");
    this.starts = new Float64Array(size).fill(-1);
    this.initialStarts = new Float64Array(size).fill(-1);
    this.contiguousStarts = new Float64Array(size).fill(-1);
    this.contiguousEdges = new Uint8Array(size);
  }

  append(chunk: string, final: boolean): void {
    if (this.input || this.active || this.ended) throw new Error("Field chunk is not ready");
    if (!Number.isSafeInteger(this.originalLength + chunk.length)) throw new RangeError("Field offsets overflow");
    this.chunkBase = this.originalLength;
    this.originalLength += chunk.length;
    this.finalChunk = final;
    this.input = segmenter.segment(chunk)[Symbol.iterator]();
  }

  step(maxUpdates: number): MatcherStep {
    if (!Number.isSafeInteger(maxUpdates) || maxUpdates < 1) throw new RangeError("Invalid matcher work budget");
    let updates = 0;
    while (updates < maxUpdates && (this.input || this.active)) {
      if (this.active) this.advancePrefix(this.active);
      else this.advanceInput();
      updates++;
    }
    return { done: this.input === null && this.active === null, updates };
  }

  result(): FieldMatch | null {
    if (!this.ended) throw new Error("Field has not finished");
    return this.best;
  }

  private advanceInput(): void {
    const part = this.input?.next();
    if (!part) return;
    if (part.done) {
      this.input = null;
      if (this.finalChunk) {
        const last = this.pending;
        this.pending = null;
        if (last) this.beginToken(last, null);
        else this.ended = true;
      }
      return;
    }
    const next = normalizeUnit(part.value.segment, this.chunkBase + part.value.index);
    if (this.pending?.whitespace && next.whitespace) this.pending = extendWhitespace(this.pending, next);
    else {
      const current = this.pending;
      this.pending = next;
      if (current) this.beginToken(current, next);
    }
  }

  private beginToken(unit: Unit, next: Unit | null): void {
    this.active = token(unit, this.position++, this.previous, next);
    this.prefix = this.query.keys.length - 1;
    this.channel = 0;
  }

  private advancePrefix(current: FieldToken): void {
    const j = this.prefix, same = this.query.keys[j] === current.key;
    if (this.channel === 2) {
      // Reset every contiguous cell, even on a miss. Right-to-left updates leave
      // the predecessor cell describing the immediately preceding field token.
      const start = !same ? -1 : j === 0 ? current.position : this.contiguousStarts[j - 1];
      const edge = j === 0 ? current.startEdge : this.contiguousEdges[j - 1] === 1;
      this.contiguousStarts[j] = start;
      this.contiguousEdges[j] = start >= 0 && edge ? 1 : 0;
      if (j === this.query.keys.length - 1 && start >= 0) {
        this.consider(edge && current.endEdge ? "whole-word" : "contiguous", start, current.position + 1);
      }
    } else {
      const starts = this.channel === 0 ? this.starts : this.initialStarts;
      if (same && (this.channel === 0 || current.whitespace || current.initial)) {
        const start = j === 0 ? current.position : starts[j - 1];
        if (start >= 0) {
          // A later feasible start dominates earlier starts at all future ends.
          starts[j] = start;
          if (j === this.query.keys.length - 1) {
            this.consider(this.channel === 0 ? "scattered" : "initials", start, current.position + 1);
          }
        }
      }
    }
    if (this.channel < 2) this.channel = this.channel === 0 ? 1 : 2;
    else {
      this.channel = 0;
      if (--this.prefix < 0) {
        this.previous = context(current);
        this.active = null;
        if (!this.input && this.finalChunk && !this.pending) this.ended = true;
      }
    }
  }

  private consider(cls: MatchClass, start: number, end: number): void {
    const skipped = end - start - this.query.keys.length;
    if (this.best && (classOrder[cls] - classOrder[this.best.class] ||
        skipped - this.best.skipped || start - this.best.start) >= 0) return;
    this.best = { class: cls, start, end, skipped };
  }
}

export function createFieldMatcher(query: CompiledQuery): FieldMatcher {
  return new StreamingFieldMatcher(query);
}

// Whole-string convenience for current callers/tests, with O(query) extra state.
// SQL must use a future resumable, pinned-span reconstruction adapter rather than
// materialize an entire large body merely to call this synchronous helper.
export function reconstructAlignment(
  query: CompiledQuery,
  text: string,
  match: FieldMatch,
): OriginalRange[] {
  if (!Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end) || match.start < 0 ||
      match.end <= match.start || match.end - match.start - query.keys.length !== match.skipped) {
    throw new RangeError("Invalid match span");
  }
  const ranges: OriginalRange[] = [];
  for (const current of fieldTokens(text)) {
    if (current.position < match.start) continue;
    if (current.position >= match.end) break;
    const j = ranges.length;
    if (j === 0 && current.position !== match.start) break;
    // Pin both endpoints, choosing the earliest feasible intermediate positions.
    if (j === query.keys.length - 1 && current.position !== match.end - 1) continue;
    if (query.keys[j] !== current.key || (match.class === "initials" && !current.whitespace && !current.initial)) continue;
    if (match.class === "whole-word" && ((j === 0 && !current.startEdge) ||
        (j === query.keys.length - 1 && !current.endEdge))) break;
    ranges.push({ start: current.start, end: current.end });
    if (ranges.length === query.keys.length) return ranges;
  }
  throw new Error("Match does not describe this field");
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareRanks(left: MatchRank, right: MatchRank): number {
  return Number(left.route === "alias") - Number(right.route === "alias") ||
    classOrder[left.class] - classOrder[right.class] || left.skipped - right.skipped ||
    Number(left.field === "body") - Number(right.field === "body") || left.start - right.start ||
    Number(left.targetKind === "item") - Number(right.targetKind === "item") ||
    binaryCompare(left.sourceId, right.sourceId) || binaryCompare(left.itemId, right.itemId) ||
    binaryCompare(left.revisionId, right.revisionId) || binaryCompare(left.aliasId, right.aliasId);
}
