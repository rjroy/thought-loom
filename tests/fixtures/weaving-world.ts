import { dirname, join } from "node:path";
import { createApp } from "../../apps/daemon/src/app";
import { KnowledgeService } from "../../apps/daemon/src/knowledge";
import { openDatabase, saveCapture } from "../../apps/daemon/src/storage";
import { createToolApp, OwnedGrants } from "../../apps/daemon/src/tool-boundary";
import { WeavingWorker, type Observation, type WeavingAdapter, type WeavingRun } from "../../apps/daemon/src/weaving";
import { WeavingSupervisor } from "../../apps/daemon/src/weaving-supervisor";
import type { Source } from "../../packages/contracts/src";
import { weavingExample as example, type BrowserWeavingScenario } from "./weaving-content";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// One explicit supervisor tick at a time; no polling sleeps or wall-clock races.
class TickGate {
  private checkpoint = deferred();
  private wake: (() => void) | undefined;
  wait = (signal: AbortSignal) => new Promise<void>((resolve) => {
    const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
    this.wake = finish;
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
    this.checkpoint.resolve();
  });
  entered() { return this.checkpoint.promise; }
  async advance() {
    if (!this.wake) throw new Error("Example supervisor has not reached its wait gate");
    const wake = this.wake;
    this.wake = undefined;
    this.checkpoint = deferred();
    wake();
    await this.checkpoint.promise;
  }
}

