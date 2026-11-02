import { Database } from "bun:sqlite";
import { compileQuery, createFieldMatcher, compareRanks, type CompiledQuery, type FieldMatch, type MatchRank } from "./fuzzy-matcher";
import { FUZZY_PROJECTION_FORMAT_VERSION, iterateCanonicalProjectionTargets, iterateTargetProjectionFields, type ProjectionField, type ProjectionFieldKind, type ProjectionTarget } from "./fuzzy-projection";
import { consumeField } from "./fuzzy-field-reader";
import { buildPassage, type FuzzyPassage } from "./fuzzy-passage";
import { DEFAULT_FUZZY_READ_POLICY, FuzzySearchError, FuzzySearchWork, type FuzzyReadPolicy } from "./fuzzy-search-work";

export type { FuzzyPassage, FuzzyPassageFragment } from "./fuzzy-passage";
export { FuzzySearchError } from "./fuzzy-search-work";

export type FuzzySearchInput = Readonly<{ query: string; limit: number; signal?: AbortSignal }>;
export type FuzzyRetrieverOptions = Readonly<{
  databasePath: string;
  // Internal dependency injection, never model/client-controlled work budgets.
  yieldControl?: () => Promise<void>;
  now?: () => number;
  policy?: FuzzyReadPolicy;
}>;

export type FuzzyMatch = Readonly<{
  target: ProjectionTarget;
  match: FieldMatch & Readonly<{ field: ProjectionFieldKind; route: "direct" | "alias" }>;
  passage: FuzzyPassage;
}>;
export type FuzzySearchResult = Readonly<{ matches: readonly FuzzyMatch[]; hasMore: boolean }>;
export type FuzzyRetriever = { search(input: FuzzySearchInput): Promise<FuzzySearchResult> };

type Winner = Readonly<{ field: ProjectionField; match: FieldMatch; rank: MatchRank; bytes: number }>;

function winner(field: ProjectionField, match: FieldMatch): Winner {
  const target = field.target, itemId = target.kind === "item" ? target.itemId : "";
  const revisionId = field.kind === "title" ? target.titleRevisionId ?? "" :
    target.kind === "item" ? target.formulationId : target.sourceId;
  return { field, match,
    rank: { route: "direct", class: match.class, skipped: match.skipped, field: field.kind === "title" ? "title" : "body",
      start: match.start, targetKind: target.kind, sourceId: target.sourceId, itemId, revisionId, aliasId: "" },
    bytes: 1_024 + 8 * (target.sourceId.length + itemId.length + revisionId.length + (target.titleRevisionId?.length ?? 0)) };
}

// A max heap keeps the worst retained target at its root. Targets arrive once,
// after all of their fields have been compared; there is no corpus-sized Set.
class WinnerHeap {
  private readonly values: Winner[] = [];
  constructor(private readonly capacity: number, private readonly work: FuzzySearchWork) {}

  add(value: Winner): void {
    if (this.values.length < this.capacity) {
      this.work.reserve(value.bytes);
      this.values.push(value);
      let index = this.values.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (compareRanks(this.values[index].rank, this.values[parent].rank) <= 0) break;
        [this.values[index], this.values[parent]] = [this.values[parent], this.values[index]];
        index = parent;
      }
      return;
    }
    const root = this.values[0];
    if (compareRanks(value.rank, root.rank) >= 0) return;
    if (value.bytes > root.bytes) this.work.reserve(value.bytes - root.bytes);
    else this.work.release(root.bytes - value.bytes);
    this.values[0] = value;
    let index = 0;
    while (true) {
      const left = index * 2 + 1, right = left + 1;
      let worst = index;
      if (left < this.values.length && compareRanks(this.values[left].rank, this.values[worst].rank) > 0) worst = left;
      if (right < this.values.length && compareRanks(this.values[right].rank, this.values[worst].rank) > 0) worst = right;
      if (worst === index) break;
      [this.values[index], this.values[worst]] = [this.values[worst], this.values[index]];
      index = worst;
    }
  }

  ordered(): Winner[] { return [...this.values].sort((a, b) => compareRanks(a.rank, b.rank)); }
}

