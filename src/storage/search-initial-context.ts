import type { Database } from "bun:sqlite";
import type { InitialRunContext } from "../domain/run-context";
import { RunConflictError, RunFenceError, type ContextRef, type RunRecord } from "../domain/run";
import { searchRecordTime, searchTurnRequest, validateSearchRequestClock } from "../domain/agentic-search";
import type { SearchClockContext } from "../domain/search-time";
import { protocolJson } from "../domain/run-protocol";
import { oneOf, record } from "../domain/validation";
import { requireSearchExecutionOwner } from "./search-run-authority";
import { mergeSearchReferences, searchReferencesEligible } from "./search-eligibility";
import { readSearchMessage, readSearchRecentMessages } from "./search-workspace-content";

interface SearchTurnInput {
  readonly sessionId: string; readonly position: number; readonly messageId: string; readonly messagePosition: number;
  readonly text: string; readonly effort: string; readonly contextMode: string; readonly intentJson: string; readonly admittedAt: string;
}
export function searchRunEffort(db: Database, runId: string): "quick" | "standard" | "thorough" | null {
  const row = db.query("SELECT t.effort FROM search_turns t JOIN runs r ON r.id=t.run_id WHERE r.id=? AND r.kind='search'")
    .get(runId) as { effort: string } | null;
  return row ? oneOf(row.effort,"search effort",["quick","standard","thorough"]) : null;
}

/** Synchronous preparation under the aggregate's immediate claim/context transaction. */
export function initialSearchContext(db: Database, run: RunRecord, clockContext: SearchClockContext): { readonly context: InitialRunContext; readonly dependencies: readonly ContextRef[] } {
  requireSearchExecutionOwner(db,run);
  const row = db.query(`SELECT t.session_id AS sessionId,t.position,u.id AS messageId,u.position AS messagePosition,u.text,t.effort,
    t.context_mode AS contextMode,t.intent_json AS intentJson,t.admitted_at AS admittedAt
    FROM search_turns t JOIN search_messages u ON u.run_id=t.run_id AND u.session_id=t.session_id AND u.role='user' WHERE t.run_id=?`)
    .get(run.id) as SearchTurnInput | null;
  if (!row) throw new RunConflictError("Retained search turn input is unavailable");
  const intent = record(JSON.parse(row.intentJson));
  if (intent.version !== 1 || intent.daemonObservedAt !== row.admittedAt || intent.contextMode !== row.contextMode) throw new RunConflictError("Retained search turn intent differs");
  const request = searchTurnRequest({ text: row.text, startingThoughtIds: intent.startingThoughtIds, requestClock: intent.requestClock,
    contextMode: intent.contextMode, composerId: intent.composerId, contextToken: intent.contextToken, effort: row.effort });
  validateSearchRequestClock(request.requestClock);
  const anchor = { clock: request.requestClock, daemonObservedAt: searchRecordTime(row.admittedAt) };
  if (protocolJson(clockContext.requestAnchor) !== protocolJson(anchor)) throw new RunConflictError("Initial search clock anchor differs");
  const current = readSearchMessage(db,row.sessionId,row.messageId);
  if (current.value.message.availability !== "available") throw new RunFenceError("Current search message context is unavailable");
  // A bounded model window does not limit the composer coverage already inherited by this run at admission.
  const conversation = request.contextMode === "restart"
    ? { value: { messages: [current.value.message], earlierMessagesOmitted: false }, dependencies: current.dependencies }
    : readSearchRecentMessages(db,row.sessionId,row.messagePosition,50);
  const dependencies = mergeSearchReferences(conversation.dependencies,current.dependencies,
    request.startingThoughtIds.map(id => ({ kind: "thought", id })));
  if (!searchReferencesEligible(db,dependencies)) throw new RunFenceError("Search initial sources are unavailable");
  return { context: { job: { kind: "search", searchSessionId: row.sessionId, turnPosition: row.position,
    effort: request.effort, contextMode: request.contextMode, request: { messageId: row.messageId, text: request.text, startingThoughtIds: request.startingThoughtIds },
    conversation: conversation.value, clockContext }, thoughts: [], connections: [], responses: [] }, dependencies };
}
