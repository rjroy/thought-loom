import "server-only";
import { isAllowedRequestOrigin, isIdempotencyKey, isRecordId, parseThoughtTitle } from "@thoughtloom/contracts";
import { daemonURL, privateJSON, readProjection } from "./daemon";
import { parseTitleInput, parseTitleView, type TitleTarget } from "./title-client";

export function readThoughtTitle(id: string, target: TitleTarget) {
  const query = target.kind === "item" ? `?${new URLSearchParams({ itemId: target.itemId, versionId: target.versionId })}` : "";
  return readProjection("bff.title.read", `/sources/${encodeURIComponent(id)}/title${query}`, parseTitleView);
}
export async function titleCommand(request: Request, id: string): Promise<Response> {
  if (!isAllowedRequestOrigin(request)) return privateJSON({ error: "Cross-origin mutation is not allowed" }, 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") return privateJSON({ error: "Cross-site mutation is not allowed" }, 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return privateJSON({ error: "JSON required" }, 415);
  const key = request.headers.get("idempotency-key");
  if (!isRecordId(id) || !isIdempotencyKey(key)) return privateJSON({ error: "invalid_input" }, 400);
  let body: unknown;
  try { const text = await request.text(); if (new TextEncoder().encode(text).length > 4096) return privateJSON({ error: "invalid_input" }, 413); body = JSON.parse(text); }
  catch { return privateJSON({ error: "invalid_input" }, 400); }
  const input = parseTitleInput(body);
  if (!input) return privateJSON({ error: "invalid_input" }, 400);
  console.info("bff.title.edit attempt", { sourceId: id });
  try {
    const response = await fetch(daemonURL(`/sources/${encodeURIComponent(id)}/title`), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(input), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000) });
    const value: unknown = await response.json();
    if ([400, 404, 409].includes(response.status)) {
      const code = typeof value === "object" && value !== null && "error" in value ? value.error : null;
      const valid = (response.status === 400 && code === "invalid_input") || (response.status === 404 && code === "invalid_reference") || (response.status === 409 && (code === "version_conflict" || code === "operation_conflict"));
      if (!valid) throw new Error("Unverified decline");
      console.info("bff.title.edit declined", { sourceId: id, status: response.status }); return privateJSON({ error: code }, response.status);
    }
    const receipt = parseThoughtTitle(value);
    if (response.status !== 200 || !receipt || receipt.author !== "user" || receipt.text !== input.text) throw new Error("Invalid title receipt");
    console.info("bff.title.edit acknowledged", { sourceId: id }); return privateJSON(receipt, 200);
  } catch { console.warn("bff.title.edit unconfirmed", { sourceId: id }); return privateJSON({ error: "title_unconfirmed" }, 503); }
}
