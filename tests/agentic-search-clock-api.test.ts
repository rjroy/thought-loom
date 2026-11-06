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
import { SearchClockReceipts } from "../src/daemon/search-clock-receipts";
import { SqliteRunRepository } from "../src/storage/run";
import { RunService } from "../src/domain/run";
import { AgentService } from "../src/domain/agent";
import { SqliteAgentRuns } from "../src/storage/agent";

const logger = createLogger("error", () => {});
const credentials = { user: "owned-user-token", ai: "owned-ai-token" };

async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const f = setup(); try { await action(f); } finally { f.db.close(); }
}
function setup() {
  const db = new Database(":memory:"); migrate(db);
  let sequence = 0;
  const sources = { id: () => `owned-${++sequence}`, now: () => "2030-01-01T12:00:00.000Z", logger };
  const store = new SqliteStore(db), sessions = store.searchSessions(sources);
  const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
  const creation = new CreationService({ ...sources, rejection, writes: { createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection) } });
  const titles = new TitleService(new SqliteTitleRepository(db, sources));
  const events: unknown[] = [];
  const receipts = new SearchClockReceipts(sessions, sources.now);
  const runs = new SqliteRunRepository(db, sources);
  const stop = new RunService({ repository: runs, ...sources, dispatcher: { submit: async () => { throw new Error("unused"); }, observe: async () => { throw new Error("unused"); } } });
  const app = createApp({ rejection, creation, titles, credentials, searchSessions: sessions, searchClockReceipts: receipts,
    agents: new AgentService(new SqliteAgentRuns(db, sources), false), diagnostics: logger, logger: event => events.push(event) });
  const session = sessions.create("user", "owned-session", {}).session;
  function request(path: string, headers: Record<string,string> = {}, actor: "user" | "ai" | "none" = "user", method = "GET") {
    const all = new Headers(headers);
    if (actor !== "none") all.set("authorization", `Bearer ${credentials[actor]}`);
    return app.request(path, { method, headers: all });
  }
  const snapshot = () => ["search_sessions", "search_turns", "search_messages", "runs", "run_steps", "search_composer_contexts", "thoughts"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  return { db, session, sessions, request, snapshot, events, receipts, stop, runs };
}
const time = "X-Thoughtloom-Client-Time", zone = "X-Thoughtloom-Client-Zone";

test("no-header direct API metadata control works without creating clock records", async () => fixture(async f => {
  const before = f.snapshot(), response = await f.request(`/search-sessions/${f.session.id}`);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
  expect((await response.json() as { session: { id: string } }).session.id).toBe(f.session.id);
  expect(f.snapshot()).toEqual(before);
}));

test("receipt ownership prevents stale arrivals, foreign sessions and fenced runs from contaminating a new turn", async () => fixture(async f => {
  const input = (composer: { composerId: string; contextToken: string }) => ({ text: "owned", startingThoughtIds: [],
    requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
  const draft = f.sessions.openComposer("user", f.session.id);
  const first = f.sessions.admitTurn("user", f.session.id, "first", input(draft));
  const original = f.receipts.ownerRun(first.run.id); if (!original) throw new Error("missing owned clock identity");
  const make = (at: string) => f.receipts.parse(new Headers({ [time]: at, [zone]: "UTC" }));
  const early = make("2030-01-01T12:00:00Z"), late = make("2030-01-01T12:01:00Z");
  f.receipts.record(original, late); f.receipts.record(original, early);
  expect(f.receipts.latest(original)?.clock.at).toBe("2030-01-01T12:01:00Z");
  f.runs.claim(first.run.id);
  const advanced = f.receipts.ownerRun(first.run.id); if (!advanced) throw new Error("missing claimed owner");
  expect(advanced.generation).toBeGreaterThan(original.generation);
  f.receipts.record(original, make("2030-01-01T12:02:00Z"));
  expect(f.receipts.latest(original)).toBeNull();
  expect(f.receipts.latest(advanced)?.clock.at).toBe("2030-01-01T12:01:00Z");
  expect(f.receipts.latest({ ...advanced, searchSessionId: "foreign-session" })).toBeNull();
  f.stop.stop("user", first.run.id);
  const next = f.sessions.admitTurn("user", f.session.id, "next", input(f.sessions.openComposer("user", f.session.id)));
  const nextOwner = f.receipts.ownerRun(next.run.id); if (!nextOwner) throw new Error("missing next owner");
  f.receipts.record(advanced, make("2030-01-01T12:03:00Z"));
  expect(f.receipts.latest(advanced)).toBeNull(); expect(f.receipts.latest(nextOwner)).toBeNull();
  f.receipts.record(nextOwner, make("2030-01-01T12:04:00Z"));
  expect(f.receipts.latest(nextOwner)?.clock.at).toBe("2030-01-01T12:04:00Z");
  f.receipts.forgetRun(next.run.id); expect(f.receipts.latest(nextOwner)).toBeNull();
  f.receipts.record(nextOwner, make("2030-01-01T12:05:00Z"));
  f.receipts.forgetSession(f.session.id); expect(f.receipts.latest(nextOwner)).toBeNull();
  f.receipts.record(nextOwner, make("2030-01-01T12:06:00Z"));
  f.receipts.clear(); expect(f.receipts.latest(nextOwner)).toBeNull();
}));

test("receipt headers reject duplicates while ordinary run status ignores malformed clock headers", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const run = f.sessions.admitTurn("user", f.session.id, "active", { text: "owned", requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: draft.composerId, contextToken: draft.contextToken });
  const before = f.snapshot();
  for (const headers of [{ [time]: "2030-01-01T12:00:00Z, 2030-01-01T12:00:00Z", [zone]: "UTC" },
    { [time]: "2030-01-01T12:00:00Z", [zone]: "UTC, UTC" }]) {
    const response = await f.request(`/runs/${run.run.id}`, headers);
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(f.snapshot()).toEqual(before);
  // Ordinary run read does not interpret the search-only transport clock.
  f.db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin) VALUES ('ordinary-source','owned','user','captured-original','2030','fixture')");
  f.db.run("INSERT INTO thought_titles VALUES ('ordinary-source',NULL,NULL)"); f.db.run("INSERT INTO thought_source_seals VALUES ('ordinary-source')");
  const ordinary = new SqliteAgentRuns(f.db, { id: (() => { let i = 0; return () => `ordinary-${++i}`; })(), now: () => "2030-01-01T12:00:00.000Z", logger }).admitEvolve("ordinary-source", "owned contribution");
  const response = await f.request(`/runs/${ordinary.run.id}`, { [time]: "invalid", [zone]: "UTC" });
  expect(response.status).toBe(200); expect(await response.json()).toEqual(ordinary.run);
}));

