import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/daemon/app";
import { AgentService } from "../src/domain/agent";
import type { SearchComposerView, SearchTurnControlView } from "../src/domain/agentic-search";
import { CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import { RunService } from "../src/domain/run";
import { TitleService } from "../src/domain/title";
import { createLogger } from "../src/logging";
import { SqliteAgentRuns } from "../src/storage/agent";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";

const credentials = { user: "owned-user-token", ai: "owned-ai-token" };
const logger = createLogger("error", () => {});
const timestamp = "2030-01-01T12:00:00.000Z";
const requestClock = { at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" };

function setup() {
  const db = new Database(":memory:"); migrate(db);
  let sequence = 0;
  const sources = { id: () => `owned-${++sequence}`, now: () => timestamp, logger };
  const store = new SqliteStore(db), sessions = store.searchSessions(sources);
  store.saveThought({ id: "source", text: "PRIVATE-LIBRARY-TEXT", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: timestamp, origin: "fixture", parentId: null, sourceIds: [] });
  const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
  const creation = new CreationService({ rejection, ...sources, writes: { createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection) } });
  const titles = new TitleService(new SqliteTitleRepository(db, sources));
  const repository = new SqliteAgentRuns(db, sources);
  const base = { rejection, creation, titles, credentials, logger: () => {}, diagnostics: logger, searchSessions: sessions };
  // Both apps use the real AgentService/SQLite, differing only in configured availability.
  const configuredOptions = { ...base, agents: new AgentService(repository, true), searchAgentsConfigured: true };
  const configlessOptions = { ...base, agents: new AgentService(repository, false), searchAgentsConfigured: false };
  const configured = createApp(configuredOptions), configless = createApp(configlessOptions);
  const stop = new RunService({ repository: new SqliteRunRepository(db, sources), ...sources,
    dispatcher: { submit: async () => { throw new Error("unexpected submit"); }, observe: async () => { throw new Error("unexpected observe"); } } });
  const session = sessions.create("user", "session-key", {}).session;
  function request(path: string, options: { configured?: boolean; actor?: "user" | "ai" | "none"; method?: string; raw?: string; key?: string } = {}) {
    const headers = new Headers(); const actor = options.actor ?? "user";
    if (actor !== "none") headers.set("authorization", `Bearer ${credentials[actor]}`);
    if (options.raw !== undefined) headers.set("content-type", "application/json");
    if (options.key !== undefined) headers.set("idempotency-key", options.key);
    return (options.configured === false ? configless : configured).request(path, { method: options.method ?? "GET", headers, body: options.raw });
  }
  const input = (draft: SearchComposerView) => ({ text: "PRIVATE-TURN-TEXT", startingThoughtIds: ["source"], requestClock,
    composerId: draft.composerId, contextToken: draft.contextToken });
  const snapshot = () => ["search_sessions", "search_composer_contexts", "search_turns", "search_messages", "runs", "run_steps", "agent_bindings"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  return { db, sources, sessions, session, stop, request, input, snapshot, allocated: () => sequence, repository };
}
async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const f = setup(); try { await action(f); } finally { f.db.close(); }
}
function privateResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private"); expect(response.headers.get("cache-control")).toContain("no-store");
}
async function expectedError(response: Response, status: number, code?: string): Promise<void> {
  expect(response.status).toBe(status); privateResponse(response);
  if (code) expect(await response.json()).toEqual(expect.objectContaining({ code }));
}
function controlOnly(value: SearchTurnControlView): void {
  expect(Object.keys(value).sort()).toEqual(["receipt", "run", "session"]);
  expect(Object.keys(value.run).sort()).toEqual(["assistantMessageId", "cancellation", "id", "kind", "outcomeReason", "searchSessionId", "status", "userMessageId"]);
  expect(JSON.stringify(value)).not.toContain("PRIVATE-TURN-TEXT");
  expect(JSON.stringify(value)).not.toContain("PRIVATE-LIBRARY-TEXT");
  expect(JSON.stringify(value)).not.toContain("confirmedThoughtIds");
  expect(JSON.stringify(value)).not.toContain("contextToken");
}

