import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { AgentSessionMissingError } from "../src/agent/errors";
import type { InboxItem, NativeMessage, NativeSession, PublicClient } from "../src/agent/opencode-adapter";
import type { AgentConfig } from "../src/daemon/agent-config";
import type { SearchClockDependencies } from "../src/domain/search-time";
import type { SearchRequestClock } from "../src/domain/agentic-search";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { createLogger } from "../src/logging";

// Decoded native history only: the real adapter and worker own all persisted work.
export class ScriptedClient implements PublicClient {
  serviceUrl?: string;
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, NativeMessage[]>();
  readonly prompts: Parameters<PublicClient["prompt"]>[0][] = [];
  readonly scriptErrors: unknown[] = [];
  readonly interrupts: string[] = [];
  readonly inboxCancellations: { sessionID: string; inboxID: string }[] = [];
  readonly historyRequests: string[] = [];
  readonly queued: InboxItem[] = [];
  readonly activeSessions = new Set<string>();
  historyPage: ((input: Parameters<PublicClient["history"]>[0]) => Promise<Awaited<ReturnType<PublicClient["history"]>>>) | undefined;
  afterInterrupt: ((sessionID: string) => void) | undefined;
  holdOutput = false;
  dropNextAck = false;
  beforePrompt: (() => Promise<void>) | undefined;
  beforeCreate: (() => Promise<void>) | undefined;
  beforeHistory: (() => Promise<void>) | undefined;
  historyMode: "normal" | "empty" | "outage" = "normal";
  constructor(private readonly script: (index: number, input: string) => object) {}
  async serverInfo() { return { version: "fixture-compatible" }; }
  async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
    await this.beforeCreate?.();
    const session: NativeSession = { id: input.id, location: input.location, model: input.model, permissions: input.permissions, metadata: input.metadata };
    this.sessions.set(input.id, session); this.messages.set(input.id, []); return session;
  }
  async sessionGet(input: { readonly sessionID: string }): Promise<NativeSession> {
    const session = this.sessions.get(input.sessionID);
    if (!session) throw new AgentSessionMissingError("fixture session absent");
    return session;
  }
  async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
    await this.beforePrompt?.();
    const messages = this.messages.get(input.sessionID);
    if (!messages) throw new Error("fixture session absent");
    const index = this.prompts.length; this.prompts.push(input);
    let output: object;
    try { output = this.script(index, input.text); }
    catch (error) { this.scriptErrors.push(error); throw error; }
    messages.push({ id: input.id, type: "user", time: { created: 10 }, text: input.text },
      { id: `assistant-${input.id}`, type: "assistant", time: { created: 11, completed: 12 }, content: [{ type: "text", text: JSON.stringify(output) }], finish: "stop" },
      { id: `idle-${input.id}`, type: "idle", time: { created: 13 }, outcome: "succeeded" });
    if (this.dropNextAck) { this.dropNextAck = false; throw new Error("owned lost acknowledgement"); }
    return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: 10 } };
  }
  async inbox() { return [...this.queued]; }
  async history(input: Parameters<PublicClient["history"]>[0]) {
    await this.beforeHistory?.();
    this.historyRequests.push(input.sessionID);
    if (this.historyPage) return this.historyPage(input);
    if (this.historyMode === "outage") throw new Error("owned history outage");
    if (this.historyMode === "empty") return { data: [], cursor: {} };
    const messages = this.messages.get(input.sessionID) ?? [];
    return { data: this.holdOutput ? messages.filter(message => message.type === "user") : messages, cursor: {} };
  }
  async active() { return Object.fromEntries([...new Set([...this.activeSessions,...(this.holdOutput ? this.prompts.map(prompt => prompt.sessionID) : [])])].map(id => [id, {}])); }
  async cancelInbox(input: Parameters<PublicClient["cancelInbox"]>[0]) { this.inboxCancellations.push(input); const index = this.queued.findIndex(item => item.id === input.inboxID && item.sessionID === input.sessionID); if (index >= 0) this.queued.splice(index,1); }
  async interrupt(input: Parameters<PublicClient["interrupt"]>[0]) { this.interrupts.push(input.sessionID); this.afterInterrupt?.(input.sessionID); return { interrupted: true }; }
}

