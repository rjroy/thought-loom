import "server-only";
import { isRecordId, parseCaptureInput, parseInquiryView, parseSearchResponse, type CaptureInput, type Source, type InquiryView, type SearchResult } from "@thoughtloom/contracts";
import { isSourceId, parseSource } from "./source";
import { isIdempotencyKey, parseWeavingRetryInput, parseWeavingRetryReceipt, parseWeavingStatusView, type WeavingStatusView } from "@thoughtloom/contracts";

// An operator-controlled loopback destination, never a browser-supplied URL.
function daemonURL(path: string): URL {
  const base = new URL(process.env.THOUGHTLOOM_DAEMON_URL ?? "http://127.0.0.1:3001");
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
      base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Invalid internal daemon configuration");
  }
  return new URL(path, base);
}

export type SourceRead =
  | { kind: "found"; source: Source }
  | { kind: "not-found" }
  | { kind: "unavailable" };

export async function readSource(id: string): Promise<SourceRead> {
  if (!isSourceId(id)) return { kind: "not-found" };
  console.info("bff.source.read attempt", { sourceId: id });
  try {
    const response = await fetch(daemonURL(`/sources/${encodeURIComponent(id)}`), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) {
      console.info("bff.source.read not_found", { sourceId: id });
      return { kind: "not-found" };
    }
    if (response.status !== 200) throw new Error("Source read failed");
    const source = parseSource(await response.json());
    if (!source || source.id !== id) throw new Error("Invalid source receipt");
    console.info("bff.source.read succeeded", { sourceId: id });
    return { kind: "found", source };
  } catch {
    console.error("bff.source.read failed", { sourceId: id, category: "daemon_unavailable" });
    return { kind: "unavailable" };
  }
}

export function privateJSON(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function forwardCapture(body: unknown, key: string | null): Promise<Response> {
  const input: CaptureInput | null = parseCaptureInput(body);
  if (!input || !key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key)) {
    return privateJSON({ error: "Invalid capture or save key" }, 400);
  }
  console.info("bff.capture.save attempt");
  try {
    const response = await fetch(daemonURL("/captures"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(input),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 409) {
      console.info("bff.capture.save conflict");
      return privateJSON({ error: "Save key conflicts with an earlier capture" }, 409);
    }
    if (response.status !== 200 && response.status !== 201) throw new Error("Capture not acknowledged");
    const source = parseSource(await response.json());
    if (!source || source.text !== input.text || source.provenance !== input.provenance) {
      throw new Error("Invalid capture receipt");
    }
    console.info("bff.capture.save succeeded", { sourceId: source.id, status: response.status });
    return privateJSON(source, response.status);
  } catch {
    console.error("bff.capture.save failed", { category: "unconfirmed_save" });
    return privateJSON({ error: "Save could not be confirmed" }, 503);
  }
}

type ProjectionRead<T> = { kind: "found"; value: T } | { kind: "not-found" } | { kind: "unavailable" };

async function readProjection<T>(operation: string, path: string, parse: (value: unknown) => T | null): Promise<ProjectionRead<T>> {
  console.info(`${operation} attempt`);
  try {
    const response = await fetch(daemonURL(path), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (response.status === 404) { console.info(`${operation} not_found`); return { kind: "not-found" }; }
    if (response.status !== 200) throw new Error("Read not acknowledged");
    const value = parse(await response.json());
    if (!value) throw new Error("Invalid read response");
    console.info(`${operation} succeeded`);
    return { kind: "found", value };
  } catch {
    console.warn(`${operation} failed`, { category: "read_unavailable" });
    return { kind: "unavailable" };
  }
}

export function validSearchQuery(query: string): boolean {
  return query.length <= 512 && (query.match(/[\p{L}\p{N}\p{M}]+/gu)?.length ?? 0) <= 16;
}

export async function readSearch(query: string): Promise<{ kind: "found"; results: SearchResult[] } | { kind: "invalid" } | { kind: "unavailable" }> {
  if (!validSearchQuery(query)) return { kind: "invalid" };
  const response = await readProjection("bff.search.read", `/search?q=${encodeURIComponent(query)}`, parseSearchResponse);
  return response.kind === "found" ? { kind: "found", results: response.value.results } : { kind: "unavailable" };
}

export async function readInquiry(id: string): Promise<ProjectionRead<InquiryView>> {
  if (!isRecordId(id)) return { kind: "not-found" };
  return readProjection("bff.inquiry.read", `/sources/${encodeURIComponent(id)}/inquiry`, (value) => {
    const parsed = parseInquiryView(value);
    return parsed?.source.id === id ? parsed : null;
  });
}

export async function readWeaving(id: string): Promise<ProjectionRead<WeavingStatusView>> {
  if (!isRecordId(id)) return { kind: "not-found" };
  return readProjection("bff.weaving.read", `/sources/${encodeURIComponent(id)}/weaving`, (value) => {
    const parsed = parseWeavingStatusView(value);
    return parsed?.sourceId === id ? parsed : null;
  });
}

export async function forwardWeavingRetry(id: string, body: unknown, key: string | null): Promise<Response> {
  const input = parseWeavingRetryInput(body);
  if (!isRecordId(id) || !input || !isIdempotencyKey(key)) return privateJSON({ error: "Invalid retry request" }, 400);
  console.info("bff.weaving.retry attempt", { sourceId: id });
  try {
    const response = await fetch(daemonURL(`/sources/${encodeURIComponent(id)}/weaving/retry`), {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(input), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if ([400, 404, 409, 503].includes(response.status)) {
      console.info("bff.weaving.retry declined", { status: response.status });
      return privateJSON({ error: response.status === 409 ? "Retry is no longer eligible. Check current status." : "Retry could not be confirmed." }, response.status);
    }
    if (response.status !== 202) throw new Error("Retry not acknowledged");
    const receipt = parseWeavingRetryReceipt(await response.json());
    if (!receipt || receipt.sourceId !== id || receipt.expectedRunId !== input.expectedRunId) throw new Error("Invalid retry receipt");
    console.info("bff.weaving.retry accepted", { sourceId: id });
    return privateJSON(receipt, 202);
  } catch {
    console.warn("bff.weaving.retry unconfirmed", { sourceId: id });
    return privateJSON({ error: "Retry could not be confirmed." }, 503);
  }
}
