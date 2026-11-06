import type { Database } from "bun:sqlite";
import { searchRecordTime, validateSearchRequestClock } from "../domain/agentic-search";
import { RunConflictError, type ContextRef } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import type { SearchActiveDiscovery, SearchCapabilityResult } from "../domain/search-capability";
import { searchCapabilityFields } from "../domain/search-capability";
import { normalizeSearchTimeRange, type SearchClockSample, type SearchTimeRangeRequest } from "../domain/search-time";
import { searchString } from "../domain/search-session-guards";
import { record } from "../domain/validation";
import { mergeSearchReferences, searchContentEligibilitySql, searchEligibilitySql, searchEvidence } from "./search-eligibility";
import { readSearchConversationPage, readSearchDiscoveries, retainedSearchDependencies, type SearchOfferedContent } from "./search-workspace-content";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** No model-selected session, raw history or user composer authority enters this private context adapter. */
export function readSearchAgentDiscoveries(db: Database, sessionId: string, after: number | null, limit: number): SearchCapabilityResult {
  const page = readSearchDiscoveries(db,sessionId,after ?? -1,Number.MAX_SAFE_INTEGER,limit,true);
  const items = page.value.items.map((item): SearchActiveDiscovery => {
    if (!item.thought || item.availability !== "available") throw new RunConflictError("Search discovery target is unavailable");
    return { ...item, thought: item.thought, availability: "available" };
  });
  return { type: "discoveries", items, nextAfterPosition: page.value.hasMore ? items.at(-1)?.position ?? null : null };
}
export function readSearchAgentConversation(db: Database, sessionId: string, before: number | null, limit: number): SearchCapabilityResult {
  const page = readSearchConversationPage(db,sessionId,before,limit);
  return { type: "search-conversation", ...page.value };
}

/** Identity/clock metadata only: never select the old user prose just to resolve an interpretation anchor. */
function timeAnchor(db: Database, sessionId: string, position: number): SearchOfferedContent<SearchClockSample> {
  const row = db.query(`SELECT t.intent_json AS intentJson,t.admitted_at AS admittedAt,u.id AS messageId,u.evidence_json AS evidenceJson
    FROM search_turns t JOIN search_messages u ON u.run_id=t.run_id AND u.session_id=t.session_id AND u.role='user'
    WHERE t.session_id=CAST(? AS TEXT) AND t.position=? AND ${searchContentEligibilitySql("message_id","u.id","u.evidence_json")}`)
    .get(text(sessionId),position) as { intentJson: string; admittedAt: string; messageId: string; evidenceJson: string } | null;
  if (!row) throw new RunConflictError("Eligible same-session user intent is unavailable");
  const intent = record(JSON.parse(row.intentJson));
  if (intent.version !== 1 || intent.daemonObservedAt !== row.admittedAt) throw new RunConflictError("Retained search clock anchor differs");
  const retained = searchCapabilityFields(intent.requestClock,["at","timeZone"]);
  const clock = { at: searchString(retained.at,"client time"), timeZone: searchString(retained.timeZone,"time zone") };
  validateSearchRequestClock(clock);
  return { value: { clock, daemonObservedAt: searchRecordTime(row.admittedAt) },
    dependencies: mergeSearchReferences(retainedSearchDependencies(db,sessionId,"message_id",[row.messageId]),
      searchEvidence(row.evidenceJson).map(id => ({kind:"thought",id}))) };
}
export function readSearchTimeRange(db: Database, sessionId: string, request: SearchTimeRangeRequest): SearchCapabilityResult {
  return { type: "time-range", range: normalizeSearchTimeRange(request,timeAnchor(db,sessionId,request.intentTurnPosition).value) };
}

/** Replay reads only retained identity/dependency/eligibility metadata, never reruns a prose projection or a capability. */
export function searchContextResultReferences(db: Database, runId: string, result: SearchCapabilityResult): readonly ContextRef[] {
  if (result.type !== "search-conversation" && result.type !== "discoveries" && result.type !== "time-range") return [];
  const owner = db.query("SELECT session_id AS sessionId FROM search_turns WHERE run_id=?").get(runId) as { sessionId: string } | null;
  if (!owner) throw new RunConflictError("Search result has no owning session");
  const sessionId = owner.sessionId;
  if (result.type === "time-range") {
    const anchor = timeAnchor(db,sessionId,result.range.intentTurnPosition);
    if (protocolJson(anchor.value) !== protocolJson(result.range.requestAnchor)) throw new RunConflictError("Search clock anchor differs");
    return anchor.dependencies;
  }
  if (result.type === "search-conversation") {
    for (const item of result.messages) {
      const row = db.query(`SELECT m.run_id AS runId,m.position,m.role,t.position AS intentTurnPosition FROM search_messages m
        JOIN search_turns t ON t.run_id=m.run_id AND t.session_id=m.session_id WHERE m.session_id=CAST(? AS TEXT) AND m.id=CAST(? AS TEXT)
          AND ${searchContentEligibilitySql("message_id","m.id","m.evidence_json")}`).get(text(sessionId),text(item.id)) as
        { runId: string; position: number; role: string; intentTurnPosition: number } | null;
      if (!row || row.runId !== item.runId || row.position !== item.position || row.role !== item.role || row.intentTurnPosition !== item.intentTurnPosition) {
        throw new RunConflictError("Retained search conversation is unavailable");
      }
    }
    return retainedSearchDependencies(db,sessionId,"message_id",result.messages.map(item => item.id));
  }
  for (const item of result.items) {
    const row = db.query(`SELECT d.position,d.thought_id AS thoughtId,${searchContentEligibilitySql("discovery_id","d.id","d.evidence_json")} AS reasonAvailable
      FROM search_discoveries d WHERE d.session_id=CAST(? AS TEXT) AND d.id=CAST(? AS TEXT) AND d.removed_at IS NULL
        AND ${searchEligibilitySql("'thought'","d.thought_id")}`).get(text(sessionId),text(item.id)) as
      { position: number; thoughtId: string; reasonAvailable: number } | null;
    if (!row || row.position !== item.position || row.thoughtId !== item.thought.id || (item.why !== null && row.reasonAvailable !== 1)) {
      // Removal changes membership, not the claim generation. Fail closed instead of retrying an unusable cached page forever.
      throw new RunConflictError("Retained search discovery is unavailable");
    }
  }
  return retainedSearchDependencies(db,sessionId,"discovery_id",result.items.filter(item => item.why !== null).map(item => item.id));
}