export async function createWeavingWorld(databasePath: string, scenario: BrowserWeavingScenario, captureInBrowser = false) {
  const capture = (key: string, text: string): Source => {
    const saved = saveCapture(databasePath, `weaving-example-${key}`, { text, provenance: example.provenance });
    if (saved.kind !== "created") throw new Error("Weaving examples require a fresh database");
    return saved.source;
  };
  const counterpart = capture("counterpart", example.counterpart);
  const candidate = new KnowledgeService(databasePath).createItem({ actor: "user", operationId: "example-candidate" }, {
    kind: "interpretation", sourceId: counterpart.id, text: example.candidate, evidenceSourceIds: [counterpart.id],
  });
  // Settle the candidate's own job through the real worker before the target
  // source exists, so it cannot steal a later controlled target tick.
  const candidateWorker = new WeavingWorker({ databasePath, adapter: {
    async prepareSession() {}, async admit() { return { kind: "admitted" }; },
    async inspect() { return { kind: "completed", recordedChanges: 0 }; },
  } });
  await candidateWorker.startNext(); await candidateWorker.recover(); await candidateWorker.close();

  let source: Source | null = captureInBrowser ? null : capture("original", example.original);
  let now = 1_000;
  let observation: Observation = { kind: "pending" };
  const admissions: WeavingRun[] = [], inspections: WeavingRun[] = [];
  const written = new Set<string>();
  const transportCredential = "browser-fixture-only-not-a-real-secret";
  const location = join(dirname(databasePath), "example-owned-location");
  const tools = createToolApp({ databasePath, transportCredential, location });

  async function recordThroughTools(run: WeavingRun) {
    const send = async (path: string, callID: string, input: object) => {
      const response = await tools.request(`/internal/tools/${path}`, {
        method: "POST", headers: { authorization: `Bearer ${transportCredential}`, "content-type": "application/json" },
        body: JSON.stringify({ native: { sessionID: run.sessionId, agent: "browser-example-weaver", messageID: "msg_browser_example_assistant", callID }, input }),
      });
      if (response.status !== 200) throw new Error(`Example domain tool failed: ${path} (${response.status})`);
      return response;
    };
    await send("read-source", "call_root_read", { sourceId: run.sourceId });
    const result = await (await send("record-interpretation", "call_interpret", {
      sourceId: run.sourceId, text: example.interpretation, evidenceSourceIds: [run.sourceId],
    })).json() as { id: string; current: { id: string } };
    await send("read-item", "call_candidate_read", { itemId: candidate.id });
    await send("read-source", "call_evidence_read", { sourceId: counterpart.id });
    await send("record-relationship", "call_connect", {
      fromItemId: result.id, fromVersionId: result.current.id, toItemId: candidate.id, toVersionId: candidate.current.id,
      type: "suggests", rationale: example.rationale, evidenceSourceIds: [run.sourceId, counterpart.id],
    });
  }

  const adapter: WeavingAdapter = {
    async prepareSession(run) {
      if (scenario === "unavailable") throw new Error("Example configured service is unavailable");
      new OwnedGrants(databasePath).bind({ run, location, agent: "browser-example-weaver", sourceIds: [run.sourceId],
        operations: ["read_source", "read_item", "record_interpretation", "record_relationship"] });
    },
    async admit(run) { admissions.push(run); return { kind: scenario === "uncertain" ? "uncertain" : "admitted" }; },
    async inspect(run) {
      inspections.push(run);
      if ((observation.kind === "completed" || observation.kind === "interrupted") && scenario === "updates") {
        if (!written.has(run.runId)) { await recordThroughTools(run); written.add(run.runId); }
        return observation.kind === "completed" ? { kind: "completed", recordedChanges: 2 } : observation;
      }
      return observation;
    },
  };
  const worker = new WeavingWorker({ databasePath, adapter: scenario === "unconfigured" ? null : adapter,
    now: () => now, leaseMs: 100, maxAttempts: 3 });
  const gate = new TickGate();
  const supervisor = new WeavingSupervisor({ worker, wait: gate.wait });
  // Proposed composition seam for the backend GREEN lane. Today createApp
  // ignores weavingWorker/weavingConfigured; no production behavior is added here.
  const composition = { databasePath, weavingStatus: () => supervisor.status,
    weavingWorker: worker, weavingConfigured: scenario !== "unconfigured" };
  const app = createApp(composition);
  let started = false;

  return {
    app, worker, supervisor, databasePath, counterpart,
    get source() { return source; },
    async fetch(request: Request) {
      const response = await app.fetch(request);
      if (request.method === "POST" && new URL(request.url).pathname === "/captures" && response.status === 201) source = await response.clone().json() as Source;
      return response;
    },
    async start() {
      if (started) return;
      started = true;
      const entered = gate.entered(); await supervisor.start(); await entered;
    },
    async advance(next: Observation = { kind: "pending" }) {
      observation = next;
      now += 101;
      if (!started) { started = true; const entered = gate.entered(); await supervisor.start(); await entered; }
      else await gate.advance();
    },
    metrics() {
      const db = openDatabase(databasePath);
      try {
        const count = (table: "sources" | "jobs" | "weaving_runs") => db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
        return { sourceId: source?.id ?? null, sources: count("sources"), jobs: count("jobs"), runs: count("weaving_runs"),
          admissions: admissions.map((run) => ({ ...run })), inspections: inspections.map((run) => ({ ...run })),
          activeGrants: db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owned_grants WHERE revoked=0").get()?.count ?? 0 };
      } finally { db.close(); }
    },
    async close() { await supervisor.close(); },
  };
}

export type BrowserWeavingWorld = Awaited<ReturnType<typeof createWeavingWorld>>;

// These controls exist only in the test harness process. Browser/application
// production entrypoints do not import this module or expose these routes.
export function createBrowserWeavingControls(directory: string) {
  let active: BrowserWeavingWorld | null = null;
  return {
    async close() { await active?.close(); active = null; },
    async fetch(request: Request): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/__browser/weaving")) return active ? active.fetch(request) : null;
      if (path === "/__browser/weaving/reset" && request.method === "POST") { await active?.close(); active = null; return Response.json({ reset: true }); }
      if (path === "/__browser/weaving/world" && request.method === "POST") {
        const input = await request.json() as { scenario: BrowserWeavingScenario; captureInBrowser?: boolean };
        if (!["unconfigured", "available", "uncertain", "unavailable", "updates"].includes(input.scenario)) return Response.json({ error: "Unknown example scenario" }, { status: 400 });
        await active?.close();
        active = await createWeavingWorld(join(directory, `weaving-${crypto.randomUUID()}.sqlite`), input.scenario, input.captureInBrowser === true);
        return Response.json({ source: active.source, counterpart: active.counterpart, exampleOnly: true });
      }
      if (!active) return Response.json({ error: "No example world" }, { status: 409 });
      if (path === "/__browser/weaving/metrics" && request.method === "GET") return Response.json(active.metrics());
      if (path === "/__browser/weaving/start" && request.method === "POST") { await active.start(); return Response.json(active.metrics()); }
      if (path === "/__browser/weaving/advance" && request.method === "POST") {
        const input = await request.json() as { outcome: "pending" | "completed" | "failed" | "interrupted" };
        if (!["pending", "completed", "failed", "interrupted"].includes(input.outcome)) return Response.json({ error: "Invalid example outcome" }, { status: 400 });
        await active.advance(input.outcome === "completed" ? { kind: "completed", recordedChanges: 0 } : { kind: input.outcome });
        return Response.json(active.metrics());
      }
      return Response.json({ error: "Unknown example control" }, { status: 404 });
    },
  };
}
