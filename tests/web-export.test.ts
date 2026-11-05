import { describe, expect, test } from "bun:test";
import { admitExport, downloadBytes, observeExport, readExportThought, readReport, requestSimple, stopExport } from "../apps/web/src/features/export/request";
import type { ExportRun } from "../apps/web/src/features/export/types";
import { handleExportAdmission, handleExportArtifact, handleExportRun, handleExportThought, handleSimpleExport } from "../apps/web/src/server/export";
import type { DaemonRequest } from "../apps/web/src/server/daemon";
import type { IdeaThought } from "../apps/web/src/features/idea/types";

const run: ExportRun = { id: "run-1", kind: "export", status: "queued", confirmedThoughtIds: [], responseId: null };
const completed: ExportRun = { ...run, status: "completed" };
const root = { id: "root-1", text: "Owned thought", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: null, sourceIds: [] } satisfies IdeaThought;
const markdown = "# Café 雪\r\n\r\nExact source words.\nLast line\r\n";
const bytes = new TextEncoder().encode(markdown);
const md = () => new Response(bytes.slice(), { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const request = (path: string, method = "GET", body?: string) => new Request(`http://127.0.0.1:3000${path}`, { method, ...(body !== undefined ? { body, headers: { "content-type": "application/json" } } : {}) });
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

describe("Simple export server boundary", () => {
  for (const input of [null, {}, { rootId: "root-1", count: 0, traversal: "breadth" }, { rootId: "root-1", count: 1.5, traversal: "depth" }, { rootId: "root-1", count: -1, traversal: "depth" }, { rootId: "root-1", count: 1, traversal: "random" }, { rootId: "root-1", count: 1, traversal: "depth", extra: true }]) {
    test(`rejects invalid input without a daemon call ${JSON.stringify(input)}`, async () => {
      let calls = 0;
      const response = await handleSimpleExport(request("/api/export/simple", "POST", JSON.stringify(input)), { callDaemon: async () => { calls++; return md(); } });
      expect(response.status).toBe(400); expect(calls).toBe(0);
    });
  }
  test("rejects query parameters and malformed JSON before transport", async () => {
    let calls = 0;
    const deps = { callDaemon: async () => { calls++; return md(); } };
    expect((await handleSimpleExport(request("/api/export/simple?extra=1", "POST", '{}'), deps)).status).toBe(400);
    expect((await handleSimpleExport(request("/api/export/simple", "POST", '{'), deps)).status).toBe(400);
    expect(calls).toBe(0);
  });
  for (const traversal of ["breadth", "depth"] as const) {
    test(`forwards exact ${traversal} request without an invented count maximum`, async () => {
      const input = { rootId: "root-1", count: 1000000, traversal };
      const calls: DaemonRequest[] = [];
      const response = await handleSimpleExport(request("/api/export/simple", "POST", JSON.stringify(input)), { callDaemon: async value => { calls.push(value); return md(); } });
      expect(calls).toEqual([{ method: "POST", path: "/exports/simple", body: JSON.stringify(input) }]);
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toMatch(/^text\/markdown/i);
      expect(response.headers.get("cache-control")).toMatch(/no-store/i);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    });
  }
  for (const status of [400, 404]) {
    test(`preserves known Simple rejection ${status} without leaking upstream body`, async () => {
      const response = await handleSimpleExport(request("/api/export/simple", "POST", JSON.stringify({ rootId: "root-1", count: 1, traversal: "breadth" })), { callDaemon: async () => new Response("owned-secret", { status }) });
      expect(response.status).toBe(status); expect(await response.text()).not.toContain("owned-secret");
    });
  }
});

describe("Agentic export server boundary", () => {
  test("rejects query parameters before admission", async () => {
    let calls = 0;
    const response = await handleExportAdmission(request("/api/export/agentic?extra=1", "POST", JSON.stringify({ request: "owned", effort: "quick" })), { callDaemon: async () => { calls++; return json({ run }, 201); } });
    expect(response.status).toBe(400); expect(calls).toBe(0);
  });
  for (const input of [null, {}, { request: " " }, { request: 5 }, { request: "valid", effort: "extreme" }, { request: "valid", effort: "quick", rootId: "root-1" }, { request: "valid", effort: "quick", id: "forged" }]) {
    test(`rejects non-contract admission ${JSON.stringify(input)}`, async () => {
      let calls = 0;
      const response = await handleExportAdmission(request("/api/export/agentic", "POST", JSON.stringify(input)), { callDaemon: async () => { calls++; return json({ run }, 201); } });
      expect(response.status).toBe(400); expect(calls).toBe(0);
    });
  }
  test("independent admission forwards request/effort and accepts export with no thoughts or response", async () => {
    const input = { request: "  owned question\n", effort: "thorough" };
    const calls: DaemonRequest[] = [];
    const response = await handleExportAdmission(request("/api/export/agentic", "POST", JSON.stringify(input)), { callDaemon: async value => { calls.push(value); return json({ run }, 201); } });
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ run });
    expect(calls).toEqual([{ method: "POST", path: "/exports/agentic", body: JSON.stringify(input) }]);
  });
  for (const bad of [{ ...run, kind: "agentic-export" }, { ...run, kind: "evolve" }, { ...run, id: "" }, { ...run, status: "invented" }]) {
    test(`rejects malformed admission ${JSON.stringify(bad)}`, async () => {
      const response = await handleExportAdmission(request("/api/export/agentic", "POST", JSON.stringify({ request: "owned", effort: "quick" })), { callDaemon: async () => json({ run: bad }, 201) });
      expect(response.status).not.toBe(201);
    });
  }
  test("503 is definite not-started, while transport failures are sanitized", async () => {
    const input = request("/api/export/agentic", "POST", JSON.stringify({ request: "owned", effort: "standard" }));
    const denied = await handleExportAdmission(input, { callDaemon: async () => new Response("owned-secret", { status: 503 }) });
    expect(denied.status).toBe(503); expect(await denied.text()).not.toContain("owned-secret");
    const uncertain = await handleExportAdmission(request("/api/export/agentic", "POST", JSON.stringify({ request: "owned", effort: "standard" })), { callDaemon: async () => { throw new Error("owned-secret"); } });
    expect([201, 400, 404, 503]).not.toContain(uncertain.status); expect(await uncertain.text()).not.toContain("owned-secret");
  });
});

