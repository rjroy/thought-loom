import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import type { SearchComposerView, SearchTurnControlView } from "../src/domain/agentic-search";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { createLogger } from "../src/logging";

const credentials = { user: "owned-user-012345678901234567890123456789", ai: "owned-agent-01234567890123456789012345678" };
const libraryTables = ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources", "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections", "thought_search_fts", "response_search_fts"];
function read<T>(path: string, action: (db: Database) => T): T { const db = new Database(path, { readonly: true }); try { return action(db); } finally { db.close(); } }
function library(db: Database): unknown { return libraryTables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()); }
function http(daemon: RunningDaemon, path: string, options: { method?: string; body?: object; key?: string } = {}) {
  return fetch(new URL(path, daemon.url), { signal: AbortSignal.timeout(3000), method: options.method ?? "GET", headers: { authorization: `Bearer ${credentials.user}`,
    ...(options.body ? { "content-type": "application/json" } : {}), ...(options.key ? { "idempotency-key": options.key } : {}) },
  body: options.body ? JSON.stringify(options.body) : undefined });
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function drive(poll: () => void, predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 150 && !predicate(); i++) { poll(); await Bun.sleep(10); }
  if (!predicate()) throw new Error(`${label} not reached`);
}
async function admit(daemon: RunningDaemon) {
  const created = await http(daemon, "/search-sessions", { method: "POST", body: {}, key: "owned-session" });
  expect(created.status).toBe(201); const { session } = await created.json() as { session: { id: string } };
  const opened = await http(daemon, `/search-sessions/${session.id}/composer-contexts`, { method: "POST", body: {} });
  expect(opened.status).toBe(201); const composer = await opened.json() as SearchComposerView;
  const input = { text: "PRIVATE-USER-TURN", startingThoughtIds: [], requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken };
  const response = await http(daemon, `/search-sessions/${session.id}/turns`, { method: "POST", body: input, key: "owned-turn" });
  expect(response.status).toBe(201); return { session, control: await response.json() as SearchTurnControlView };
}
async function start(path: string, dir: string, client: ScriptedClient, setPoll: (poll: () => void) => void) {
  return startDaemon({ dbPath: path, port: 0, credentials, agent: { service: { url: "http://127.0.0.1:44991" }, directory: dir,
    model: { providerID: "owned-provider", id: "owned-model" }, effort: { quick: null, standard: null, thorough: null } } }, () => {}, {
    startTimer: callback => { setPoll(callback); return () => {}; }, resolveAgentService: async () => ({ url: "http://127.0.0.1:44991" }),
    createPublicClient: () => client, logSink: () => {},
  });
}

