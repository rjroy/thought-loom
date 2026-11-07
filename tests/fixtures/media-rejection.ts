import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { RejectionService } from "../../src/domain/rejection";
import type { Claim, ContextRef } from "../../src/domain/run";
import type { Logger } from "../../src/logging";
import type { MediaSourceAdmission } from "../../src/storage/media-admission";
import { SqliteRejectionRepository } from "../../src/storage/rejection";
import { mediaAdmissionInput } from "./media-admission";
import type { MediaSubmissionFixture, PreparedMediaSubmission } from "./media-submission";
import { expectedQueuedMediaSeal, expectNoMediaPublication, terminationAttempt } from "./media-termination";
import { mediaNeighbor } from "./media-weave";

export function mediaRejection(db: Database, logger?: Logger): RejectionService {
  return new RejectionService(new SqliteRejectionRepository(db, logger));
}

export function expectImmediateMediaFence(db: Database, before: Claim): void {
  expect(db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(before.runId)).toEqual({
    status: "interrupted", generation: before.generation + 1, cancellation_state: "pending",
  });
  expect(db.inTransaction).toBe(false);
}

export function expectRejectedQueuedAttempt(db: Database, admission: MediaSourceAdmission): string {
  expectImmediateMediaFence(db, { runId: admission.run.id, generation: admission.run.generation });
  const attempt = terminationAttempt(db, admission.run.id);
  expect(attempt).toMatchObject({ source_id: admission.thought.mediaSource.id, position: 0, run_id: admission.run.id,
    open_slot: 0, interpretation_thought_id: null, failure_code: "context-unavailable", cleanup_state: "pending", retry_evidence_json: null });
  expect(attempt.cleanup_identity_json).not.toBeNull();
  if (attempt.cleanup_identity_json === null) throw new Error("Rejection must retain the queued attempt's cleanup seal");
  const seal: unknown = JSON.parse(attempt.cleanup_identity_json);
  expect(seal).toEqual(expectedQueuedMediaSeal(admission));
  expectNoMediaPublication(db, admission);
  return attempt.cleanup_identity_json;
}

const evidenceTables = ["media_store", "media_sources", "thoughts", "thought_titles", "thought_sources", "thought_source_seals",
  "connections", "connection_sources", "responses", "response_thoughts", "response_seals", "run_steps", "run_media_parts",
  "run_context", "run_operation_receipts", "run_issued_thoughts", "run_replies", "agent_bindings", "execution_owners"];

function tableRows(db: Database, tables: readonly string[]) {
  return tables.map(table => ({ table, rows: db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() }));
}

/** Immutable source metadata, exact input/parts/intent and knowledge, excluding the state that rejection must change. */
export function retainedMediaEvidence(db: Database) { return tableRows(db, evidenceTables); }

/** Include rejection markers and both search revisions so rollback cannot lose eligibility/index state either. */
export function mediaRejectionSnapshot(db: Database) {
  return [...retainedMediaEvidence(db), ...tableRows(db, ["runs", "media_weave_attempts", "rejected_thoughts",
    "rejected_connections", "search_revision", "search_revisions"])];
}

export type IndirectMediaExposure = "connection" | "response";

/** Legitimate scoped exposure, with no direct root reference and no invented full-read or binary witness. */
export function exposeIndirectMediaDependency(f: MediaSubmissionFixture, prepared: PreparedMediaSubmission, kind: IndirectMediaExposure) {
  const source = mediaAdmissionInput(55);
  f.store.saveMediaSource(source);
  let ref: ContextRef;
  if (kind === "connection") {
    f.store.saveConnection({ id: "media-rejection-indirect-connection", fromId: source.thought.id, toId: mediaNeighbor.id,
      category: "related", proposedBy: "ai", explanation: "Controlled incident connection", sourceIds: [] });
    ref = { kind: "connection", id: "media-rejection-indirect-connection" };
  } else {
    f.store.saveResponse({ id: "media-rejection-indirect-response", text: "Controlled jointly associated reply", role: "addendum",
      state: "complete", thoughtIds: [mediaNeighbor.id, source.thought.id] });
    ref = { kind: "response", id: "media-rejection-indirect-response" };
  }
  expect(f.runs.expose(prepared.claim, ref)).not.toBeNull();
  expect(f.runs.contextRefs(prepared.run.id)).toContainEqual(ref);
  expect(f.runs.contextRefs(prepared.run.id)).not.toContainEqual({ kind: "thought", id: source.thought.id });
  expect(prepared.prompt.media.parts.map(part => part.sourceId)).not.toContain(source.thought.mediaSource.id);
  return { source, ref };
}

/** Abort only when the real marker and complete target fence (including a mapped seal, if required) coexist inside SQL. */
export function installMediaRejectionFault(db: Database, before: Claim, thoughtId: string, mapped: boolean): () => void {
  db.exec(`CREATE TEMP TABLE fixture_media_rejection_target(run_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,
    thought_id TEXT NOT NULL,mapped INTEGER NOT NULL)`);
  db.run("INSERT INTO fixture_media_rejection_target(run_id,generation,thought_id,mapped) VALUES (?,?,?,?)",
    [before.runId, before.generation, thoughtId, mapped ? 1 : 0]);
  const complete = `EXISTS(SELECT 1 FROM fixture_media_rejection_target target
    JOIN main.rejected_thoughts marker ON marker.thought_id=target.thought_id JOIN main.runs run ON run.id=target.run_id
    WHERE run.status='interrupted' AND run.generation=target.generation+1 AND run.cancellation_state='pending'
      AND (target.mapped=0 OR EXISTS(SELECT 1 FROM main.media_weave_attempts attempt JOIN main.media_sources source ON source.id=attempt.source_id
        WHERE attempt.run_id=run.id AND source.source_thought_id=target.thought_id AND attempt.open_slot=0
          AND attempt.failure_code='context-unavailable' AND attempt.cleanup_state='pending' AND attempt.cleanup_identity_json IS NOT NULL
          AND attempt.retry_evidence_json IS NULL AND attempt.interpretation_thought_id IS NULL)))`;
  // Observe either write order, without a module mock or a production fault flag.
  db.exec(`CREATE TEMP TRIGGER fixture_media_rejection_marker_fault AFTER INSERT ON main.rejected_thoughts WHEN ${complete}
    BEGIN SELECT RAISE(ABORT,'injected complete media rejection fence'); END;
    CREATE TEMP TRIGGER fixture_media_rejection_run_fault AFTER UPDATE ON main.runs WHEN ${complete}
    BEGIN SELECT RAISE(ABORT,'injected complete media rejection fence'); END;
    CREATE TEMP TRIGGER fixture_media_rejection_attempt_fault AFTER UPDATE ON main.media_weave_attempts WHEN ${complete}
    BEGIN SELECT RAISE(ABORT,'injected complete media rejection fence'); END;`);
  return () => db.exec(`DROP TRIGGER temp.fixture_media_rejection_marker_fault;
    DROP TRIGGER temp.fixture_media_rejection_run_fault; DROP TRIGGER temp.fixture_media_rejection_attempt_fault;
    DROP TABLE temp.fixture_media_rejection_target;`);
}
