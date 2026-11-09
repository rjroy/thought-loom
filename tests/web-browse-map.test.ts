import { describe, expect, test } from "bun:test";
import { browseMapHref, decodeBrowseMapLocation, decodeBrowseNeighborhoodReadRequest, encodeBrowseNeighborhoodReadRequest, safeBrowseReturnTo } from "../apps/web/src/features/browse/query";
import { decodeBrowseNeighborhood, type BrowseNeighborhoodPage } from "../apps/web/src/features/browse/results";
import { fetchBrowseNeighborhood, type BrowseNeighborhoodClient, type BrowseNeighborhoodResult } from "../apps/web/src/features/browse/request";
import { createBrowseMapController } from "../apps/web/src/features/browse/map-controller";
import { fitMapCamera, placeMapNodes } from "../apps/web/src/features/browse/map-layout";
import { handleBrowseNeighborhood } from "../apps/web/src/server/browse";
import type { DaemonRequest } from "../apps/web/src/server/daemon";

const base = { text: "Owned original text", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "test", parentId: null, sourceIds: [] } as const;
const root = { ...base, id: "root", parentId: "parent", sourceIds: ["parent", "parent"] };
const parent = { ...base, id: "parent" };
const child = { ...base, id: "child", parentId: "root", sourceIds: ["root"] };
const extra = { ...base, id: "extra", sourceIds: ["child"] };
const evolution = { kind: "evolution", id: "edge-evolution", fromId: "parent", toId: "root" } as const;
const provenance = (position: number) => ({ kind: "provenance" as const, id: `edge-source-${position}`, fromId: "parent", toId: "root", position });
const connection = { kind: "connection", id: "edge-connection", fromId: "parent", toId: "root", connection: { id: "connection-id", fromId: "parent", toId: "root", category: "supports", proposedBy: "ai", explanation: "Owned evidence", sourceIds: ["extra"] } } as const;
const first: BrowseNeighborhoodPage = { thought: root, nodes: [parent], edges: [evolution, provenance(0), provenance(1), connection], nextCursor: "root-next" };
const second: BrowseNeighborhoodPage = { thought: root, nodes: [child], edges: [{ kind: "evolution", id: "edge-child", fromId: "root", toId: "child" }], nextCursor: null };
const childPage: BrowseNeighborhoodPage = { thought: child, nodes: [root, extra], edges: [{ kind: "evolution", id: "edge-child", fromId: "root", toId: "child" }, { kind: "provenance", id: "edge-extra", fromId: "child", toId: "extra", position: 0 }], nextCursor: "child-next" };
const location = { rootId: "root", scope: "normal", returnTo: "/browse" } as const;
const geometry = { nodeWidth: 100, nodeHeight: 50, gap: 12 };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const fetcher = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;
const request = (query = "") => new Request(`http://127.0.0.1:3000/api/browse/thoughts/root/neighborhood${query}`);

