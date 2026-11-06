import { expect, test } from "bun:test";
import { createImport, listImportFiles, listImports, readImportFile, readImportRun, readSourceParts, stopImportRun, uploadImportFile } from "../apps/web/src/features/import/request";
import type { ImportBatch, ImportFile, SelectedFile } from "../apps/web/src/features/import/types";

const batch: ImportBatch = { id: "batch-1", namespaceId: "namespace-1", createdAt: "2032-01-01T00:00:00Z", sealedAt: null, state: "open", counts: { admitted: 1, pending: 1, imported: 0, skippedIdentical: 0, skippedChanged: 0, failed: 0, interrupted: 0 } };
const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Café 雪\r\n")]);
const selection: SelectedFile = { id: "local-1", key: "stable-key", relativePath: "notes/a.md", file: new File([bytes], "a.md") };
const file: ImportFile = { id: "file-1", importId: batch.id, position: 1, relativePath: selection.relativePath, byteLength: bytes.length, createdAt: batch.createdAt, state: "queued", runId: "run-1", documentId: null, thoughtCount: null, segmentation: null, error: null };
const fake = (fn: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch => (async (url: RequestInfo | URL, init?: RequestInit) => fn(String(url), init)) as typeof fetch;
const json = (value: unknown, status = 200) => Response.json(value, { status });

test("file upload preserves key, metadata and exact bytes, and rejects mismatched receipt identities", async () => {
  const calls: Request[] = [];
  const transport = fake(async (url, init) => { calls.push(new Request(`http://web.invalid${url}`, init)); return json({ file }, 202); });
  expect((await uploadImportFile(batch.id, selection, { fetch: transport })).kind).toBe("confirmed");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.headers.get("idempotency-key")).toBe(selection.key);
  const form = await calls[0]?.formData();
  expect(JSON.parse(String(form?.get("metadata")))).toEqual({ relativePath: selection.relativePath });
  expect(new Uint8Array(await (form?.get("file") as File).arrayBuffer())).toEqual(bytes);
  for (const wrong of [{ ...file, importId: "other" }, { ...file, relativePath: "other.md" }, { ...file, byteLength: file.byteLength + 1 }]) {
    let count = 0;
    const result = await uploadImportFile(batch.id, selection, { fetch: fake(async () => { count++; return json({ file: wrong }, 202); }) });
    expect(result.kind).toBe("uncertain"); expect(count).toBe(1);
  }
});

test("uncertain writes do not replay; explicit rejections remain not-applied", async () => {
  for (const status of [500, 201]) {
    let calls = 0;
    const result = await createImport("batch-key", { fetch: fake(async () => { calls++; return status === 201 ? json({ import: { id: "wrong" } }, status) : new Response(null, { status }); }) });
    expect(result.kind).toBe("uncertain"); expect(calls).toBe(1);
  }
  expect(await createImport("batch-key", { fetch: fake(async () => new Response(null, { status: 409 })) })).toEqual({ kind: "not-applied", status: 409 });
});

test("page continuations are encoded and malformed reports or parents are not accepted", async () => {
  const paths: string[] = [];
  const transport = fake(async url => { paths.push(url); return json({ items: [batch], nextCursor: "next+cursor/=" }); });
  expect((await listImports("prior+cursor/=", { fetch: transport })).kind).toBe("found");
  expect(new URL(paths[0] ?? "", "http://web.invalid").searchParams.get("cursor")).toBe("prior+cursor/=");
  const badPages = [{ items: [{ ...file, importId: "other" }], nextCursor: null }, { items: [file], nextCursor: 3 }, { items: [{ ...file, state: "imported" }], nextCursor: null }];
  for (const value of badPages) expect((await listImportFiles(batch.id, "page-2", { fetch: fake(async () => json(value)) })).kind).toBe("error");
  expect((await readImportFile(batch.id, file.id, { fetch: fake(async () => json({ file: { ...file, id: "other" } })) })).kind).toBe("error");
});

test("known-run reads and Stop cannot accept another file or batch", async () => {
  const known = { id: "run-1", importId: "batch-1", fileId: "file-1" };
  const other = { ...known, kind: "import", status: "running", fileId: "file-other" };
  expect((await readImportRun(known, { fetch: fake(async () => json(other)) })).kind).toBe("error");
  let calls = 0;
  expect((await stopImportRun(known, { fetch: fake(async () => { calls++; return json(other); }) })).kind).toBe("uncertain");
  expect(calls).toBe(1);
});

test("source page validation rejects invalid byte ranges without inventing mapped thoughts", async () => {
  const invalid = { items: [{ position: 0, kind: "thought", startByte: 8, endByte: 3, thoughtId: "thought-1", ordinal: 0, rejected: false }], nextCursor: null };
  expect((await readSourceParts("source-1", null, { fetch: fake(async () => json(invalid)) })).kind).toBe("error");
});