test("local Delete rollback keeps its receipt and successful Delete forgets the owner", async () => fixture(async f => {
  const draft = f.sessions.openComposer("user", f.session.id);
  const run = f.sessions.admitTurn("user", f.session.id, "queued", { text: "owned", requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: draft.composerId, contextToken: draft.contextToken });
  const owner = f.receipts.ownerRun(run.run.id); if (!owner) throw new Error("missing active owner");
  const headers = { [time]: "2035-06-01T12:00:00Z", [zone]: "UTC" };
  expect((await f.request(`/search-sessions/${f.session.id}`, headers)).status).toBe(200);
  const receipt = f.receipts.latest(owner); expect(receipt?.clock.at).toBe(headers[time]);
  const before = f.snapshot();
  f.db.exec("CREATE TEMP TRIGGER owned_delete_failure BEFORE UPDATE OF deleted_at ON search_sessions BEGIN SELECT RAISE(ABORT,'owned failure'); END");
  const failed = await f.request(`/search-sessions/${f.session.id}`, {}, "user", "DELETE");
  expect(failed.status).toBe(500); expect(failed.headers.get("cache-control")).toContain("no-store");
  expect(f.snapshot()).toEqual(before); expect(f.receipts.latest(owner)).toEqual(receipt);
  f.db.exec("DROP TRIGGER temp.owned_delete_failure");
  const deleted = await f.request(`/search-sessions/${f.session.id}`, {}, "user", "DELETE");
  expect(deleted.status).toBe(204); expect(f.receipts.latest(owner)).toBeNull();
  expect(f.db.query("SELECT count(*) AS n FROM search_messages").get()).toEqual({ n: 0 });
}));

for (const [label, headers] of [
  ["time only", { [time]: "2035-06-01T12:00:00Z" }],
  ["zone only", { [zone]: "UTC" }],
  ["unknown zone", { [time]: "2035-06-01T12:00:00Z", [zone]: "Not/A_Zone" }],
  ["offset contradicts zone", { [time]: "2035-06-01T12:00:00+09:00", [zone]: "America/Los_Angeles" }],
  ["malformed time", { [time]: "not-a-time", [zone]: "UTC" }],
] as const) test(`scoped metadata rejects ${label} client clock before any write`, async () => fixture(async f => {
  const before = f.snapshot();
  const response = await f.request(`/search-sessions/${f.session.id}`, headers);
  expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toContain("private"); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual(expect.objectContaining({ code: "invalid-search-request" }));
  expect(f.snapshot()).toEqual(before);
}));

test("valid skewed clock polls are read-only and user-scoped, not record time authority", async () => fixture(async f => {
  const headers = { [time]: "2035-06-01T05:00:00-07:00", [zone]: "America/Los_Angeles" };
  const before = f.snapshot();
  for (let i = 0; i < 3; i++) {
    const response = await f.request(`/search-sessions/${f.session.id}`, headers);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(expect.objectContaining({ session: f.session }));
  }
  expect(f.snapshot()).toEqual(before);
  const ai = await f.request(`/search-sessions/${f.session.id}`, headers, "ai"); expect(ai.status).toBe(403);
  const unauthenticated = await f.request(`/search-sessions/${f.session.id}`, headers, "none"); expect(unauthenticated.status).toBe(401);
  expect((await f.request("/search-sessions/no-such-session", headers)).status).toBe(404);
  expect(f.snapshot()).toEqual(before);
  expect(JSON.stringify(f.events)).not.toContain(headers[time]);
  expect(JSON.stringify(f.events)).not.toContain(credentials.user);
}));
