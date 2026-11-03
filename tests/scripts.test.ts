import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runApi, type ApiDependencies, type HttpFetch } from "../scripts/api";
import { runDemo, type DemoDependencies } from "../scripts/demo";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";

const userToken = "user-test-0123456789-0123456789-ab";
const aiToken = "agent-test-0123456789-0123456789-a";
const env = { THOUGHTLOOM_DAEMON_URL: "http://127.0.0.1:3001", THOUGHTLOOM_USER_TOKEN: userToken, THOUGHTLOOM_AI_TOKEN: aiToken };

function apiFixture(fetcher: HttpFetch) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: ApiDependencies = { fetch: fetcher, stdout: value => out.push(value), stderr: value => err.push(value), timeoutMs: 50 };
  return { deps, out, err };
}

describe("api script", () => {
  test("sends selected credential and JSON to explicit loopback without following redirects", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fixture = apiFixture(async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ id: "created" }, { status: 201 });
    });
    expect(await runApi(["--role", "ai", "POST", "/thoughts/parent/developments", '{"text":"hello"}'], env, fixture.deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3001/thoughts/parent/developments");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${aiToken}`);
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toContain("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: "hello" });
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(fixture.out.join("\n")).toContain("201");
    expect(fixture.out.join("\n")).toContain('"created"');
    expect(fixture.err).toEqual([]);
    expect(JSON.stringify([fixture.out, fixture.err])).not.toContain(aiToken);
  });

  test("user role supports query paths with only its own configured credential", async () => {
    const captured: { authorization: string | null; requested: string }[] = [];
    const fixture = apiFixture(async (input, init) => {
      captured.push({ requested: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json([]);
    });
    expect(await runApi(["--role", "user", "GET", "/thoughts?scope=history"], { THOUGHTLOOM_DAEMON_URL: env.THOUGHTLOOM_DAEMON_URL, THOUGHTLOOM_USER_TOKEN: userToken }, fixture.deps)).toBe(0);
    expect(captured).toEqual([{ requested: "http://127.0.0.1:3001/thoughts?scope=history", authorization: `Bearer ${userToken}` }]);
  });

  test.each([
    { args: ["GET", "/thoughts"], environment: env, diagnostic: /role/i },
    { args: ["--role", "admin", "GET", "/thoughts"], environment: env, diagnostic: /role/i },
    { args: ["--role", "ai", "POST", "/thoughts", "{"], environment: env, diagnostic: /json/i },
    { args: ["--role", "user", "GET", "http://attacker.example/"], environment: env, diagnostic: /path/i },
    { args: ["--role", "user", "GET", "//attacker.example/"], environment: env, diagnostic: /path/i },
    { args: ["--role", "user", "GET", "/\\attacker.example/"], environment: env, diagnostic: /path/i },
    { args: ["--role", "user", "GET", "/thoughts"], environment: { ...env, THOUGHTLOOM_DAEMON_URL: "http://attacker.example:3001" }, diagnostic: /url|loopback/i },
    { args: ["--role", "user", "GET", "/thoughts"], environment: { ...env, THOUGHTLOOM_DAEMON_URL: "http://user:password@127.0.0.1:3001" }, diagnostic: /url|credential/i },
    { args: ["--role", "user", "GET", "/thoughts"], environment: { ...env, THOUGHTLOOM_DAEMON_URL: "file:///tmp/db" }, diagnostic: /url|protocol/i },
    { args: ["--role", "user", "GET", "/thoughts"], environment: { ...env, THOUGHTLOOM_DAEMON_URL: "" }, diagnostic: /url/i },
    { args: ["--role", "ai", "GET", "/thoughts"], environment: { ...env, THOUGHTLOOM_AI_TOKEN: "" }, diagnostic: /token/i },
  ])("invalid arguments or config fail before network: %j", async ({ args, environment, diagnostic }) => {
    let called = false;
    const fixture = apiFixture(async () => { called = true; return Response.json({}); });
    expect(await runApi(args, environment, fixture.deps)).not.toBe(0);
    expect(called).toBe(false);
    expect(fixture.err.join(" ")).toMatch(diagnostic);
    expect(JSON.stringify([fixture.out, fixture.err])).not.toContain(userToken);
  });

  test("HTTP and transport failures return nonzero without exposing credentials or internal errors", async () => {
    const http = apiFixture(async () => Response.json({ error: "Not found" }, { status: 404 }));
    expect(await runApi(["--role", "user", "GET", "/thoughts/missing"], env, http.deps)).not.toBe(0);
    expect([...http.out, ...http.err].join(" ")).toContain("404");
    const failed = apiFixture(async () => { throw new Error(`transport ${userToken} internal detail`); });
    expect(await runApi(["--role", "user", "GET", "/thoughts"], env, failed.deps)).not.toBe(0);
    expect(failed.err.join(" ")).toMatch(/request|network|daemon|connect/i);
    expect(JSON.stringify([failed.out, failed.err])).not.toContain(userToken);
    expect(JSON.stringify([failed.out, failed.err])).not.toContain("internal detail");
  });

  test("plain-text HTTP 404 reports its status without echoing the response body", async () => {
    const sentinel = "sensitive plain response content";
    const fixture = apiFixture(async () => new Response(sentinel, { status: 404, headers: { "content-type": "text/plain" } }));
    expect(await runApi(["--role", "user", "GET", "/typo"], env, fixture.deps)).not.toBe(0);
    const output = [...fixture.out, ...fixture.err].join("\n");
    expect(output).toContain("404");
    expect(output).not.toContain(sentinel);
  });

  test("successful Markdown export prints status and exact Markdown rather than parsing JSON", async () => {
    const markdown = "# A title\n\n- source: note-1\n\nOriginal *thinking*.\n";
    const fixture = apiFixture(async () => new Response(markdown, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } }));
    expect(await runApi(["--role", "user", "POST", "/exports/simple", '{"rootId":"note-1","count":1,"traversal":"depth"}'], env, fixture.deps)).toBe(0);
    expect(fixture.out).toEqual([`200\n${markdown}`]);
    expect(fixture.err).toEqual([]);
  });

  test("Markdown output redacts configured tokens; malformed JSON remains an error", async () => {
    const markdown = apiFixture(async () => new Response(`# Retained\n${userToken}`, { headers: { "content-type": "text/markdown" } }));
    expect(await runApi(["--role", "user", "POST", "/exports/simple", "{}"], env, markdown.deps)).toBe(0);
    expect(markdown.out.join("\n")).toContain("[redacted]");
    expect(JSON.stringify([markdown.out, markdown.err])).not.toContain(userToken);
    const invalid = apiFixture(async () => new Response("{broken", { status: 200, headers: { "content-type": "application/json" } }));
    expect(await runApi(["--role", "user", "GET", "/thoughts"], env, invalid.deps)).not.toBe(0);
    expect(invalid.err.join(" ")).toMatch(/200.*invalid json/i);
    expect(invalid.out).toEqual([]);
  });

  test("bounds both stalled fetch and stalled response body", async () => {
    const stalled = apiFixture(() => new Promise<Response>(() => {}));
    expect(await runApi(["--role", "user", "GET", "/thoughts"], env, stalled.deps)).not.toBe(0);
    expect(stalled.err.join(" ")).toMatch(/timeout|timed out/i);
    const body = apiFixture(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } })));
    expect(await runApi(["--role", "user", "GET", "/thoughts"], env, body.deps)).not.toBe(0);
    expect(body.err.join(" ")).toMatch(/timeout|timed out/i);
    const markdown = apiFixture(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("# partial")); } }), { headers: { "content-type": "text/markdown" } }));
    expect(await runApi(["--role", "user", "POST", "/exports/simple", "{}"], env, markdown.deps)).not.toBe(0);
    expect(markdown.err.join(" ")).toMatch(/timeout|timed out/i);
  }, 2000);
});

