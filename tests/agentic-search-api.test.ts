import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/daemon/app";
import { CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import { TitleService } from "../src/domain/title";
import { createLogger } from "../src/logging";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";
import type { SearchSessionView } from "../src/domain/agentic-search";
import { RunService } from "../src/domain/run";
import { SqliteRunRepository } from "../src/storage/run";

const credentials = { user: "owned-user-token", ai: "owned-ai-token" };
const logger = createLogger("error", () => {});

async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const f = setup();
  try { await action(f); } finally { f.db.close(); }
}

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const store = new SqliteStore(db);
  const clock = { now: "2030-01-01T00:00:00.000Z" };
  let sequence = 0;
  const sources = { id: () => `session-${++sequence}`, now: () => clock.now, logger };
  const sessions = store.searchSessions(sources);
  const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
  const creation = new CreationService({ rejection, ...sources, writes: {
    createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection),
  } });
  const titles = new TitleService(new SqliteTitleRepository(db, sources));
  const events: { path: string }[] = [];
  const options = { rejection, creation, titles, credentials, logger: (event: { path: string }) => events.push(event), diagnostics: logger, searchSessions: sessions };
  const app = createApp(options);
  store.saveThought({ id: "library-thought", text: "PRIVATE-LIBRARY-SENTINEL", title: null, titleAuthor: null,
    author: "user", kind: "captured-original", createdAt: clock.now, origin: "fixture", parentId: null, sourceIds: [] });
  function request(path: string, options: { actor?: "user" | "ai" | "none"; method?: string; raw?: string; headers?: Record<string, string> } = {}) {
    const headers = new Headers(options.headers);
    const actor = options.actor ?? "user";
    if (actor !== "none") headers.set("authorization", `Bearer ${credentials[actor]}`);
    if (options.raw !== undefined) headers.set("content-type", "application/json");
    return app.request(path, { method: options.method ?? "GET", headers, body: options.raw });
  }
  const knowledge = () => ["thoughts", "thought_titles", "thought_source_seals", "connections", "responses"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  const stop = new RunService({ repository: new SqliteRunRepository(db, sources), ...sources,
    dispatcher: { submit: async () => { throw new Error("unused"); }, observe: async () => { throw new Error("unused"); } } });
  return { db, sessions, clock, request, knowledge, rejection, stop, events };
}

function privateResponse(response: Response): void {
  const value = response.headers.get("cache-control") ?? "";
  expect(value).toContain("private");
  expect(value).toContain("no-store");
}

async function invalid(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  privateResponse(response);
  expect(await response.json()).toEqual(expect.objectContaining({ code: "invalid-search-request" }));
}

test("owned Hono and SQLite fixture has working ordinary reads and domain session creation", async () => fixture(async f => {
  const session = f.sessions.create("user", "control", {}).session;
  expect(f.sessions.get("user", session.id)).toEqual(session);
  const response = await f.request("/thoughts");
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).toContain("PRIVATE-LIBRARY-SENTINEL");
}));

test("POST creates daemon-owned metadata and exact replay does not change it", async () => fixture(async f => {
  const before = f.knowledge();
  const headers = { "idempotency-key": "create-one" };
  const response = await f.request("/search-sessions", { method: "POST", raw: "{}", headers });
  expect(response.status).toBe(201);
  privateResponse(response);
  const created = await response.json() as { session: SearchSessionView };
  expect(created).toEqual({ session: { id: "session-1", title: expect.any(String), createdAt: f.clock.now, lastActivityAt: f.clock.now, revision: 0 } });
  const rows = f.db.query("SELECT * FROM search_sessions").all();
  f.clock.now = "2030-01-02T00:00:00.000Z";
  const replay = await f.request("/search-sessions", { method: "POST", raw: "{}", headers });
  expect(replay.status).toBe(200); privateResponse(replay);
  expect(await replay.json()).toEqual(created);
  expect(f.db.query("SELECT * FROM search_sessions").all()).toEqual(rows);
  expect(f.knowledge()).toEqual(before);
}));

