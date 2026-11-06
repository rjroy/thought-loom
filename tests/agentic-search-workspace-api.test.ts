import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/daemon/app";
import { CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import { RunService } from "../src/domain/run";
import { TitleService } from "../src/domain/title";
import type { SearchComposerView } from "../src/domain/agentic-search";
import { createLogger } from "../src/logging";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";

const logger = createLogger("error", () => {});
const clock = { at: "2030-01-01T12:00:00Z", timeZone: "UTC" };
const credentials = { user: "owned-user-token", ai: "owned-ai-token" };

function setup() {
  const db = new Database(":memory:"); migrate(db);
  let sequence = 0;
  const sources = { id: () => `owned-${++sequence}`, now: () => "2030-01-01T12:00:00.000Z", logger };
  const store = new SqliteStore(db), sessions = store.searchSessions(sources);
  for (const [id, text] of [["T", "private source"], ["U", "other source"]]) {
    store.saveThought({ id, text, title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: sources.now(), origin: "fixture", parentId: null, sourceIds: [] });
  }
  const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
  const creation = new CreationService({ rejection, ...sources, writes: { createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection) } });
  const titles = new TitleService(new SqliteTitleRepository(db, sources));
  const app = createApp({ rejection, creation, titles, credentials, logger: () => {}, diagnostics: logger, searchSessions: sessions });
  const stop = new RunService({ repository: new SqliteRunRepository(db, sources), ...sources,
    dispatcher: { submit: async () => { throw new Error("unused"); }, observe: async () => { throw new Error("unused"); } } });
  const session = sessions.create("user", "owned-session", {}).session;
  function admit(key: string, text: string, thoughtIds: string[], composer: SearchComposerView) {
    return sessions.admitTurn("user", session.id, key, { text, startingThoughtIds: thoughtIds, requestClock: clock,
      composerId: composer.composerId, contextToken: composer.contextToken });
  }
  // Real domain admission and Stop retain messages without simulating native completion.
  const original = admit("first", "PRIVATE-FIRST-USER-TEXT", ["T"], sessions.openComposer("user", session.id));
  stop.stop("user", original.run.id);
  const second = admit("second", "PRIVATE-SECOND-USER-TEXT", ["U"], sessions.openComposer("user", session.id));
  stop.stop("user", second.run.id);
  function request(path: string, options: { method?: string; raw?: string; actor?: "user" | "ai" | "none" } = {}) {
    const headers = new Headers(); const actor = options.actor ?? "user";
    if (actor !== "none") headers.set("authorization", `Bearer ${credentials[actor]}`);
    if (options.raw !== undefined) headers.set("content-type", "application/json");
    return app.request(path, { method: options.method ?? "GET", headers, body: options.raw });
  }
  const refs = (id: string) => db.query("SELECT ref_kind,ref_id FROM search_composer_dependencies WHERE composer_id=? ORDER BY ref_kind,ref_id").all(id);
  return { db, sessions, session, original, rejection, request, refs, admit };
}

async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const f = setup(); try { await action(f); } finally { f.db.close(); }
}
function privateResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
}
async function error(response: Response, status: number, code?: string): Promise<void> {
  expect(response.status).toBe(status); privateResponse(response);
  if (code) expect(await response.json()).toEqual(expect.objectContaining({ code }));
}

test("owned app and domain fixture retain admitted stopped turns without native execution", async () => fixture(async f => {
  expect(f.sessions.history("user", f.session.id).messages.items.map(item => item.text)).toEqual(["PRIVATE-FIRST-USER-TEXT", "PRIVATE-SECOND-USER-TEXT"]);
  expect((await f.request(`/search-sessions/${f.session.id}`)).status).toBe(200);
  expect(f.db.query("SELECT count(*) AS n FROM agent_bindings").get()).toEqual({ n: 0 });
}));

