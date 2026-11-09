import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { RunWorker, type WorkerNative } from "../src/agent/worker";
import type { AgentBinding } from "../src/agent/binding";
import type { AgentConfig } from "../src/daemon/agent-config";
import { RunFenceError, type Claim, type RunRecord } from "../src/domain/run";
import { createLogger } from "../src/logging";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { isRunRestoreFenced } from "../src/storage/restore-fences";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const now = () => "2030-01-02T03:04:05.000Z";
const logger = createLogger("verbose", () => {});
const agent: AgentConfig = { service: { url: "http://127.0.0.1:44991" }, directory: "/tmp/opencode/owned-restore-agent",
  model: { providerID: "fixture", id: "fixture" }, effort: { quick: null, standard: null, thorough: null } };
const binding = (run: RunRecord): AgentBinding => ({ sessionId: run.sessionId, serviceUrl: "http://127.0.0.1:44991",
  location: { directory: "/tmp/opencode/owned-restore-agent" }, model: { providerID: "fixture", id: "fixture" },
  permissions: [{ action: "*", resource: "*", effect: "allow" }], protocolVersion: 1 });

async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/restore-run-fence-"), db = new Database(join(dir, "owned.sqlite"));
  try { migrate(db, logger); await action(setup(db)); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}
function setup(db: Database) {
  let sequence = 0;
  const id = () => `owned-${++sequence}`, sources = { id, now, logger };
  const store = new SqliteStore(db), runs = new SqliteRunRepository(db, sources), ops = new SqliteRunOperations(db, sources);
  const steps = new SqliteRunProtocolRepository(db, logger), capabilities = new SqliteCapabilityDispatcher(db, sources);
  const state = new SqliteRunWorkerState(db, sources), bindings = new SqliteAgentBindings(db, logger);
  function admit(label: string): RunRecord {
    const subject = `subject-${label}`;
    store.saveThought({ id: subject, text: `test subject ${label}`, title: null, author: "user", kind: "captured-original",
      createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
    return ops.admitWeave("user", { subjectId: subject, triggerId: `capture:${subject}` });
  }
  function fence(runId: string): void {
    db.run("INSERT INTO restore_fences(entity_kind,entity_id,snapshot_sha256,restored_at,original_state_json) VALUES ('run',?,?,?,?)",
      [runId, "a".repeat(64), now(), "{}"]);
  }
  function snapshot() {
    return ["runs", "run_steps", "agent_bindings", "run_context", "run_operation_receipts", "run_issued_thoughts", "run_replies", "thoughts", "thought_titles"]
      .map(table => ({ table, rows: db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() }));
  }
  return { db, sources, runs, ops, steps, capabilities, state, bindings, admit, fence, snapshot };
}

test("fenced queued and already-claimed runs deny claim, prompt preparation, binding and Stop without rewriting history", async () => fixture(f => {
  const queued = f.admit("queued"), active = f.admit("active"), claim = f.runs.claim(active.id);
  const visibleQueued = f.runs.get(queued.id), visibleActive = f.runs.get(active.id);
  f.fence(queued.id); f.fence(active.id);
  const before = f.snapshot();
  expect(() => f.runs.claim(queued.id)).toThrow(RunFenceError);
  expect(() => f.runs.claim(active.id)).toThrow(RunFenceError);
  expect(() => f.steps.prepare(claim, { promptId: active.promptId, input: "private prepared prompt" })).toThrow(RunFenceError);
  expect(() => f.state.prepareInitial(claim, () => "private rendered prompt")).toThrow(RunFenceError);
  expect(() => f.bindings.bind(active.id, binding(active), claim)).toThrow(RunFenceError);
  expect(() => f.bindings.assertActive(claim)).toThrow(RunFenceError);
  f.runs.stop(queued.id); f.runs.stop(queued.id); f.runs.stop(active.id); f.runs.stop(active.id);
  expect(f.snapshot()).toEqual(before);
  expect(f.runs.get(queued.id)).toEqual(visibleQueued); expect(f.runs.get(active.id)).toEqual(visibleActive);
  const fresh = f.admit("fresh"), freshClaim = f.runs.claim(fresh.id);
  expect(freshClaim.runId).toBe(fresh.id);
  expect(f.steps.prepare(freshClaim, { promptId: fresh.promptId, input: "fresh owned prompt" }).input).toBe("fresh owned prompt");
  f.bindings.bind(fresh.id, binding(fresh), freshClaim);
  expect(f.bindings.get(fresh.id)).toEqual(binding(fresh));
}));

test("a fence blocks cached capability replay and new capability or legacy writes while fresh work still writes", async () => fixture(f => {
  const cached = f.admit("cached"), cachedClaim = f.runs.claim(cached.id);
  f.steps.prepare(cachedClaim, { promptId: cached.promptId, input: "owned read prompt" });
  const read = { capability: "readThought", arguments: { id: "subject-cached" } } as const;
  f.steps.completeStep(cachedClaim, cached.promptId, { version: 1, kind: "request", request: read });
  const result = f.capabilities.dispatch(cachedClaim, cached.promptId, read);
  expect(result.type).toBe("thought");
  expect(f.capabilities.dispatch(cachedClaim, cached.promptId, read)).toEqual(result);

  const pending = f.admit("pending"), pendingClaim = f.runs.claim(pending.id);
  f.steps.prepare(pendingClaim, { promptId: pending.promptId, input: "owned write prompt" });
  f.state.initialContext(pendingClaim);
  expect(f.capabilities.fullReadWitnesses(pending.id)).toContainEqual({ kind: "thought", id: "subject-pending" });
  const write = { capability: "interpretation", arguments: { text: "new fenced interpretation", sourceIds: [] } } as const;
  f.steps.completeStep(pendingClaim, pending.promptId, { version: 1, kind: "request", request: write });
  const receiptRun = f.admit("receipt"), receiptClaim = f.runs.claim(receiptRun.id);
  f.steps.prepare(receiptClaim, { promptId: receiptRun.promptId, input: "owned receipt prompt" });
  f.state.initialContext(receiptClaim);
  expect(f.capabilities.fullReadWitnesses(receiptRun.id)).toContainEqual({ kind: "thought", id: "subject-receipt" });
  f.steps.completeStep(receiptClaim, receiptRun.promptId, { version: 1, kind: "request", request: write });
  const receiptResult = f.capabilities.dispatch(receiptClaim, receiptRun.promptId, write);
  expect(f.ops.stepReceipt(receiptRun.id, receiptRun.promptId)).not.toBeNull();
  expect(f.capabilities.dispatch(receiptClaim, receiptRun.promptId, write)).toEqual(receiptResult);
  f.fence(cached.id); f.fence(pending.id); f.fence(receiptRun.id);
  const before = f.snapshot();
  expect(() => f.capabilities.dispatch(cachedClaim, cached.promptId, read)).toThrow(RunFenceError);
  expect(() => f.capabilities.dispatch(receiptClaim, receiptRun.promptId, write)).toThrow(RunFenceError);
  expect(() => f.capabilities.dispatch(pendingClaim, pending.promptId, write)).toThrow(RunFenceError);
  expect(() => f.runs.commit(pendingClaim, { id: "legacy-operation", type: "development", parentId: "subject-pending", text: "new fenced development", sourceIds: [] })).toThrow(RunFenceError);
  expect(f.snapshot()).toEqual(before);
  expect(f.ops.stepReceipt(pending.id, pending.promptId)).toBeNull();
  const fresh = f.admit("fresh-write"), freshClaim = f.runs.claim(fresh.id);
  f.steps.prepare(freshClaim, { promptId: fresh.promptId, input: "fresh owned write prompt" });
  f.state.initialContext(freshClaim);
  expect(f.capabilities.fullReadWitnesses(fresh.id)).toContainEqual({ kind: "thought", id: "subject-fresh-write" });
  f.steps.completeStep(freshClaim, fresh.promptId, { version: 1, kind: "request", request: write });
  expect(f.capabilities.dispatch(freshClaim, fresh.promptId, write).type).toBe("interpretation");
  expect(f.ops.stepReceipt(fresh.id, fresh.promptId)).not.toBeNull();
}));

test("configured direct tick does not resolve a service for a fenced queued run, while a fresh run still resolves", async () => fixture(async f => {
  const historical = f.admit("resolve-fenced"), fresh = f.admit("resolve-fresh"); f.fence(historical.id);
  let resolutions = 0, clients = 0;
  const worker = new ConfiguredRunWorker({ db: f.db, ...f.sources, config: agent,
    async resolve() { resolutions++; throw new Error("owned resolver tripwire"); },
    client() { clients++; throw new Error("owned client tripwire"); } });
  try {
    const before = f.snapshot(); await worker.tick(historical.id);
    expect(resolutions).toBe(0); expect(clients).toBe(0); expect(f.snapshot()).toEqual(before);
    await worker.tick(fresh.id); expect(resolutions).toBe(1); expect(clients).toBe(0);
  } finally { worker.pause(); await worker.drain(); }
}));

test("fenced terminal pending cancellation remains historical while unfenced cleanup reaches its native port", async () => fixture(async f => {
  function interrupted(label: string): RunRecord {
    const run = f.admit(label), claim = f.runs.claim(run.id), prompt = { promptId: run.promptId, input: "owned submitted prompt" };
    f.steps.prepare(claim, prompt); f.bindings.bind(run.id, binding(run), claim);
    f.bindings.assertActive(claim, prompt, "submit"); f.runs.stop(run.id);
    expect(f.steps.cancellation(run.id)).toBe("pending");
    return run;
  }
  const historical = interrupted("cancel-fenced"), fresh = interrupted("cancel-fresh"); f.fence(historical.id);
  let factories = 0, cancellations = 0;
  const native: WorkerNative = {
    async ensureSession() { throw new Error("unexpected ensure"); }, async submit() { throw new Error("unexpected submit"); },
    async observe() { throw new Error("unexpected observe"); }, async cancel() { cancellations++; return "pending"; },
  };
  const worker = new RunWorker({ db: f.db, ...f.sources, bindingFor: binding, native: () => { factories++; return native; } });
  try {
    const before = f.snapshot();
    f.runs.stop(historical.id); f.runs.stop(historical.id);
    await worker.tick(historical.id); await worker.tick(historical.id);
    expect(factories).toBe(0); expect(cancellations).toBe(0); expect(f.snapshot()).toEqual(before);
    expect(f.steps.cancellation(historical.id)).toBe("pending");
    await worker.tick(fresh.id); expect(factories).toBe(1); expect(cancellations).toBe(1);
  } finally { worker.pause(); await worker.drain(); }
}));

test("run fence lookup preserves historical identities without a runs row", async () => fixture(f => {
  expect(f.runs.get("purged-owned-run")).toBeNull();
  expect(isRunRestoreFenced(f.db, "purged-owned-run")).toBe(false);
  f.fence("purged-owned-run");
  expect(isRunRestoreFenced(f.db, "purged-owned-run")).toBe(true);
  expect(isRunRestoreFenced(f.db, "other-owned-run")).toBe(false);
  expect(f.runs.get("purged-owned-run")).toBeNull();
}));

test("a previously checked fence schema fails closed after owned DDL changes", async () => {
  const mutations = [
    "DROP TABLE restore_fences",
    "ALTER TABLE restore_fences ADD COLUMN unexpected TEXT",
    `DROP TABLE restore_fences; CREATE TABLE restore_fences (
      entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL,
      restored_at TEXT NOT NULL, original_state_json TEXT NOT NULL, PRIMARY KEY(entity_id,entity_kind))`,
    "DROP TRIGGER restore_fences_immutable_delete",
    `DROP TRIGGER restore_fences_immutable_update;
      CREATE TRIGGER restore_fences_immutable_update BEFORE UPDATE ON restore_fences BEGIN SELECT 1; END`,
  ];
  for (const ddl of mutations) await fixture(f => {
    const fresh = f.admit("schema-control"), target = f.admit("schema-target");
    expect(isRunRestoreFenced(f.db, fresh.id)).toBe(false);
    expect(f.runs.claim(fresh.id).runId).toBe(fresh.id);
    f.fence(target.id);
    expect(isRunRestoreFenced(f.db, target.id)).toBe(true);
    const before = f.snapshot();
    f.db.exec(ddl);
    expect(() => isRunRestoreFenced(f.db, target.id)).toThrow(RunFenceError);
    expect(() => f.runs.claim(target.id)).toThrow(RunFenceError);
    expect(f.snapshot()).toEqual(before);
    expect(f.runs.get(target.id)?.status).toBe("queued");
  });
});

test("a leading-BOM run alias cannot claim a fenced canonical run or change its journal", async () => fixture(f => {
  const historical = f.admit("alias-claim"), fresh = f.admit("alias-claim-fresh");
  f.fence(historical.id);
  const before = f.snapshot();
  expect(() => f.runs.claim(`\uFEFF${historical.id}`)).toThrow();
  expect(f.snapshot()).toEqual(before);
  expect(f.runs.get(historical.id)?.generation).toBe(historical.generation);
  expect(f.runs.claim(fresh.id).runId).toBe(fresh.id);
}));

test("a leading-BOM alias of a valid claim cannot replay cached reads or write receipts after fencing", async () => fixture(f => {
  const cached = f.admit("alias-read"), readClaim = f.runs.claim(cached.id);
  const read = { capability: "readThought", arguments: { id: "subject-alias-read" } } as const;
  f.steps.prepare(readClaim, { promptId: cached.promptId, input: "owned cached read" });
  f.steps.completeStep(readClaim, cached.promptId, { version: 1, kind: "request", request: read });
  const readResult = f.capabilities.dispatch(readClaim, cached.promptId, read);
  expect(readResult.type).toBe("thought");
  expect(f.capabilities.dispatch(readClaim, cached.promptId, read)).toEqual(readResult);

  const recorded = f.admit("alias-receipt"), recordedClaim = f.runs.claim(recorded.id);
  f.steps.prepare(recordedClaim, { promptId: recorded.promptId, input: "owned receipt context" });
  f.state.initialContext(recordedClaim);
  expect(f.capabilities.fullReadWitnesses(recorded.id)).toContainEqual({ kind: "thought", id: "subject-alias-receipt" });
  const write = { capability: "interpretation", arguments: { text: "owned cached interpretation", sourceIds: [] } } as const;
  f.steps.completeStep(recordedClaim, recorded.promptId, { version: 1, kind: "request", request: write });
  const recordedResult = f.capabilities.dispatch(recordedClaim, recorded.promptId, write);
  expect(f.ops.stepReceipt(recorded.id, recorded.promptId)).not.toBeNull();
  expect(f.capabilities.dispatch(recordedClaim, recorded.promptId, write)).toEqual(recordedResult);

  const pending = f.admit("alias-pending"), pendingClaim = f.runs.claim(pending.id);
  f.steps.prepare(pendingClaim, { promptId: pending.promptId, input: "owned pending context" });
  f.state.initialContext(pendingClaim);
  expect(f.capabilities.fullReadWitnesses(pending.id)).toContainEqual({ kind: "thought", id: "subject-alias-pending" });
  f.steps.completeStep(pendingClaim, pending.promptId, { version: 1, kind: "request", request: write });
  f.fence(cached.id); f.fence(recorded.id); f.fence(pending.id);
  const alias = (claim: Claim): Claim => ({ ...claim, runId: `\uFEFF${claim.runId}` });
  const before = f.snapshot();
  expect(() => f.capabilities.dispatch(alias(readClaim), cached.promptId, read)).toThrow();
  expect(() => f.capabilities.dispatch(alias(recordedClaim), recorded.promptId, write)).toThrow();
  expect(() => f.capabilities.dispatch(alias(pendingClaim), pending.promptId, write)).toThrow();
  expect(() => f.runs.commit(alias(pendingClaim), { id: "alias-op", type: "development", parentId: "subject-alias-pending", text: "must not write", sourceIds: [] })).toThrow();
  expect(f.snapshot()).toEqual(before);
  expect(f.ops.stepReceipt(pending.id, pending.promptId)).toBeNull();
  const fresh = f.admit("alias-write-control"), claim = f.runs.claim(fresh.id);
  f.steps.prepare(claim, { promptId: fresh.promptId, input: "fresh owned context" }); f.state.initialContext(claim);
  f.steps.completeStep(claim, fresh.promptId, { version: 1, kind: "request", request: write });
  expect(f.capabilities.dispatch(claim, fresh.promptId, write).type).toBe("interpretation");
}));

test("a leading-BOM alias cannot trigger configured service discovery for fenced history", async () => fixture(async f => {
  const historical = f.admit("alias-resolve"), fresh = f.admit("alias-resolve-control"); f.fence(historical.id);
  let resolutions = 0, clients = 0;
  const worker = new ConfiguredRunWorker({ db: f.db, ...f.sources, config: agent,
    async resolve() { resolutions++; throw new Error("owned resolver tripwire"); },
    client() { clients++; throw new Error("owned client tripwire"); } });
  try {
    const before = f.snapshot();
    try { await worker.tick(`\uFEFF${historical.id}`); } catch (error) { expect(error).toBeInstanceOf(Error); }
    expect(resolutions).toBe(0); expect(clients).toBe(0); expect(f.snapshot()).toEqual(before);
    await worker.tick(fresh.id); expect(resolutions).toBe(1); expect(clients).toBe(0);
  } finally { worker.pause(); await worker.drain(); }
}));

test("a leading-BOM Stop alias cannot interrupt or change fenced history", async () => fixture(f => {
  const historical = f.admit("alias-stop"), fresh = f.admit("alias-stop-control");
  f.fence(historical.id); const before = f.snapshot();
  try { f.runs.stop(`\uFEFF${historical.id}`); } catch (error) { expect(error).toBeInstanceOf(Error); }
  expect(f.snapshot()).toEqual(before);
  expect(f.runs.get(historical.id)).toEqual(historical);
  f.runs.stop(fresh.id); expect(f.runs.get(fresh.id)?.status).toBe("interrupted");
}));
