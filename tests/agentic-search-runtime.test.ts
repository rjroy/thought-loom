import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { RunSupervisor } from "../src/agent/supervisor";
import { AgentSessionMissingError } from "../src/agent/errors";
import type { InboxItem, NativeMessage, NativeSession, PublicClient } from "../src/agent/opencode-adapter";
import type { AgentConfig } from "../src/daemon/agent-config";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { createLogger } from "../src/logging";

// Decoded PublicClient fixture mirrors the native history correlation contract;
// it does not start or contact a service and never directly completes SQL work.
class OwnedClient implements PublicClient {
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, NativeMessage[]>();
  readonly prompts: Parameters<PublicClient["prompt"]>[0][] = [];
  constructor(private readonly output: (index: number) => object) {}
  async serverInfo() { return { version: "fixture-compatible" }; }
  async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
    const session: NativeSession = { id: input.id, location: input.location, model: input.model, permissions: input.permissions, metadata: input.metadata };
    this.sessions.set(input.id, session); this.messages.set(input.id, []); return session;
  }
  async sessionGet(input: { readonly sessionID: string }): Promise<NativeSession> {
    const session = this.sessions.get(input.sessionID);
    if (!session) throw new AgentSessionMissingError("fixture session absent");
    return session;
  }
  async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
    const messages = this.messages.get(input.sessionID);
    if (!messages) throw new Error("fixture session missing");
    const index = this.prompts.length;
    this.prompts.push(input);
    messages.push({ id: input.id, type: "user", time: { created: 10 }, text: input.text },
      { id: `assistant-${input.id}`, type: "assistant", time: { created: 11, completed: 12 }, content: [{ type: "text", text: JSON.stringify(this.output(index)) }], finish: "stop" },
      { id: `idle-${input.id}`, type: "idle", time: { created: 13 }, outcome: "succeeded" });
    return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: 10 } };
  }
  async inbox() { return []; }
  async history(input: Parameters<PublicClient["history"]>[0]) { return { data: this.messages.get(input.sessionID) ?? [], cursor: {} }; }
  async active() { return {}; }
  async cancelInbox() {}
  async interrupt() { return { interrupted: true }; }
}

const config: AgentConfig = { service: { url: "http://127.0.0.1:44991" }, directory: "/tmp/opencode/owned-agent-fixture",
  model: { providerID: "fixture-provider", id: "fixture-model" }, effort: { quick: "fixture-quick", standard: "fixture-standard", thorough: "fixture-thorough" } };
const now = () => "2030-01-01T12:00:03.000Z";
const logger = createLogger("error", () => {});

