import { ForbiddenActorError, scopeActiveConnection, scopeActiveThought, type ReadScope } from "./rejection";
import { nonEmpty, ValidationError } from "./validation";
import type { ThoughtAuthor, MaterialKind, MediaSource, Thought } from "./thought";
import type { Connection } from "./connection";

/** A response hit points to its latest eligible associated thought. */
interface SearchHitIdentity {
  readonly id: string;
  readonly thoughtId: string;
}
export type SearchHit = SearchHitIdentity & (
  { readonly kind: "thought" | "response"; readonly text: string }
  | { readonly kind: "thought"; readonly text: null; readonly mediaSource: MediaSource }
);
export interface SearchRepository {
  search(scope: ReadScope, query: string): readonly SearchHit[];
  suggest(scope: ReadScope, term: string): readonly string[];
  query(scope: ReadScope, query: string, options: SearchOptions): SearchPage;
}
export interface SearchOptions {
  readonly authors?: readonly ThoughtAuthor[];
  readonly kinds?: readonly MaterialKind[];
  readonly from?: string;
  readonly to?: string;
  readonly sort?: "relevance" | "newest" | "oldest";
}
export type SearchResult = SearchHit & {
  readonly title: string;
  readonly author: ThoughtAuthor;
  readonly materialKind: MaterialKind;
  readonly createdAt: string;
  readonly snippet: string;
  readonly context: SearchContext | null;
};
export type SearchContext = { readonly kind: "connection"; readonly thought: Thought; readonly connection: Connection }
  | { readonly kind: "predecessor"; readonly thought: Thought };

/** Candidates arrive ordered by own-text relevance, thought ID, then connection ID. */
export function searchContexts(scope: ReadScope, targets: readonly { id: string; parentId: string | null }[],
  candidates: readonly { targetId: string; thoughtId: string; connectionId: string }[],
  thoughts: ReadonlyMap<string, Thought>, connections: ReadonlyMap<string, Connection>,
  rejected: ReadonlySet<string>, rejectedConnections: ReadonlySet<string>): ReadonlyMap<string, SearchContext> {
  const result = new Map<string, SearchContext>();
  for (const candidate of candidates) {
    if (result.has(candidate.targetId)) continue;
    const thought = thoughts.get(candidate.thoughtId);
    const connection = connections.get(candidate.connectionId);
    if (!thought || !connection) continue;
    const visibleThought = scopeActiveThought(scope.actor, thought, rejected);
    const visibleConnection = scopeActiveConnection(scope.actor, connection, rejected, rejectedConnections);
    if (visibleThought && visibleConnection) result.set(candidate.targetId, { kind: "connection", thought: visibleThought, connection: visibleConnection });
  }
  for (const target of targets) {
    if (result.has(target.id) || target.parentId === null) continue;
    const parent = thoughts.get(target.parentId);
    const visible = parent && scopeActiveThought(scope.actor, parent, rejected);
    if (visible) result.set(target.id, { kind: "predecessor", thought: visible });
  }
  return result;
}
export interface SearchPage {
  readonly results: readonly SearchResult[];
  readonly counts: { readonly authors: Readonly<Record<ThoughtAuthor, number>>; readonly kinds: Readonly<Record<MaterialKind, number>> };
}

/** Retrieval and vocabulary must be scoped before publication. */
export class SearchService {
  constructor(private readonly repository: SearchRepository) {}
  query(scope: ReadScope, query: string, options: SearchOptions = {}): SearchPage {
    this.validate(scope);
    nonEmpty(query, "query");
    if (options.authors && (!Array.isArray(options.authors) || options.authors.some(value => value !== "user" && value !== "ai" && value !== "source"))) throw new ValidationError("Invalid author");
    if (options.kinds && (!Array.isArray(options.kinds) || options.kinds.some(value => !["captured-original", "user-contribution", "ai-interpretation", "developing-idea", "imported-original", "media-original"].includes(value)))) throw new ValidationError("Invalid kind");
    if (options.sort !== undefined && !["relevance", "newest", "oldest"].includes(options.sort)) throw new ValidationError("Invalid sort");
    const from = options.from === undefined ? undefined : searchDate(options.from, false);
    const to = options.to === undefined ? undefined : searchDate(options.to, true);
    if (from && to && from > to) throw new ValidationError("Invalid date range");
    return this.repository.query(scope, query, { ...options, from, to });
  }
  private validate(scope: ReadScope): void {
    if (!scope || (scope.actor !== "user" && scope.actor !== "ai") ||
        (scope.mode !== "normal" && scope.mode !== "history" && scope.mode !== "show-rejected") ||
        (scope.actor === "ai" && scope.mode !== "normal")) throw new ForbiddenActorError("Invalid read scope");
  }
  search(scope: ReadScope, query: string): readonly SearchHit[] {
    this.validate(scope);
    return this.repository.search(scope, nonEmpty(query, "query"));
  }
  suggest(scope: ReadScope, term: string): readonly string[] {
    this.validate(scope);
    return this.repository.suggest(scope, nonEmpty(term, "term"));
  }
}

function searchDate(value: string, endOfDay: boolean): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) throw new ValidationError("Invalid date");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new ValidationError("Invalid date");
  return new Date(milliseconds + (endOfDay && value.length === 10 ? 86_399_999 : 0)).toISOString();
}
