import { requestDaemon, type DaemonDependencies, type DaemonRequest } from "./daemon";
import type { WebConfig } from "./config";
import { isTrustedRequest } from "./request-guard";

type Dependencies = DaemonDependencies & { readonly config: WebConfig; readonly maxFileBytes: number };
const headers = { "cache-control": "private, no-store" };
const problem = (status: number) => Response.json({ message: status === 403 ? "Forbidden." : status === 413 ? "Upload too large." : status === 400 ? "Invalid request." : "Unable to confirm outcome." }, { status, headers });
const safeId = (id: string) => /^[A-Za-z0-9_~.-]+$/.test(id) && id !== "." && id !== "..";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const id = (value: unknown): value is string => typeof value === "string" && safeId(value);
const nonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const metadataLimit = 4096;
const multipartOverhead = 65536;
const uploadAllowance = metadataLimit + multipartOverhead;

function importBatch(value: unknown, expectedId?: string): boolean {
  if (!record(value) || !id(value.id) || (expectedId !== undefined && value.id !== expectedId) || !id(value.namespaceId)
      || typeof value.createdAt !== "string" || !value.createdAt.trim()
      || !(value.sealedAt === null || (typeof value.sealedAt === "string" && !!value.sealedAt.trim()))
      || !record(value.counts)) return false;
  const counts = value.counts;
  if (!nonNegativeInteger(counts.admitted) || !nonNegativeInteger(counts.pending) || !nonNegativeInteger(counts.imported)
      || !nonNegativeInteger(counts.skippedIdentical) || !nonNegativeInteger(counts.skippedChanged)
      || !nonNegativeInteger(counts.failed) || !nonNegativeInteger(counts.interrupted)) return false;
  if (counts.admitted !== counts.pending + counts.imported + counts.skippedIdentical + counts.skippedChanged + counts.failed + counts.interrupted) return false;
  return value.state === (value.sealedAt === null ? "open" : counts.pending > 0 ? "processing" : "completed");
}

function page(value: Record<string, unknown>, validItem: (item: unknown) => boolean): boolean {
  return Array.isArray(value.items) && value.items.every(validItem)
    && (value.nextCursor === null || (typeof value.nextCursor === "string" && value.nextCursor.length > 0));
}

function importRun(value: unknown, expectedId: string): boolean {
  return record(value) && value.id === expectedId && value.kind === "import" && id(value.importId) && id(value.fileId)
    && typeof value.status === "string" && ["queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"].includes(value.status);
}

function importFile(value: unknown, batchId: string | undefined): boolean {
  if (!record(value) || !id(value.id) || value.importId !== batchId || !nonNegativeInteger(value.position)
      || typeof value.relativePath !== "string" || !value.relativePath.trim() || !nonNegativeInteger(value.byteLength)
      || typeof value.createdAt !== "string" || !value.createdAt.trim()
      || !(value.runId === null || id(value.runId)) || !(value.documentId === null || id(value.documentId))
      || !(value.thoughtCount === null || nonNegativeInteger(value.thoughtCount))) return false;
  const segmentation = value.segmentation;
  if (segmentation !== null) {
    if (!record(segmentation)) return false;
    if (segmentation.method === "structural") {
      if (typeof segmentation.reason !== "string" || !["ai-unconfigured", "ai-unavailable", "ai-failed", "ai-invalid", "ai-context-unavailable"].includes(segmentation.reason)) return false;
    } else if (!((segmentation.method === "ai" || segmentation.method === "not-needed") && segmentation.reason === null)) return false;
  }
  if (value.error !== null && (!record(value.error) || typeof value.error.code !== "string" || !value.error.code.trim() || typeof value.error.retryable !== "boolean")) return false;
  if (value.state === "imported") {
    return value.runId !== null && value.documentId !== null && value.thoughtCount !== null && record(segmentation)
      && (segmentation.method === "not-needed") === (value.thoughtCount === 0) && value.error === null;
  }
  if (value.thoughtCount !== null || segmentation !== null) return false;
  if (value.state === "skipped-identical" || value.state === "skipped-changed") return value.documentId !== null && value.error === null;
  if (value.state === "failed" || value.state === "interrupted") return value.documentId === null && value.error !== null;
  if (value.documentId !== null || value.error !== null) return false;
  if (value.state === "waiting") return value.runId === null;
  return typeof value.state === "string" && ["queued", "submitting", "running", "uncertain"].includes(value.state) && value.runId !== null;
}

