import type { ImportBatch, ImportFile, ImportPage, ImportRead, ImportRun, ImportSource, ImportWrite, Segmentation, SelectedFile, SourcePart } from "./types";

type Fetcher = { readonly fetch: typeof fetch; readonly signal?: AbortSignal };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const importId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_~.-]+$/.test(v) && v !== "." && v !== "..";
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const nullableId = (v: unknown) => v === null || importId(v);
function segmentation(v: unknown): v is Segmentation {
  return record(v) && ((["ai", "not-needed"].includes(String(v.method)) && v.reason === null) || (v.method === "structural" && ["ai-unconfigured", "ai-unavailable", "ai-failed", "ai-invalid", "ai-context-unavailable"].includes(String(v.reason))));
}
function batch(v: unknown): v is ImportBatch {
  if (!record(v) || !importId(v.id) || !importId(v.namespaceId) || !text(v.createdAt) || !(v.sealedAt === null || text(v.sealedAt)) || !record(v.counts)) return false;
  const c = v.counts;
  if (![c.admitted, c.pending, c.imported, c.skippedIdentical, c.skippedChanged, c.failed, c.interrupted].every(integer)) return false;
  return c.admitted === (c.pending as number) + (c.imported as number) + (c.skippedIdentical as number) + (c.skippedChanged as number) + (c.failed as number) + (c.interrupted as number)
    && v.state === (v.sealedAt === null ? "open" : (c.pending as number) > 0 ? "processing" : "completed");
}
function file(v: unknown): v is ImportFile {
  if (!record(v) || !importId(v.id) || !importId(v.importId) || !integer(v.position) || !text(v.relativePath) || !integer(v.byteLength) || !text(v.createdAt) || !nullableId(v.runId) || !nullableId(v.documentId) || !(v.thoughtCount === null || integer(v.thoughtCount)) || !(v.segmentation === null || segmentation(v.segmentation))) return false;
  if (!(v.error === null || (record(v.error) && text(v.error.code) && typeof v.error.retryable === "boolean"))) return false;
  if (v.state === "imported") return v.runId !== null && v.documentId !== null && v.thoughtCount !== null && v.segmentation !== null && v.error === null && ((v.segmentation as Segmentation).method === "not-needed") === (v.thoughtCount === 0);
  if (v.segmentation !== null || v.thoughtCount !== null) return false;
  if (v.state === "skipped-identical" || v.state === "skipped-changed") return v.documentId !== null && v.error === null;
  if (v.state === "failed" || v.state === "interrupted") return v.documentId === null && v.error !== null;
  return v.documentId === null && v.error === null && (v.state === "waiting" ? v.runId === null : ["queued", "submitting", "running", "uncertain"].includes(String(v.state)) && v.runId !== null);
}
function run(v: unknown): v is ImportRun {
  return record(v) && importId(v.id) && v.kind === "import" && importId(v.importId) && importId(v.fileId) && ["queued", "submitting", "running", "uncertain", "completed", "failed", "interrupted"].includes(String(v.status));
}
function source(v: unknown): v is ImportSource {
  return record(v) && importId(v.id) && importId(v.originalNamespaceId) && text(v.originalPath) && integer(v.byteLength) && typeof v.sha256 === "string" && /^[a-f0-9]{64}$/.test(v.sha256) && v.encoding === "utf-8" && text(v.createdAt) && text(v.parserVersion) && segmentation(v.segmentation) && integer(v.thoughtCount);
}
function part(v: unknown): v is SourcePart {
  return record(v) && integer(v.position) && ["thought", "separator", "frontmatter", "bom"].includes(String(v.kind)) && integer(v.startByte) && integer(v.endByte) && v.endByte >= v.startByte && nullableId(v.thoughtId) && (v.ordinal === null || integer(v.ordinal)) && (v.rejected === undefined || typeof v.rejected === "boolean") && (v.kind !== "thought" || (v.thoughtId !== null && v.ordinal !== null));
}
function page<T>(value: unknown, valid: (value: unknown) => value is T): value is ImportPage<T> {
  return record(value) && Array.isArray(value.items) && value.items.every(valid) && (value.nextCursor === null || text(value.nextCursor));
}
const base = "/api/imports";
const batchPath = (id: string) => `${base}/markdown/${encodeURIComponent(id)}`;
const options = (deps: Fetcher): RequestInit => ({ cache: "no-store", redirect: "error", ...(deps.signal ? { signal: deps.signal } : {}) });
async function read<T>(path: string, valid: (value: unknown) => value is T, deps: Fetcher): Promise<ImportRead<T>> {
  try {
    const response = await deps.fetch(path, options(deps));
    if (response.status === 404) return { kind: "unavailable" };
    if (response.status !== 200) return { kind: "error" };
    const value: unknown = await response.json();
    return valid(value) ? { kind: "found", value } : { kind: "error" };
  } catch { return { kind: "error" }; }
}
async function write<T>(path: string, body: string | FormData, key: string | null, valid: (v: unknown) => v is T, statuses: readonly number[], deps: Fetcher): Promise<ImportWrite<T>> {
  try {
    // Writes are never aborted as a substitute for knowing whether the daemon admitted them.
    const response = await deps.fetch(path, { method: "POST", cache: "no-store", redirect: "error", headers: { ...(typeof body === "string" ? { "content-type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body });
    if ([400, 403, 404, 409, 413, 415, 422, 503].includes(response.status)) return { kind: "not-applied", status: response.status };
    if (!statuses.includes(response.status)) return { kind: "uncertain" };
    const value: unknown = await response.json();
    return valid(value) ? { kind: "confirmed", value } : { kind: "uncertain" };
  } catch { return { kind: "uncertain" }; }
}
const wrappedBatch = (v: unknown): v is { import: ImportBatch } => record(v) && batch(v.import);
const wrappedFile = (v: unknown): v is { file: ImportFile } => record(v) && file(v.file);
export function createImport(key: string, deps: Fetcher) { return write(`${base}/markdown`, "{}", key, wrappedBatch, [200, 201], deps); }
export function uploadImportFile(id: string, snapshot: SelectedFile, deps: Fetcher) {
  const body = new FormData(); body.set("metadata", JSON.stringify({ relativePath: snapshot.relativePath })); body.set("file", snapshot.file);
  return write(`${batchPath(id)}/files`, body, snapshot.key, (v): v is { file: ImportFile } => wrappedFile(v) && v.file.importId === id && v.file.relativePath === snapshot.relativePath && v.file.byteLength === snapshot.file.size, [200, 202], deps);
}
export function sealImport(id: string, deps: Fetcher) { return write(`${batchPath(id)}/seal`, "{}", null, (v): v is { import: ImportBatch } => wrappedBatch(v) && v.import.id === id && v.import.sealedAt !== null, [200], deps); }
export function readImport(id: string, deps: Fetcher) { return read(batchPath(id), (v): v is { import: ImportBatch } => wrappedBatch(v) && v.import.id === id, deps); }
export function listImports(cursor: string | null, deps: Fetcher) { return read(`${base}/markdown${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, (v): v is ImportPage<ImportBatch> => page(v, batch), deps); }
export function listImportFiles(id: string, cursor: string | null, deps: Fetcher) { return read(`${batchPath(id)}/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, (v): v is ImportPage<ImportFile> => page(v, file) && v.items.every(item => item.importId === id), deps); }
export function readImportFile(batchId: string, fileId: string, deps: Fetcher) { return read(`${batchPath(batchId)}/files/${encodeURIComponent(fileId)}`, (v): v is { file: ImportFile } => wrappedFile(v) && v.file.importId === batchId && v.file.id === fileId, deps); }
export function readImportRun(known: Pick<ImportRun, "id" | "importId" | "fileId">, deps: Fetcher) { return read(`${base}/runs/${encodeURIComponent(known.id)}`, (v): v is ImportRun => run(v) && v.id === known.id && v.importId === known.importId && v.fileId === known.fileId, deps); }
export function stopImportRun(known: Pick<ImportRun, "id" | "importId" | "fileId">, deps: Fetcher) { return write(`${base}/runs/${encodeURIComponent(known.id)}/stop`, "{}", null, (v): v is ImportRun => run(v) && v.id === known.id && v.importId === known.importId && v.fileId === known.fileId, [200], deps); }
export function readImportSource(id: string, deps: Fetcher) { return read(`${base}/sources/${encodeURIComponent(id)}`, (v): v is { source: ImportSource } => record(v) && source(v.source) && v.source.id === id, deps); }
export function readSourceParts(id: string, cursor: string | null, deps: Fetcher) { return read(`${base}/sources/${encodeURIComponent(id)}/parts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, (v): v is ImportPage<SourcePart> => page(v, part), deps); }
export async function readSourceRaw(id: string, deps: Fetcher): Promise<ImportRead<Uint8Array<ArrayBuffer>>> {
  try {
    const response = await deps.fetch(`${base}/sources/${encodeURIComponent(id)}/raw`, options(deps));
    if (response.status === 404) return { kind: "unavailable" };
    if (response.status !== 200) return { kind: "error" };
    return { kind: "found", value: new Uint8Array(await response.arrayBuffer()) };
  } catch { return { kind: "error" }; }
}
