import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { createApp } from "../src/daemon/app";
import { AgentService } from "../src/domain/agent";
import { CreationService } from "../src/domain/creation";
import { ExportHistoryService, type ExportHistoryItem } from "../src/domain/export-history";
import { RejectionService } from "../src/domain/rejection";
import { RunService } from "../src/domain/run";
import { TitleService } from "../src/domain/title";
import { createLogger } from "../src/logging";
import { SqliteAgentRuns } from "../src/storage/agent";
import { SqliteAgenticExports } from "../src/storage/agentic-export";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";

const credentials = { user: "owned-user-token", ai: "owned-ai-token" };
const logger = createLogger("error", () => {});

async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const f = setup();
  try { await action(f); } finally { f.db.close(); }
}
function setup() {
  const db = new Database(":memory:"); migrate(db, logger);
  const clock = { now: "2030-01-01T00:00:00.000Z" }; let sequence = 0, nativeCalls = 0;
  const sources = { id: () => `owned-${++sequence}`, now: () => clock.now, logger };
  const store = new SqliteStore(db), rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
  const creation = new CreationService({ rejection, ...sources, writes: {
    createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection),
  } });
  const titles = new TitleService(new SqliteTitleRepository(db, sources));
  const agents = new AgentService(new SqliteAgentRuns(db, sources), true);
  const exports = new SqliteAgenticExports(db, sources), runs = new SqliteRunRepository(db, sources);
  const app = createApp({ rejection, creation, titles, agents, exportHistory: new ExportHistoryService(exports), credentials, logger: () => {}, diagnostics: logger });
  const runService = new RunService({ repository: runs, ...sources, dispatcher: {
    submit: async () => { nativeCalls++; throw new Error("unexpected provider submit"); },
    observe: async () => { nativeCalls++; throw new Error("unexpected provider observation"); },
  } });
  const steps = new SqliteRunProtocolRepository(db, logger), capabilities = new SqliteCapabilityDispatcher(db, sources);
  store.saveThought({ id: "source", text: "owned library thought", title: null, titleAuthor: null, author: "user",
    kind: "captured-original", createdAt: clock.now, origin: "fixture", parentId: null, sourceIds: [] });
  function request(path: string, options: { actor?: "user" | "ai" | "none"; method?: string; raw?: string } = {}) {
    const headers = new Headers(); const actor = options.actor ?? "user";
    if (actor !== "none") headers.set("authorization", `Bearer ${credentials[actor]}`);
    if (options.raw !== undefined) headers.set("content-type", "application/json");
    return app.request(path, { method: options.method ?? "GET", headers, body: options.raw });
  }
  function complete() {
    const run = exports.admit("user", { request: "Gather source", effort: "thorough" });
    const claim = runs.claim(run.id); steps.prepare(claim, { promptId: run.promptId, input: "PRIVATE-PROMPT-SENTINEL" });
    const read = { capability: "readThought", arguments: { id: "source" } };
    steps.completeStep(claim, run.promptId, { version: 1, kind: "request", request: read });
    const result = capabilities.dispatch(claim, run.promptId, read);
    const next = { promptId: `${run.id}-next`, input: JSON.stringify(result) };
    steps.advance(claim, run.promptId, result, next);
    steps.completeStep(claim, next.promptId, { version: 1, kind: "report", markdown: "# Owned report", sourceThoughtIds: ["source"] });
    return {run, report:exports.finalize(claim, next.promptId)};
  }
  const knowledge = () => ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "rejected_thoughts", "connections", "responses"]
    .map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  return {db, clock, sources, store, rejection, exports, runs, runService, steps, request, complete, knowledge, nativeCalls: () => nativeCalls};
}
function privateResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
}
interface Page { readonly items: readonly ExportHistoryItem[]; readonly nextCursor: string | null }

