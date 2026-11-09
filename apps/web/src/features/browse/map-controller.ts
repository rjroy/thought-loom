import type { IdeaThought } from "../idea/types";
import type { BrowseMapLocation } from "./query";
import type { BrowseFailureReason, BrowseNeighborhoodClient } from "./request";
import type { NeighborhoodEdge } from "./results";
import type { MapCamera, MapGeometry, MapPositions } from "./map-layout";
import { browseMapGeometry, placeMapNodes } from "./map-layout";
import { decodeBrowseMapLocation } from "./query";
import type { BrowseNeighborhoodResult } from "./request";

export interface BrowseMapProblem {
  readonly reason: BrowseFailureReason | "unavailable";
  readonly message: string;
}

/** null cursor is exhausted only after a successful page, not before the first expansion. */
export interface BrowseMapExpansion {
  readonly phase: "idle" | "loading" | "ready" | "error" | "unavailable";
  readonly loaded: boolean;
  readonly nextCursor: string | null;
  readonly exhausted: boolean;
  readonly problem: BrowseMapProblem | null;
}

export interface BrowseMapState {
  readonly location: BrowseMapLocation;
  readonly phase: "idle" | "loading" | "ready" | "error" | "unavailable";
  readonly selectedId: string | null;
  readonly nodes: readonly IdeaThought[];
  readonly edges: readonly NeighborhoodEdge[];
  readonly expansions: Readonly<Record<string, BrowseMapExpansion>>;
  readonly positions: MapPositions;
  readonly camera: MapCamera;
  readonly presentation: "map" | "linked-list";
  readonly problem: BrowseMapProblem | null;
  readonly notice: "scope-reset" | "selection-unavailable" | "library-changed" | null;
}

export interface BrowseMapController {
  getSnapshot(): BrowseMapState;
  subscribe(listener: () => void): () => void;
  /** First open reads one page; matching root/scope preserves exploration, selection and camera. */
  open(location: BrowseMapLocation): Promise<void>;
  /** Loaded thought only. No fetch, expansion, route-root change or camera change. */
  select(id: string): void;
  /**
   * Exactly one page for this node; duplicate activation joins its in-flight read.
   * Read errors retain confirmed content. A 404 removes the unavailable node/incident edges;
   * an unavailable root clears the graph. Missing selection falls back to the visible root.
   */
  expand(id: string): Promise<void>;
  /** Explicit restart at the bookmarked starting thought; no automatic cursor replay. */
  refresh(): Promise<void>;
  setPresentation(presentation: BrowseMapState["presentation"]): void;
  setCamera(camera: MapCamera): void;
  /** Idea mutations invalidate confirmed graph/read state; the next open must re-read. */
  invalidate(): void;
  dispose(): void;
}

/**
 * One active root/scope workspace. Root/scope changes fence reads and clear old graph/cursors/positions;
 * global node IDs deduplicate while distinct edge IDs and provenance occurrences survive.
 * Presentation remains the user's choice; matching root/scope also retains camera and inspection.
 * Request size and layout geometry are injectable test-owned inputs.
 */
