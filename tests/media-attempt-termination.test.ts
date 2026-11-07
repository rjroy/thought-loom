import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RunFenceError, type Claim } from "../src/domain/run";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { mediaAdmissionInput } from "./fixtures/media-admission";
import { expectNoMediaPublication, expectStoppedMediaAttempt, expectUntouchedMediaAttempt, installMediaStopFault,
  mediaTerminationFixture, mediaTerminationSnapshot, terminationAttempt, type MediaStopFault } from "./fixtures/media-termination";

describe("queued media-attempt Stop sealing", () => {
  test("Stop seals an admitted media attempt atomically", async () => mediaTerminationFixture(f => {
    expectUntouchedMediaAttempt(f);
    const { run, thought } = f.admission;
    const history = f.db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(run.id);
    const source = f.db.query("SELECT rowid,* FROM media_sources WHERE id=?").get(thought.mediaSource.id);

    f.runs.stop(run.id);

    expect(f.runs.get(run.id)).toEqual({ ...run, status: "interrupted", generation: run.generation + 1 });
    expectStoppedMediaAttempt(f.db, f.admission);
    expect(f.db.inTransaction).toBe(false);
    // A second real connection observes both terminal facts only after the command commits.
    expectStoppedMediaAttempt(f.other, f.admission);
    expect(mediaTerminationSnapshot(f.other)).toEqual(mediaTerminationSnapshot(f.db));
    expect(f.db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(run.id)).toEqual(history);
    expect(f.db.query("SELECT rowid,* FROM media_sources WHERE id=?").get(thought.mediaSource.id)).toEqual(source);
    expect(f.store.getThought(thought.id)).toEqual(thought);
    expect(f.db.query("SELECT * FROM agent_bindings WHERE run_id=?").all(run.id)).toEqual([]);
    expect(f.db.query("SELECT * FROM run_media_parts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM run_context WHERE run_id=?").all(run.id)).toEqual([]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test("repeated Stop across connections reuses the exact seal without refencing or touching another source", async () => mediaTerminationFixture(f => {
    const other = f.admissions.admit("user", mediaAdmissionInput(1));
    const untouched = terminationAttempt(f.db, other.run.id);
    f.runs.stop(f.admission.run.id);
    const first = expectStoppedMediaAttempt(f.db, f.admission), before = mediaTerminationSnapshot(f.db);

    f.runs.stop(f.admission.run.id);
    new SqliteRunRepository(f.other, f.sources).stop(f.admission.run.id);

    expect(mediaTerminationSnapshot(f.db)).toEqual(before);
    expect(terminationAttempt(f.other, f.admission.run.id).cleanup_identity_json).toBe(first.cleanup_identity_json);
    expect(terminationAttempt(f.db, other.run.id)).toEqual(untouched);
    expect(f.runs.get(other.run.id)).toEqual(other.run);
    expectNoMediaPublication(f.db, other);
  }));

  test("the pending seal and full original journal survive reopen and repeat migration without clearance", async () => mediaTerminationFixture(f => {
    f.runs.stop(f.admission.run.id);
    const first = expectStoppedMediaAttempt(f.db, f.admission), before = mediaTerminationSnapshot(f.db);
    const reopened = new Database(f.path);
    try {
      migrate(reopened, f.sources.logger);
      migrate(reopened, f.sources.logger);
      expect(mediaTerminationSnapshot(reopened)).toEqual(before);
      expect(expectStoppedMediaAttempt(reopened, f.admission).cleanup_identity_json).toBe(first.cleanup_identity_json);
      new SqliteRunRepository(reopened, f.sources).stop(f.admission.run.id);
      expect(mediaTerminationSnapshot(reopened)).toEqual(before);
      expect(new SqliteStore(reopened).getThought(f.admission.thought.id)).toEqual(f.admission.thought);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(reopened.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally { reopened.close(); }
  }));

  test("callbacks carrying the pre-Stop generation cannot prepare, advance, complete or publish late work", async () => mediaTerminationFixture(f => {
    expectUntouchedMediaAttempt(f);
    const { run } = f.admission;
    // A retained admission-generation token is not evidence that this queued attempt ever executed.
    const old: Claim = { runId: run.id, generation: run.generation };
    f.runs.stop(run.id);
    expect(f.runs.get(run.id)).toMatchObject({ status: "interrupted", generation: old.generation + 1 });
    const before = mediaTerminationSnapshot(f.db);
    const steps = new SqliteRunProtocolRepository(f.db, f.sources.logger);
    const operations = new SqliteRunOperations(f.db, f.sources);
    const callbacks: readonly { readonly name: string; readonly call: () => unknown }[] = [
      { name: "prepare", call: () => steps.prepare(old, { promptId: run.promptId, input: "late text-only preparation" }) },
      { name: "worker renderer", call: () => new SqliteRunWorkerState(f.db, f.sources).prepareInitial(old, () => {
        throw new Error("A fenced renderer must never be invoked");
      }) },
      { name: "native acknowledgement", call: () => f.runs.setStatus(old, "running", "running", run.promptId) },
      { name: "native completion", call: () => steps.completeStep(old, run.promptId, { version: 1, kind: "complete", reply: "late retained reply" }) },
      { name: "successor", call: () => steps.advance(old, run.promptId, null, { promptId: "late-media-successor", input: "late successor" }) },
      { name: "interpretation", call: () => operations.executeStep(old, run.promptId,
        { type: "interpretation", text: "late interpretation", sourceIds: [] }) },
      { name: "dispatch", call: () => new SqliteCapabilityDispatcher(f.db, f.sources).dispatch(old, run.promptId,
        { capability: "title-fill", arguments: { title: "late title" } }) },
      { name: "finalization", call: () => operations.completeWeave(old, run.promptId) },
      { name: "reclaim", call: () => f.runs.claim(run.id) },
    ];
    for (const callback of callbacks) {
      expect(callback.call).toThrow(RunFenceError);
      expect(mediaTerminationSnapshot(f.db)).toEqual(before);
      expect(f.db.inTransaction).toBe(false);
    }
    expectNoMediaPublication(f.db, f.admission);
  }));

  test("a committed queued-attempt seal cannot be rewritten or reopen its slot", async () => mediaTerminationFixture(f => {
    f.runs.stop(f.admission.run.id);
    expectStoppedMediaAttempt(f.db, f.admission);
    const before = mediaTerminationSnapshot(f.db), runId = f.admission.run.id;
    expect(() => f.db.run("UPDATE media_weave_attempts SET open_slot=1 WHERE run_id=?", [runId])).toThrow();
    expect(() => f.db.run("UPDATE media_weave_attempts SET failure_code='processing-failed' WHERE run_id=?", [runId])).toThrow();
    expect(() => f.db.run("UPDATE media_weave_attempts SET cleanup_identity_json='{}' WHERE run_id=?", [runId])).toThrow();
    expect(mediaTerminationSnapshot(f.db)).toEqual(before);
  }));

  const faults: readonly MediaStopFault[] = ["run fence", "complete fence and seal"];
  for (const phase of faults) test(`SQL failure after ${phase} rolls back every terminal write and permits a clean Stop`, async () => mediaTerminationFixture(f => {
    expectUntouchedMediaAttempt(f);
    const before = mediaTerminationSnapshot(f.db);
    const disarm = installMediaStopFault(f.db, f.admission.run.id, phase);
    try {
      // The trigger fires only after actual matching writes, not merely entry into the Stop method.
      expect(() => f.runs.stop(f.admission.run.id)).toThrow(`injected media Stop ${phase}`);
      expect(f.db.inTransaction).toBe(false);
      expect(mediaTerminationSnapshot(f.db)).toEqual(before);
      expect(mediaTerminationSnapshot(f.other)).toEqual(before);
      expectUntouchedMediaAttempt(f);
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { disarm(); }

    f.runs.stop(f.admission.run.id);
    expectStoppedMediaAttempt(f.db, f.admission);
    expectStoppedMediaAttempt(f.other, f.admission);
    expect(f.store.getThought(f.admission.thought.id)).toEqual(f.admission.thought);
  }));
});
