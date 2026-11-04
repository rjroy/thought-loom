import { decodeSearchQuery, encodeSearchQuery, type SearchQuery } from "./query";
import { decodeWebSearchPage, type WebSearchPage } from "./results";
export type SearchFetchResult = { readonly kind: "success"; readonly page: WebSearchPage } | { readonly kind: "error"; readonly message: string };
export async function fetchSearch(query: SearchQuery, deps: { readonly fetch: typeof fetch; readonly signal?: AbortSignal }): Promise<SearchFetchResult> {
  const failure: SearchFetchResult = { kind: "error", message: "Search unavailable." };
  try {
    const params = encodeSearchQuery(query);
    if (!decodeSearchQuery(params)) return failure;
    const response = await deps.fetch(`/api/search?${params}`, { method: "GET", cache: "no-store", signal: deps.signal, redirect: "error" });
    if (response.status !== 200) return failure;
    const page = decodeWebSearchPage(await response.json());
    return page ? { kind: "success", page } : failure;
  } catch { return failure; }
}