test("export catalog is bounded, deterministic, user-only and exposes only export metadata", async () => fixture(async f => {
  const ids: string[] = [];
  for (let i = 0; i < 51; i++) ids.push(f.exports.admit("user", { request: `Owned question ${i}`, effort: "quick" }).id);
  const weave = f.runService.admit("user", "weave").run;
  const legacy = f.runService.admit("user", "export").run;
  const first = await f.request("/exports/agentic");
  expect(first.status).toBe(200); privateResponse(first);
  const page = await first.json() as Page;
  expect(page.items).toHaveLength(50); expect(typeof page.nextCursor).toBe("string");
  if (!page.nextCursor) throw new Error("missing export cursor");
  const second = await f.request(`/exports/agentic?cursor=${encodeURIComponent(page.nextCursor)}`);
  expect(second.status).toBe(200); privateResponse(second);
  const last = await second.json() as Page;
  expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeNull();
  expect([...page.items, ...last.items].map(item => item.id).sort()).toEqual(ids.sort());
  expect(page.items.some(item => item.id === weave.id || item.id === legacy.id)).toBe(false);
  for (const item of [...page.items, ...last.items]) {
    expect(Object.keys(item).sort()).toEqual(["createdAt", "deletionState", "effort", "id", "request", "restored", "status"]);
    expect(item).toMatchObject({ status: "queued", effort: "quick", restored: false, deletionState: "stop-required" });
  }
  const bounded = await f.request("/exports/agentic?limit=1");
  expect(bounded.status).toBe(200);
  const boundedPage = await bounded.json() as Page;
  expect(boundedPage.items).toHaveLength(1); expect(boundedPage.nextCursor).not.toBeNull();
  for (const query of ["?limit=0", "?limit=201", "?limit=1.5", "?limit=01", "?limit=1&limit=1", "?other=1", "?cursor=invalid", `?limit=2&cursor=${encodeURIComponent(boundedPage.nextCursor ?? "")}`]) {
    expect((await f.request(`/exports/agentic${query}`)).status).toBe(400);
  }
  expect((await f.request("/exports/agentic", {actor:"ai"})).status).toBe(403);
  expect((await f.request("/exports/agentic", {actor:"none"})).status).toBe(401);
}));

test("metadata recovers request and effort while existing Markdown download survives source rejection", async () => fixture(async f => {
  const {run, report} = f.complete();
  f.rejection.rejectThought("user", "source");
  const response = await f.request(`/exports/agentic/${run.id}/metadata`);
  expect(response.status).toBe(200); privateResponse(response);
  const metadata = await response.json();
  expect(metadata).toEqual({id:run.id,status:"completed",createdAt:f.clock.now,request:"Gather source",effort:"thorough",restored:false,deletionState:"ready"});
  expect(JSON.stringify(metadata)).not.toContain("PRIVATE-PROMPT-SENTINEL");
  expect(JSON.stringify(metadata)).not.toContain(run.sessionId);
  expect(JSON.stringify(metadata)).not.toContain(run.promptId);
  const download = await f.request(`/exports/agentic/${run.id}`);
  expect(download.status).toBe(200); expect(download.headers.get("content-type")).toContain("text/markdown");
  expect(await download.text()).toBe(report.markdown);
  for (const path of [`/exports/agentic/${run.id}/metadata`, `/exports/agentic/${run.id}`]) {
    expect((await f.request(path,{actor:"ai"})).status).toBe(403);
  }
  expect((await f.request(`/exports/agentic/${run.id}/metadata?unexpected=1`)).status).toBe(400);
  expect((await f.request("/exports/agentic/missing/metadata")).status).toBe(404);
}));

