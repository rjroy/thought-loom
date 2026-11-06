import type { Database } from "bun:sqlite";
import { RunConflictError, type RunRecord } from "../domain/run";
import type { RunStep } from "../domain/run-protocol";
import { protocolJson } from "../domain/run-protocol";
import { searchRecordTime } from "../domain/agentic-search";
import { readSearchClientClockObservation, readSearchClockContext, readSearchClockSample, selectSearchClockContext, type SearchClockContext,
  type SearchClockDependencies, type SearchClockOwner, type SearchClockSample } from "../domain/search-time";
import { record } from "../domain/validation";
import { requireSearchExecutionOwner } from "./search-run-authority";

interface ClockOwner { readonly owner: SearchClockOwner; readonly anchor: SearchClockSample }
interface ClockState {
  readonly owner: SearchClockOwner;
  readonly currentPromptId: string;
  readonly context: SearchClockContext;
  readonly elapsedAtBaseMs: number;
  readonly monotonicBase: number;
  readonly lastBoundaryWall: number;
  readonly lastMonotonic: number;
}
export interface PreparedSearchClock {
  readonly context: SearchClockContext | null;
  /** Cache only after SQL persistence succeeds. A later SQL/current-prompt mismatch also discards it. */
  readonly committed: () => void;
}

function clockOwner(db: Database, run: RunRecord): ClockOwner {
  requireSearchExecutionOwner(db,run);
  const row = db.query("SELECT session_id AS sessionId,intent_json AS intentJson,admitted_at AS admittedAt FROM search_turns WHERE run_id=?")
    .get(run.id) as { sessionId: string; intentJson: string; admittedAt: string } | null;
  if (!row) throw new RunConflictError("Retained search clock owner is unavailable");
  const intent = record(JSON.parse(row.intentJson));
  if (intent.version !== 1 || intent.daemonObservedAt !== row.admittedAt) throw new RunConflictError("Retained search clock anchor differs");
  return { owner: Object.freeze({ runId: run.id, generation: run.generation, searchSessionId: row.sessionId, nativeSessionId: run.sessionId }),
    anchor: readSearchClockSample({ clock: intent.requestClock, daemonObservedAt: row.admittedAt }) };
}
function ownedContext(input: unknown, anchor: SearchClockSample): SearchClockContext {
  const context = readSearchClockContext(input);
  if (protocolJson(context.requestAnchor) !== protocolJson(anchor)) throw new RunConflictError("Prepared search clock anchor differs");
  return context;
}

/** Processed replay validates stored clock bytes, but never samples a wall/monotonic clock or observation provider. */
export function retainedSearchSuccessorClock(db: Database, run: RunRecord, step: RunStep): SearchClockContext | undefined {
  if (step.input === null) throw new RunConflictError("Prepared search successor is unavailable");
  const input = record(JSON.parse(step.input));
  return Object.hasOwn(input,"clockContext") ? ownedContext(input.clockContext,clockOwner(db,run).anchor) : undefined;
}

/** Only known clock paths are extracted. This cold read never loads retained prompt/query/native prose. */
function mostRecentClock(db: Database, runId: string, through: number, anchor: SearchClockSample): SearchClockContext {
  const path = "CASE WHEN position=0 THEN '$.context.job.clockContext' ELSE '$.clockContext' END";
  const row = db.query(`SELECT json_extract(input,${path}) AS clockJson FROM run_steps
    WHERE run_id=? AND position<=? AND input IS NOT NULL AND json_valid(input)
      AND CASE WHEN json_valid(input) THEN json_type(input,${path}) END IS NOT NULL ORDER BY position DESC LIMIT 1`)
    .get(runId,through) as { clockJson: string } | null;
  if (!row) throw new RunConflictError("Retained search clock attachment is unavailable");
  return ownedContext(JSON.parse(row.clockJson),anchor);
}

