import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KnowledgeService } from "../src/knowledge";
import { createToolApp, OwnedGrants } from "../src/tool-boundary";
import { WeavingWorker, type WeavingRun } from "../src/weaving";

type Cleanup = Array<() => Promise<void>>;

export async function searchFixture(rootText: string, cleanup: Cleanup) {
  const dir = await mkdtemp("/tmp/opencode/search-fixture-"), databasePath = join(dir, "fixture.sqlite");
  cleanup.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const app = createApp({ databasePath });
  let count = 0;
  const capture = async (text: string) => {
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `fixture-${++count}` }, body: JSON.stringify({ text, provenance: "test-owned source" }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; text: string; provenance: string };
  };
  const root = await capture(rootText);
  return { app, databasePath, root, capture, knowledge: new KnowledgeService(databasePath) };
}

export async function ownedSearchTransport(f: Awaited<ReturnType<typeof searchFixture>>, cleanup: Cleanup) {
  let enter = (_run: WeavingRun) => {}, release = () => {};
  const entered = new Promise<WeavingRun>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker = new WeavingWorker({ databasePath: f.databasePath, adapter: { async prepareSession(run) { enter(run); await gate; }, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; } } });
  const done = worker.startNext();
  cleanup.unshift(async () => { release(); await done; await worker.close(); });
  const run = await Promise.race([entered, done.then(() => { throw new Error("Fixture worker did not enter"); })]);
  new OwnedGrants(f.databasePath).bind({ run, location: "/fixture/search", agent: "fixture-search", sourceIds: [f.root.id], operations: ["search"] });
  release(); expect((await done).kind).toBe("started");
  const tools = createToolApp({ databasePath: f.databasePath, transportCredential: "fixture-search-credential", location: "/fixture/search" });
  const native = { sessionID: run.sessionId, agent: "fixture-search", messageID: "msg_fixture_search", callID: "call_fixture_search" };
  return (input: unknown) => tools.request("/internal/tools/search", { method: "POST", headers: { authorization: "Bearer fixture-search-credential", "content-type": "application/json" }, body: JSON.stringify({ action: "search", native, input }) });
}
