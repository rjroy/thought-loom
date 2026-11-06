import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";

type Attempt = { method: string; path: string; authorization: string | undefined; key: string | undefined; match: string | undefined; body: string; clockTime?: string; clockZone?: string };
const initialSession = { id: "owned-session-1", title: "Owned saved search", createdAt: "2030-01-01T00:00:00.000Z", lastActivityAt: "2030-01-01T00:00:00.000Z", revision: 0 };
const composer = { composerId: "owned-composer-1", contextToken: "owned-context-token", eligibilityRevision: 0 };
const searchRun = { id: "owned-search-run-1", kind: "search", status: "queued", searchSessionId: initialSession.id, userMessageId: "owned-message-1", assistantMessageId: null, outcomeReason: null, cancellation: "none" };
const turnControl = { receipt: { searchSessionId: initialSession.id, runId: searchRun.id, userMessageId: searchRun.userMessageId, admittedAt: "2030-01-01T00:00:00.000Z" }, run: searchRun, session: initialSession };
const message = { id: searchRun.userMessageId, runId: searchRun.id, position: 0, role: "user", text: "Owned saved message", createdAt: "2030-01-01T00:00:00.000Z", disposition: null, evidenceThoughtIds: [], availability: "available" };
const thought = { id: "owned-thought-1", text: "Owned eligible thought", title: "Owned idea", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "capture", parentId: null, sourceIds: [] };
// A valid thought whose UTF-8 text is below 1 MiB but whose JSON-escaped response exceeds it.
const largeThoughtText = '"\\\n'.repeat(250_000);
const discovery = { id: "owned-entry-1", position: 0, addedAt: "2030-01-01T00:00:00.000Z", removedAt: null,
  thought: { id: thought.id, title: thought.title, titleAuthor: thought.titleAuthor, author: thought.author, kind: thought.kind, createdAt: thought.createdAt },
  why: "Owned rationale", evidenceThoughtIds: [], availability: "available", reasonStatus: "available" };

