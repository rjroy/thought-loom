import type { DaemonRequest } from "./daemon";
import { decodeBrowseNeighborhoodReadRequest, decodeBrowseReadRequest, encodeBrowseNeighborhoodReadRequest, encodeBrowseReadRequest } from "../features/browse/query";
import { decodeBrowseNeighborhood, decodeBrowsePage } from "../features/browse/results";

export interface BrowseDependencies {
  readonly callDaemon: (request: DaemonRequest) => Promise<Response>;
}

export interface BrowseProblem {
  readonly code: "invalid-browse-request" | "browse-restart-required" | "browse-unavailable";
  readonly message: string;
}

/** Fixed-purpose read boundary; upstream bodies are never used as public error messages. */
export async function handleBrowse(request: Request, deps: BrowseDependencies): Promise<Response> {
  const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
  const problem = (code: BrowseProblem["code"], message: string, status: number) => json({ code, message } satisfies BrowseProblem, status);
  const query = decodeBrowseReadRequest(new URL(request.url).searchParams);
  if (!query) return problem("invalid-browse-request", "Invalid Browse parameters.", 400);
  if (!query.author.length) return json({ items: [], nextCursor: null }, 200);
  try {
    const response = await deps.callDaemon({ method: "GET", path: `/browse/thoughts?${encodeBrowseReadRequest(query)}` });
    if (response.status === 400 && query.cursor !== undefined) return problem("browse-restart-required", "Refresh this list to continue.", 400);
    if (response.status !== 200) return problem("browse-unavailable", "Ideas could not be loaded.", 502);
    const page = decodeBrowsePage(await response.json(), query);
    return page && page.items.length <= query.limit ? json(page, 200) : problem("browse-unavailable", "Ideas could not be loaded.", 502);
  } catch { return problem("browse-unavailable", "Ideas could not be loaded.", 502); }
}

export interface BrowseNeighborhoodProblem {
  readonly code: "invalid-neighborhood-request" | "neighborhood-restart-required" | "neighborhood-unavailable" | "neighborhood-read-failed";
  readonly message: string;
}

/**
 * Fixed GET /thoughts/:id/neighborhood. 200 scoped page; 400 invalid request or continuation;
 * 404 unavailable focus; 502 read/DTO failure. All results private/no-store and errors sanitized.
 */
export async function handleBrowseNeighborhood(request: Request, id: string, deps: BrowseDependencies): Promise<Response> {
  const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
  const problem = (code: BrowseNeighborhoodProblem["code"], message: string, status: number) => json({ code, message } satisfies BrowseNeighborhoodProblem, status);
  const query = decodeBrowseNeighborhoodReadRequest(id, new URL(request.url).searchParams);
  if (!query) return problem("invalid-neighborhood-request", "Invalid neighborhood request.", 400);
  try {
    const response = await deps.callDaemon({ method: "GET", path: `/thoughts/${encodeURIComponent(id)}/neighborhood?${encodeBrowseNeighborhoodReadRequest(query)}` });
    if (response.status === 404) return problem("neighborhood-unavailable", "Idea unavailable in this view.", 404);
    if (response.status === 400 && query.cursor !== undefined) return problem("neighborhood-restart-required", "Refresh the map to continue.", 400);
    if (response.status !== 200) return problem("neighborhood-read-failed", "Linked ideas could not be loaded.", 502);
    const page = decodeBrowseNeighborhood(await response.json(), id, query.scope);
    return page && page.edges.length <= query.limit ? json(page, 200) : problem("neighborhood-read-failed", "Linked ideas could not be loaded.", 502);
  } catch { return problem("neighborhood-read-failed", "Linked ideas could not be loaded.", 502); }
}