// Bound actual received bytes before invoking the platform multipart parser. The
// allowance covers multipart headers and metadata, not additional file bytes.
async function boundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

type Operation = { path: string; method: "GET" | "POST"; kind: "json" | "upload" | "raw"; batchId?: string; key?: boolean };

function operation(request: Request): Operation | null {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").slice(1);
  if (parts[0] !== "api" || parts[1] !== "imports") return null;
  const p = parts.slice(2);
  const method = request.method;
  let path: string;
  let kind: Operation["kind"] = "json";
  let batchId: string | undefined;
  let key = false;
  let list = false;
  let history = false;
  if (p[0] === "markdown") {
    if (p.length === 1 && (method === "GET" || method === "POST")) { path = "/imports/markdown"; list = method === "GET"; key = method === "POST"; }
    else if (p[1] && safeId(p[1])) {
      batchId = p[1]; path = `/imports/markdown/${batchId}`;
      if (p.length === 2 && method === "GET") { /* detail */ }
      else if (p.length === 3 && p[2] === "seal" && method === "POST") path += "/seal";
      else if (p.length === 3 && p[2] === "files" && (method === "GET" || method === "POST")) { path += "/files"; list = method === "GET"; if (method === "POST") { kind = "upload"; key = true; } }
      else if (p.length === 4 && p[2] === "files" && p[3] && safeId(p[3]) && method === "GET") path += `/files/${p[3]}`;
      else return null;
    } else return null;
  } else if (p[0] === "namespaces" && p.length === 1 && method === "GET") path = "/import-namespaces";
  else if (p[0] === "runs" && p[1] && safeId(p[1]) && ((p.length === 2 && method === "GET") || (p.length === 3 && p[2] === "stop" && method === "POST"))) path = `/runs/${p[1]}${method === "POST" ? "/stop" : ""}`;
  else if (p[0] === "sources" && method === "GET") {
    history = true; path = "/import-sources";
    if (p.length === 1) list = true;
    else if (p[1] && safeId(p[1])) {
      path += `/${p[1]}`;
      if (p.length === 3 && p[2] === "parts") { path += "/parts"; list = true; }
      else if (p.length === 3 && p[2] === "raw") { path += "/raw"; kind = "raw"; }
      else if (p.length !== 2) return null;
    } else return null;
  } else return null;
  const query = new URLSearchParams();
  if (history) query.set("scope", "history");
  for (const [name, value] of url.searchParams) {
    if (!list || !["limit", "cursor"].includes(name) || query.has(name)) return null;
    query.set(name, value);
  }
  if (query.size) path += `?${query}`;
  return { path, method: method as "GET" | "POST", kind, batchId, key };
}

