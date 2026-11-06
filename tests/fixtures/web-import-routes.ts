import { strict as assert } from "node:assert";
import * as batches from "../../apps/web/src/app/api/imports/markdown/route";
import * as batch from "../../apps/web/src/app/api/imports/markdown/[id]/route";
import * as files from "../../apps/web/src/app/api/imports/markdown/[id]/files/route";
import * as file from "../../apps/web/src/app/api/imports/markdown/[id]/files/[fileId]/route";
import * as seal from "../../apps/web/src/app/api/imports/markdown/[id]/seal/route";
import * as namespaces from "../../apps/web/src/app/api/imports/namespaces/route";
import * as run from "../../apps/web/src/app/api/imports/runs/[id]/route";
import * as stop from "../../apps/web/src/app/api/imports/runs/[id]/stop/route";
import * as sources from "../../apps/web/src/app/api/imports/sources/route";
import * as source from "../../apps/web/src/app/api/imports/sources/[id]/route";
import * as parts from "../../apps/web/src/app/api/imports/sources/[id]/parts/route";
import * as raw from "../../apps/web/src/app/api/imports/sources/[id]/raw/route";

type Route = Record<string, unknown>;
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const calls: Request[] = [];
const batchReceipt = { id: "batch-1", namespaceId: "loose", createdAt: "2032-01-01T00:00:00Z", sealedAt: null, state: "open", counts: { admitted: 1, pending: 1, imported: 0, skippedIdentical: 0, skippedChanged: 0, failed: 0, interrupted: 0 } };
const fileReceipt = { id: "file-1", importId: "batch-1", position: 1, relativePath: "a.md", byteLength: new TextEncoder().encode("owned bytes").length, createdAt: "2032-01-01T00:00:00Z", state: "queued", runId: "run-1", documentId: null, thoughtCount: null, segmentation: null, error: null };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  calls.push(request);
  const url = new URL(request.url);
  if (url.pathname.endsWith("/raw")) return new Response("owned raw source");
  if (url.pathname.startsWith("/runs/")) return Response.json({ id: "run-1", kind: "import", status: "uncertain", importId: "batch-1", fileId: "file-1" });
  if (url.pathname === "/imports/markdown" && request.method === "POST") return Response.json({ import: batchReceipt }, { status: 201 });
  if (url.pathname === "/imports/markdown" && request.method === "GET") return Response.json({ items: [batchReceipt], nextCursor: null });
  if (url.pathname === "/imports/markdown/batch-1/files" && request.method === "POST") return Response.json({ file: fileReceipt }, { status: 202 });
  if (url.pathname === "/imports/markdown/batch-1/files" && request.method === "GET") return Response.json({ items: [fileReceipt], nextCursor: null });
  if (url.pathname === "/imports/markdown/batch-1/files/file-1") return Response.json({ file: fileReceipt });
  if (url.pathname === "/imports/markdown/batch-1") return Response.json({ import: batchReceipt });
  if (url.pathname === "/imports/markdown/batch-1/seal") return Response.json({ import: { ...batchReceipt, sealedAt: "2032-01-02T00:00:00Z", state: "processing" } });
  return Response.json({});
}) as typeof fetch;

const cases: Array<{ route: Route; method: "GET" | "POST"; browser: string; upstream: string; params?: Record<string, string>; upload?: boolean }> = [
  { route: batches, method: "GET", browser: "/markdown?limit=3", upstream: "/imports/markdown?limit=3" },
  { route: batches, method: "POST", browser: "/markdown", upstream: "/imports/markdown" },
  { route: batch, method: "GET", browser: "/markdown/batch-1", upstream: "/imports/markdown/batch-1", params: { id: "batch-1" } },
  { route: files, method: "GET", browser: "/markdown/batch-1/files", upstream: "/imports/markdown/batch-1/files", params: { id: "batch-1" } },
  { route: files, method: "POST", browser: "/markdown/batch-1/files", upstream: "/imports/markdown/batch-1/files", params: { id: "batch-1" }, upload: true },
  { route: file, method: "GET", browser: "/markdown/batch-1/files/file-1", upstream: "/imports/markdown/batch-1/files/file-1", params: { id: "batch-1", fileId: "file-1" } },
  { route: seal, method: "POST", browser: "/markdown/batch-1/seal", upstream: "/imports/markdown/batch-1/seal", params: { id: "batch-1" } },
  { route: namespaces, method: "GET", browser: "/namespaces", upstream: "/import-namespaces" },
  { route: run, method: "GET", browser: "/runs/run-1", upstream: "/runs/run-1", params: { id: "run-1" } },
  { route: stop, method: "POST", browser: "/runs/run-1/stop", upstream: "/runs/run-1/stop", params: { id: "run-1" } },
  { route: sources, method: "GET", browser: "/sources?limit=3", upstream: "/import-sources?scope=history&limit=3" },
  { route: source, method: "GET", browser: "/sources/source-1", upstream: "/import-sources/source-1?scope=history", params: { id: "source-1" } },
  { route: parts, method: "GET", browser: "/sources/source-1/parts", upstream: "/import-sources/source-1/parts?scope=history", params: { id: "source-1" } },
  { route: raw, method: "GET", browser: "/sources/source-1/raw", upstream: "/import-sources/source-1/raw?scope=history", params: { id: "source-1" } },
];

