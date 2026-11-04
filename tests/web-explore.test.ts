import { describe, expect, test } from "bun:test";
import { clearSearchFilters, datePreset, decodeSearchQuery, encodeSearchQuery, ideaHref, type SearchQuery } from "../apps/web/src/features/explore/query";
import { decodeSearchPage, decodeWebSearchPage } from "../apps/web/src/features/explore/results";
import { fetchSearch } from "../apps/web/src/features/explore/request";
import { handleSearch } from "../apps/web/src/server/search";
import type { DaemonRequest } from "../apps/web/src/server/daemon";
import { requestDaemon } from "../apps/web/src/server/daemon";
import { readWebConfig } from "../apps/web/src/server/config";
import { createLogger, type LogRecord } from "../src/logging";

const query: SearchQuery = { q: "  thinking + words  ", author: ["user", "ai"], kind: ["captured-original", "developing-idea"], from: "2032-02-01", to: "2032-02-29", sort: "newest", scope: "show-rejected" };
const contextThought = { id: "context-1", text: "Context original text", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: "2031-01-01T12:00:00.000Z", origin: "capture", parentId: null, sourceIds: [] } as const;
const connection = { id: "connection-1", fromId: "t-1", toId: "context-1", category: "supports", proposedBy: "ai", explanation: "original explanation", sourceIds: [] } as const;
const first = { kind: "response", id: "response-1", thoughtId: "t-1", text: "Full response original words", snippet: "response snippet", title: "Destination title", author: "ai", materialKind: "user-contribution", createdAt: "2032-02-01T00:00:00.000Z", context: { kind: "connection", thought: contextThought, connection } } as const;
const second = { kind: "thought", id: "t-2", thoughtId: "t-2", text: "Full thought original words", snippet: "thought snippet", title: "Thought title", author: "user", materialKind: "captured-original", createdAt: "2032-02-02T00:00:00.000Z", context: { kind: "predecessor", thought: contextThought } } as const;
const page = { results: [first, second], counts: { authors: { user: 7, ai: 12 }, kinds: { "captured-original": 3, "user-contribution": 5, "ai-interpretation": 0, "developing-idea": 9 } } };
const webPage = { ...page, rejectionStatus: { "t-2": false } };
const request = (params: string) => new Request(`http://127.0.0.1:3000/api/search${params}`);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

describe("Explore query contract", () => {
  test("round-trips repeated facets, inclusive dates and other selections", () => {
    const encoded = encodeSearchQuery(query);
    expect(encoded.getAll("author")).toEqual(["user", "ai"]);
    expect(encoded.getAll("kind")).toEqual(["captured-original", "developing-idea"]);
    expect(decodeSearchQuery(encoded)).toEqual(query);
  });
  test("defaults to normal relevance and empty facets; clear retains query and sort", () => {
    expect(decodeSearchQuery(new URLSearchParams("q=word"))).toEqual({ q: "word", author: [], kind: [], sort: "relevance", scope: "normal" });
    expect(clearSearchFilters(query)).toEqual({ q: query.q, author: [], kind: [], sort: "newest", scope: "normal" });
  });
  for (const value of ["", "q=", "q=+++", "q=x&q=y", "q=x&from=2031-01-01&from=2031-01-02", "q=x&to=2031-01-01&to=2031-01-02", "q=x&sort=newest&sort=oldest", "q=x&scope=normal&scope=show-rejected", "q=x&extra=1", "q=x&scope=history", "q=x&author=other", "q=x&kind=response", "q=x&sort=best", "q=x&from=2031-02-29", "q=x&to=2032-02-30", "q=x&from=2032-03-01&to=2032-02-29", "q=x&from=2032-01-01T12:00:00%2B01:00"]) {
    test(`rejects invalid search parameters ${value}`, () => expect(decodeSearchQuery(new URLSearchParams(value))).toBeUndefined());
  }
  test("accepts leap day and documented UTC timestamp bounds", () => {
    expect(decodeSearchQuery(new URLSearchParams("q=x&from=2032-02-29T00%3A00%3A00Z&to=2032-02-29T23%3A59%3A59.999Z"))).toBeDefined();
  });
  test("date presets use owned UTC clock and inclusive calendar days", () => {
    const now = new Date("2032-01-03T00:30:00.000Z");
    expect(datePreset("anytime", now)).toEqual({});
    expect(datePreset("last-7-days", now)).toEqual({ from: "2031-12-28", to: "2032-01-03" });
    expect(datePreset("last-30-days", now)).toEqual({ from: "2031-12-05", to: "2032-01-03" });
    expect(datePreset("this-year", now)).toEqual({ from: "2032-01-01", to: "2032-01-03" });
  });
  test("idea links encode destination and response identity and refuse external return targets", () => {
    const href = ideaHref({ kind: "response", id: "response / &", thoughtId: "thought / &" }, "/explore?q=own%20words&sort=newest");
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe(`/ideas/${encodeURIComponent("thought / &")}`);
    expect(url.searchParams.get("responseId")).toBe("response / &");
    expect(url.searchParams.get("returnTo")).toBe("/explore?q=own%20words&sort=newest");
    for (const unsafe of ["https://evil.test/explore", "//evil.test/explore", "/explore/../evil", "/other", "/explore?returnTo=https://evil.test"]) {
      const result = new URL(ideaHref({ kind: "thought", id: "t", thoughtId: "t" }, unsafe), "http://localhost");
      expect(result.pathname).toBe("/ideas/t");
      expect([null, "/explore"]).toContain(result.searchParams.get("returnTo"));
      expect(result.searchParams.has("responseId")).toBe(false);
    }
  });
});

