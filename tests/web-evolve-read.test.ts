import { describe, expect, test } from "bun:test";
import { readEvolveResponse, readEvolveThought } from "../apps/web/src/features/evolve/request";
import { handleEvolveResponse } from "../apps/web/src/server/evolve";
import type { DaemonRequest } from "../apps/web/src/server/daemon";
import type { IdeaThought, SharedResponse } from "../apps/web/src/features/idea/types";

const thought = { id: "issued-1", text: "owned private thought", title: null, titleAuthor: null, author: "ai", kind: "developing-idea", createdAt: "2032-01-01T00:00:00Z", origin: "development", parentId: "contribution-1", sourceIds: [] } satisfies IdeaThought;
const reply = { id: "reply-1", text: "owned private reply", role: "addendum", state: "complete", thoughtIds: ["issued-1", "issued-2"] } satisfies SharedResponse;
const json = (value: unknown, status = 200) => Response.json(value, { status });
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;
const request = (query = "") => new Request(`http://127.0.0.1:3000/api/evolve/thoughts/issued-1/responses/reply-1${query}`);

describe("normal Evolve selected thought client", () => {
  test("reads a source-authored imported original", async () => {
    const imported = { ...thought, author: "source", kind: "imported-original", origin: "markdown-import", parentId: null } as const;
    const result = await readEvolveThought("issued-1", { fetch: fakeFetch(async () => json(imported)) });
    expect(result).toEqual({ kind: "found", value: imported });
  });
  test("uses the fixed thought route and returns canonical matching data", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await readEvolveThought("issued-1", { fetch: fakeFetch(async (input, init) => { calls.push({ url: String(input), init }); return json(thought); }) });
    expect(result).toEqual({ kind: "found", value: thought });
    expect(calls).toHaveLength(1); expect(calls[0]?.url).toBe("/api/evolve/thoughts/issued-1");
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(calls[0]?.init?.cache).toBe("no-store"); expect(calls[0]?.init?.redirect).toBe("error");
  });
  for (const [label, getResponse, expected] of [
    ["hidden", async () => new Response(null, { status: 404 }), "unavailable"],
    ["server error", async () => new Response("owned-secret private text", { status: 500 }), "error"],
    ["mismatched ID", async () => json({ ...thought, id: "other" }), "error"],
    ["rejected projection", async () => json({ ...thought, rejected: true }), "error"],
    ["malformed", async () => new Response("{", { status: 200 }), "error"],
    ["connection loss", async () => { throw new Error("owned-secret private text"); }, "error"],
  ] as const) {
    test(`${label} does not produce a thought or raw error`, async () => {
      const calls: string[] = [];
      const result = await readEvolveThought("issued-1", { fetch: fakeFetch(async input => { calls.push(String(input)); return getResponse(); }) });
      expect(result.kind).toBe(expected); expect(calls).toEqual(["/api/evolve/thoughts/issued-1"]);
      if (result.kind === "found") throw new Error("Unexpected thought");
      expect(result.message).not.toContain("owned-secret"); expect(result.message).not.toContain("private text");
    });
  }
});

describe("normal associated Evolve reply server", () => {
  test("checks a visible thought then returns only its matching associated reply", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleEvolveResponse(request(), "issued-1", "reply-1", { callDaemon: async command => {
      calls.push(command);
      const path = new URL(command.path, "http://daemon.invalid").pathname;
      return path === "/thoughts/issued-1" ? json(thought) : json([reply]);
    } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(reply);
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => new URL(call.path, "http://daemon.invalid").pathname)).toEqual(["/thoughts/issued-1", "/thoughts/issued-1/responses"]);
    expect(calls.every(call => call.method === "GET" && [null, "normal"].includes(new URL(call.path, "http://daemon.invalid").searchParams.get("scope")))).toBe(true);
    expect(calls.some(call => call.path.startsWith("/responses/"))).toBe(false);
  });
  test("a missing or rejected thought stops before response lookup and never broadens", async () => {
    for (const response of [new Response(null, { status: 404 }), json({ ...thought, rejected: true }), json({ ...thought, id: "wrong" })]) {
      const calls: DaemonRequest[] = [];
      const result = await handleEvolveResponse(request(), "issued-1", "reply-1", { callDaemon: async command => { calls.push(command); return response; } });
      expect(result.status).not.toBe(200); expect(calls).toHaveLength(1);
      expect(calls[0]?.path).not.toContain("history"); expect(calls[0]?.path).not.toContain("show-rejected");
    }
  });
  for (const replies of [[], [{ ...reply, id: "other" }], [{ ...reply, thoughtIds: ["foreign"] }], [{ ...reply, text: 3 }], { items: [reply] }]) {
    test(`refuses absent, malformed or foreign association ${JSON.stringify(replies)}`, async () => {
      const calls: DaemonRequest[] = [];
      const response = await handleEvolveResponse(request(), "issued-1", "reply-1", { callDaemon: async command => { calls.push(command); return calls.length === 1 ? json(thought) : json(replies); } });
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain("owned private reply");
      expect(calls.every(call => !call.path.startsWith("/responses/"))).toBe(true);
    });
  }
  for (const query of ["?scope=history", "?scope=show-rejected", "?path=/responses/reply-1"]) {
    test(`rejects browser-controlled scope or path ${query}`, async () => {
      let calls = 0;
      const result = await handleEvolveResponse(request(query), "issued-1", "reply-1", { callDaemon: async () => { calls++; return json(thought); } });
      expect(result.status).toBe(400); expect(calls).toBe(0);
    });
  }
  test("sanitizes upstream errors and returns private no-store failure", async () => {
    const response = await handleEvolveResponse(request(), "issued-1", "reply-1", { callDaemon: async () => { throw new Error("owned-secret owned private reply"); } });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    const body = await response.text(); expect(body).not.toContain("owned-secret"); expect(body).not.toContain("owned private reply");
  });
});

describe("associated Evolve reply client", () => {
  test("calls only the fixed thought-associated route with no-store", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await readEvolveResponse("issued-1", "reply-1", { fetch: fakeFetch(async (input, init) => { calls.push({ url: String(input), init }); return json(reply); }) });
    expect(result).toEqual({ kind: "found", value: reply }); expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/evolve/thoughts/issued-1/responses/reply-1");
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(calls[0]?.init?.cache).toBe("no-store"); expect(calls[0]?.init?.redirect).toBe("error");
  });
  for (const [label, response, expected] of [
    ["missing", new Response(null, { status: 404 }), "unavailable"],
    ["wrong ID", json({ ...reply, id: "other" }), "error"],
    ["foreign thought", json({ ...reply, thoughtIds: ["foreign"] }), "error"],
    ["malformed", new Response("{", { status: 200 }), "error"],
    ["upstream failure", new Response("owned-secret owned private reply", { status: 500 }), "error"],
  ] as const) {
    test(`${label} is not presented as a reply`, async () => {
      let calls = 0;
      const result = await readEvolveResponse("issued-1", "reply-1", { fetch: fakeFetch(async () => { calls++; return response; }) });
      expect(result.kind).toBe(expected); expect(calls).toBe(1);
      if (result.kind === "found") throw new Error("Unexpected reply");
      expect(result.message).not.toContain("owned-secret"); expect(result.message).not.toContain("owned private reply");
    });
  }
});