test("composer lifecycle keeps saved content and discards only the selected draft", async () => fixture(async f => {
  const base = `/search-sessions/${f.session.id}/composer-contexts`;
  const created = await f.request(base, { method: "POST", raw: "{}" });
  expect(created.status).toBe(201); privateResponse(created);
  const draft = await created.json() as SearchComposerView;
  expect(draft).toEqual({ composerId: expect.any(String), contextToken: expect.any(String), eligibilityRevision: expect.any(Number) });
  const path = `${base}/${draft.composerId}`;
  const refreshed = await f.request(path);
  expect(refreshed.status).toBe(200); privateResponse(refreshed);
  expect(await refreshed.json()).toEqual(draft);
  const discarded = await f.request(path, { method: "DELETE" });
  expect(discarded.status).toBe(204); privateResponse(discarded);
  await error(await f.request(path), 409, "context-changed");
  expect((await f.request(path, { method: "DELETE" })).status).toBe(204);
  expect(f.sessions.history("user", f.session.id).messages.items[0]?.text).toBe("PRIVATE-FIRST-USER-TEXT");
  const fresh = await f.request(base, { method: "POST", raw: "{}" });
  expect(fresh.status).toBe(201);
  const next = await fresh.json() as SearchComposerView;
  expect(next.composerId).not.toBe(draft.composerId); expect(f.refs(next.composerId)).toEqual([]);
  await error(await f.request(`${base}/foreign`), 404);
  await error(await f.request(base, { method: "POST", raw: '{"unknown":1}' }), 400, "invalid-search-request");
  await error(await f.request(`${base}/${next.composerId}?unknown=1`, { method: "DELETE" }), 400, "invalid-search-request");
}));

test("fresh C2 normal page registers recovered prose before admission and rejection cannot wash it", async () => fixture(async f => {
  const c1 = f.sessions.openComposer("user", f.session.id);
  const c1page = f.sessions.messages("user", f.session.id, { composerId: c1.composerId, limit: 1 });
  expect(c1page.items[0]?.text).toBe("PRIVATE-FIRST-USER-TEXT");
  const c2 = f.sessions.openComposer("user", f.session.id);
  const recovered = f.sessions.turnByKey("user", f.session.id, "first");
  expect(JSON.stringify(recovered)).not.toContain("PRIVATE-FIRST-USER-TEXT");
  expect(f.refs(c2.composerId)).toEqual([]);
  const url = `/search-sessions/${f.session.id}/messages?scope=normal&composerId=${encodeURIComponent(c2.composerId)}&limit=1`;
  const response = await f.request(url);
  expect(response.status).toBe(200); privateResponse(response);
  const page = await response.json() as SearchComposerView & { items: { text: string | null }[]; sessionRevision: number; nextCursor: string | null };
  expect(page.composerId).toBe(c2.composerId); expect(page.contextToken).toEqual(expect.any(String));
  expect(page.sessionRevision).toEqual(expect.any(Number)); expect(page.items[0]?.text).toBe("PRIVATE-FIRST-USER-TEXT");
  expect(f.refs(c2.composerId)).toEqual([{ ref_kind: "thought", ref_id: "T" }]);
  f.rejection.rejectThought("user", "T"); f.rejection.restoreThought("user", "T");
  await error(await f.request(`/search-sessions/${f.session.id}/composer-contexts/${c2.composerId}`), 409, "context-changed");
  expect(() => f.admit("new-turn", "paraphrase", [], page)).toThrow(/context-changed/);
  const history = await f.request(`/search-sessions/${f.session.id}/messages?scope=history`);
  expect(history.status).toBe(200); privateResponse(history);
  const body = await history.json() as Record<string, unknown>;
  expect(JSON.stringify(body)).toContain("PRIVATE-FIRST-USER-TEXT");
  expect(body).not.toHaveProperty("contextToken"); expect(body).not.toHaveProperty("composerId");
}));

test("normal HTTP page binds its offered dependency into a later domain admission", async () => fixture(async f => {
  const c2 = f.sessions.openComposer("user", f.session.id);
  const response = await f.request(`/search-sessions/${f.session.id}/messages?composerId=${c2.composerId}&limit=1`);
  expect(response.status).toBe(200); privateResponse(response);
  const page = await response.json() as SearchComposerView;
  expect(f.refs(c2.composerId)).toEqual([{ ref_kind: "thought", ref_id: "T" }]);
  const admitted = f.admit("follow-up", "paraphrase", [], page);
  expect(f.db.query("SELECT ref_kind,ref_id FROM search_content_dependencies WHERE message_id=? ORDER BY ref_kind,ref_id").all(admitted.receipt.userMessageId)).toEqual([{ ref_kind: "thought", ref_id: "T" }]);
}));

