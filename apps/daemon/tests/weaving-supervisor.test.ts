import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { WeavingSupervisor } from "../src/weaving-supervisor";
import { WeavingWorker, type WeavingAdapter, type WeavingRun } from "../src/weaving";

test("daemon supervisor claims and inspects independently of requests and stops cleanly", async () => {
  const calls: string[] = [];
  const run: WeavingRun = { jobId: "job-1", sourceId: "source-1", runId: "run-1", sessionId: "ses_1", promptId: "msg_1" };
  let announce = () => {};
  const waiting = new Promise<void>((resolve) => { announce = resolve; });
  const supervisor = new WeavingSupervisor({
    worker: {
      async recover() { calls.push("recover"); },
      async startNext() { calls.push("claim"); return calls.filter((call) => call === "claim").length === 1 ? { kind: "started" as const, run } : { kind: "empty" as const }; },
    },
    wait: (signal) => new Promise<void>((resolve) => { announce(); signal.addEventListener("abort", () => resolve(), { once: true }); }),
  });
  await supervisor.start();
  await waiting;
  expect(calls).toContain("recover");
  expect(calls).toContain("claim");
  await supervisor.close();
  const count = calls.length;
  await Promise.resolve();
  expect(calls).toHaveLength(count);
});

test("unavailable service yields a bounded wait instead of a busy retry loop", async () => {
  let calls = 0;
  let announce = () => {};
  const waiting = new Promise<void>((resolve) => { announce = resolve; });
  const supervisor = new WeavingSupervisor({
    worker: { async recover() {}, async startNext() { calls++; return { kind: "unavailable" as const }; } },
    wait: (signal) => new Promise<void>((resolve) => { announce(); signal.addEventListener("abort", () => resolve(), { once: true }); }),
  });
  await supervisor.start();
  await waiting;
  expect(calls).toBe(1);
  await supervisor.close();
});

test("a real queued capture is claimed then reconciled by daemon-lifetime supervisor ticks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-supervisor-"));
  try {
    const databasePath = join(directory, "test.sqlite");
    const app = createApp({ databasePath });
    const response = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "supervised" }, body: JSON.stringify({ text: "A queued original", provenance: "manual" }) });
    expect(response.status).toBe(201);
    const source = await response.json() as { id: string };
    const admitted: WeavingRun[] = [];
    const inspected: WeavingRun[] = [];
    const adapter: WeavingAdapter = {
      async prepareSession() {},
      async admit(run) { admitted.push(run); return { kind: "admitted" }; },
      async inspect(run) { inspected.push(run); return { kind: "completed", recordedChanges: 0 }; },
    };
    const worker = new WeavingWorker({ databasePath, adapter });
    let wake: (() => void) | undefined;
    let entered: (() => void) | undefined;
    let nextWait = new Promise<void>((resolve) => { entered = resolve; });
    const supervisor = new WeavingSupervisor({ worker, wait: (signal) => new Promise<void>((resolve) => {
      wake = resolve; entered?.(); signal.addEventListener("abort", () => resolve(), { once: true });
    }) });
    await supervisor.start();
    try {
      await nextWait;
      expect(admitted).toHaveLength(1);
      expect((await worker.getJob(source.id))?.status).toBe("running");
      nextWait = new Promise<void>((resolve) => { entered = resolve; });
      wake?.();
      await nextWait;
      expect(inspected).toEqual(admitted);
      expect((await worker.getJob(source.id))?.status).toBe("completed");
      expect(admitted).toHaveLength(1);
    } finally { await supervisor.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
