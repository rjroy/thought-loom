import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon } from "../src/daemon/runtime";
import type { ImportBatch, ImportFile, ImportPart, ImportSource } from "../src/domain/markdown-import-contract";

const credentials = { user: "test-user-token-0123456789-abcdef012345", ai: "test-agent-token-0123456789-abcdef01234" };
const bytes = new TextEncoder().encode("---\r\ntitle: private-metadata-token\r\n---\r\nFirst café paragraph.\r\n");

async function owned(action: (request: Requester, path: string) => Promise<void>) {
  const dir = await mkdtemp(join("/tmp/opencode", "import-http-"));
  const path = join(dir, "owned.sqlite");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ port: 0, dbPath: path, credentials }, () => {}, { logSink: () => {} });
    const base = daemon.url;
    const request: Requester = (url, init = {}, actor = "user") => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${credentials[actor]}`);
      return fetch(new URL(url, base), { ...init, headers });
    };
    await action(request, path);
  } finally {
    try { if (daemon) await daemon.stop(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}

type Requester = (path: string, init?: RequestInit, actor?: "user" | "ai") => Promise<Response>;
const json = (body: object, key?: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
function upload(path: string, content: Uint8Array, key: string): RequestInit {
  const body = new FormData();
  const ownedBytes = new Uint8Array(content.length);
  ownedBytes.set(content);
  body.set("metadata", JSON.stringify({ relativePath: path }));
  body.set("file", new Blob([ownedBytes.buffer]), "untrusted-name.md");
  return { method: "POST", headers: { "Idempotency-Key": key }, body };
}
async function create(request: Requester, key = "batch-key"): Promise<ImportBatch> {
  const response = await request("/imports/markdown", json({}, key));
  expect(response.status).toBe(201);
  return ((await response.json()) as { import: ImportBatch }).import;
}
async function completed(request: Requester, batchId: string, fileId: string): Promise<ImportFile> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await request(`/imports/markdown/${batchId}/files/${fileId}`);
    expect(response.status).toBe(200);
    const file = ((await response.json()) as { file: ImportFile }).file;
    if (["imported", "skipped-identical", "skipped-changed", "failed", "interrupted"].includes(file.state)) return file;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for import file");
}
async function errorCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(JSON.stringify(await response.json())).toContain(code);
}

test("batch creation uses the daemon namespace, idempotency, validation and user authority", async () => owned(async request => {
  const batch = await create(request);
  expect(structuredClone(batch)).toMatchObject({ id: expect.any(String), namespaceId: expect.any(String), createdAt: expect.any(String), sealedAt: null, state: "open", counts: { admitted: 0, pending: 0 } });
  const namespaces = await request("/import-namespaces");
  expect(namespaces.status).toBe(200);
  const { items } = await namespaces.json() as { items: { id: string; kind: string; label: string }[] };
  expect(items).toHaveLength(1);
  expect(structuredClone(items[0])).toMatchObject({ id: batch.namespaceId, kind: expect.any(String), label: expect.any(String) });
  expect((await request("/import-namespaces", {}, "ai")).status).toBe(403);
  expect((await request("/imports/markdown", json({}, "ai-key"), "ai")).status).toBe(403);
  const replay = await request("/imports/markdown", json({ namespaceId: items[0]?.id }, "batch-key"));
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as { import: ImportBatch }).import.id).toBe(batch.id);
  expect((await request("/imports/markdown", json({ namespaceId: "nonexistent" }, "batch-key"))).status).toBe(404);
  expect((await request("/imports/markdown", json({ id: "caller-owned" }, "other"))).status).toBe(400);
  expect((await request("/imports/markdown", json({}))).status).toBe(400);
  expect((await request("/imports/markdown?unexpected=1", json({}, "other"))).status).toBe(400);
}), 10000);

test("multipart admission, completion, inspection and rejection preserve the user-only source boundary", async () => owned(async (request, dbPath) => {
  const batch = await create(request);
  const path = "private-path-token/original.md";
  const admitted = await request(`/imports/markdown/${batch.id}/files`, upload(path, bytes, "file-key"));
  expect(admitted.status).toBe(202);
  const initial = ((await admitted.json()) as { file: ImportFile }).file;
  expect(structuredClone(initial)).toMatchObject({ id: expect.any(String), importId: batch.id, relativePath: path, byteLength: bytes.length, position: expect.any(Number), createdAt: expect.any(String) });
  const replay = await request(`/imports/markdown/${batch.id}/files`, upload(path, bytes, "file-key"));
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as { file: ImportFile }).file.id).toBe(initial.id);
  await errorCode(await request(`/imports/markdown/${batch.id}/files`, upload(path, new TextEncoder().encode("changed"), "file-key")), 409, "idempotency-conflict");
  await errorCode(await request(`/imports/markdown/${batch.id}/files`, upload("other.md", bytes, "file-key")), 409, "idempotency-conflict");
  const first = await completed(request, batch.id, initial.id);
  expect(structuredClone(first)).toMatchObject({ state: "imported", thoughtCount: 1, documentId: expect.any(String), segmentation: { method: "structural", reason: "ai-unconfigured" } });
  if (!first.documentId) throw new Error("Missing document ID");
  const documentId = first.documentId;
  const identicalResponse = await request(`/imports/markdown/${batch.id}/files`, upload("copy.md", bytes, "copy-key"));
  expect(identicalResponse.status).toBe(200);
  expect(((await identicalResponse.json()) as { file: ImportFile }).file).toMatchObject({ state: "skipped-identical", documentId, runId: null });
  const changedResponse = await request(`/imports/markdown/${batch.id}/files`, upload(path, new TextEncoder().encode("new revision"), "changed-key"));
  expect(changedResponse.status).toBe(200);
  expect(((await changedResponse.json()) as { file: ImportFile }).file).toMatchObject({ state: "skipped-changed", documentId, runId: null });
  const sealed = await request(`/imports/markdown/${batch.id}/seal`, json({}));
  expect(sealed.status).toBe(200);
  expect(((await sealed.json()) as { import: ImportBatch }).import).toMatchObject({ state: "completed", counts: { admitted: 3, imported: 1, skippedIdentical: 1, skippedChanged: 1, pending: 0 } });
  expect((await request(`/imports/markdown/${batch.id}/seal`, json({}))).status).toBe(200);
  const sealedReplay = await request(`/imports/markdown/${batch.id}/files`, upload(path, bytes, "file-key"));
  expect(sealedReplay.status).toBe(200);
  expect(((await sealedReplay.json()) as { file: ImportFile }).file).toEqual(first);
  await errorCode(await request(`/imports/markdown/${batch.id}/files`, upload("late.md", bytes, "late")), 409, "import-sealed");
  const report = await request(`/imports/markdown/${batch.id}/files`);
  expect(report.status).toBe(200);
  expect(((await report.json()) as { items: ImportFile[] }).items).toHaveLength(3);

  const detail = await request(`/import-sources/${documentId}?scope=history`);
  expect(detail.status).toBe(200);
  const source = ((await detail.json()) as { source: ImportSource }).source;
  expect(source).toMatchObject({ id: documentId, originalNamespaceId: batch.namespaceId, originalPath: path, byteLength: bytes.length, encoding: "utf-8", thoughtCount: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const partsResponse = await request(`/import-sources/${documentId}/parts?scope=history`);
  expect(partsResponse.status).toBe(200);
  const parts = ((await partsResponse.json()) as { items: ImportPart[] }).items;
  const part = parts.find(item => item.kind === "thought");
  if (!part?.thoughtId) throw new Error("Missing thought part");
  expect(part.rejected).toBe(false);
  const raw = await request(`/import-sources/${documentId}/raw?scope=history`);
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-type")).toContain("text/markdown");
  expect(raw.headers.get("content-disposition")).toContain("attachment");
  expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
  expect(raw.headers.get("cache-control")).toContain("no-store");
  expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
  const provenance = `/thoughts/${part.thoughtId}/import-source`;
  expect(await (await request(provenance)).json()).toEqual({ importSource: { documentId, ordinal: part.ordinal, startByte: part.startByte, endByte: part.endByte } });
  for (const endpoint of ["/import-namespaces", "/imports/markdown", `/imports/markdown/${batch.id}`, `/imports/markdown/${batch.id}/files`, `/imports/markdown/${batch.id}/files/${initial.id}`, "/import-sources?scope=history", `/import-sources/${documentId}?scope=history`, `/import-sources/${documentId}/parts?scope=history`, `/import-sources/${documentId}/raw?scope=history`, provenance]) {
    expect((await request(endpoint, {}, "ai")).status).toBe(403);
  }
  await errorCode(await request(`/import-sources/${documentId}`), 400, "inspection-scope-required");
  const aiThoughts = await request("/thoughts", {}, "ai");
  expect(aiThoughts.status).toBe(200);
  const aiText = JSON.stringify(await aiThoughts.json());
  expect(aiText).not.toContain("private-metadata-token");
  expect(aiText).not.toContain("private-path-token");
  const aiSearch = await request("/search?q=paragraph", {}, "ai");
  expect(aiSearch.status).toBe(200);
  const searchText = await aiSearch.text();
  expect(searchText).not.toContain("private-metadata-token");
  expect(searchText).not.toContain("private-path-token");
  const aiDetail = await request(`/thoughts/${part.thoughtId}`, {}, "ai");
  expect(aiDetail.status).toBe(200);
  const thoughtText = await aiDetail.text();
  expect(thoughtText).not.toContain(documentId);
  expect(thoughtText).not.toContain("private-metadata-token");
  expect(thoughtText).not.toContain("private-path-token");
  const exportBody = json({ rootId: part.thoughtId, count: 1, traversal: "depth" });
  expect((await request("/exports/simple", exportBody, "ai")).status).toBe(403);
  const exported = await request("/exports/simple", exportBody);
  expect(exported.status).toBe(200);
  const exportedText = await exported.text();
  expect(exportedText).not.toContain("private-metadata-token");
  expect(exportedText).not.toContain("private-path-token");
  expect((await request(`/thoughts/${part.thoughtId}/reject`, json({}))).status).toBe(204);
  expect((await request(provenance)).status).toBe(404);
  expect((await request(`${provenance}?scope=history`)).status).toBe(200);
  const rejectedParts = ((await (await request(`/import-sources/${documentId}/parts?scope=history`)).json()) as { items: ImportPart[] }).items;
  expect(rejectedParts.find(item => item.thoughtId === part.thoughtId)?.rejected).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try { expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='import'").get()).toEqual({ n: 1 }); }
  finally { db.close(); }
}), 15000);

test("finite file pagination binds an opaque continuation to its parent and rejects tampering", async () => owned(async request => {
  const a = await create(request, "pagination-a");
  const b = await create(request, "pagination-b");
  for (const [key, text] of [["one", "first distinct document"], ["two", "second distinct document"]]) {
    expect((await request(`/imports/markdown/${a.id}/files`, upload(`${key}.md`, new TextEncoder().encode(text), key))).status).toBe(202);
  }
  const first = await request(`/imports/markdown/${a.id}/files?limit=1`);
  expect(first.status).toBe(200);
  const page = await first.json() as { items: ImportFile[]; nextCursor: string | null };
  expect(page.items).toHaveLength(1);
  expect(typeof page.nextCursor).toBe("string");
  if (!page.nextCursor) throw new Error("Expected a continuation");
  const cursor = encodeURIComponent(page.nextCursor);
  const lateResponse = await request(`/imports/markdown/${a.id}/files`, upload("three.md", new TextEncoder().encode("third distinct document"), "three"));
  expect(lateResponse.status).toBe(202);
  const late = ((await lateResponse.json()) as { file: ImportFile }).file;
  const next = await request(`/imports/markdown/${a.id}/files?limit=1&cursor=${cursor}`);
  expect(next.status).toBe(200);
  const second = await next.json() as { items: ImportFile[]; nextCursor: string | null };
  expect(second.items).toHaveLength(1);
  expect(second.items[0]?.id).not.toBe(page.items[0]?.id);
  expect(second.items[0]?.id).not.toBe(late.id);
  expect(second.nextCursor).toBeNull();
  const fresh = await request(`/imports/markdown/${a.id}/files?limit=3`);
  expect(fresh.status).toBe(200);
  const freshPage = await fresh.json() as { items: ImportFile[]; nextCursor: string | null };
  expect(freshPage.items.map(file => file.id)).toEqual([page.items[0]?.id, second.items[0]?.id, late.id]);
  expect(freshPage.nextCursor).toBeNull();
  expect((await request(`/imports/markdown/${b.id}/files?limit=1&cursor=${cursor}`)).status).toBe(400);
  expect((await request(`/imports/markdown/${a.id}/files?limit=2&cursor=${cursor}`)).status).toBe(400);
  expect((await request(`/import-sources?scope=history&limit=1&cursor=${cursor}`)).status).toBe(400);
  expect((await request(`/imports/markdown/${a.id}/files?limit=1&cursor=${encodeURIComponent(page.nextCursor + "x")}`)).status).toBe(400);
}), 10000);