test("configured HTTP Delete returns before held native admission and retains only cancellation metadata", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "retention-http-")), path = join(dir, "owned.sqlite");
  const client = new ScriptedClient(() => ({ version: 1, kind: "search-reply", reply: "PRIVATE-NATIVE-REPLY", disposition: "done", sourceThoughtIds: [] }));
  let enter = () => {}, release = () => {}, entered = false, released = false, poll = () => {};
  const reached = new Promise<void>(resolve => { enter = () => { entered = true; resolve(); }; });
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
  client.beforePrompt = async () => { enter(); await gate; };
  let daemon: RunningDaemon | undefined;
  try {
    const seed = new Database(path);
    try {
      migrate(seed, createLogger("error", () => {}));
      new SqliteStore(seed).saveThought({ id: "library", text: "PRIVATE-OWNED-LIBRARY", title: null, titleAuthor: null,
        author: "user", kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "fixture", parentId: null, sourceIds: [] });
    } finally { seed.close(); }
    daemon = await start(path, dir, client, callback => { poll = callback; });
    const { session, control } = await admit(daemon);
    await drive(poll, () => entered, "native submission"); await bounded(reached, "submission entry");
    expect(client.prompts).toHaveLength(0);
    const before = read(path, library);
    const result = await bounded(http(daemon, `/search-sessions/${session.id}`, { method: "DELETE" }), "local Delete");
    expect(result.status).toBe(204); expect(released).toBe(false);
    const outbox = read(path, db => {
      expect(db.query("SELECT id FROM runs WHERE id=?").get(control.run.id)).toBeNull();
      expect(db.query("SELECT count(*) AS n FROM search_messages WHERE session_id=?").get(session.id)).toEqual({ n: 0 });
      expect(library(db)).toEqual(before);
      return db.query("SELECT state,drain_state,prompt_manifest_json,evidence_json FROM search_native_cleanup WHERE run_id=?").get(control.run.id) as { state: string; drain_state: string; prompt_manifest_json: string; evidence_json: string | null } | null;
    });
    if (!outbox) throw new Error("missing durable cleanup");
    expect(outbox.state).toBe("pending"); expect(outbox.drain_state).not.toBe("drained");
    expect(JSON.stringify(outbox)).not.toContain("PRIVATE-USER-TURN"); expect(JSON.stringify(outbox)).not.toContain("PRIVATE-NATIVE-REPLY");
    client.historyMode = "empty"; release();
    await drive(poll, () => client.prompts.length === 1, "late native admission");
    const prompt = client.prompts[0]; if (!prompt) throw new Error("missing late admitted prompt");
    expect(client.sessions.get(prompt.sessionID)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    await drive(poll, () => read(path, db => (db.query("SELECT drain_state FROM search_native_cleanup WHERE run_id=?").get(control.run.id) as { drain_state: string } | null)?.drain_state === "drained"), "joined local flight");
    const pending = read(path, db => db.query("SELECT state,admission_state,prompt_manifest_json,evidence_json FROM search_native_cleanup WHERE run_id=?").get(control.run.id)) as { state: string; admission_state: string; prompt_manifest_json: string; evidence_json: string | null };
    expect(pending.state).toBe("pending"); expect(pending.prompt_manifest_json).toBe(outbox.prompt_manifest_json);
    expect(pending.admission_state).toBe("admitted"); expect(pending.evidence_json).not.toBeNull();
    expect(JSON.stringify(pending)).not.toContain("PRIVATE-USER-TURN"); expect(JSON.stringify(pending)).not.toContain("PRIVATE-NATIVE-REPLY");
    expect(client.prompts).toHaveLength(1); expect(read(path, library)).toEqual(before);
    expect(read(path, db => db.query("SELECT id FROM runs WHERE id=?").get(control.run.id))).toBeNull();
    client.historyMode = "normal";
    await drive(poll, () => read(path, db => { const row = db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(control.run.id) as { state: string } | null; return row === null || row.state === "settled"; }), "owned terminal settlement");
    expect(client.prompts).toHaveLength(1); expect(read(path, library)).toEqual(before);
  } finally { release(); await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("daemon shutdown holds its execution lease until a held cleanup history call drains", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "retention-drain-http-")), path = join(dir, "owned.sqlite");
  const client = new ScriptedClient(() => ({ version: 1, kind: "search-reply", reply: "PRIVATE-NATIVE-REPLY", disposition: "done", sourceThoughtIds: [] }));
  client.holdOutput = true;
  let release = () => {}, enter = () => {}, entered = false, poll = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { enter = () => { entered = true; resolve(); }; });
  let daemon: RunningDaemon | undefined, reopened: RunningDaemon | undefined, stopping: Promise<void> | undefined;
  try {
    daemon = await start(path, dir, client, callback => { poll = callback; });
    const { control } = await admit(daemon);
    await drive(poll, () => client.prompts.length === 1, "initial native submission");
    const stopped = await http(daemon, `/runs/${control.run.id}/stop`, { method: "POST", body: {} });
    expect(stopped.status).toBe(200);
    client.beforeHistory = async () => { enter(); await gate; }; client.historyMode = "empty";
    await drive(poll, () => entered, "cleanup history"); await bounded(reached, "cleanup RPC");
    let settled = false;
    stopping = daemon.stop().then(() => { settled = true; });
    let contender: RunningDaemon | undefined, failure: unknown;
    try { contender = await startDaemon({ dbPath: path, port: 0, credentials }, () => {}, { logSink: () => {} }); }
    catch (error) { failure = error; }
    finally { await contender?.stop(); }
    expect(failure instanceof Error ? failure.message : null).toBe("Daemon startup failed: execution owner already held");
    expect(settled).toBe(false);
    expect(read(path, db => db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(control.run.id))).toEqual({ state: "pending" });
    release(); await bounded(stopping, "daemon cleanup drain"); daemon = undefined; stopping = undefined;
    reopened = await startDaemon({ dbPath: path, port: 0, credentials }, () => {}, { logSink: () => {} });
    const controlAfter = await http(reopened, `/runs/${control.run.id}`);
    expect(controlAfter.status).toBe(200);
    expect(await controlAfter.json()).toEqual(expect.objectContaining({ status: "interrupted", outcomeReason: "stopped", cancellation: "pending" }));
    expect(client.prompts).toHaveLength(1);
  } finally { release(); if (stopping) await stopping; await daemon?.stop(); await reopened?.stop(); await rm(dir, { recursive: true, force: true }); }
});