describe("Export run, artifact and root server reads", () => {
  for (const status of ["queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"] as const) {
    test(`returns canonical ${status} for the known export run`, async () => {
      const calls: DaemonRequest[] = [];
      const value = { ...run, status };
      const response = await handleExportRun(request("/api/export/runs/run-1"), run.id, { callDaemon: async command => { calls.push(command); return json(value); } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
      expect(calls).toEqual([{ method: "GET", path: "/runs/run-1" }]);
    });
  }
  test("Stop forwards exactly {} and requires matching export identity", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleExportRun(request("/api/export/runs/run-1", "POST", "{}"), run.id, { callDaemon: async value => { calls.push(value); return json({ ...run, status: "interrupted" }); } });
    expect(response.status).toBe(200); expect(calls).toEqual([{ method: "POST", path: "/runs/run-1/stop", body: "{}" }]);
    const wrong = await handleExportRun(request("/api/export/runs/run-1"), run.id, { callDaemon: async () => json({ ...run, id: "other" }) });
    expect(wrong.status).not.toBe(200);
    const wrongKind = await handleExportRun(request("/api/export/runs/run-1"), run.id, { callDaemon: async () => json({ ...run, kind: "evolve" }) });
    expect(wrongKind.status).not.toBe(200);
    let invalidCalls = 0;
    const invalid = await handleExportRun(request("/api/export/runs/run-1", "POST", '{"extra":true}'), run.id, { callDaemon: async () => { invalidCalls++; return json(run); } });
    expect(invalid.status).toBe(400); expect(invalidCalls).toBe(0);
  });
  test("artifact 200 preserves bytes; 409 never supplies partial report", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleExportArtifact(request("/api/export/agentic/run-1"), run.id, { callDaemon: async value => { calls.push(value); return md(); } });
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    expect(calls).toEqual([{ method: "GET", path: "/exports/agentic/run-1" }]);
    const pending = await handleExportArtifact(request("/api/export/agentic/run-1"), run.id, { callDaemon: async () => new Response("owned partial report", { status: 409 }) });
    expect(pending.status).toBe(409); expect(await pending.text()).not.toContain("owned partial report");
    const missing = await handleExportArtifact(request("/api/export/agentic/run-1"), run.id, { callDaemon: async () => new Response("owned missing", { status: 404 }) });
    expect(missing.status).toBe(404); expect(await missing.text()).not.toContain("owned missing");
  });
  test("root/source read is fixed normal scope and rejects forged metadata", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleExportThought(request("/api/export/thoughts/root-1"), root.id, { callDaemon: async value => { calls.push(value); return json(root); } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(root);
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    const target = new URL(calls[0]?.path ?? "", "http://daemon.invalid");
    expect(target.pathname).toBe("/thoughts/root-1"); expect([null, "normal"]).toContain(target.searchParams.get("scope"));
    for (const invalid of [{ ...root, id: "other" }, { ...root, rejected: true }]) {
      const bad = await handleExportThought(request("/api/export/thoughts/root-1"), root.id, { callDaemon: async () => json(invalid) });
      expect(bad.status).not.toBe(200);
    }
    let count = 0;
    const invalidScope = await handleExportThought(request("/api/export/thoughts/root-1?scope=history"), root.id, { callDaemon: async () => { count++; return json(root); } });
    expect(invalidScope.status).toBe(400); expect(count).toBe(0);
  });
});

describe("Export client contracts", () => {
  test("Simple preview and download preserve the exact response bytes from one request", async () => {
    let calls = 0;
    const input = { rootId: "root-1", count: 3, traversal: "depth" as const };
    const result = await requestSimple(input, { fetch: fakeFetch(async (url, init) => {
      calls++; expect(String(url)).toBe("/api/export/simple"); expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(input); expect(init?.cache).toBe("no-store"); return md();
    }) });
    expect(result.kind).toBe("ready"); if (result.kind !== "ready") throw new Error("Expected artifact");
    expect(result.artifact.text).toBe(markdown); expect(result.artifact.bytes).toEqual(bytes);
    expect(downloadBytes(result.artifact)).toEqual(bytes); expect(calls).toBe(1);
  });
  for (const [status, kind] of [[400, "not-started"], [404, "not-started"], [503, "not-started"], [500, "uncertain"], [200, "uncertain"]] as const) {
    test(`Agentic admission ${status} is ${kind} without replay`, async () => {
      let calls = 0;
      const input = { request: "Owned question", effort: "quick" as const };
      const result = await admitExport(input, { fetch: fakeFetch(async () => { calls++; return new Response("owned-secret", { status }); }) });
      expect(calls).toBe(1); expect(result.kind).toBe(kind);
      if (result.kind === "admitted") throw new Error("Unexpected admission");
      expect(result.snapshot).toEqual(input); expect(result.message).not.toContain("owned-secret");
    });
  }
  test("admission snapshots input before awaiting and accepts canonical export receipt", async () => {
    const input = { request: "original question", effort: "quick" as const };
    let finish: (response: Response) => void = () => { throw new Error("fetch not called"); };
    let body = "";
    const pending = admitExport(input, { fetch: fakeFetch(async (url, init) => { expect(String(url)).toBe("/api/export/agentic"); body = String(init?.body); return new Promise<Response>(resolve => { finish = resolve; }); }) });
    input.request = "later edit"; finish(json({ run }, 201));
    expect(JSON.parse(body)).toEqual({ request: "original question", effort: "quick" });
    expect(await pending).toEqual({ kind: "admitted", run });
  });
  test("known-run observation and Stop retain prior run on failure", async () => {
    const observed = await observeExport(run, { fetch: fakeFetch(async url => { expect(String(url)).toBe("/api/export/runs/run-1"); return json(completed); }) });
    expect(observed).toEqual({ kind: "observed", run: completed });
    let calls = 0;
    const stopped = await stopExport(completed, { fetch: fakeFetch(async (url, init) => { calls++; expect(String(url)).toBe("/api/export/runs/run-1"); expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toEqual({}); throw new Error("owned-secret"); }) });
    expect(calls).toBe(1); expect(stopped.kind).toBe("unavailable"); expect(stopped.run).toEqual(completed);
  });
  test("status alone is not an artifact and noncompleted runs cannot trigger an artifact read", async () => {
    let calls = 0;
    const fetch = fakeFetch(async () => { calls++; return md(); });
    const result = await readReport(run, { fetch });
    expect(result.kind).not.toBe("ready"); expect(calls).toBe(0);
  });
  test("completed report still requires 200 Markdown and preserves its exact bytes", async () => {
    const pending = await readReport(completed, { fetch: fakeFetch(async () => new Response("owned partial", { status: 409 })) });
    expect(pending.kind).toBe("not-ready");
    let calls = 0;
    const result = await readReport(completed, { fetch: fakeFetch(async (url, init) => { calls++; expect(String(url)).toBe("/api/export/agentic/run-1"); expect(init?.cache).toBe("no-store"); return md(); }) });
    expect(result.kind).toBe("ready"); if (result.kind !== "ready") throw new Error("Expected report");
    expect(result.artifact.text).toBe(markdown); expect(downloadBytes(result.artifact)).toEqual(bytes); expect(calls).toBe(1);
  });
  test("normal source/root read does not expose a wrong or rejected record", async () => {
    for (const invalid of [{ ...root, id: "other" }, { ...root, rejected: true }]) {
      expect(await readExportThought("root-1", { fetch: fakeFetch(async () => json(invalid)) })).toBeNull();
    }
    expect(await readExportThought("root-1", { fetch: fakeFetch(async url => { expect(String(url)).toBe("/api/export/thoughts/root-1"); return json(root); }) })).toEqual(root);
  });
});

describe("Export response body cleanup", () => {
  const input = { rootId: "root-1", count: 3, traversal: "breadth" as const };
  const agentic = { request: "owned request", effort: "quick" as const };
  type Outcome = { readonly kind: string } | null;
  type Case = { readonly label: string; readonly status: number; readonly contentType?: string; readonly expected: string | null; readonly invoke: (response: Response) => Promise<Outcome> };
  const cases: Case[] = [
    ...[404, 502, 202].map(status => ({ label: "thought", status, expected: null, invoke: (response: Response) => readExportThought("root-1", { fetch: fakeFetch(async () => response) }) })),
    ...([ [409, "not-ready"], [404, "unavailable"], [502, "error"], [202, "error"] ] as const).map(([status, expected]) => ({ label: "Simple", status, expected, invoke: (response: Response) => requestSimple(input, { fetch: fakeFetch(async () => response) }) })),
    { label: "Simple wrong content type", status: 200, contentType: "application/json", expected: "error", invoke: response => requestSimple(input, { fetch: fakeFetch(async () => response) }) },
    ...([ [400, "not-started"], [401, "not-started"], [403, "not-started"], [404, "not-started"], [503, "not-started"], [502, "uncertain"], [202, "uncertain"] ] as const).map(([status, expected]) => ({ label: "admission", status, expected, invoke: (response: Response) => admitExport(agentic, { fetch: fakeFetch(async () => response) }) })),
    ...[404, 502, 202].flatMap(status => [
      { label: "observation", status, expected: "unavailable", invoke: (response: Response) => observeExport(run, { fetch: fakeFetch(async () => response) }) },
      { label: "Stop", status, expected: "unavailable", invoke: (response: Response) => stopExport(run, { fetch: fakeFetch(async () => response) }) },
    ]),
    ...([ [409, "not-ready"], [404, "unavailable"], [502, "error"], [202, "error"] ] as const).map(([status, expected]) => ({ label: "report", status, expected, invoke: (response: Response) => readReport(completed, { fetch: fakeFetch(async () => response) }) })),
    { label: "report wrong content type", status: 200, contentType: "text/html", expected: "error", invoke: response => readReport(completed, { fetch: fakeFetch(async () => response) }) },
  ];
  function tracked(status: number, contentType = "application/json", rejectCancel = false) {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() { cancellations++; if (rejectCancel) return Promise.reject(new Error("owned cleanup failure")); },
    }, { highWaterMark: 0 });
    return { response: new Response(stream, { status, headers: { "content-type": contentType } }), cancellations: () => cancellations };
  }
  for (const item of cases) {
    test(`${item.label} ${item.status} cancels its abandoned body`, async () => {
      const owned = tracked(item.status, item.contentType);
      const result = await item.invoke(owned.response);
      expect(result === null ? null : result.kind).toBe(item.expected);
      expect(owned.cancellations()).toBe(1);
    });
  }
  for (const label of ["thought", "Simple wrong content type", "admission", "observation", "Stop", "report"] as const) {
    const item = cases.find(value => value.label === label);
    if (!item) throw new Error(`Missing cleanup case: ${label}`);
    test(`${label} preserves its classified result when cancellation rejects`, async () => {
      const owned = tracked(item.status, item.contentType, true);
      const result = await item.invoke(owned.response);
      expect(result === null ? null : result.kind).toBe(item.expected);
      expect(owned.cancellations()).toBe(1);
    });
  }
  test("successful JSON and Markdown bodies are consumed rather than abandoned", async () => {
    const cases = [
      { body: JSON.stringify(root), type: "application/json", status: 200, invoke: (response: Response) => readExportThought("root-1", { fetch: fakeFetch(async () => response) }) },
      { body: markdown, type: "text/markdown", status: 200, invoke: (response: Response) => requestSimple(input, { fetch: fakeFetch(async () => response) }) },
      { body: JSON.stringify({ run }), type: "application/json", status: 201, invoke: (response: Response) => admitExport(agentic, { fetch: fakeFetch(async () => response) }) },
      { body: JSON.stringify(run), type: "application/json", status: 200, invoke: (response: Response) => observeExport(run, { fetch: fakeFetch(async () => response) }) },
      { body: JSON.stringify(run), type: "application/json", status: 200, invoke: (response: Response) => stopExport(run, { fetch: fakeFetch(async () => response) }) },
      { body: markdown, type: "text/markdown", status: 200, invoke: (response: Response) => readReport(completed, { fetch: fakeFetch(async () => response) }) },
    ];
    for (const item of cases) {
      let cancellations = 0;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(item.body)); controller.close(); }, cancel() { cancellations++; } });
      const response = new Response(stream, { status: item.status, headers: { "content-type": item.type } });
      await item.invoke(response);
      expect(response.bodyUsed).toBe(true);
      expect(cancellations).toBe(0);
    }
  });
});
