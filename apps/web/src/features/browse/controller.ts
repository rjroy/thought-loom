import type { BrowseQuery } from "./query";
import type { BrowseClient, BrowseFailureReason } from "./request";
import type { BrowsePage } from "./results";
import { decodeBrowseQuery, encodeBrowseQuery } from "./query";
import type { BrowseFetchResult } from "./request";

export interface BrowseState {
  readonly query: BrowseQuery;
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly items: BrowsePage["items"];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly problem: {
    readonly reason: BrowseFailureReason;
    readonly stage: "first" | "more";
    readonly message: string;
  } | null;
}

export interface BrowseController {
  getSnapshot(): BrowseState;
  subscribe(listener: () => void): () => void;
  setQuery(query: BrowseQuery): Promise<void>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  invalidate(): void;
  dispose(): void;
}

/** Controlled read owner; pageSize is injectable so tests own their pagination inputs. */
export function createBrowseController(
  initialQuery: BrowseQuery,
  client: BrowseClient,
  options: { readonly pageSize?: number } = {},
): BrowseController {
  const pageSize = options.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error("Invalid Browse page size");
  const normalize = (query: BrowseQuery) => {
    const value = decodeBrowseQuery(encodeBrowseQuery(query));
    if (!value) throw new Error("Invalid Browse query");
    return value;
  };
  let state: BrowseState = { query: normalize(initialQuery), phase: "idle", items: [], nextCursor: null, loadingMore: false, problem: null };
  let generation = 0, disposed = false;
  let active: { readonly abort: AbortController; readonly generation: number; promise: Promise<void> } | null = null;
  const listeners = new Set<() => void>();
  const publish = (change: Partial<BrowseState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const cancel = () => { generation++; active?.abort.abort(); active = null; };
  function read(more: boolean): Promise<void> {
    if (disposed) return Promise.resolve();
    if (more && active) return active.promise;
    if (more && (state.phase !== "ready" || state.nextCursor === null || state.problem?.reason === "restart-required")) return Promise.resolve();
    const cursor = more ? state.nextCursor : null;
    cancel();
    if (!state.query.author.length) {
      publish({ phase: "ready", items: [], nextCursor: null, loadingMore: false, problem: null });
      return Promise.resolve();
    }
    const flight = { abort: new AbortController(), generation, promise: Promise.resolve() };
    active = flight;
    publish(more ? { loadingMore: true, problem: null } : { phase: "loading", items: [], nextCursor: null, loadingMore: false, problem: null });
    if (active !== flight) return Promise.resolve();
    const query = state.query;
    const current = () => !disposed && active === flight && generation === flight.generation && !flight.abort.signal.aborted;
    flight.promise = (async () => {
      let result: BrowseFetchResult;
      try {
        result = await client.read({ ...query, limit: pageSize, ...(cursor === null ? {} : { cursor }) }, flight.abort.signal);
      } catch { result = { kind: "error", reason: "read-failed", message: "Ideas could not be loaded." }; }
      if (!current()) return;
      active = null;
      if (result.kind === "error") {
        publish({ phase: more ? "ready" : "error", loadingMore: false,
          problem: { reason: result.reason, stage: more ? "more" : "first", message: result.message } });
        return;
      }
      const items = more ? [...state.items] : [];
      const known = new Set(items.map(item => item.id));
      for (const item of result.page.items) if (!known.has(item.id)) { known.add(item.id); items.push(item); }
      // A repeated cursor cannot make progress. Keep confirmed words, require an explicit restart.
      const stalled = cursor !== null && result.page.nextCursor === cursor;
      publish({ phase: "ready", items, nextCursor: result.page.nextCursor, loadingMore: false,
        problem: stalled ? { reason: "restart-required", stage: "more", message: "Refresh this list to continue." } : null });
    })();
    return flight.promise;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setQuery(query) {
      if (disposed) return Promise.resolve();
      const normalized = normalize(query);
      if (encodeBrowseQuery(normalized).toString() === encodeBrowseQuery(state.query).toString()) {
        return state.phase === "idle" ? read(false) : active?.promise ?? Promise.resolve();
      }
      cancel();
      publish({ query: normalized, phase: "idle", items: [], nextCursor: null, loadingMore: false, problem: null });
      return read(false);
    },
    refresh: () => read(false),
    loadMore: () => read(true),
    invalidate() { if (!disposed) { cancel(); publish({ phase: "idle", items: [], nextCursor: null, loadingMore: false, problem: null }); } },
    dispose() { disposed = true; cancel(); listeners.clear(); },
  };
}
