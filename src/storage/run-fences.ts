import type { Database } from "bun:sqlite";
import type { RejectionService } from "../domain/rejection";
import { requireOrdinaryRun, RunConflictError, RunNotFoundError, type ContextRef, type ContextValue, type RunRecord } from "../domain/run";
import type { Thought } from "../domain/thought";
import type { Connection } from "../domain/connection";
import { createSharedResponse, type SharedResponse } from "../domain/shared-response";
import { record } from "../domain/validation";
import type { Logger } from "../logging";
import { SqliteSharedResponses } from "./shared-response";

export type RunVisibility = (ref: ContextRef) => ContextValue | null;

export function issuedRunThoughts(db: Database, runId: string): readonly string[] {
  return db.query<{ id: string }, [string]>("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position")
    .all(runId).map(row => row.id);
}

export function runAssociations(db: Database, run: RunRecord): Pick<SharedResponse, "role" | "thoughtIds"> | null {
  const thoughtIds = issuedRunThoughts(db,run.id);
  if (thoughtIds.length) return { role: "addendum", thoughtIds };
  return run.kind === "evolve" && run.inputThoughtId !== null ? { role: "fallback", thoughtIds: [run.inputThoughtId] } : null;
}

/** Scoped values cached for one synchronous transaction, never across rejection/restoration. */
export function scopedRunVisibility(service: RejectionService): RunVisibility {
  const scope = { actor: "ai", mode: "normal" } as const;
  let thoughts: ReadonlyMap<string, Thought> | undefined;
  let connections: ReadonlyMap<string, Connection> | undefined;
  const responses = new Map<string, SharedResponse | null>();
  return ref => {
    if (ref.kind === "thought") {
      thoughts ??= new Map(service.listThoughts(scope).map(item => [item.id,item]));
      return thoughts.get(ref.id) ?? null;
    }
    if (ref.kind === "connection") {
      connections ??= new Map(service.listConnections(scope).map(item => [item.id,item]));
      return connections.get(ref.id) ?? null;
    }
    if (ref.kind !== "response") throw new RunConflictError();
    if (!responses.has(ref.id)) responses.set(ref.id,service.getResponse(scope,ref.id));
    return responses.get(ref.id) ?? null;
  };
}

/** The same subject/input/issued/context eligibility at ordinary execution and eager media rejection boundaries. */
export function ordinaryRunContextValid(db: Database, run: RunRecord, visible: RunVisibility): boolean {
  const intent = db.query<{ subjectId: string | null; triggerId: string | null }, [string]>(
    "SELECT weave_subject_id AS subjectId,weave_trigger_id AS triggerId FROM runs WHERE id=?").get(run.id);
  const subject = intent !== null && intent.subjectId !== null && intent.triggerId !== null ? intent.subjectId : undefined;
  const ids = [...issuedRunThoughts(db,run.id), ...(run.inputThoughtId === null ? [] : [run.inputThoughtId]), ...(subject === undefined ? [] : [subject])];
  const refs = db.query<ContextRef, [string]>("SELECT kind,ref_id AS id FROM run_context WHERE run_id=? ORDER BY rowid").all(run.id);
  return ids.every(id => visible({ kind: "thought", id }) !== null) && refs.every(ref => visible(ref) !== null);
}

/** Canonical ordinary finalInterrupt body, shared with rejection without a repository/aggregate import cycle.
 * Caller owns the existing immediate transaction. Native cancellation/drain remains the worker's later responsibility.
 */
export function interruptOrdinaryRun(db: Database, run: RunRecord, _reason: "stopped" | "context-invalidated" | "failed", logger: Logger): void {
  if (!db.inTransaction) throw new RunConflictError("Run interruption requires its owning transaction");
  requireOrdinaryRun(run);
  const row = db.query<{ draft: string | null; responseId: string | null }, [string]>(
    "SELECT draft_json AS draft,response_id AS responseId FROM run_replies WHERE run_id=?").get(run.id);
  const associations = runAssociations(db,run);
  let mediaWeave = false;
  if (run.kind === "weave") {
    const subject = db.query<{ subjectId: string | null; triggerId: string | null; kind: string | null }, [string]>(
      `SELECT run.weave_subject_id AS subjectId,run.weave_trigger_id AS triggerId,thought.kind
       FROM runs run LEFT JOIN thoughts thought ON thought.id=run.weave_subject_id WHERE run.id=?`).get(run.id);
    if (subject && subject.subjectId !== null && subject.triggerId !== null) {
      if (subject.kind === null) throw new RunNotFoundError();
      mediaWeave = subject.kind === "media-original";
    }
  }
  // Source-root replies are finalized by the Weaver; interruption never publishes a draft summary.
  if (!mediaWeave && row?.draft && !row.responseId && associations) {
    const response = createSharedResponse({ ...record(JSON.parse(row.draft)), ...associations, state: "interrupted" });
    new SqliteSharedResponses(db,logger).save(response);
    db.run("UPDATE run_replies SET draft_json=NULL,response_id=? WHERE run_id=?",[response.id,run.id]);
  }
  db.run("UPDATE runs SET status='interrupted',generation=generation+1,cancellation_state='pending' WHERE id=?",[run.id]);
}
