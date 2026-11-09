import type { BrowseReadRequest } from "./query";
import type { BrowsePage } from "./results";
import { encodeBrowseReadRequest } from "./query";
import { decodeBrowsePage } from "./results";
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
