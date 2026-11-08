import { describe, expect, test } from "bun:test";
import { decodeIdeaLocation, ideaActionHref } from "../apps/web/src/features/idea/location";
import { commandIdea, readIdea } from "../apps/web/src/features/idea/request";
import type { BranchPreview, IdeaCommand, IdeaConnection, IdeaThought, SharedResponse } from "../apps/web/src/features/idea/types";
import { handleIdeaCommand, handleIdeaRead } from "../apps/web/src/server/idea";
import type { DaemonRequest } from "../apps/web/src/server/daemon";
import { connection as validConnection, thought as validThought } from "../apps/web/src/features/idea/validation";

const root = { id: "root-1", text: "immutable original thought", title: "Title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: "parent-1", sourceIds: ["source-1", "missing-source"] } satisfies IdeaThought;
const parent = { ...root, id: "parent-1", text: "parent text", parentId: "hidden-parent", sourceIds: [] };
const child = { ...root, id: "child-1", text: "direct child", parentId: "root-1", sourceIds: [] };
const source = { ...root, id: "source-1", text: "source text", parentId: null, sourceIds: [] };
const edge = { id: "edge-1", fromId: "root-1", toId: "source-1", category: "supports", proposedBy: "ai", explanation: "directed explanation", sourceIds: [], rejected: false } satisfies IdeaConnection;
const rejectedEdge = { ...edge, id: "edge-2", fromId: "missing-source", toId: "root-1", rejected: true };
const reply = { id: "reply-1", text: "associated reply", role: "addendum", state: "complete", thoughtIds: ["prior-1", "root-1"] } satisfies SharedResponse;
const fallback = { id: "reply-2", text: "interrupted fallback", role: "fallback", state: "interrupted", thoughtIds: ["root-1"] } satisfies SharedResponse;
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
  for (const part of ["sources", "history"] as const) {
    test(`obsolete ${part} part is rejected before any daemon read`, async () => {
      const calls: DaemonRequest[] = [];
      const response = await handleIdeaRead(req(`?scope=normal&part=${part}`), "root-1", { callDaemon: async command => { calls.push(command); return new Response(null, { status: 404 }); } });
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  }
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
      if (url.pathname === "/thoughts/root-1/children") return json([]);
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
      if (path.endsWith("/children")) return json([]);
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
      if (path === "/thoughts/root-1/children") return json([]);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return new Response(null, { status: 404 });
    } });
    expect(response.status).toBe(200);
    expect(maximum).toBeLessThanOrEqual(4);
    expect((await response.json()).connections).toEqual(links.map(connection => ({ connection, thought: null })));
  });
  test("initial context contains the immediate parent, direct children and ordered sources without walking ancestors or descendants", async () => {
    const calls: string[] = [];
    const interpretation = { ...child, author: "ai", kind: "ai-interpretation", sourceIds: ["root-1"] };
    const response = await handleIdeaRead(req("?scope=normal&part=view"), "root-1", { callDaemon: async command => {
      calls.push(command.path);
      const url = new URL(command.path, "http://daemon.invalid");
      expect([null, "normal"]).toContain(url.searchParams.get("scope"));
      if (url.pathname === "/thoughts/root-1") return json(root);
      if (url.pathname === "/thoughts/root-1/children") return json([interpretation]);
      if (url.pathname === "/thoughts/root-1/connections") return json([edge]);
      if (url.pathname === "/thoughts/root-1/responses") return json([reply]);
      if (url.pathname === "/thoughts/parent-1") return json(parent);
      if (url.pathname === "/thoughts/source-1") return json(source);
      if (url.pathname === "/thoughts/missing-source") return new Response(null, { status: 404 });
      throw new Error(`unexpected read ${url.pathname}`);
    } });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.parent).toEqual({ id: "parent-1", thought: parent });
    expect(view.children).toEqual([interpretation]);
    expect(view.sources).toEqual([{ id: "source-1", thought: source }, { id: "missing-source", thought: null }]);
    expect(view.connections).toEqual([{ connection: edge, thought: source }]);
    expect(view.responses).toEqual([reply]);
    expect(calls.filter(path => new URL(path, "http://daemon.invalid").pathname === "/thoughts/source-1")).toHaveLength(1);
    expect(calls.every(path => !path.startsWith("/thoughts?"))).toBe(true);
    expect(calls.every(path => !path.includes("history"))).toBe(true);
    expect(calls.some(path => path.includes("hidden-parent") || path.includes("child-1/children"))).toBe(false);
  });
  test("an interpretation exposes its own provenance and its immediate parent only", async () => {
    const calls: string[] = [];
    const interpretation = { ...child, author: "ai", kind: "ai-interpretation", sourceIds: ["root-1"] };
    const response = await handleIdeaRead(req("?scope=normal&part=view"), "child-1", { callDaemon: async command => {
      calls.push(command.path);
      const url = new URL(command.path, "http://daemon.invalid");
      expect([null, "normal"]).toContain(url.searchParams.get("scope"));
      if (url.pathname === "/thoughts/child-1") return json(interpretation);
      if (url.pathname === "/thoughts/child-1/children" || url.pathname === "/thoughts/child-1/connections" || url.pathname === "/thoughts/child-1/responses") return json([]);
      if (url.pathname === "/thoughts/root-1") return json(root);
      throw new Error(`unexpected read ${url.pathname}`);
    } });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.parent).toEqual({ id: "root-1", thought: root });
    expect(view.sources).toEqual([{ id: "root-1", thought: root }]);
    expect(view.children).toEqual([]);
    expect(calls.filter(path => new URL(path, "http://daemon.invalid").pathname === "/thoughts/root-1")).toHaveLength(1);
    expect(calls.some(path => path.includes("parent-1"))).toBe(false);
  });
  for (const scenario of ["root", "untitled", "unavailable"] as const) {
    test(`${scenario} parent is represented without inventing an ancestor or broadening scope`, async () => {
      const calls: string[] = [];
      const selected = { ...root, parentId: scenario === "root" ? null : "parent-1", sourceIds: [] };
      const untitled = { ...parent, title: null, titleAuthor: null };
      const response = await handleIdeaRead(req("?scope=normal&part=view"), "root-1", { callDaemon: async command => {
        calls.push(command.path);
        const url = new URL(command.path, "http://daemon.invalid");
        expect([null, "normal"]).toContain(url.searchParams.get("scope"));
        if (url.pathname === "/thoughts/root-1") return json(selected);
        if (["/thoughts/root-1/children", "/thoughts/root-1/connections", "/thoughts/root-1/responses"].includes(url.pathname)) return json([]);
        if (url.pathname === "/thoughts/parent-1") return scenario === "untitled" ? json(untitled) : new Response(null, { status: 404 });
        throw new Error(`unexpected read ${url.pathname}`);
      } });
      expect(response.status).toBe(200);
      expect((await response.json()).parent).toEqual(scenario === "root" ? null : { id: "parent-1", thought: scenario === "untitled" ? untitled : null });
      expect(calls.some(path => path.includes("hidden-parent"))).toBe(false);
      expect(calls.filter(path => path.startsWith("/thoughts/parent-1?")).length).toBe(scenario === "root" ? 0 : 1);
    });
  }
  test("shared parent, source and connection references are resolved once with at most four concurrent reads", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `ref-${i}`);
    const selected = { ...root, parentId: ids[0], sourceIds: ids };
    const links = ids.map((id, i) => ({ ...edge, id: `link-${i}`, toId: id }));
    const calls: string[] = [];
    let active = 0, maximum = 0;
    const response = await handleIdeaRead(req("?scope=show-rejected&part=view"), "root-1", { callDaemon: async command => {
      const url = new URL(command.path, "http://daemon.invalid");
      calls.push(url.pathname);
      expect(url.searchParams.get("scope")).toBe("show-rejected");
      if (url.pathname === "/thoughts/root-1") return json(selected);
      if (url.pathname === "/thoughts/root-1/connections") return json(links);
      if (url.pathname === "/thoughts/root-1/children" || url.pathname === "/thoughts/root-1/responses") return json([]);
      const id = url.pathname.slice("/thoughts/".length);
      if (!ids.includes(id)) throw new Error("unexpected read");
      active++; maximum = Math.max(maximum, active);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return json({ ...source, id }); }
      finally { active--; }
    } });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.parent).toEqual({ id: ids[0], thought: { ...source, id: ids[0] } });
    expect(view.sources).toEqual(ids.map(id => ({ id, thought: { ...source, id } })));
    expect(view.connections).toEqual(links.map((connection, i) => ({ connection, thought: { ...source, id: ids[i] } })));
    for (const id of ids) expect(calls.filter(path => path === `/thoughts/${id}`)).toHaveLength(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });
  for (const failingPath of ["/thoughts/root-1/children", "/thoughts/root-1/connections", "/thoughts/root-1/responses", "/thoughts/parent-1", "/thoughts/source-1"] as const) {
    test(`a failed ${failingPath} read is an error, not empty or unavailable context`, async () => {
      const response = await handleIdeaRead(req("?scope=normal&part=view"), "root-1", { callDaemon: async command => {
        const path = new URL(command.path, "http://daemon.invalid").pathname;
        if (path === failingPath) return new Response("private upstream content", { status: 500 });
        if (path === "/thoughts/root-1") return json(root);
        if (path === "/thoughts/root-1/connections" || path === "/thoughts/root-1/children" || path === "/thoughts/root-1/responses") return json([]);
        if (path === "/thoughts/parent-1") return json(parent);
        if (path === "/thoughts/source-1") return json(source);
        return new Response(null, { status: 404 });
      } });
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("private upstream content");
    });
  }
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
  test("decodes imported source thoughts without extending title or connection attribution", async () => {
    const imported = { ...root, author: "source", kind: "imported-original", origin: "markdown-import", parentId: null, sourceIds: [] } as const;
    expect(validThought(imported)).toBe(true);
    expect(validThought({ ...imported, titleAuthor: "source" })).toBe(false);
    expect(validConnection({ ...edge, proposedBy: "source" })).toBe(false);
    const value = { thought: imported, parent: null, children: [], sources: [], connections: [], responses: [], focusedResponse: null };
    const result = await readIdea("root-1", { scope: "normal", part: "view" }, { fetch: fakeFetch(async () => json(value)) });
    expect(result).toEqual({ kind: "view", value });
  });
  const command: IdeaCommand = { action: "reject-branch", thoughtId: "root-1", preview };
  const titleCommand: IdeaCommand = { action: "title", thoughtId: "root-1", title: "new" };
  const uncertain = { kind: "uncertain", message: "Outcome unconfirmed.", command: titleCommand } as const;
  for (const status of [404, 500]) {
    test(`read ${status} cancels an unread response body and preserves its safe result`, async () => {
      let cancels = 0;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
      const response = new Response(body, { status });
      const result = await readIdea("root-1", { scope: "normal", part: "view" }, { fetch: fakeFetch(async () => response) });
      expect(result).toEqual(status === 404 ? { kind: "unavailable", message: "Idea unavailable." } : { kind: "error", message: "Idea unavailable." });
      expect(cancels).toBe(1);
      expect(response.bodyUsed).toBe(true);
    });
  }
  for (const [status, input, expected] of [
    ...[400, 401, 403, 404].map(status => [status, titleCommand, { kind: "not-applied", message: "The change was not applied.", command: titleCommand }] as const),
    [409, command, { kind: "conflict", message: "The branch changed; review a new preview.", command }],
    [409, titleCommand, uncertain],
    [500, titleCommand, uncertain],
  ] as const) {
    test(`command ${input.action} ${status} cancels an unread body and preserves its safe result`, async () => {
      let cancels = 0;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
      const response = new Response(body, { status });
      const result = await commandIdea(input, { fetch: fakeFetch(async () => response) });
      expect(result).toEqual(expected);
      expect(cancels).toBe(1);
      expect(response.bodyUsed).toBe(true);
    });
  }
  for (const mode of ["throw", "reject", "pending"] as const) {
    for (const operation of ["read", "command"] as const) {
      test(`${operation} keeps its result when body cancellation ${mode}s`, async () => {
        let cancels = 0;
        const body = new ReadableStream<Uint8Array>();
        Object.defineProperty(body, "cancel", { value: () => {
          cancels++;
          if (mode === "throw") throw new Error("private cancellation failure");
          if (mode === "reject") return Promise.reject(new Error("private cancellation failure"));
          return new Promise<void>(() => {});
        } });
        const response = new Response(body, { status: 500 });
        const fetch = fakeFetch(async () => response);
        const pending = operation === "read"
          ? readIdea("root-1", { scope: "normal", part: "view" }, { fetch })
          : commandIdea(titleCommand, { fetch });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cancellation delayed the result")), 500); })]);
          expect(result).toEqual(operation === "read" ? { kind: "error", message: "Idea unavailable." } : uncertain);
          expect(cancels).toBe(1);
        } finally { clearTimeout(timer); }
      });
    }
  }
  test("successful title JSON and malformed read and title JSON consume their bodies", async () => {
    const titleResponse = json({ ...root, title: "new" });
    expect(await commandIdea(titleCommand, { fetch: fakeFetch(async () => titleResponse) })).toEqual({ kind: "applied", thought: { ...root, title: "new" } });
    expect(titleResponse.bodyUsed).toBe(true);
    const readResponse = new Response("{", { status: 200 });
    expect(await readIdea("root-1", { scope: "normal", part: "view" }, { fetch: fakeFetch(async () => readResponse) })).toEqual({ kind: "error", message: "Idea unavailable." });
    expect(readResponse.bodyUsed).toBe(true);
    const malformedTitle = new Response("{", { status: 200 });
    expect(await commandIdea(titleCommand, { fetch: fakeFetch(async () => malformedTitle) })).toEqual(uncertain);
    expect(malformedTitle.bodyUsed).toBe(true);
  });
  test("view decoding retains direct context and rejects a missing or malformed projection", async () => {
    const value = { thought: root, parent: { id: "parent-1", thought: parent }, children: [child], sources: [{ id: "source-1", thought: source }, { id: "missing-source", thought: null }], connections: [{ connection: edge, thought: source }], responses: [reply], focusedResponse: reply };
    const read = (body: unknown) => readIdea("root-1", { scope: "normal", part: "view" }, { fetch: fakeFetch(async () => json(body)) });
    expect(await read(value)).toEqual({ kind: "view", value });
    const { parent: _parent, ...missingParent } = value;
    expect((await read(missingParent)).kind).toBe("error");
    expect((await read({ ...value, children: [{ ...child, parentId: "other" }] })).kind).toBe("error");
    expect((await read({ ...value, sources: [{ id: "source-1", thought: { ...source, id: "foreign" } }] })).kind).toBe("error");
  });
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
