// Run explicitly with Bun's react-server condition; ordinary unit discovery
// must not import Next's server-only boundary under the default condition.
import { afterEach, expect, test } from "bun:test";
import { readSearch } from "../../apps/web/lib/daemon";
import { GET } from "../../apps/web/app/api/search/route";

const originalFetch = globalThis.fetch;
const originalDaemonURL = process.env.THOUGHTLOOM_DAEMON_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDaemonURL === undefined) delete process.env.THOUGHTLOOM_DAEMON_URL;
  else process.env.THOUGHTLOOM_DAEMON_URL = originalDaemonURL;
});

test("web search adapter preserves the daemon's bounded alias disclosure and raw query", async () => {
  process.env.THOUGHTLOOM_DAEMON_URL = "http://127.0.0.1:4318";
  let requested: URL | undefined;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requested = new URL(String(input));
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    return Response.json({ engineVersion: 2, results: [], hasMore: false, searchTruncated: true, aliasExpansionTruncated: true });
  }, { preconnect: originalFetch.preconnect });
  const result = await readSearch({ query: " alias ", limit: 3 });
  expect(requested?.pathname).toBe("/search");
  expect(requested?.searchParams.get("q")).toBe(" alias ");
  expect(requested?.searchParams.get("limit")).toBe("3");
  expect(result).toEqual({ kind: "found", value: { engineVersion: 2, results: [], hasMore: false, searchTruncated: true, aliasExpansionTruncated: true } });
});

test("daemon busy 503 is unavailable rather than an empty successful search", async () => {
  process.env.THOUGHTLOOM_DAEMON_URL = "http://127.0.0.1:4318";
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    return Response.json({ error: "search busy" }, { status: 503 });
  }, { preconnect: originalFetch.preconnect });
  expect(await readSearch({ query: "fixture" })).toEqual({ kind: "unavailable" });
  expect(calls).toBe(1);
});

test("search BFF forwards unavailable instead of returning an empty result", async () => {
  process.env.THOUGHTLOOM_DAEMON_URL = "http://127.0.0.1:4318";
  globalThis.fetch = Object.assign(async () => Response.json({ error: "search busy" }, { status: 503 }), { preconnect: originalFetch.preconnect });
  const response = await GET(new Request("http://127.0.0.1:4317/api/search?q=fixture"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Search unavailable" });
});
