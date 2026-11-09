export interface BrowseQuery {
  readonly sort: "newest" | "oldest";
  readonly author: readonly ("user" | "ai")[];
  readonly scope: "normal" | "show-rejected";
}

export interface BrowseReadRequest extends BrowseQuery {
  readonly limit: number;
  readonly cursor?: string;
}

export function decodeBrowseQuery(params: URLSearchParams): BrowseQuery | undefined {
  if ([...params.keys()].some(key => !["sort", "author", "scope"].includes(key))
      || ["sort", "scope"].some(key => params.getAll(key).length > 1)) return undefined;
  const sort = params.get("sort") ?? "newest", scope = params.get("scope") ?? "normal";
  if ((sort !== "newest" && sort !== "oldest") || (scope !== "normal" && scope !== "show-rejected")) return undefined;
  const selected = params.getAll("author");
  if (selected.includes("none")) return selected.length === 1 ? { sort, author: [], scope } : undefined;
  if (selected.some(value => value !== "user" && value !== "ai")) return undefined;
  const author = (["user", "ai"] as const).filter(value => !selected.length || selected.includes(value));
  return { sort, author, scope };
}

export function encodeBrowseQuery(query: BrowseQuery): URLSearchParams {
  const params = new URLSearchParams({ sort: query.sort });
  for (const value of query.author.length ? query.author : ["none"]) params.append("author", value);
  params.set("scope", query.scope);
  const normalized = decodeBrowseQuery(params);
  if (!normalized) throw new Error("Invalid Browse query");
  params.delete("author");
  for (const value of normalized.author.length ? normalized.author : ["none"]) params.append("author", value);
  return params;
}

/** API-only limit (default 50, range 1–200) and opaque cursor, in addition to list filters. */
export function decodeBrowseReadRequest(params: URLSearchParams): BrowseReadRequest | undefined {
  if (["limit", "cursor"].some(key => params.getAll(key).length > 1)) return undefined;
  const filters = new URLSearchParams(params);
  filters.delete("limit"); filters.delete("cursor");
  const query = decodeBrowseQuery(filters), rawLimit = params.get("limit"), cursor = params.get("cursor");
  const limit = rawLimit === null ? 50 : /^[1-9]\d*$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!query || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || (cursor !== null && (!cursor.trim() || cursor.length > 8192 || /[\x00-\x1f\x7f]/.test(cursor)))) return undefined;
  return { ...query, limit, ...(cursor === null ? {} : { cursor }) };
}

export function encodeBrowseReadRequest(request: BrowseReadRequest): URLSearchParams {
  const params = encodeBrowseQuery(request);
  params.set("limit", String(request.limit));
  if (request.cursor !== undefined) params.set("cursor", request.cursor);
  if (!decodeBrowseReadRequest(params)) throw new Error("Invalid Browse read request");
  return params;
}

export function browseListHref(query: BrowseQuery): string {
  return `/browse?${encodeBrowseQuery(query)}`;
}

/** Future .4 destination only; no map route or active UI link is added in .3. */
export function browseMapHref(id: string, returnTo: string = "/browse", scope: BrowseQuery["scope"] = "normal"): string {
  if (!id.trim() || id === "." || id === "..") return "/browse";
  let safeReturn = "/browse";
  if (returnTo.startsWith("/browse?") && !/[\\#\x00-\x1f\x7f]/.test(returnTo)) {
    const query = decodeBrowseQuery(new URLSearchParams(returnTo.slice("/browse?".length)));
    if (query) safeReturn = browseListHref(query);
  }
  const params = new URLSearchParams({ returnTo: safeReturn });
  if (scope === "show-rejected") params.set("scope", scope);
  return `/browse/${encodeURIComponent(id)}?${params}`;
}
