import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonEvent, type RunningDaemon } from "../src/daemon/runtime";
import type { LogRecord } from "../src/logging";

const credentials = { user: "test-user-token-0123456789-abcdef012345", ai: "test-agent-token-0123456789-abcdef01234" };
const encoder = new TextEncoder();
type Requester = (path: string, init?: RequestInit, role?: "user" | "ai") => Promise<Response>;

async function fixture(action: (request: Requester, events: DaemonEvent[], logs: LogRecord[]) => Promise<void>) {
  const dir = await mkdtemp(join("/tmp/opencode", "import-boundary-"));
  const events: DaemonEvent[] = [], logs: LogRecord[] = [];
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ port: 0, dbPath: join(dir, "test.sqlite"), credentials, importMaxBytes: 32, logLevel: "verbose" }, event => events.push(event), { logSink: record => logs.push(record) });
    const url = daemon.url;
    const request: Requester = (path, init = {}, role = "user") => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${credentials[role]}`);
      return fetch(new URL(path, url), { ...init, headers });
    };
    await action(request, events, logs);
  } finally {
    try { if (daemon) await daemon.stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}
const command = (body: string, key = "batch-key"): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body });
async function batch(request: Requester): Promise<string> {
  const response = await request("/imports/markdown", command("{}"));
  expect(response.status).toBe(201);
  return ((await response.json()) as { import: { id: string } }).import.id;
}
function form(path: string, data: Uint8Array, key = "file-key"): RequestInit {
  const body = new FormData(), copy = new Uint8Array(data.length);
  copy.set(data);
  body.append("metadata", JSON.stringify({ relativePath: path }));
  body.append("file", new Blob([copy.buffer]), "ignored.md");
  return { method: "POST", headers: { "idempotency-key": key }, body };
}
function wire(parts: { name: string; value: Uint8Array; filename?: string }[]): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(encoder.encode(`--fixture\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}\r\n\r\n`), part.value, encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode("--fixture--\r\n"));
  const result = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function multipart(parts: { name: string; value: Uint8Array; filename?: string }[], key = "raw-key"): RequestInit {
  return { method: "POST", headers: { "content-type": "multipart/form-data; boundary=fixture", "idempotency-key": key }, body: wire(parts) };
}

test("strict JSON, keys, queries and role gates reject client authority before admission", async () => fixture(async request => {
  const id = await batch(request);
  for (const body of ['{"id":"client"}', '{"createdAt":"2030"}', '{"title":"client"}', '{"kind":"source"}', '{"namespaceId":"x","namespaceId":"x"}', '[]', '{']) {
    expect((await request("/imports/markdown", command(body, "bad-json-key"))).status).toBe(400);
  }
  for (const key of [" ", "bad key", "x".repeat(129), "bad,duplicate"]) {
    expect((await request("/imports/markdown", command("{}", key))).status).toBe(400);
  }
  expect((await request("/imports/markdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  expect((await request("/imports/markdown", { method: "POST", headers: { "idempotency-key": "key" }, body: "{}" })).status).toBe(415);
  expect((await request("/imports/markdown?limit=1&limit=1")).status).toBe(400);
  expect((await request("/import-sources?scope=history&scope=history")).status).toBe(400);
  for (const endpoint of ["/imports/markdown", `/imports/markdown/${id}/files`, `/imports/markdown/${id}/seal`]) {
    expect((await request(endpoint, command("not json"), "ai")).status).toBe(403);
  }
  expect((await request("/import-sources?scope=normal&unexpected=1", {}, "ai")).status).toBe(403);
  const report = await request(`/imports/markdown/${id}`);
  expect(((await report.json()) as { import: { counts: { admitted: number } } }).import.counts.admitted).toBe(0);
}), 10000);

test("multipart validation and file byte cap reject before admission and release the receiver", async () => fixture(async request => {
  const id = await batch(request), endpoint = `/imports/markdown/${id}/files`;
  const meta = { name: "metadata", value: encoder.encode('{"relativePath":"ok.md"}') };
  const file = { name: "file", value: encoder.encode("owned text"), filename: "x.md" };
  for (const parts of [[meta, meta, file], [meta, file, file], [file], [meta], [{ name: "metadata", value: encoder.encode('{"relativePath":"a","relativePath":"b"}') }, file], [{ name: "metadata", value: new Uint8Array([0xff]) }, file]]) {
    expect((await request(endpoint, multipart(parts))).status).toBe(400);
  }
  for (const path of ["../bad.md", "/absolute.md", "a/../b.md", "C:/bad.md", "a\\b.md"]) {
    expect((await request(endpoint, form(path, encoder.encode("text")))).status).toBe(400);
  }
  for (const data of [new Uint8Array([0xff]), new Uint8Array([65, 0, 66])]) {
    expect((await request(endpoint, form("bad.md", data))).status).toBe(422);
  }
  expect((await request(endpoint, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=fixture", "idempotency-key": "malformed" }, body: "broken" })).status).toBe(400);
  const truncated = wire([meta, file]).slice(0, -10);
  expect((await request(endpoint, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=fixture", "idempotency-key": "truncated" }, body: truncated })).status).toBe(400);
  expect((await request(endpoint, multipart([{ name: "metadata", value: encoder.encode(JSON.stringify({ relativePath: "x".repeat(4096) })) }, file]))).status).toBe(400);
  expect((await request(endpoint, command("{}", "wrong-media"))).status).toBe(415);
  expect((await request(endpoint, form("large.md", encoder.encode("x".repeat(33))))).status).toBe(413);
  const accepted = await request(endpoint, form("good.md", encoder.encode("short owned input"), "valid-after-errors"));
  expect(accepted.status).toBe(202);
  const report = await request(`/imports/markdown/${id}`);
  expect(((await report.json()) as { import: { counts: { admitted: number } } }).import.counts.admitted).toBe(1);
}), 10000);

test("boundary diagnostics log route attempts and outcomes without source, keys or credentials", async () => fixture(async (request, events, logs) => {
  const id = await batch(request);
  const response = await request(`/imports/markdown/${id}/files`, form("private-path-marker.md", encoder.encode("private-content-marker"), "private-key-marker"));
  expect(response.status).toBe(202);
  const path = "/imports/markdown/:id/files";
  expect(events.some(event => "path" in event && event.path === path && event.phase === "attempt")).toBe(true);
  expect(events.some(event => "path" in event && event.path === path && event.phase === "outcome" && event.status === 202)).toBe(true);
  const output = JSON.stringify({ events, logs });
  for (const secret of ["private-path-marker", "private-content-marker", "private-key-marker", credentials.user, credentials.ai]) expect(output).not.toContain(secret);
}), 10000);

test("restart invalidates process-owned cursors without losing persisted membership", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "import-cursor-restart-"));
  const dbPath = join(dir, "owned.sqlite");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ port: 0, dbPath, credentials }, () => {}, { logSink: () => {} });
    const request = (path: string, init: RequestInit = {}) => {
      if (!daemon) throw new Error("Daemon is not running");
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${credentials.user}`);
      return fetch(new URL(path, daemon.url), { ...init, headers });
    };
    for (const key of ["restart-one", "restart-two"]) expect((await request("/imports/markdown", command("{}", key))).status).toBe(201);
    const first = await request("/imports/markdown?limit=1");
    expect(first.status).toBe(200);
    const page = await first.json() as { items: { id: string }[]; nextCursor: string | null };
    expect(page.items).toHaveLength(1);
    if (!page.nextCursor) throw new Error("Expected restart cursor");
    await daemon.stop();
    daemon = undefined;
    daemon = await startDaemon({ port: 0, dbPath, credentials }, () => {}, { logSink: () => {} });
    expect((await request(`/imports/markdown?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).status).toBe(400);
    const fresh = await request("/imports/markdown?limit=2");
    expect(fresh.status).toBe(200);
    const list = await fresh.json() as { items: { id: string }[]; nextCursor: string | null };
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.id).toBe(page.items[0]?.id);
    expect(list.nextCursor).toBeNull();
  } finally {
    try { if (daemon) await daemon.stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}, 10000);

test("injected persistence failure rolls back one admitted file while another completes", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "import-failure-boundary-"));
  const dbPath = join(dir, "owned.sqlite"), logs: LogRecord[] = [];
  let daemon: RunningDaemon | undefined, db: Database | undefined;
  let tick: (() => void) | undefined;
  try {
    daemon = await startDaemon({ port: 0, dbPath, credentials }, () => {}, {
      logSink: record => logs.push(record), startTimer: poll => { tick = poll; return () => { tick = undefined; }; },
    });
    const url = daemon.url;
    const request: Requester = (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${credentials.user}`);
      return fetch(new URL(path, url), { ...init, headers });
    };
    db = new Database(dbPath);
    // A test-owned SQLite fault, not a claim that ordinary Markdown is invalid.
    db.exec("CREATE TRIGGER fixture_fail_import BEFORE INSERT ON thoughts WHEN NEW.text='fixture-fail-content' BEGIN SELECT RAISE(ABORT,'private-fault-detail'); END");
    const id = await batch(request);
    for (const [path, text, key] of [["private-failed-path.md", "fixture-fail-content", "failed-key"], ["good.md", "fixture-good-content", "good-key"]]) {
      expect((await request(`/imports/markdown/${id}/files`, form(path, encoder.encode(text), key))).status).toBe(202);
    }
    expect((await request(`/imports/markdown/${id}/seal`, command("{}"))).status).toBe(200);
    let files: { state: string; error: { code: string } | null; documentId: string | null }[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      tick?.();
      const response = await request(`/imports/markdown/${id}/files`);
      expect(response.status).toBe(200);
      files = ((await response.json()) as { items: typeof files }).items;
      if (files.some(file => file.state === "failed") && files.some(file => file.state === "imported")) break;
      await Bun.sleep(20);
    }
    expect(files.map(file => file.state)).toEqual(["failed", "imported"]);
    expect(files[0]?.error?.code).toBe("persistence-failed");
    expect(files[0]?.documentId).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM thoughts WHERE text='fixture-fail-content'").get()).toEqual({ n: 0 });
    const report = await request(`/imports/markdown/${id}`);
    const summary = ((await report.json()) as { import: { state: string; counts: { failed: number; imported: number; pending: number } } }).import;
    expect(summary.state).toBe("completed");
    expect(summary.counts.failed).toBe(1);
    expect(summary.counts.imported).toBe(1);
    expect(summary.counts.pending).toBe(0);
    const log = JSON.stringify(logs);
    for (const secret of ["fixture-fail-content", "fixture-good-content", "private-failed-path", "private-fault-detail", "failed-key", credentials.user, credentials.ai]) expect(log).not.toContain(secret);
  } finally {
    try { if (daemon) await daemon.stop(); } finally { try { db?.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  }
}, 10000);