describe("map location and neighborhood boundary", () => {
  test("validates map locations, nested returns and bounded neighborhood parameters", () => {
    const list = "/browse?sort=oldest&author=user&scope=normal";
    const href = browseMapHref("root", list, "show-rejected");
    const url = new URL(href, "http://web.invalid");
    expect(decodeBrowseMapLocation("root", url.searchParams)).toEqual({ rootId: "root", scope: "show-rejected", returnTo: list });
    expect(safeBrowseReturnTo(href)).toBe(href);
    for (const value of ["https://evil.test/browse", "//evil.test/browse", "/browse/../other", "/browse/root?returnTo=https%3A%2F%2Fevil.test", "/browse/root?scope=history"]) expect(safeBrowseReturnTo(value)).toBeUndefined();
    expect(decodeBrowseMapLocation("root", new URLSearchParams("returnTo=https%3A%2F%2Fevil.test"))).toEqual(location);
    for (const params of ["scope=history", "scope=normal&scope=normal", "other=x", "returnTo=x&returnTo=y"]) expect(decodeBrowseMapLocation("root", new URLSearchParams(params))).toBeUndefined();
    const read = { id: "root", scope: "show-rejected", limit: 3, cursor: "owned+/=" } as const;
    expect(decodeBrowseNeighborhoodReadRequest("root", encodeBrowseNeighborhoodReadRequest(read))).toEqual(read);
    expect(decodeBrowseNeighborhoodReadRequest("root", new URLSearchParams())).toEqual({ id: "root", scope: "normal", limit: 50 });
    for (const query of ["limit=0", "limit=201", "limit=1.5", "limit=1&limit=2", "cursor=", "cursor=x&cursor=y", "scope=history", "author=user", "extra=x"]) expect(decodeBrowseNeighborhoodReadRequest("root", new URLSearchParams(query))).toBeUndefined();
  });

  test("accepts distinct roles and duplicate source occurrences but rejects inconsistent or unsafe projections", () => {
    expect(decodeBrowseNeighborhood(first, "root", "normal")).toEqual(first);
    const inspection = { ...first, thought: { ...root, rejected: false }, nodes: [{ ...parent, rejected: true }], edges: first.edges.map(edge => edge.kind === "connection" ? { ...edge, connection: { ...edge.connection, rejected: true } } : edge) };
    expect(decodeBrowseNeighborhood(inspection, "root", "show-rejected")).toEqual(inspection);
    const invalid = [
      { ...first, thought: child }, { ...first, nodes: [parent, parent] }, { ...first, nodes: [root, parent] },
      { ...first, nodes: [] }, { ...first, edges: [{ ...evolution, fromId: "parent", toId: "extra" }] },
      { ...first, edges: [evolution, evolution] }, { ...first, edges: [{ ...provenance(0), position: -1 }] },
      { ...first, edges: [{ ...connection, id: "connection-id" }] },
      { ...first, edges: [{ ...connection, connection: { ...connection.connection, toId: "extra" } }] },
      { ...first, thought: { ...root, rejected: true } }, { ...first, nextCursor: "" },
    ];
    for (const item of invalid) expect(decodeBrowseNeighborhood(item, "root", "normal")).toBeUndefined();
    expect(decodeBrowseNeighborhood(first, "root", "show-rejected")).toBeUndefined();
  });

  test("server uses fixed daemon path, scopes and private sanitized errors", async () => {
    const calls: DaemonRequest[] = [];
    const result = await handleBrowseNeighborhood(request("?limit=5&scope=normal&cursor=opaque"), "root", { callDaemon: async input => { calls.push(input); return json(first); } });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toMatch(/no-store/i);
    expect(await result.json()).toEqual(first);
    expect(calls[0]?.method).toBe("GET");
    const url = new URL(calls[0]?.path ?? "", "http://daemon.invalid");
    expect(url.pathname).toBe("/thoughts/root/neighborhood");
    expect(url.searchParams.get("limit")).toBe("5"); expect(url.searchParams.get("cursor")).toBe("opaque");
    expect(url.searchParams.get("scope")).toBe("normal");
    for (const [upstream, expected] of [[404, 404], [400, 400], [500, 502]] as const) {
      const response = await handleBrowseNeighborhood(request("?cursor=bad"), "root", { callDaemon: async () => new Response("owned-secret", { status: upstream }) });
      expect(response.status).toBe(expected); expect(response.headers.get("cache-control")).toMatch(/no-store/i);
      expect(await response.text()).not.toContain("owned-secret");
    }
    const invalid = await handleBrowseNeighborhood(request("?limit=0"), "root", { callDaemon: async () => { throw new Error("must not call"); } });
    expect(invalid.status).toBe(400);
    const malformed = await handleBrowseNeighborhood(request(), "root", { callDaemon: async () => json({ ...first, nodes: [] }) });
    expect(malformed.status).toBe(502);
  });

  test("browser requests same-origin path with abort and typed unavailable/restart failures", async () => {
    const signal = new AbortController().signal;
    const calls: { url: string; init?: RequestInit }[] = [];
    const input = { id: "root", scope: "normal", limit: 5 } as const;
    const result = await fetchBrowseNeighborhood(input, { signal, fetch: fetcher(async (url, init) => { calls.push({ url: String(url), init }); return json(first); }) });
    expect(result).toEqual({ kind: "success", page: first });
    expect(calls[0]?.url.startsWith("/api/browse/thoughts/root/neighborhood?")).toBe(true);
    expect(calls[0]?.init?.signal).toBe(signal); expect(calls[0]?.init?.cache).toBe("no-store");
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(false);
    expect((await fetchBrowseNeighborhood(input, { fetch: fetcher(async () => new Response("private", { status: 404 })) })).kind).toBe("unavailable");
    const error = await fetchBrowseNeighborhood({ ...input, cursor: "bad" }, { fetch: fetcher(async () => json({ code: "neighborhood-restart-required", message: "private" }, 400)) });
    expect(error).toMatchObject({ kind: "error", reason: "restart-required" });
  });

  test("discarded neighborhood error bodies are cancelled without delaying or changing safe classification", async () => {
    const input = { id: "root", scope: "normal", limit: 5 } as const;
    for (const status of [404, 400, 500]) for (const mode of ["success", "throw", "reject", "pending"] as const) {
      const cleanup = Promise.withResolvers<void>();
      let cancels = 0, settled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("owned-sensitive-error")); },
        cancel() {
          cancels++;
          if (mode === "throw") throw new Error("owned-sensitive-cancel-error");
          if (mode === "reject") return Promise.reject(new Error("owned-sensitive-cancel-error"));
          if (mode === "pending") return cleanup.promise;
        },
      });
      const response = new Response(body, { status });
      const work = fetchBrowseNeighborhood(input, { fetch: fetcher(async () => response) });
      void work.then(() => { settled = true; });
      try {
        // Advance only promise jobs, not a wall-clock delay or an external service.
        for (let i = 0; i < 40; i++) await Promise.resolve();
        expect(settled).toBe(true);
        expect(cancels).toBe(1);
        expect(response.bodyUsed).toBe(true);
      } finally { cleanup.resolve(); }
      const result = await work;
      expect(result.kind).toBe(status === 404 ? "unavailable" : "error");
      if (result.kind === "success") throw new Error("Expected safe failure result");
      expect(result.message).not.toContain("owned-sensitive");
      if (result.kind === "error") expect(result.reason).toBe("read-failed");
    }
  });

  test("successful and restart JSON are consumed rather than cancelled", async () => {
    for (const scenario of ["success", "restart"] as const) {
      let cancels = 0;
      const value = scenario === "success" ? first : { code: "neighborhood-restart-required", message: "owned text" };
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); },
        cancel() { cancels++; },
      });
      const response = new Response(body, { status: scenario === "success" ? 200 : 400 });
      const input = { id: "root", scope: "normal", limit: 5, ...(scenario === "restart" ? { cursor: "stale" } : {}) } as const;
      const result = await fetchBrowseNeighborhood(input, { fetch: fetcher(async () => response) });
      expect(result).toMatchObject(scenario === "success" ? { kind: "success", page: first } : { kind: "error", reason: "restart-required" });
      expect(response.bodyUsed).toBe(true);
      expect(cancels).toBe(0);
    }
  });
});

