import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import type { MediaSourceAdmission } from "../../src/storage/media-admission";
import { readMediaSubmission } from "../../src/storage/media-submission";
import { SqliteRunRepository } from "../../src/storage/run";
import { mediaAdmissionFixture, mediaAdmissionInput, mediaAdmissionSnapshot } from "./media-admission";

type MediaAdmissionFixture = Parameters<Parameters<typeof mediaAdmissionFixture>[0]>[0];
export interface MediaTerminationFixture extends MediaAdmissionFixture {
  readonly admission: MediaSourceAdmission;
  readonly runs: SqliteRunRepository;
}

export async function mediaTerminationFixture(action: (fixture: MediaTerminationFixture) => void | Promise<void>): Promise<void> {
  await mediaAdmissionFixture(async base => {
    const admission = base.admissions.admit("user", mediaAdmissionInput());
    await action({ ...base, admission, runs: new SqliteRunRepository(base.db, base.sources) });
  });
}

export interface MediaTerminationAttempt {
  readonly source_id: string;
  readonly position: number;
  readonly run_id: string;
  readonly request_key: string;
  readonly open_slot: number;
  readonly interpretation_thought_id: string | null;
  readonly failure_code: string | null;
  readonly cleanup_state: string;
  readonly cleanup_identity_json: string | null;
  readonly retry_evidence_json: string | null;
}

export function terminationAttempt(db: Database, runId: string): MediaTerminationAttempt {
  const row = db.query<MediaTerminationAttempt, [string]>(`SELECT source_id,position,run_id,request_key,open_slot,
    interpretation_thought_id,failure_code,cleanup_state,cleanup_identity_json,retry_evidence_json
    FROM media_weave_attempts WHERE run_id=?`).get(runId);
  expect(row).not.toBeNull();
  if (row === null) throw new Error("Expected a genuinely admitted media attempt");
  return row;
}

export function expectUntouchedMediaAttempt(f: MediaTerminationFixture): void {
  const { db, admission } = f, { run, thought } = admission;
  expect(f.runs.get(run.id)).toEqual(run);
  expect(run).toMatchObject({ status: "queued", generation: 0, nativeState: "unknown" });
  expect(db.query(`SELECT position,prompt_id,input,state,native_state,envelope_json,result_json,
    media_submit_owner_id,media_submit_generation FROM run_steps WHERE run_id=? ORDER BY position`).all(run.id)).toEqual([
    { position: 0, prompt_id: run.promptId, input: null, state: "prepared", native_state: "unknown",
      envelope_json: null, result_json: null, media_submit_owner_id: null, media_submit_generation: null },
  ]);
  expect(db.query("SELECT * FROM agent_bindings WHERE run_id=?").all(run.id)).toEqual([]);
  expect(db.query("SELECT * FROM run_media_parts WHERE prompt_id=?").all(run.promptId)).toEqual([]);
  expect(readMediaSubmission(db, run.promptId)).toBeNull();
  expect(terminationAttempt(db, run.id)).toMatchObject({ source_id: thought.mediaSource.id, position: 0, run_id: run.id,
    open_slot: 1, interpretation_thought_id: null, failure_code: null, cleanup_state: "none",
    cleanup_identity_json: null, retry_evidence_json: null });
  expectNoMediaPublication(db, admission);
}

export function expectNoMediaPublication(db: Database, admission: MediaSourceAdmission): void {
  expect(db.query("SELECT id FROM thoughts WHERE parent_id=?").all(admission.thought.id)).toEqual([]);
  for (const table of ["run_operation_receipts", "run_issued_thoughts", "run_replies"]) {
    expect(db.query(`SELECT * FROM ${table} WHERE run_id=?`).all(admission.run.id)).toEqual([]);
  }
  expect(terminationAttempt(db, admission.run.id).interpretation_thought_id).toBeNull();
}