test("explicit history and normal discoveries use separate user projections", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const base = `/search-sessions/${f.session.id}`;
  const history = await f.request(`${base}/messages?scope=history&limit=1`);
  expect(history.status).toBe(200); privateResponse(history);
  const body = await history.json() as { items: { text: string | null }[]; nextCursor: string | null };
  expect(body.items[0]?.text).toBe("PRIVATE-FIRST-USER-TEXT");
  expect(body).not.toHaveProperty("contextToken"); expect(body).not.toHaveProperty("composerId");
  if (!body.nextCursor) throw new Error("missing history continuation");
  const token = encodeURIComponent(body.nextCursor);
  await error(await f.request(`${base}/messages?scope=normal&composerId=${draft.composerId}&limit=1&cursor=${token}`), 400, "invalid-search-request");
  await error(await f.request(`${base}/discoveries?scope=history&limit=1&cursor=${token}`), 400, "invalid-search-request");
  const discovery = await f.request(`${base}/discoveries?composerId=${draft.composerId}`);
  expect(discovery.status).toBe(200); privateResponse(discovery);
  expect(await discovery.json()).toEqual(expect.objectContaining({ items: [], composerId: draft.composerId, contextToken: expect.any(String) }));
}));

test("normal pages and preview expose only safe content with ledger coverage, never an AI full-read", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const positive = await f.request(`/search-sessions/${f.session.id}/composer-contexts/${draft.composerId}/thoughts/U`);
  expect(positive.status).toBe(200); privateResponse(positive);
  expect(await positive.json()).toEqual(expect.objectContaining({ composerId: draft.composerId, thought: expect.objectContaining({ id: "U" }) }));
  expect(f.refs(draft.composerId)).toEqual([{ ref_kind: "thought", ref_id: "U" }]);
  expect(f.db.query("SELECT count(*) AS n FROM run_context WHERE full_read=1").get()).toEqual({ n: 0 });
  f.rejection.rejectThought("user", "T");
  const viewer = f.sessions.openComposer("user", f.session.id);
  const base = `/search-sessions/${f.session.id}`;
  const response = await f.request(`${base}/messages?composerId=${viewer.composerId}&limit=1`);
  expect(response.status).toBe(200); privateResponse(response);
  const page = await response.json() as { items: unknown[]; nextCursor: string | null };
  expect(page.items[0]).toEqual(expect.objectContaining({ text: null, availability: "context-unavailable", evidenceThoughtIds: [] }));
  expect(JSON.stringify(page)).not.toContain("PRIVATE-FIRST-USER-TEXT");
  expect(f.refs(viewer.composerId)).toEqual([]);
  const preview = await f.request(`${base}/composer-contexts/${viewer.composerId}/thoughts/U`);
  expect(preview.status).toBe(200); privateResponse(preview);
  const safePreview = await preview.json();
  expect(safePreview).toEqual(expect.objectContaining({ thought: expect.objectContaining({ id: "U", text: "other source" }), composerId: viewer.composerId, contextToken: expect.any(String) }));
  expect(JSON.stringify(safePreview)).not.toContain("private source");
  expect(f.refs(viewer.composerId)).toEqual([{ ref_kind: "thought", ref_id: "U" }]);
  expect(f.db.query("SELECT count(*) AS n FROM run_context WHERE full_read=1").get()).toEqual({ n: 0 });
  const hidden = await f.request(`${base}/composer-contexts/${viewer.composerId}/thoughts/T`);
  expect(hidden.status).toBe(404); privateResponse(hidden);
  expect(await hidden.text()).not.toContain("private source");
  expect(f.refs(viewer.composerId)).toEqual([{ ref_kind: "thought", ref_id: "U" }]);
}));

