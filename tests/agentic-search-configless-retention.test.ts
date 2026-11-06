import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import type { SearchComposerView, SearchTurnControlView } from "../src/domain/agentic-search";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { createLogger } from "../src/logging";
import { ScriptedClient } from "./agentic-search-capability-fixture";

const credentials = { user: "owned-user-012345678901234567890123456789", ai: "owned-agent-01234567890123456789012345678" };
const logger = createLogger("error", () => {});
const libraryTables = ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources", "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections", "thought_search_fts", "response_search_fts"];
const library = (db: Database) => libraryTables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
function request(daemon: RunningDaemon, path: string, options: { method?: string; body?: object; key?: string; actor?: "user" | "ai" } = {}) {
  return fetch(new URL(path, daemon.url), { method: options.method ?? "GET", signal: AbortSignal.timeout(3000), headers: {
    authorization: `Bearer ${credentials[options.actor ?? "user"]}`, ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.key ? { "idempotency-key": options.key } : {}),
  }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
function readonly<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path, { readonly: true }); try { return fn(db); } finally { db.close(); }
}

for (const stopFirst of [false, true]) test(`configless runtime locally deletes qualified bound search ${stopFirst ? "after Stop" : "while active"}`, async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "configless-retention-")), dbPath = join(dir, "owned.sqlite");
  const client = new ScriptedClient(() => ({ version: 1, kind: "search-reply", reply: "PRIVATE-FAKE-REPLY", disposition: "done", sourceThoughtIds: [] }));
  client.holdOutput = true;
  let configured: RunningDaemon | undefined, plain: RunningDaemon | undefined, reopened: RunningDaemon | undefined;
  let poll: (() => void) | undefined, forbiddenCalls = 0;
  try {
    const seed = new Database(dbPath);
    try {
      migrate(seed, logger);
      new SqliteStore(seed).saveThought({ id: "library", text: "PRIVATE-LIBRARY-CONTENT", title: null, titleAuthor: null,
        author: "user", kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "fixture", parentId: null, sourceIds: [] });
    } finally { seed.close(); }
    const beforeLibrary = readonly(dbPath, library);
    configured = await startDaemon({ dbPath, port: 0, credentials, agent: { service: { url: "http://127.0.0.1:44991" }, directory: dir,
      model: { providerID: "owned-provider", id: "owned-model" }, effort: { quick: null, standard: null, thorough: null } } }, () => {}, {
      startTimer: callback => { poll = callback; return () => {}; }, resolveAgentService: async () => ({ url: "http://127.0.0.1:44991" }),
      createPublicClient: () => client, logSink: () => {},
    });
    const created = await request(configured, "/search-sessions", { method: "POST", body: {}, key: "session-key" });
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string } };
    const opened = await request(configured, `/search-sessions/${session.id}/composer-contexts`, { method: "POST", body: {} });
    expect(opened.status).toBe(201); const composer = await opened.json() as SearchComposerView;
    const input = { text: "PRIVATE-RETAINED-TURN", startingThoughtIds: [], requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" },
      composerId: composer.composerId, contextToken: composer.contextToken };
    const admitted = await request(configured, `/search-sessions/${session.id}/turns`, { method: "POST", body: input, key: "turn-key" });
    expect(admitted.status).toBe(201); const control = await admitted.json() as SearchTurnControlView;
    for (let i = 0; i < 100 && client.prompts.length === 0; i++) { poll?.(); await Bun.sleep(10); }
    expect(client.prompts).toHaveLength(1); expect(client.scriptErrors).toEqual([]);
    const prompt = client.prompts[0]; if (!prompt) throw new Error("missing admitted native prompt");
    expect(client.sessions.get(prompt.sessionID)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    await configured.stop(); configured = undefined;
    const oldBinding = readonly(dbPath, db => db.query("SELECT execution_owner_id,session_id FROM agent_bindings WHERE run_id=?").get(control.run.id)) as { execution_owner_id: string | null; session_id: string } | null;
    expect(oldBinding?.execution_owner_id).toEqual(expect.any(String)); expect(oldBinding?.session_id).toBe(prompt.sessionID);
    if (!oldBinding?.execution_owner_id) throw new Error("missing qualified predecessor owner");
    expect(readonly(dbPath, db => db.query("SELECT count(*) AS n FROM execution_owners WHERE id=?").get(oldBinding?.execution_owner_id ?? ""))).toEqual({ n: 1 });
    const priorSteps = readonly(dbPath, db => db.query("SELECT position,prompt_id,submit_owner FROM run_steps WHERE run_id=? ORDER BY position").all(control.run.id)) as { position: number; prompt_id: string; submit_owner: string | null }[];
    expect(priorSteps).toEqual([expect.objectContaining({ position: 0, prompt_id: prompt.id, submit_owner: oldBinding.execution_owner_id })]);

    const disabled = { startTimer: () => () => {}, resolveAgentService: async () => { forbiddenCalls++; throw new Error("unexpected resolver"); },
      createPublicClient: () => { forbiddenCalls++; throw new Error("unexpected client"); }, logSink: () => {} };
    plain = await startDaemon({ dbPath, port: 0, credentials }, () => {}, disabled);
    const metadata = await request(plain, `/search-sessions/${session.id}`);
    expect(metadata.status).toBe(200); expect(metadata.headers.get("cache-control")).toContain("no-store");
    const check = await request(plain, `/runs/${control.run.id}`);
    expect(check.status).toBe(200); expect(JSON.stringify(await check.json())).not.toContain("PRIVATE-RETAINED-TURN");
    expect((await request(plain, `/search-sessions/${session.id}`, { actor: "ai" })).status).toBe(403);
    const fresh = await request(plain, "/search-sessions", { method: "POST", body: {}, key: "fresh-key" });
    expect(fresh.status).toBe(201); const freshSession = (await fresh.json() as { session: { id: string } }).session;
    const draftResponse = await request(plain, `/search-sessions/${freshSession.id}/composer-contexts`, { method: "POST", body: {} });
    const draft = await draftResponse.json() as SearchComposerView;
    const preNew = readonly(dbPath, db => db.query("SELECT rowid,* FROM runs ORDER BY rowid").all());
    const unavailable = await request(plain, `/search-sessions/${freshSession.id}/turns`, { method: "POST", key: "fresh-turn", body: { ...input, composerId: draft.composerId, contextToken: draft.contextToken } });
    expect(unavailable.status).toBe(503); expect(readonly(dbPath, db => db.query("SELECT rowid,* FROM runs ORDER BY rowid").all())).toEqual(preNew);
    if (stopFirst) {
      const stopped = await request(plain, `/runs/${control.run.id}/stop`, { method: "POST", body: {} });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual(expect.objectContaining({ status: "interrupted", outcomeReason: "stopped", cancellation: "pending" }));
    }
    expect(forbiddenCalls).toBe(0); expect(client.prompts).toHaveLength(1);
    const existingCleanup = readonly(dbPath, db => db.query("SELECT binding_json,prompt_manifest_json FROM search_native_cleanup WHERE run_id=?").get(control.run.id));
    const beforeForbidden = readonly(dbPath, db => [db.query("SELECT rowid,* FROM search_sessions ORDER BY rowid").all(), db.query("SELECT rowid,* FROM runs ORDER BY rowid").all(), db.query("SELECT rowid,* FROM search_native_cleanup ORDER BY rowid").all()]);
    expect((await request(plain, `/search-sessions/${session.id}`, { method: "DELETE", actor: "ai" })).status).toBe(403);
    expect(readonly(dbPath, db => [db.query("SELECT rowid,* FROM search_sessions ORDER BY rowid").all(), db.query("SELECT rowid,* FROM runs ORDER BY rowid").all(), db.query("SELECT rowid,* FROM search_native_cleanup ORDER BY rowid").all()])).toEqual(beforeForbidden);
    const deleted = await request(plain, `/search-sessions/${session.id}`, { method: "DELETE" });
    if (deleted.status !== 204) throw new Error(`owned configless Delete returned ${deleted.status}: ${await deleted.text()}`);
    expect(deleted.status).toBe(204); expect(deleted.headers.get("cache-control")).toContain("no-store");
    expect((await request(plain, `/search-sessions/${session.id}`, { method: "DELETE" })).status).toBe(204);
    expect(forbiddenCalls).toBe(0); expect(client.prompts).toHaveLength(1);
    const outbox = readonly(dbPath, db => {
      expect(db.query("SELECT title,deleted_at,create_request_key FROM search_sessions WHERE id=?").get(session.id)).toEqual({ title: null, deleted_at: expect.any(String), create_request_key: "session-key" });
      for (const table of ["search_turns", "search_messages", "search_discoveries", "search_content_dependencies", "search_composer_contexts"]) expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(session.id)).toEqual({ n: 0 });
      for (const table of ["runs", "run_steps", "run_context", "agent_bindings"]) expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE ${table === "runs" ? "id" : "run_id"}=?`).get(control.run.id)).toEqual({ n: 0 });
      expect(library(db)).toEqual(beforeLibrary);
      return db.query("SELECT binding_json,prompt_manifest_json,state,drain_state FROM search_native_cleanup WHERE run_id=?").get(control.run.id) as { binding_json: string; prompt_manifest_json: string; state: string; drain_state: string } | null;
    });
    expect(outbox).not.toBeNull(); if (!outbox) throw new Error("missing durable cleanup metadata");
    expect(outbox.state).toBe("pending"); expect(outbox.drain_state).toBe("unknown-after-restart");
    expect(JSON.stringify(outbox)).not.toContain("PRIVATE-RETAINED-TURN"); expect(JSON.stringify(outbox)).not.toContain("PRIVATE-FAKE-REPLY");
    const manifest = JSON.parse(outbox.prompt_manifest_json) as { setupOwnerId: string; nativeSessionId: string; steps: { position: number; promptId: string; submitOwnerId: string | null }[] };
    expect(manifest.setupOwnerId).toBe(oldBinding.execution_owner_id); expect(manifest.nativeSessionId).toBe(prompt.sessionID);
    expect(manifest.steps.map(step => ({ position: step.position, prompt_id: step.promptId, submit_owner: step.submitOwnerId }))).toEqual(priorSteps);
    if (existingCleanup) expect(outbox).toEqual(expect.objectContaining(existingCleanup));
    await plain.stop(); plain = undefined;
    reopened = await startDaemon({ dbPath, port: 0, credentials }, () => {}, disabled);
    expect((await request(reopened, `/runs/${control.run.id}`)).status).toBe(404);
    expect((await request(reopened, `/search-sessions/${session.id}/turns/by-key/turn-key`)).status).toBe(404);
    expect((await request(reopened, "/search-sessions", { method: "POST", body: {}, key: "session-key" })).status).toBe(409);
    expect(readonly(dbPath, db => db.query("SELECT binding_json,prompt_manifest_json,state,drain_state FROM search_native_cleanup WHERE run_id=?").get(control.run.id))).toEqual(outbox);
    expect(readonly(dbPath, library)).toEqual(beforeLibrary); expect(forbiddenCalls).toBe(0); expect(client.prompts).toHaveLength(1);
  } finally {
    client.holdOutput = false;
    await configured?.stop(); await plain?.stop(); await reopened?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
