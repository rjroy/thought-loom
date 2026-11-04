import { describe, expect, test } from "bun:test";
import { decodeIdeaLocation, ideaActionHref } from "../apps/web/src/features/idea/location";
import { commandIdea, readIdea } from "../apps/web/src/features/idea/request";
import type { BranchPreview, IdeaCommand } from "../apps/web/src/features/idea/types";
import { handleIdeaCommand, handleIdeaRead } from "../apps/web/src/server/idea";
import type { DaemonRequest } from "../apps/web/src/server/daemon";

const root = { id: "root-1", text: "immutable original thought", title: "Title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: "parent-1", sourceIds: ["source-1", "missing-source"] };
const parent = { ...root, id: "parent-1", text: "parent text", parentId: "hidden-parent", sourceIds: [] };
const child = { ...root, id: "child-1", text: "direct child", parentId: "root-1", sourceIds: [] };
const source = { ...root, id: "source-1", text: "source text", parentId: null, sourceIds: [] };
const edge = { id: "edge-1", fromId: "root-1", toId: "source-1", category: "supports", proposedBy: "ai", explanation: "directed explanation", sourceIds: [], rejected: false };
const rejectedEdge = { ...edge, id: "edge-2", fromId: "missing-source", toId: "root-1", rejected: true };
const reply = { id: "reply-1", text: "associated reply", role: "addendum", state: "complete", thoughtIds: ["prior-1", "root-1"] };
const fallback = { id: "reply-2", text: "interrupted fallback", role: "fallback", state: "interrupted", thoughtIds: ["root-1"] };
const preview: BranchPreview = { rootId: "root-1", branchIds: ["root-1", "child-1"], affectedIds: ["child-1"], count: 1 };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const noContent = () => new Response(null, { status: 204 });
const req = (suffix = "") => new Request(`http://127.0.0.1:3000/api/ideas/root-1${suffix}`);
const commandRequest = (body: unknown) => new Request("http://127.0.0.1:3000/api/ideas/root-1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

describe("Idea location", () => {
  test("direct links default to normal and a safe Explore return", () => {
    expect(decodeIdeaLocation("root-1", new URLSearchParams())).toEqual({ id: "root-1", scope: "normal", returnTo: "/explore" });
  });
  test("accepts deliberate inspection and preserves associated response identity", () => {
    const params = new URLSearchParams({ responseId: "reply-1", returnTo: "/explore?q=words&scope=show-rejected&author=ai" });
    expect(decodeIdeaLocation("root-1", params)).toEqual({ id: "root-1", scope: "show-rejected", responseId: "reply-1", returnTo: "/explore?q=words&scope=show-rejected&author=ai" });
    expect(decodeIdeaLocation("root-1", new URLSearchParams({ scope: "history" }))?.scope).toBe("history");
  });
  for (const target of ["https://evil.test/explore?q=x&scope=show-rejected", "//evil.test/explore?q=x&scope=show-rejected", "/explore?q=x&scope=history", "/explore?q=x&scope=show-rejected&extra=1"]) {
    test(`does not infer inspection from unsafe return ${target}`, () => {
      const location = decodeIdeaLocation("root-1", new URLSearchParams({ returnTo: target }));
      expect(location?.scope).toBe("normal");
      expect(location?.returnTo).toBe("/explore");
    });
  }
  test("contextual links preserve encoded selected identity", () => {
    for (const action of ["evolve", "export"] as const) {
      const link = new URL(ideaActionHref("owned/id &", action), "http://web.invalid");
      expect(link.origin).toBe("http://web.invalid");
      expect(link.pathname).toBe(`/${action}`);
      expect(link.searchParams.get("thoughtId")).toBe("owned/id &");
      expect([...link.searchParams.keys()]).toEqual(["thoughtId"]);
      expect(link.hash).toBe("");
    }
  });
});

describe("scoped Idea reads", () => {
  test("missing focused thought stops without fetching relationships or broadening", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleIdeaRead(req("?scope=normal&part=view"), "root-1", { callDaemon: async command => { calls.push(command); return new Response(null, { status: 404 }); } });
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toMatch(/^\/thoughts\/root-1(?:\?scope=normal)?$/);
  });
  test("scoped relationships preserve directed edge states, resolve neighbors once, and never fetch unrelated response ID", async () => {
    const calls: string[] = [];
    const response = await handleIdeaRead(req("?scope=show-rejected&part=view&responseId=unrelated-secret"), "root-1", { callDaemon: async command => {
      calls.push(command.path);
      const url = new URL(command.path, "http://daemon.invalid");
      expect(url.searchParams.get("scope")).toBe("show-rejected");
      if (url.pathname === "/thoughts/root-1") return json({ ...root, rejected: true });
      if (url.pathname === "/thoughts/root-1/connections") return json([edge, { ...edge, id: "edge-3" }, rejectedEdge]);
      if (url.pathname === "/thoughts/root-1/responses") return json([reply, fallback]);
      if (url.pathname === "/thoughts/source-1") return json({ ...source, rejected: true });
      return new Response(null, { status: 404 });
    } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    const view = await response.json();
    expect(view.thought).toEqual({ ...root, rejected: true });
    expect(view.connections).toEqual([{ connection: edge, thought: { ...source, rejected: true } }, { connection: { ...edge, id: "edge-3" }, thought: { ...source, rejected: true } }, { connection: rejectedEdge, thought: null }]);
    expect(view.responses).toEqual([reply, fallback]);
    expect(view.focusedResponse).toBeNull();
    expect(calls.filter(path => path.startsWith("/thoughts/source-1?")).length).toBe(1);
    expect(calls.some(path => path.startsWith("/responses/"))).toBe(false);
    expect(JSON.stringify(view)).not.toContain("unrelated-secret");
  });
  test("associated focused reply retains canonical role, state and association order", async () => {
    const response = await handleIdeaRead(req("?scope=normal&part=view&responseId=reply-2"), "root-1", { callDaemon: async command => {
      const path = new URL(command.path, "http://daemon.invalid").pathname;
      if (path === "/thoughts/root-1") return json(root);
      if (path.endsWith("/responses")) return json([reply, fallback]);
      if (path.endsWith("/connections")) return json([]);
      return new Response(null, { status: 404 });
    } });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.focusedResponse).toEqual(fallback);
    expect(view.responses).toEqual([reply, fallback]);
    expect(view.connections).toEqual([]);
  });
  test("neighbor reads are bounded and keep unavailable endpoints honest", async () => {
    const links = Array.from({ length: 9 }, (_, index) => ({ ...edge, id: `edge-${index}`, toId: `neighbor-${index}` }));
    let active = 0, maximum = 0;
    const response = await handleIdeaRead(req("?scope=normal&part=view"), "root-1", { callDaemon: async command => {
      const path = new URL(command.path, "http://daemon.invalid").pathname;
      if (path === "/thoughts/root-1") return json(root);
      if (path === "/thoughts/root-1/connections") return json(links);
      if (path === "/thoughts/root-1/responses") return json([]);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return new Response(null, { status: 404 });
    } });
    expect(response.status).toBe(200);
    expect(maximum).toBeLessThanOrEqual(4);
    expect((await response.json()).connections).toEqual(links.map(connection => ({ connection, thought: null })));
  });
  test("sources are explicit on-demand scoped reads and missing sources stay unavailable", async () => {
    const calls: string[] = [];
    const response = await handleIdeaRead(req("?scope=normal&part=sources"), "root-1", { callDaemon: async command => {
      calls.push(command.path);
      const url = new URL(command.path, "http://daemon.invalid");
      expect([null, "normal"]).toContain(url.searchParams.get("scope"));
      if (url.pathname === "/thoughts/root-1") return json(root);
      if (url.pathname === "/thoughts/source-1") return json(source);
      return new Response(null, { status: 404 });
    } });
    expect(response.status).toBe(200);
    expect((await response.json()).sources).toEqual([{ id: "source-1", thought: source }, { id: "missing-source", thought: null }]);
    expect(calls.every(path => !path.startsWith("/thoughts?"))).toBe(true);
    expect(calls.every(path => !path.includes("history"))).toBe(true);
  });
  test("history follows known parents and direct children without crossing an unavailable ancestor", async () => {
    const calls: string[] = [];
    const response = await handleIdeaRead(req("?scope=normal&part=history"), "root-1", { callDaemon: async command => {
      calls.push(command.path);
      const url = new URL(command.path, "http://daemon.invalid");
      expect([null, "normal"]).toContain(url.searchParams.get("scope"));
      if (url.pathname === "/thoughts/root-1") return json(root);
      if (url.pathname === "/thoughts/parent-1") return json(parent);
      if (url.pathname === "/thoughts/root-1/children") return json([child]);
      return new Response(null, { status: 404 });
    } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ancestors: [parent], children: [child], unavailableParentId: "hidden-parent" });
    expect(calls.some(path => path.startsWith("/thoughts/child-1/children"))).toBe(false);
    expect(calls.some(path => path.startsWith("/thoughts?"))).toBe(false);
  });
  test("history detects parent cycles without recursive daemon reads", async () => {
    const calls: string[] = [];
    const response = await handleIdeaRead(req("?scope=history&part=history"), "root-1", { callDaemon: async command => {
      calls.push(command.path);
      const path = new URL(command.path, "http://daemon.invalid").pathname;
      if (path === "/thoughts/root-1") return json({ ...root, rejected: false });
      if (path === "/thoughts/parent-1") return json({ ...parent, parentId: "root-1", rejected: true });
      if (path === "/thoughts/root-1/children") return json([]);
      throw new Error("unexpected read");
    } });
    expect(response.status).toBe(200);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls.every(path => path.includes("scope=history"))).toBe(true);
  });
});

describe("fixed Idea commands", () => {
  for (const command of [{ action: "title", thoughtId: "other", title: "x" }, { action: "title", thoughtId: "root-1", title: "x", text: "rewrite" }, { action: "title", thoughtId: "root-1", title: " " }, { action: "reject-branch", thoughtId: "root-1", preview: { ...preview, rootId: "other" } }, { action: "unknown", thoughtId: "root-1" }, { action: "reject-thought", thoughtId: "root-1", path: "/other" }]) {
    test(`rejects invalid command before transport ${JSON.stringify(command)}`, async () => {
      let calls = 0;
      const response = await handleIdeaCommand(commandRequest(command), "root-1", { callDaemon: async () => { calls++; return noContent(); } });
      expect(response.status).toBe(400);
      expect(calls).toBe(0);
    });
  }
  test("title clear forwards only null and returns full daemon canonical thought", async () => {
    const calls: DaemonRequest[] = [];
    const updated = { ...root, title: null, titleAuthor: null };
    const response = await handleIdeaCommand(commandRequest({ action: "title", thoughtId: "root-1", title: null }), "root-1", { callDaemon: async command => { calls.push(command); return json(updated); } });
    expect(calls).toEqual([{ method: "PUT", path: "/thoughts/root-1/title", body: JSON.stringify({ title: null }) }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(updated);
  });
  for (const [action, path] of [["reject-thought", "/thoughts/root-1/reject"], ["restore-thought", "/thoughts/root-1/restore"], ["restore-branch", "/thoughts/root-1/branch/restore"], ["reject-connection", "/connections/edge-1/reject"], ["restore-connection", "/connections/edge-1/restore"]] as const) {
    test(`${action} maps to its one bodyless endpoint`, async () => {
      const calls: DaemonRequest[] = [];
      const command = { action, thoughtId: "root-1", ...(action.includes("connection") ? { connectionId: "edge-1" } : {}) };
      const response = await handleIdeaCommand(commandRequest(command), "root-1", { callDaemon: async value => { calls.push(value); return noContent(); } });
      expect(response.status).toBe(204);
      expect(calls).toEqual([{ method: "POST", path }]);
    });
  }
  test("forwards exact branch preview once and exposes stale 409 without replay", async () => {
    const calls: DaemonRequest[] = [];
    const command = { action: "reject-branch", thoughtId: "root-1", preview };
    const response = await handleIdeaCommand(commandRequest(command), "root-1", { callDaemon: async value => { calls.push(value); return new Response("private stale body", { status: 409 }); } });
    expect(response.status).toBe(409);
    expect(calls).toEqual([{ method: "POST", path: "/thoughts/root-1/branch/reject", body: JSON.stringify(preview) }]);
    expect(await response.text()).not.toContain("private stale body");
  });
  test("reads daemon preview exactly instead of recomputing it", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleIdeaRead(req("?part=preview&scope=normal"), "root-1", { callDaemon: async value => { calls.push(value); return json(preview); } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(preview);
    expect(calls).toEqual([{ method: "GET", path: "/thoughts/root-1/branch/preview" }]);
  });
  for (const mode of ["drop", "500", "malformed-title", "wrong-title-id"] as const) {
    test(`does not report ${mode} as applied or known-not-applied`, async () => {
      let calls = 0;
      const command = mode.includes("title") ? { action: "title", thoughtId: "root-1", title: "new" } : { action: "reject-thought", thoughtId: "root-1" };
      const response = await handleIdeaCommand(commandRequest(command), "root-1", { callDaemon: async () => {
        calls++;
        if (mode === "drop") throw new Error("owned-secret immutable original thought");
        if (mode === "500") return new Response("owned-secret immutable original thought", { status: 500 });
        if (mode === "malformed-title") return json({ id: "root-1" });
        return json({ ...root, id: "other" });
      } });
      expect(calls).toBe(1);
      expect([200, 204, 400, 401, 403, 404, 409]).not.toContain(response.status);
      const body = await response.text();
      expect(body).not.toContain("owned-secret");
      expect(body).not.toContain("immutable original thought");
    });
  }
});

describe("Idea client request outcomes", () => {
  const command: IdeaCommand = { action: "reject-branch", thoughtId: "root-1", preview };
  for (const [status, kind] of [[400, "not-applied"], [401, "not-applied"], [403, "not-applied"], [404, "not-applied"], [409, "conflict"], [500, "uncertain"], [200, "uncertain"]] as const) {
    test(`classifies branch command ${status} as ${kind} without retry or private error`, async () => {
      let calls = 0;
      const result = await commandIdea(command, { fetch: fakeFetch(async () => { calls++; return new Response("owned-secret private content", { status }); }) });
      expect(calls).toBe(1);
      expect(result.kind).toBe(kind);
      if (result.kind === "applied") throw new Error("unexpected success");
      expect(result.message).not.toContain("owned-secret");
      expect(result.message).not.toContain("private content");
    });
  }
  test("connection restore is independently confirmed by 204", async () => {
    const result = await commandIdea({ action: "restore-connection", thoughtId: "root-1", connectionId: "edge-1" }, { fetch: fakeFetch(async () => noContent()) });
    expect(result.kind).toBe("applied");
  });
  test("title malformed 200 and dropped connection remain uncertain", async () => {
    for (const fetch of [fakeFetch(async () => json({ id: "root-1" })), fakeFetch(async () => { throw new Error("owned-secret private content"); })]) {
      const result = await commandIdea({ action: "title", thoughtId: "root-1", title: "new" }, { fetch });
      expect(result.kind).toBe("uncertain");
      if (result.kind === "applied") throw new Error("unexpected success");
      expect(result.message).not.toContain("owned-secret");
    }
  });
  test("freezes target and branch preview before waiting for a response", async () => {
    const mutable = { action: "reject-branch" as const, thoughtId: "root-1", preview: { rootId: "root-1", branchIds: ["root-1", "child-1"], affectedIds: ["child-1"], count: 1 } };
    let complete: (response: Response) => void = () => { throw new Error("fetch not called"); };
    let body = "";
    const pending = commandIdea(mutable, { fetch: fakeFetch(async (_input, init) => { body = String(init?.body); return new Promise<Response>(resolve => { complete = resolve; }); }) });
    mutable.thoughtId = "other"; mutable.preview.branchIds.push("later"); mutable.preview.affectedIds.length = 0;
    complete(new Response(null, { status: 500 }));
    const result = await pending;
    expect(JSON.parse(body)).toEqual({ action: "reject-branch", thoughtId: "root-1", preview });
    expect(result.kind).toBe("uncertain");
    if (result.kind === "applied") throw new Error("unexpected success");
    expect(result.command).toEqual(command);
  });
  test("read uses fixed Idea route and returns typed unavailable instead of broadening", async () => {
    const urls: string[] = [];
    const result = await readIdea("root-1", { scope: "normal", part: "view", responseId: "reply-1" }, { fetch: fakeFetch(async input => { urls.push(String(input)); return new Response(null, { status: 404 }); }) });
    expect(result.kind).toBe("unavailable");
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0] ?? "", "http://web.invalid");
    expect(url.pathname).toBe("/api/ideas/root-1");
    expect(url.searchParams.get("scope")).toBe("normal");
    expect(url.searchParams.get("responseId")).toBe("reply-1");
  });
});