async function fixture(action: (db: Database, store: SqliteStore, worker: ConfiguredRunWorker, client: OwnedClient, id: () => string) => Promise<void>, output: (index: number) => object): Promise<void> {
  const dir = mkdtempSync(join("/tmp/opencode", "search-runtime-owned-"));
  const db = new Database(join(dir, "owned.sqlite"));
  try {
    migrate(db);
    let sequence = 0;
    const id = () => `fixture${String(++sequence).padStart(24, "0")}`;
    const store = new SqliteStore(db);
    const client = new OwnedClient(output);
    const worker = new ConfiguredRunWorker({ db, config, id, now, logger,
      resolve: async () => ({ url: "http://127.0.0.1:44991" }), client: () => client });
    try { await action(db, store, worker, client, id); }
    finally { worker.pause(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function status(db: Database, runId: string): string {
  const row = db.query("SELECT status FROM runs WHERE id=?").get(runId) as { status: string } | null;
  if (!row) throw new Error("missing owned run");
  return row.status;
}
async function drive(worker: ConfiguredRunWorker, db: Database, runId: string): Promise<void> {
  // Bounded test polling, not a product or worker turn quota.
  for (let i = 0; i < 24 && !["completed", "failed", "interrupted"].includes(status(db, runId)); i++) await worker.tick(runId);
}
function knowledge(db: Database): unknown {
  return ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources", "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections", "thought_search_fts", "response_search_fts"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
}

test("owned decoded facade drives a new Weaver with unattended native permissions", async () => fixture(async (db, store, worker, client, id) => {
  store.saveThought({ id: "subject", text: "fixture thought", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const run = new SqliteRunOperations(db, { id, now, logger }).admitWeave("user", { subjectId: "subject", triggerId: "fixture-trigger" });
  await drive(worker, db, run.id);
  expect(status(db, run.id)).toBe("completed");
  expect(client.prompts).toHaveLength(1);
  expect([...client.sessions.values()][0]?.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
}, () => ({ version: 1, kind: "complete", reply: "fixture complete" })));

test("search clarification and follow-up use fresh owned native contexts and never write library knowledge", async () => fixture(async (db, store, worker, client, id) => {
  for (const [thoughtId, text] of [["safe", "safe source fixture"], ["hidden", "REJECTED-NATIVE-SENTINEL"]]) {
    store.saveThought({ id: thoughtId, text, title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  }
  new RejectionService(new SqliteRejectionRepository(db, logger)).rejectThought("user", "hidden");
  const before = knowledge(db);
  const sessions = store.searchSessions({ id, now, logger });
  const session = sessions.create("user", "search-session", {}).session;
  const draft = sessions.openComposer("user", session.id);
  const firstInput = { text: "FIRST-SEARCH-QUESTION", startingThoughtIds: ["safe"],
    requestClock: { at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" }, composerId: draft.composerId, contextToken: draft.contextToken };
  const first = sessions.admitTurn("user", session.id, "first-turn", firstInput);
  expect(sessions.admitTurn("user", session.id, "first-turn", firstInput)).toEqual(first);
  expect(client.prompts).toHaveLength(0);
  expect(status(db, first.run.id)).toBe("queued");
  await drive(worker, db, first.run.id);
  expect(client.prompts).toHaveLength(1);
  expect(status(db, first.run.id)).toBe("completed");
  expect(db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(first.run.id)).toEqual({ open_slot: 0 });
  expect(db.query("SELECT text,disposition FROM search_messages WHERE run_id=? AND role='assistant'").get(first.run.id)).toEqual({ text: "CLARIFICATION-REPLY", disposition: "awaiting-user" });
  const firstPrompt = client.prompts[0];
  if (!firstPrompt) throw new Error("expected first owned prompt");
  expect(firstPrompt.text).toContain("2030-01-01T04:00:00-08:00");
  expect(firstPrompt.text).toContain("2030-01-01T12:00:03.000Z");
  expect(firstPrompt.text).not.toContain("REJECTED-NATIVE-SENTINEL");
  const nextDraft = sessions.openComposer("user", session.id);
  const second = sessions.admitTurn("user", session.id, "second-turn", { text: "SECOND-SEARCH-ANSWER", startingThoughtIds: [],
    requestClock: firstInput.requestClock, composerId: nextDraft.composerId, contextToken: nextDraft.contextToken });
  expect(second.run.id).not.toBe(first.run.id);
  await drive(worker, db, second.run.id);
  expect(client.prompts).toHaveLength(2);
  expect(status(db, second.run.id)).toBe("completed");
  expect(db.query("SELECT text,disposition FROM search_messages WHERE run_id=? AND role='assistant'").get(second.run.id)).toEqual({ text: "NO-FINDINGS-REPLY", disposition: "done" });
  const secondPrompt = client.prompts[1];
  if (!secondPrompt) throw new Error("expected second owned prompt");
  expect(secondPrompt.sessionID).not.toBe(firstPrompt.sessionID);
  expect(secondPrompt.id).not.toBe(firstPrompt.id);
  expect(secondPrompt.text).toContain("FIRST-SEARCH-QUESTION");
  expect(secondPrompt.text).toContain("CLARIFICATION-REPLY");
  expect(secondPrompt.text).toContain("SECOND-SEARCH-ANSWER");
  expect(secondPrompt.text).not.toContain("REJECTED-NATIVE-SENTINEL");
  expect(client.sessions.get(firstPrompt.sessionID)?.metadata.runId).toBe(first.run.id);
  expect(client.sessions.get(secondPrompt.sessionID)?.metadata.runId).toBe(second.run.id);
  expect(client.messages.get(secondPrompt.sessionID)?.map(message => message.type)).toEqual(["user", "assistant", "idle"]);
  expect([...client.sessions.values()].map(item => item.permissions)).toEqual([
    [{ action: "*", resource: "*", effect: "deny" }], [{ action: "*", resource: "*", effect: "deny" }],
  ]);
  expect(knowledge(db)).toEqual(before);
  expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='weave'").get()).toEqual({ n: 0 });
  await worker.tick(first.run.id); await worker.tick(second.run.id);
  expect(client.prompts).toHaveLength(2);
}, index => ({ version: 1, kind: "search-reply", reply: index === 0 ? "CLARIFICATION-REPLY" : "NO-FINDINGS-REPLY", disposition: index === 0 ? "awaiting-user" : "done", sourceThoughtIds: [] })));

test("existing supervisor includes queued search runs in its bounded scan", async () => fixture(async (db, store, worker, _client, id) => {
  const sessions = store.searchSessions({ id, now, logger }), session = sessions.create("user", "session", {}).session;
  const composer = sessions.openComposer("user", session.id);
  const turn = sessions.admitTurn("user", session.id, "turn", { text: "find it", startingThoughtIds: [], requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
  const seen: string[] = [];
  const supervisor = new RunSupervisor({ db, logger, startTimer: () => () => {}, worker: { tick: async runId => { seen.push(runId); await worker.tick(runId); }, pause: () => worker.pause() } });
  try { await supervisor.poll(); expect(seen).toContain(turn.run.id); }
  finally { await supervisor.stop(); }
}, () => ({ version: 1, kind: "search-reply", reply: "none", disposition: "done", sourceThoughtIds: [] })));