test("workspace scopes, authorization and signed cursor boundaries are enforced", async () => fixture(async f => {
  const c = f.sessions.openComposer("user", f.session.id), base = `/search-sessions/${f.session.id}`;
  const page = await f.request(`${base}/messages?scope=normal&composerId=${c.composerId}&limit=1`);
  expect(page.status).toBe(200); privateResponse(page);
  const body = await page.json() as { nextCursor: string | null };
  if (!body.nextCursor) throw new Error("missing continuation");
  const cursor = encodeURIComponent(body.nextCursor), other = f.sessions.create("user", "other", {}).session;
  const forged = encodeURIComponent(`${body.nextCursor[0] === "A" ? "B" : "A"}${body.nextCursor.slice(1)}`);
  for (const path of [`${base}/messages`, `${base}/messages?scope=history&composerId=${c.composerId}`,
    `${base}/messages?scope=normal&scope=history&composerId=${c.composerId}`, `${base}/messages?composerId=${c.composerId}&unknown=x`,
    `${base}/messages?composerId=${c.composerId}&limit=1&cursor=${forged}`,
    `${base}/discoveries?composerId=${c.composerId}&limit=1&cursor=${cursor}`,
    `${base}/messages?scope=history&limit=1&cursor=${cursor}`]) {
    const rejected = await f.request(path);
    expect(rejected.status).toBe(400); privateResponse(rejected);
    expect(await rejected.text()).not.toContain("PRIVATE-FIRST-USER-TEXT");
  }
  const foreign = await f.request(`/search-sessions/${other.id}/messages?composerId=${c.composerId}&limit=1&cursor=${cursor}`);
  expect([400, 404]).toContain(foreign.status); privateResponse(foreign);
  await error(await f.request(`${base}/messages?composerId=${c.composerId}`, { actor: "ai" }), 403);
  await error(await f.request(`${base}/messages?composerId=${c.composerId}`, { actor: "none" }), 401);
}));