export const now = () => "2030-01-01T12:00:03.000Z";
export const logger = createLogger("error", () => {});
export const config: AgentConfig = { service: { url: "http://127.0.0.1:44991" }, directory: "/tmp/opencode/owned-agent-fixture",
  model: { providerID: "fixture-provider", id: "fixture-model" }, effort: { quick: "fixture-quick", standard: "fixture-standard", thorough: "fixture-thorough" } };
export const request = (capability: string, args: object) => ({ version: 1, kind: "request", request: { capability, arguments: args } });
export const find = () => request("findThoughts", { query: "cobalt", authors: [], kinds: [], from: null, until: null, sort: "oldest", limit: 25, cursor: null });
export const discovery = (id: string) => request("addDiscovery", { thoughtId: id, why: "A useful recorded thought", evidenceThoughtIds: [] });
export const reply = () => ({ version: 1, kind: "search-reply", reply: "Found the recorded thought.", disposition: "done", sourceThoughtIds: ["target"] });

export function candidateFromSuccessor(input: string): string {
  const envelope: unknown = JSON.parse(input);
  function visit(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    if ("kind" in value && value.kind === "thought" && "id" in value && value.id === "target") return value.id;
    for (const part of Object.values(value)) { const found = visit(part); if (found) return found; }
    return undefined;
  }
  const id = visit(envelope);
  if (!id) throw new Error("successor did not contain the actual eligible target candidate");
  return id;
}
export function knowledge(db: Database): unknown {
  return ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources", "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections", "thought_search_fts", "response_search_fts"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
}
export async function fixture(script: (index: number, input: string) => object,
  action: (db: Database, store: SqliteStore, worker: ConfiguredRunWorker, client: ScriptedClient, id: () => string) => Promise<void>,
  workerNow: () => string = now,
  searchClock?: SearchClockDependencies): Promise<void> {
  const dir = mkdtempSync(join("/tmp/opencode", "search-capabilities-owned-"));
  const db = new Database(join(dir, "owned.sqlite"));
  try {
    migrate(db); let sequence = 0;
    const id = () => `fixture${String(++sequence).padStart(24, "0")}`;
    const store = new SqliteStore(db), client = new ScriptedClient(script);
    const worker = new ConfiguredRunWorker({ db, config, id, now: workerNow, logger, resolve: async () => ({ url: "http://127.0.0.1:44991" }), client: () => client, searchClock });
    try { await action(db, store, worker, client, id); } finally { worker.pause(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
export function setup(db: Database, store: SqliteStore, id: () => string, requestClock: SearchRequestClock = { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, startingThoughtIds: readonly string[] = []) {
  for (const [thoughtId, text] of [["target", "cobalt eligible fixture"], ["hidden", "cobalt REJECTED-SENTINEL"]]) {
    store.saveThought({ id: thoughtId, text, title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  }
  new RejectionService(new SqliteRejectionRepository(db, logger)).rejectThought("user", "hidden");
  const sessions = store.searchSessions({ id, now, logger }), session = sessions.create("user", "session", {}).session;
  const control = store.searchInvestigation().findThoughts({ query: "cobalt", authors: [], kinds: [], from: null, until: null, sort: "oldest", limit: 25, cursor: null });
  expect(control.type).toBe("page");
  if (control.type !== "page") throw new Error("fixture corpus unexpectedly changed");
  expect(control.items.map(item => item.id)).toEqual(["target"]);
  const composer = sessions.openComposer("user", session.id);
  const turn = sessions.admitTurn("user", session.id, "turn", { text: "Find cobalt", startingThoughtIds,
    requestClock, composerId: composer.composerId, contextToken: composer.contextToken });
  return { sessions, session, runId: turn.run.id };
}
export function status(db: Database, runId: string): string {
  const row = db.query("SELECT status FROM runs WHERE id=?").get(runId) as { status: string } | null;
  if (!row) throw new Error("missing run"); return row.status;
}
export async function drive(worker: ConfiguredRunWorker, db: Database, runId: string): Promise<number[]> {
  const reads: number[] = [];
  // Bounded test polling, not a product turn quota.
  for (let i = 0; i < 96 && !["completed", "failed", "interrupted"].includes(status(db, runId)); i++) {
    await worker.tick(runId);
    const row = db.query("SELECT full_read FROM run_context WHERE run_id=? AND kind='thought' AND ref_id='target'").get(runId) as { full_read: number } | null;
    if (row) reads.push(row.full_read);
  }
  return reads;
}