test("real app, domain admission and ordinary run projection are available as controls", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const input = f.input(draft);
  const control = f.sessions.admitTurn("user", f.session.id, "seed", input);
  expect(f.sessions.turnByKey("user", f.session.id, "seed")).toEqual(control);
  expect(f.db.query("SELECT text FROM search_messages WHERE id=?").get(control.receipt.userMessageId)).toEqual({ text: input.text });
  const ordinary = f.repository.admitEvolve("source", "ordinary fixture");
  const response = await f.request(`/runs/${ordinary.run.id}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(ordinary.run);
  expect(f.db.query("SELECT count(*) AS n FROM agent_bindings").get()).toEqual({ n: 0 });
}));

test("HTTP turn admission, exact replay and by-key return canonical control only", async () => fixture(async f => {
  const base = `/search-sessions/${f.session.id}`;
  const opened = await f.request(`${base}/composer-contexts`, { method: "POST", raw: "{}" });
  expect(opened.status).toBe(201); privateResponse(opened);
  const draft = await opened.json() as SearchComposerView, input = f.input(draft), raw = JSON.stringify(input);
  const admitted = await f.request(`${base}/turns`, { method: "POST", raw, key: "turn-key" });
  expect(admitted.status).toBe(201); privateResponse(admitted);
  const control = await admitted.json() as SearchTurnControlView;
  controlOnly(control);
  expect(control.receipt).toEqual({ searchSessionId: f.session.id, runId: control.run.id, userMessageId: control.run.userMessageId, admittedAt: timestamp });
  expect(control.run).toEqual(expect.objectContaining({ kind: "search", status: "queued", searchSessionId: f.session.id, assistantMessageId: null }));
  const saved = f.db.query("SELECT intent_json,effort,context_mode FROM search_turns WHERE run_id=?").get(control.run.id) as { intent_json: string; effort: string; context_mode: string };
  expect(JSON.parse(saved.intent_json)).toEqual(expect.objectContaining({ requestClock, daemonObservedAt: timestamp }));
  expect(saved.effort).toBe("standard"); expect(saved.context_mode).toBe("continue");
  const before = f.snapshot(), allocated = f.allocated();
  const replay = await f.request(`${base}/turns`, { method: "POST", raw, key: "turn-key", configured: false });
  expect(replay.status).toBe(200); privateResponse(replay);
  expect(await replay.json()).toEqual(control); expect(f.snapshot()).toEqual(before); expect(f.allocated()).toBe(allocated);
  const explicitDefaults = await f.request(`${base}/turns`, { method: "POST", raw: JSON.stringify({ ...input, effort: "standard", contextMode: "continue" }), key: "turn-key", configured: false });
  expect(explicitDefaults.status).toBe(200); privateResponse(explicitDefaults);
  expect(await explicitDefaults.json()).toEqual(control); expect(f.snapshot()).toEqual(before); expect(f.allocated()).toBe(allocated);
  const lookup = await f.request(`${base}/turns/by-key/turn-key`, { configured: false });
  expect(lookup.status).toBe(200); privateResponse(lookup);
  const found = await lookup.json() as SearchTurnControlView; expect(found).toEqual(control); controlOnly(found);
  await expectedError(await f.request(`${base}/turns/by-key/missing`, { configured: false }), 404);
  await expectedError(await f.request(`${base}/turns`, { method: "POST", raw: JSON.stringify({ ...input, text: "changed" }), key: "turn-key" }), 409, "idempotency-conflict");
  const another = f.sessions.openComposer("user", f.session.id);
  await expectedError(await f.request(`${base}/turns`, { method: "POST", raw: JSON.stringify(f.input(another)), key: "new-key" }), 409, "turn-active");
}));

test("new turn without configuration fails before allocating IDs or persisting admission", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id), before = f.snapshot(), allocated = f.allocated();
  const response = await f.request(`/search-sessions/${f.session.id}/turns`, { configured: false, method: "POST", raw: JSON.stringify(f.input(draft)), key: "new-turn" });
  await expectedError(response, 503, "agents-not-configured");
  expect(f.snapshot()).toEqual(before); expect(f.allocated()).toBe(allocated);
}));

test("by-key reads a real previously admitted turn without current configuration", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const original = f.sessions.admitTurn("user", f.session.id, "known-key", f.input(draft));
  const before = f.snapshot();
  const response = await f.request(`/search-sessions/${f.session.id}/turns/by-key/known-key`, { configured: false });
  expect(response.status).toBe(200); privateResponse(response);
  const body = await response.json() as SearchTurnControlView;
  expect(body).toEqual(original); controlOnly(body); expect(f.snapshot()).toEqual(before);
}));

test("known replay wins over consumed original composer and another active turn", async () => fixture(async f => {
  const originalDraft = f.sessions.openComposer("user", f.session.id), input = f.input(originalDraft);
  const original = f.sessions.admitTurn("user", f.session.id, "original-key", input);
  f.stop.stop("user", original.run.id);
  const nextDraft = f.sessions.openComposer("user", f.session.id);
  const next = f.sessions.admitTurn("user", f.session.id, "later-key", { ...f.input(nextDraft), text: "LATER-TURN" });
  const before = f.snapshot(), allocated = f.allocated();
  const replay = await f.request(`/search-sessions/${f.session.id}/turns`, { configured: false, method: "POST", key: "original-key", raw: JSON.stringify(input) });
  expect(replay.status).toBe(200); privateResponse(replay);
  const body = await replay.json() as SearchTurnControlView;
  expect(body.receipt).toEqual(original.receipt);
  expect(body.run).toEqual(expect.objectContaining({ id: original.run.id, status: "interrupted", outcomeReason: "stopped" }));
  controlOnly(body); expect(f.snapshot()).toEqual(before); expect(f.allocated()).toBe(allocated);
  expect(f.sessions.metadata("user", f.session.id)?.activeRun?.id).toBe(next.run.id);
  await expectedError(await f.request(`/search-sessions/${f.session.id}/turns`, { configured: false, method: "POST", key: "original-key", raw: JSON.stringify({ ...input, text: "different" }) }), 409, "idempotency-conflict");
  expect(f.snapshot()).toEqual(before); expect(f.allocated()).toBe(allocated);
}));

test("configless Stop uses the search user boundary without agent dispatch", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const admitted = f.sessions.admitTurn("user", f.session.id, "stop-only", f.input(draft));
  const response = await f.request(`/runs/${admitted.run.id}/stop`, { configured: false, method: "POST", raw: "{}" });
  expect(response.status).toBe(200); privateResponse(response);
  const view = await response.json() as SearchTurnControlView["run"];
  expect(view).toEqual(expect.objectContaining({ id: admitted.run.id, kind: "search", status: "interrupted", outcomeReason: "stopped" }));
  expect(f.db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(admitted.run.id)).toEqual({ open_slot: 0 });
  expect(f.db.query("SELECT count(*) AS n FROM agent_bindings").get()).toEqual({ n: 0 });
}));

test("configless Check and user Stop project search control and preserve retained message", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const admitted = f.sessions.admitTurn("user", f.session.id, "owned-run", f.input(draft));
  const before = f.snapshot();
  const status = await f.request(`/runs/${admitted.run.id}`, { configured: false });
  expect(status.status).toBe(200); privateResponse(status);
  expect(await status.json()).toEqual(admitted.run); expect(f.snapshot()).toEqual(before);
  const stopped = await f.request(`/runs/${admitted.run.id}/stop`, { configured: false, method: "POST", raw: "{}" });
  expect(stopped.status).toBe(200); privateResponse(stopped);
  const view = await stopped.json() as SearchTurnControlView["run"];
  expect(view).toEqual(expect.objectContaining({ id: admitted.run.id, kind: "search", status: "interrupted", outcomeReason: "stopped" }));
  expect(Object.keys(view).sort()).toEqual(Object.keys(admitted.run).sort());
  expect(f.db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(admitted.run.id)).toEqual({ open_slot: 0 });
  expect(f.db.query("SELECT text FROM search_messages WHERE id=?").get(admitted.receipt.userMessageId)).toEqual({ text: "PRIVATE-TURN-TEXT" });
  const again = await f.request(`/runs/${admitted.run.id}/stop`, { configured: false, method: "POST", raw: "{}" });
  expect(again.status).toBe(200); expect(await again.json()).toEqual(view);
}));

test("strict turn admission rejects caller authority, duplicate fields and invalid clocks without writes", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id), input = f.input(draft), base = `/search-sessions/${f.session.id}/turns`;
  const before = f.snapshot();
  for (const raw of [JSON.stringify({ ...input, runId: "caller-run" }), JSON.stringify({ ...input, effort: "invalid-effort" }),
    JSON.stringify({ ...input, requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "Not/A_Zone" } }),
    JSON.stringify({ ...input, requestClock: { at: "2030-01-01T04:00:00+09:00", timeZone: "America/Los_Angeles" } }),
    JSON.stringify({ ...input, requestClock: undefined }), `${JSON.stringify(input).slice(0,-1)},"text":"duplicate"}`]) {
    await expectedError(await f.request(base, { method: "POST", key: "invalid", raw }), 400, "invalid-search-request");
    expect(f.snapshot()).toEqual(before);
  }
  await expectedError(await f.request(`${base}?unknown=1`, { method: "POST", key: "invalid", raw: JSON.stringify(input) }), 400, "invalid-search-request");
  await expectedError(await f.request(base, { method: "POST", raw: JSON.stringify(input) }), 400, "invalid-search-request");
  await expectedError(await f.request(base, { actor: "ai", method: "POST", key: "invalid", raw: JSON.stringify(input) }), 403);
  await expectedError(await f.request(base, { actor: "none", method: "POST", key: "invalid", raw: JSON.stringify(input) }), 401);
  expect(f.snapshot()).toEqual(before);
}));

test("turn keys are scoped to sessions and lookups never return a foreign turn", async () => fixture(async f => {
  const first = f.sessions.admitTurn("user", f.session.id, "same-key", f.input(f.sessions.openComposer("user", f.session.id)));
  const other = f.sessions.create("user", "other-session", {}).session;
  await expectedError(await f.request(`/search-sessions/${other.id}/turns/by-key/same-key`), 404);
  const otherDraft = f.sessions.openComposer("user", other.id);
  const admitted = await f.request(`/search-sessions/${other.id}/turns`, { method: "POST", key: "same-key", raw: JSON.stringify({ ...f.input(otherDraft), text: "OTHER-SESSION-TEXT" }) });
  expect(admitted.status).toBe(201); privateResponse(admitted);
  const second = await admitted.json() as SearchTurnControlView;
  expect(second.receipt.searchSessionId).toBe(other.id); expect(second.run.id).not.toBe(first.run.id);
  const one = await f.request(`/search-sessions/${f.session.id}/turns/by-key/same-key`);
  const two = await f.request(`/search-sessions/${other.id}/turns/by-key/same-key`);
  expect(await one.json()).toEqual(first); expect(await two.json()).toEqual(second);
}));

test("deleted queued session wins over replay, by-key and run access without resurrecting content", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id), input = f.input(draft);
  const admitted = f.sessions.admitTurn("user", f.session.id, "deleted-key", input);
  f.sessions.delete("user", f.session.id); // Local-only safe path: no binding and untouched initial step.
  expect(f.db.query("SELECT count(*) AS n FROM search_messages").get()).toEqual({ n: 0 });
  const before = f.snapshot(), allocated = f.allocated(), base = `/search-sessions/${f.session.id}`;
  for (const response of [await f.request(`${base}/turns/by-key/deleted-key`, { configured: false }),
    await f.request(`/runs/${admitted.run.id}`, { configured: false }),
    await f.request(`/runs/${admitted.run.id}/stop`, { configured: false, method: "POST", raw: "{}" }),
    await f.request(`${base}/turns`, { configured: false, method: "POST", key: "deleted-key", raw: JSON.stringify(input) })]) {
    expect(response.status).toBe(404); privateResponse(response);
    expect(await response.text()).not.toContain("PRIVATE-TURN-TEXT");
  }
  expect(f.snapshot()).toEqual(before); expect(f.allocated()).toBe(allocated);
}));

test("search run Check and Stop reject unauthorized or malformed controls atomically", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const admitted = f.sessions.admitTurn("user", f.session.id, "strict-stop", f.input(draft));
  const path = `/runs/${admitted.run.id}`, before = f.snapshot();
  for (const options of [{ method: "POST", raw: '{"unknown":1}' }, { method: "POST", raw: '{"x":1,"x":2}' }, { method: "POST", raw: "{" }]) {
    await expectedError(await f.request(`${path}/stop`, options), 400);
    expect(f.snapshot()).toEqual(before);
  }
  await expectedError(await f.request(`${path}/stop?x=1`, { method: "POST", raw: "{}" }), 400);
  for (const actor of ["ai", "none"] as const) {
    await expectedError(await f.request(path, { actor }), actor === "ai" ? 403 : 401);
    await expectedError(await f.request(`${path}/stop`, { actor, method: "POST", raw: "{}" }), actor === "ai" ? 403 : 401);
    expect(f.snapshot()).toEqual(before);
  }
  const valid = await f.request(path); expect(valid.status).toBe(200); privateResponse(valid);
  expect(await valid.json()).toEqual(admitted.run);
  expect(f.snapshot()).toEqual(before);
}));
