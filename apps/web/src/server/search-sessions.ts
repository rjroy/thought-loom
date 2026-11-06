import { requestDaemon, type DaemonDependencies, type DaemonRequest } from "./daemon";
import type { WebConfig } from "./config";
import { isTrustedRequest } from "./request-guard";
import { clientClock } from "./search-clock";

type Dependencies = DaemonDependencies & { readonly config: WebConfig };
type Operation = { readonly path: string; readonly kind: "catalog" | "create" | "detail" | "rename" | "delete" | "open" | "refresh" | "discard"; readonly sessionId?: string; readonly composerId?: string };
export const headers = { "cache-control": "private, no-store" };
export const problem = (status: number, code?: string) => Response.json({ message: status === 403 ? "Forbidden." : status === 400 ? "Invalid request." : "Unable to confirm outcome.", ...(code ? {code} : {}) }, {status,headers});
export const safeId = (value: string): boolean => /^[A-Za-z0-9_~.-]+$/.test(value) && value !== "." && value !== ".." && value.length <= 256;
export const record = (value: unknown): value is Record<string,unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const exact = (value: Record<string,unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
export const id = (value: unknown): value is string => typeof value === "string" && safeId(value);
export const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.isWellFormed() && !value.includes("\0");
export const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value;
};

export function session(value: unknown, expected?: string): boolean {
  return record(value) && exact(value,["id","title","createdAt","lastActivityAt","revision"]) && id(value.id) && (expected === undefined || value.id === expected) &&
    nonempty(value.title) && timestamp(value.createdAt) && timestamp(value.lastActivityAt) && nonnegative(value.revision);
}
export function run(value: unknown, sessionId: string, activeOnly = true): boolean {
  return record(value) && exact(value,["id","kind","status","searchSessionId","userMessageId","assistantMessageId","outcomeReason","cancellation"]) &&
    id(value.id) && value.kind === "search" && value.searchSessionId === sessionId && id(value.userMessageId) &&
    (value.assistantMessageId === null || id(value.assistantMessageId)) && typeof value.status === "string" &&
    (activeOnly ? ["queued","submitting","running","uncertain"] : ["queued","submitting","running","uncertain","completed","interrupted","failed"]).includes(value.status) &&
    (value.outcomeReason === null || value.outcomeReason === "stopped" || value.outcomeReason === "context-invalidated" || value.outcomeReason === "failed") &&
    (value.cancellation === "none" || value.cancellation === "pending" || value.cancellation === "settled");
}
function composer(value: unknown, expected?: string): boolean {
  return record(value) && exact(value,["composerId","contextToken","eligibilityRevision"]) && id(value.composerId) &&
    (expected === undefined || value.composerId === expected) && nonempty(value.contextToken) && value.contextToken.length <= 16384 && nonnegative(value.eligibilityRevision);
}
function validResult(value: unknown, op: Operation): boolean {
  if (!record(value)) return false;
  if (op.kind === "catalog") return exact(value,["items","nextCursor"]) && Array.isArray(value.items) && value.items.every(item => session(item)) &&
    (value.nextCursor === null || (nonempty(value.nextCursor) && value.nextCursor.length <= 2048));
  if (op.kind === "create" || op.kind === "rename") return exact(value,["session"]) && session(value.session,op.sessionId);
  if (op.kind === "detail") return exact(value,["session","activeRun","eligibilityRevision"]) && session(value.session,op.sessionId) &&
    !!op.sessionId && (value.activeRun === null || run(value.activeRun,op.sessionId)) && nonnegative(value.eligibilityRevision);
  if (op.kind === "open" || op.kind === "refresh") return composer(value,op.composerId);
  return false;
}
function operation(request: Request): Operation | null {
  const url = new URL(request.url), parts = url.pathname.split("/");
  if (parts[1] !== "api" || parts[2] !== "search-sessions") return null;
  const method = request.method, sessionId = parts[3], composerId = parts[5];
  let kind: Operation["kind"], path = "/search-sessions";
  if (parts.length === 3 && method === "GET") kind = "catalog";
  else if (parts.length === 3 && method === "POST") kind = "create";
  else if (sessionId && safeId(sessionId)) {
    path += `/${sessionId}`;
    if (parts.length === 4 && method === "GET") kind = "detail";
    else if (parts.length === 4 && method === "PATCH") kind = "rename";
    else if (parts.length === 4 && method === "DELETE") kind = "delete";
    else if (parts[4] === "composer-contexts" && parts.length === 5 && method === "POST") { kind = "open"; path += "/composer-contexts"; }
    else if (parts[4] === "composer-contexts" && parts.length === 6 && composerId && safeId(composerId) && (method === "GET" || method === "DELETE")) {
      kind = method === "GET" ? "refresh" : "discard"; path += `/composer-contexts/${composerId}`;
    } else return null;
  } else return null;
  const query = new URLSearchParams();
  for (const [name,value] of url.searchParams) {
    if (kind !== "catalog" || !["limit","cursor"].includes(name) || query.has(name)) return null;
    if (name === "limit" && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 200)) return null;
    if (name === "cursor" && (!value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))) return null;
    query.set(name,value);
  }
  return {path:path + (query.size ? `?${query}` : ""),kind,...(sessionId ? {sessionId} : {}),...(composerId ? {composerId} : {})};
}
export async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0, complete = false;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) { complete = true; break; }
      size += part.value.byteLength; if (size > limit) return null; chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  } finally { if (!complete) await reader.cancel(); reader.releaseLock(); }
}
function requestBody(raw: string, kind: Operation["kind"]): string | null {
  if (kind === "create" || kind === "open") return /^\s*\{\s*\}\s*$/.test(raw) ? "{}" : null;
  if (kind !== "rename") return raw === "" ? "" : null;
  // Exactly one string member: this rejects duplicate keys even when escaped.
  if (!/^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/.test(raw)) return null;
  const value: unknown = JSON.parse(raw);
  return record(value) && exact(value,["title"]) && nonempty(value.title) ? JSON.stringify({title:value.title}) : null;
}