describe("canonical search DTO", () => {
  test("preserves response/thought identities, ordering, full records, contexts and counts", () => {
    expect(decodeSearchPage(page)).toEqual(page);
    expect(decodeWebSearchPage(webPage)).toEqual(webPage);
  });
  for (const invalid of [null, {}, { ...page, results: "bad" }, { ...page, counts: {} }, { ...page, results: [{ ...first, thoughtId: 2 }] }, { ...page, results: [{ ...first, context: { kind: "other" } }] }, { ...webPage, rejectionStatus: { "t-2": "false" } }]) {
    test(`rejects malformed web data ${JSON.stringify(invalid)}`, () => expect(decodeWebSearchPage(invalid)).toBeUndefined());
  }
});

describe("fixed search server handler", () => {
  for (const suffix of ["", "?q=", "?q=%20%20", "?q=x&q=y", "?q=x&scope=history", "?q=x&path=/thoughts", "?q=x&author=other", "?q=x&kind=other", "?q=x&from=2031-02-29", "?q=x&from=2032-03-01&to=2032-02-01"]) {
    test(`rejects ${suffix} before calling daemon`, async () => {
      let count = 0;
      const response = await handleSearch(request(suffix), { callDaemon: async () => { count++; return json(page); } });
      expect(response.status).toBe(400);
      expect(count).toBe(0);
    });
  }
  test("forwards only validated fixed-path parameters and keeps canonical data private", async () => {
    const calls: DaemonRequest[] = [];
    const params = encodeSearchQuery({ ...query, scope: "normal" });
    const response = await handleSearch(request(`?${params}`), { callDaemon: async command => { calls.push(command); return json(page); } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    const target = new URL(calls[0]?.path ?? "", "http://daemon.invalid");
    expect(target.pathname).toBe("/search");
    expect(decodeSearchQuery(target.searchParams)).toEqual({ ...query, scope: "normal" });
    expect(await response.json()).toEqual({ ...page, rejectionStatus: {} });
  });
  test("show-rejected inspects only distinct thought hits, bounds concurrency and keeps unknown separate", async () => {
    const thoughts = Array.from({ length: 8 }, (_, i) => ({ ...second, id: `t-${i}`, thoughtId: `t-${i}`, context: null }));
    const data = { ...page, results: [first, ...thoughts, thoughts[0]] };
    const inspected: string[] = [];
    let active = 0, maximum = 0;
    const response = await handleSearch(request("?q=words&scope=show-rejected"), { callDaemon: async command => {
      if (command.path.startsWith("/search?")) return json(data);
      inspected.push(command.path);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      const id = new URL(command.path, "http://daemon.invalid").pathname.split("/").at(-1);
      if (id === "t-3") throw new Error("private upstream failure");
      if (id === "t-4") return new Response("private", { status: 500 });
      if (id === "t-5") return json({ rejected: "no" });
      return json({ rejected: id === "t-2" });
    } });
    expect(response.status).toBe(200);
    expect(inspected).toHaveLength(8);
    expect(new Set(inspected).size).toBe(8);
    expect(inspected.every(path => /^\/thoughts\/t-\d\?scope=show-rejected$/.test(path))).toBe(true);
    expect(maximum).toBeLessThanOrEqual(4);
    const result = await response.json();
    expect(result.results).toEqual(data.results);
    expect(result.counts).toEqual(page.counts);
    expect(result.rejectionStatus).toEqual({ "t-0": false, "t-1": false, "t-2": true, "t-3": null, "t-4": null, "t-5": null, "t-6": false, "t-7": false });
  });
  test("response-only hits do not cause inspection", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleSearch(request("?q=word&scope=show-rejected"), { callDaemon: async command => { calls.push(command); return json({ ...page, results: [first] }); } });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await response.json()).rejectionStatus).toEqual({});
  });
  for (const failure of ["status", "malformed", "shape", "throw"] as const) {
    test(`sanitizes upstream ${failure}`, async () => {
      const response = await handleSearch(request("?q=private-query"), { callDaemon: async () => {
        if (failure === "throw") throw new Error("private-query owned-token");
        if (failure === "status") return new Response("private-query owned-token", { status: 500 });
        if (failure === "malformed") return new Response("{", { status: 200 });
        return json({ results: [] });
      } });
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.headers.get("cache-control")).toMatch(/no-store/i);
      const body = await response.text();
      expect(body).not.toContain("private-query");
      expect(body).not.toContain("owned-token");
    });
  }
});