/** One preparation policy, no scheduler or native engine. Cache contains only bounded clock/ownership metadata. */
export class SqliteSearchPromptClock {
  private readonly states = new Map<string,ClockState>();
  private readonly monotonicNow: () => number;
  constructor(private readonly db: Database, private readonly now: () => string, private readonly dependencies: SearchClockDependencies = {}) {
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }
  forget(runId: string): void { this.states.delete(runId); }
  clear(): void { this.states.clear(); }
  private remember(runId: string, state: ClockState): void {
    this.states.delete(runId);
    this.states.set(runId,state);
    // Eviction changes only the elapsed-time source to retained daemon timestamps, never prompt identity or SQL state.
    if (this.states.size > 128) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
  }
  private latest(owner: SearchClockOwner): SearchClockSample | null {
    if (!this.dependencies.latestObservation) return null;
    try {
      const observation = this.dependencies.latestObservation(owner);
      if (observation === null) return null;
      const data = readSearchClientClockObservation(observation);
      if (data.searchSessionId !== owner.searchSessionId) throw new RunConflictError();
      // The trusted receipt store owns arrival order; daemon wall time can move backwards and is not a sequence ID.
      return { clock: data.clock, daemonObservedAt: data.daemonObservedAt };
    } catch { throw new RunConflictError("Invalid search clock observation"); }
  }
  /** Called only for a new, normal initial/successor input inside its existing claim/context transaction. */
  prepare(run: RunRecord, current: RunStep, nextPromptId: string): PreparedSearchClock {
    const { owner, anchor } = clockOwner(this.db,run);
    const daemonNow = searchRecordTime(this.now()), wall = Date.parse(daemonNow), monotonic = this.monotonicNow();
    if (!Number.isFinite(monotonic) || monotonic < 0) throw new RunConflictError("Invalid search monotonic clock");
    const fresh = current.position === 0 && current.input === null;
    let previous = this.states.get(run.id);
    if (previous && (previous.owner.generation !== owner.generation || previous.owner.nativeSessionId !== owner.nativeSessionId ||
      previous.owner.searchSessionId !== owner.searchSessionId || previous.currentPromptId !== current.promptId)) previous = undefined;
    if (!fresh && !previous) {
      const context = mostRecentClock(this.db,run.id,current.position,anchor), attachedWall = Date.parse(context.observedNow.daemonNow);
      previous = { owner, currentPromptId: current.promptId, context, elapsedAtBaseMs: Math.max(0,wall-attachedWall),
        monotonicBase: monotonic, lastMonotonic: monotonic, lastBoundaryWall: attachedWall };
    }
    const retained = previous ? { clock: previous.context.observedNow.clock, daemonObservedAt: previous.context.observedNow.daemonObservedAt } : anchor;
    const backwards = previous !== undefined && (wall < previous.lastBoundaryWall || monotonic < previous.lastMonotonic);
    const elapsed = previous ? previous.elapsedAtBaseMs + Math.max(0,monotonic-previous.monotonicBase) : null;
    const selected = selectSearchClockContext({ boundary: "model-input", freshNative: fresh, preparedInput: null, requestAnchor: anchor,
      latestSample: this.latest(owner), retainedSample: retained, daemonNow, elapsedSinceLastMs: elapsed, backwardClockDiscontinuity: backwards });
    if (selected.kind === "reuse") throw new RunConflictError("A new search input must not replace prepared bytes");
    const attached = selected.kind === "attach" ? selected.context : null;
    const context = attached ?? previous?.context;
    if (!context) throw new RunConflictError("Initial search clock attachment required");
    const state: ClockState = { owner, currentPromptId: nextPromptId, context,
      elapsedAtBaseMs: attached ? 0 : previous?.elapsedAtBaseMs ?? 0, monotonicBase: attached ? monotonic : previous?.monotonicBase ?? monotonic,
      lastBoundaryWall: wall, lastMonotonic: monotonic };
    return { context: attached, committed: () => this.remember(run.id,state) };
  }
}
