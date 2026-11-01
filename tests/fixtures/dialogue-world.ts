import { dirname, join } from "node:path";
import { createApp } from "../../apps/daemon/src/app";
import { DialogueService } from "../../apps/daemon/src/dialogue";
import { KnowledgeService } from "../../apps/daemon/src/knowledge";
import { NativeWeavingAdapter, type NativeClientPort, type NativeSession } from "../../apps/daemon/src/native-adapter";
import { runScope } from "../../apps/daemon/src/run-scope";
import { openDatabase, saveCapture } from "../../apps/daemon/src/storage";
import { createToolApp } from "../../apps/daemon/src/tool-boundary";
import { WeavingWorker, type WeavingRun } from "../../apps/daemon/src/weaving";
import { ABANDONMENT_ACKNOWLEDGEMENT, WeavingAbandonmentService } from "../../apps/daemon/src/weaving-abandonment";
import type { FollowUpLimits, Source, ToolAction } from "../../packages/contracts/src";
import { dialogueExample as example, type BrowserDialogueScenario } from "./dialogue-content";
import { followUpExample } from "./follow-up-content";

type Outcome = "pending" | "succeeded" | "failed" | "interrupted";
type ScriptedAnswer = { outcome: Outcome; text: string };
const backgroundActions: ToolAction[] = ["read_source", "read_item", "read_relationship", "search", "record_interpretation", "record_alias", "record_relationship", "revise_interpretation", "revise_relationship"];
type FollowUpFixtureOptions = { followUp?: boolean; followUpLimits?: Partial<FollowUpLimits>; previewLimit?: number };