/** Test-owned HTTP daemon; it records the actual built Next server's boundary calls. */
export function agenticSearchDaemon(token: string) {
  const attempts: Attempt[] = [];
  let session = { ...initialSession }, deleted = false, failReads = false, admitted = false, savedTurnKey: string | undefined, largePreview = false;
  let longMessages = false, unavailable = false, failPages = false, multiPage = false, holdPages = false, activeRun = false;
  let releasePages: (() => void) | undefined;
  let currentComposer = composer.composerId;
  let turnMode: "normal" | "hold" | "unknown" | "context-changed" = "normal", releaseTurn: (() => void) | undefined;
  let fault: "none" | "wrong-composer" | "history-token" | "control-prose" | "wrong-identity" | "ordinary-kind" = "none";
  function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" }).end(JSON.stringify(value));
  }
  return {
    attempts,
    expectedAuthorization: `Bearer ${token}`,
    reset() { releaseTurn?.(); releasePages?.(); releaseTurn = undefined; releasePages = undefined; turnMode = "normal"; currentComposer = composer.composerId; session = { ...initialSession }; deleted = false; attempts.length = 0; failReads = false; failPages = false; multiPage = false; holdPages = false; activeRun = false; admitted = false; savedTurnKey = undefined; largePreview = false; longMessages = false; unavailable = false; fault = "none"; },
    setFailReads(value: boolean) { failReads = value; },
    setFault(value: typeof fault) { fault = value; },
    setLargePreview(value: boolean) { largePreview = value; },
    setLongMessages(value: boolean) { longMessages = value; },
    setUnavailable(value: boolean) { unavailable = value; },
    setFailPages(value: boolean) { failPages = value; },
    setMultiPage(value: boolean) { multiPage = value; },
    setActiveRun(value: boolean) { activeRun = value; },
    holdPages() { holdPages = true; },
    releasePages() { holdPages = false; releasePages?.(); releasePages = undefined; },
    setTurnMode(value: typeof turnMode) { turnMode = value; },
    releaseTurn() { releaseTurn?.(); releaseTurn = undefined; },
    async handler(request: IncomingMessage, response: ServerResponse) {
      let body = ""; for await (const chunk of request) body += String(chunk);
      const method = request.method ?? "", path = request.url ?? "";
      attempts.push({ method, path, authorization: request.headers.authorization, key: request.headers["idempotency-key"] as string | undefined,
        match: request.headers["if-match"] as string | undefined, body,
        ...(request.headers["x-thoughtloom-client-time"] === undefined ? {} : { clockTime: String(request.headers["x-thoughtloom-client-time"]) }),
        ...(request.headers["x-thoughtloom-client-zone"] === undefined ? {} : { clockZone: String(request.headers["x-thoughtloom-client-zone"]) }) });
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      if (method === "GET" && failReads) { response.writeHead(500).end("private-owned-daemon-error"); return; }
      const url = new URL(path, "http://owned.invalid"), base = "/search-sessions";
      if (method === "GET" && url.pathname === `/thoughts/${thought.id}`) { json(response, 200, thought); return; }
      if (method === "GET" && ["children", "connections", "responses"].some(suffix => url.pathname === `/thoughts/${thought.id}/${suffix}`)) { json(response, 200, []); return; }
      if (url.pathname === `/runs/${searchRun.id}` && method === "GET") {
        json(response, 200, fault === "ordinary-kind" ? { ...searchRun, kind: "weave" } : fault === "wrong-identity" ? { ...searchRun, id: "foreign-run" } : fault === "control-prose" ? { ...searchRun, job: "PRIVATE-UNTRUSTED-PROSE" } : searchRun); return;
      }
      if (url.pathname === `/runs/${searchRun.id}/stop` && method === "POST") { json(response, 200, { ...searchRun, status: "interrupted", outcomeReason: "stopped", cancellation: "pending" }); return; }
      if (url.pathname === `${base}/${session.id}/turns` && method === "POST") {
        if (turnMode === "context-changed") { json(response, 409, { error: "Conflict", code: "context-changed" }); return; }
        const status = admitted ? 200 : 201; admitted = true; savedTurnKey = request.headers["idempotency-key"] as string | undefined;
        if (turnMode === "hold") await new Promise<void>(resolve => { releaseTurn = resolve; });
        if (turnMode === "unknown") { response.destroy(); return; }
        json(response, status, fault === "control-prose" ? { ...turnControl, message: "PRIVATE-UNTRUSTED-PROSE" } : fault === "wrong-identity" ? { ...turnControl, receipt: { ...turnControl.receipt, runId: "foreign-run" } } : turnControl); return;
      }
      if (url.pathname.startsWith(`${base}/${session.id}/turns/by-key/`) && method === "GET") {
        const encoded = url.pathname.slice(`${base}/${session.id}/turns/by-key/`.length);
        if (savedTurnKey && decodeURIComponent(encoded) === savedTurnKey) { json(response, 200, turnControl); return; }
        response.writeHead(404).end(); return;
      }
      if ((url.pathname === `${base}/${session.id}/messages` || url.pathname === `${base}/${session.id}/discoveries`) && method === "GET") {
        if (failPages) { response.writeHead(500).end(); return; }
        if (holdPages) await new Promise<void>(resolve => { releasePages = resolve; });
        const second = multiPage && url.searchParams.get("cursor") === "owned-next";
        const items = url.pathname.endsWith("/messages") ? [unavailable ? { ...message, text: null, evidenceThoughtIds: [], availability: "context-unavailable" } : longMessages ? { ...message, ...(second ? { id: "owned-message-2", position: 1 } : {}), text: second ? "Owned older page ".repeat(400) : "Owned saved message ".repeat(400) } : message] :
          [unavailable ? { ...discovery, thought: null, why: null, evidenceThoughtIds: [], availability: "thought-unavailable", reasonStatus: "context-unavailable" } : discovery];
        const page = { items, nextCursor: multiPage && url.pathname.endsWith("/messages") && !second ? "owned-next" : null };
        if (url.searchParams.get("scope") === "history") { json(response, 200, fault === "history-token" ? { ...page, contextToken: "PRIVATE-HISTORY-TOKEN" } : page); return; }
        json(response, 200, { ...page, sessionRevision: 3, eligibilityRevision: 0, composerId: fault === "wrong-composer" ? "foreign-composer" : currentComposer, contextToken: "owned-current-token" }); return;
      }
      if (url.pathname === `${base}/${session.id}/composer-contexts/${composer.composerId}/thoughts/${thought.id}` && method === "GET") {
        json(response, 200, { thought: largePreview ? { ...thought, text: largeThoughtText } : thought, sessionRevision: 3, eligibilityRevision: 0, composerId: fault === "wrong-composer" ? "foreign-composer" : composer.composerId, contextToken: "owned-current-token" }); return;
      }
      if (url.pathname === `${base}/${session.id}/discoveries/${discovery.id}` && method === "DELETE") { response.writeHead(204, { "Search-Session-Revision": "4" }).end(); return; }
      if (url.pathname === base && method === "GET") { json(response, 200, { items: deleted ? [] : [session], nextCursor: null }); return; }
      if (url.pathname === base && method === "POST") { deleted = false; json(response, 201, { session }); return; }
      if (url.pathname === `${base}/${session.id}` && method === "GET") {
        if (deleted) { json(response, 404, { error: "Not found", code: "search-session-not-found" }); return; }
        json(response, 200, { session, activeRun: activeRun ? searchRun : null, eligibilityRevision: 0 }); return;
      }
      if (url.pathname === `${base}/${session.id}` && method === "PATCH") {
        if (request.headers["if-match"] !== String(session.revision)) { json(response, 409, { error: "Conflict", code: "revision-conflict" }); return; }
        const parsed = JSON.parse(body) as { title: string }; session = { ...session, title: parsed.title, revision: session.revision + 1 };
        json(response, 200, { session }); return;
      }
      if (url.pathname === `${base}/${session.id}` && method === "DELETE") { deleted = true; response.writeHead(204).end(); return; }
      if (url.pathname === `${base}/${session.id}/composer-contexts` && method === "POST") {
        if (turnMode === "context-changed") currentComposer = "owned-composer-2";
        json(response, 201, { ...composer, composerId: currentComposer }); return;
      }
      if (url.pathname === `${base}/${session.id}/composer-contexts/${composer.composerId}` && method === "GET") { json(response, 200, composer); return; }
      if (url.pathname === `${base}/${session.id}/composer-contexts/${composer.composerId}` && method === "DELETE") { response.writeHead(204).end(); return; }
      response.writeHead(404).end();
    },
  };
}

type Fixture = ReturnType<typeof agenticSearchDaemon>;
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;

