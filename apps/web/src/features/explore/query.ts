export type SearchAuthor = "user" | "ai";
export type SearchMaterialKind = "captured-original" | "user-contribution" | "ai-interpretation" | "developing-idea";
export interface SearchQuery {
  readonly q: string;
  readonly author: readonly SearchAuthor[];
  readonly kind: readonly SearchMaterialKind[];
  readonly from?: string;
  readonly to?: string;
  readonly sort: "relevance" | "newest" | "oldest";
  readonly scope: "normal" | "show-rejected";
}
export type DatePreset = "anytime" | "last-7-days" | "last-30-days" | "this-year";
const authors = ["user", "ai"] as const;
const kinds = ["captured-original", "user-contribution", "ai-interpretation", "developing-idea"] as const;
const sorts = ["relevance", "newest", "oldest"] as const;
const scopes = ["normal", "show-rejected"] as const;
function includes<T extends string>(values: readonly T[], value: string): value is T { return values.some(item => item === value); }

function bound(value: string, end: boolean): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z)?$/.exec(value);
  if (!match) return undefined;
  const date = match[1];
  const time = match[2] ?? (end ? "23:59:59" : "00:00:00");
  const fraction = (match[3] ?? (match[2] ? "0" : end ? "999" : "0")).padEnd(3, "0");
  const normalized = `${date}T${time}.${fraction}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === normalized ? timestamp : undefined;
}

export function decodeSearchQuery(params: URLSearchParams): SearchQuery | undefined {
  const singleton = ["q", "from", "to", "sort", "scope"];
  if ([...params.keys()].some(key => !singleton.includes(key) && key !== "author" && key !== "kind")
      || singleton.some(key => params.getAll(key).length > 1)) return undefined;
  const q = params.get("q");
  const author = params.getAll("author"), kind = params.getAll("kind");
  const sort = params.get("sort") ?? "relevance", scope = params.get("scope") ?? "normal";
  const from = params.get("from"), to = params.get("to");
  if (!q?.trim() || !author.every(value => includes(authors, value)) || !kind.every(value => includes(kinds, value))
      || !includes(sorts, sort) || !includes(scopes, scope)) return undefined;
  const start = from === null ? undefined : bound(from, false), end = to === null ? undefined : bound(to, true);
  if ((from !== null && start === undefined) || (to !== null && end === undefined)
      || (start !== undefined && end !== undefined && start > end)) return undefined;
  return { q, author, kind, ...(from !== null ? { from } : {}), ...(to !== null ? { to } : {}), sort, scope };
}
export function encodeSearchQuery(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams({ q: query.q });
  for (const author of query.author) params.append("author", author);
  for (const kind of query.kind) params.append("kind", kind);
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  params.set("sort", query.sort); params.set("scope", query.scope);
  return params;
}
export function clearSearchFilters(query: SearchQuery): SearchQuery {
  return { q: query.q, author: [], kind: [], sort: query.sort, scope: "normal" };
}
export function datePreset(preset: DatePreset, now: Date): { readonly from?: string; readonly to?: string } {
  if (preset === "anytime") return {};
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = date.toISOString().slice(0, 10);
  if (preset === "this-year") date.setUTCMonth(0, 1);
  else date.setUTCDate(date.getUTCDate() - (preset === "last-7-days" ? 6 : 29));
  return { from: date.toISOString().slice(0, 10), to };
}
export function ideaHref(result: { readonly kind: "thought" | "response"; readonly id: string; readonly thoughtId: string }, returnTo: string): string {
  const params = new URLSearchParams();
  if (result.kind === "response") params.set("responseId", result.id);
  if (returnTo === "/explore" || (returnTo.startsWith("/explore?") && !/[\\#\x00-\x1f\x7f]/.test(returnTo)
      && decodeSearchQuery(new URLSearchParams(returnTo.slice("/explore?".length))) !== undefined)) params.set("returnTo", returnTo);
  const suffix = params.toString();
  return `/ideas/${encodeURIComponent(result.thoughtId)}${suffix ? `?${suffix}` : ""}`;
}