test("catalog walks all owned metadata in order and rejects changed or invalid cursors", async () => fixture(async f => {
  const first = f.sessions.create("user", "first", {}).session;
  f.clock.now = "2030-01-02T00:00:00.000Z";
  const second = f.sessions.create("user", "second", {}).session;
  f.clock.now = "2030-01-03T00:00:00.000Z";
  const third = f.sessions.create("user", "third", {}).session;
  const response = await f.request("/search-sessions?limit=1");
  expect(response.status).toBe(200); privateResponse(response);
  const page = await response.json() as { items: SearchSessionView[]; nextCursor: string | null };
  expect(page.items).toEqual([third]);
  expect(typeof page.nextCursor).toBe("string");
  if (!page.nextCursor) throw new Error("missing first cursor");
  const cursor = page.nextCursor;
  const next = await f.request(`/search-sessions?limit=1&cursor=${encodeURIComponent(cursor)}`);
  expect(next.status).toBe(200); privateResponse(next);
  const middle = await next.json() as typeof page;
  expect(middle.items).toEqual([second]);
  if (!middle.nextCursor) throw new Error("missing second cursor");
  const last = await f.request(`/search-sessions?limit=1&cursor=${encodeURIComponent(middle.nextCursor)}`);
  expect(last.status).toBe(200); privateResponse(last);
  expect(await last.json()).toEqual({ items: [first], nextCursor: null });
  expect(JSON.stringify(page)).not.toContain("PRIVATE-LIBRARY-SENTINEL");
  f.sessions.create("user", "fourth", {});
  const changed = await f.request(`/search-sessions?limit=1&cursor=${encodeURIComponent(cursor)}`);
  expect(changed.status).toBe(409); privateResponse(changed);
  expect(await changed.json()).toEqual(expect.objectContaining({ code: "list-changed" }));
  for (const query of ["?cursor=not-a-cursor", "?limit=0", "?limit=1&limit=1", "?unknown=1"]) await invalid(await f.request(`/search-sessions${query}`));
}));

test("detail and revision-checked rename return only session control metadata", async () => fixture(async f => {
  const session = f.sessions.create("user", "detail", {}).session;
  const response = await f.request(`/search-sessions/${session.id}`);
  expect(response.status).toBe(200); privateResponse(response);
  expect(await response.json()).toEqual({ session, activeRun: null, eligibilityRevision: expect.any(Number) });
  const renamed = await f.request(`/search-sessions/${session.id}`, { method: "PATCH", raw: '{"title":"Owned title"}', headers: { "if-match": "0" } });
  expect(renamed.status).toBe(200); privateResponse(renamed);
  expect(await renamed.json()).toEqual({ session: { ...session, title: "Owned title", revision: 1 } });
  const stale = await f.request(`/search-sessions/${session.id}`, { method: "PATCH", raw: '{"title":"stale"}', headers: { "if-match": "0" } });
  expect(stale.status).toBe(409); privateResponse(stale);
  expect(await stale.json()).toEqual(expect.objectContaining({ code: "revision-conflict" }));
  await invalid(await f.request(`/search-sessions/${session.id}?scope=history`));
  await invalid(await f.request(`/search-sessions/${session.id}`, { method: "PATCH", raw: '{"title":"a","title":"b"}', headers: { "if-match": "1" } }));
  await invalid(await f.request(`/search-sessions/${session.id}`, { method: "PATCH", raw: '{"title":"a"}', headers: { "if-match": "1, 1" } }));
}));

test("unbound Delete is idempotent, preserves library, and cannot resurrect a receipt", async () => fixture(async f => {
  const session = f.sessions.create("user", "delete-key", {}).session;
  const before = f.knowledge();
  const deleted = await f.request(`/search-sessions/${session.id}`, { method: "DELETE" });
  expect(deleted.status).toBe(204); privateResponse(deleted);
  expect(await deleted.text()).toBe("");
  const replay = await f.request(`/search-sessions/${session.id}`, { method: "DELETE" });
  expect(replay.status).toBe(204); privateResponse(replay);
  const missing = await f.request("/search-sessions/not-found", { method: "DELETE" });
  expect(missing.status).toBe(404); privateResponse(missing);
  const create = await f.request("/search-sessions", { method: "POST", raw: "{}", headers: { "idempotency-key": "delete-key" } });
  expect(create.status).toBe(409); privateResponse(create);
  expect(await create.json()).toEqual(expect.objectContaining({ code: "session-deleted" }));
  expect(f.knowledge()).toEqual(before);
}));

test("unauthenticated metadata errors are private", async () => fixture(async f => {
  const unauthorized = await f.request("/search-sessions", { actor: "none" });
  expect(unauthorized.status).toBe(401); privateResponse(unauthorized);
}));

