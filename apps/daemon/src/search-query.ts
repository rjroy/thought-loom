import type { Database } from "bun:sqlite";
import type { SearchCorrection, SearchMatch } from "@thoughtloom/contracts";

export type SearchVariant = { expression: string; kind: SearchMatch["kind"]; correctedTerms: SearchCorrection[] };
export const SEARCH_CANDIDATE_LIMIT = 1_000;
const VOCABULARY_LIMIT = 512, PER_TERM_VOCABULARY = 128, CORRECTIONS_PER_TERM = 3, TYPO_VARIANTS = 16;

export function ftsExpression(terms: readonly string[], prefix: boolean): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"${prefix ? "*" : ""}`).join(" AND ");
}

// One insertion, deletion, substitution OR adjacent transposition, over Unicode
// code points. This is a bounded vocabulary comparison, never a note-body scan.
export function oneEditAway(left: string, right: string): boolean {
  const a = Array.from(left), b = Array.from(right);
  if (Math.abs(a.length - b.length) > 1 || left === right) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1).join("") === b.slice(i + 1).join("") ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2).join("") === b.slice(i + 2).join(""));
  }
  const longer = a.length > b.length ? a : b, shorter = a.length > b.length ? b : a;
  return longer.slice(i + 1).join("") === shorter.slice(i).join("");
}

// SQLite's UTF-8 dictionary order is Unicode scalar order, not JavaScript's
// UTF-16 string order. Comparisons stop within the bounded query-sized key.
function dictionaryOrder(left: string, right: string): number {
  let a = 0, b = 0;
  while (a < left.length && b < right.length) {
    const x = left.codePointAt(a), y = right.codePointAt(b);
    if (x === undefined || y === undefined) break;
    if (x !== y) return x - y;
    a += x > 0xffff ? 2 : 1; b += y > 0xffff ? 2 : 1;
  }
  return Number(a < left.length) - Number(b < right.length);
}
function successor(point: number): string | null {
  if (point === 0x10ffff) return null;
  return String.fromCodePoint(point + 1 === 0xd800 ? 0xe000 : point + 1);
}
function prefixEnd(prefix: string): string {
  const points = Array.from(prefix);
  while (points.length) {
    const last = points.pop(), code = last?.codePointAt(0);
    if (code === undefined) continue;
    const next = successor(code);
    if (next !== null) return points.join("") + next;
  }
  // Every route preserves a first query letter/number, so this cannot occur.
  throw new Error("Search vocabulary prefix has no upper bound");
}
type WildcardRoute = { prefix: string; suffix: string; start: string; cursor: string; upper: string; wrapped: boolean };
function wildcardRoutes(points: readonly string[]): WildcardRoute[] {
  const routes: WildcardRoute[] = [], start = points.join("");
  // Longer fixed prefixes first; every non-initial substitution and insertion
  // position participates. No broad first-letter vocabulary walk is used.
  for (let index = points.length; index >= 1; index--) {
    const prefix = points.slice(0, index).join(""), upper = prefixEnd(prefix);
    routes.push({ prefix, suffix: points.slice(index).join(""), start, cursor: start, upper, wrapped: false });
    if (index < points.length) routes.push({ prefix, suffix: points.slice(index + 1).join(""), start, cursor: start, upper, wrapped: false });
  }
  return routes;
}

// A route represents prefix + ONE unknown scalar + suffix. Each indexed seek
// examines one dictionary entry. Jumping to the exact suffix or the next scalar
// skips an entire irrelevant lexical interval, regardless of its word count.
// Start near the typed word, then wrap once to cover smaller replacement keys.
function advanceRoute(route: WildcardRoute, word: string | undefined): { candidate?: string; pending: boolean } {
  let candidate: string | undefined;
  if (word === undefined) route.cursor = route.wrapped ? route.start : route.upper;
  else {
    const point = word.codePointAt(route.prefix.length);
    if (point === undefined) route.cursor = route.prefix + "\u0001";
    else {
      const target = route.prefix + String.fromCodePoint(point) + route.suffix;
      if (word === target) candidate = word;
      const next = successor(point);
      route.cursor = dictionaryOrder(word, target) < 0 ? target : next === null ? route.upper : route.prefix + next + route.suffix;
    }
  }
  if (dictionaryOrder(route.cursor, route.wrapped ? route.start : route.upper) >= 0) {
    if (route.wrapped || route.prefix === route.start) return { candidate, pending: false };
    route.wrapped = true; route.cursor = route.prefix;
  }
  return { candidate, pending: true };
}

