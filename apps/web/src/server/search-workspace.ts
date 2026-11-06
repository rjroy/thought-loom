import { requestDaemon, type DaemonDependencies, type DaemonRequest } from "./daemon";
import type { WebConfig } from "./config";
import { isTrustedRequest } from "./request-guard";
import { clientClock, validClock } from "./search-clock";
import { headers, problem, safeId, record, exact, id, nonnegative, nonempty, timestamp, session, run, readBounded } from "./search-sessions";

type Dependencies = DaemonDependencies & {readonly config: WebConfig};
type Operation = {readonly path: string; readonly kind: "messages" | "discoveries" | "preview" | "remove" | "turn" | "by-key" | "check" | "stop";
  readonly sessionId?: string; readonly composerId?: string; readonly thoughtId?: string; readonly runId?: string; readonly history?: boolean};
const token = (v: unknown): v is string => nonempty(v) && v.length <= 16384;
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(id) && new Set(v).size === v.length;
const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const titleAuthor = (v: unknown) => v === null || v === "user" || v === "ai";
const author = (v: unknown) => v === "user" || v === "ai" || v === "source";
const material = (v: unknown) => typeof v === "string" && ["captured-original","user-contribution","ai-interpretation","developing-idea","imported-original"].includes(v);
function thoughtSummary(v: unknown): boolean {
  return record(v) && exact(v,["id","title","titleAuthor","author","kind","createdAt"]) && id(v.id) && nonempty(v.title) && titleAuthor(v.titleAuthor) && author(v.author) && material(v.kind) && timestamp(v.createdAt);
}
function thought(v: unknown, expected: string): boolean {
  return record(v) && exact(v,["id","text","title","titleAuthor","author","kind","createdAt","origin","parentId","sourceIds"]) && v.id === expected &&
    nonempty(v.text) && (v.title === null || nonempty(v.title)) && titleAuthor(v.titleAuthor) && author(v.author) && material(v.kind) && timestamp(v.createdAt) && nonempty(v.origin) && (v.parentId === null || id(v.parentId)) && ids(v.sourceIds);
}
function message(v: unknown, history: boolean): boolean {
  return record(v) && exact(v,["id","runId","position","role","text","createdAt","disposition","evidenceThoughtIds","availability"]) && id(v.id) && id(v.runId) && nonnegative(v.position) &&
    (v.role === "user" || v.role === "assistant") && (history ? nonempty(v.text) : v.text === null || nonempty(v.text)) && timestamp(v.createdAt) &&
    (v.disposition === null || v.disposition === "done" || v.disposition === "awaiting-user") && ids(v.evidenceThoughtIds) &&
    (v.availability === "available" || v.availability === "context-unavailable") &&
    (history || v.availability === "available" || (v.text === null && v.evidenceThoughtIds.length === 0));
}
function discovery(v: unknown, history: boolean): boolean {
  return record(v) && exact(v,["id","position","addedAt","removedAt","thought","why","evidenceThoughtIds","availability","reasonStatus"]) && id(v.id) && nonnegative(v.position) && timestamp(v.addedAt) &&
    (v.removedAt === null || (history && timestamp(v.removedAt))) && (history ? thoughtSummary(v.thought) : v.thought === null || thoughtSummary(v.thought)) &&
    (history ? nonempty(v.why) : v.why === null || nonempty(v.why)) && ids(v.evidenceThoughtIds) &&
    (v.availability === "available" || v.availability === "thought-unavailable") && (v.reasonStatus === "available" || v.reasonStatus === "context-unavailable") &&
    (history || v.availability === "available" || (v.thought === null && v.why === null && v.evidenceThoughtIds.length === 0)) &&
    (history || v.reasonStatus === "available" || (v.why === null && v.evidenceThoughtIds.length === 0));
}
function control(v: unknown, expectedSession: string): boolean {
  if (!record(v) || !exact(v,["receipt","run","session"]) || !record(v.receipt) || !record(v.run) || !session(v.session,expectedSession) || !run(v.run,expectedSession,false)) return false;
  const r = v.receipt;
  return exact(r,["searchSessionId","runId","userMessageId","admittedAt"]) && r.searchSessionId === expectedSession && r.runId === v.run.id && r.userMessageId === v.run.userMessageId && timestamp(r.admittedAt);
}
function result(value: unknown, op: Operation): boolean {
  if (op.kind === "check" || op.kind === "stop") return record(value) && id(value.searchSessionId) && value.id === op.runId && run(value,value.searchSessionId,false);
  if (op.kind === "turn" || op.kind === "by-key") return !!op.sessionId && control(value,op.sessionId);
  if (!record(value)) return false;
  if (op.kind === "preview") return exact(value,["thought","sessionRevision","eligibilityRevision","composerId","contextToken"]) && !!op.thoughtId && thought(value.thought,op.thoughtId) && value.composerId === op.composerId && nonnegative(value.sessionRevision) && nonnegative(value.eligibilityRevision) && token(value.contextToken);
  const pageKeys = op.history ? ["items","nextCursor"] : ["items","nextCursor","sessionRevision","eligibilityRevision","composerId","contextToken"];
  if (!exact(value,pageKeys) || !Array.isArray(value.items) || !(value.nextCursor === null || token(value.nextCursor))) return false;
  if (!value.items.every(item => op.kind === "messages" ? message(item,!!op.history) : discovery(item,!!op.history))) return false;
  return !!op.history || (value.composerId === op.composerId && token(value.contextToken) && nonnegative(value.sessionRevision) && nonnegative(value.eligibilityRevision));
}
function operation(request: Request): Operation | null {
  const url = new URL(request.url), p = url.pathname.split("/"), method = request.method;
  let op: Operation;
  if (p[1] === "api" && p[2] === "search-runs" && p[3] && safeId(p[3])) {
    if (p.length === 4 && method === "GET") op = {kind:"check",runId:p[3],path:`/runs/${p[3]}`};
    else if (p.length === 5 && p[4] === "stop" && method === "POST") op = {kind:"stop",runId:p[3],path:`/runs/${p[3]}/stop`}; else return null;
  } else if (p[1] === "api" && p[2] === "search-sessions" && p[3] && safeId(p[3])) {
    const sessionId = p[3], base = `/search-sessions/${sessionId}`;
    if (p.length === 5 && (p[4] === "messages" || p[4] === "discoveries") && method === "GET") op = {kind:p[4],sessionId,path:`${base}/${p[4]}`};
    else if (p.length === 6 && p[4] === "discoveries" && p[5] && safeId(p[5]) && method === "DELETE") op = {kind:"remove",sessionId,path:`${base}/discoveries/${p[5]}`};
    else if (p.length === 8 && p[4] === "composer-contexts" && p[5] && safeId(p[5]) && p[6] === "thoughts" && p[7] && safeId(p[7]) && method === "GET") op = {kind:"preview",sessionId,composerId:p[5],thoughtId:p[7],path:`${base}/composer-contexts/${p[5]}/thoughts/${p[7]}`};
    else if (p.length === 5 && p[4] === "turns" && method === "POST") op = {kind:"turn",sessionId,path:`${base}/turns`};
    else if (p.length === 7 && p[4] === "turns" && p[5] === "by-key" && p[6] && method === "GET") {
      let key: string;
      try { key = decodeURIComponent(p[6]); } catch { return null; }
      if (!keyPattern.test(key)) return null;
      op = {kind:"by-key",sessionId,path:`${base}/turns/by-key/${key}`};
    }
    else return null;
  } else return null;
  const query = new URLSearchParams(), page = op.kind === "messages" || op.kind === "discoveries";
  for (const [name,value] of url.searchParams) {
    if (!page || !["scope","composerId","limit","cursor"].includes(name) || query.has(name)) return null;
    if (name === "limit" && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 200)) return null;
    if (name === "cursor" && (!value || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value))) return null;
    if (name === "composerId" && !safeId(value)) return null;
    if (name === "scope" && value !== "normal" && value !== "history") return null;
    query.set(name,value);
  }
  if (page) {
    const history = query.get("scope") === "history", composerId = query.get("composerId");
    if (history ? composerId !== null : composerId === null) return null;
    op = {...op,history,...(composerId === null ? {} : {composerId})};
  }
  return {...op,path:op.path + (query.size ? `?${query}` : "")};
}
function noDuplicateKeys(input: string): boolean {
  const stack: (Set<string> | null)[] = [], tokens = input.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "{") stack.push(new Set()); else if (t === "[") stack.push(null); else if (t === "}" || t === "]") stack.pop();
    else if (t?.startsWith('"') && tokens[i+1] === ":") { const keys = stack.at(-1), key: string = JSON.parse(t); if (!keys || keys.has(key)) return false; keys.add(key); }
  }
  return true;
}
function turnInput(v: unknown): boolean {
  if (!record(v) || Object.keys(v).some(k => !["text","startingThoughtIds","requestClock","effort","contextMode","composerId","contextToken"].includes(k)) || !nonempty(v.text) || !id(v.composerId) || !token(v.contextToken) || !record(v.requestClock) || !exact(v.requestClock,["at","timeZone"]) || typeof v.requestClock.at !== "string" || typeof v.requestClock.timeZone !== "string" || !validClock({at:v.requestClock.at,timeZone:v.requestClock.timeZone})) return false;
  return (v.startingThoughtIds === undefined || ids(v.startingThoughtIds)) && (v.effort === undefined || v.effort === "quick" || v.effort === "standard" || v.effort === "thorough") && (v.contextMode === undefined || v.contextMode === "continue" || v.contextMode === "restart");
}
export function createSearchWorkspaceBoundary(deps: Dependencies): (request: Request) => Promise<Response> {
  return async request => {
    if (!isTrustedRequest(deps.config,request)) return problem(403);
    const op = operation(request), clock = clientClock(request.headers);
    if (!op || !clock.valid) return problem(400);
    const key = request.headers.get("idempotency-key");
    if (op.kind === "turn" && (!key || !keyPattern.test(key))) return problem(400);
    let body: string | undefined;
    try {
      if (op.kind === "turn" || op.kind === "stop" || op.kind === "remove") {
        if (op.kind !== "remove" && !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(request.headers.get("content-type") ?? "")) return problem(400);
        const raw = await readBounded(request.body,4096); if (raw === null) return problem(413);
        if (op.kind === "remove") { if (raw !== "") return problem(400); }
        else { const value: unknown = JSON.parse(raw); if (!noDuplicateKeys(raw) || (op.kind === "stop" ? !record(value) || !exact(value,[]) : !turnInput(value))) return problem(400); body = raw; }
      }
    } catch { return problem(400); }
    try {
      if (op.kind === "stop") {
        const check = await requestDaemon(deps.config,{path:`/runs/${op.runId}`,method:"GET",clientClock:clock.value},deps);
        if (check.status === 404) return problem(404);
        if (check.status !== 200) return problem(502);
        const raw = await readBounded(check.body,1024*1024); if (raw === null || !result(JSON.parse(raw),{...op,kind:"check"})) return problem(502);
      }
      const outgoing: DaemonRequest = {path:op.path,method:request.method as DaemonRequest["method"],body,clientClock:clock.value,preserveErrorBody:true,...(op.kind === "turn" && key ? {idempotencyKey:key} : {})};
      const upstream = await requestDaemon(deps.config,outgoing,deps);
      if (!upstream.ok) {
        if (![400,403,404,409,413,415,503].includes(upstream.status)) return problem(502);
        const raw = await readBounded(upstream.body,4096); if (raw === null) return problem(502);
        let code: string | undefined;
        try { const value: unknown = JSON.parse(raw); if (record(value) && typeof value.code === "string" && ["invalid-search-request","search-session-not-found","search-turn-not-found","search-composer-not-found","search-thought-not-found","search-discovery-not-found","context-changed","idempotency-conflict","turn-active","agents-not-configured"].includes(value.code)) code = value.code; } catch { /* Error text is never forwarded. */ }
        return problem(upstream.status,code);
      }
      if (op.kind === "remove") {
        const revision = upstream.headers.get("search-session-revision");
        if (upstream.status !== 204 || !revision || !/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) return problem(502);
        return new Response(null,{status:204,headers:{...headers,"search-session-revision":revision}});
      }
      if (!(op.kind === "turn" ? [200,201].includes(upstream.status) : upstream.status === 200)) return problem(502);
      // Workspace content has no daemon text-size contract; JSON escaping can exceed any fixed byte cap.
      let value: unknown;
      if (op.kind === "messages" || op.kind === "discoveries" || op.kind === "preview") value = await upstream.json();
      else { const raw = await readBounded(upstream.body,1024*1024); if (raw === null) return problem(502); value = JSON.parse(raw); }
      if (!result(value,op)) return problem(502);
      return Response.json(value,{status:upstream.status,headers});
    } catch { return problem(502); }
  };
}
