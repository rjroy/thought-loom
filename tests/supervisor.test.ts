import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RunSupervisor, type SupervisedWorker } from "../src/agent/supervisor";
import { RunService, type NativeDispatcher } from "../src/domain/run";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteAgenticExports } from "../src/storage/agentic-export";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const now = () => "2032-01-01T00:00:00Z";
const native: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>) {
  const dir = mkdtempSync(join("/tmp/opencode", "supervisor-owned-"));
  const db = new Database(join(dir, "owned.sqlite"));
  try { migrate(db); await action(setup(db)); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
function setup(db: Database) {
  let sequence = 0;
  const id = () => `fixture-${++sequence}`;
  new SqliteStore(db).saveThought({ id: "subject", text: "owned subject", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const runs = new SqliteRunRepository(db, { id, now });
  const service = new RunService({ repository: runs, dispatcher: native, id, now });
  const ops = new SqliteRunOperations(db, { id, now });
  const steps = new SqliteRunProtocolRepository(db);
  const admit = (triggerId: string) => ops.admitWeave("user", { subjectId: "subject", triggerId });
  return { db, runs, service, ops, steps, admit };
}
function gate() {
  let release: () => void = () => { throw new Error("gate not initialized"); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release() };
}
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

test("scans queued, active, uncertain and terminal pending cancellation, not settled or completed", async () => fixture(async f => {
  const queued = f.admit("queued");
  let exportSequence = 0;
  const exportRun = new SqliteAgenticExports(f.db, { id: () => `export-${++exportSequence}`, now }).admit("user", { request: "Find related thinking" });
  const active = f.admit("active");
  const activeClaim = f.service.claim(active.id);
  f.steps.prepare(activeClaim, { promptId: active.promptId, input: "active input" });
  f.runs.setStatus(activeClaim, "submitting", undefined, active.promptId);
  f.runs.setStatus(activeClaim, "running", "running", active.promptId);
  const uncertain = f.admit("uncertain");
  const uncertainClaim = f.service.claim(uncertain.id);
  f.steps.prepare(uncertainClaim, { promptId: uncertain.promptId, input: "uncertain input" });
  f.runs.setStatus(uncertainClaim, "submitting", undefined, uncertain.promptId);
  f.runs.setStatus(uncertainClaim, "uncertain", undefined, uncertain.promptId);
  const pending = f.admit("pending cancellation");
  f.service.stop("user", pending.id);
  const settled = f.admit("settled cancellation");
  f.service.stop("user", settled.id);
  f.steps.settleCancellation(settled.id);
  const finished = f.admit("finished");
  const doneClaim = f.service.claim(finished.id);
  f.steps.prepare(doneClaim, { promptId: finished.promptId, input: "done input" });
  f.steps.completeStep(doneClaim, finished.promptId, { version: 1, kind: "complete", reply: "no findings" });
  f.ops.completeWeave(doneClaim, finished.promptId);
  const seen: string[] = [];
  const worker: SupervisedWorker = { async tick(runId) { seen.push(runId); }, pause() {} };
  const supervisor = new RunSupervisor({ db: f.db, worker, startTimer: () => () => {} });
  try {
    await supervisor.poll();
    expect(seen.sort()).toEqual([queued.id, active.id, uncertain.id, pending.id, exportRun.id].sort());
    expect(f.runs.get(active.id)?.generation).toBe(activeClaim.generation);
    expect(f.runs.get(uncertain.id)?.generation).toBe(uncertainClaim.generation);
  } finally { await supervisor.stop(); }
}));

test("overlapping polls coalesce each run while independent runs progress", async () => fixture(async f => {
  const slow = f.admit("slow");
  const fast = f.admit("fast");
  const blocked = gate();
  const seen: string[] = [];
  const worker: SupervisedWorker = { async tick(runId) { seen.push(runId); if (runId === slow.id) await blocked.promise; }, pause() {} };
  const supervisor = new RunSupervisor({ db: f.db, worker, startTimer: () => () => {} });
  const first = supervisor.poll();
  try {
    await flush();
    expect(seen).toContain(slow.id);
    expect(seen).toContain(fast.id);
    const second = supervisor.poll();
    await flush();
    expect(seen.filter(id => id === slow.id)).toHaveLength(1);
    // A completed independent flight may be polled again; the slow one stays singular.
    blocked.release();
    await Promise.all([first, second]);
  } finally { blocked.release(); await first; await supervisor.stop(); }
}));

test("stop cancels timers, pauses before draining held work, and leaves run state untouched", async () => fixture(async f => {
  const run = f.admit("shutdown");
  const before = f.runs.get(run.id);
  const blocked = gate();
  let calls = 0, pauses = 0, timers = 0, cancels = 0;
  let timerCallback: (() => void) | undefined;
  const worker: SupervisedWorker = { async tick() { calls++; await blocked.promise; }, pause() { pauses++; } };
  const supervisor = new RunSupervisor({ db: f.db, worker, startTimer: callback => { timers++; timerCallback = callback; return () => { cancels++; }; } });
  supervisor.start();
  supervisor.start();
  const flight = supervisor.poll();
  try {
    await flush();
    expect(calls).toBe(1);
    expect(timers).toBe(1);
    let stopped = false;
    const stopping = supervisor.stop().then(() => { stopped = true; });
    await flush();
    expect(pauses).toBe(1);
    expect(cancels).toBe(1);
    expect(stopped).toBe(false);
    timerCallback?.();
    await flush();
    expect(calls).toBe(1);
    blocked.release();
    await Promise.all([flight, stopping]);
    await supervisor.stop();
    expect(pauses).toBe(1);
    expect(cancels).toBe(1);
    expect(f.runs.get(run.id)).toEqual(before);
    expect(f.steps.cancellation(run.id)).toBe("none");
  } finally { blocked.release(); await flight; await supervisor.stop(); }
}));
