import { describe, expect, test } from "bun:test";
import { browseListHref, browseMapHref, decodeBrowseQuery, decodeBrowseReadRequest, encodeBrowseQuery, encodeBrowseReadRequest, type BrowseQuery } from "../apps/web/src/features/browse/query";
import { decodeBrowsePage, type BrowsePage } from "../apps/web/src/features/browse/results";
import { fetchBrowsePage, type BrowseClient, type BrowseFetchResult } from "../apps/web/src/features/browse/request";
import { createBrowseController } from "../apps/web/src/features/browse/controller";
import { handleBrowse } from "../apps/web/src/server/browse";
import type { DaemonRequest } from "../apps/web/src/server/daemon";
import { ownedMedia } from "./fixtures/web-media";

const defaults: BrowseQuery = { sort: "newest", author: ["user", "ai"], scope: "normal" };
const old: BrowseQuery = { sort: "oldest", author: ["ai"], scope: "show-rejected" };
const thought = { id: "one", text: "Owned actual thinking", title: "Owned title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "capture", parentId: null, sourceIds: [] } as const;
const next = { ...thought, id: "two", text: "Second owned thought", title: null, titleAuthor: null, author: "ai", kind: "developing-idea" } as const;
const page: BrowsePage = { items: [thought], nextCursor: "owned-cursor" };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const request = (query = "") => new Request(`http://127.0.0.1:3000/api/browse/thoughts${query}`);
const fetcher = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

describe("Browse bookmarks and read validation", () => {
  test("defaults, empty author sentinel and normalized URLs round-trip", () => {
    expect(decodeBrowseQuery(new URLSearchParams())).toEqual(defaults);
    expect(decodeBrowseReadRequest(new URLSearchParams())).toEqual({ ...defaults, limit: 50 });
    const empty = { ...defaults, author: [] };
    expect(decodeBrowseQuery(new URLSearchParams("author=none"))).toEqual(empty);
    expect(encodeBrowseQuery(empty).getAll("author")).toEqual(["none"]);
    const normalized = decodeBrowseQuery(new URLSearchParams("author=ai&author=user&author=ai&sort=oldest&scope=show-rejected"));
    expect(normalized?.author).toEqual(["user", "ai"]);
    if (!normalized) throw new Error("Missing normalized query");
    expect(decodeBrowseQuery(encodeBrowseQuery(normalized))).toEqual(normalized);
    const read = { ...old, limit: 13, cursor: "opaque+/=" };
    expect(decodeBrowseReadRequest(encodeBrowseReadRequest(read))).toEqual(read);
    const url = new URL(browseListHref(old), "http://web.invalid");
    expect(url.pathname).toBe("/browse");
    expect(decodeBrowseQuery(url.searchParams)).toEqual(old);
  });

  test("rejects unknown parameters, conflicting selections and invalid read controls", () => {
    for (const value of ["author=none&author=ai", "author=source", "author=", "sort=bad", "sort=newest&sort=oldest", "scope=history", "scope=normal&scope=normal", "unknown=x", "limit=1", "cursor=x"]) {
      expect(decodeBrowseQuery(new URLSearchParams(value))).toBeUndefined();
    }
    for (const value of ["limit=0", "limit=201", "limit=1.5", "limit=", "limit=1&limit=2", "cursor=", "cursor=x&cursor=y", "author=none&author=user", "unknown=x"]) {
      expect(decodeBrowseReadRequest(new URLSearchParams(value))).toBeUndefined();
    }
  });

  test("map handoff encodes IDs and allows only safe browse return locations", () => {
    const safe = browseListHref(old);
    const url = new URL(browseMapHref("thought / &", safe, "show-rejected"), "http://web.invalid");
    expect(url.origin).toBe("http://web.invalid");
    expect(url.pathname).toContain(encodeURIComponent("thought / &"));
    expect(url.searchParams.get("returnTo")).toBe(safe);
    expect(url.searchParams.get("scope")).toBe("show-rejected");
    for (const unsafe of ["https://evil.test/browse", "//evil.test/browse", "/browse/../other", "/other", "/browse?returnTo=https://evil.test"]) {
      const target = new URL(browseMapHref("id", unsafe), "http://web.invalid");
      expect([null, "/browse"]).toContain(target.searchParams.get("returnTo"));
    }
  });
});

describe("Browse data boundaries", () => {
  test("decodes existing thought union and requires inspection flags only in inspection scope", () => {
    expect(decodeBrowsePage(page, defaults)).toEqual(page);
    const media = { items: [ownedMedia], nextCursor: null };
    expect(decodeBrowsePage(media, defaults)).toEqual(media);
    const inspected = { items: [{ ...next, rejected: false }, { ...thought, rejected: true }], nextCursor: null };
    expect(decodeBrowsePage(inspected, old)).toEqual(inspected);
    for (const invalid of [null, {}, { items: [thought], nextCursor: 4 }, { items: [{ ...thought, sourceIds: [5] }], nextCursor: null }, { items: [{ ...thought, rejected: true }], nextCursor: null }]) {
      expect(decodeBrowsePage(invalid, defaults)).toBeUndefined();
    }
    expect(decodeBrowsePage({ items: [next], nextCursor: null }, old)).toBeUndefined();
    expect(decodeBrowsePage({ items: [{ ...next, rejected: "false" }], nextCursor: null }, old)).toBeUndefined();
  });

  test("server forwards fixed explicit authors and bounded controls; empty selection never reaches daemon", async () => {
    const calls: DaemonRequest[] = [];
    const callDaemon = async (command: DaemonRequest) => { calls.push(command); return json({ items: [{ ...next, rejected: false }], nextCursor: null }); };
    const response = await handleBrowse(request("?author=ai&sort=oldest&scope=show-rejected&limit=13&cursor=opaque"), { callDaemon });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    const target = new URL(calls[0]?.path ?? "", "http://daemon.invalid");
    expect(target.pathname).toBe("/browse/thoughts");
    expect(target.searchParams.getAll("author")).toEqual(["ai"]);
    expect(target.searchParams.get("sort")).toBe("oldest");
    expect(target.searchParams.get("scope")).toBe("show-rejected");
    expect(target.searchParams.get("limit")).toBe("13");
    expect(target.searchParams.get("cursor")).toBe("opaque");
    expect(await response.json()).toEqual({ items: [{ ...next, rejected: false }], nextCursor: null });
    const empty = await handleBrowse(request("?author=none"), { callDaemon });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [], nextCursor: null });
    expect(calls).toHaveLength(1);
    const initial = await handleBrowse(request(), { callDaemon: async command => { calls.push(command); return json(page); } });
    expect(initial.status).toBe(200);
    expect(new URL(calls[1]?.path ?? "", "http://daemon.invalid").searchParams.getAll("author").sort()).toEqual(["ai", "user"]);
  });

  test("server sanitizes invalid input, malformed data, exceptions and rejected cursors", async () => {
    let called = 0;
    const invalid = await handleBrowse(request("?limit=0"), { callDaemon: async () => { called++; return json(page); } });
    expect(invalid.status).toBe(400); expect(called).toBe(0);
    for (const mode of ["throw", "status", "json", "shape", "inspection"] as const) {
      const result = await handleBrowse(request(mode === "inspection" ? "?scope=show-rejected" : ""), { callDaemon: async () => {
        if (mode === "throw") throw new Error("owned-private-token");
        if (mode === "status") return new Response("owned-private-token", { status: 500 });
        if (mode === "json") return new Response("{", { status: 200 });
        return json(mode === "shape" ? { items: "bad", nextCursor: null } : page);
      } });
      expect(result.status).toBe(502);
      expect(result.headers.get("cache-control")).toMatch(/no-store/i);
      const body = await result.text();
      expect(body).not.toContain("owned-private-token");
      expect(JSON.parse(body).code).toBe("browse-unavailable");
    }
    const restart = await handleBrowse(request("?cursor=bad"), { callDaemon: async () => new Response("owned-private-token", { status: 400 }) });
    expect(restart.status).toBe(400);
    const body = await restart.text();
    expect(body).not.toContain("owned-private-token");
    expect(JSON.parse(body).code).toBe("browse-restart-required");
  });

  test("browser fetch stays same-origin, passes abort and maps safe typed failures", async () => {
    const signal = new AbortController().signal;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await fetchBrowsePage({ ...defaults, limit: 2 }, { signal, fetch: fetcher(async (input, init) => { calls.push({ url: String(input), init }); return json(page); }) });
    expect(result).toEqual({ kind: "success", page });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.startsWith("/api/browse/thoughts?")).toBe(true);
    expect(calls[0]?.init?.signal).toBe(signal);
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(false);
    for (const response of [json({ code: "browse-restart-required", message: "safe" }, 400), new Response("owned-private-token", { status: 500 }), json({ items: "bad" })]) {
      const error = await fetchBrowsePage({ ...defaults, limit: 2, cursor: "bad" }, { fetch: fetcher(async () => response) });
      expect(error.kind).toBe("error");
      if (error.kind !== "error") throw new Error("Expected error");
      expect(error.message).not.toContain("owned-private-token");
      if (response.status === 400) expect(error.reason).toBe("restart-required");
    }
  });
});