async function scan(db: Database, query: CompiledQuery, limit: number, work: FuzzySearchWork): Promise<FuzzySearchResult> {
  // Reserve known query/prefix/alignment state and the bounded final passage
  // payload/highlight arrays. Individual chunks are preflighted separately.
  work.reserve(query.keys.reduce((bytes, key) => bytes + key.length * 2 + 96, 0) +
    limit * (4_096 * 2 + query.keys.length * 32 + 1_024));
  const heap = new WinnerHeap(limit + 1, work);
  for (const target of iterateCanonicalProjectionTargets(db)) {
    work.check();
    work.targets++;
    let best: Winner | null = null;
    for (const field of iterateTargetProjectionFields(db, target, (length) => work.checkChunk(length))) {
      const matcher = createFieldMatcher(query);
      await consumeField(field, matcher, work);
      const match = matcher.result();
      if (match) {
        const candidate = winner(field, match);
        if (!best || compareRanks(candidate.rank, best.rank) < 0) best = candidate;
      }
    }
    if (best) heap.add(best);
  }
  const selected = heap.ordered(), matches: FuzzyMatch[] = [];
  for (const value of selected.slice(0, limit)) {
    const passage = await buildPassage(value.field, query, value.match, work);
    matches.push({ target: value.field.target, match: { ...value.match, field: value.field.kind, route: "direct" }, passage });
  }
  work.check();
  return { matches, hasMore: selected.length > limit };
}

function validateInput(input: FuzzySearchInput): CompiledQuery | null {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200 ||
      input.query.length > 512 || /[\uD800-\uDFFF]/u.test(input.query)) {
    throw new FuzzySearchError("invalid", "Invalid search query or limit");
  }
  return compileQuery(input.query);
}

// Internal phase-2 engine: public transports still use the old staged reader
// until the coordinated contract/alias/cutover phase. Search never initializes,
// migrates, writes to, or falls back from this read-only connection.
export function createFuzzyRetriever(options: FuzzyRetrieverOptions): FuzzyRetriever {
  const policy = Object.freeze({ ...(options.policy ?? DEFAULT_FUZZY_READ_POLICY) });
  if (!Number.isFinite(policy.deadlineMs) || policy.deadlineMs <= 0 ||
      !Number.isSafeInteger(policy.workingSetBytes) || policy.workingSetBytes <= 0) throw new RangeError("Invalid search policy");
  let active = false;
  return { async search(input): Promise<FuzzySearchResult> {
    const query = validateInput(input);
    if (!query) return { matches: [], hasMore: false };
    if (active) throw new FuzzySearchError("busy", "Another search is active");
    active = true;
    const work = new FuzzySearchWork(policy, input.signal, options.now, options.yieldControl);
    const metadata = { engineVersion: 1, projectionVersion: FUZZY_PROJECTION_FORMAT_VERSION,
      limit: input.limit, queryLength: input.query.length };
    console.info("fuzzy.search attempt", metadata);
    let opened = false;
    try {
      work.check();
      const db = new Database(options.databasePath, { readonly: true, create: false });
      opened = true;
      let transaction = false;
      let result: FuzzySearchResult;
      try {
        db.exec("BEGIN");
        transaction = true;
        // BEGIN is deferred. A real canonical read, not a callback or PRAGMA,
        // pins the snapshot before any scheduling hook can run another writer.
        const pin = db.prepare<{ id: string }, []>("SELECT id FROM sources ORDER BY id");
        try { pin.get(); } finally { pin.finalize(); }
        await work.yield();
        result = await scan(db, query, input.limit, work);
        db.exec("COMMIT");
        transaction = false;
      } finally {
        try { if (transaction) db.exec("ROLLBACK"); } finally { db.close(); }
      }
      console.info("fuzzy.search succeeded", { ...metadata, targets: work.targets, chunks: work.chunks,
        updates: work.updates, elapsedMs: work.elapsedMs, resultCount: result.matches.length, hasMore: result.hasMore });
      return result;
    } catch (error) {
      const failure = error instanceof FuzzySearchError ? error : new FuzzySearchError(opened ? "projection" : "unavailable", "Search unavailable");
      console.warn("fuzzy.search failed", { ...metadata, targets: work.targets, chunks: work.chunks,
        updates: work.updates, elapsedMs: work.elapsedMs, category: failure.code });
      throw failure;
    } finally { active = false; }
  } };
}