describe("client search request", () => {
  test("forwards the caller's abort signal to the fixed read request", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | null | undefined;
    await fetchSearch(query, { signal: controller.signal, fetch: fakeFetch(async (_input, init) => { observed = init?.signal; return json(webPage); }) });
    expect(observed).toBe(controller.signal);
  });
  test("uses the fixed local read route and returns decoded data", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = fakeFetch(async (input, init) => { calls.push({ url: String(input), init }); return json(webPage); });
    const result = await fetchSearch(query, { fetch });
    expect(result).toEqual({ kind: "success", page: webPage });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "", "http://web.invalid");
    expect(url.pathname).toBe("/api/search");
    expect(url.origin).toBe("http://web.invalid");
    expect(decodeSearchQuery(url.searchParams)).toEqual(query);
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(calls[0]?.init?.cache).toBe("no-store");
  });
  for (const mode of ["throw", "status", "malformed", "shape"] as const) {
    test(`reports safe typed error for ${mode}`, async () => {
      let calls = 0;
      const result = await fetchSearch(query, { fetch: fakeFetch(async () => {
        calls++;
        if (mode === "throw") throw new Error("owned-token private-query");
        if (mode === "status") return new Response("owned-token private-query", { status: 500 });
        if (mode === "malformed") return new Response("{", { status: 200 });
        return json({ results: [] });
      }) });
      expect(calls).toBe(1);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("Expected error result");
      expect(result.message).not.toContain("owned-token");
      expect(result.message).not.toContain("private-query");
    });
  }
});

test("actual daemon transport logs no search query or credentials", async () => {
  const records: LogRecord[] = [];
  const token = "owned-search-secret";
  const text = "owned-private-query & detail";
  const params = new URLSearchParams({ q: text });
  await requestDaemon(readWebConfig({ THOUGHTLOOM_USER_TOKEN: token }), { method: "GET", path: `/search?${params}` }, {
    fetch: fakeFetch(async () => json(page)), logger: createLogger("verbose", record => records.push(record)), timeoutMs: 1000,
  });
  expect(records.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(records)).not.toContain(text);
  expect(JSON.stringify(records)).not.toContain(params.toString());
  expect(JSON.stringify(records)).not.toContain(token);
});