describe("map workspace controller", () => {
  test("reopening an unavailable root does not implicitly repeat its read", async () => {
    let calls = 0;
    const map = createBrowseMapController(location, { read: async () => { calls++; return { kind: "unavailable", message: "Unavailable" }; } });
    await map.open(location);
    expect(map.getSnapshot().phase).toBe("unavailable");
    await map.open(location);
    expect(calls).toBe(1);
    expect(map.getSnapshot().phase).toBe("unavailable");
    map.dispose();
  });

  test("selection never fetches or recenters; explicit expansion merges unique nodes and role-distinct edges", async () => {
    const held = Promise.withResolvers<BrowseNeighborhoodResult>();
    const calls: Array<{ id: string; cursor?: string; limit: number }> = [];
    const client: BrowseNeighborhoodClient = { read: async input => {
      calls.push(input);
      if (input.id === "root" && !input.cursor) return { kind: "success", page: first };
      if (input.id === "root") return { kind: "success", page: second };
      if (input.id === "child" && !input.cursor) return held.promise;
      return { kind: "success", page: { ...childPage, nodes: [], edges: [], nextCursor: null } };
    } };
    const map = createBrowseMapController(location, client, { pageSize: 4, geometry });
    await map.open(location);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ id: "root", limit: 4 });
    await map.expand("root");
    const camera = { x: 20, y: -10, scale: 1.25 }; map.setCamera(camera); map.setPresentation("linked-list");
    const before = map.getSnapshot(); map.select("child");
    expect(calls).toHaveLength(2);
    expect(map.getSnapshot()).toMatchObject({ selectedId: "child", location, camera, presentation: "linked-list", positions: before.positions });
    const load = map.expand("child"), duplicate = map.expand("child");
    expect(calls).toHaveLength(3);
    held.resolve({ kind: "success", page: childPage }); await Promise.all([load, duplicate]);
    expect(map.getSnapshot().nodes.map(node => node.id).sort()).toEqual(["child", "extra", "parent", "root"]);
    expect(map.getSnapshot().edges.map(edge => edge.id).sort()).toEqual(["edge-child", "edge-connection", "edge-evolution", "edge-extra", "edge-source-0", "edge-source-1"]);
    expect(map.getSnapshot().expansions.child).toMatchObject({ loaded: true, nextCursor: "child-next", exhausted: false });
    await map.open(location); expect(calls).toHaveLength(3);
    expect(map.getSnapshot()).toMatchObject({ selectedId: "child", camera, presentation: "linked-list" });
    map.dispose();
  });

  test("failed page retains confirmed graph, retry and explicit restart do not silently replay cursors", async () => {
    const calls: Array<{ id: string; cursor?: string }> = []; let n = 0;
    const map = createBrowseMapController(location, { read: async input => {
      calls.push(input); n++;
      if (n === 1 || n === 4) return { kind: "success", page: first };
      if (n === 2) return { kind: "error", reason: "read-failed", message: "Retry" };
      return { kind: "success", page: second };
    } }, { geometry });
    await map.open(location); const saved = map.getSnapshot();
    await map.expand("root");
    expect(map.getSnapshot()).toMatchObject({ nodes: saved.nodes, edges: saved.edges, expansions: { root: { problem: { reason: "read-failed" }, nextCursor: "root-next" } } });
    await map.expand("root"); expect(calls[2]).toMatchObject({ id: "root", cursor: "root-next" });
    await map.refresh(); expect(calls[3]?.cursor).toBeUndefined();
    expect(map.getSnapshot().nodes.map(item => item.id).sort()).toEqual(["parent", "root"]);
    map.dispose();
  });

  test("unavailable expansion removes only that node and incident edges; bad cursor requires restart", async () => {
    let calls = 0;
    const map = createBrowseMapController(location, { read: async input => {
      calls++;
      if (input.id === "parent") return { kind: "unavailable", message: "Unavailable" };
      if (input.cursor) return { kind: "error", reason: "restart-required", message: "Refresh" };
      return { kind: "success", page: first };
    } });
    await map.open(location); map.select("parent"); await map.expand("parent");
    expect(map.getSnapshot().nodes.map(node => node.id)).toEqual(["root"]);
    expect(map.getSnapshot().edges).toEqual([]);
    expect(map.getSnapshot().selectedId).toBe("root");
    await map.expand("root");
    expect(map.getSnapshot().expansions.root?.problem?.reason).toBe("restart-required");
    const before = calls; await map.expand("root"); expect(calls).toBe(before);
    await map.refresh(); expect(calls).toBe(before + 1);
    expect(map.getSnapshot().nodes.map(node => node.id).sort()).toEqual(["parent", "root"]);
    map.dispose();
  });

  test("root, scope and invalidation fence late work; unavailable root and disconnected graph stay distinct", async () => {
    for (const change of ["root", "scope", "invalidate"] as const) {
      const held = Promise.withResolvers<BrowseNeighborhoodResult>(); let calls = 0;
      const map = createBrowseMapController(location, { read: async input => {
        calls++;
        if (calls === 1) return held.promise;
        if (input.id === "missing") return { kind: "unavailable", message: "Unavailable" };
        return { kind: "success", page: { thought: { ...root, ...(input.scope === "show-rejected" ? { rejected: false } : {}) }, nodes: [], edges: [], nextCursor: null } };
      } });
      const stale = map.open(location);
      if (change === "invalidate") map.invalidate();
      else await map.open(change === "root" ? { ...location, rootId: "missing" } : { ...location, scope: "show-rejected" });
      held.resolve({ kind: "success", page: first }); await stale;
      expect(map.getSnapshot().nodes.some(item => item.id === "parent")).toBe(false);
      if (change === "root") expect(map.getSnapshot().phase).toBe("unavailable");
      if (change === "scope") expect(map.getSnapshot()).toMatchObject({ phase: "ready", edges: [], location: { scope: "show-rejected" } });
      if (change === "invalidate") { await map.open(location); expect(calls).toBe(2); expect(map.getSnapshot().edges).toEqual([]); }
      map.dispose();
    }
  });
});

