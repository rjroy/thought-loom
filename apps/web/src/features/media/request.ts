import { mediaDescriptor, mediaThought } from "../idea/media";
import type { MediaClient, MediaProblem, MediaReceipt, MediaRun, MediaUploadSnapshot, MediaSourceClient, MediaRetryEligibility } from "./types";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_~.-]+$/.test(value) && value !== "." && value !== "..";
export const validUploadKey = (value: string): boolean => /^[A-Za-z0-9._:-]{1,128}$/.test(value);
export function validMediaRun(value: unknown): value is MediaRun {
  return object(value) && Object.keys(value).length === 5
    && Object.keys(value).every(key => ["id", "kind", "status", "confirmedThoughtIds", "responseId"].includes(key))
    && id(value.id) && value.kind === "weave" && typeof value.status === "string"
    && ["queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"].includes(value.status)
    && Array.isArray(value.confirmedThoughtIds) && value.confirmedThoughtIds.every(id)
    && new Set(value.confirmedThoughtIds).size === value.confirmedThoughtIds.length
    && (value.responseId === null || id(value.responseId));
}
function receipt(value: unknown): value is MediaReceipt {
  return object(value) && Object.keys(value).length === 2 && mediaThought(value.thought) && validMediaRun(value.run);
}

function eligibility(value: unknown): value is MediaRetryEligibility {
  return object(value) && Object.keys(value).length === 2 && Object.keys(value).every(key => key === "eligible" || key === "reason")
    && (value.eligible === true && value.reason === null || value.eligible === false && typeof value.reason === "string"
      && ["source-rejected", "interpretation-exists", "work-active", "work-unsettled", "work-completed"].includes(value.reason));
}
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf" };
async function discard(response: Response) { try { await response.body?.cancel(); } catch { /* A failed read remains a failed read. */ } }

