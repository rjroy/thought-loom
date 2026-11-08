import { describe, expect, test } from "bun:test";
import { readWebConfig } from "../apps/web/src/server/config";
import { requestDaemon, type DaemonRequest } from "../apps/web/src/server/daemon";
import { createImportBoundary } from "../apps/web/src/server/import";
import { createLogger } from "../src/logging";
import type { ImportBatch, ImportFile } from "../src/domain/markdown-import-contract";
import { thought as ideaThought } from "../apps/web/src/features/idea/validation";

const token = "owned-server-token";
const config = readWebConfig({ THOUGHTLOOM_USER_TOKEN: token });
const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# café 雪\r\nsecond\r\n")]);
const counts = { admitted: 1, pending: 1, imported: 0, skippedIdentical: 0, skippedChanged: 0, failed: 0, interrupted: 0 };
const batch = { id: "batch-1", namespaceId: "loose", createdAt: "2032-01-01T00:00:00Z", sealedAt: null, state: "open", counts } satisfies ImportBatch;
const file = { id: "file-1", importId: "batch-1", position: 1, relativePath: "notes/a.md", byteLength: bytes.length, createdAt: "2032-01-01T00:00:00Z", state: "queued", runId: "run-1", documentId: null, thoughtCount: null, segmentation: null, error: null } satisfies ImportFile;
const run = { id: "run-1", kind: "import", status: "uncertain", importId: "batch-1", fileId: "file-1" };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const browser = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:3000${path}`, {
  ...init, headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", ...Object.fromEntries(new Headers(init.headers)) },
});
function upload(extra?: (form: FormData) => void, key = "attempt-1") {
  const form = new FormData();
  form.set("metadata", JSON.stringify({ relativePath: "notes/a.md" }));
  form.set("file", new File([bytes], "untrusted-name.md", { type: "text/markdown" }));
  extra?.(form);
  return browser("/api/imports/markdown/batch-1/files", { method: "POST", headers: { "idempotency-key": key, authorization: "Bearer browser-token", cookie: "browser-cookie", "x-evil": "browser-header" }, body: form });
}
function harness(reply: (url: URL, init: RequestInit) => Promise<Response>, maxFileBytes = 1024) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return reply(url, init ?? {});
  }) as typeof globalThis.fetch;
  const handle = createImportBoundary({ config, fetch, logger: createLogger("verbose", () => {}), timeoutMs: 1000, maxFileBytes });
  return { handle, calls };
}

describe("existing daemon transport", () => {
  test("sends a multipart file with its idempotency key and matching boundary", async () => {
    const form = new FormData();
    form.set("metadata", JSON.stringify({ relativePath: "notes/a.md" }));
    form.set("file", new File([bytes], "a.md", { type: "text/markdown" }));
    let outbound: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      outbound = new Request(input, init);
      return json({ file }, 202);
    }) as typeof fetch;
    const request: DaemonRequest = { method: "POST", path: "/imports/markdown/batch-1/files", body: form, idempotencyKey: "attempt-1" };
    await requestDaemon(config, request, { fetch: fakeFetch, logger: createLogger("verbose", () => {}), timeoutMs: 1000 });
    expect(outbound?.headers.get("content-type")).toMatch(/^multipart\/form-data;\s*boundary=/i);
    expect(outbound?.headers.get("idempotency-key")).toBe("attempt-1");
    expect(outbound?.headers.get("authorization")).toBe(`Bearer ${token}`);
    const parts = await outbound?.formData();
    expect(JSON.parse(String(parts?.get("metadata")))).toEqual({ relativePath: "notes/a.md" });
    expect(new Uint8Array(await (parts?.get("file") as File).arrayBuffer())).toEqual(bytes);
  });
});

describe("fixed-purpose Markdown import server boundary", () => {
  test("creates and reads batches and files, seals, and observes/stops the known run", async () => {
    const h = harness(async (url, init) => {
      if (url.pathname === "/imports/markdown" && init.method === "POST") return json({ import: batch }, 201);
      if (url.pathname === "/imports/markdown" && init.method === "GET") return json({ items: [batch], nextCursor: null });
      if (url.pathname === "/imports/markdown/batch-1/files" && init.method === "GET") return json({ items: [file], nextCursor: null });
      if (url.pathname === "/imports/markdown/batch-1/files/file-1") return json({ file });
      if (url.pathname === "/imports/markdown/batch-1") return json({ import: batch });
      if (url.pathname.endsWith("/seal")) return json({ import: { ...batch, sealedAt: "2032-01-02T00:00:00Z", state: "processing" } });
      if (url.pathname === "/runs/run-1" || url.pathname === "/runs/run-1/stop") return json(run);
      return new Response(null, { status: 404 });
    });
    const actions: Array<[string, RequestInit, number]> = [
      ["/api/imports/markdown", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "batch-key" }, body: "{}" }, 201],
      ["/api/imports/markdown?limit=10", {}, 200],
      ["/api/imports/markdown/batch-1", {}, 200],
      ["/api/imports/markdown/batch-1/files", {}, 200],
      ["/api/imports/markdown/batch-1/files/file-1", {}, 200],
      ["/api/imports/markdown/batch-1/seal", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 200],
      ["/api/imports/runs/run-1", {}, 200],
      ["/api/imports/runs/run-1/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 200],
    ];
    for (const [path, init, status] of actions) {
      const response = await h.handle(browser(path, init));
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    }
    expect(h.calls.map(({ url, init }) => `${init.method} ${url.pathname}`)).toEqual(["POST /imports/markdown", "GET /imports/markdown", "GET /imports/markdown/batch-1", "GET /imports/markdown/batch-1/files", "GET /imports/markdown/batch-1/files/file-1", "POST /imports/markdown/batch-1/seal", "GET /runs/run-1", "GET /runs/run-1", "POST /runs/run-1/stop"]);
    expect(h.calls[1]?.url.searchParams.get("limit")).toBe("10");
    expect(new Headers(h.calls[0]?.init.headers).get("idempotency-key")).toBe("batch-key");
  });

  for (const kind of ["evolve", "export"] as const) {
    test(`does not stop a known ${kind} run through the import boundary`, async () => {
      const h = harness(async () => json({ id: "run-1", kind, status: "running", confirmedThoughtIds: [], responseId: null }));
      const response = await h.handle(browser("/api/imports/runs/run-1/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      expect(response.status).not.toBe(200);
      expect(h.calls.map(({ url, init }) => `${init.method} ${url.pathname}`)).toEqual(["GET /runs/run-1"]);
    });
  }

  test("does not stop a run whose import classification cannot be confirmed", async () => {
    const h = harness(async () => json({ ...run, id: "other" }));
    const response = await h.handle(browser("/api/imports/runs/run-1/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).not.toBe(200);
    expect(h.calls.map(({ url, init }) => `${init.method} ${url.pathname}`)).toEqual(["GET /runs/run-1"]);
  });

  for (const [label, value] of [
    ["empty id", { ...batch, id: "" }],
    ["unusable id", { ...batch, id: "../other" }],
    ["missing report", { id: "batch-1" }],
    ["invalid state", { ...batch, state: "finished" }],
    ["missing counts", { ...batch, counts: undefined }],
  ] as const) {
    test(`batch admission leaves malformed success uncertain: ${label}`, async () => {
      const h = harness(async () => json({ import: value }, 201));
      const response = await h.handle(browser("/api/imports/markdown", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "batch-key" }, body: "{}" }));
      expect([200, 201, 400, 409]).not.toContain(response.status);
      expect(h.calls).toHaveLength(1);
      expect(new Headers(h.calls[0]?.init.headers).get("idempotency-key")).toBe("batch-key");
    });
  }

  for (const [label, path, value] of [
    ["batch detail wrong identity", "/api/imports/markdown/batch-1", { import: { ...batch, id: "batch-other" } }],
    ["batch detail missing report fields", "/api/imports/markdown/batch-1", { import: { id: "batch-1" } }],
    ["batch list invalid item", "/api/imports/markdown", { items: [{ ...batch, counts: { ...counts, pending: -1 } }], nextCursor: null }],
    ["batch list invalid cursor", "/api/imports/markdown", { items: [batch], nextCursor: 4 }],
    ["file detail wrong file identity", "/api/imports/markdown/batch-1/files/file-1", { file: { ...file, id: "file-other" } }],
    ["file detail wrong parent", "/api/imports/markdown/batch-1/files/file-1", { file: { ...file, importId: "batch-other" } }],
    ["file detail incomplete imported report", "/api/imports/markdown/batch-1/files/file-1", { file: { ...file, state: "imported" } }],
    ["file list wrong parent", "/api/imports/markdown/batch-1/files", { items: [{ ...file, importId: "batch-other" }], nextCursor: null }],
    ["file list malformed report", "/api/imports/markdown/batch-1/files", { items: [{ id: "file-1", importId: "batch-1" }], nextCursor: null }],
    ["file list missing continuation field", "/api/imports/markdown/batch-1/files", { items: [file] }],
  ] as const) {
    test(`does not confirm invalid ${label}`, async () => {
      const h = harness(async () => json(value));
      const response = await h.handle(browser(path));
      expect(response.status).not.toBe(200);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.init.method).toBe("GET");
    });
  }

  test("does not confirm sealing the wrong batch", async () => {
    const h = harness(async () => json({ import: { ...batch, id: "batch-other" } }));
    const response = await h.handle(browser("/api/imports/markdown/batch-1/seal", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect([200, 400, 409]).not.toContain(response.status);
    expect(h.calls).toHaveLength(1);
  });

  test("forwards exact source bytes and the same request key, not browser credentials", async () => {
    const h = harness(async () => json({ file }, 202));
    const response = await h.handle(upload());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ file });
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call?.url.pathname).toBe("/imports/markdown/batch-1/files");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("idempotency-key")).toBe("attempt-1");
    expect(headers.has("cookie")).toBe(false); expect(headers.has("x-evil")).toBe(false);
    const forwarded = await new Request("http://daemon.invalid", call?.init).formData();
    expect(JSON.parse(String(forwarded.get("metadata")))).toEqual({ relativePath: "notes/a.md" });
    const part = forwarded.get("file");
    expect(part).toBeInstanceOf(File);
    expect(new Uint8Array(await (part as File).arrayBuffer())).toEqual(bytes);
    expect(JSON.stringify(Object.fromEntries(response.headers))).not.toContain(token);
  });

  test("accepts a bounded multipart envelope with separate metadata and framing allowances", async () => {
    const boundary = "owned-boundary";
    const metadata = JSON.stringify({ relativePath: "notes/a.md" }) + " ".repeat(3000);
    const padding = " ".repeat(31500);
    const encoder = new TextEncoder();
    const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data;${padding}name="metadata"\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Disposition: form-data;${padding}name="file"; filename="a.md"\r\nContent-Type: text/markdown\r\n\r\n`);
    const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    const wire = new Uint8Array(prefix.length + bytes.length + suffix.length);
    wire.set(prefix); wire.set(bytes, prefix.length); wire.set(suffix, prefix.length + bytes.length);
    const metadataBytes = encoder.encode(metadata).length;
    const framingBytes = wire.length - bytes.length - metadataBytes;
    expect(metadataBytes).toBeLessThanOrEqual(4096);
    expect(framingBytes).toBeLessThanOrEqual(65536);
    expect(wire.length).toBeGreaterThan(bytes.length + 65536);
    expect(wire.length).toBeLessThanOrEqual(bytes.length + 4096 + 65536);
    const parsed = await new Request("http://fixture.invalid", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: wire }).formData();
    expect(JSON.parse(String(parsed.get("metadata")))).toEqual({ relativePath: "notes/a.md" });
    const inputPart = parsed.get("file");
    expect(inputPart).toBeInstanceOf(File);
    expect(new Uint8Array(await (inputPart as File).arrayBuffer())).toEqual(bytes);
    const h = harness(async () => json({ file }, 202), bytes.length);
    const response = await h.handle(browser("/api/imports/markdown/batch-1/files", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": "overhead-key" }, body: wire }));
    expect(response.status).toBe(202);
    expect(h.calls).toHaveLength(1);
    expect(new Headers(h.calls[0]?.init.headers).get("idempotency-key")).toBe("overhead-key");
    const forwarded = await new Request("http://daemon.invalid", h.calls[0]?.init).formData();
    expect(JSON.parse(String(forwarded.get("metadata")))).toEqual({ relativePath: "notes/a.md" });
    const part = forwarded.get("file");
    expect(part).toBeInstanceOf(File);
    expect(new Uint8Array(await (part as File).arrayBuffer())).toEqual(bytes);
  });

  test("rejects untrusted mutations before reading or contacting the daemon", async () => {
    const h = harness(async () => json({ import: batch }, 201));
    for (const headers of [{ host: "evil.test", origin: "http://127.0.0.1:3000" }, { host: "127.0.0.1:3000", origin: "http://evil.test" }, { host: "127.0.0.1:3000" }]) {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("{}")); } });
      const request = new Request("http://127.0.0.1:3000/api/imports/markdown", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
      // Request may prefetch one chunk before the handler gets control.
      await Promise.resolve(); await Promise.resolve();
      const prefetched = pulls;
      expect((await h.handle(request)).status).toBe(403);
      expect(pulls).toBe(prefetched);
    }
    expect(h.calls).toHaveLength(0);
  });

  test("rejects forbidden fields, duplicate parts, bad keys and oversize files before forwarding", async () => {
    const h = harness(async () => json({ file }, 202), bytes.length - 1);
    expect((await h.handle(upload())).status).toBe(413);
    const other = harness(async () => json({ file }, 202));
    for (const request of [upload(f => f.append("extra", "x")), upload(f => f.append("metadata", "{}")), upload(undefined, "bad key"), upload(f => f.set("metadata", '{"relativePath":"notes/a.md","id":"invented"}'))]) {
      expect((await other.handle(request)).status).toBe(400);
    }
    expect(h.calls).toHaveLength(0); expect(other.calls).toHaveLength(0);
  });

  test("bounds streamed upload even without Content-Length", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(8192)); if (pulls > 40) controller.close(); } });
    const request = browser("/api/imports/markdown/batch-1/files", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=owned", "idempotency-key": "attempt-1" }, body: stream, duplex: "half" } as RequestInit);
    const h = harness(async () => json({ file }, 202), 32);
    expect((await h.handle(request)).status).toBe(413);
    expect(pulls).toBeLessThan(40); expect(h.calls).toHaveLength(0);
  });

  test("uncertain admission is not retried and never leaks upstream diagnostics", async () => {
    const h = harness(async () => { throw new Error(`${token} private-source-sentinel`); });
    const response = await h.handle(upload());
    expect([200, 202, 400, 409]).not.toContain(response.status);
    expect(h.calls).toHaveLength(1);
    expect(new Headers(h.calls[0]?.init.headers).get("idempotency-key")).toBe("attempt-1");
    const text = await response.text();
    expect(text).not.toContain(token); expect(text).not.toContain("private-source-sentinel");
  });

  test("replay returns original file identity, not a replacement", async () => {
    const frozen = bytes.slice();
    let admissions = 0;
    const h = harness(async (_url, init) => {
      expect(new Headers(init.headers).get("idempotency-key")).toBe("attempt-1");
      const parts = await new Request("http://daemon.invalid", init).formData();
      expect(JSON.parse(String(parts.get("metadata")))).toEqual({ relativePath: "notes/a.md" });
      expect(new Uint8Array(await (parts.get("file") as File).arrayBuffer())).toEqual(frozen);
      const first = admissions === 0;
      if (first) admissions++;
      return json({ file }, first ? 202 : 200);
    });
    const first = await h.handle(upload());
    const replay = await h.handle(upload());
    expect(first.status).toBe(202); expect(await first.json()).toEqual({ file });
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ file });
    expect(h.calls).toHaveLength(2); expect(admissions).toBe(1);
    expect(bytes).toEqual(frozen);
  });

  test("accepts a replay already imported with zero thoughts and retained source", async () => {
    const imported: ImportFile = { ...file, state: "imported", documentId: "source-1", thoughtCount: 0, segmentation: { method: "not-needed", reason: null } };
    const h = harness(async () => json({ file: imported }, 200));
    const response = await h.handle(upload());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ file: imported });
    expect(h.calls).toHaveLength(1);
  });

  test("source bytes are deliberate history reads with private safe headers", async () => {
    const h = harness(async () => new Response(bytes, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": "attachment; filename=source.md", "x-content-type-options": "nosniff", "x-upstream-secret": token } }));
    const response = await h.handle(browser("/api/imports/sources/source-1/raw"));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls[0]?.url.pathname).toBe("/import-sources/source-1/raw");
    expect(h.calls[0]?.url.searchParams.get("scope")).toBe("history");
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.has("x-upstream-secret")).toBe(false);
    expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  test("offers namespaces and fixed user-history source metadata and parts reads", async () => {
    const source = { id: "source-1", originalNamespaceId: "loose", originalPath: "notes/a.md", sha256: "a".repeat(64), byteLength: bytes.length, encoding: "utf-8", createdAt: "2032-01-01T00:00:00Z", parserVersion: "1", segmentation: { method: "structural", reason: "ai-unconfigured" }, thoughtCount: 0 };
    const h = harness(async url => {
      if (url.pathname === "/import-namespaces") return json({ items: [{ id: "loose", kind: "loose-markdown", label: "Loose Markdown" }] });
      if (url.pathname === "/import-sources/source-1") return json({ source });
      return json({ items: [], nextCursor: null });
    });
    for (const path of ["/api/imports/namespaces", "/api/imports/sources", "/api/imports/sources/source-1", "/api/imports/sources/source-1/parts"]) {
      expect((await h.handle(browser(path))).status).toBe(200);
    }
    expect(h.calls.map(({ url }) => url.pathname)).toEqual(["/import-namespaces", "/import-sources", "/import-sources/source-1", "/import-sources/source-1/parts"]);
    for (const call of h.calls.slice(1)) expect(call.url.searchParams.get("scope")).toBe("history");
  });

  test("does not claim admission from malformed success or expose upstream error body", async () => {
    for (const reply of [() => new Response("{", { status: 202 }), () => json({ file: { ...file, importId: "wrong" } }, 202), () => new Response(`${token} private-source-sentinel`, { status: 500 })]) {
      const h = harness(async () => reply());
      const response = await h.handle(upload());
      expect([200, 202, 400, 409]).not.toContain(response.status);
      expect(h.calls).toHaveLength(1);
      const text = await response.text();
      expect(text).not.toContain(token); expect(text).not.toContain("private-source-sentinel");
    }
  });

  for (const [label, malformed] of [
    ["missing report fields", { id: file.id, importId: file.importId }],
    ["missing state", { ...file, state: undefined }],
    ["invalid state", { ...file, state: "completed" }],
    ["empty file identity", { ...file, id: "" }],
    ["invalid relative path type", { ...file, relativePath: 4 }],
    ["invalid byte length", { ...file, byteLength: -1 }],
    ["invalid run identity", { ...file, runId: 4 }],
    ["invalid thought count", { ...file, thoughtCount: -1 }],
    ["missing segmentation", { ...file, segmentation: undefined }],
    ["invalid error report", { ...file, error: { code: "parse-failed", retryable: "yes" } }],
  ] as const) {
    test(`does not confirm malformed file admission: ${label}`, async () => {
      const h = harness(async () => json({ file: malformed }, 202));
      const response = await h.handle(upload());
      expect([200, 202, 400, 409]).not.toContain(response.status);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.init.method).toBe("POST");
      expect(new Headers(h.calls[0]?.init.headers).get("idempotency-key")).toBe("attempt-1");
    });
  }

  test("does not expose a generic daemon proxy or caller-selected source scope", async () => {
    const h = harness(async () => json({}));
    for (const path of ["/api/imports/thoughts", "/api/imports/sources/source-1/raw?scope=normal", "/api/imports/markdown/batch-1?path=/thoughts"]) {
      expect((await h.handle(browser(path))).status).not.toBe(200);
    }
    expect(h.calls).toHaveLength(0);
  });
});