export function createSearchSessionBoundary(deps: Dependencies): (request: Request) => Promise<Response> {
  return async request => {
    if (!isTrustedRequest(deps.config,request)) return problem(403);
    const clock = clientClock(request.headers); if (!clock.valid) return problem(400);
    const op = operation(request); if (!op) return problem(400);
    const key = request.headers.get("idempotency-key"), revision = request.headers.get("if-match");
    if (op.kind === "create" && (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))) return problem(400);
    if (op.kind === "rename" && (!revision || !/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision)))) return problem(400);
    let body: string | undefined;
    try {
      if (["create","rename","open","delete","discard"].includes(op.kind)) {
        if (["create","rename","open"].includes(op.kind) && !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(request.headers.get("content-type") ?? "")) return problem(400);
        const raw = await readBounded(request.body,4096); if (raw === null) return problem(413);
        const parsed = requestBody(raw,op.kind); if (parsed === null) return problem(400);
        if (op.kind !== "delete" && op.kind !== "discard") body = parsed;
      }
    } catch { return problem(400); }
    try {
      const outgoing: DaemonRequest = {path:op.path,method:request.method as DaemonRequest["method"],body,preserveErrorBody:true,clientClock:clock.value,
        ...(op.kind === "create" && key ? {idempotencyKey:key} : {}),...(op.kind === "rename" && revision ? {ifMatch:revision} : {})};
      const upstream = await requestDaemon(deps.config,outgoing,deps);
      if (!upstream.ok) {
        if (![400,403,404,409,413,415,503].includes(upstream.status)) return problem(502);
        const raw = await readBounded(upstream.body,4096);
        if (raw === null) return problem(502);
        let code: string | undefined;
        try { const value: unknown = JSON.parse(raw); if (record(value) && typeof value.code === "string" && ["invalid-search-request","search-session-not-found","search-composer-not-found","session-deleted","revision-conflict","list-changed","context-changed","native-cleanup-required"].includes(value.code)) code = value.code; } catch { /* Never return untrusted error text. */ }
        return problem(upstream.status,code);
      }
      if (op.kind === "delete" || op.kind === "discard") return upstream.status === 204 ? new Response(null,{status:204,headers}) : problem(502);
      const expected = op.kind === "create" ? [200,201] : op.kind === "open" ? [201] : [200];
      if (!expected.includes(upstream.status)) return problem(502);
      const raw = await readBounded(upstream.body,1024*1024); if (raw === null) return problem(502);
      const value: unknown = JSON.parse(raw); if (!validResult(value,op)) return problem(502);
      return Response.json(value,{status:upstream.status,headers});
    } catch { return problem(502); }
  };
}
