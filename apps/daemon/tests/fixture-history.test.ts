import { expect, test } from "bun:test";
import { OpenCode, type SessionMessageInfo } from "./native-client-support";
import { canonicalHistory, verifyTitleHistory } from "../../../tests/native/fixture-history";

const sessionId = "ses_fixture", agent = "fixture_weaver", messageId = "msg_title", callId = "call_title";
const scope = () => ({ sessionId, agent, messageId, callId, signal: new AbortController().signal });
type Page = { data: SessionMessageInfo[]; cursor: { next?: string | null } };

function message(options: { id?: string; agent?: string; callId?: string; name?: string; running?: boolean } = {}): SessionMessageInfo {
  return { id: options.id ?? messageId, type: "assistant", agent: options.agent ?? agent,
    model: { providerID: "fixture", id: "fixture-model" }, time: { created: 1, completed: 2 },
    content: [{ type: "tool", id: options.callId ?? callId, name: options.name ?? "record_title_v1", time: { created: 1, completed: 2 },
      state: options.running ? { status: "running", input: {}, metadata: {} } : { status: "completed", input: {}, content: [{ type: "text", text: "fixture receipt" }] } }] };
}

// Real installed SDK transport, but all HTTP responses are test-owned in memory.
function fixture(reply: (url: URL) => Page) {
  const requests: URL[] = [];
  const fakeFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (request.signal.aborted) throw request.signal.reason;
    if (request.method !== "GET" || url.pathname !== `/api/session/${sessionId}/message`) throw new Error("Unexpected SDK fixture request");
    requests.push(url); return Response.json(reply(url));
  }, { preconnect: fetch.preconnect });
  return { client: OpenCode.make({ baseUrl: "http://127.0.0.1:19089", fetch: fakeFetch }), requests };
}

test("title history accepts a matching nonempty page followed by empty EOF", async () => {
  const f = fixture((url) => url.searchParams.has("cursor") ? { data: [], cursor: {} } : { data: [message()], cursor: { next: "after-title" } });
  await verifyTitleHistory(f.client, scope());
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]?.searchParams.get("order")).toBe("asc");
  expect(f.requests[1]?.searchParams.get("cursor")).toBe("after-title");
  expect(f.requests[1]?.searchParams.has("order")).toBe(false);
});

test("title history finds its exact completed tool on a later page", async () => {
  const f = fixture((url) => {
    const cursor = url.searchParams.get("cursor");
    return cursor === null ? { data: [message({ id: "msg_earlier" })], cursor: { next: "page-two" } } : cursor === "page-two" ? { data: [message()], cursor: { next: "after-title" } } : { data: [], cursor: {} };
  });
  await verifyTitleHistory(f.client, scope());
  expect(f.requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "page-two", "after-title"]);
  expect(f.requests.slice(1).every((url) => !url.searchParams.has("order"))).toBe(true);
});

for (const [label, options] of [
  ["wrong message", { id: "msg_other" }], ["wrong agent", { agent: "other_agent" }],
  ["wrong call", { callId: "call_other" }], ["wrong action", { name: "record_idea" }],
  ["incomplete tool", { running: true }],
] as const) {
  test(`title history rejects ${label} even at EOF`, async () => {
    const f = fixture(() => ({ data: [message(options)], cursor: {} }));
    await expect(verifyTitleHistory(f.client, scope())).rejects.toMatchObject({ code: "title_native_history_missing" });
    expect(f.requests).toHaveLength(1);
  });
}

test("baseline fixture pager follows next to empty EOF without repeating order", async () => {
  const f = fixture((url) => url.searchParams.has("cursor") ? { data: [], cursor: {} } : { data: [message()], cursor: { next: "after-title" } });
  expect(await canonicalHistory(f.client, sessionId, new AbortController().signal)).toEqual([message()]);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]?.searchParams.get("order")).toBe("asc");
  expect(f.requests[1]?.searchParams.get("cursor")).toBe("after-title");
  expect(f.requests[1]?.searchParams.has("order")).toBe(false);
});

test("baseline fixture pager rejects duplicate messages and repeated cursors", async () => {
  const duplicate = fixture((url) => ({ data: [message()], cursor: { next: url.searchParams.has("cursor") ? "next-two" : "next-one" } }));
  await expect(canonicalHistory(duplicate.client, sessionId, new AbortController().signal)).rejects.toMatchObject({ code: "witness_history_duplicate" });
  expect(duplicate.requests).toHaveLength(2);
  const loop = fixture(() => ({ data: [], cursor: { next: "same-cursor" } }));
  await expect(canonicalHistory(loop.client, sessionId, new AbortController().signal)).rejects.toMatchObject({ code: "witness_history_cursor_loop" });
  expect(loop.requests).toHaveLength(2);
});

test("baseline fixture pager bounds unique cursors and honors cancellation", async () => {
  let count = 0;
  const f = fixture(() => ({ data: [], cursor: { next: `page-${++count}` } }));
  await expect(canonicalHistory(f.client, sessionId, new AbortController().signal)).rejects.toMatchObject({ code: "witness_history_page_budget" });
  expect(f.requests).toHaveLength(20);
  const cancelled = new AbortController(); cancelled.abort();
  const cancelledFixture = fixture(() => ({ data: [], cursor: {} }));
  await expect(canonicalHistory(cancelledFixture.client, sessionId, cancelled.signal)).rejects.toThrow();
  expect(cancelledFixture.requests).toHaveLength(0);
});