test("Delete requires Stop and cancellation settlement and preserves unrelated records", async () => fixture(async f => {
  const admitted = await f.request("/exports/agentic", {method:"POST",raw:JSON.stringify({request:"Owned queued export"})});
  expect(admitted.status).toBe(201);
  const {run} = await admitted.json() as {run:{id:string;kind:string;status:string}};
  expect(run).toMatchObject({kind:"export",status:"queued"});
  const before = f.knowledge(), weave = f.runService.admit("user", "weave").run;
  const path = `/exports/agentic/${run.id}`;
  expect((await f.request(path,{method:"DELETE",actor:"ai"})).status).toBe(403);
  expect((await f.request(path,{method:"DELETE"})).status).toBe(409);
  expect((await f.request(`/exports/agentic/${weave.id}`,{method:"DELETE"})).status).toBe(404);
  expect((await f.request("/exports/agentic/missing",{method:"DELETE"})).status).toBe(404);
  const stopped = await f.request(`/runs/${run.id}/stop`,{method:"POST",raw:"{}"});
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({id:run.id,kind:"export",status:"interrupted"});
  expect((await f.request(`${path}/metadata`)).status).toBe(200);
  expect(await (await f.request(`${path}/metadata`)).json()).toMatchObject({deletionState:"settling",restored:false});
  expect((await f.request(path,{method:"DELETE"})).status).toBe(409);
  expect(new SqliteRunWorkerState(f.db,f.sources).settleUnsubmitted(run.id)).toBe(true);
  const deleted = await f.request(path,{method:"DELETE"});
  expect(deleted.status).toBe(204); privateResponse(deleted); expect(await deleted.text()).toBe("");
  expect((await f.request(`${path}/metadata`)).status).toBe(404);
  expect((await f.request(path)).status).toBe(404);
  expect((await f.request(path,{method:"DELETE"})).status).toBe(404);
  expect(f.runs.get(weave.id)?.kind).toBe("weave"); expect(f.knowledge()).toEqual(before);
}));

test("deleting a completed report removes its history and Markdown but not library knowledge", async () => fixture(async f => {
  const {run} = f.complete(), before = f.knowledge(), path = `/exports/agentic/${run.id}`;
  expect((await f.request(path)).status).toBe(200);
  expect((await f.request(path,{method:"DELETE"})).status).toBe(204);
  expect((await f.request(path)).status).toBe(404);
  expect((await f.request(`${path}/metadata`)).status).toBe(404);
  const page = await (await f.request("/exports/agentic")).json() as Page;
  expect(page.items.some(item => item.id === run.id)).toBe(false);
  expect(f.knowledge()).toEqual(before);
}));

test("generic Stop acknowledges restored local discard without changing pending cancellation or calling a provider", async () => fixture(async f => {
  const run = f.exports.admit("user",{request:"Restored request",effort:"quick"});
  f.runService.stop("user",run.id);
  f.db.run("INSERT INTO restore_fences VALUES ('run',?,?,?,?)",[run.id,"a".repeat(64),f.clock.now,"{}"]);
  const path = `/exports/agentic/${run.id}`, before = f.db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(run.id);
  let resolutions = 0, clients = 0;
  const worker = new ConfiguredRunWorker({db:f.db,...f.sources,config:{service:{url:"http://127.0.0.1:44991"},directory:"/tmp/opencode/owned-agent",
    model:{providerID:"fixture",id:"fixture"},effort:{quick:null,standard:null,thorough:null}},
    async resolve() { resolutions++; throw new Error("unexpected provider resolution"); },
    client() { clients++; throw new Error("unexpected provider client"); }});
  try {
    await worker.tick(run.id);
    expect((await f.request(path,{method:"DELETE"})).status).toBe(409);
    const metadata = await f.request(`${path}/metadata`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({request:"Restored request",effort:"quick",restored:true,status:"interrupted",deletionState:"stop-required"});
    expect((await f.request(`/runs/${run.id}/stop`,{method:"POST",raw:"{}",actor:"ai"})).status).toBe(403);
    expect((await f.request(`/runs/${run.id}/stop`,{method:"POST",raw:"{}"})).status).toBe(200);
    await worker.tick(run.id);
    expect(f.db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(run.id)).toEqual(before);
    expect(f.steps.cancellation(run.id)).toBe("pending");
    expect(await (await f.request(`${path}/metadata`)).json()).toMatchObject({restored:true,deletionState:"ready"});
    expect((await f.request(path,{method:"DELETE"})).status).toBe(204);
    await worker.tick(run.id);
    expect((await f.request(path)).status).toBe(404);
    expect(f.nativeCalls()).toBe(0); expect(resolutions).toBe(0); expect(clients).toBe(0);
  } finally { worker.pause(); await worker.drain(); }
}));