async function withRoot(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join("/tmp/opencode", "thoughtloom-script-test-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

describe("isolated demo", () => {
  test("walkthrough uses its own real HTTP daemon and cleans up after success", async () => {
    await withRoot(async root => {
      const output: string[] = [];
      const errors: string[] = [];
      const calls: { method: string; path: string; query: string; authorization: string | null; status: number; body: unknown; result: unknown; contentType: string }[] = [];
      const credentials: { user: string; ai: string }[] = [];
      const exportSnapshots: { before: unknown; after: unknown }[] = [];
      let daemon: RunningDaemon | undefined;
      let daemonUrl = "";
      const deps: DemoDependencies = {
        tempRoot: root, timeoutMs: 2000,
        start: async (config, logger) => {
          expect(config.port).toBe(0);
          expect(config.dbPath.startsWith(`${root}/`)).toBe(true);
          expect(config.credentials.user).not.toBe(config.credentials.ai);
          credentials.push(config.credentials);
          daemon = await startDaemon(config, logger);
          daemonUrl = daemon.url;
          return daemon;
        },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          expect(url.origin).toBe(new URL(daemonUrl).origin);
          const knowledge = async () => {
            const headers = { authorization: `Bearer ${credentials[0]?.user}` };
            const thoughts = await fetch(new URL("/thoughts?scope=history", daemonUrl), { headers, signal: AbortSignal.timeout(2000) });
            const connections = await fetch(new URL("/connections?scope=history", daemonUrl), { headers, signal: AbortSignal.timeout(2000) });
            expect(thoughts.status).toBe(200);
            expect(connections.status).toBe(200);
            return { thoughts: await thoughts.json(), connections: await connections.json() };
          };
          const before = url.pathname === "/exports/simple" ? await knowledge() : undefined;
          const response = await fetch(input, { ...init, signal: AbortSignal.timeout(2000) });
          const contentType = response.headers.get("content-type") ?? "";
          const result: unknown = response.status === 204 ? null : contentType.toLowerCase().startsWith("text/markdown") ? await response.clone().text() : await response.clone().json();
          if (before !== undefined) exportSnapshots.push({ before, after: await knowledge() });
          calls.push({ method: init?.method ?? "GET", path: url.pathname, query: url.search, authorization: new Headers(init?.headers).get("authorization"), status: response.status, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, result, contentType });
          return response;
        },
        stdout: value => output.push(value), stderr: value => errors.push(value),
      };
      try {
        expect(await runDemo(deps)).toBe(0);
        expect(errors).toEqual([]);
        const report = output.join("\n");
        expect(credentials).toHaveLength(1);
        for (const token of [credentials[0]?.user, credentials[0]?.ai]) {
          expect(typeof token).toBe("string");
          if (token === undefined) throw new Error("Demo did not supply credentials");
          expect(JSON.stringify([output, errors])).not.toContain(token);
        }
        for (const milestone of [/original/i, /contribution/i, /simulated.*ai/i, /sibling/i, /connection/i, /single.*reject/i, /active.*child/i, /preview/i, /branch.*reject/i, /partial.*restor/i, /(?:filtered.*search|search.*filter)/i, /(?:typo.*search|search.*typo)/i, /(?:markdown.*export|export.*markdown)/i]) expect(report).toMatch(milestone);
        const creates = calls.filter(call => call.method === "POST" && (call.path === "/thoughts" || /^\/thoughts\/[^/]+\/(contributions|developments)$/.test(call.path)) && call.status === 201);
        expect(creates.length).toBeGreaterThanOrEqual(5);
        expect(new Set(creates.map(call => call.authorization)).size).toBe(2);
        const capture = creates.find(call => call.path === "/thoughts");
        const captureBody = object(capture?.body);
        expect(typeof captureBody?.text).toBe("string");
        expect(Object.keys(captureBody ?? {}).every(key => ["text", "title"].includes(key))).toBe(true);
        const ids = new Set(creates.map(call => object(call.result)?.id));
        const filtered = calls.find(call => {
          const params = new URLSearchParams(call.query);
          return call.path === "/search" && call.method === "GET" && call.status === 200 && params.get("q") === "simulated" && params.getAll("author").includes("ai") && params.getAll("kind").includes("developing-idea");
        });
        const typo = calls.find(call => call.path === "/search" && call.method === "GET" && call.status === 200 && new URLSearchParams(call.query).get("q") === "simuluted");
        for (const call of [filtered, typo]) {
          expect(call).toBeDefined();
          const page = object(call?.result);
          expect(Array.isArray(page?.results)).toBe(true);
          if (!Array.isArray(page?.results)) throw new Error("Expected search results");
          expect(page.results.some(item => { const hit = object(item); return hit?.kind === "thought" && ids.has(hit.id) && typeof hit.text === "string" && /simulated ai development/i.test(hit.text); })).toBe(true);
        }
        const exported = calls.find(call => call.path === "/exports/simple" && call.method === "POST" && call.status === 200);
        expect(exported?.contentType).toMatch(/^text\/markdown\b/i);
        expect(exported?.authorization).toBe(`Bearer ${credentials[0]?.user}`);
        const exportBody = object(exported?.body);
        expect(typeof exportBody?.rootId).toBe("string");
        expect(ids.has(exportBody?.rootId)).toBe(true);
        const exportRoot = creates.map(call => object(call.result)).find(item => item?.id === exportBody?.rootId);
        expect(typeof exported?.result).toBe("string");
        if (typeof exported?.result !== "string" || typeof exportRoot?.id !== "string" || typeof exportRoot.text !== "string") throw new Error("Expected exported root and Markdown");
        expect(exported.result).toContain(exportRoot.id);
        expect(exported.result).toContain(exportRoot.text);
        expect(exportSnapshots).toHaveLength(1);
        expect(exportSnapshots[0]?.after).toEqual(exportSnapshots[0]?.before);
        for (const call of creates.filter(item => item.path !== "/thoughts")) {
          const body = object(call.body);
          expect(typeof body?.text).toBe("string");
          expect(Object.keys(body ?? {}).every(key => ["text", "title", "sourceIds"].includes(key))).toBe(true);
          expect(ids.has(call.path.split("/")[2])).toBe(true);
          expect(call.authorization).toBe(call.path.endsWith("/developments") ? `Bearer ${credentials[0]?.ai}` : `Bearer ${credentials[0]?.user}`);
        }
        expect(calls.some(call => call.path === "/connections" && call.method === "POST" && call.status === 201)).toBe(true);
        expect(calls.some(call => call.path.endsWith("/branch/preview") && call.status === 200)).toBe(true);
        expect(calls.some(call => call.path.endsWith("/branch/reject") && call.status === 204)).toBe(true);
        expect(calls.some(call => call.path.endsWith("/branch/restore") && call.status === 204)).toBe(true);
        expect(calls.some(call => call.method === "GET" && call.query.includes("scope=history") && call.status === 200)).toBe(true);
        expect(calls.some(call => call.method === "GET" && call.path.startsWith("/thoughts/") && call.status === 404)).toBe(true);
        expect(calls.some(call => call.method === "POST" && call.path.startsWith("/connections/") && call.path.endsWith("/reject") && call.status === 204)).toBe(true);
        expect(calls.some(call => call.method === "GET" && call.path.startsWith("/connections/") && call.status === 404)).toBe(true);
        const singleIndex = calls.findIndex(call => call.method === "POST" && /^\/thoughts\/[^/]+\/reject$/.test(call.path) && call.status === 204);
        const branchIndex = calls.findIndex(call => call.method === "POST" && call.path.endsWith("/branch/reject") && call.status === 204);
        const restoreIndex = calls.findIndex(call => call.method === "POST" && call.path.endsWith("/branch/restore") && call.status === 204);
        expect(singleIndex).toBeGreaterThanOrEqual(0);
        expect(branchIndex).toBeGreaterThan(singleIndex);
        expect(restoreIndex).toBeGreaterThan(branchIndex);
        const rejectedId = calls[singleIndex]?.path.split("/")[2];
        const child = creates.map(call => object(call.result)).find(item => item?.parentId === rejectedId);
        expect(typeof child?.id).toBe("string");
        if (!child || typeof child.id !== "string" || !rejectedId) throw new Error("Missing rejected parent or child creation");
        const aiAuth = `Bearer ${credentials[0]?.ai}`;
        const interim = calls.slice(singleIndex + 1, branchIndex);
        expect(interim.some(call => call.method === "GET" && call.path === `/thoughts/${rejectedId}` && call.authorization === aiAuth && call.status === 404)).toBe(true);
        const activeChild = interim.find(call => call.method === "GET" && call.path === `/thoughts/${child.id}` && call.authorization === aiAuth && call.status === 200);
        const visible = object(activeChild?.result);
        expect(visible?.id).toBe(child.id);
        expect(visible?.parentId).toBeNull();
        expect(Array.isArray(visible?.sourceIds)).toBe(true);
        if (!Array.isArray(visible?.sourceIds)) throw new Error("Missing visible child provenance");
        expect(visible.sourceIds).not.toContain(rejectedId);
        const restoredId = calls[restoreIndex]?.path.split("/")[2];
        const branchRoot = calls[branchIndex]?.path.split("/")[2];
        expect(restoredId).not.toBe(branchRoot);
        const afterward = calls.slice(restoreIndex + 1);
        const restored = afterward.find(call => call.method === "GET" && call.path === `/thoughts/${restoredId}` && call.authorization === aiAuth && call.status === 200);
        expect(object(restored?.result)?.id).toBe(restoredId);
        expect(afterward.some(call => call.method === "GET" && call.path === `/thoughts/${branchRoot}` && call.authorization === aiAuth && call.status === 404)).toBe(true);
        const linkReject = calls.find(call => call.method === "POST" && /^\/connections\/[^/]+\/reject$/.test(call.path) && call.status === 204);
        const linkId = linkReject?.path.split("/")[2];
        expect(typeof linkId).toBe("string");
        expect(afterward.some(call => call.method === "GET" && call.path === `/connections/${linkId}` && call.authorization === aiAuth && call.status === 404)).toBe(true);
        expect(await readdir(root)).toEqual([]);
        await expect(fetch(daemonUrl, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      } finally { if (daemon) await Promise.race([daemon.stop(), Bun.sleep(2000).then(() => { throw new Error("daemon cleanup timed out"); })]); }
    });
  }, 15000);

  test("a scenario request failure reports failure and cleans up owned daemon and directory", async () => {
    await withRoot(async root => {
      let daemon: RunningDaemon | undefined;
      let daemonUrl = "";
      const errors: string[] = [];
      const deps: DemoDependencies = {
        tempRoot: root, timeoutMs: 1000,
        start: async (config, logger) => { daemon = await startDaemon(config, logger); daemonUrl = daemon.url; return daemon; },
        fetch: async () => Response.json({ error: "fixture failure" }, { status: 500 }),
        stdout: () => {}, stderr: message => errors.push(message),
      };
      try {
        expect(await runDemo(deps)).not.toBe(0);
        expect(errors.join(" ")).toMatch(/failed|error|500/i);
        expect(daemonUrl).not.toBe("");
        expect(await readdir(root)).toEqual([]);
        await expect(fetch(daemonUrl, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      } finally { if (daemon) await Promise.race([daemon.stop(), Bun.sleep(2000).then(() => { throw new Error("daemon cleanup timed out"); })]); }
    });
  }, 10000);
});
