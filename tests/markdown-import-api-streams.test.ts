import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/daemon/app";
import { CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import { TitleService } from "../src/domain/title";
import { SqliteImportInspection } from "../src/storage/import-inspection";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteTitleRepository } from "../src/storage/title";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const credentials = { user: "stream-user-secret", ai: "stream-ai-secret" };
const encode = (text: string) => new TextEncoder().encode(text);
const quiet = { verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };

function appFixture() {
  const db = new Database(":memory:");
  let sequence = 0;
  const sources = { id: () => `stream-owned-${++sequence}`, now: () => "2030-01-02T03:04:05.000Z", logger: quiet };
  migrate(db, quiet);
  const store = new SqliteStore(db, sources);
  const rejection = new RejectionService(new SqliteRejectionRepository(db, quiet));
  const creation = new CreationService({ rejection, ...sources, writes: { createThought: value => store.saveThought(value), createConnection: value => store.saveConnection(value) } });
  const imports = new SqliteMarkdownImports(db, sources);
  const app = createApp({ rejection, creation, titles: new TitleService(new SqliteTitleRepository(db, sources)), credentials, logger: () => {}, diagnostics: quiet,
    imports: { commands: imports, inspection: new SqliteImportInspection(db, sources), maxBytes: 32 } });
  const batch = imports.createBatch("user", "stream-batch");
  const endpoint = `http://localhost/imports/markdown/${batch.id}/files`;
  async function request(body: ReadableStream<Uint8Array>, key: string, role: "user" | "ai" = "user"): Promise<Response> {
    return app.request(new Request(endpoint, { method: "POST", headers: { authorization: `Bearer ${credentials[role]}`, "content-type": "multipart/form-data; boundary=fixture", "idempotency-key": key }, body }));
  }
  return { db, imports, batch, request };
}

function source(path: string, text: string): Uint8Array {
  return encode(`--fixture\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify({ relativePath: path })}\r\n--fixture\r\nContent-Disposition: form-data; name="file"; filename="x.md"\r\n\r\n${text}\r\n--fixture--\r\n`);
}
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({ pull(controller) { if (offset === bytes.length) { controller.close(); return; } const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end; } }, { highWaterMark: 0 });
}
function held() {
  let resolveRead: () => void = () => {};
  const read = new Promise<void>(resolve => { resolveRead = resolve; });
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { resolveRead(); } }, { highWaterMark: 0 });
  return { body, read, release() { try { controller?.close(); } catch { /* Already settled. */ } }, abort() { try { controller?.error(new Error("fixture client disconnected")); } catch { /* Already settled. */ } } };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("stream fixture timed out")), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test("two active receivers reject a third and release both slots after held bodies settle", async () => {
  const f = appFixture(), a = held(), b = held();
  let first: Promise<Response> | undefined, second: Promise<Response> | undefined;
  try {
    first = f.request(a.body, "held-a");
    second = f.request(b.body, "held-b");
    await bounded(Promise.all([a.read, b.read]));
    const busy = await bounded(f.request(chunked(source("third.md", "short")), "third"));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).not.toBeNull();
    expect(f.imports.batch("user", f.batch.id)?.counts.admitted).toBe(0);
    a.abort(); b.release();
    expect((await bounded(first)).status).toBe(500);
    expect((await bounded(second)).status).toBe(400);
    expect((await bounded(f.request(chunked(source("valid.md", "short")), "valid"))).status).toBe(202);
  } finally {
    a.release(); b.release();
    await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
    f.db.close();
  }
}, 10000);

test("streamed file and aggregate limits reject without admission and cancel unfinished input", async () => {
  const f = appFixture();
  let cancelled = false;
  try {
    expect((await bounded(f.request(chunked(source("large.md", "x".repeat(33))), "file-too-large"))).status).toBe(413);
    let sent = false;
    const oversize = new ReadableStream<Uint8Array>({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(70000)); } }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    expect((await bounded(f.request(oversize, "aggregate-too-large"))).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(f.imports.batch("user", f.batch.id)?.counts.admitted).toBe(0);
    expect((await bounded(f.request(chunked(source("next.md", "valid")), "next"))).status).toBe(202);
  } finally { f.db.close(); }
}, 10000);

test("AI role is denied before a streaming upload is read", async () => {
  const f = appFixture();
  let read = false;
  try {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { read = true; controller.close(); } }, { highWaterMark: 0 });
    expect((await bounded(f.request(body, "ai", "ai"))).status).toBe(403);
    expect(read).toBe(false);
    expect(f.imports.batch("user", f.batch.id)?.counts.admitted).toBe(0);
  } finally { f.db.close(); }
}, 10000);
