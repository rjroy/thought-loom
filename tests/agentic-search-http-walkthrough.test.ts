import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import type { SearchComposerView, SearchTurnControlView } from "../src/domain/agentic-search";
import { ScriptedClient, request as capability } from "./agentic-search-capability-fixture";

const credentials = { user: "owned-user-012345678901234567890123456789", ai: "owned-agent-01234567890123456789012345678" };
const libraryTables = ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources", "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections", "thought_search_fts", "response_search_fts"];
function read<T>(path: string, action: (db: Database) => T): T { const db = new Database(path, { readonly: true }); try { return action(db); } finally { db.close(); } }
function library(db: Database): unknown { return libraryTables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()); }
const clock = { at: "2030-01-01T00:00:00Z", timeZone: "UTC" };

test("isolated HTTP search walkthrough with a deterministic decoded fake agent", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "search-http-walkthrough-")), path = join(dir, "owned.sqlite");
  let daemon: RunningDaemon | undefined, poll = () => {}, turnNumber = 0, firstId = "", secondId = "", holdFinal = false, entered = false, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const starts: { turn: number; sessionID: string; input: string }[] = [];
  const client = new ScriptedClient((_index, input) => {
    const value = JSON.parse(input) as { kind: string; context?: { job?: { kind?: string } }; request?: { capability: string }; result?: unknown };
    if (value.kind === "job" && value.context?.job?.kind === "weave") return { version: 1, kind: "complete", reply: "No additional findings." };
    if (value.kind === "job" && value.context?.job?.kind === "search") {
      turnNumber++;
      if (turnNumber >= 4) return { version: 1, kind: "search-reply", reply: "No additional findings.", disposition: "done", sourceThoughtIds: [] };
      return capability("findThoughts", { query: "cobalt", authors: [], kinds: [], from: null, until: null, sort: "oldest", limit: 25, cursor: null });
    }
    const target = turnNumber === 2 ? secondId : firstId;
    if (value.request?.capability === "findThoughts") {
      if (!JSON.stringify(value.result).includes(target)) throw new Error("expected owned eligible candidate");
      return capability("readThought", { id: target });
    }
    if (value.request?.capability === "readThought") return capability("addDiscovery", { thoughtId: target, why: "Recorded evidence is relevant.", evidenceThoughtIds: [] });
    if (value.request?.capability === "addDiscovery") {
      if (turnNumber === 2) holdFinal = true;
      return { version: 1, kind: "search-reply", reply: turnNumber === 1 ? "Which direction should I explore?" : "Recorded findings are ready.",
        disposition: turnNumber === 1 ? "awaiting-user" : "done", sourceThoughtIds: [target] };
    }
    throw new Error("unexpected owned fake-agent protocol");
  });
  client.beforeHistory = async () => { if (holdFinal) { entered = true; await gate; } };
  function req(pathname: string, options: { method?: string; body?: object; key?: string } = {}) {
    if (!daemon) throw new Error("owned daemon unavailable");
    return fetch(new URL(pathname, daemon.url), { method: options.method ?? "GET", signal: AbortSignal.timeout(4000), headers: {
      authorization: `Bearer ${credentials.user}`, "X-Thoughtloom-Client-Time": "2030-01-01T00:01:00Z", "X-Thoughtloom-Client-Zone": "UTC",
      ...(options.body ? { "content-type": "application/json" } : {}), ...(options.key ? { "idempotency-key": options.key } : {}),
    }, body: options.body ? JSON.stringify(options.body) : undefined });
  }
  async function json<T>(response: Response, status: number): Promise<T> { expect(response.status).toBe(status); return await response.json() as T; }
  async function waitFor(predicate: () => boolean, label: string) {
    for (let i = 0; i < 500 && !predicate(); i++) { poll(); await Bun.sleep(10); }
    if (!predicate()) throw new Error(`owned walkthrough ${label} not reached`);
  }
  const runStatus = (id: string) => read(path, db => (db.query("SELECT status FROM runs WHERE id=?").get(id) as { status: string } | null)?.status);
  const promptStarts = () => client.prompts.filter(p => {
    const value = JSON.parse(p.text) as { kind: string; context?: { job?: { kind?: string } } };
    return value.kind === "job" && value.context?.job?.kind === "search";
  });
  try {
    daemon = await startDaemon({ dbPath: path, port: 0, credentials, agent: { service: { url: "http://127.0.0.1:44991" }, directory: dir,
      model: { providerID: "owned-provider", id: "owned-model" }, effort: { quick: null, standard: null, thorough: null } } }, () => {}, {
      startTimer: callback => { poll = callback; return () => {}; }, resolveAgentService: async () => ({ url: "http://127.0.0.1:44991" }),
      createPublicClient: () => client, logSink: () => {},
    });
    const first = await json<{ id: string }>(await req("/thoughts", { method: "POST", body: { text: "cobalt first REJECTED-SENTINEL", title: "First" } }), 201);
    const second = await json<{ id: string }>(await req("/thoughts", { method: "POST", body: { text: "cobalt second source", title: "Second" } }), 201);
    firstId = first.id; secondId = second.id;
    await waitFor(() => read(path, db => (db.query("SELECT count(*) AS n FROM runs WHERE kind='weave' AND status NOT IN ('completed','failed','interrupted')").get() as { n: number }).n === 0), "background weaves");
    expect(client.scriptErrors).toEqual([]);
    const initialLibrary = read(path, library);
    console.log("walkthrough: captured owned thoughts; fake weaves settled");
    const session = (await json<{ session: { id: string } }>(await req("/search-sessions", { method: "POST", body: {}, key: "session-one" }), 201)).session;
    const other = (await json<{ session: { id: string } }>(await req("/search-sessions", { method: "POST", body: {}, key: "session-two" }), 201)).session;
    async function composer(sessionId: string) { return json<SearchComposerView>(await req(`/search-sessions/${sessionId}/composer-contexts`, { method: "POST", body: {} }), 201); }
    async function submit(sessionId: string, draft: SearchComposerView, key: string, text: string) {
      const body = { text, requestClock: clock, composerId: draft.composerId, contextToken: draft.contextToken };
      return { body, response: await req(`/search-sessions/${sessionId}/turns`, { method: "POST", key, body }) };
    }
    const firstDraft = await composer(session.id);
    const firstSubmission = await submit(session.id, firstDraft, "shared-key", "Explore the topic.");
    // Simulate a caller losing the successful response after the daemon committed it.
    expect(firstSubmission.response.status).toBe(201); await firstSubmission.response.body?.cancel();
    const firstControl = await json<SearchTurnControlView>(await req(`/search-sessions/${session.id}/turns/by-key/shared-key`), 200);
    expect(JSON.stringify(firstControl)).not.toContain("Explore the topic.");
    const replay = await json<SearchTurnControlView>(await req(`/search-sessions/${session.id}/turns`, { method: "POST", body: firstSubmission.body, key: "shared-key" }), 200);
    expect(replay.receipt).toEqual(firstControl.receipt);
    await waitFor(() => runStatus(firstControl.run.id) === "completed", `first run ${firstControl.run.id}`);
    expect(promptStarts()).toHaveLength(1); expect(client.scriptErrors).toEqual([]);
    const viewDraft = await composer(session.id);
    const messages = await json<SearchComposerView & { items: { text: string | null; disposition: string | null }[] }>(await req(`/search-sessions/${session.id}/messages?composerId=${viewDraft.composerId}`), 200);
    expect(messages.items.map(item => item.disposition)).toContain("awaiting-user");
    const discoveries = await json<SearchComposerView & { items: { id: string; thought: { id: string } | null }[] }>(await req(`/search-sessions/${session.id}/discoveries?composerId=${viewDraft.composerId}`), 200);
    expect(discoveries.items).toHaveLength(1); expect(discoveries.items[0]?.thought?.id).toBe(firstId);
    const removedId = discoveries.items[0]?.id; if (!removedId) throw new Error("missing first occurrence");
    console.log("walkthrough: recovered admission and clarification; registered current composer");
    const secondSubmission = await submit(session.id, discoveries, "second-turn", "Explore another direction.");
    const secondControl = await json<SearchTurnControlView>(secondSubmission.response, 201);
    await waitFor(() => entered, `held reply ${secondControl.run.id}`);
    const removed = await req(`/search-sessions/${session.id}/discoveries/${removedId}`, { method: "DELETE" });
    expect(removed.status).toBe(204); expect(removed.headers.get("search-session-revision")).toMatch(/^\d+$/);
    holdFinal = false; release();
    await waitFor(() => runStatus(secondControl.run.id) === "completed", `second run ${secondControl.run.id}`);
    const thirdDraft = await composer(session.id);
    const thirdMessages = await json<SearchComposerView>(await req(`/search-sessions/${session.id}/messages?composerId=${thirdDraft.composerId}`), 200);
    const thirdView = await json<SearchComposerView & { items: { id: string; thought: { id: string } | null }[] }>(await req(`/search-sessions/${session.id}/discoveries?composerId=${thirdMessages.composerId}`), 200);
    expect(thirdView.items.map(item => item.thought?.id)).toEqual([secondId]);
    const thirdControl = await json<SearchTurnControlView>((await submit(session.id, thirdView, "third-turn", "Revisit the original direction.")).response, 201);
    await waitFor(() => runStatus(thirdControl.run.id) === "completed", `third run ${thirdControl.run.id}`);
    const retry = await req(`/search-sessions/${session.id}/discoveries/${removedId}`, { method: "DELETE" });
    expect(retry.status).toBe(204); expect(retry.headers.get("search-session-revision")).toMatch(/^\d+$/);
    const currentDraft = await composer(session.id);
    const current = await json<{ items: { id: string; thought: { id: string } | null }[] }>(await req(`/search-sessions/${session.id}/discoveries?composerId=${currentDraft.composerId}`), 200);
    expect(current.items.map(item => item.thought?.id)).toEqual([secondId, firstId]);
    expect(current.items[1]?.id).not.toBe(removedId);
    expect(read(path, library)).toEqual(initialLibrary);
    console.log("walkthrough: removed one occurrence and rediscovered it without knowledge writes");
    const searchStarts = promptStarts();
    expect(searchStarts).toHaveLength(3);
    searchStarts.forEach((item, index) => starts.push({ turn: index + 1, sessionID: item.sessionID, input: item.text }));
    expect(new Set(starts.map(item => item.sessionID)).size).toBe(3);
    expect(starts[1]?.input).toContain("Explore the topic.");
    expect(starts[1]?.input).toContain("Which direction should I explore?");
    for (const start of starts) expect(client.sessions.get(start.sessionID)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    const rejection = await req(`/thoughts/${firstId}/reject`, { method: "POST", body: {} }); expect(rejection.status).toBe(204);
    const invalidated = await req(`/search-sessions/${session.id}/composer-contexts/${currentDraft.composerId}`);
    expect(invalidated.status).toBe(409);
    const safeDraft = await composer(session.id);
    const safeMessages = await json<SearchComposerView & { items: { text: string | null; availability: string }[] }>(await req(`/search-sessions/${session.id}/messages?composerId=${safeDraft.composerId}`), 200);
    expect(safeMessages.items.some(item => item.availability === "context-unavailable" && item.text === null)).toBe(true);
    expect(JSON.stringify(safeMessages)).not.toContain("REJECTED-SENTINEL");
    const safe = await json<SearchTurnControlView>((await submit(session.id, safeMessages, "safe-turn", "Continue with eligible context.")).response, 201);
    await waitFor(() => runStatus(safe.run.id) === "completed", `safe run ${safe.run.id}`);
    const safePrompt = promptStarts()[3]; if (!safePrompt) throw new Error("missing safe native context");
    expect(safePrompt.text).not.toContain("REJECTED-SENTINEL");
    console.log("walkthrough: rejected source excluded from fresh fake-agent context");
    client.holdOutput = true;
    const otherDraft = await composer(other.id);
    const otherTurn = await json<SearchTurnControlView>((await submit(other.id, otherDraft, "shared-key", "Independent session.")).response, 201);
    expect(otherTurn.run.id).not.toBe(firstControl.run.id);
    await waitFor(() => client.prompts.some(item => client.sessions.get(item.sessionID)?.metadata.runId === otherTurn.run.id), `other run ${otherTurn.run.id}`);
    const beforeDelete = read(path, library);
    const deleted = await req(`/search-sessions/${other.id}`, { method: "DELETE" }); expect(deleted.status).toBe(204);
    expect((await req(`/runs/${otherTurn.run.id}`)).status).toBe(404);
    expect((await req("/search-sessions", { method: "POST", body: {}, key: "session-two" })).status).toBe(409);
    expect((await req(`/search-sessions/${session.id}`)).status).toBe(200);
    const outbox = read(path, db => db.query("SELECT state,prompt_manifest_json FROM search_native_cleanup WHERE run_id=?").get(otherTurn.run.id)) as { state: string; prompt_manifest_json: string } | null;
    expect(outbox?.state).toBe("pending"); expect(JSON.stringify(outbox)).not.toContain("Independent session.");
    expect(read(path, library)).toEqual(beforeDelete);
    expect(client.scriptErrors).toEqual([]);
    console.log("walkthrough: local Delete preserved library and the other session; native cleanup remains pending");
  } finally { holdFinal = false; release(); client.holdOutput = false; await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
});