export function createBrowseMapController(
  location: BrowseMapLocation,
  client: BrowseNeighborhoodClient,
  options: { readonly pageSize?: number; readonly geometry?: MapGeometry } = {},
): BrowseMapController {
  const pageSize = options.pageSize ?? 50, geometry = options.geometry ?? browseMapGeometry;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error("Invalid map page size");
  const normalize = (input: BrowseMapLocation) => {
    const parsed = decodeBrowseMapLocation(input.rootId, new URLSearchParams({ scope: input.scope, returnTo: input.returnTo }));
    if (!parsed) throw new Error("Invalid map location");
    return parsed;
  };
  const emptyExpansion = (): BrowseMapExpansion => ({ phase: "idle", loaded: false, nextCursor: null, exhausted: false, problem: null });
  const blank = (owner: BrowseMapLocation, presentation: BrowseMapState["presentation"], notice: BrowseMapState["notice"]): BrowseMapState => ({
    location: owner, presentation, notice, phase: "idle", selectedId: null, nodes: [], edges: [], expansions: {}, positions: {},
    camera: { x: 0, y: 0, scale: 1 }, problem: null,
  });
  let state = blank(normalize(location), "map", null), generation = 0, disposed = false;
  type Flight = { readonly abort: AbortController; readonly generation: number; promise: Promise<void> };
  const flights = new Map<string, Flight>(), unavailable = new Set<string>(), listeners = new Set<() => void>();
  const publish = (change: Partial<BrowseMapState>) => { state = { ...state, ...change }; for (const listener of listeners) listener(); };
  const cancel = () => { generation++; for (const flight of flights.values()) flight.abort.abort(); flights.clear(); unavailable.clear(); };
  const expansionAt = (id: string) => Object.hasOwn(state.expansions, id) ? state.expansions[id] : undefined;
  const setExpansion = (id: string, value: BrowseMapExpansion) => Object.fromEntries([...Object.entries(state.expansions), [id, value]]);

  function removeUnavailable(id: string, message: string) {
    const problem: BrowseMapProblem = { reason: "unavailable", message };
    if (id === state.location.rootId) {
      cancel();
      state = blank(state.location, state.presentation, state.notice);
      publish({ phase: "unavailable", problem });
      return;
    }
    unavailable.add(id);
    const nodes = state.nodes.filter(node => node.id !== id), selectedId = state.selectedId === id ? state.location.rootId : state.selectedId;
    publish({ nodes, edges: state.edges.filter(edge => edge.fromId !== id && edge.toId !== id), selectedId,
      positions: Object.fromEntries(Object.entries(state.positions).filter(([key]) => key !== id)),
      expansions: setExpansion(id, { ...emptyExpansion(), phase: "unavailable", problem }),
      notice: selectedId !== state.selectedId ? "selection-unavailable" : state.notice });
  }

  function expand(id: string): Promise<void> {
    if (disposed || unavailable.has(id)) return Promise.resolve();
    const active = flights.get(id);
    if (active) return active.promise;
    if (id !== state.location.rootId && !state.nodes.some(node => node.id === id)) return Promise.resolve();
    const before = expansionAt(id) ?? emptyExpansion();
    if (before.exhausted || before.problem?.reason === "restart-required") return Promise.resolve();
    const cursor = before.loaded ? before.nextCursor : null, owner = state.location;
    const initial = !state.nodes.length;
    const flight: Flight = { abort: new AbortController(), generation, promise: Promise.resolve() };
    flights.set(id, flight);
    publish({ phase: initial ? "loading" : state.phase, problem: initial ? null : state.problem,
      expansions: setExpansion(id, { ...before, phase: "loading", problem: null }) });
    if (flights.get(id) !== flight) return Promise.resolve();
    flight.promise = (async () => {
      let result: BrowseNeighborhoodResult;
      try { result = await client.read({ id, scope: owner.scope, limit: pageSize, ...(cursor === null ? {} : { cursor }) }, flight.abort.signal); }
      catch { result = { kind: "error", reason: "read-failed", message: "Linked ideas could not be loaded." }; }
      if (disposed || flight.generation !== generation || flights.get(id) !== flight || flight.abort.signal.aborted) return;
      flights.delete(id);
      if (result.kind === "unavailable") { removeUnavailable(id, result.message); return; }
      if (result.kind === "success" && result.page.thought.id !== id) result = { kind: "error", reason: "read-failed", message: "Linked ideas could not be loaded." };
      if (result.kind === "error") {
        const problem: BrowseMapProblem = { reason: result.reason, message: result.message };
        publish({ phase: initial ? "error" : "ready", problem: initial ? problem : state.problem,
          expansions: setExpansion(id, { ...before, phase: "error", problem }) });
        return;
      }
      const page = result.page, nodes = new Map(state.nodes.map(node => [node.id, node]));
      for (const node of [page.thought, ...page.nodes]) if (!unavailable.has(node.id)) nodes.set(node.id, node);
      const edges = new Map(state.edges.map(edge => [edge.id, edge]));
      for (const edge of page.edges) if (nodes.has(edge.fromId) && nodes.has(edge.toId) && !unavailable.has(edge.fromId) && !unavailable.has(edge.toId)) edges.set(edge.id, edge);
      const expansions = new Map(Object.entries(state.expansions));
      for (const node of nodes.values()) if (!expansions.has(node.id)) expansions.set(node.id, emptyExpansion());
      const stalled = cursor !== null && page.nextCursor === cursor;
      expansions.set(id, { phase: stalled ? "error" : "ready", loaded: true, nextCursor: page.nextCursor, exhausted: page.nextCursor === null,
        problem: stalled ? { reason: "restart-required", message: "Refresh the map to continue." } : null });
      publish({ phase: "ready", nodes: [...nodes.values()], edges: [...edges.values()], expansions: Object.fromEntries(expansions), problem: null,
        selectedId: state.selectedId ?? owner.rootId, positions: placeMapNodes(state.positions, id, [...nodes.keys()], geometry) });
    })();
    return flight.promise;
  }

  function restart(owner: BrowseMapLocation, notice: BrowseMapState["notice"]): Promise<void> {
    cancel();
    state = blank(owner, state.presentation, notice);
    publish({});
    return expand(owner.rootId);
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open(input) {
      if (disposed) return Promise.resolve();
      const next = normalize(input), sameRoot = next.rootId === state.location.rootId;
      if (!sameRoot || next.scope !== state.location.scope) return restart(next, sameRoot ? "scope-reset" : null);
      if (next.returnTo !== state.location.returnTo) publish({ location: next });
      return state.phase === "idle" ? expand(next.rootId) : flights.get(next.rootId)?.promise ?? Promise.resolve();
    },
    select(id) { if (!disposed && state.nodes.some(node => node.id === id)) publish({ selectedId: id }); },
    expand,
    refresh: () => disposed ? Promise.resolve() : restart(state.location, null),
    setPresentation(presentation) { if (!disposed) publish({ presentation }); },
    setCamera(camera) {
      if (!disposed && [camera.x, camera.y, camera.scale].every(Number.isFinite) && camera.scale > 0) publish({ camera: { ...camera } });
    },
    invalidate() { if (!disposed) { cancel(); state = blank(state.location, state.presentation, "library-changed"); publish({}); } },
    dispose() { disposed = true; cancel(); listeners.clear(); },
  };
}