test("discovery removal targets one occurrence and replay cannot remove a later one", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const run = f.admit("discover", "find U", [], draft);
  const row = f.db.query("SELECT prompt_id FROM runs WHERE id=?").get(run.run.id) as { prompt_id: string };
  // Storage publication fixture, not a claim that native model execution occurred.
  function occurrence(prompt: string, id: string, position: number) {
    const envelope = JSON.stringify({ version: 1, kind: "request", request: { capability: "addDiscovery", arguments: { thoughtId: "U", why: `rationale-${id}`, evidenceThoughtIds: [] } } });
    const receipt = JSON.stringify({ type: "discovery-add", entryId: id, outcome: "added" });
    f.db.run("UPDATE run_steps SET input='fixture',state='completed',native_state='completed',envelope_json=?,result_json=? WHERE run_id=? AND prompt_id=?", [envelope, receipt, run.run.id, prompt]);
    f.db.run("INSERT INTO search_discoveries(id,session_id,thought_id,position,why,evidence_json,added_run_id,added_prompt_id,added_at) VALUES (?,?,'U',?,?,'[]',?,?,'2030')", [id, f.session.id, position, `rationale-${id}`, run.run.id, prompt]);
    f.db.run("INSERT INTO search_content_dependencies(session_id,discovery_id,ref_kind,ref_id) VALUES (?,?,'thought','T')", [f.session.id, id]);
  }
  occurrence(row.prompt_id, "E1", 0);
  const base = `/search-sessions/${f.session.id}/discoveries`;
  const removed = await f.request(`${base}/E1`, { method: "DELETE" });
  expect(removed.status).toBe(204); privateResponse(removed);
  expect(removed.headers.get("search-session-revision")).toMatch(/^\d+$/);
  f.db.run("UPDATE run_steps SET state='processed' WHERE run_id=? AND prompt_id=?", [run.run.id, row.prompt_id]);
  f.db.run("INSERT INTO run_steps(run_id,position,prompt_id,state,native_state) VALUES (?,1,'next-prompt','prepared','unknown')", [run.run.id]);
  occurrence("next-prompt", "E2", 1);
  const replay = await f.request(`${base}/E1`, { method: "DELETE" });
  expect(replay.status).toBe(204); privateResponse(replay);
  expect(replay.headers.get("search-session-revision")).toMatch(/^\d+$/);
  f.rejection.rejectThought("user", "T");
  const viewer = f.sessions.openComposer("user", f.session.id);
  const page = await f.request(`${base}?composerId=${viewer.composerId}`);
  expect(page.status).toBe(200); privateResponse(page);
  const body = await page.json() as { items: unknown[] };
  expect(body.items).toEqual([expect.objectContaining({ id: "E2", thought: expect.objectContaining({ id: "U" }), why: null, evidenceThoughtIds: [], reasonStatus: "context-unavailable" })]);
  expect(JSON.stringify(body)).not.toContain("rationale-E2");
  const history = await f.request(`${base}?scope=history`);
  expect(history.status).toBe(200); privateResponse(history);
  const historyBody = await history.json() as Record<string, unknown>;
  expect(JSON.stringify(historyBody)).toContain("E1"); expect(JSON.stringify(historyBody)).toContain("E2");
  expect(historyBody).not.toHaveProperty("contextToken");
  const first = await f.request(`${base}?scope=history&limit=1`);
  expect(first.status).toBe(200); privateResponse(first);
  const firstPage = await first.json() as { items: { id: string }[]; nextCursor: string | null };
  expect(firstPage.items.map(item => item.id)).toEqual(["E1"]);
  if (!firstPage.nextCursor) throw new Error("missing discovery history cursor");
  const token = encodeURIComponent(firstPage.nextCursor);
  const second = await f.request(`${base}?scope=history&limit=1&cursor=${token}`);
  expect(second.status).toBe(200); privateResponse(second);
  expect(await second.json()).toEqual(expect.objectContaining({ items: [expect.objectContaining({ id: "E2" })], nextCursor: null }));
  const forged = encodeURIComponent(`${firstPage.nextCursor[0] === "A" ? "B" : "A"}${firstPage.nextCursor.slice(1)}`);
  for (const path of [`${base}?scope=history&limit=1&cursor=${forged}`, `${base}?scope=history&limit=2&cursor=${token}`,
    `/search-sessions/${f.session.id}/messages?scope=history&limit=1&cursor=${token}`,
    `/search-sessions/${f.sessions.create("user", "foreign", {}).session.id}/discoveries?scope=history&limit=1&cursor=${token}`]) {
    await error(await f.request(path), 400, "invalid-search-request");
  }
}));

test("history message cursor continues and rejects tampering, wrong limit and foreign session", async () => fixture(async f => {
  const base = `/search-sessions/${f.session.id}`;
  const first = await f.request(`${base}/messages?scope=history&limit=1`);
  expect(first.status).toBe(200); privateResponse(first);
  const page = await first.json() as { items: { text: string }[]; nextCursor: string | null };
  expect(page.items[0]?.text).toBe("PRIVATE-FIRST-USER-TEXT");
  if (!page.nextCursor) throw new Error("missing message history cursor");
  const token = encodeURIComponent(page.nextCursor);
  const second = await f.request(`${base}/messages?scope=history&limit=1&cursor=${token}`);
  expect(second.status).toBe(200); privateResponse(second);
  expect(await second.json()).toEqual(expect.objectContaining({ items: [expect.objectContaining({ text: "PRIVATE-SECOND-USER-TEXT" })], nextCursor: null }));
  const forged = encodeURIComponent(`${page.nextCursor[0] === "A" ? "B" : "A"}${page.nextCursor.slice(1)}`);
  const other = f.sessions.create("user", "other-history", {}).session;
  for (const path of [`${base}/messages?scope=history&limit=1&cursor=${forged}`, `${base}/messages?scope=history&limit=2&cursor=${token}`,
    `${base}/discoveries?scope=history&limit=1&cursor=${token}`, `/search-sessions/${other.id}/messages?scope=history&limit=1&cursor=${token}`]) {
    await error(await f.request(path), 400, "invalid-search-request");
  }
}));