export function typoVariants(db: Database, terms: readonly string[], check: () => void): { variants: SearchVariant[]; truncated: boolean } {
  const choices: { index: number; words: string[] }[] = [];
  let probes = 0, truncated = false;
  const membership = db.prepare<{ term: string }, [string]>("SELECT term FROM search_vocabulary WHERE term=?");
  const vocabulary = db.prepare<{ term: string }, [string, string]>(
    "SELECT term FROM search_vocabulary WHERE term>=? AND term<? ORDER BY term LIMIT 1");
  try {
    for (let index = 0; index < terms.length; index++) {
      const term = terms[index], points = Array.from(term);
      if (points.length < 4 || points.length > 32) continue;
      if (probes >= VOCABULARY_LIMIT) { truncated = true; break; }
      const budget = Math.min(PER_TERM_VOCABULARY, VOCABULARY_LIMIT - probes), words: string[] = [], seen = new Set<string>();
      let used = 0;
      function consider(word: string | undefined): void {
        if (word === undefined || seen.has(word) || !oneEditAway(term, word)) return;
        seen.add(word);
        if (words.length < CORRECTIONS_PER_TERM) words.push(word);
        else truncated = true;
      }
      function probe(): void { check(); used++; probes++; }
      // Exact deletions (trailing extra character first), then transpositions,
      // cannot be crowded out by unrelated vocabulary. Preserve the first scalar.
      const exact = new Set<string>();
      for (let at = points.length - 1; at >= 1; at--) exact.add(points.slice(0, at).join("") + points.slice(at + 1).join(""));
      for (let at = points.length - 2; at >= 1; at--) {
        if (points[at] !== points[at + 1]) exact.add([...points.slice(0, at), points[at + 1], points[at], ...points.slice(at + 2)].join(""));
      }
      for (const candidate of exact) {
        if (used === budget) { truncated = true; break; }
        probe(); consider(membership.get(candidate)?.term);
      }
      let pending = wildcardRoutes(points);
      // Round-robin prevents a crowded wildcard position from starving every
      // other position. Empty seeks count too: at most 128/term, 512/request.
      while (pending.length && used < budget) {
        const next: WildcardRoute[] = [];
        for (let at = 0; at < pending.length; at++) {
          if (used === budget) { next.push(...pending.slice(at)); break; }
          const route = pending[at];
          probe();
          const row = vocabulary.get(route.cursor, route.wrapped ? route.start : route.upper);
          const advanced = advanceRoute(route, row?.term);
          consider(advanced.candidate);
          if (advanced.pending) next.push(route);
        }
        pending = next;
      }
      if (pending.length) truncated = true;
      if (words.length) choices.push({ index, words });
    }
  } finally { membership.finalize(); vocabulary.finalize(); }
  const variants: SearchVariant[] = [], seen = new Set<string>();
  function add(replacements: readonly { index: number; term: string }[]): boolean {
    const changes = new Map(replacements.map((entry) => [entry.index, entry.term]));
    const expression = terms.map((term, index) => ftsExpression([changes.get(index) ?? term], !changes.has(index))).join(" AND ");
    if (seen.has(expression)) return true;
    if (variants.length === TYPO_VARIANTS) { truncated = true; return false; }
    seen.add(expression);
    variants.push({ expression, kind: "typo", correctedTerms: replacements.map((entry) => ({ from: terms[entry.index], to: entry.term })) });
    return true;
  }
  for (const choice of choices) for (const term of choice.words) if (!add([{ index: choice.index, term }])) return { variants, truncated };
  // At most two corrected terms; unchanged words still use indexed prefixes.
  for (let i = 0; i < choices.length; i++) for (let j = i + 1; j < choices.length; j++) {
    for (const left of choices[i].words) for (const right of choices[j].words) {
      if (!add([{ index: choices[i].index, term: left }, { index: choices[j].index, term: right }])) return { variants, truncated };
    }
  }
  return { variants, truncated };
}
