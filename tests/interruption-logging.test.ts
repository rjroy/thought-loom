import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentService } from "../src/domain/agent";
import { RunFenceError, RunService, type NativeDispatcher } from "../src/domain/run";
import { RejectionService } from "../src/domain/rejection";
import { createLogger, type LogRecord } from "../src/logging";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteAgentRuns } from "../src/storage/agent";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { mediaPathFixture } from "./fixtures/media-path-worker";

const dispatcher: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
const privateText = "test-owned private thought and reply sentinel";

function fixture(action: (f: {
  db: Database; records: LogRecord[]; runs: SqliteRunRepository; service: RunService;
  agents: AgentService; bindings: SqliteAgentBindings; operations: SqliteRunOperations; rejection: RejectionService;
}) => void): void {
  const db = new Database(":memory:");
  const records: LogRecord[] = [];
  const logger = createLogger("info", record => records.push(record));
  let sequence = 0;
  const sources = { id: () => `owned-${++sequence}`, now: () => "2031-01-01T00:00:00Z", logger };
  try {
    migrate(db, logger);
    new SqliteStore(db, undefined, logger).saveThought({ id: "root", text: privateText, title: null, author: "user", kind: "captured-original", createdAt: sources.now(), origin: "capture", parentId: null, sourceIds: [] });
    const runs = new SqliteRunRepository(db, sources);
    const service = new RunService({ repository: runs, dispatcher, ...sources });
    const agents = new AgentService(new SqliteAgentRuns(db, sources), true);
    const bindings = new SqliteAgentBindings(db, logger);
    const operations = new SqliteRunOperations(db, sources);
    const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
    records.length = 0;
    action({ db, records, runs, service, agents, bindings, operations, rejection });
    expect(JSON.stringify(records)).not.toContain(privateText);
  } finally { db.close(); }
}

// One event denotes a committed interruption, not an in-transaction attempt.
function interruptions(records: LogRecord[]): LogRecord[] {
  return records.filter(record => record.message === "[run storage] interruption committed");
}
function event(runId: string, reason: string, previousGeneration: number, cancellationState: string): LogRecord {
  return { level: "info", message: "[run storage] interruption committed", context: {
    runId, reason, previousStatus: "queued", status: "interrupted",
    previousGeneration, generation: previousGeneration + 1, cancellationState,
  } };
}

test("Stop logs its committed fence once, with safe generation and cancellation metadata", () => fixture(f => {
  const run = f.service.admit("user", "weave").run;
  f.runs.stop(run.id);
  f.runs.stop(run.id);
  expect(f.runs.get(run.id)).toMatchObject({ status: "interrupted", generation: 1 });
  expect(interruptions(f.records)).toEqual([event(run.id, "stopped", 0, "pending")]);
}));

test("AgentService Evolve Stop logs once after its owning transaction commits", () => fixture(f => {
  const { run } = f.agents.evolve("user", "root", privateText);
  expect(f.agents.stop("user", run.id)).toMatchObject({ id: run.id, status: "interrupted" });
  expect(f.agents.stop("user", run.id)).toMatchObject({ id: run.id, status: "interrupted" });
  expect(f.runs.get(run.id)).toMatchObject({ status: "interrupted", generation: 1 });
  expect(interruptions(f.records)).toEqual([event(run.id, "stopped", 0, "pending")]);
}));

test("AgentService Stop does not log if its owning transaction fails at commit", () => fixture(f => {
  const { run } = f.agents.evolve("user", "root", privateText);
  f.db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE test_stop_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE test_stop_child (parent_id INTEGER REFERENCES test_stop_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER test_stop_commit_failure AFTER UPDATE OF status ON runs
      WHEN NEW.status='interrupted' AND OLD.status='queued'
      BEGIN INSERT INTO test_stop_child(parent_id) VALUES (1); END;`);
  expect(() => f.agents.stop("user", run.id)).toThrow(/foreign key/i);
  expect(f.runs.get(run.id)).toMatchObject({ status: "queued", generation: 0 });
  expect(interruptions(f.records)).toEqual([]);
}));

test("invalidated context is distinguished from Stop after the fence commits", () => fixture(f => {
  const admission = f.service.admit("user", "weave");
  const claim = f.service.claim(admission.run.id);
  expect(f.service.context(claim, { kind: "thought", id: "root" })).not.toBeNull();
  expect(f.runs.contextRefs(admission.run.id)).toEqual([{ kind: "thought", id: "root" }]);
  f.rejection.rejectThought("user", "root");
  expect(() => f.runs.claim(admission.run.id)).toThrow(RunFenceError);
  expect(f.runs.get(admission.run.id)).toMatchObject({ status: "interrupted", generation: claim.generation + 1 });
  expect(interruptions(f.records)).toEqual([event(admission.run.id, "context-invalidated", claim.generation, "pending")]);
}));

test("native quarantine is not reported as an ordinary user Stop", () => fixture(f => {
  const run = f.service.admit("user", "weave").run;
  const claim = f.service.claim(run.id);
  f.bindings.assertActive(claim, undefined, "quarantined");
  expect(f.runs.get(run.id)).toMatchObject({ status: "interrupted", generation: claim.generation + 1 });
  expect(interruptions(f.records)).toEqual([event(run.id, "quarantined", claim.generation, "pending")]);
}));

test("an interrupted reply logs its own cause and does not claim cancellation was requested", () => fixture(f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: privateText });
  if (!admission.contribution) throw new Error("Expected owned contribution");
  const claim = f.service.claim(admission.run.id);
  f.runs.finish(claim, { id: "owned-reply", text: privateText, role: "fallback", state: "interrupted", thoughtIds: [admission.contribution.id] });
  expect(f.runs.get(admission.run.id)).toMatchObject({ status: "interrupted", generation: claim.generation + 1 });
  expect(interruptions(f.records)).toEqual([event(admission.run.id, "interrupted-reply", claim.generation, "none")]);
}));

test("rolled-back and transient failed transitions do not log a committed interruption", () => fixture(f => {
  const rollback = f.service.admit("user", "weave").run;
  expect(() => f.db.transaction(() => { f.runs.stop(rollback.id); throw new Error("owned rollback"); })()).toThrow("owned rollback");
  expect(f.runs.get(rollback.id)).toMatchObject({ status: "queued", generation: 0 });
  const failed = f.service.admit("user", "weave").run;
  const claim = f.service.claim(failed.id);
  f.operations.fail(claim);
  expect(f.runs.get(failed.id)).toMatchObject({ status: "failed", generation: claim.generation + 1 });
  expect(interruptions(f.records)).toEqual([]);
}));

test("eager media-source rejection logs its committed context fence once", async () => mediaPathFixture(async f => {
  const records: LogRecord[] = [];
  const logger = createLogger("info", record => records.push(record));
  const rejection = new RejectionService(new SqliteRejectionRepository(f.db, logger));
  const run = f.ops.admitWeave("user", { subjectId: f.source.id, triggerId: "test-media-interruption" });
  rejection.rejectThought("user", f.source.id);
  rejection.rejectThought("user", f.source.id);
  expect(f.run(run.id)).toMatchObject({ status: "interrupted", generation: 1 });
  expect(interruptions(records)).toEqual([event(run.id, "context-invalidated", 0, "pending")]);
  expect(JSON.stringify(records)).not.toContain(f.source.mediaSource.name);
  expect(JSON.stringify(records)).not.toContain(f.path);
}));