test("metadata routes reject AI credentials", async () => fixture(async f => {
  const forbidden = await f.request("/search-sessions", { actor: "ai" });
  expect(forbidden.status).toBe(403); privateResponse(forbidden);
}));

test("creation rejects missing or ambiguous keys and strict invalid JSON fields", async () => fixture(async f => {
  const valid = { "idempotency-key": "valid-key" };
  const inputs: { raw: string; headers: Record<string, string> }[] = [
    { raw: "{}", headers: {} },
    { raw: "{}", headers: { "idempotency-key": "a, b" } },
    { raw: '{"title":"caller"}', headers: valid },
    { raw: '{"id":"a","id":"b"}', headers: valid },
  ];
  for (const input of inputs) await invalid(await f.request("/search-sessions", { method: "POST", ...input }));
  expect(f.sessions.list("user").items).toEqual([]);
}));

test("metadata projects live active control and eligibility without changing composer state or exposing content", async () => fixture(async f => {
  const session = f.sessions.create("user", "active", {}).session;
  const draft = f.sessions.openComposer("user", session.id);
  const admitted = f.sessions.admitTurn("user", session.id, "turn", { text: "SECRET-TURN-PROSE", startingThoughtIds: [],
    requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" }, composerId: draft.composerId, contextToken: draft.contextToken });
  const composer = f.db.query("SELECT rowid,* FROM search_composer_contexts").all();
  const response = await f.request(`/search-sessions/${session.id}`);
  expect(response.status).toBe(200); privateResponse(response);
  const active = await response.json() as { session: SearchSessionView; activeRun: unknown; eligibilityRevision: number };
  expect(active.session).toEqual(admitted.session);
  expect(active.activeRun).toEqual(admitted.run);
  expect(JSON.stringify(active)).not.toContain("SECRET-TURN-PROSE");
  expect(JSON.stringify(active)).not.toContain(draft.contextToken);
  expect(f.db.query("SELECT rowid,* FROM search_composer_contexts").all()).toEqual(composer);
  f.rejection.rejectThought("user", "library-thought");
  const changed = await (await f.request(`/search-sessions/${session.id}`)).json() as typeof active;
  expect(changed.eligibilityRevision).toBeGreaterThan(active.eligibilityRevision);
  expect(changed.activeRun).toEqual(admitted.run);
  f.stop.stop("user", admitted.run.id);
  const stopped = await (await f.request(`/search-sessions/${session.id}`)).json() as typeof active;
  expect(stopped.activeRun).toBeNull();
  expect(stopped.eligibilityRevision).toBe(changed.eligibilityRevision);
}));

test("catalog cursor authentication and metadata request boundaries fail closed", async () => fixture(async f => {
  f.sessions.create("user", "cursor-a", {}); f.sessions.create("user", "cursor-b", {});
  const page = await (await f.request("/search-sessions?limit=1")).json() as { nextCursor: string | null };
  if (!page.nextCursor) throw new Error("missing owned cursor");
  const cursor = page.nextCursor;
  const tampered = `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}`;
  await invalid(await f.request(`/search-sessions?limit=1&cursor=${encodeURIComponent(tampered)}`));
  await invalid(await f.request(`/search-sessions?limit=2&cursor=${encodeURIComponent(cursor)}`));
  await invalid(await f.request(`/search-sessions?cursor=${"x".repeat(2049)}`));
  const session = f.sessions.list("user").items[0];
  if (!session) throw new Error("missing owned session");
  await invalid(await f.request(`/search-sessions/${session.id}`, { method: "DELETE", raw: "{}" }));
  await invalid(await f.request(`/search-sessions/${session.id}`, { method: "PATCH", raw: '{"title":"a","title":"b"}', headers: { "if-match": "0" } }));
  const tooLarge = await f.request("/search-sessions", { method: "POST", raw: `{"padding":"${"x".repeat(5000)}"}`, headers: { "idempotency-key": "oversize" } });
  expect(tooLarge.status).toBe(413); privateResponse(tooLarge);
  expect(await tooLarge.json()).toEqual(expect.objectContaining({ code: "request-too-large" }));
  const paths = JSON.stringify(f.events);
  expect(paths).not.toContain(session.id); expect(paths).not.toContain(cursor);
  expect(paths).toContain("/search-sessions/:id");
}));