/** Source inspection is separate from command receipts; no upload-key lookup occurs here. */
export function createMediaSourceClient(fetcher: typeof fetch = fetch): MediaSourceClient {
  const base = (sourceId: string) => `/api/imports/media-sources/${encodeURIComponent(sourceId)}`;
  return {
    async readSource(sourceId, scope, signal) {
      if (!id(sourceId) || (scope !== "normal" && scope !== "history")) return { kind: "error" };
      try {
        const response = await fetcher(`${base(sourceId)}?${new URLSearchParams({ scope })}`, { method: "GET", cache: "no-store", redirect: "error", signal });
        if (response.status === 404) { await discard(response); return { kind: "unavailable" }; }
        if (response.status !== 200) { await discard(response); return { kind: "error" }; }
        const value: unknown = await response.json();
        if (!object(value) || Object.keys(value).length !== 3 || !Object.keys(value).every(key => ["thought", "run", "retry"].includes(key))
          || !mediaThought(value.thought) || value.thought.mediaSource.id !== sourceId || !(value.run === null || validMediaRun(value.run)) || !eligibility(value.retry)
          || (scope === "normal" ? value.thought.rejected === true : typeof value.thought.rejected !== "boolean")) return { kind: "error" };
        return { kind: "found", value: { thought: value.thought, run: value.run, retry: value.retry } };
      } catch { return { kind: "error" }; }
    },
    async readRun(runId, signal) {
      if (!id(runId)) return { kind: "error" };
      try {
        const response = await fetcher(`/api/imports/media-runs/${encodeURIComponent(runId)}`, { method: "GET", cache: "no-store", redirect: "error", signal });
        if (response.status !== 200) { await discard(response); return { kind: "error" }; }
        const value: unknown = await response.json();
        return validMediaRun(value) && value.id === runId ? { kind: "found", run: value } : { kind: "error" };
      } catch { return { kind: "error" }; }
    },
    async retry(sourceId, key) {
      if (!id(sourceId) || !validUploadKey(key)) return { kind: "refused", problem: { status: 400, code: "invalid-media-request" } };
      try {
        const response = await fetcher(`${base(sourceId)}/retry`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: "{}", cache: "no-store", redirect: "error" });
        if (response.status === 200 || response.status === 202) {
          const value: unknown = await response.json();
          if (object(value) && Object.keys(value).length === 1 && validMediaRun(value.run)) return { kind: "confirmed", run: value.run };
          return { kind: "uncertain", problem: { status: response.status, code: null } };
        }
        const error = await problem(response);
        return { kind: response.status === 409 ? "conflict" : [400, 401, 403, 404, 413, 415].includes(response.status) ? "refused" : "uncertain", problem: error };
      } catch { return { kind: "uncertain", problem: { status: null, code: null } }; }
    },
    async stop(known) {
      if (!validMediaRun(known)) return { kind: "uncertain" };
      const runId = known.id;
      try {
        const response = await fetcher(`/api/imports/media-runs/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store", redirect: "error" });
        if (response.status !== 200) { await discard(response); return { kind: "uncertain" }; }
        const value: unknown = await response.json();
        return validMediaRun(value) && value.id === runId ? { kind: "confirmed", run: value } : { kind: "uncertain" };
      } catch { return { kind: "uncertain" }; }
    },
    async download(source, scope) {
      if (!mediaDescriptor(source) || (scope !== "normal" && scope !== "history")) return { kind: "error" };
      try {
        const response = await fetcher(`${base(source.id)}/raw?${new URLSearchParams({ scope })}`, { method: "GET", cache: "no-store", redirect: "error" });
        const mime = response.headers.get("content-type"), extension = mime === null ? undefined : extensions[mime];
        if (response.status !== 200 || !mime || !extension || mime !== source.mimeType
          || response.headers.get("content-disposition") !== `attachment; filename="source.${extension}"`
          || response.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff") { await discard(response); return { kind: "error" }; }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return bytes.byteLength === source.byteLength ? { kind: "ready", bytes, mimeType: mime, filename: `source.${extension}` } : { kind: "error" };
      } catch { return { kind: "error" }; }
    },
  };
}
export function receiptMatches(receipt: MediaReceipt, snapshot: MediaUploadSnapshot): boolean {
  const source = receipt.thought.mediaSource;
  // Multipart filename parameters escape quotes and line breaks, but do not decode existing percent sequences.
  const wireName = snapshot.file.name.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
  return source.name === wireName && source.byteLength === snapshot.file.size && source.clarification === snapshot.clarification;
}
async function problem(response: Response): Promise<MediaProblem> {
  const codes: Record<number, readonly string[]> = {
    400: ["invalid-media-request"], 403: ["forbidden"], 404: ["not-found"],
    409: ["idempotency-conflict", "media-processing-conflict"], 413: ["source-too-large"],
    415: ["unsupported-media-type"], 422: ["unsupported-source-content"],
    503: ["receiver-busy", "storage-unavailable", "original-unavailable"],
  };
  let code: string | null = null;
  try {
    const value: unknown = await response.json();
    if (object(value) && typeof value.code === "string" && codes[response.status]?.includes(value.code)) code = value.code;
  } catch { /* Status is usable; untrusted error text never is. */ }
  return { status: response.status, code };
}

/** Browser-safe fixed-purpose requests. No retry, polling or daemon configuration. */
export function createMediaClient(fetcher: typeof fetch = fetch): MediaClient {
  return {
    async upload(snapshot) {
      const unknown = { kind: "uncertain", problem: { status: null, code: null } } as const;
      if (!validUploadKey(snapshot.key)) return { kind: "not-started", problem: { status: 400, code: "invalid-media-request" } };
      try {
        const form = new FormData();
        form.set("metadata", JSON.stringify(snapshot.clarification === null ? {} : { clarification: snapshot.clarification }));
        form.set("file", snapshot.file);
        const response = await fetcher("/api/imports/media", { method: "POST", body: form,
          headers: { "idempotency-key": snapshot.key }, cache: "no-store", redirect: "error" });
        if (response.status === 200 || response.status === 202) {
          const value: unknown = await response.json();
          return receipt(value) && receiptMatches(value, snapshot) ? { kind: "confirmed", receipt: value } : unknown;
        }
        const error = await problem(response);
        const refused = [400, 401, 403, 413, 415, 422].includes(response.status) || (response.status === 503 && error.code === "receiver-busy");
        return { kind: refused ? "not-started" : "uncertain", problem: error };
      } catch { return unknown; }
    },
    async byKey(key) {
      if (!validUploadKey(key)) return { kind: "error" };
      try {
        const response = await fetcher(`/api/imports/media/by-key/${encodeURIComponent(key)}`, { method: "GET", cache: "no-store", redirect: "error" });
        if (response.status === 404) { await response.body?.cancel(); return { kind: "absent" }; }
        if (response.status !== 200) { await response.body?.cancel(); return { kind: "error" }; }
        const value: unknown = await response.json();
        return receipt(value) ? { kind: "confirmed", receipt: value } : { kind: "error" };
      } catch { return { kind: "error" }; }
    },
  };
}