export function createImportBoundary(deps: Dependencies): (request: Request) => Promise<Response> {
  if (!Number.isSafeInteger(deps.maxFileBytes) || deps.maxFileBytes <= 0 || deps.maxFileBytes > Number.MAX_SAFE_INTEGER - uploadAllowance) throw new Error("Invalid upload limit");
  return async request => {
    if (!isTrustedRequest(deps.config, request)) return problem(403);
    const op = operation(request);
    if (!op) return problem(400);
    const key = request.headers.get("idempotency-key");
    if (op.key && (!key || !keyPattern.test(key))) return problem(400);
    let body: string | FormData | undefined;
    try {
      if (op.method === "POST") {
        const contentType = request.headers.get("content-type") ?? "";
        if (op.kind === "upload") {
          if (!/^multipart\/form-data\s*;/i.test(contentType)) return problem(400);
          const bytes = await boundedBody(request, deps.maxFileBytes + uploadAllowance);
          if (!bytes) return problem(413);
          const form = await new Request("http://localhost/", { method: "POST", headers: { "content-type": contentType }, body: bytes }).formData();
          const entries = Array.from(form.entries());
          if (entries.length !== 2 || form.getAll("metadata").length !== 1 || form.getAll("file").length !== 1) return problem(400);
          const metadata = form.get("metadata"), file = form.get("file");
          if (typeof metadata !== "string" || !(file instanceof File)) return problem(400);
          if (new TextEncoder().encode(metadata).byteLength > metadataLimit) return problem(400);
          if (file.size > deps.maxFileBytes) return problem(413);
          const parsed: unknown = JSON.parse(metadata);
          if (!record(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.relativePath !== "string") return problem(400);
          body = new FormData();
          body.set("metadata", metadata); body.set("file", file);
        } else {
          if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) return problem(400);
          const bytes = await boundedBody(request, 65536);
          if (!bytes) return problem(413);
          body = new TextDecoder().decode(bytes);
          const parsed: unknown = JSON.parse(body);
          if (!record(parsed)) return problem(400);
          const names = Object.keys(parsed);
          if (op.key ? names.some(name => name !== "namespaceId") || ("namespaceId" in parsed && typeof parsed.namespaceId !== "string") : names.length !== 0) return problem(400);
        }
      }
    } catch { return problem(400); }
    try {
      if (op.method === "POST" && op.path.startsWith("/runs/")) {
        const runPath = op.path.slice(0, -"/stop".length);
        const expectedId = runPath.split("/")[2];
        if (!expectedId) return problem(400);
        const classification = await requestDaemon(deps.config, { path: runPath, method: "GET" }, deps);
        if (classification.status !== 200 || !importRun(await classification.json(), expectedId)) return problem(502);
      }
      const daemonRequest: DaemonRequest = { path: op.path, method: op.method, body, ...(op.key && key ? { idempotencyKey: key } : {}) };
      const upstream = await requestDaemon(deps.config, daemonRequest, deps);
      if (!upstream.ok) return problem([400, 404, 409, 413, 415, 422, 503].includes(upstream.status) ? upstream.status : 502);
      if (op.kind === "raw") {
        if (upstream.status !== 200) return problem(502);
        return new Response(upstream.body, { status: 200, headers: { ...headers, "content-type": "text/markdown; charset=utf-8", "content-disposition": "attachment; filename=source.md", "x-content-type-options": "nosniff" } });
      }
      const value: unknown = await upstream.json();
      if (!record(value)) return problem(502);
      if (op.kind === "upload" && (![200, 202].includes(upstream.status) || !importFile(value.file, op.batchId))) return problem(502);
      const [pathname] = op.path.split("?");
      const parts = pathname?.split("/") ?? [];
      if (parts[1] === "imports" && parts[2] === "markdown") {
        if (parts.length === 3) {
          if (op.method === "POST" ? ![200, 201].includes(upstream.status) || !importBatch(value.import) : upstream.status !== 200 || !page(value, item => importBatch(item))) return problem(502);
        } else if (parts.length === 4 || parts[4] === "seal") {
          if (upstream.status !== 200 || !importBatch(value.import, op.batchId)
              || (parts[4] === "seal" && record(value.import) && value.import.sealedAt === null)) return problem(502);
        } else if (parts[4] === "files" && op.method === "GET") {
          if (upstream.status !== 200 || (parts.length === 5
            ? !page(value, item => importFile(item, op.batchId))
            : !importFile(value.file, op.batchId) || !record(value.file) || value.file.id !== parts[5])) return problem(502);
        }
      }
      if (op.path.startsWith("/runs/")) {
        const id = op.path.split("/")[2];
        if (!id || upstream.status !== 200 || !importRun(value, id)) return problem(502);
      }
      return Response.json(value, { status: upstream.status, headers });
    } catch { return problem(502); }
  };
}
