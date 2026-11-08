import type { Database } from "bun:sqlite";
import type { ContextRef } from "../domain/run";
import type { SearchConversationMessage } from "../domain/search-capability";
import { displayTitle, type Thought } from "../domain/thought";
import { SearchNotFoundError, type SearchDiscoveryView, type SearchMessageView, type SearchThoughtSummary } from "../domain/agentic-search";
import { mergeSearchReferences, searchContentEligibilitySql, searchEligibilitySql, searchEvidence } from "./search-eligibility";
import { requiredMediaSource, storedMediaSources, storedThought } from "./media-source";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
export interface SearchOfferedContent<T> { readonly value: T; readonly dependencies: readonly ContextRef[] }
interface ContentPage<T> { readonly items: readonly T[]; readonly hasMore: boolean }
interface MessageRow extends Omit<SearchMessageView, "availability" | "evidenceThoughtIds"> { readonly evidenceJson: string; readonly available: number }
interface DiscoveryRow {
  readonly id: string; readonly position: number; readonly addedAt: string; readonly why: string; readonly evidenceJson: string;
  readonly available: number; readonly targetAvailable: number; readonly thoughtId: string; readonly text: string | null; readonly title: string | null;
  readonly titleAuthor: SearchThoughtSummary["titleAuthor"]; readonly author: SearchThoughtSummary["author"];
  readonly kind: SearchThoughtSummary["kind"]; readonly createdAt: string;
}
const messageSelect = `SELECT m.id,m.run_id AS runId,m.position,m.role,m.text,m.created_at AS createdAt,m.disposition,
  m.evidence_json AS evidenceJson,${searchContentEligibilitySql("message_id", "m.id", "m.evidence_json")} AS available FROM search_messages m`;

