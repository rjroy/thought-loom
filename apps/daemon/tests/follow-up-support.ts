import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app";
import { OwnedGrants } from "../src/tool-boundary";
import { KnowledgeService } from "../src/knowledge";
import { WeavingWorker, type Observation, type WeavingAdapter, type WeavingRun } from "../src/weaving";
import { NativeWeavingAdapter, createMaintainedClient, type NativeClientPort, type NativeSession, type NativeWeavingOptions } from "../src/native-adapter";
import type { OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { parseDialogueTurnReceipt, parseDialogueView, parseItemView, parseFollowUpStatusView, type FollowUpLimits, type FollowUpStatusView, type ToolAction } from "@thoughtloom/contracts";

// Test-owned policy, not the operator's current setup/default tuning.
export const backgroundActions: ToolAction[] = ["read_source", "read_item", "read_relationship", "search", "record_interpretation", "record_alias", "record_relationship", "revise_interpretation", "revise_relationship"];
const location = "/fixture/follow-up", agent = "fixture_weaver", credential = "test-owned-follow-up-credential";
const model = { providerID: "fixture", id: "fixture" };
type Owned = WeavingRun & { kind: "capture" | "dialogue" | "follow_up"; turnSourceId: string | null };
type Outcome = "pending" | "succeeded" | "failed" | "interrupted";
export type FollowUpFixture = Awaited<ReturnType<typeof followUpFixture>>;

export async function followUpFixture(register: (close: () => Promise<void>) => void) {
  const directory = await mkdtemp("/tmp/opencode/thoughtloom-follow-up-contract-");
  const databasePath = join(directory, "fixture.sqlite"), workers: WeavingWorker[] = [];
  async function close() { try { await Promise.all(workers.map((worker) => worker.close())); } finally { await rm(directory, { recursive: true, force: true }); } }
  register(close);
  const app = createApp({ databasePath, tools: { transportCredential: credential, location } });
  let sequence = 0;
  function read<T>(action: (db: Database) => T): T { const db = new Database(databasePath, { readonly: true }); try { return action(db); } finally { db.close(); } }
  function owned(run: WeavingRun): Owned {
    // The fixture's native port/grant binding uses the worker's persisted
    // association, not a mutable "current turn" or caller-supplied job kind.
    const row = read((db) => db.query<Owned, [string, string, string, string, string]>(`SELECT r.id AS runId,r.job_id AS jobId,j.source_id AS sourceId,
      r.session_id AS sessionId,r.prompt_id AS promptId,j.kind,t.source_id AS turnSourceId FROM weaving_runs r JOIN jobs j ON j.id=r.job_id
      LEFT JOIN dialogue_turns t ON t.job_id=j.id WHERE r.id=? AND r.job_id=? AND j.source_id=? AND r.session_id=? AND r.prompt_id=?`)
      .get(run.runId, run.jobId, run.sourceId, run.sessionId, run.promptId));
    expect(row).not.toBeNull();
    if (!row) throw new Error("Missing persisted fixture run");
    return row;
  }
  const observed = new Map<string, Observation>();
  const seedAdapter: WeavingAdapter = {
    async prepareSession(run) {
      const row = owned(run);
      if (row.kind === "follow_up") throw new Error("The origin fixture must not consume follow-up work");
      const sourceIds = row.kind === "dialogue" ? [row.sourceId, row.turnSourceId] : [row.sourceId];
      if (!sourceIds.every((id): id is string => typeof id === "string")) throw new Error("Missing owned turn source");
      new OwnedGrants(databasePath).bind({ run, location, agent, sourceIds, operations: row.kind === "dialogue" ? [...backgroundActions, "record_idea"] : [...backgroundActions] });
    },
    async admit() { return { kind: "admitted" }; },
    async inspect(run) { return observed.get(run.runId) ?? { kind: "pending" }; },
  };
  const seed = new WeavingWorker({ databasePath, adapter: seedAdapter }); workers.push(seed);
  async function capture(text: string) {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `capture-${++sequence}` }, body: JSON.stringify({ text, provenance: "test-owned fixture" }) });
    expect(response.status).toBe(201); return await response.json() as { id: string; text: string };
  }
  const root = await capture("Controlled original: preserve the meaning of a handoff.");
  // Drain capture through the real worker before any follow-up is queued.
  const captured = await seed.startNext(); expect(captured.kind).toBe("started");
  if (captured.kind !== "started") throw new Error("Capture fixture not admitted");
  observed.set(captured.run.runId, { kind: "completed", recordedChanges: 0 }); await seed.recover();
  const opened = await app.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: root.id } }) });
  expect(opened.status).toBe(201);
  const parsedDialogue = parseDialogueView(await opened.json()); expect(parsedDialogue).not.toBeNull();
  if (!parsedDialogue) throw new Error("Invalid fixture dialogue");
  const dialogue = parsedDialogue;
  async function submit(text: string) {
    const response = await app.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `turn-${++sequence}` }, body: JSON.stringify({ text }) });
    expect(response.status).toBe(201); const receipt = parseDialogueTurnReceipt(await response.json()); expect(receipt).not.toBeNull();
    if (!receipt) throw new Error("Invalid fixture turn receipt"); return receipt;
  }
  async function startTurn(text: string) {
    const turn = await submit(text), started = await seed.startNext(); expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error("Dialogue fixture not admitted");
    expect(started.run.jobId).toBe(turn.jobId); expect(owned(started.run).turnSourceId).toBe(turn.sourceId);
    return { turn, run: started.run };
  }
  async function finishTurn(run: WeavingRun) {
    observed.set(run.runId, { kind: "completed", recordedChanges: 0, assistant: { messageId: `msg_answer_${++sequence}`, text: "Controlled dialogue response." } });
    await seed.recover();
  }
  async function drainCapture() {
    const started = await seed.startNext(); expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error("Additional capture fixture not admitted");
    expect(owned(started.run).kind).toBe("capture"); observed.set(started.run.runId, { kind: "completed", recordedChanges: 0 }); await seed.recover();
  }
  async function tool(run: WeavingRun, action: ToolAction, input: unknown) {
    return app.request(`/internal/tools/${action.replaceAll("_", "-")}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify({ native: { sessionID: run.sessionId, agent, messageID: `msg_tool_${++sequence}`, callID: `call_tool_${sequence}` }, action, input }) });
  }
  async function idea(started: Awaited<ReturnType<typeof startTurn>>, text: string) {
    const response = await tool(started.run, "record_idea", { rootSourceId: root.id, turnSourceId: started.turn.sourceId, dialogueId: dialogue.id, turnId: started.turn.id, text, evidenceSourceIds: [root.id, started.turn.sourceId] });
    expect(response.status).toBe(200); const item = parseItemView({ ...await response.json() as object, historyTruncated: false }); expect(item).not.toBeNull();
    if (!item) throw new Error("Invalid idea fixture receipt"); return item;
  }
  async function origin(text = "Controlled developing idea.") {
    const started = await startTurn(`Controlled retained user question ${++sequence}.`), item = await idea(started, text);
    await finishTurn(started.run); return { ...started, item };
  }
  function jobs() { return read((db) => db.query<{ id: string; status: string }, []>("SELECT id,status FROM jobs WHERE kind='follow_up' ORDER BY rowid").all()); }
  function operation(versionId: string, relationship = false) {
    const row = read((db) => db.query<{ id: string }, [string]>(`SELECT operation_id AS id FROM ${relationship ? "relationship_revisions" : "formulations"} WHERE id=?`).get(versionId));
    if (!row) throw new Error("Missing committed fixture revision"); return row.id;
  }
  async function correct(itemId: string, expectedVersionId: string, text: string, turnSourceId: string, key = `correction-${++sequence}`) {
    return app.request(`/items/${itemId}/correct`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ expectedVersionId, text, sourceId: turnSourceId }) });
  }
  async function native(settings: { maintained?: boolean; uncertain?: boolean; maxAttempts?: number; contextCharacters?: number; titleCapability?: boolean } = {}) {
    const registrationFile = join(directory, `registration-${++sequence}.json`);
    await writeFile(registrationFile, JSON.stringify({ url: "http://127.0.0.1:1234", pid: 42, version: "2.2.2" }), { mode: 0o600 });
    const sessions = new Map<string, NativeSession>(), sdkSessions = new Map<string, Record<string, unknown>>();
    const prompts: WeavingRun[] = [], nativePrompts: Array<{ sessionID: string; id: string; text: string }> = [], creations: Record<string, unknown>[] = [];
    const outcomes = new Map<string, Outcome>();
    const options: NativeWeavingOptions = { databasePath, registrationFile, location, agent, model, operations: [...backgroundActions],
      followUpContextLimits: { targets: 2, origins: 2, characters: settings.contextCharacters ?? 8_000 } };
    // Only the concrete SDK method family already used by production. No HTTP,
    // native process, event emulator or model server is created by these hooks.
    const sdk = {
      server: { async info() { return { version: "2.2.2", pid: 42 }; } },
      plugin: { async list() { return { data: [{ id: "thoughtloom", state: { status: "active" } }] }; } },
      rpc: { async call(input: { input: { nonce: string } }) {
        if (!settings.titleCapability) throw new Error("Capability unavailable");
        return { output: { protocol: 1, nonce: input.input.nonce, buildId: "fixture-reviewed-build", setupId: "fixture-setup", nativePid: 42, directory: location, actions: ["read_source", "record_title_v1"] } };
      } },
      session: {
        async create(input: Record<string, unknown>) {
          if (typeof input.id !== "string") throw new Error("Missing SDK session ID");
          const id = input.id;
          const row = read((db) => db.query<{ kind: string; command: string }, [string]>("SELECT j.kind,c.payload AS command FROM weaving_runs r JOIN jobs j ON j.id=r.job_id JOIN native_commands c ON c.run_id=r.id WHERE r.session_id=?").get(id));
          expect(row?.kind).toBe("follow_up"); expect(typeof row?.command).toBe("string");
          creations.push(structuredClone(input)); sdkSessions.set(id, input); return input;
        },
        async get(input: { sessionID: string }) { const value = sdkSessions.get(input.sessionID); if (!value) throw new Error("Unknown SDK fixture session"); return value; },
        async prompt(input: { sessionID: string; id: string; text: string }) { nativePrompts.push(structuredClone(input)); return { id: input.id, sessionID: input.sessionID, payload: { text: input.text } }; },
      },
    } as unknown as OpenCodeClient;
    const maintained = settings.maintained ? createMaintainedClient(options, { async discover() { return { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "fixture", password: "test-owned" } }; }, headers: Service.headers, make() { return sdk; }, ...(settings.titleCapability ? { expectedCapabilityBuildId: "fixture-reviewed-build" } : {}) }) : undefined;
    const client: NativeClientPort = {
      discover: (file, version) => maintained ? maintained.discover(file, version) : Promise.resolve({ url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }),
      identity: () => maintained ? maintained.identity() : Promise.resolve({ version: "2.2.2", pid: 42 }),
      async createSession(run) {
        const row = owned(run); expect(row.kind).toBe("follow_up");
        if (maintained) return maintained.createSession(run);
        const value: NativeSession = { id: row.sessionId, ownerRunId: row.runId, ownerJobId: row.jobId, ownerSourceId: row.sourceId, ownerPromptId: row.promptId,
          location, agent, model: { ...model, variant: "default" }, permissionActions: ["deny:*:*", ...backgroundActions.map((action) => `allow:${action}`)] };
        sessions.set(value.id, value); return value;
      },
      async getSession(id) { if (maintained) return maintained.getSession(id); const value = sessions.get(id); if (!value) throw new Error("Unknown owned fixture session"); return value; },
      async prompt(run, claim) { owned(run); prompts.push(run); if (settings.uncertain) throw new Error("Controlled admission response loss"); return maintained ? maintained.prompt(run, claim) : { promptId: run.promptId }; },
      async activity(id) { const outcome = outcomes.get(id) ?? "pending"; return { active: outcome === "pending", outcome: outcome === "pending" ? null : outcome }; },
      async history(id) {
        const run = prompts.find((entry) => entry.sessionId === id); if (!run) throw new Error("Unknown fixture prompt");
        const outcome = outcomes.get(id) ?? "pending";
        return { messages: [{ id: run.promptId, type: "user", state: "completed" }, { id: `msg_result_${id}`, type: "assistant", state: outcome === "succeeded" ? "completed" : outcome, text: "" }] };
      },
      async close() { await maintained?.close?.(); },
    };
    const makeWorker = () => { const worker = new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter({ ...options, client }), maxAttempts: settings.maxAttempts ?? 3 }); workers.push(worker); return worker; };
    const worker = makeWorker();
    return { worker, makeWorker, prompts, nativePrompts, creations, setOutcome(run: WeavingRun, value: Outcome) { outcomes.set(run.sessionId, value); } };
  }
  function http(worker?: WeavingWorker, limits?: Partial<FollowUpLimits>) { return createApp({ databasePath, ...(worker ? { weavingWorker: worker, weavingConfigured: true, weavingStatus: () => "waiting" as const } : {}), ...(limits ? { followUpLimits: limits } : {}) }); }
  async function status(worker?: WeavingWorker, limits?: Partial<FollowUpLimits>): Promise<FollowUpStatusView> {
    const response = await http(worker, limits).request(`/sources/${root.id}/follow-ups`); expect(response.status).toBe(200);
    const value = parseFollowUpStatusView(await response.json()); expect(value).not.toBeNull();
    if (!value) throw new Error("Invalid follow-up HTTP output"); return value;
  }
  return { directory, databasePath, root, dialogue, app, read, owned, capture, drainCapture, submit, startTurn, finishTurn, tool, idea, origin, jobs, operation, correct, native, http, status,
    knowledge: new KnowledgeService(databasePath), close };
}
