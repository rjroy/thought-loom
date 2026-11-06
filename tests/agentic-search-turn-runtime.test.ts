import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SearchComposerView, SearchTurnControlView } from "../src/domain/agentic-search";
import { startDaemon } from "../src/daemon/runtime";

test("configured runtime commits HTTP admission and wakes supervisor while resolver is unavailable", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "search-turn-runtime-"));
  const dbPath = join(dir, "owned.sqlite"), user = "owned-user-012345678901234567890123456789", ai = "owned-agent-01234567890123456789012345678";
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let resolutions = 0, clients = 0, polls = 0;
  try {
    const daemon = await startDaemon({ dbPath, port: 0, credentials: { user, ai }, agent: {
      service: { url: "http://127.0.0.1:44991" }, directory: dir,
      model: { providerID: "owned-provider", id: "owned-model" }, effort: { quick: null, standard: null, thorough: null },
    } }, () => {}, {
      startTimer: () => { polls++; return () => {}; }, // Never fires: only the postcommit wake can dispatch.
      resolveAgentService: async () => { resolutions++; entered(); await barrier; throw new Error("owned service unavailable"); },
      createPublicClient: () => { clients++; throw new Error("unexpected client"); },
      logSink: () => {},
    });
    try {
      const request = (path: string, method = "GET", body?: string, key?: string) => fetch(new URL(path, daemon.url), {
        method, headers: { authorization: `Bearer ${user}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) },
        body, signal: AbortSignal.timeout(3000),
      });
      const sessionResponse = await request("/search-sessions", "POST", "{}", "session");
      expect(sessionResponse.status).toBe(201);
      const { session } = await sessionResponse.json() as { session: { id: string } };
      const composerResponse = await request(`/search-sessions/${session.id}/composer-contexts`, "POST", "{}");
      expect(composerResponse.status).toBe(201);
      const composer = await composerResponse.json() as SearchComposerView;
      expect(resolutions).toBe(0);
      const response = await request(`/search-sessions/${session.id}/turns`, "POST", JSON.stringify({ text: "OWNED-RUNTIME-TURN", startingThoughtIds: [],
        requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken }), "turn");
      expect(response.status).toBe(201);
      const control = await response.json() as SearchTurnControlView;
      expect(control.run.status).toBe("queued");
      await Promise.race([reached, Bun.sleep(3000).then(() => { throw new Error("postcommit wake did not reach resolver"); })]);
      const db = new Database(dbPath, { readonly: true });
      try { expect(db.query("SELECT run_id FROM search_turns WHERE run_id=?").get(control.run.id)).toEqual({ run_id: control.run.id }); }
      finally { db.close(); }
      expect(polls).toBe(1); expect(resolutions).toBe(1); expect(clients).toBe(0);
      release();
      const check = await request(`/runs/${control.run.id}`);
      expect(check.status).toBe(200);
      expect(JSON.stringify(await check.json())).not.toContain("OWNED-RUNTIME-TURN");
    } finally { release(); await daemon.stop(); }
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});
