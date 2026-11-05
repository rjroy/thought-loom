import type { SearchAuthor, SearchMaterialKind } from "./query";

export interface ContextThought {
  readonly id: string; readonly text: string; readonly title: string | null; readonly titleAuthor?: "user" | "ai" | null;
  readonly author: SearchAuthor; readonly kind: SearchMaterialKind; readonly createdAt: string;
  readonly origin: string; readonly parentId: string | null; readonly sourceIds: readonly string[];
}
export interface ContextConnection {
  readonly id: string; readonly fromId: string; readonly toId: string;
  readonly category: "supports" | "contradicts" | "extends" | "related";
  readonly proposedBy: "user" | "ai"; readonly explanation: string; readonly sourceIds: readonly string[];
}
export interface SearchResult {
  readonly kind: "thought" | "response"; readonly id: string; readonly thoughtId: string;
  readonly text: string; readonly snippet: string; readonly title: string; readonly author: SearchAuthor;
  readonly materialKind: SearchMaterialKind; readonly createdAt: string;
  readonly context: null | { readonly kind: "predecessor"; readonly thought: ContextThought }
    | { readonly kind: "connection"; readonly thought: ContextThought; readonly connection: ContextConnection };
}
export interface SearchPage {
  readonly results: readonly SearchResult[];
  readonly counts: { readonly authors: Readonly<Record<SearchAuthor, number>>; readonly kinds: Readonly<Record<SearchMaterialKind, number>> };
}
export interface WebSearchPage extends SearchPage { readonly rejectionStatus: Readonly<Record<string, boolean | null>>; }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function actor(value: unknown): value is "user" | "ai" { return value === "user" || value === "ai"; }
function author(value: unknown): value is SearchAuthor { return actor(value) || value === "source"; }
function material(value: unknown): value is SearchMaterialKind {
  return value === "captured-original" || value === "user-contribution" || value === "ai-interpretation" || value === "developing-idea" || value === "imported-original";
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function thought(value: unknown): value is ContextThought {
  return object(value) && typeof value.id === "string" && typeof value.text === "string"
    && (typeof value.title === "string" || value.title === null)
    && (value.titleAuthor === undefined || value.titleAuthor === null || actor(value.titleAuthor))
    && author(value.author) && material(value.kind) && typeof value.createdAt === "string"
    && typeof value.origin === "string" && (typeof value.parentId === "string" || value.parentId === null) && strings(value.sourceIds);
}
function connection(value: unknown): value is ContextConnection {
  return object(value) && typeof value.id === "string" && typeof value.fromId === "string" && typeof value.toId === "string"
    && (value.category === "supports" || value.category === "contradicts" || value.category === "extends" || value.category === "related")
    && actor(value.proposedBy) && typeof value.explanation === "string" && strings(value.sourceIds);
}
function result(value: unknown): value is SearchResult {
  if (!object(value) || (value.kind !== "thought" && value.kind !== "response")
      || typeof value.id !== "string" || !value.id || typeof value.thoughtId !== "string" || !value.thoughtId
      || typeof value.text !== "string" || typeof value.snippet !== "string" || typeof value.title !== "string"
      || !author(value.author) || !material(value.materialKind) || typeof value.createdAt !== "string") return false;
  if (value.context === null) return true;
  if (!object(value.context) || !thought(value.context.thought)) return false;
  return value.context.kind === "predecessor" || (value.context.kind === "connection" && connection(value.context.connection));
}
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function decodeSearchPage(value: unknown): SearchPage | undefined {
  if (!object(value) || !Array.isArray(value.results) || !value.results.every(result) || !object(value.counts)
      || !object(value.counts.authors) || !object(value.counts.kinds)) return undefined;
  const a = value.counts.authors, k = value.counts.kinds;
  if (!count(a.user) || !count(a.ai) || !count(a.source) || !count(k["captured-original"]) || !count(k["user-contribution"])
      || !count(k["ai-interpretation"]) || !count(k["developing-idea"]) || !count(k["imported-original"])) return undefined;
  return value as unknown as SearchPage;
}
export function decodeWebSearchPage(value: unknown): WebSearchPage | undefined {
  const page = decodeSearchPage(value);
  if (!page || !object(value) || !object(value.rejectionStatus)
      || !Object.values(value.rejectionStatus).every(status => status === null || typeof status === "boolean")) return undefined;
  return value as unknown as WebSearchPage;
}