export async function checkAgenticSearchRoutes({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const base = "/api/search-sessions", id = initialSession.id, detail = `${base}/${id}`, contexts = `${detail}/composer-contexts`;
  const before = daemon.attempts.length, body = "{}", content = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nIdempotency-Key: owned-create-key\r\n`;
  assert.ok((await probe("POST", base, content, body)).status >= 400);
  assert.equal((await probe("POST", base, `Host: ${host}\r\n${content}`, body)).status, 403);
  assert.equal((await probe("POST", base, `Host: ${host}\r\nOrigin: http://foreign.invalid\r\n${content}`, body)).status, 403);
  assert.equal((await probe("GET", base, `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
  assert.equal(daemon.attempts.length, before, "untrusted requests must not reach the daemon");
  const read = await fetch(`${origin}${base}?limit=1&cursor=owned-cursor`);
  assert.equal(read.status, 200, "fixed session catalog route must forward a real catalog read");
  assert.match(read.headers.get("cache-control") ?? "", /private.*no-store|no-store.*private/i);
  assert.deepEqual(await read.json(), { items: [initialSession], nextCursor: null });
  assert.equal(daemon.attempts.at(-1)?.path, "/search-sessions?limit=1&cursor=owned-cursor");
  const meta = await fetch(`${origin}${detail}`); assert.equal(meta.status, 200);
  assert.deepEqual(await meta.json(), { session: initialSession, activeRun: null, eligibilityRevision: 0 });
  assert.ok(daemon.attempts.every(item => item.method === "GET"), "catalog and metadata GET must not create anything");
  for (const query of ["?limit=1&limit=2", "?scope=history", "?unknown=1"]) {
    const count = daemon.attempts.length, response = await fetch(`${origin}${base}${query}`);
    assert.equal(response.status, 400); assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.equal(daemon.attempts.length, count);
  }
  async function mutation(path: string, method: string, raw?: string, extra: Record<string, string> = {}) {
    return fetch(`${origin}${path}`, { method, headers: { origin, ...(raw === undefined ? {} : { "content-type": "application/json" }), ...extra }, body: raw });
  }
  for (const raw of ['{"unknown":true}', '{"id":"a","id":"b"}']) {
    const count = daemon.attempts.length, response = await mutation(base, "POST", raw, { "idempotency-key": "owned-create-key" });
    assert.equal(response.status, 400); assert.match(response.headers.get("cache-control") ?? "", /no-store/i); assert.equal(daemon.attempts.length, count);
  }
  const created = await mutation(base, "POST", "{}", { "idempotency-key": "owned-create-key" });
  assert.equal(created.status, 201); assert.deepEqual(await created.json(), { session: initialSession });
  assert.deepEqual(daemon.attempts.at(-1), { method: "POST", path: "/search-sessions", authorization: daemon.expectedAuthorization, key: "owned-create-key", match: undefined, body: "{}" });
  const renamed = await mutation(detail, "PATCH", '{"title":"Owned renamed search"}', { "if-match": "0" });
  assert.equal(renamed.status, 200); assert.equal((await renamed.json()).session.title, "Owned renamed search");
  assert.equal(daemon.attempts.at(-1)?.match, "0"); assert.equal(daemon.attempts.at(-1)?.path, `/search-sessions/${id}`);
  const stale = await mutation(detail, "PATCH", '{"title":"stale"}', { "if-match": "0" });
  assert.equal(stale.status, 409); assert.match(stale.headers.get("cache-control") ?? "", /no-store/i);
  assert.equal((await stale.json()).code, "revision-conflict");
  const invalidMutations: Array<readonly [string, string, string, Record<string, string>]> = [
    [detail, "PATCH", '{"title":"a","title":"b"}', { "if-match": "1" }],
    [detail, "PATCH", '{"title":"a","unknown":true}', { "if-match": "1" }],
    [detail, "PATCH", '{"title":"a"}', {}],
    [contexts, "POST", '{"unknown":true}', {}],
    [detail, "DELETE", "{}", {}],
  ];
  for (const [path, method, raw, headers] of invalidMutations) {
    const count = daemon.attempts.length, response = await mutation(path, method, raw, headers);
    assert.equal(response.status, 400); assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.equal(daemon.attempts.length, count, "invalid fixed-route inputs must not reach daemon");
  }
  const opened = await mutation(contexts, "POST", "{}"); assert.equal(opened.status, 201); assert.deepEqual(await opened.json(), composer);
  const refreshed = await fetch(`${origin}${contexts}/${composer.composerId}`); assert.equal(refreshed.status, 200); assert.deepEqual(await refreshed.json(), composer);
  const discarded = await mutation(`${contexts}/${composer.composerId}`, "DELETE"); assert.equal(discarded.status, 204);
  const removed = await mutation(detail, "DELETE"); assert.equal(removed.status, 204);
  for (const response of [created, renamed, opened, refreshed, discarded, removed]) assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  assert.ok(daemon.attempts.every(item => item.authorization === daemon.expectedAuthorization));
  daemon.setFailReads(true);
  try {
    const failure = await fetch(`${origin}${base}`); assert.equal(failure.status, 502); assert.match(failure.headers.get("cache-control") ?? "", /no-store/i);
    assert.ok(!(await failure.text()).includes("private-owned-daemon-error"));
  } finally { daemon.setFailReads(false); }
}

export async function checkAgenticWorkspaceRoutes({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const base = `/api/search-sessions/${initialSession.id}`, params = `composerId=${composer.composerId}&limit=1`, start = daemon.attempts.length;
  assert.equal((await probe("GET", `${base}/messages?${params}`, `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
  assert.equal(daemon.attempts.length, start);
  const normal = await fetch(`${origin}${base}/messages?${params}`);
  assert.equal(normal.status, 200, "composer-scoped message page must reach the owned daemon");
  assert.match(normal.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await normal.json(), { items: [message], nextCursor: null, sessionRevision: 3, eligibilityRevision: 0, composerId: composer.composerId, contextToken: "owned-current-token" });
  const first = daemon.attempts.at(-1); assert.equal(first?.authorization, daemon.expectedAuthorization);
  const forwarded = new URL(first?.path ?? "", origin);
  assert.equal(forwarded.pathname, `/search-sessions/${initialSession.id}/messages`); assert.equal(forwarded.searchParams.get("composerId"), composer.composerId);
  const discoveries = await fetch(`${origin}${base}/discoveries?${params}`);
  assert.equal(discoveries.status, 200); assert.deepEqual(await discoveries.json(), { items: [discovery], nextCursor: null, sessionRevision: 3, eligibilityRevision: 0, composerId: composer.composerId, contextToken: "owned-current-token" });
  const history = await fetch(`${origin}${base}/messages?scope=history&limit=1`);
  assert.equal(history.status, 200); const historyPage = await history.json();
  assert.deepEqual(historyPage, { items: [message], nextCursor: null }); assert.ok(!Object.hasOwn(historyPage, "contextToken"));
  const discoveryHistory = await fetch(`${origin}${base}/discoveries?scope=history&limit=1`);
  assert.equal(discoveryHistory.status, 200); assert.deepEqual(await discoveryHistory.json(), { items: [discovery], nextCursor: null });
  const previewPath = `${base}/composer-contexts/${composer.composerId}/thoughts/${thought.id}`;
  const preview = await fetch(`${origin}${previewPath}`); assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { thought, sessionRevision: 3, eligibilityRevision: 0, composerId: composer.composerId, contextToken: "owned-current-token" });
  const entry = `${base}/discoveries/${discovery.id}`;
  const noOrigin = await probe("DELETE", entry, `Host: ${host}\r\nContent-Length: 0\r\n`);
  assert.equal(noOrigin.status, 403);
  const remove = await fetch(`${origin}${entry}`, { method: "DELETE", headers: { origin } });
  assert.equal(remove.status, 204); assert.equal(remove.headers.get("search-session-revision"), "4");
  assert.equal(daemon.attempts.at(-1)?.path, `/search-sessions/${initialSession.id}/discoveries/${discovery.id}`);
  for (const path of [`${base}/messages`, `${base}/messages?scope=history&composerId=${composer.composerId}`,
    `${base}/messages?${params}&composerId=duplicate`, `${base}/discoveries?scope=normal&actor=ai`, `${previewPath}?scope=history`]) {
    const before = daemon.attempts.length, invalid = await fetch(`${origin}${path}`);
    assert.equal(invalid.status, 400); assert.match(invalid.headers.get("cache-control") ?? "", /no-store/i);
    assert.equal(daemon.attempts.length, before);
  }
  daemon.setFault("wrong-composer");
  try {
    const invalid = await fetch(`${origin}${base}/messages?${params}`); assert.equal(invalid.status, 502); assert.match(invalid.headers.get("cache-control") ?? "", /no-store/i);
    const invalidPreview = await fetch(`${origin}${previewPath}`); assert.equal(invalidPreview.status, 502);
  }
  finally { daemon.setFault("none"); }
  daemon.setFault("history-token");
  try { const invalid = await fetch(`${origin}${base}/messages?scope=history`); assert.equal(invalid.status, 502); assert.ok(!(await invalid.text()).includes("PRIVATE-HISTORY-TOKEN")); }
  finally { daemon.setFault("none"); }
}

export async function checkAgenticTurnRoutes({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const base = `/api/search-sessions/${initialSession.id}`, path = `${base}/turns`;
  const payload = { text: "Owned exact intent", requestClock: { at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" }, composerId: composer.composerId, contextToken: composer.contextToken };
  const raw = JSON.stringify(payload), key = "owned-turn-key", clockTime = "2035-06-01T05:00:00-07:00", clockZone = "America/Los_Angeles";
  const header = `Host: ${host}\r\nOrigin: http://foreign.invalid\r\nContent-Type: application/json\r\nIdempotency-Key: ${key}\r\nContent-Length: ${Buffer.byteLength(raw)}\r\n`;
  assert.equal((await probe("POST", path, header, raw)).status, 403); assert.equal(daemon.attempts.length, 0);
  const send = (body: string, extra: Record<string,string> = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": key,
    "x-thoughtloom-client-time": clockTime, "x-thoughtloom-client-zone": clockZone, ...extra }, body });
  const admitted = await send(raw);
  assert.equal(admitted.status, 201, "turn admission must return a control-only receipt from the daemon");
  assert.match(admitted.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await admitted.json(), turnControl);
  const attempt = daemon.attempts.at(-1);
  assert.equal(attempt?.authorization, daemon.expectedAuthorization); assert.equal(attempt?.path, `/search-sessions/${initialSession.id}/turns`);
  assert.equal(attempt?.key, key); assert.deepEqual(JSON.parse(attempt?.body ?? "null"), payload);
  assert.equal(attempt?.clockTime, clockTime); assert.equal(attempt?.clockZone, clockZone);
  const replay = await send(raw, { "x-thoughtloom-client-time": "2035-06-01T06:00:00-07:00" });
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), turnControl);
  assert.deepEqual(JSON.parse(daemon.attempts.at(-1)?.body ?? "null"), payload);
  assert.equal(daemon.attempts.at(-1)?.key, key); assert.equal(daemon.attempts.at(-1)?.clockTime, "2035-06-01T06:00:00-07:00");
  const lookup = await fetch(`${origin}${base}/turns/by-key/${key}`, { headers: { "x-thoughtloom-client-time": clockTime, "x-thoughtloom-client-zone": clockZone } });
  assert.equal(lookup.status, 200); const found = await lookup.json(); assert.deepEqual(found, turnControl);
  assert.ok(!JSON.stringify(found).includes(payload.text)); assert.equal(daemon.attempts.at(-1)?.clockTime, clockTime);
  for (const invalid of [JSON.stringify({ ...payload, runId: "caller-owned" }), `${raw.slice(0,-1)},"text":"duplicate"}`]) {
    const before: number = daemon.attempts.length, response = await send(invalid); assert.equal(response.status, 400);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i); assert.equal(daemon.attempts.length, before);
  }
  const invalidClocks: Record<string,string>[] = [{ "x-thoughtloom-client-time": clockTime }, { "x-thoughtloom-client-time": "2035-06-01T12:00:00+09:00", "x-thoughtloom-client-zone": clockZone }];
  for (const clock of invalidClocks) {
    const before: number = daemon.attempts.length;
    const invalid = await fetch(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": key, ...clock }, body: raw });
    assert.equal(invalid.status, 400); assert.match(invalid.headers.get("cache-control") ?? "", /no-store/i); assert.equal(daemon.attempts.length, before);
  }
  daemon.setFault("control-prose");
  try { const invalid = await send(raw); assert.equal(invalid.status, 502); assert.ok(!(await invalid.text()).includes("PRIVATE-UNTRUSTED-PROSE")); }
  finally { daemon.setFault("none"); }
  daemon.setFault("wrong-identity");
  try { const invalid = await send(raw); assert.equal(invalid.status, 502); assert.match(invalid.headers.get("cache-control") ?? "", /no-store/i); }
  finally { daemon.setFault("none"); }
}

export async function checkAgenticRunRoutes({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const path = `/api/search-runs/${searchRun.id}`, stop = `${path}/stop`;
  assert.equal((await probe("POST", stop, `Host: ${host}\r\nOrigin: http://foreign.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n`, "{}")).status, 403);
  assert.equal(daemon.attempts.length, 0);
  const clockTime = "2035-06-01T12:00:00Z", clockZone = "UTC";
  const check = await fetch(`${origin}${path}`, { headers: { "x-thoughtloom-client-time": clockTime, "x-thoughtloom-client-zone": clockZone } });
  assert.equal(check.status, 200, "known search Check must return its validated control DTO");
  assert.match(check.headers.get("cache-control") ?? "", /no-store/i); assert.deepEqual(await check.json(), searchRun);
  assert.equal(daemon.attempts.at(-1)?.path, `/runs/${searchRun.id}`); assert.equal(daemon.attempts.at(-1)?.clockTime, clockTime);
  const stopped = await fetch(`${origin}${stop}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-thoughtloom-client-time": clockTime, "x-thoughtloom-client-zone": clockZone }, body: "{}" });
  assert.equal(stopped.status, 200); assert.match(stopped.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await stopped.json(), { ...searchRun, status: "interrupted", outcomeReason: "stopped", cancellation: "pending" });
  assert.equal(daemon.attempts.at(-1)?.path, `/runs/${searchRun.id}/stop`); assert.equal(daemon.attempts.at(-1)?.authorization, daemon.expectedAuthorization);
  for (const fault of ["ordinary-kind", "wrong-identity", "control-prose"] as const) {
    daemon.setFault(fault); const response = await fetch(`${origin}${path}`); assert.equal(response.status, 502);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i); const text = await response.text();
    assert.ok(!text.includes("foreign-run")); assert.ok(!text.includes("PRIVATE-UNTRUSTED-PROSE"));
  }
  daemon.setFault("none");
  const before = daemon.attempts.length;
  const invalid = await fetch(`${origin}${stop}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: '{"unexpected":true}' });
  assert.equal(invalid.status, 400); assert.equal(daemon.attempts.length, before);
  const malformedClock = await fetch(`${origin}${path}`, { headers: { "x-thoughtloom-client-time": clockTime } });
  assert.equal(malformedClock.status, 400); assert.equal(daemon.attempts.length, before);
  const unexpected = await fetch(`${origin}/api/search-runs/${searchRun.id}/arbitrary-action`, { method: "POST", headers: { origin } });
  assert.ok(unexpected.status >= 400); assert.equal(daemon.attempts.length, before);
}

export async function checkAgenticRecoveryKey({ origin, daemon }: { origin: string; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const base = `/api/search-sessions/${initialSession.id}`, key = "search:123";
  const body = JSON.stringify({ text: "Owned exact intent", requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" },
    composerId: composer.composerId, contextToken: composer.contextToken });
  const admission = await fetch(`${origin}${base}/turns`, { method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": key }, body });
  assert.equal(admission.status, 201, "colon-key admission positive control");
  const control = await admission.json(); assert.deepEqual(control, turnControl);
  assert.equal(daemon.attempts.at(-1)?.key, key);
  const paths = [`${base}/turns/by-key/${key}`, `${base}/turns/by-key/${encodeURIComponent(key)}`];
  const results = await Promise.all(paths.map(path => fetch(`${origin}${path}`)));
  assert.deepEqual(results.map(response => response.status), [200, 200], "both raw and canonical percent-encoded valid keys must recover the same admitted control");
  for (const response of results) {
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const recovered = await response.json(); assert.deepEqual(recovered, control);
    assert.ok(!JSON.stringify(recovered).includes("Owned exact intent"));
  }
  const lookups = daemon.attempts.filter(item => item.method === "GET" && item.path.includes("/turns/by-key/"));
  assert.equal(lookups.length, 2, "both lookups must reach the fixed daemon route");
  for (const call of lookups) {
    const path = new URL(call.path, origin).pathname;
    assert.equal(decodeURIComponent(path.split("/").at(-1) ?? ""), key);
    assert.equal(call.authorization, daemon.expectedAuthorization);
  }
  const before = daemon.attempts.length;
  const unsafe = await fetch(`${origin}${base}/turns/by-key/search%2F123`);
  assert.ok(unsafe.status >= 400); assert.equal(daemon.attempts.length, before, "a key must not escape its fixed path segment");
}

export async function checkAgenticLargePreview({ origin, daemon }: { origin: string; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const path = `/api/search-sessions/${initialSession.id}/composer-contexts/${composer.composerId}/thoughts/${thought.id}`;
  const small = await fetch(`${origin}${path}`);
  assert.equal(small.status, 200, "ordinary eligible preview positive control");
  assert.equal((await small.json()).thought.text, thought.text);
  assert.ok(Buffer.byteLength(largeThoughtText, "utf8") < 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...thought, text: largeThoughtText }), "utf8") > 1024 * 1024);
  daemon.setLargePreview(true);
  try {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, "a large eligible thought must not be truncated or rejected by the BFF");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const value = await response.json() as { thought: typeof thought; composerId: string; contextToken: string; sessionRevision: number; eligibilityRevision: number };
    assert.equal(value.thought.id, thought.id); assert.equal(value.thought.text.length, largeThoughtText.length);
    assert.equal(value.thought.text, largeThoughtText);
    assert.equal(value.composerId, composer.composerId); assert.equal(value.contextToken, "owned-current-token");
    assert.equal(value.sessionRevision, 3); assert.equal(value.eligibilityRevision, 0);
    assert.equal(daemon.attempts.at(-1)?.authorization, daemon.expectedAuthorization);
  } finally { daemon.setLargePreview(false); }
}

export async function checkAgenticSearchEntry(page: Page, daemon: Fixture, options: { origin: string; daemonOrigin: string; token: string }): Promise<void> {
  daemon.reset();
  const leaks: string[] = [];
  page.on("request", request => {
    if (request.url().startsWith(options.daemonOrigin) || request.url().includes(options.token) || request.headers().authorization?.includes(options.token)) leaks.push("browser credential boundary");
  });
  await page.goto(`${options.origin}/explore`, { waitUntil: "networkidle" });
  const ask = page.getByRole("link", { name: "Ask your library", exact: true });
  const saved = page.getByRole("link", { name: "Saved searches", exact: true }).or(page.getByRole("button", { name: "Saved searches", exact: true }));
  await expect(ask).toBeVisible(); await expect(saved).toBeVisible();
  assert.equal(daemon.attempts.filter(item => item.method !== "GET").length, 0, "render and prefetch must not write");
  await ask.click();
  await expect(page.getByRole("button", { name: /^new search$/i })).toBeVisible();
  assert.equal(daemon.attempts.filter(item => item.method !== "GET").length, 0, "opening entry must not create a session or composer");
  await page.getByRole("button", { name: /^new search$/i }).click();
  await expect.poll(() => daemon.attempts.filter(item => item.method === "POST" && item.path === "/search-sessions").length).toBe(1);
  await expect.poll(() => daemon.attempts.filter(item => item.method === "POST" && item.path === `/search-sessions/${initialSession.id}/composer-contexts`).length).toBe(1);
  assert.equal(daemon.attempts.filter(item => item.path.endsWith("/turns")).length, 0, "New search must not invoke an agent");
  assert.deepEqual(leaks, []);
}

export async function checkAgenticSearchSaved(page: Page, daemon: Fixture, options: { origin: string; daemonOrigin: string; token: string }): Promise<void> {
  daemon.reset();
  const leaks: string[] = [];
  page.on("request", request => {
    if (request.url().startsWith(options.daemonOrigin) || request.url().includes(options.token) || request.headers().authorization?.includes(options.token)) leaks.push("browser credential boundary");
  });
  await page.goto(`${options.origin}/explore`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Saved searches", exact: true }).or(page.getByRole("button", { name: "Saved searches", exact: true })).click();
  await expect(page.getByText("Owned saved search")).toBeVisible();
  assert.equal(daemon.attempts.filter(item => item.method !== "GET").length, 0, "catalog render and prefetch must not create work");
  await page.getByRole("link", { name: /^resume$/i }).or(page.getByRole("button", { name: /^resume$/i })).click();
  await expect(page.getByText("Owned saved search").first()).toBeVisible();
  await expect.poll(() => daemon.attempts.filter(item => item.method === "POST" && item.path === `/search-sessions/${initialSession.id}/composer-contexts`).length).toBe(1);
  assert.equal(daemon.attempts.filter(item => item.path.endsWith("/turns")).length, 0, "Resume must not invoke an agent");
  assert.deepEqual(leaks, []);
}

async function resumeOwnedSearch(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/explore`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Saved searches", exact: true }).or(page.getByRole("button", { name: "Saved searches", exact: true })).click();
  await expect(page.getByText(initialSession.title)).toBeVisible();
  await page.getByRole("link", { name: /^resume$/i }).or(page.getByRole("button", { name: /^resume$/i })).click();
  await expect(page.getByRole("textbox", { name: /^your message$/i })).toBeVisible();
}

export async function checkAgenticIdleReadRetry(page: Page, daemon: Fixture, options: { origin: string; narrow: boolean }): Promise<void> {
  daemon.reset();
  try {
    await resumeOwnedSearch(page, options.origin);
    const canonical = page.url(), field = page.getByRole("textbox", { name: "Your message" });
    await field.fill("Owned unsent retry draft");
    if (options.narrow) await page.getByRole("button", { name: /discovered ideas/i }).click();
    await page.getByRole("link", { name: "Open idea" }).first().click();
    daemon.setFailPages(true);
    await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*search/i }).click();
    await page.waitForURL(canonical);
    await expect(page.getByText(/could not confirm the latest state/i)).toBeVisible();
    await expect(field).toHaveValue("Owned unsent retry draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    const writes = daemon.attempts.filter(item => item.method !== "GET").length;
    const before = daemon.attempts.length;
    daemon.setFailPages(false);
    await page.getByRole("button", { name: "Check search" }).click();
    await expect(page.getByRole("region", { name: "Conversation" }).getByText("Owned saved message")).toBeVisible();
    await expect(field).toHaveValue("Owned unsent retry draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    assert.equal(daemon.attempts.filter(item => item.method !== "GET").length, writes, "retry must not create a composer or admit a turn");
    const retried = daemon.attempts.slice(before).filter(item => item.path.includes("/messages") || item.path.includes("/discoveries"));
    assert.ok(retried.length >= 2 && retried.every(item => new URL(item.path, options.origin).searchParams.get("composerId") === composer.composerId));
  } finally { daemon.setFailPages(false); }
}

export async function checkAgenticActiveReadingPosition(page: Page, daemon: Fixture, options: { origin: string; narrow: boolean }): Promise<void> {
  daemon.reset(); daemon.setActiveRun(true); daemon.setLongMessages(true); daemon.setMultiPage(true);
  await page.clock.install();
  try {
    await resumeOwnedSearch(page, options.origin);
    await expect(page.getByText(/queued/i).first()).toBeVisible();
    await page.getByRole("button", { name: "More messages" }).click();
    await expect(page.getByText(/Owned older page/)).toBeVisible();
    if (options.narrow) await page.getByRole("button", { name: /discovered ideas/i }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByRole("region", { name: "Idea preview" })).toContainText("Owned eligible thought");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const beforeScroll = await page.evaluate(() => window.scrollY); assert.ok(beforeScroll > 0);
    const before = daemon.attempts.length;
    const writes = daemon.attempts.filter(item => item.method !== "GET").length;
    daemon.holdPages();
    await page.clock.fastForward(1600);
    await expect.poll(() => daemon.attempts.slice(before).some(item => item.path.includes("/messages"))).toBe(true);
    // Content may be concealed while eligibility is checked, but the reader's place must not collapse.
    expect(Math.abs(await page.evaluate(() => window.scrollY) - beforeScroll)).toBeLessThanOrEqual(2);
    // Retained DOM is not a refresh barrier: wait for the new continuation and
    // preview responses before checking the refreshed content and request audit.
    const continuation = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === `/api/search-sessions/${initialSession.id}/messages` && url.searchParams.get("cursor") === "owned-next";
    });
    const preview = page.waitForResponse(response => response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/search-sessions/${initialSession.id}/composer-contexts/${composer.composerId}/thoughts/${thought.id}`);
    daemon.releasePages();
    const [continuationResponse, previewResponse] = await Promise.all([continuation, preview]);
    assert.equal(continuationResponse.status(), 200);
    assert.equal(previewResponse.status(), 200);
    assert.equal((await continuationResponse.json()).composerId, composer.composerId);
    assert.equal((await previewResponse.json()).composerId, composer.composerId);
    await expect(page.getByText(/Owned older page/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Idea preview" })).toContainText("Owned eligible thought");
    expect(Math.abs(await page.evaluate(() => window.scrollY) - beforeScroll)).toBeLessThanOrEqual(2);
    const refreshed = daemon.attempts.slice(before).filter(item => item.path.includes("/messages") || item.path.includes("/discoveries"));
    assert.ok(refreshed.some(item => new URL(item.path, options.origin).searchParams.get("cursor") === "owned-next"));
    assert.ok(refreshed.every(item => new URL(item.path, options.origin).searchParams.get("composerId") === composer.composerId));
    assert.equal(daemon.attempts.filter(item => item.method !== "GET").length, writes, "polling and eligible refresh must not create work");
    daemon.setUnavailable(true);
    await page.clock.fastForward(1600);
    await expect(page.getByText("Owned rationale")).toHaveCount(0);
    await expect(page.getByText("Owned eligible thought")).toHaveCount(0);
  } finally { daemon.releasePages(); }
}

export async function checkAgenticWorkspaceBrowser(page: Page, daemon: Fixture, options: { origin: string; daemonOrigin: string; token: string; narrow: boolean }): Promise<void> {
  daemon.reset();
  const leaks: string[] = [];
  page.on("request", request => { if (request.url().startsWith(options.daemonOrigin) || request.url().includes(options.token) || request.headers().authorization?.includes(options.token)) leaks.push("browser credential boundary"); });
  try {
    await resumeOwnedSearch(page, options.origin);
    const canonical = page.url(); assert.notEqual(new URL(canonical).pathname, "/explore", "Resume needs a bookmarkable session URL");
    await expect(page.getByText("Owned saved message")).toBeVisible();
    if (options.narrow) await page.getByText(/discovered ideas/i).first().click();
    await expect(page.getByText("Owned idea")).toBeVisible();
    await page.getByRole("button", { name: /preview/i }).first().click();
    await expect(page.getByText("Owned eligible thought")).toBeVisible();
    const field = page.getByRole("textbox", { name: /^your message$/i });
    const send = page.getByRole("button", { name: /^send$/i });
    await expect(send).toBeDisabled();
    const effort = page.getByRole("combobox", { name: /effort/i });
    await expect(effort).toHaveValue(/standard/i);
    assert.equal(await field.evaluate(element => element.tagName), "TEXTAREA");
    daemon.setTurnMode("hold");
    await field.fill("OWNED-PENDING-TURN"); await send.click();
    await expect.poll(() => daemon.attempts.filter(item => item.method === "POST" && item.path.endsWith("/turns")).length).toBe(1);
    await expect(page.getByRole("region", { name: "Conversation" }).getByText("OWNED-PENDING-TURN", { exact: true })).toHaveCount(0);
    await expect(field).toHaveValue("OWNED-PENDING-TURN");
    await expect(field).toHaveAttribute("readonly", "");
    await expect(send).toBeDisabled();
    daemon.setTurnMode("normal"); daemon.releaseTurn();
    await expect(page.getByText(/queued|searching/i).first()).toBeVisible();
    const check = page.getByRole("button", { name: /^check$/i });
    const stop = page.getByRole("button", { name: /^stop$/i });
    await expect(check).toBeVisible(); await expect(stop).toBeVisible();
    await check.click();
    await expect.poll(() => daemon.attempts.some(item => item.method === "GET" && item.path === `/runs/${searchRun.id}`)).toBe(true);
    await stop.click();
    await expect.poll(() => daemon.attempts.some(item => item.method === "POST" && item.path === `/runs/${searchRun.id}/stop`)).toBe(true);
    assert.ok(!((await page.content()).includes("owned-context-token")), "control data must not render the context token");
    if (options.narrow) await page.getByRole("button", { name: /session actions/i }).click();
    await expect(page.getByRole("button", { name: /edit title/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /copy link/i })).toBeVisible();
    const history = page.getByRole("link", { name: /^history$/i }).or(page.getByRole("button", { name: /^history$/i }));
    await history.click();
    await expect(page.getByText(/history.*user.only/i)).toBeVisible();
    await expect(page.getByRole("textbox", { name: /^your message$/i })).toHaveCount(0);
    await expect.poll(() => daemon.attempts.some(item => item.path.includes("scope=history") && !item.path.includes("composerId="))).toBe(true);
    assert.deepEqual(leaks, []);
  } finally { daemon.releaseTurn(); daemon.setTurnMode("normal"); }
}

export async function checkAgenticUnknownAdmission(page: Page, daemon: Fixture, options: { origin: string }): Promise<void> {
  daemon.reset();
  await resumeOwnedSearch(page, options.origin);
  daemon.setTurnMode("unknown");
  try {
    const text = "OWNED-UNCERTAIN-TURN";
    await page.getByRole("textbox", { name: /^your message$/i }).fill(text);
    await page.getByRole("button", { name: /^send$/i }).click();
    await expect(page.getByText(/not sure this request started/i)).toBeVisible();
    const snapshot = page.getByRole("region", { name: "Unconfirmed request" });
    await expect(snapshot.getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Conversation" }).getByText(text, { exact: true })).toHaveCount(0);
    const submitted = daemon.attempts.filter(item => item.method === "POST" && item.path.endsWith("/turns"));
    assert.equal(submitted.length, 1); const original = submitted[0]; assert.ok(original?.key);
    const frozen = JSON.parse(original.body) as { text: string; requestClock: { at: string; timeZone: string } };
    assert.equal(frozen.text, text); assert.ok(frozen.requestClock.at); assert.ok(frozen.requestClock.timeZone);
    await snapshot.getByRole("button", { name: /^check$/i }).click();
    await expect.poll(() => daemon.attempts.some(item => item.method === "GET" && item.path.includes("/turns/by-key/") && decodeURIComponent(item.path.split("/").at(-1) ?? "") === original.key)).toBe(true);
    assert.equal(daemon.attempts.filter(item => item.method === "POST" && item.path.endsWith("/turns")).length, 1, "Check must not re-admit or generate a new key");
  } finally { daemon.setTurnMode("normal"); }
}

export async function checkAgenticChangedContext(page: Page, daemon: Fixture, options: { origin: string }): Promise<void> {
  daemon.reset();
  await resumeOwnedSearch(page, options.origin);
  daemon.setTurnMode("context-changed");
  try {
    const text = "OWNED-COPYABLE-OLD-DRAFT";
    await page.getByRole("textbox", { name: /^your message$/i }).fill(text);
    await page.getByRole("button", { name: /^send$/i }).click();
    await expect(page.getByText(/context changed.*draft cannot be sent/i)).toBeVisible();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    const creationCount = daemon.attempts.filter(item => item.method === "POST" && item.path.endsWith("/composer-contexts")).length;
    const fresh = page.getByRole("button", { name: /start a new blank draft/i });
    await expect(fresh).toBeVisible();
    assert.equal(daemon.attempts.filter(item => item.method === "POST" && item.path.endsWith("/composer-contexts")).length, creationCount, "invalidation must not silently rebase");
    await fresh.click();
    await expect.poll(() => daemon.attempts.filter(item => item.method === "POST" && item.path.endsWith("/composer-contexts")).length).toBe(creationCount + 1);
    await expect(page.getByRole("textbox", { name: /^your message$/i })).toHaveValue("");
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  } finally { daemon.setTurnMode("normal"); }
}

export async function checkAgenticReturnNavigation(page: Page, daemon: Fixture, options: { origin: string; narrow: boolean }): Promise<void> {
  daemon.reset(); daemon.setLongMessages(true);
  await page.goto(`${options.origin}/explore?q=owned`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Saved searches", exact: true }).or(page.getByRole("button", { name: "Saved searches", exact: true })).click();
  await page.getByRole("link", { name: /^resume$/i }).or(page.getByRole("button", { name: /^resume$/i })).click();
  const field = page.getByRole("textbox", { name: /^your message$/i });
  await expect(field).toBeVisible();
  const searchUrl = new URL(page.url());
  assert.ok(searchUrl.pathname.startsWith("/explore/ask"), "search session must have its canonical Explore subtree URL");
  await field.fill("OWNED-UNSENT-NAVIGATION-DRAFT");
  if (options.narrow) await page.getByText(/discovered ideas/i).first().click();
  await page.getByRole("button", { name: /preview/i }).first().click();
  await expect(page.getByText("Owned eligible thought")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const open = page.getByRole("link", { name: /open idea/i }).first();
  await open.scrollIntoViewIfNeeded();
  const expectedScroll = await page.evaluate(() => window.scrollY);
  const href = await open.getAttribute("href"); assert.ok(href);
  const target = new URL(href, options.origin);
  assert.equal(target.pathname, `/ideas/${thought.id}`);
  assert.equal(target.searchParams.get("returnTo"), `${searchUrl.pathname}${searchUrl.search}`);
  await open.click();
  await expect(page.getByRole("heading", { name: "Owned idea", level: 1 })).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*search/i }).click();
  await page.waitForURL(searchUrl.href);
  assert.equal(`${new URL(page.url()).pathname}${new URL(page.url()).search}`, `${searchUrl.pathname}${searchUrl.search}`);
  await expect(field).toHaveValue("OWNED-UNSENT-NAVIGATION-DRAFT");
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - expectedScroll), { timeout: 5000 }).toBeLessThanOrEqual(2);
  await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*explore/i }).click();
  await page.waitForURL(url => url.pathname === "/explore" && url.searchParams.get("q") === "owned");
  const back = new URL(page.url()); assert.equal(back.pathname, "/explore"); assert.equal(back.searchParams.get("q"), "owned");
  assert.equal(daemon.attempts.filter(item => item.method === "POST" && item.path.endsWith("/turns")).length, 0);
}

