import "server-only";
import { isIdempotencyKey, isLocalRequest, isRecordId, parseFollowUpRetryInput, parseFollowUpRetryReceipt, parseFollowUpStatusView } from "@thoughtloom/contracts";
import { daemonURL, privateJSON, readProjection } from "./daemon";

export async function readFollowUps(id: string) {
  if (!isRecordId(id)) return { kind: "not-found" as const };
  return readProjection("bff.follow_up.read", `/sources/${encodeURIComponent(id)}/follow-ups`, (body) => {
    const value = parseFollowUpStatusView(body); return value?.sourceId === id ? value : null;
  });
}

export async function retryFollowUp(request: Request, sourceId: string, jobId: string) {
  if (!isLocalRequest(request)) return privateJSON({ error: "Forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return privateJSON({ error: "JSON required" }, 415);
  const key = request.headers.get("idempotency-key");
  if (!isRecordId(sourceId) || !isRecordId(jobId) || !isIdempotencyKey(key)) return privateJSON({ error: "Invalid retry identity" }, 400);
  let body: unknown;
  try { const text = await request.text(); if (new TextEncoder().encode(text).length > 4096) return privateJSON({ error: "Input is too long" }, 413); body = JSON.parse(text); }
  catch { return privateJSON({ error: "Invalid JSON" }, 400); }
  const input = parseFollowUpRetryInput(body);
  if (!input) return privateJSON({ error: "Invalid retry input" }, 400);
  console.info("bff.follow_up.retry attempt", { sourceId, jobId });
  try {
    const response = await fetch(daemonURL(`/sources/${encodeURIComponent(sourceId)}/follow-ups/${encodeURIComponent(jobId)}/retry`), {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 409) {
      const error: unknown = await response.json();
      if (typeof error !== "object" || error === null || !("error" in error) || error.error !== "retry_conflict") throw new Error("Unconfirmed conflict");
      console.info("bff.follow_up.retry declined", { sourceId, jobId, status: 409 });
      return privateJSON({ error: "retry_conflict" }, 409);
    }
    if (response.status !== 202) throw new Error("Unconfirmed retry");
    const value = parseFollowUpRetryReceipt(await response.json());
    if (!value || value.sourceId !== sourceId || value.jobId !== jobId || value.expectedRunId !== input.expectedRunId) throw new Error("Invalid retry receipt");
    console.info("bff.follow_up.retry accepted", { sourceId, jobId });
    return privateJSON(value, 202);
  } catch {
    console.warn("bff.follow_up.retry unconfirmed", { sourceId, jobId });
    return privateJSON({ error: "retry_unconfirmed" }, 503);
  }
}