// Harness-only composition. The real native adapter uses a scripted port, never
// Service.discover/OpenCode.make, a personal registration or a model endpoint.
export async function createDialogueWorld(databasePath: string, scenario: BrowserDialogueScenario, empty = false, options: FollowUpFixtureOptions = {}) {
  const capture = (key: string, text: string): Source => {
    const result = saveCapture(databasePath, `dialogue-example-${key}`, { text, provenance: example.provenance });
    if (result.kind !== "created") throw new Error("Dialogue fixture requires a fresh database");
    return result.source;
  };
  const root = capture("root", example.original), counterpart = capture("counterpart", example.counterpart);
  const knowledge = new KnowledgeService(databasePath);
  const initial = empty ? null : knowledge.createItem({ actor: "ai", operationId: "example-first-reading", runId: "example-seed-only" }, {
    kind: "interpretation", sourceId: root.id, text: example.initialReading, evidenceSourceIds: [root.id],
  });
  const item = initial ? knowledge.reviseItem({ actor: "ai", operationId: "example-current-reading", runId: "example-seed-only" }, {
    itemId: initial.id, expectedVersionId: initial.current.id, text: example.reading, evidenceSourceIds: [root.id],
  }) : null;
  const alternate = empty ? null : knowledge.createItem({ actor: "ai", operationId: "example-alternate", runId: "example-seed-only" }, {
    kind: "interpretation", sourceId: root.id, text: example.alternate, evidenceSourceIds: [root.id],
  });
  const neighbor = empty ? null : knowledge.createItem({ actor: "ai", operationId: "example-neighbor", runId: "example-seed-only" }, {
    kind: "interpretation", sourceId: counterpart.id, text: example.neighbor, evidenceSourceIds: [counterpart.id],
  });
  const relationship = item && neighbor ? knowledge.createRelationship({ actor: "ai", operationId: "example-connection", runId: "example-seed-only" }, {
    fromItemId: item.id, toItemId: neighbor.id, type: "suggests", rationale: example.rationale, evidenceSourceIds: [root.id, counterpart.id],
  }) : null;

  // Settle only the explicit seed captures, through the existing worker. Later
  // browser turns have separate dialogue jobs and cannot reuse these runs.
  const seedWorker = new WeavingWorker({ databasePath, adapter: {
    async prepareSession() {}, async admit() { return { kind: "admitted" }; },
    async inspect() { return { kind: "completed", recordedChanges: 0 }; },
  } });
  for (let i = 0; i < 2; i++) {
    if ((await seedWorker.startNext()).kind !== "started") throw new Error("Missing seed capture job");
    await seedWorker.recover();
  }
  await seedWorker.close();

  const location = join(dirname(databasePath), "example-dialogue-location"), agent = "browser-example-dialogue";
  const transportCredential = "browser-dialogue-fixture-only-not-a-real-secret";
  const tools = createToolApp({ databasePath, location, transportCredential });
  const sessions = new Map<string, NativeSession>(), answers = new Map<string, ScriptedAnswer>();
  const textListeners = new Map<string, Parameters<NonNullable<NativeClientPort["subscribeText"]>>[1]>();
  const prompts: WeavingRun[] = [], stopCalls: string[] = [], written = new Set<string>();
  let now = 1_000, revision = 0;
  const operations: ToolAction[] = options.followUp ? [...backgroundActions, "record_idea"] : ["read_source", "read_item", "record_idea"];
  const captureOperations: ToolAction[] = options.followUp ? [...backgroundActions] : ["read_source"];
  let availability: "available" | "unconfigured" | "unavailable" = "available", uncertainFollowUp = false;
  let recentReading: ReturnType<KnowledgeService["createItem"]> | null = null;
  const scopeFor = (run: WeavingRun) => {
    const db = openDatabase(databasePath);
    try { const scope = runScope(db, run); if (!scope) throw new Error("Missing owned fixture scope"); return scope; }
    finally { db.close(); }
  };
  const client: NativeClientPort = {
    async discover() { return { url: "http://127.0.0.1:1234", version: "2.2.2", pid: 42 }; },
    async identity() { return { version: "2.2.2", pid: 42 }; },
    async createSession(run) {
      const scope = scopeFor(run);
      const session: NativeSession = { id: run.sessionId, ownerRunId: run.runId, ownerJobId: run.jobId, ownerSourceId: run.sourceId, ownerPromptId: run.promptId,
        location, agent, model: { providerID: "example", id: "scripted", variant: "default" },
          permissionActions: ["deny:*:*", ...(scope.kind === "dialogue" ? operations : captureOperations).map((action) => `allow:${action}`)],
          ...(scope.kind === "dialogue" ? { ownerDialogueId: scope.dialogueId, ownerTurnId: scope.turnId, ownerTurnSourceId: scope.turnSourceId } : {}),
          ...(scope.kind === "follow_up" ? { ownerInputHash: scope.inputHash } : {}) };
      sessions.set(run.sessionId, session); return session;
    },
    async getSession(id) { const session = sessions.get(id); if (!session) throw new Error("Unknown scripted session"); return session; },
    async subscribeText(sessionId, onEvent) { textListeners.set(sessionId, onEvent); return { async close() { textListeners.delete(sessionId); } }; },
    async prompt(run) {
      prompts.push(run); answers.set(run.sessionId, { outcome: "pending", text: "" });
      if (scenario === "uncertain" || (uncertainFollowUp && scopeFor(run).kind === "follow_up")) throw new Error("Example uncertain prompt acknowledgement");
      return { promptId: run.promptId };
    },
    async cancelUndelivered(sessionId, promptId) { stopCalls.push(`cancel:${sessionId}:${promptId}`); },
    async interrupt(sessionId, options) { stopCalls.push(`interrupt:${sessionId}:${String(options.resume)}`); },
    async activity(sessionId) {
      const answer = answers.get(sessionId); if (!answer) throw new Error("Unknown scripted answer");
      return { active: answer.outcome === "pending", outcome: answer.outcome === "pending" ? null : answer.outcome };
    },
    async history(sessionId) {
      const run = prompts.find((entry) => entry.sessionId === sessionId), answer = answers.get(sessionId);
      if (!run || !answer) throw new Error("Unknown scripted history");
      return { messages: [{ id: run.promptId, type: "user", state: "completed" },
        { id: `msg_example_${run.runId}`, parentId: run.promptId, type: "assistant", agent, model: { providerID: "example", id: "scripted" },
          state: answer.outcome === "succeeded" ? "completed" : answer.outcome, text: answer.text, textParts: answer.outcome === "pending" ? [] : [answer.text] }] };
    },
  };
  const makeWorker = () => new WeavingWorker({ databasePath, now: () => now, leaseMs: 100,
    adapter: new NativeWeavingAdapter({ client, databasePath, registrationFile: join(dirname(databasePath), "example-registration-unused.json"),
      location, agent, model: { providerID: "example", id: "scripted" }, operations: captureOperations, dialogueOperations: [...operations],
      ...(options.previewLimit ? { previewLimits: { maxCharacters: options.previewLimit, maxFragments: 8, maxEventIds: 32, ttlMs: 60_000 } } : {}) }) });
  let worker = makeWorker();
  const makeApp = () => createApp({ databasePath, weavingWorker: worker, weavingConfigured: availability !== "unconfigured", weavingStatus: () => availability === "available" ? "waiting" : "unavailable",
    ...(options.followUpLimits ? { followUpLimits: options.followUpLimits } : {}) });
  let app = makeApp();

  async function tool(run: WeavingRun, action: string, callID: string, input: object) {
    const response = await tools.request(`/internal/tools/${action}`, { method: "POST", headers: { authorization: `Bearer ${transportCredential}`, "content-type": "application/json" },
      body: JSON.stringify({ native: { sessionID: run.sessionId, agent, messageID: `msg_example_${run.runId}`, callID }, input }) });
    if (response.status !== 200) throw new Error(`Scripted domain tool ${action} failed (${response.status})`);
    return response;
  }

  async function writeIdea() {
    const run = prompts.at(-1); if (!run) throw new Error("No admitted example turn");
    if (written.has(run.runId)) return;
    const scope = scopeFor(run); if (scope.kind !== "dialogue") throw new Error("Expected dialogue scope");
    const dialogue = new DialogueService(databasePath).get(scope.dialogueId); if (!dialogue) throw new Error("Missing dialogue");
    const send = (action: string, callID: string, input: object) => tool(run, action, callID, input);
    await send("read-source", "call_example_root", { sourceId: scope.rootSourceId });
    await send("read-source", "call_example_turn", { sourceId: scope.turnSourceId });
    if (dialogue.selection.kind === "item") await send("read-item", "call_example_reading", { itemId: dialogue.selection.id });
    await send("record-idea", "call_example_develop", { rootSourceId: scope.rootSourceId, turnSourceId: scope.turnSourceId, dialogueId: scope.dialogueId, turnId: scope.turnId,
      text: example.idea, evidenceSourceIds: [scope.rootSourceId, scope.turnSourceId],
      ...(dialogue.selection.kind === "item" ? { derivedFrom: { itemId: dialogue.selection.id, versionId: dialogue.selection.versionId } } : {}) });
    written.add(run.runId);
  }

  function metrics() {
    const db = openDatabase(databasePath);
    try {
      const count = (table: "sources" | "jobs" | "dialogues" | "dialogue_turns") => db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
      return { sources: count("sources"), jobs: count("jobs"), dialogues: count("dialogues"), turns: count("dialogue_turns"),
        admissions: prompts.map((run) => ({ ...run })), stopCalls: [...stopCalls],
        activeGrants: db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owned_grants WHERE revoked=0").get()?.count ?? 0 };
    } finally { db.close(); }
  }

  return {
    metadata: { root, counterpart, item, alternate, neighbor, relationship, exampleOnly: true },
    fetch: (request: Request) => app.fetch(request), metrics,
    async start() { now += 101; await worker.recover(); return worker.startNext(); },
    captureForAbandonment() { return capture("abandon", "Example original retained after local abandonment."); },
    seedRecentReading(outsideWindow: boolean, userAuthored: boolean, longText: boolean) {
      const originalNow = Date.now;
      try {
        Date.now = () => Date.parse("2035-01-01T00:00:00.000Z");
        if (outsideWindow) for (let n = 0; n < 65; n++) knowledge.createItem({ actor: "ai", operationId: `springboard-filler-${n}`, runId: "fixture-seed" },
          { kind: "interpretation", sourceId: root.id, text: `Fixture earlier reading ${n}`, evidenceSourceIds: [root.id] });
        Date.now = () => Date.parse("2040-01-01T00:00:00.000Z");
        recentReading = knowledge.createItem({ actor: "ai", operationId: "springboard-reading", runId: "fixture-seed" },
          { kind: "interpretation", sourceId: root.id, text: longText ? `Fixture long interpretation ${"careful handoff ".repeat(40)}` : "Fixture sampled interpretation about changing handoffs.", evidenceSourceIds: [root.id] });
        if (userAuthored) recentReading = knowledge.reviseItem({ actor: "user", operationId: "springboard-user-revision" },
          { itemId: recentReading.id, expectedVersionId: recentReading.current.id, text: "My saved corrected interpretation of the handoff.", evidenceSourceIds: [root.id] });
        return recentReading;
      } finally { Date.now = originalNow; }
    },
    reviseRecentReading() {
      if (!recentReading) throw new Error("No sampled fixture reading");
      recentReading = knowledge.reviseItem({ actor: "user", operationId: "springboard-later-revision" },
        { itemId: recentReading.id, expectedVersionId: recentReading.current.id, text: "Fixture later formulation must not replace the sampled version.", evidenceSourceIds: [root.id] });
      return recentReading;
    },
    seedLegacyRandom() {
      const db = openDatabase(databasePath);
      try {
        for (const [id, version, text] of [["legacy-random-ai", "legacy-random-ai-v1", "Fixture legacy random AI reading"], ["legacy-random-user", "legacy-random-user-v1", "Fixture legacy reading before user correction"]]) {
          db.run("INSERT INTO knowledge_items(id,kind,source_id) VALUES (?,'interpretation',?)", [id, root.id]);
          db.run("INSERT INTO formulations(id,item_id,text,author,operation_id) VALUES (?,?,?,'ai',?)", [version, id, text, `${id}-operation`]);
          db.run("INSERT INTO formulation_evidence(formulation_id,source_id,position) VALUES (?,?,0)", [version, root.id]);
        }
      } finally { db.close(); }
      const user = knowledge.reviseItem({ actor: "user", operationId: "legacy-random-user-correction" }, { itemId: "legacy-random-user", expectedVersionId: "legacy-random-user-v1", text: "Fixture legacy random user correction", evidenceSourceIds: [root.id] });
      return { ai: knowledge.getItem("legacy-random-ai"), user };
    },
    reviseLegacyRandom() {
      const previous = knowledge.getItem("legacy-random-ai");
      return knowledge.reviseItem({ actor: "user", operationId: "legacy-random-later-revision" }, { itemId: previous.id, expectedVersionId: previous.current.id,
        text: "Later legacy revision must not replace sampled formulation.", evidenceSourceIds: [root.id] });
    },
    abandon() {
      const run = prompts.at(-1); if (!run) throw new Error("No scripted run to abandon");
      return new WeavingAbandonmentService({ databasePath, now: () => now }).abandon({ expectedJobId: run.jobId, expectedRunId: run.runId,
        expectedSessionId: run.sessionId, expectedPromptId: run.promptId, expectedStatus: "uncertain", acknowledgement: ABANDONMENT_ACKNOWLEDGEMENT }, `browser-abandon-${run.runId}`);
    },
    async advance(outcome: Outcome, text: string, idea: boolean) {
      const run = prompts.at(-1); if (!run) throw new Error("No scripted run to advance");
      if (idea) await writeIdea();
      answers.set(run.sessionId, { outcome, text }); now += 101; await worker.recover();
    },
    writeIdea,
    async preview(text: string, start: boolean) {
      const run = prompts.at(-1); if (!run || scopeFor(run).kind !== "dialogue") throw new Error("No admitted dialogue run");
      const emit = textListeners.get(run.sessionId); if (!emit) throw new Error("Preview subscription unavailable");
      const common = { sessionID: run.sessionId, assistantMessageID: `msg_example_${run.runId}`, ordinal: 0 };
      if (start) emit({ ...common, id: `evt_start_${crypto.randomUUID()}`, type: "session.text.started" });
      emit({ ...common, id: `evt_delta_${crypto.randomUUID()}`, type: "session.text.delta", delta: text });
      now += 101; await worker.recover();
    },
    async writeFollowUp(multiple = false) {
      const run = prompts.at(-1); if (!run || scopeFor(run).kind !== "follow_up") throw new Error("No admitted follow-up run");
      await tool(run, "read-source", "call_follow_up_root", { sourceId: root.id });
      await tool(run, "record-interpretation", "call_follow_up_interpretation", { sourceId: root.id, text: followUpExample.interpretation, evidenceSourceIds: [root.id] });
      if (multiple) await tool(run, "record-interpretation", "call_follow_up_second", { sourceId: root.id, text: followUpExample.secondInterpretation, evidenceSourceIds: [root.id] });
    },
    async writeNeighborFollowUp() {
      const run = prompts.at(-1);
      if (!run || scopeFor(run).kind !== "follow_up" || run.sourceId !== counterpart.id || !item || !neighbor || !relationship) throw new Error("Expected counterpart-owned follow-up");
      const currentItem = knowledge.getItem(neighbor.id), currentRelationship = knowledge.getRelationship(relationship.id);
      await tool(run, "read-source", "call_neighbor_root", { sourceId: counterpart.id });
      await tool(run, "read-source", "call_neighbor_other_source", { sourceId: root.id });
      await tool(run, "read-item", "call_neighbor_other_item", { itemId: item.id });
      await tool(run, "read-item", "call_neighbor_item", { itemId: neighbor.id });
      await tool(run, "read-relationship", "call_neighbor_relationship", { relationshipId: relationship.id });
      await tool(run, "revise-interpretation", "call_neighbor_revise", { itemId: neighbor.id, expectedVersionId: currentItem.current.id,
        text: "Example neighbor follow-up: Explicit handoff contracts preserve context.", evidenceSourceIds: [counterpart.id] });
      await tool(run, "read-item", "call_neighbor_item_current", { itemId: neighbor.id });
      await tool(run, "revise-relationship", "call_neighbor_relationship_revise", { relationshipId: relationship.id, expectedVersionId: currentRelationship.current.id,
        status: "active", rationale: "Example neighbor follow-up: A shared handoff contract needs a concrete fidelity check.", evidenceSourceIds: [root.id, counterpart.id] });
    },
    async writeAlias() {
      const run = prompts.at(-1); if (!run || scopeFor(run).kind !== "dialogue") throw new Error("No admitted dialogue run");
      await tool(run, "record-alias", "call_example_alias", { alias: followUpExample.alias, expansion: followUpExample.expansion, evidenceSourceIds: [root.id] });
    },
    configureFollowUp(input: { availability?: "available" | "unconfigured" | "unavailable"; uncertain?: boolean }) {
      if (!options.followUp) throw new Error("Follow-up controls require the explicit fixture mode");
      if (input.availability !== undefined) availability = input.availability;
      if (input.uncertain !== undefined) uncertainFollowUp = input.uncertain;
      app = makeApp();
    },
    revise(target: "item" | "relationship" | "both") {
      revision++;
      if ((target === "item" || target === "both") && item) {
        const current = knowledge.getItem(item.id);
        knowledge.reviseItem({ actor: "user", operationId: `example-external-item-${revision}` }, { itemId: item.id, expectedVersionId: current.current.id, text: example.changedReading, evidenceSourceIds: [root.id] });
      }
      if ((target === "relationship" || target === "both") && relationship) {
        const current = knowledge.getRelationship(relationship.id);
        knowledge.reviseRelationship({ actor: "user", operationId: `example-external-link-${revision}` }, { relationshipId: relationship.id, expectedVersionId: current.current.id,
          status: "active", rationale: example.changedRationale, evidenceSourceIds: [root.id, counterpart.id] });
      }
    },
    blockRoot() {
      const service = new DialogueService(databasePath), dialogue = service.create(root.id, { selection: { kind: "source", id: root.id } }, "example-external-context");
      return service.submit(dialogue.id, "example-external-turn", { text: example.blocked }).receipt;
    },
    async recreate() { await worker.close(); worker = makeWorker(); app = makeApp(); now += 101; await worker.recover(); },
    async close() { await worker.close(); },
  };
}

export type BrowserDialogueWorld = Awaited<ReturnType<typeof createDialogueWorld>>;
export type BrowserDialogueMetadata = BrowserDialogueWorld["metadata"];

// Controls are imported only by serve.ts. Production routes have no dependency
// on this fixture, and no test command alters the normal user's database.
export function createBrowserDialogueControls(directory: string) {
  let active: BrowserDialogueWorld | null = null;
  let emptyApp: ReturnType<typeof createApp> | null = null;
  return {
    async close() { await active?.close(); active = null; emptyApp = null; },
    async fetch(request: Request): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/__browser/dialogue")) return active ? active.fetch(request) : emptyApp ? emptyApp.fetch(request) : null;
      if (path === "/__browser/dialogue/reset" && request.method === "POST") { await active?.close(); active = null; emptyApp = null; return Response.json({ reset: true }); }
      if (path === "/__browser/dialogue/empty-collection" && request.method === "POST") {
        await active?.close(); active = null; emptyApp = createApp({ databasePath: join(directory, `empty-${crypto.randomUUID()}.sqlite`) });
        return Response.json({ empty: true });
      }
      if (path === "/__browser/dialogue/world" && request.method === "POST") {
        const input = await request.json() as { scenario?: BrowserDialogueScenario; empty?: boolean; followUp?: boolean; limitedFollowUp?: boolean; previewLimit?: number };
        if (input.scenario !== undefined && input.scenario !== "available" && input.scenario !== "uncertain") return Response.json({ error: "Invalid example scenario" }, { status: 400 });
        await active?.close(); emptyApp = null; active = await createDialogueWorld(join(directory, `dialogue-${crypto.randomUUID()}.sqlite`), input.scenario ?? "available", input.empty === true,
          { followUp: input.followUp === true, ...(input.limitedFollowUp === true ? { followUpLimits: { jobs: 1, origins: 1, targets: 1, changes: 1 } } : {}), ...(input.previewLimit ? { previewLimit: input.previewLimit } : {}) });
        return Response.json(active.metadata);
      }
      if (!active) return Response.json({ error: "No example dialogue world" }, { status: 409 });
      if (path === "/__browser/dialogue/metrics" && request.method === "GET") return Response.json(active.metrics());
      if (request.method !== "POST") return Response.json({ error: "Unknown example control" }, { status: 404 });
      if (path === "/__browser/dialogue/start") { const result = await active.start(); return Response.json({ result, ...active.metrics() }); }
      if (path === "/__browser/dialogue/capture-abandon") return Response.json(active.captureForAbandonment());
      if (path === "/__browser/dialogue/seed-recent-reading") { const input = await request.json() as { outsideWindow?: boolean; userAuthored?: boolean; longText?: boolean }; return Response.json(active.seedRecentReading(input.outsideWindow === true, input.userAuthored === true, input.longText === true)); }
      if (path === "/__browser/dialogue/revise-recent-reading") return Response.json(active.reviseRecentReading());
      if (path === "/__browser/dialogue/seed-legacy-random") return Response.json(active.seedLegacyRandom());
      if (path === "/__browser/dialogue/revise-legacy-random") return Response.json(active.reviseLegacyRandom());
      if (path === "/__browser/dialogue/abandon") return Response.json(active.abandon());
      if (path === "/__browser/dialogue/write-idea") { await active.writeIdea(); return Response.json(active.metrics()); }
      if (path === "/__browser/dialogue/preview") { const input = await request.json() as { text?: unknown; start?: unknown }; if (typeof input.text !== "string" || typeof input.start !== "boolean") return Response.json({ error: "Invalid preview fixture" }, { status: 400 }); await active.preview(input.text, input.start); return Response.json(active.metrics()); }
      if (path === "/__browser/dialogue/write-follow-up") { const input = await request.json() as { multiple?: boolean }; await active.writeFollowUp(input.multiple === true); return Response.json(active.metrics()); }
      if (path === "/__browser/dialogue/write-neighbor-follow-up") { await active.writeNeighborFollowUp(); return Response.json(active.metrics()); }
      if (path === "/__browser/dialogue/write-alias") { await active.writeAlias(); return Response.json(active.metrics()); }
      if (path === "/__browser/dialogue/configure-follow-up") {
        const input = await request.json() as { availability?: "available" | "unconfigured" | "unavailable"; uncertain?: boolean };
        if ((input.availability !== undefined && !["available", "unconfigured", "unavailable"].includes(input.availability)) || (input.uncertain !== undefined && typeof input.uncertain !== "boolean")) return Response.json({ error: "Invalid fixture availability" }, { status: 400 });
        active.configureFollowUp(input); return Response.json(active.metrics());
      }
      if (path === "/__browser/dialogue/advance") {
        const input = await request.json() as { outcome: Outcome; text?: string; idea?: boolean };
        if (!["pending", "succeeded", "failed", "interrupted"].includes(input.outcome) || (input.text !== undefined && typeof input.text !== "string")) return Response.json({ error: "Invalid scripted outcome" }, { status: 400 });
        await active.advance(input.outcome, input.text ?? "", input.idea === true); return Response.json(active.metrics());
      }
      if (path === "/__browser/dialogue/revise") {
        const input = await request.json() as { target: "item" | "relationship" | "both" };
        if (!["item", "relationship", "both"].includes(input.target)) return Response.json({ error: "Invalid example revision target" }, { status: 400 });
        active.revise(input.target); return Response.json(active.metrics());
      }
      if (path === "/__browser/dialogue/block-root") return Response.json(active.blockRoot());
      if (path === "/__browser/dialogue/recreate") { await active.recreate(); return Response.json(active.metrics()); }
      return Response.json({ error: "Unknown example dialogue control" }, { status: 404 });
    },
  };
}