export async function checkAgenticSessionActions(page: Page, daemon: Fixture, options: { origin: string; narrow: boolean }): Promise<void> {
  daemon.reset();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: options.origin });
  await resumeOwnedSearch(page, options.origin);
  const canonical = page.url();
  if (options.narrow) await page.getByRole("button", { name: /session actions/i }).click();
  await page.getByRole("button", { name: /copy link/i }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(canonical);
  await page.getByRole("button", { name: /edit title/i }).click();
  const title = page.getByRole("textbox", { name: /title/i }); await title.fill("Owned renamed search");
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(page.getByText("Owned renamed search").first()).toBeVisible();
  await expect.poll(() => daemon.attempts.some(item => item.method === "PATCH" && item.path === `/search-sessions/${initialSession.id}` && item.match === "0")).toBe(true);
  if (options.narrow) {
    const actions = page.getByRole("button", { name: /session actions/i });
    if (await actions.getAttribute("aria-expanded") === "false") await actions.click();
  }
  await page.getByRole("button", { name: /^delete$/i }).click();
  await expect(page.getByText(/delete this search\?/i)).toBeVisible();
  await expect(page.getByText(/library ideas stay/i)).toBeVisible();
  await page.getByRole("button", { name: /delete search/i }).click();
  await expect.poll(() => daemon.attempts.filter(item => item.method === "DELETE" && item.path === `/search-sessions/${initialSession.id}`).length).toBe(1);
  assert.equal(daemon.attempts.filter(item => item.method === "POST" && item.path === "/search-sessions").length, 0, "Delete must not recreate the session");
}

export async function checkAgenticUnavailable(page: Page, daemon: Fixture, options: { origin: string; narrow: boolean }): Promise<void> {
  daemon.reset(); daemon.setUnavailable(true);
  try {
    await resumeOwnedSearch(page, options.origin);
    await expect(page.getByText(/message unavailable/i)).toBeVisible();
    if (options.narrow) await page.getByRole("button", { name: /discovered ideas/i }).click();
    await expect(page.getByText(/idea unavailable/i)).toBeVisible();
    await expect(page.getByText(/explanation unavailable/i)).toBeVisible();
    await expect(page.getByText("Owned saved message", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Owned idea", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Owned rationale", { exact: true })).toHaveCount(0);
    assert.equal(daemon.attempts.filter(item => item.path.includes("scope=history")).length, 0, "normal unavailable content must not fall back to history");
  } finally { daemon.setUnavailable(false); }
}