export function retainedSearchDependencies(db: Database, sessionId: string, owner: "message_id" | "discovery_id", ids: readonly string[]): readonly ContextRef[] {
  if (!ids.length) return [];
  return db.query(`SELECT ref_kind AS kind,ref_id AS id FROM search_content_dependencies
    WHERE session_id=CAST(? AS TEXT) AND ${owner} IN (SELECT value FROM json_each(CAST(? AS TEXT)))`)
    .all(text(sessionId), text(JSON.stringify(ids))) as ContextRef[];
}
function projectMessages(db: Database, sessionId: string, rows: readonly MessageRow[]): SearchOfferedContent<readonly SearchMessageView[]> {
  const exposed: ContextRef[] = [];
  const items = rows.map(({ available, evidenceJson, ...message }) => {
    const evidence = available === 1 ? searchEvidence(evidenceJson) : Object.freeze([]);
    for (const id of evidence) exposed.push({ kind: "thought", id });
    return Object.freeze({ ...message, text: available === 1 ? message.text : null, evidenceThoughtIds: evidence,
      availability: available === 1 ? "available" : "context-unavailable" } satisfies SearchMessageView);
  });
  return { value: Object.freeze(items), dependencies: mergeSearchReferences(exposed,
    retainedSearchDependencies(db, sessionId, "message_id", rows.filter(row => row.available === 1).map(row => row.id))) };
}
export function readSearchMessage(db: Database, sessionId: string, messageId: string): SearchOfferedContent<{ readonly message: SearchMessageView }> {
  const row = db.query(`${messageSelect} WHERE m.session_id=CAST(? AS TEXT) AND m.id=CAST(? AS TEXT)`)
    .get(text(sessionId), text(messageId)) as MessageRow | null;
  if (!row) throw new SearchNotFoundError("search-message-not-found");
  const projected = projectMessages(db, sessionId, [row]), message = projected.value[0];
  if (!message) throw new SearchNotFoundError("search-message-not-found");
  return { value: { message }, dependencies: projected.dependencies };
}
export function readSearchMessages(db: Database, sessionId: string, after: number, highWater: number, limit: number): SearchOfferedContent<ContentPage<SearchMessageView>> {
  const rows = db.query(`${messageSelect} WHERE m.session_id=CAST(? AS TEXT) AND m.position>? AND m.position<=? ORDER BY m.position LIMIT ?`)
    .all(text(sessionId), after, highWater, limit + 1) as MessageRow[];
  const offered = projectMessages(db, sessionId, rows.slice(0, limit));
  return { value: { items: offered.value, hasMore: rows.length > limit }, dependencies: offered.dependencies };
}
/** Model preparation reads a bounded safe window from SQL, never native history or the user-history projection. */
export function readSearchRecentMessages(db: Database, sessionId: string, throughPosition: number, limit: number):
  SearchOfferedContent<{ readonly messages: readonly SearchMessageView[]; readonly earlierMessagesOmitted: boolean }> {
  const rows = db.query(`${messageSelect} WHERE m.session_id=CAST(? AS TEXT) AND m.position<=? ORDER BY m.position DESC LIMIT ?`)
    .all(text(sessionId), throughPosition, limit + 1) as MessageRow[];
  const projected = projectMessages(db,sessionId,rows.slice(0,limit).reverse());
  return { value: { messages: projected.value, earlierMessagesOmitted: rows.length > limit }, dependencies: projected.dependencies };
}
/** Private agent paging excludes unsafe messages, not just their text. Positions remain original message positions. */
export function readSearchConversationPage(db: Database, sessionId: string, beforePosition: number | null, limit: number):
  SearchOfferedContent<{ readonly messages: readonly SearchConversationMessage[]; readonly nextBeforePosition: number | null }> {
  const rows = db.query(`SELECT page.*,t.position AS intentTurnPosition FROM (${messageSelect}
    WHERE m.session_id=CAST(? AS TEXT) AND (? IS NULL OR m.position<?)
      AND ${searchContentEligibilitySql("message_id","m.id","m.evidence_json")} ORDER BY m.position DESC LIMIT ?) page
    JOIN search_turns t ON t.run_id=page.runId AND t.session_id=CAST(? AS TEXT) ORDER BY page.position DESC`)
    .all(text(sessionId),beforePosition,beforePosition,limit+1,text(sessionId)) as (MessageRow & { intentTurnPosition: number })[];
  const selected = rows.slice(0,limit), offered = projectMessages(db,sessionId,selected);
  const messages = offered.value.map((message,index): SearchConversationMessage => {
    const row = selected[index];
    if (!row || message.text === null || message.availability !== "available") throw new SearchNotFoundError("search-message-not-found");
    return { ...message, text: message.text, availability: "available", intentTurnPosition: row.intentTurnPosition };
  });
  return { value: { messages, nextBeforePosition: rows.length > limit ? messages.at(-1)?.position ?? null : null }, dependencies: offered.dependencies };
}
export function readSearchDiscoveries(db: Database, sessionId: string, after: number, highWater: number, limit: number,
  eligibleTargetsOnly = false): SearchOfferedContent<ContentPage<SearchDiscoveryView>> {
  const rows = db.query(`SELECT d.id,d.position,d.added_at AS addedAt,d.why,d.evidence_json AS evidenceJson,
    ${searchContentEligibilitySql("discovery_id", "d.id", "d.evidence_json")} AS available,
    ${searchEligibilitySql("'thought'", "d.thought_id")} AS targetAvailable,
    t.id AS thoughtId,t.text,m.title,m.title_author AS titleAuthor,t.author,t.kind,t.created_at AS createdAt
    FROM search_discoveries d JOIN thoughts t ON t.id=d.thought_id JOIN thought_titles m ON m.thought_id=t.id
    WHERE d.session_id=CAST(? AS TEXT) AND d.removed_at IS NULL AND d.position>? AND d.position<=?
      ${eligibleTargetsOnly ? `AND ${searchEligibilitySql("'thought'","d.thought_id")}` : ""} ORDER BY d.position LIMIT ?`)
    .all(text(sessionId), after, highWater, limit + 1) as DiscoveryRow[];
  const selected = rows.slice(0, limit), exposed: ContextRef[] = [];
  const sources = storedMediaSources(db,selected.filter(row => row.targetAvailable === 1 && row.text === null).map(row => row.thoughtId));
  const items = selected.map(row => {
    const targetAvailable = row.targetAvailable === 1, rationaleAvailable = targetAvailable && row.available === 1;
    const thought = targetAvailable ? Object.freeze({ id: row.thoughtId,
      title: row.text === null ? row.title ?? requiredMediaSource(sources,row.thoughtId).name : displayTitle({text:row.text,title:row.title}), titleAuthor: row.titleAuthor,
      author: row.author, kind: row.kind, createdAt: row.createdAt }) : null;
    const evidence = rationaleAvailable ? searchEvidence(row.evidenceJson) : Object.freeze([]);
    if (targetAvailable) exposed.push({ kind: "thought", id: row.thoughtId });
    for (const id of evidence) exposed.push({ kind: "thought", id });
    return Object.freeze({ id: row.id, position: row.position, addedAt: row.addedAt, removedAt: null, thought,
      why: rationaleAvailable ? row.why : null, evidenceThoughtIds: evidence,
      availability: targetAvailable ? "available" : "thought-unavailable", reasonStatus: rationaleAvailable ? "available" : "context-unavailable" } satisfies SearchDiscoveryView);
  });
  const dependencies = mergeSearchReferences(exposed, retainedSearchDependencies(db, sessionId, "discovery_id",
    selected.filter(row => row.targetAvailable === 1 && row.available === 1).map(row => row.id)));
  return { value: { items: Object.freeze(items), hasMore: rows.length > limit }, dependencies };
}
export function readSearchThoughtPreview(db: Database, thoughtId: string): SearchOfferedContent<{ readonly thought: Thought }> {
  const row = db.query(`SELECT thought.id,thought.text,m.title,m.title_author AS titleAuthor,thought.author,thought.kind,thought.created_at AS createdAt,thought.origin,
    CASE WHEN NOT EXISTS (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=thought.parent_id) THEN thought.parent_id END AS parentId
    FROM thoughts thought JOIN thought_titles m ON m.thought_id=thought.id
    WHERE thought.id=CAST(? AS TEXT) AND ${searchEligibilitySql("'thought'", "thought.id")}`).get(text(thoughtId));
  if (!row) throw new SearchNotFoundError("search-thought-not-found");
  const sources = db.query(`SELECT s.source_id AS id FROM thought_sources s WHERE s.thought_id=CAST(? AS TEXT)
    AND ${searchEligibilitySql("'thought'", "s.source_id")} ORDER BY s.position`).all(text(thoughtId)) as { id: string }[];
  const thought = storedThought(db,{ ...row, sourceIds: sources.map(source => source.id) });
  const ids = [thought.id, ...(thought.parentId === null ? [] : [thought.parentId]), ...thought.sourceIds];
  return { value: { thought }, dependencies: mergeSearchReferences(ids.map(id => ({ kind: "thought", id }))) };
}
