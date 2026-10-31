import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { WeavingWorker, type Observation, type WeavingAdapter, type WeavingRun } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-weaving-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const app = createApp({ databasePath });
  const response = await app.request("/captures", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "weaving-source" },
    body: JSON.stringify({ text: "An original thought for a controlled weaving run.", provenance: "manual" }),
  });
  expect(response.status).toBe(201);
  const source = await response.json() as { id: string; text: string; createdAt: string; provenance: string };
  return { databasePath, app, source };
}

class ScriptedAdapter implements WeavingAdapter {
  prepared: WeavingRun[] = [];
  admitted: WeavingRun[] = [];
  inspected: WeavingRun[] = [];
  onAdmit: (run: WeavingRun) => Promise<{ kind: "admitted" } | { kind: "uncertain" }> = async () => ({ kind: "admitted" });
  outcome: Observation = { kind: "pending" };
  async prepareSession(run: WeavingRun): Promise<void> { this.prepared.push(run); }
  async admit(run: WeavingRun) { this.admitted.push(run); return this.onAdmit(run); }
  async inspect(run: WeavingRun) { this.inspected.push(run); return this.outcome; }
}

test("claim persists the owned run and stable native IDs before admission; admission is not completion", async () => {
  const { databasePath, source } = await fixture();
  const adapter = new ScriptedAdapter();
  adapter.onAdmit = async (run) => {
    const persisted = await new WeavingWorker({ databasePath, adapter }).getJob(source.id);
    expect(persisted).toMatchObject({ sourceId: source.id, status: "running", run });
    expect(run.runId).toBeTruthy();
    expect(run.sessionId).toBeTruthy();
    expect(run.promptId).toBeTruthy();
    expect(adapter.prepared).toEqual([run]);
    return { kind: "admitted" };
  };
  const worker = new WeavingWorker({ databasePath, adapter });
  const started = await worker.startNext();
  expect(started.kind).toBe("started");
  expect((await worker.getJob(source.id))?.status).toBe("running");
  expect(adapter.admitted).toHaveLength(1);
});

test("one leased capture cannot be claimed by a competing worker", async () => {
  const { databasePath, source } = await fixture();
  const adapter = new ScriptedAdapter();
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseResolve: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  adapter.onAdmit = async () => { enteredResolve?.(); await release; return { kind: "admitted" }; };
  const first = new WeavingWorker({ databasePath, adapter }).startNext();
  try {
    await Promise.race([entered, first.then(() => { throw new Error("Worker returned before admission"); })]);
    const competing = await new WeavingWorker({ databasePath, adapter }).startNext();
    expect(competing).toEqual({ kind: "empty" });
    expect((await new WeavingWorker({ databasePath, adapter }).getJob(source.id))?.status).toBe("running");
    expect(adapter.admitted).toHaveLength(1);
  } finally { releaseResolve?.(); await first; }
});

test("restart reconciles the same admitted IDs without resubmission and permits zero-change success", async () => {
  const { databasePath, source } = await fixture();
  const adapter = new ScriptedAdapter();
  const first = new WeavingWorker({ databasePath, adapter });
  const started = await first.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected a started job");
  adapter.outcome = { kind: "completed", recordedChanges: 0 };
  const restarted = new WeavingWorker({ databasePath, adapter });
  await restarted.recover();
  expect(adapter.admitted).toEqual([started.run]);
  expect(adapter.inspected).toEqual([started.run]);
  expect(await restarted.getJob(source.id)).toMatchObject({ status: "completed", run: started.run });
});

test("uncertain admission remains uncertain across restart and never resubmits", async () => {
  const { databasePath, source } = await fixture();
  const adapter = new ScriptedAdapter();
  adapter.onAdmit = async () => ({ kind: "uncertain" });
  const first = new WeavingWorker({ databasePath, adapter });
  const started = await first.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected a started job");
  expect((await first.getJob(source.id))?.status).toBe("uncertain");
  const restarted = new WeavingWorker({ databasePath, adapter });
  await restarted.recover();
  expect(adapter.inspected).toEqual([started.run]);
  expect(adapter.admitted).toEqual([started.run]);
  expect((await restarted.getJob(source.id))?.status).toBe("uncertain");
});

test("unconfigured service fails closed while the saved original and queued job remain available", async () => {
  const { databasePath, source, app } = await fixture();
  const worker = new WeavingWorker({ databasePath, adapter: null });
  expect(await worker.startNext()).toEqual({ kind: "unavailable" });
  expect(await worker.getJob(source.id)).toMatchObject({ sourceId: source.id, status: "queued", run: null });
  expect(await (await app.request(`/sources/${source.id}`)).json()).toEqual(source);
});

test("recovery retains correlated failure and interruption distinctly without resubmission", async () => {
  for (const outcome of ["failed", "interrupted"] as const) {
    const { databasePath, source } = await fixture();
    const adapter = new ScriptedAdapter();
    const worker = new WeavingWorker({ databasePath, adapter });
    const started = await worker.startNext();
    expect(started.kind).toBe("started");
    adapter.outcome = { kind: outcome };
    await new WeavingWorker({ databasePath, adapter }).recover();
    expect((await worker.getJob(source.id))?.status).toBe(outcome);
    expect(adapter.admitted).toHaveLength(1);
  }
});