test("normal continuation reused by C2 registers only its offered page and cannot reuse C1 token", async () => fixture(async f => {
  const base = `/search-sessions/${f.session.id}`, c1 = f.sessions.openComposer("user", f.session.id), c2 = f.sessions.openComposer("user", f.session.id);
  const first = await f.request(`${base}/messages?composerId=${c1.composerId}&limit=1`);
  expect(first.status).toBe(200); privateResponse(first);
  const page1 = await first.json() as SearchComposerView & { nextCursor: string | null };
  if (!page1.nextCursor) throw new Error("missing normal cursor");
  expect(f.refs(c2.composerId)).toEqual([]);
  const next = await f.request(`${base}/messages?composerId=${c2.composerId}&limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`);
  expect(next.status).toBe(200); privateResponse(next);
  const page2 = await next.json() as SearchComposerView & { items: { text: string }[]; nextCursor: string | null };
  expect(page2.composerId).toBe(c2.composerId); expect(page2.items[0]?.text).toBe("PRIVATE-SECOND-USER-TEXT");
  expect(page2.nextCursor).toBeNull();
  expect(f.refs(c2.composerId)).toEqual([{ ref_kind: "thought", ref_id: "U" }]);
  expect(() => f.admit("wrong-token", "attempt", [], { ...page2, contextToken: page1.contextToken })).toThrow(/context-changed/);
  const admitted = f.admit("second-page-admission", "follow-up", [], page2);
  expect(f.db.query("SELECT ref_kind,ref_id FROM search_content_dependencies WHERE message_id=? ORDER BY ref_kind,ref_id").all(admitted.receipt.userMessageId)).toEqual([{ ref_kind: "thought", ref_id: "U" }]);
}));

test("discard of invalidated and consumed contexts cannot reset coverage or delete saved messages", async () => fixture(async f => {
  const base = `/search-sessions/${f.session.id}/composer-contexts`;
  const invalidated = f.sessions.openComposer("user", f.session.id);
  const offered = await f.request(`/search-sessions/${f.session.id}/messages?composerId=${invalidated.composerId}&limit=1`);
  expect(offered.status).toBe(200);
  f.rejection.rejectThought("user", "T"); f.rejection.restoreThought("user", "T");
  const invalidPath = `${base}/${invalidated.composerId}`;
  for (let i = 0; i < 2; i++) { const result = await f.request(invalidPath, { method: "DELETE" }); expect(result.status).toBe(204); privateResponse(result); }
  await error(await f.request(invalidPath), 409, "context-changed");
  expect(f.refs(invalidated.composerId)).toEqual([{ ref_kind: "thought", ref_id: "T" }]);
  const consumed = f.sessions.openComposer("user", f.session.id);
  const run = f.admit("consumed", "saved after discard", [], consumed);
  const consumedPath = `${base}/${consumed.composerId}`;
  const discarded = await f.request(consumedPath, { method: "DELETE" });
  expect(discarded.status).toBe(204); privateResponse(discarded);
  await error(await f.request(consumedPath), 409, "context-changed");
  expect(f.db.query("SELECT text FROM search_messages WHERE id=?").get(run.receipt.userMessageId)).toEqual({ text: "saved after discard" });
  expect(f.db.query("SELECT count(*) AS n FROM agent_bindings").get()).toEqual({ n: 0 });
}));

test("workspace transport rejects oversized and unexpected mutation bodies without changing drafts", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id), base = `/search-sessions/${f.session.id}/composer-contexts`;
  const oversized = await f.request(base, { method: "POST", raw: `{"x":"${"a".repeat(5000)}"}` });
  await error(oversized, 413, "request-too-large");
  await error(await f.request(`${base}/${draft.composerId}`, { method: "DELETE", raw: "{}" }), 400, "invalid-search-request");
  await error(await f.request(`${base}?x=1`, { method: "POST", raw: "{}" }), 400, "invalid-search-request");
  await error(await f.request(base, { method: "POST", raw: '{"x":1,"x":2}' }), 400, "invalid-search-request");
  const stillActive = await f.request(`${base}/${draft.composerId}`);
  expect(stillActive.status).toBe(200); privateResponse(stillActive);
  expect(await stillActive.json()).toEqual(draft);
}));