/** Design's source/run identity, not the root Thought ID or the pre-Stop execution generation. */
export function expectedQueuedMediaSeal(admission: MediaSourceAdmission) {
  return { version: 1, sourceId: admission.thought.mediaSource.id, runId: admission.run.id,
    fencedGeneration: admission.run.generation + 1, binding: null,
    steps: [{ position: 0, promptId: admission.run.promptId, inputSha256: null, parts: [], authorization: "never-authorized" }] };
}

export function expectStoppedMediaAttempt(db: Database, admission: MediaSourceAdmission): MediaTerminationAttempt {
  const attempt = terminationAttempt(db, admission.run.id);
  expect(attempt).toMatchObject({ source_id: admission.thought.mediaSource.id, position: 0, run_id: admission.run.id,
    open_slot: 0, interpretation_thought_id: null, failure_code: "interrupted", cleanup_state: "pending", retry_evidence_json: null });
  expect(attempt.cleanup_identity_json).not.toBeNull();
  if (attempt.cleanup_identity_json === null) throw new Error("Stop must retain its pending cleanup identity");
  const seal: unknown = JSON.parse(attempt.cleanup_identity_json);
  // Exact closed version-one shape; null hash and empty parts describe the actual never-prepared step, not cleared native work.
  expect(seal).toEqual(expectedQueuedMediaSeal(admission));
  expect(db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(admission.run.id)).toEqual({
    status: "interrupted", generation: admission.run.generation + 1, cancellation_state: "pending",
  });
  expectNoMediaPublication(db, admission);
  return attempt;
}

export function mediaTerminationSnapshot(db: Database) {
  return [...mediaAdmissionSnapshot(db), { table: "run_media_parts", rows: db.query("SELECT rowid,* FROM run_media_parts ORDER BY rowid").all() }];
}

export type MediaStopFault = "run fence" | "complete fence and seal";

/** Test-owned real SQLite triggers observe the writes; the complete fault works with either legitimate write order. */
export function installMediaStopFault(db: Database, runId: string, phase: MediaStopFault): () => void {
  db.exec("CREATE TEMP TABLE fixture_media_stop_target(run_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)");
  const run = db.query<{ generation: number }, [string]>("SELECT generation FROM runs WHERE id=?").get(runId);
  if (run === null) throw new Error("Expected the admitted run before arming its SQL fault");
  db.run("INSERT INTO fixture_media_stop_target(run_id,generation) VALUES (?,?)", [runId, run.generation]);
  const fenced = `EXISTS(SELECT 1 FROM main.runs run JOIN fixture_media_stop_target target ON target.run_id=run.id
    WHERE run.status='interrupted' AND run.generation=target.generation+1 AND run.cancellation_state='pending')`;
  const complete = `${fenced} AND EXISTS(SELECT 1 FROM main.media_weave_attempts attempt
    JOIN fixture_media_stop_target target ON target.run_id=attempt.run_id
    WHERE attempt.open_slot=0 AND attempt.failure_code='interrupted' AND attempt.cleanup_state='pending'
      AND attempt.cleanup_identity_json IS NOT NULL AND attempt.interpretation_thought_id IS NULL AND attempt.retry_evidence_json IS NULL)`;
  const condition = phase === "run fence" ? fenced : complete;
  db.exec(`CREATE TEMP TRIGGER fixture_media_stop_run_fault AFTER UPDATE ON main.runs
    WHEN NEW.id=(SELECT run_id FROM fixture_media_stop_target) AND ${condition}
    BEGIN SELECT RAISE(ABORT,'injected media Stop ${phase}'); END;`);
  if (phase === "complete fence and seal") db.exec(`CREATE TEMP TRIGGER fixture_media_stop_attempt_fault AFTER UPDATE ON main.media_weave_attempts
    WHEN NEW.run_id=(SELECT run_id FROM fixture_media_stop_target) AND ${condition}
    BEGIN SELECT RAISE(ABORT,'injected media Stop ${phase}'); END;`);
  return () => db.exec(`DROP TRIGGER temp.fixture_media_stop_run_fault;
    ${phase === "complete fence and seal" ? "DROP TRIGGER temp.fixture_media_stop_attempt_fault;" : ""}
    DROP TABLE temp.fixture_media_stop_target;`);
}
