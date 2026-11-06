import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon } from "../src/daemon/runtime";
import type { SearchComposerView, SearchTurnControlView } from "../src/domain/agentic-search";
import type { SearchClockContext } from "../src/domain/search-time";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { drive, fixture, logger, request as capabilityRequest } from "./agentic-search-capability-fixture";
import { SearchClockReceipts } from "../src/daemon/search-clock-receipts";
import { createApp } from "../src/daemon/app";
import { CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import { TitleService } from "../src/domain/title";
import { AgentService } from "../src/domain/agent";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteTitleRepository } from "../src/storage/title";
import { SqliteAgentRuns } from "../src/storage/agent";

test("HTTP client observation reaches the actual first native input without moving the request anchor", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "clock-http-runtime-"));
  const dbPath = join(dir, "owned.sqlite"), user = "owned-user-012345678901234567890123456789", ai = "owned-agent-01234567890123456789012345678";
  const anchor = { at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" };
  const observed = { at: "2035-06-01T05:00:00-07:00", timeZone: "America/Los_Angeles" };
  const client = new ScriptedClient(() => ({ version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] }));
  client.holdOutput = true;
  let poll: (() => void) | undefined;
  try {
    const daemon = await startDaemon({ dbPath, port: 0, credentials: { user, ai }, agent: {
      service: { url: "http://127.0.0.1:44991" }, directory: dir,
      model: { providerID: "owned-provider", id: "owned-model" }, effort: { quick: null, standard: null, thorough: null },
    } }, () => {}, { startTimer: callback => { poll = callback; return () => {}; },
      resolveAgentService: async () => ({ url: "http://127.0.0.1:44991" }), createPublicClient: () => client, logSink: () => {} });
    try {
      const request = (path: string, method = "GET", body?: string, extra: Record<string,string> = {}) => fetch(new URL(path, daemon.url), {
        method, headers: { authorization: `Bearer ${user}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
        body, signal: AbortSignal.timeout(3000),
      });
      const created = await request("/search-sessions", "POST", "{}", { "idempotency-key": "session" });
      expect(created.status).toBe(201);
      const { session } = await created.json() as { session: { id: string; createdAt: string } };
      const opened = await request(`/search-sessions/${session.id}/composer-contexts`, "POST", "{}");
      expect(opened.status).toBe(201);
      const composer = await opened.json() as SearchComposerView;
      const payload = { text: "OWNED-CLOCK-TURN", startingThoughtIds: [], requestClock: anchor, composerId: composer.composerId, contextToken: composer.contextToken };
      const headers = { "idempotency-key": "turn", "X-Thoughtloom-Client-Time": observed.at, "X-Thoughtloom-Client-Zone": observed.timeZone };
      const admitted = await request(`/search-sessions/${session.id}/turns`, "POST", JSON.stringify(payload), headers);
      expect(admitted.status).toBe(201);
      const control = await admitted.json() as SearchTurnControlView;
      // Bounded test scheduling of the existing supervisor, not an application turn quota.
      for (let i = 0; i < 100 && client.prompts.length === 0; i++) { poll?.(); await Bun.sleep(10); }
      expect(client.prompts).toHaveLength(1); expect(client.scriptErrors).toEqual([]);
      const prompt = client.prompts[0]; if (!prompt) throw new Error("missing actual native input");
      expect(client.sessions.get(prompt.sessionID)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query("SELECT admitted_at,intent_json FROM search_turns WHERE run_id=?").get(control.run.id) as { admitted_at: string; intent_json: string };
        expect(JSON.parse(row.intent_json)).toEqual(expect.objectContaining({ requestClock: anchor, daemonObservedAt: row.admitted_at }));
        expect(row.admitted_at).toBe(control.receipt.admittedAt);
        expect(row.admitted_at).not.toBe(observed.at); expect(session.createdAt).not.toBe(observed.at);
        expect(db.query("SELECT input FROM run_steps WHERE run_id=? ORDER BY position").get(control.run.id)).toEqual({ input: prompt.text });
        const stepBefore = db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(control.run.id);
        for (let i = 0; i < 3; i++) expect((await request(`/search-sessions/${session.id}`, "GET", undefined, headers)).status).toBe(200);
        expect(db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(control.run.id)).toEqual(stepBefore);
        expect(client.prompts).toHaveLength(1);
        const replay = await request(`/search-sessions/${session.id}/turns`, "POST", JSON.stringify(payload), {
          ...headers, "X-Thoughtloom-Client-Time": "2035-06-01T06:00:00-07:00",
        });
        expect(replay.status).toBe(200);
        expect((await replay.json() as SearchTurnControlView).receipt).toEqual(control.receipt);
        expect(db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(control.run.id)).toEqual(stepBefore);
        expect(client.prompts).toHaveLength(1);
      } finally { db.close(); }
      const parsed = JSON.parse(prompt.text) as { context: { job: { clockContext: SearchClockContext } } };
      const context = parsed.context.job.clockContext;
      expect(context.requestAnchor.clock).toEqual(anchor);
      expect(context.observedNow.clock).toEqual(observed);
      expect(context.observedNow.source).toBe("latest");
      expect(context.observedNow.offsetBasis).toBe("apparent-including-transit-delay");
      expect(context.observedNow.clientMinusDaemonMs).toBe(Date.parse(observed.at) - Date.parse(context.observedNow.daemonObservedAt));
    } finally { client.holdOutput = false; await daemon.stop(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("HTTP polls refresh only the next normal model input using the real receipt and worker ports", async () => {
  let wall = "2030-01-01T12:00:03.000Z", elapsed = 0;
  let receipts: SearchClockReceipts | undefined;
  const anchor = { at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" };
  const firstSample = { at: "2030-01-01T12:00:00Z", timeZone: "UTC" };
  const laterSample = { at: "2030-01-01T05:59:30-08:00", timeZone: "America/Los_Angeles" };
  await fixture(index => index === 0 ? capabilityRequest("readSearchConversation", { beforePosition: null, limit: 25 }) :
    { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] }, async (db, store, worker, client, id) => {
    const sources = { id, now: () => wall, logger }, sessions = store.searchSessions(sources);
    receipts = new SearchClockReceipts(sessions, () => wall);
    const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
    const creation = new CreationService({ rejection, ...sources, writes: { createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection) } });
    const titles = new TitleService(new SqliteTitleRepository(db, sources));
    const agents = new AgentService(new SqliteAgentRuns(db, sources), true);
    const app = createApp({ rejection, creation, titles, agents, searchSessions: sessions, searchAgentsConfigured: true, searchClockReceipts: receipts,
      credentials: { user: "owned-user", ai: "owned-ai" }, logger: () => {}, diagnostics: logger });
    function http(path: string, options: { method?: string; body?: object; key?: string; sample?: typeof anchor } = {}) {
      const headers = new Headers({ authorization: "Bearer owned-user" });
      if (options.body) headers.set("content-type", "application/json");
      if (options.key) headers.set("idempotency-key", options.key);
      if (options.sample) { headers.set("X-Thoughtloom-Client-Time", options.sample.at); headers.set("X-Thoughtloom-Client-Zone", options.sample.timeZone); }
      return app.request(path, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    }
    const session = sessions.create("user", "session", {}).session, draft = sessions.openComposer("user", session.id);
    client.holdOutput = true;
    const response = await http(`/search-sessions/${session.id}/turns`, { method: "POST", key: "turn", sample: firstSample,
      body: { text: "owned intent", requestClock: anchor, composerId: draft.composerId, contextToken: draft.contextToken } });
    expect(response.status).toBe(201);
    const control = await response.json() as SearchTurnControlView;
    for (let i = 0; i < 24 && client.prompts.length === 0; i++) await worker.tick(control.run.id);
    expect(client.prompts).toHaveLength(1);
    const first = client.prompts[0]; if (!first) throw new Error("missing first input");
    const firstContext = (JSON.parse(first.text) as { context: { job: { clockContext: SearchClockContext } } }).context.job.clockContext;
    expect(firstContext.requestAnchor.clock).toEqual(anchor); expect(firstContext.observedNow.clock).toEqual(firstSample);
    const before = db.query("SELECT position,prompt_id,input FROM run_steps WHERE run_id=? ORDER BY position").all(control.run.id);
    wall = "2030-01-01T13:00:04.000Z"; elapsed = 3_601_000;
    for (let i = 0; i < 3; i++) {
      expect((await http(`/search-sessions/${session.id}`, { sample: laterSample })).status).toBe(200);
      expect((await http(`/runs/${control.run.id}`, { sample: laterSample })).status).toBe(200);
      await worker.tick(control.run.id);
    }
    expect(client.prompts).toHaveLength(1);
    expect(db.query("SELECT position,prompt_id,input FROM run_steps WHERE run_id=? ORDER BY position").all(control.run.id)).toEqual(before);
    client.holdOutput = false;
    await drive(worker, db, control.run.id);
    expect(client.prompts).toHaveLength(2); expect(client.scriptErrors).toEqual([]);
    const successor = client.prompts[1]; if (!successor) throw new Error("missing capability result input");
    const secondContext = (JSON.parse(successor.text) as { clockContext: SearchClockContext }).clockContext;
    expect(secondContext.requestAnchor).toEqual(firstContext.requestAnchor);
    expect(secondContext.observedNow).toEqual(expect.objectContaining({ clock: laterSample, daemonObservedAt: wall, source: "latest", offsetBasis: "apparent-including-transit-delay" }));
    expect(secondContext.observedNow.clientMinusDaemonMs).toBe(Date.parse(laterSample.at) - Date.parse(wall));
    expect(db.query("SELECT input FROM run_steps WHERE run_id=? ORDER BY position").all(control.run.id)).toEqual(client.prompts.map(prompt => ({ input: prompt.text })));
  }, () => wall, { monotonicNow: () => elapsed, latestObservation: owner => receipts?.latest(owner) ?? null });
});
