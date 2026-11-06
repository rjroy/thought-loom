import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { request as httpRequest, type ClientRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";

const credentials = { user: "test-user-token-0123456789-abcdef012345", ai: "test-agent-token-0123456789-abcdef01234" };

async function fixture(action: (url: string, pending: Set<ClientRequest>, dbPath: string) => Promise<void>) {
  const dir = await mkdtemp(join("/tmp/opencode", "import-wire-"));
  const pending = new Set<ClientRequest>();
  let daemon: RunningDaemon | undefined;
  try {
    const dbPath = join(dir, "owned.sqlite");
    daemon = await startDaemon({ port: 0, dbPath, credentials, importMaxBytes: 32 }, () => {}, { logSink: () => {} });
    await action(daemon.url, pending, dbPath);
  } finally {
    for (const request of pending) request.destroy();
    try { if (daemon) await daemon.stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

async function jsonRequest(url: string, path: string, body?: object, key?: string): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${credentials.user}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  return fetch(new URL(path, url), { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function newBatch(url: string): Promise<string> {
  const response = await jsonRequest(url, "/imports/markdown", {}, "batch-wire");
  expect(response.status).toBe(201);
  return ((await response.json()) as { import: { id: string } }).import.id;
}

async function wire(url: URL, headers: string[], pending: Set<ClientRequest>, write: (request: ClientRequest) => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(url, { method: "POST", headers: ["Host", url.host, ...headers], agent: false }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        settled = true;
        pending.delete(request);
        resolve({ status: response.statusCode ?? 0, body });
      });
      response.on("error", reject);
      // Do not continue sending an upload once the daemon responds.
      if (!request.writableEnded) request.end();
    });
    pending.add(request);
    request.setTimeout(3000, () => request.destroy(new Error("wire fixture timeout")));
    request.on("error", error => { pending.delete(request); if (!settled) reject(error); });
    try { write(request); } catch (error) { request.destroy(); reject(error); }
  });
}

test("chunked socket upload is bounded before multipart admission and releases its receiver", async () => fixture(async (url, pending, dbPath) => {
  const id = await newBatch(url);
  const path = `/imports/markdown/${id}/files`;
  const response = await wire(new URL(path, url), ["Authorization", `Bearer ${credentials.user}`, "Content-Type", "multipart/form-data; boundary=fixture", "Idempotency-Key", "chunked-key", "Transfer-Encoding", "chunked"], pending, request => {
    // No Content-Length and no end: the server must respond while the producer is still open.
    request.write(Buffer.alloc(70000, 65));
  });
  expect({ status: response.status, body: JSON.parse(response.body) }).toMatchObject({ status: 413, body: { code: "source-too-large" } });
  expect(JSON.parse(response.body)).toMatchObject({ code: "source-too-large" });
  const before = await jsonRequest(url, `/imports/markdown/${id}`);
  expect(((await before.json()) as { import: { counts: { admitted: number } } }).import.counts.admitted).toBe(0);
  const db = new Database(dbPath, { readonly: true });
  try { expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 }); }
  finally { db.close(); }
  const form = new FormData();
  form.set("metadata", JSON.stringify({ relativePath: "valid.md" }));
  form.set("file", new Blob(["owned valid text"]), "untrusted.md");
  const valid = await fetch(new URL(path, url), { method: "POST", headers: { authorization: `Bearer ${credentials.user}`, "idempotency-key": "after-chunked" }, body: form });
  expect(valid.status).toBe(202);
}), 10000);

test("duplicate Idempotency-Key header lines are rejected on the socket before batch admission", async () => fixture(async (url, pending) => {
  const response = await wire(new URL("/imports/markdown", url), ["Authorization", `Bearer ${credentials.user}`, "Content-Type", "application/json", "Idempotency-Key", "first", "Idempotency-Key", "second", "Content-Length", "2"], pending, request => request.end("{}"));
  expect(response.status).toBe(400);
  expect(JSON.parse(response.body)).toMatchObject({ code: "invalid-import-request" });
  const list = await jsonRequest(url, "/imports/markdown");
  expect(list.status).toBe(200);
  expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
}), 10000);