test("map placement retains existing nodes and fitting contains supplied geometry", () => {
  const existing = { root: { x: 10, y: 20 }, prior: { x: 250, y: 20 } };
  const positions = placeMapNodes(existing, "root", ["root", "prior", "new-a", "new-b"], geometry);
  expect(positions.root).toEqual(existing.root); expect(positions.prior).toEqual(existing.prior);
  expect(existing).toEqual({ root: { x: 10, y: 20 }, prior: { x: 250, y: 20 } });
  const points = Object.values(positions);
  expect(points).toHaveLength(4);
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i], b = points[j]; if (!a || !b) throw new Error("Missing position");
    expect(Math.abs(a.x - b.x) >= geometry.nodeWidth || Math.abs(a.y - b.y) >= geometry.nodeHeight).toBe(true);
  }
  const viewport = { width: 700, height: 500 }, padding = 20;
  const camera = fitMapCamera(positions, geometry, viewport, { padding, minScale: 0.01, maxScale: 4 });
  expect(camera.scale).toBeGreaterThanOrEqual(0.01); expect(camera.scale).toBeLessThanOrEqual(4);
  for (const point of points) {
    expect(point.x * camera.scale + camera.x).toBeGreaterThanOrEqual(padding - 0.001);
    expect(point.y * camera.scale + camera.y).toBeGreaterThanOrEqual(padding - 0.001);
    expect((point.x + geometry.nodeWidth) * camera.scale + camera.x).toBeLessThanOrEqual(viewport.width - padding + 0.001);
    expect((point.y + geometry.nodeHeight) * camera.scale + camera.y).toBeLessThanOrEqual(viewport.height - padding + 0.001);
  }
});
