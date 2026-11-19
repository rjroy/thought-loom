import type { DaemonRequest } from "./daemon";
import { exact, id, nonempty, nonnegative, readBounded, record, timestamp } from "./search-sessions";
import { publicRun, validRun } from "../features/evolve/validation";

type Kind = "create" | "read" | "saves" | "send" | "turn-key" | "continue" | "keep" | "save-key";
type Operation = { kind: Kind; path: string; sessionId?: string; turnId?: string; key?: string; limit?: number; receiptView?: boolean };
const headers = { "cache-control": "private, no-store" };
const problem = (status: number, code?: string) => Response.json({
  message: status === 400 ? "Invalid request." : status === 403 ? "Forbidden." : status === 404 ? "Unavailable." : "Unable to confirm outcome.",
  ...(code ? { code } : {}),
}, { status, headers });
const keyValid = (value: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(value) && value !== "." && value !== "..";
const statuses = ["pending", "queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"];

function operation(request: Request): Operation | null {
  const url = new URL(request.url);
  const parts = url.pathname.split("/");
  if (parts[1] !== "api" || parts[2] !== "evolve-sessions") return null;
  if (parts.length === 3 && request.method === "POST") return url.search ? null : { kind: "create", path: "/evolve-sessions" };
  const sessionId = parts[3];
  if (!sessionId || !id(sessionId)) return null;
  const base = `/evolve-sessions/${sessionId}`;
  if (parts.length === 4 && request.method === "GET") {
    const paging = pageQuery(url, "before");
    return paging ? { kind: "read", path: `${base}${paging.query}`, sessionId, limit: paging.limit } : null;
  }
  if (parts.length === 7 && parts[4] === "turns" && id(parts[5]) && parts[6] === "saves" && request.method === "GET") {
    const paging = pageQuery(url, "after");
    return paging ? { kind: "saves", path: `${base}/turns/${parts[5]}/saves${paging.query}`, sessionId, turnId: parts[5], limit: paging.limit } : null;
  }
  if (parts[4] === "turns" && ((parts.length === 5 && request.method === "POST") ||
      (parts.length === 7 && parts[5] === "by-key" && request.method === "GET"))) {
    if (url.search && (url.searchParams.size !== 1 || url.searchParams.get("view") !== "receipt")) return null;
    const receiptView = url.search !== "";
    const suffix = receiptView ? "?view=receipt" : "";
    if (parts.length === 5) return { kind: "send", path: `${base}/turns${suffix}`, sessionId, receiptView };
    const key = decodeKey(parts[6]);
    return key ? { kind: "turn-key", path: `${base}/turns/by-key/${key}${suffix}`, sessionId, key, receiptView } : null;
  }
  if (url.search) return null;
  if (parts.length === 5 && parts[4] === "continuation" && request.method === "PUT") return { kind: "continue", path: `${base}/continuation`, sessionId };
  if (parts[4] !== "turns") return null;
  const turnId = parts[5];
  if (!turnId || !id(turnId) || parts[6] !== "saves") return null;
  if (parts.length === 7 && request.method === "POST") return { kind: "keep", path: `${base}/turns/${turnId}/saves`, sessionId, turnId };
  if (parts.length === 9 && parts[7] === "by-key" && request.method === "GET") {
    const key = decodeKey(parts[8]);
    return key ? { kind: "save-key", path: `${base}/turns/${turnId}/saves/by-key/${key}`, sessionId, turnId, key } : null;
  }
  return null;
}
function pageQuery(url: URL, cursorName: "before" | "after"): { query: string; limit: number } | null {
  const params = url.searchParams;
  if ([...params.keys()].some(name => name !== "limit" && name !== cursorName) ||
      params.getAll("limit").length > 1 || params.getAll(cursorName).length > 1) return null;
  const requested = params.get("limit"), cursor = params.get(cursorName);
  if ((cursor !== null && (requested === null || !id(cursor))) ||
      (requested !== null && (!/^(?:[1-9]|1[0-9]|20)$/.test(requested)))) return null;
  const limit = requested === null ? 20 : Number(requested);
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== null) query.set(cursorName, cursor);
  return { query: `?${query}`, limit };
}
function decodeKey(value: string | undefined): string | null {
  try { const key = decodeURIComponent(value ?? ""); return keyValid(key) ? key : null; } catch { return null; }
}
function session(value: unknown, expected?: string): boolean {
  return record(value) && exact(value, ["id", "anchorThoughtId", "continuationThoughtId", "mode", "createdAt"]) &&
    id(value.id) && (!expected || value.id === expected) && id(value.anchorThoughtId) && id(value.continuationThoughtId) &&
    value.mode === "ideas-only" && timestamp(value.createdAt);
}
function save(value: unknown): boolean {
  if (!record(value)) return false;
  const keys = ["thoughtId", "parentId", "speaker", "text", "selectedBy", "source", "start"];
  if (value.sourceTurnId !== undefined) keys.push("sourceTurnId");
  return exact(value, keys) && id(value.thoughtId) && id(value.parentId) && nonempty(value.text) &&
    (value.speaker === "user" || value.speaker === "ai") && (value.selectedBy === "user" || value.selectedBy === "ai") &&
    (value.source === "passage" ? nonnegative(value.start) : value.source === "synthesis" && value.start === null && value.sourceTurnId === undefined) &&
    (value.sourceTurnId === undefined || id(value.sourceTurnId));
}
function turn(value: unknown, paged = false): boolean {
  return record(value) && exact(value, ["id", "parentId", "text", "status", "admittedAt", "runId", "reply", "saves",
    ...(paged ? ["savesHasMore", "savesNextAfter"] : [])]) &&
    id(value.id) && id(value.parentId) && nonempty(value.text) && typeof value.status === "string" && statuses.includes(value.status) &&
    timestamp(value.admittedAt) && (value.runId === null || id(value.runId)) &&
    (value.reply === null || typeof value.reply === "string") && Array.isArray(value.saves) && value.saves.every(save) &&
    (!paged || (typeof value.savesHasMore === "boolean" && (value.savesNextAfter === null || id(value.savesNextAfter))));
}
function result(value: unknown, op: Operation): boolean {
  if (!record(value)) return false;
  if (op.kind === "create" || op.kind === "continue") return exact(value, ["session"]) && session(value.session, op.sessionId);
  if (op.kind === "read") return exact(value, ["session", "turns", "nextBefore"]) && session(value.session, op.sessionId) &&
    Array.isArray(value.turns) && value.turns.length <= (op.limit ?? 20) && value.turns.every(item => turn(item, true)) &&
    (value.nextBefore === null || id(value.nextBefore));
  if (op.kind === "saves") return exact(value, ["saves", "nextAfter"]) && Array.isArray(value.saves) &&
    value.saves.length <= (op.limit ?? 20) && value.saves.every(save) && (value.nextAfter === null || id(value.nextAfter));
  if (op.kind === "keep" || op.kind === "save-key") return exact(value, ["receipt"]) && save(value.receipt) &&
    record(value.receipt) && value.receipt.selectedBy === "user" && value.receipt.source === "passage";
  if (!exact(value, ["receipt", "turn", "run"]) || !record(value.receipt) || !turn(value.turn) || !record(value.turn)) return false;
  return (!op.receiptView || (Array.isArray(value.turn.saves) && value.turn.saves.length === 0)) &&
    exact(value.receipt, ["sessionId", "turnId", "admittedAt"]) && value.receipt.sessionId === op.sessionId &&
    value.receipt.turnId === value.turn.id && value.receipt.admittedAt === value.turn.admittedAt &&
    (value.run === null ? value.turn.runId === null : validRun(value.run) && value.run.responseId === null && value.run.id === value.turn.runId);
}

