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

/** Bookmark the starting thought; inspection and expansion remain mounted workspace state. */
export function browseMapHref(id: string, returnTo: string = "/browse", scope: BrowseQuery["scope"] = "normal"): string {
  if (!id.trim() || id === "." || id === "..") return "/browse";
  let safeReturn = "/browse";
  if (returnTo.startsWith("/browse?") && !/[\\#\x00-\x1f\x7f]/.test(returnTo)) {
    const query = decodeBrowseQuery(new URLSearchParams(returnTo.slice("/browse?".length)));
    if (query) safeReturn = returnTo;
  }
  const params = new URLSearchParams({ returnTo: safeReturn });
  if (scope === "show-rejected") params.set("scope", scope);
  return `/browse/${encodeURIComponent(id)}?${params}`;
}

export interface BrowseMapLocation {
  readonly rootId: string;
  readonly scope: BrowseQuery["scope"];
  /** A validated list URL only; never another map, external URL or arbitrary route. */
  readonly returnTo: string;
}

export interface BrowseNeighborhoodReadRequest {
  readonly id: string;
  readonly scope: BrowseQuery["scope"];
  readonly limit: number;
  readonly cursor?: string;
}

/** Map page accepts only scope and returnTo. Invalid return destinations fall back to /browse. */
export function decodeBrowseMapLocation(id: string, params: URLSearchParams): BrowseMapLocation | undefined {
  if (!validBrowseId(id) || [...params.keys()].some(key => key !== "scope" && key !== "returnTo")
      || ["scope", "returnTo"].some(key => params.getAll(key).length > 1)) return undefined;
  const scope = params.get("scope") ?? "normal";
  if (scope !== "normal" && scope !== "show-rejected") return undefined;
  const target = params.get("returnTo");
  return { rootId: id, scope, returnTo: validListReturn(target) ? target : "/browse" };
}

/** Idea return allowlist: a list URL or map URL whose own returnTo is restricted to a list. */
export function safeBrowseReturnTo(value: string | null): string | undefined {
  if (validListReturn(value)) return value;
  if (!value || /[\\#\x00-\x1f\x7f]/.test(value)) return undefined;
  const match = /^\/browse\/([^/?]+)(?:\?([^#]*))?$/.exec(value);
  if (!match?.[1]) return undefined;
  try {
    const params = new URLSearchParams(match[2]);
    if (params.has("returnTo") && !validListReturn(params.get("returnTo"))) return undefined;
    return decodeBrowseMapLocation(decodeURIComponent(match[1]), params) ? value : undefined;
  } catch { return undefined; }
}

function validListReturn(value: string | null): value is string {
  return value === "/browse" || !!value && value.startsWith("/browse?") && !/[\\#\x00-\x1f\x7f]/.test(value)
    && decodeBrowseQuery(new URLSearchParams(value.slice("/browse?".length))) !== undefined;
}
function validBrowseId(id: string): boolean {
  return /^[A-Za-z0-9_~.-]+$/.test(id) && id !== "." && id !== "..";
}

/** Fixed neighborhood read: scope normal/show-rejected, limit default 50/range 1–200, opaque cursor. */
export function decodeBrowseNeighborhoodReadRequest(id: string, params: URLSearchParams): BrowseNeighborhoodReadRequest | undefined {
  if (!validBrowseId(id) || [...params.keys()].some(key => !["scope", "limit", "cursor"].includes(key))
      || ["scope", "limit", "cursor"].some(key => params.getAll(key).length > 1)) return undefined;
  const scope = params.get("scope") ?? "normal", raw = params.get("limit"), cursor = params.get("cursor");
  const limit = raw === null ? 50 : /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  if ((scope !== "normal" && scope !== "show-rejected") || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || cursor !== null && (!cursor.trim() || cursor.length > 8192 || /[\x00-\x1f\x7f]/.test(cursor))) return undefined;
  return { id, scope, limit, ...(cursor === null ? {} : { cursor }) };
}

export function encodeBrowseNeighborhoodReadRequest(request: BrowseNeighborhoodReadRequest): URLSearchParams {
  const params = new URLSearchParams({ scope: request.scope, limit: String(request.limit) });
  if (request.cursor !== undefined) params.set("cursor", request.cursor);
  if (!decodeBrowseNeighborhoodReadRequest(request.id, params)) throw new Error("Invalid neighborhood request");
  return params;
}