describe("Browse pagination controller", () => {
  test("appends unique results, serializes load-more and preserves confirmed rows on retryable error", async () => {
    const held = Promise.withResolvers<BrowseFetchResult>();
    const requests: Array<{ cursor?: string; limit: number }> = [];
    let more = 0;
    const client: BrowseClient = { read: async input => {
      requests.push(input);
      if (!input.cursor) return { kind: "success", page };
      more++;
      if (more === 1) return held.promise;
      if (more === 2) return { kind: "error", reason: "read-failed", message: "Try again" };
      return { kind: "success", page: { items: [next], nextCursor: null } };
    } };
    const controller = createBrowseController(defaults, client, { pageSize: 2 });
    await controller.refresh();
    const loading = controller.loadMore(), duplicate = controller.loadMore();
    expect(requests).toHaveLength(2);
    held.resolve({ kind: "success", page: { items: [thought, next], nextCursor: "second" } });
    await Promise.all([loading, duplicate]);
    expect(controller.getSnapshot()).toMatchObject({ phase: "ready", items: [thought, next], nextCursor: "second", loadingMore: false });
    await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [thought, next], nextCursor: "second", problem: { stage: "more", reason: "read-failed" } });
    await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [thought, next], nextCursor: null, problem: null });
    expect(requests.every(item => item.limit === 2)).toBe(true);
    controller.dispose();
  });

  test("scope changes clear immediately and stale completions cannot restore inspected rows", async () => {
    const held = Promise.withResolvers<BrowseFetchResult>();
    let calls = 0;
    const inspected = { ...thought, rejected: true };
    const controller = createBrowseController(old, { read: async input => {
      calls++;
      if (calls === 1) return { kind: "success", page: { items: [inspected], nextCursor: "old-cursor" } };
      if (input.scope === "show-rejected") return held.promise;
      return { kind: "success", page: { items: [next], nextCursor: null } };
    } });
    await controller.refresh();
    const stale = controller.loadMore();
    const changed = controller.setQuery(defaults);
    expect(controller.getSnapshot().items).toEqual([]);
    await changed;
    held.resolve({ kind: "success", page: { items: [inspected], nextCursor: null } });
    await stale;
    expect(controller.getSnapshot()).toMatchObject({ query: defaults, items: [next], nextCursor: null });
    controller.dispose();
  });
});
