import { describe, expect, test } from "bun:test";
import { commandIdea } from "../apps/web/src/features/idea/request";
import type { IdeaCommand } from "../apps/web/src/features/idea/types";
import { handleIdeaCommand } from "../apps/web/src/server/idea";
import type { DaemonRequest } from "../apps/web/src/server/daemon";

const intent = { action: "create-connection", thoughtId: "root-1", fromId: "root-1", toId: "other-1", category: "supports", explanation: "A reason", sourceIds: ["source-1"] } as const;
const canonical = { id: "connection-1", fromId: intent.fromId, toId: intent.toId, category: intent.category, explanation: intent.explanation, sourceIds: [...intent.sourceIds], proposedBy: "user", rejected: false };
const request = (body: unknown) => new Request("http://127.0.0.1:3000/api/ideas/root-1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const clientCommand = (value: unknown): IdeaCommand => value as IdeaCommand;
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

describe("fixed user connection command", () => {
  for (const [fromId, toId] of [["root-1", "other-1"], ["other-1", "root-1"]] as const) {
    for (const category of ["supports", "contradicts", "extends", "related"] as const) {
      test(`forwards ${category} with direction ${fromId} to ${toId} once`, async () => {
        const calls: DaemonRequest[] = [];
        const input = { ...intent, fromId, toId, category };
        const result = { ...canonical, fromId, toId, category };
        const response = await handleIdeaCommand(request(input), "root-1", { callDaemon: async operation => { calls.push(operation); return Response.json(result, { status: 201 }); } });
        expect(calls).toEqual([{ method: "POST", path: "/connections", body: JSON.stringify({ fromId, toId, category, explanation: intent.explanation, sourceIds: ["source-1"] }) }]);
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual(result);
      });
    }
  }

  test("omitted sources are accepted and default to an empty list", async () => {
    const { sourceIds: _sources, ...withoutSources } = intent;
    const calls: DaemonRequest[] = [];
    const response = await handleIdeaCommand(request(withoutSources), "root-1", { callDaemon: async operation => { calls.push(operation); return Response.json({ ...canonical, sourceIds: [] }, { status: 201 }); } });
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.body));
    expect({ ...body, sourceIds: body.sourceIds ?? [] }).toEqual({ fromId: "root-1", toId: "other-1", category: "supports", explanation: "A reason", sourceIds: [] });
  });

  for (const extra of [{ id: "forged" }, { proposedBy: "ai" }, { author: "ai" }, { path: "/thoughts" }]) {
    test(`rejects client-controlled server fields ${Object.keys(extra)[0]}`, async () => {
      let calls = 0;
      const response = await handleIdeaCommand(request({ ...intent, ...extra }), "root-1", { callDaemon: async () => { calls++; return new Response(null, { status: 204 }); } });
      expect(response.status).toBe(400);
      expect(calls).toBe(0);
    });
  }

  for (const invalid of [{ fromId: "elsewhere", toId: "other-1" }, { toId: "root-1" }, { category: "invented" }, { explanation: "  " }, { sourceIds: [12] }]) {
    test(`rejects malformed intent ${JSON.stringify(invalid)}`, async () => {
      let calls = 0;
      const response = await handleIdeaCommand(request({ ...intent, ...invalid }), "root-1", { callDaemon: async () => { calls++; return new Response(null, { status: 204 }); } });
      expect(response.status).toBe(400);
      expect(calls).toBe(0);
    });
  }

  for (const status of [400, 401, 403, 404]) {
    test(`preserves known ${status} failure without exposing daemon content or retrying`, async () => {
      let calls = 0;
      const response = await handleIdeaCommand(request(intent), "root-1", { callDaemon: async () => { calls++; return new Response("private sentinel", { status }); } });
      expect(calls).toBe(1);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("private sentinel");
    });
  }

  for (const mode of ["drop", "500", "204", "malformed", "wrong-author"] as const) {
    test(`${mode} cannot establish creation or safe retry`, async () => {
      let calls = 0;
      const response = await handleIdeaCommand(request(intent), "root-1", { callDaemon: async () => {
        calls++;
        if (mode === "drop") throw new Error("private sentinel");
        if (mode === "500") return new Response("private sentinel", { status: 500 });
        if (mode === "204") return new Response(null, { status: 204 });
        return Response.json(mode === "malformed" ? { id: "connection-1" } : { ...canonical, proposedBy: "ai" }, { status: 201 });
      } });
      expect(calls).toBe(1);
      expect([201, 400, 401, 403, 404]).not.toContain(response.status);
      expect(await response.text()).not.toContain("private sentinel");
    });
  }
});

describe("connection client save outcomes", () => {
  for (const [status, kind] of [[400, "not-applied"], [401, "not-applied"], [403, "not-applied"], [404, "not-applied"], [500, "uncertain"], [204, "uncertain"]] as const) {
    test(`classifies ${status} as ${kind} with one browser request`, async () => {
      let calls = 0;
      const result = await commandIdea(clientCommand(intent), { fetch: fakeFetch(async () => { calls++; return new Response(status === 204 ? null : "private sentinel", { status }); }) });
      expect(calls).toBe(1);
      expect(result.kind).toBe(kind);
      expect(JSON.stringify(result)).not.toContain("private sentinel");
    });
  }
  test("accepts only the canonical 201 and never sends credentials from the browser", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const response = Response.json(canonical, { status: 201 });
    const result = await commandIdea(clientCommand(intent), { fetch: fakeFetch(async (input, init) => { calls.push({ url: String(input), init }); return response; }) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/ideas/root-1");
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(intent);
    expect(result.kind).toBe("applied");
    expect(response.bodyUsed).toBe(true);
  });
  test("malformed 201 JSON is consumed and remains uncertain", async () => {
    const response = new Response("{", { status: 201 });
    const result = await commandIdea(clientCommand(intent), { fetch: fakeFetch(async () => response) });
    expect(result).toEqual({ kind: "uncertain", message: "Outcome unconfirmed.", command: intent });
    expect(response.bodyUsed).toBe(true);
  });
  test("retains an independent submitted snapshot after a dropped request", async () => {
    const mutable = { ...intent, sourceIds: ["source-1"] };
    let complete: () => void = () => { throw new Error("fetch not called"); };
    let calls = 0;
    const pending = commandIdea(clientCommand(mutable), { fetch: fakeFetch(async () => { calls++; await new Promise<void>(resolve => { complete = resolve; }); throw new Error("private sentinel"); }) });
    mutable.sourceIds.push("later");
    expect(calls).toBe(1);
    complete();
    const result = await pending;
    expect(calls).toBe(1);
    expect(result.kind).toBe("uncertain");
    if (result.kind === "applied") throw new Error("unexpected success");
    expect(result.command).toEqual(intent);
    expect(result.message).not.toContain("private sentinel");
  });
});