describe("fixed-purpose media import server boundary", () => {
  const clarification = "  Compare red and blue.\r\nKeep exact wording.  ";
  const media = {id:"thought-1",text:null,title:null,titleAuthor:null,author:"source",kind:"media-original",origin:"media-import",
    parentId:null,sourceIds:[],createdAt:"2032-01-01T00:00:00Z",mediaSource:{id:"source-1",name:"picture.png",mimeType:"image/png",
      byteLength:bytes.length,fileAuthorship:"unverified",clarification,clarificationAuthor:"user"}};
  const original = {id:"run-original",kind:"weave",status:"failed",confirmedThoughtIds:[],responseId:null};
  const latest = {id:"run-retry",kind:"weave",status:"queued",confirmedThoughtIds:[],responseId:null};
  const active = {eligible:false,reason:"work-active"};
  const path = "/api/imports/media-sources/source-1";
  function mediaUpload(change?: (form: FormData) => void, key = "upload:1") {
    const form = new FormData();
    form.set("metadata",JSON.stringify({clarification}));
    form.set("file",new File([bytes],"picture.png",{type:"image/png"}));
    change?.(form);
    return browser("/api/imports/media",{method:"POST",headers:{"idempotency-key":key,authorization:"Bearer browser-token",cookie:"browser-cookie"},body:form});
  }
  const retryRequest = () => browser(`${path}/retry`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":"retry:1"},body:"{}"});

  test("uploads exact file and clarification, and keeps original receipt distinct from latest source run", async () => {
    const h = harness(async (url, init) => {
      if (url.pathname === "/imports/media") return json({thought:media,run:original},202);
      if (url.pathname === "/imports/media/by-key/upload:1") return json({thought:media,run:original});
      if (url.pathname === "/media-sources/source-1") return json({thought:media,run:latest,retry:active});
      if (url.pathname === "/media-sources/source-1/retry" && init.method === "POST") return json({run:latest},202);
      return new Response(null,{status:404});
    });
    const admitted = await h.handle(mediaUpload());
    expect(admitted.status).toBe(202); expect(await admitted.json()).toEqual({thought:media,run:original});
    const receipt = await h.handle(browser("/api/imports/media/by-key/upload:1"));
    expect(receipt.status).toBe(200); expect(await receipt.json()).toEqual({thought:media,run:original});
    const inspection = await h.handle(browser(path));
    expect(inspection.status).toBe(200); expect(await inspection.json()).toEqual({thought:media,run:latest,retry:active});
    const retried = await h.handle(retryRequest());
    expect(retried.status).toBe(202); expect(await retried.json()).toEqual({run:latest});
    expect(h.calls.map(({url,init}) => `${init.method} ${url.pathname}${url.search}`)).toEqual([
      "POST /imports/media","GET /imports/media/by-key/upload:1","GET /media-sources/source-1","POST /media-sources/source-1/retry"]);
    const first = h.calls[0];
    const outbound = new Headers(first?.init.headers);
    expect(outbound.get("authorization")).toBe(`Bearer ${token}`); expect(outbound.get("idempotency-key")).toBe("upload:1");
    expect(outbound.has("cookie")).toBe(false);
    expect(first?.init.redirect).toBe("error");
    const form = await new Request("http://daemon.invalid",first?.init).formData();
    expect(JSON.parse(String(form.get("metadata")))).toEqual({clarification});
    const part = form.get("file"); expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe("picture.png"); expect(new Uint8Array(await (part as File).arrayBuffer())).toEqual(bytes);
    expect(new Headers(h.calls[3]?.init.headers).get("idempotency-key")).toBe("retry:1");
    expect(h.calls[3]?.init.body).toBe("{}");
    for (const response of [admitted,receipt,inspection,retried]) expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("receipt lookup decodes a browser-encoded key once and forwards the same safe identity", async () => {
    const h = harness(async () => json({thought:media,run:original}));
    const response = await h.handle(browser("/api/imports/media/by-key/upload%3A1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({thought:media,run:original});
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.init.method).toBe("GET");
    expect(h.calls[0]?.url.pathname).toBe("/imports/media/by-key/upload%3A1");
    expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${token}`);
    for (const key of ["bad%2Fkey","bad%252Fkey","bad%ZZkey"]) {
      expect((await h.handle(browser(`/api/imports/media/by-key/${key}`))).status).toBe(400);
    }
    expect(h.calls).toHaveLength(1);
  });

  test("requires trusted origin and host, bounded single-part upload and fixed paths", async () => {
    const h = harness(async () => json({thought:media,run:original},202));
    const untrustedHeaders: HeadersInit[] = [{host:"evil.test",origin:"http://127.0.0.1:3000"},{host:"127.0.0.1:3000",origin:"http://evil.test"},{host:"127.0.0.1:3000"}];
    for (const headers of untrustedHeaders) {
      const request = new Request("http://127.0.0.1:3000/api/imports/media",{method:"POST",headers,body:"untrusted"});
      expect((await h.handle(request)).status).toBe(403);
    }
    for (const request of [mediaUpload(f => f.append("file",new File([bytes],"second.png"))),
      mediaUpload(f => f.set("metadata",JSON.stringify({clarification,path:"/private"}))),mediaUpload(undefined,"bad key"),
      browser(`${path}?scope=history&scope=normal`),browser(`${path}?scope=show-rejected`),
      browser(`${path}/retry`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":"key"},body:'{"path":"/private"}'})]) {
      expect((await h.handle(request)).status).toBe(400);
    }
    const limited = harness(async () => json({thought:media,run:original},202),bytes.length-1);
    expect((await limited.handle(mediaUpload())).status).toBe(413);
    expect(h.calls).toHaveLength(0); expect(limited.calls).toHaveLength(0);
  });

  test("history is explicit and original bytes use safe private attachment headers", async () => {
    const h = harness(async url => url.pathname.endsWith("/raw")
      ? new Response(bytes,{headers:{"content-type":"image/png","content-disposition":"attachment; filename=source.png","x-upstream-secret":token}})
      : json({thought:{...media,rejected:true},run:latest,retry:{eligible:false,reason:"source-rejected"}}));
    const history = await h.handle(browser(`${path}?scope=history`));
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({thought:{...media,rejected:true},run:latest,retry:{eligible:false,reason:"source-rejected"}});
    for (const suffix of ["/raw","/raw?scope=history"]) {
      const response = await h.handle(browser(`${path}${suffix}`));
      expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;\s*filename="?source\.png"?$/);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.has("x-upstream-secret")).toBe(false);
    }
    expect(h.calls.map(({url}) => `${url.pathname}${url.search}`)).toEqual([
      "/media-sources/source-1?scope=history","/media-sources/source-1/raw","/media-sources/source-1/raw?scope=history"]);
  });

  test("observes and stops only a verified media weave through its fixed run boundary", async () => {
    const h = harness(async url => url.pathname === "/runs/run-retry/stop" ? json({...latest,status:"interrupted"}) : json(latest));
    const runPath = "/api/imports/media-runs/run-retry";
    const read = await h.handle(browser(runPath));
    expect(read.status).toBe(200); expect(await read.json()).toEqual(latest);
    const stop = await h.handle(browser(`${runPath}/stop`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}));
    expect(stop.status).toBe(200); expect(await stop.json()).toEqual({...latest,status:"interrupted"});
    expect(h.calls.map(({url,init}) => `${init.method} ${url.pathname}`)).toEqual([
      "GET /runs/run-retry","GET /runs/run-retry","POST /runs/run-retry/stop"]);
    for (const kind of ["evolve","export","import"]) {
      const other = harness(async () => json({...latest,kind}));
      const denied = await other.handle(browser(`${runPath}/stop`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}));
      expect(denied.status).not.toBe(200);
      expect(other.calls.map(({url,init}) => `${init.method} ${url.pathname}`)).toEqual(["GET /runs/run-retry"]);
    }
  });

  test("validates descriptor, ordinary run and closed retry union before confirming a source", async () => {
    expect(ideaThought(media)).toBe(true);
    const validRetry = [{eligible:true,reason:null},...(["source-rejected","interpretation-exists","work-active","work-unsettled","work-completed"] as const).map(reason => ({eligible:false,reason}))];
    for (const retry of validRetry) {
      const h = harness(async () => json({thought:media,run:null,retry}));
      expect((await h.handle(browser(path))).status).toBe(200);
    }
    const malformed = [
      {thought:{...media,text:"invented"},run:latest,retry:active},
      {thought:{...media,mediaSource:{...media.mediaSource,id:"other"}},run:latest,retry:active},
      {thought:{...media,mediaSource:{...media.mediaSource,clarificationAuthor:null}},run:latest,retry:active},
      {thought:media,run:{...latest,kind:"evolve"},retry:active},
      {thought:media,run:{...latest,status:"unknown"},retry:active},
      {thought:media,run:latest,retry:{eligible:true,reason:"work-active"}},
      {thought:media,run:latest,retry:{eligible:false,reason:"invented"}},
    ];
    for (const value of malformed) {
      const h = harness(async () => json(value));
      expect((await h.handle(browser(path))).status).toBe(502);
      expect(h.calls).toHaveLength(1);
    }
  });

  test("never returns upstream errors, redirects or private diagnostics", async () => {
    for (const response of [new Response(`${token} private-path`,{status:500}),new Response(null,{status:302,headers:{location:"http://evil.test"}})]) {
      const h = harness(async () => response);
      const result = await h.handle(mediaUpload());
      expect(result.status).toBe(502); expect(result.headers.get("cache-control")).toContain("no-store");
      expect(result.headers.has("location")).toBe(false);
      const body = await result.text(); expect(body).not.toContain(token); expect(body).not.toContain("private-path");
      expect(h.calls).toHaveLength(1); expect(h.calls[0]?.init.redirect).toBe("error");
    }
  });
});

test("actual Next route wrappers wire their exported methods to the guarded server boundary", async () => {
  // The react-server condition resolves the real server-only marker in this
  // isolated child; no module mocks or global changes leak into other tests.
  const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=react-server", "tests/fixtures/web-import-routes.ts"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: "/tmp/opencode", THOUGHTLOOM_DAEMON_URL: "http://127.0.0.1:3001", THOUGHTLOOM_WEB_ORIGIN: "http://127.0.0.1:3000", THOUGHTLOOM_USER_TOKEN: "owned-route-token" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).not.toContain("owned-route-token");
});
