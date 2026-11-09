import type { BrowseNeighborhoodReadRequest, BrowseReadRequest } from "./query";
import type { BrowseNeighborhoodPage, BrowsePage } from "./results";
import { encodeBrowseNeighborhoodReadRequest, encodeBrowseReadRequest } from "./query";
import { decodeBrowseNeighborhood, decodeBrowsePage } from "./results";
import { record } from "../idea/validation";

export type BrowseFailureReason = "read-failed" | "restart-required";
export type BrowseFetchResult =
  | { readonly kind: "success"; readonly page: BrowsePage }
  | { readonly kind: "error"; readonly reason: BrowseFailureReason; readonly message: string };

export interface BrowseClient {
  read(request: BrowseReadRequest, signal?: AbortSignal): Promise<BrowseFetchResult>;
}

/** Fixed same-origin GET /api/browse/thoughts; no credentials or daemon URL in client input. */
export async function fetchBrowsePage(
  request: BrowseReadRequest,
  deps: { readonly fetch: typeof fetch; readonly signal?: AbortSignal },
): Promise<BrowseFetchResult> {
  const failure: BrowseFetchResult = { kind: "error", reason: "read-failed", message: "Ideas could not be loaded." };
  try {
    const params = encodeBrowseReadRequest(request);
    const response = await deps.fetch(`/api/browse/thoughts?${params}`, {
      method: "GET", cache: "no-store", redirect: "error", signal: deps.signal,
    });
    if (response.status === 400 && request.cursor !== undefined) {
      const problem: unknown = await response.json();
      if (record(problem) && problem.code === "browse-restart-required") return {
        kind: "error", reason: "restart-required", message: "This list needs refreshing. Refresh to load the current ideas.",
      };
    }
    if (response.status !== 200) return failure;
    const page = decodeBrowsePage(await response.json(), request);
    return page && page.items.length <= request.limit ? { kind: "success", page } : failure;
  } catch { return failure; }
}

export type BrowseNeighborhoodResult =
  | { readonly kind: "success"; readonly page: BrowseNeighborhoodPage }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "error"; readonly reason: BrowseFailureReason; readonly message: string };

export interface BrowseNeighborhoodClient {
  read(request: BrowseNeighborhoodReadRequest, signal?: AbortSignal): Promise<BrowseNeighborhoodResult>;
}

/** Release discarded bodies without delaying or changing the classified result. */
function discardNeighborhoodBody(response: Response): void {
  try {
    if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
  } catch { /* Cleanup is best-effort, including synchronous cancellation failures. */ }
}

/** Fixed same-origin GET /api/browse/thoughts/:id/neighborhood; 404 is not a transport failure. */
export async function fetchBrowseNeighborhood(
  request: BrowseNeighborhoodReadRequest,
  deps: { readonly fetch: typeof fetch; readonly signal?: AbortSignal },
): Promise<BrowseNeighborhoodResult> {
  const failure: BrowseNeighborhoodResult = { kind: "error", reason: "read-failed", message: "Linked ideas could not be loaded." };
  try {
    const params = encodeBrowseNeighborhoodReadRequest(request);
    const response = await deps.fetch(`/api/browse/thoughts/${encodeURIComponent(request.id)}/neighborhood?${params}`, {
      method: "GET", cache: "no-store", redirect: "error", signal: deps.signal,
    });
    if (response.status === 404) {
      discardNeighborhoodBody(response);
      return { kind: "unavailable", message: "Idea unavailable in this view." };
    }
    if (response.status === 400 && request.cursor !== undefined) {
      const problem: unknown = await response.json();
      if (record(problem) && problem.code === "neighborhood-restart-required") return {
        kind: "error", reason: "restart-required", message: "Refresh the map to restart from the starting idea.",
      };
    }
    if (response.status !== 200) { discardNeighborhoodBody(response); return failure; }
    const page = decodeBrowseNeighborhood(await response.json(), request.id, request.scope);
    return page && page.edges.length <= request.limit ? { kind: "success", page } : failure;
  } catch { return failure; }
}
