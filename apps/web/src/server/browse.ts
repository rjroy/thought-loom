import type { DaemonRequest } from "./daemon";
import { decodeBrowseReadRequest, encodeBrowseReadRequest } from "../features/browse/query";
import { decodeBrowsePage } from "../features/browse/results";

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