for (const route of new Set(cases.map(item => item.route))) {
  const expected = cases.filter(item => item.route === route).map(item => item.method).sort();
  assert.deepEqual(["GET", "POST", "PUT", "PATCH", "DELETE"].filter(method => typeof route[method] === "function").sort(), expected);
}

for (const item of cases) {
  const handler = item.route[item.method] as Handler;
  assert.equal(typeof handler, "function", `${item.browser} exports ${item.method}`);
  const headers = new Headers({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", authorization: "Bearer browser-secret", cookie: "browser-cookie" });
  let body: BodyInit | undefined;
  if (item.method === "POST") {
    if (item.upload) {
      const form = new FormData();
      form.set("metadata", JSON.stringify({ relativePath: "a.md" }));
      form.set("file", new File(["owned bytes"], "a.md"));
      body = form;
    } else { headers.set("content-type", "application/json"); body = "{}"; }
    if (item.upload || item.route === batches) headers.set("idempotency-key", "owned-key");
  }
  const context = { params: Promise.resolve(item.params ?? {}) };
  const makeRequest = () => new Request(`http://127.0.0.1:3000/api/imports${item.browser}`, { method: item.method, headers, body });
  const before = calls.length;
  const response = await handler(makeRequest(), context);
  assert.equal(response.status, item.upload ? 202 : item.route === batches && item.method === "POST" ? 201 : 200, item.browser);
  const expectedCalls = item.route === stop ? 2 : 1;
  assert.equal(calls.length, before + expectedCalls);
  if (item.route === stop) {
    const checked = calls[before];
    assert.ok(checked);
    assert.equal(checked.method, "GET");
    assert.equal(new URL(checked.url).pathname, "/runs/run-1");
    assert.equal(checked.headers.get("authorization"), "Bearer owned-route-token");
  }
  const sent = calls[before + expectedCalls - 1];
  assert.ok(sent);
  assert.equal(`${new URL(sent.url).pathname}${new URL(sent.url).search}`, item.upstream);
  assert.equal(sent.method, item.method);
  assert.equal(sent.headers.get("authorization"), "Bearer owned-route-token");
  assert.equal(sent.headers.get("cookie"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  if (item.upload || (item.route === batches && item.method === "POST")) assert.equal(sent.headers.get("idempotency-key"), "owned-key");
  if (item.method === "POST") {
    headers.set("origin", "http://evil.test");
    assert.equal((await handler(makeRequest(), context)).status, 403, `${item.browser} rejects untrusted origin`);
    assert.equal(calls.length, before + expectedCalls);
  }
  headers.set("origin", "http://127.0.0.1:3000");
  headers.set("host", "evil.test");
  assert.equal((await handler(makeRequest(), context)).status, 403, `${item.browser} rejects untrusted host`);
  assert.equal(calls.length, before + expectedCalls);
}

// A missing server credential must not fall back to the browser's bearer token.
delete process.env.THOUGHTLOOM_USER_TOKEN;
const before = calls.length;
const response = await batches.GET(new Request("http://127.0.0.1:3000/api/imports/markdown", { headers: { host: "127.0.0.1:3000", authorization: "Bearer browser-secret" } }));
assert.notEqual(response.status, 200);
assert.equal(calls.length, before);
