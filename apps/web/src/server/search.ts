import type { DaemonRequest } from "./daemon";
import { decodeSearchQuery, encodeSearchQuery } from "../features/explore/query";
import { decodeSearchPage } from "../features/explore/results";
export interface SearchDependencies { readonly callDaemon: (request: DaemonRequest) => Promise<Response>; }
/** Bun-testable core; route and credentials remain server-only. */
export async function handleSearch(request: Request, deps: SearchDependencies): Promise<Response> {
  const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
  const query = decodeSearchQuery(new URL(request.url).searchParams);
  if (!query) return json({ message: "Invalid search parameters." }, 400);
  try {
    const response = await deps.callDaemon({ method: "GET", path: `/search?${encodeSearchQuery(query)}` });
    if (response.status !== 200) return json({ message: "Search unavailable." }, 502);
    const page = decodeSearchPage(await response.json());
    if (!page) return json({ message: "Search unavailable." }, 502);
    const rejectionStatus: Record<string, boolean | null> = Object.create(null);
    if (query.scope === "show-rejected") {
      const ids = [...new Set(page.results.filter(item => item.kind === "thought").map(item => item.thoughtId))];
      let next = 0;
      async function inspect(): Promise<void> {
        while (next < ids.length) {
          const id = ids[next++];
          if (id === undefined) continue;
          let rejected: boolean | null = null;
          try {
            const detail = await deps.callDaemon({ method: "GET", path: `/thoughts/${encodeURIComponent(id)}?scope=show-rejected` });
            if (detail.status === 200) {
              const data: unknown = await detail.json();
              if (typeof data === "object" && data !== null && "rejected" in data && typeof data.rejected === "boolean") rejected = data.rejected;
            }
          } catch { /* An unavailable inspection is unknown, not active. */ }
          rejectionStatus[id] = rejected;
        }
      }
      await Promise.all(Array.from({ length: Math.min(ids.length, 4) }, () => inspect()));
    }
    return json({ ...page, rejectionStatus }, 200);
  } catch { return json({ message: "Search unavailable." }, 502); }
}