/** Fixed-purpose boundary; production wrapper supplies the request guard and server credentials. */
export async function handleEvolveSession(request: Request, callDaemon: (request: DaemonRequest) => Promise<Response>): Promise<Response> {
  const op = operation(request);
  if (!op) return problem(400);
  const keyed = op.kind === "send" || op.kind === "keep";
  const key = request.headers.get("idempotency-key");
  if (keyed && (!key || !keyValid(key))) return problem(400);
  let body: string | undefined;
  if (["create", "send", "continue", "keep"].includes(op.kind)) {
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(request.headers.get("content-type") ?? "")) return problem(415);
    try {
      const raw = await readBounded(request.body, op.kind === "send" ? 28672 : op.kind === "keep" ? 102400 : 4096);
      if (raw === null) return problem(413);
      // All accepted fields are strings. This also rejects duplicate and escaped duplicate keys.
      if (!/^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*")*\s*\}\s*$/.test(raw)) return problem(400);
      const input: unknown = JSON.parse(raw);
      const fields = op.kind === "create" ? ["anchorThoughtId"] : op.kind === "continue" ? ["thoughtId"] : op.kind === "send" ? ["parentId", "text"] : ["speaker", "text", "parentId"];
      if (record(input) && (op.kind === "continue" || op.kind === "send") && Object.hasOwn(input, "expectedContinuationThoughtId")) {
        fields.push("expectedContinuationThoughtId");
      }
      if (!record(input) || !exact(input, fields) || !fields.every(field => nonempty(input[field])) ||
          (op.kind === "keep" && input.speaker !== "user" && input.speaker !== "ai")) return problem(400);
      // Reject duplicate keys independently of JSON.parse's last-value behavior.
      const names = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*"(?:[^"\\]|\\.)*"/g)].map(match => JSON.parse(`"${match[1]}"`) as string);
      if (names.length !== fields.length || new Set(names).size !== names.length) return problem(400);
      body = JSON.stringify(input);
    } catch { return problem(400); }
  }
  try {
    const response = await callDaemon({ method: request.method as DaemonRequest["method"], path: op.path, body,
      ...(keyed && key ? { idempotencyKey: key } : {}), preserveErrorBody: true });
    if (!response.ok) {
      if (![400, 403, 404, 409, 413, 415, 503].includes(response.status)) return problem(502);
      const raw = await readBounded(response.body, 4096);
      if (raw === null) return problem(502);
      let code: string | undefined;
      try {
        const value: unknown = JSON.parse(raw);
        if (record(value) && typeof value.code === "string" && ["idempotency-conflict", "turn-active", "invalid-continuation", "invalid-passage", "stale-continuation"].includes(value.code)) code = value.code;
      } catch { /* Do not expose upstream error text. */ }
      return problem(response.status, code);
    }
    const expected = op.kind === "create" ? [201] : keyed ? [200, 201] : [200];
    if (!expected.includes(response.status)) return problem(502);
    const raw = await readBounded(response.body, 4 * 1024 * 1024);
    if (raw === null) return problem(502);
    const value: unknown = JSON.parse(raw);
    if (!result(value, op)) return problem(502);
    if (record(value) && validRun(value.run)) value.run = publicRun(value.run);
    return Response.json(value, { status: response.status, headers });
  } catch { return problem(502); }
}
