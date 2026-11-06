import type { Database } from "bun:sqlite";
import type { SearchHistoryContent, SearchHistoryCursor, SearchHistoryDiscovery, SearchHistoryMessage,
  SearchHistoryPage, SearchHistoryQueries, SearchHistoryQuery, SearchThoughtSummary } from "../domain/agentic-search";
import { displayTitle } from "../domain/thought";
import { searchEligibilitySql as eligible, searchContentEligibilitySql as available, searchEvidence as evidence } from "./search-eligibility";

interface MessageRow extends Omit<SearchHistoryMessage, "evidenceThoughtIds" | "availability"> {
  readonly evidenceJson: string;
  readonly available: number;
}
interface DiscoveryRow {
  readonly id: string; readonly position: number; readonly addedAt: string; readonly removedAt: string | null;
  readonly why: string; readonly evidenceJson: string; readonly available: number; readonly targetAvailable: number;
  readonly thoughtId: string; readonly title: string | null; readonly text: string; readonly titleAuthor: SearchThoughtSummary["titleAuthor"];
  readonly author: SearchThoughtSummary["author"]; readonly kind: SearchThoughtSummary["kind"]; readonly createdAt: string;
}

function page<T extends { readonly position: number }>(db: Database, sessionId: string, kind: SearchHistoryCursor["kind"],
  query: SearchHistoryQuery, read: (after: number, highWater: number, limit: number) => readonly T[]): SearchHistoryPage<T> {
  const table = kind === "messages" ? "search_messages" : "search_discoveries";
  const highWater = query.cursor?.highWater ?? (db.query(`SELECT COALESCE(MAX(position),-1) AS n FROM ${table} WHERE session_id=CAST(? AS TEXT)`)
    .get(new TextEncoder().encode(sessionId)) as { n: number }).n;
  const rows = read(query.cursor?.after ?? -1, highWater, query.limit + 1);
  const items = Object.freeze(rows.slice(0, query.limit)), last = items.at(-1);
  const nextCursor: SearchHistoryCursor | null = rows.length > query.limit && last
    ? Object.freeze({ kind, scope: "history", sessionId, limit: query.limit, after: last.position, highWater }) : null;
  return Object.freeze({ items, nextCursor });
}

/** Called only inside a user history transaction. Never used to seed normal workspace/AI context. */
export function readSearchHistory(db: Database, sessionId: string, query: SearchHistoryQueries): SearchHistoryContent {
  const id = new TextEncoder().encode(sessionId);
  const messages = page(db, sessionId, "messages", query.messages, (after, highWater, limit) => {
    const rows = db.query(`SELECT m.id,m.run_id AS runId,m.position,m.role,m.text,m.created_at AS createdAt,
      m.disposition,m.evidence_json AS evidenceJson,${available("message_id", "m.id", "m.evidence_json")} AS available
      FROM search_messages m WHERE m.session_id=CAST(? AS TEXT) AND m.position>? AND m.position<=? ORDER BY m.position LIMIT ?`)
      .all(id, after, highWater, limit) as MessageRow[];
    return rows.map(row => {
      const { evidenceJson, available: current, ...message } = row;
      return Object.freeze({ ...message, evidenceThoughtIds: evidence(evidenceJson),
        availability: current === 1 ? "available" : "context-unavailable" } satisfies SearchHistoryMessage);
    });
  });
  const discoveries = page(db, sessionId, "discoveries", query.discoveries, (after, highWater, limit) => {
    const rows = db.query(`SELECT d.id,d.position,d.added_at AS addedAt,d.removed_at AS removedAt,d.why,d.evidence_json AS evidenceJson,
      ${available("discovery_id", "d.id", "d.evidence_json")} AS available,${eligible("'thought'", "d.thought_id")} AS targetAvailable,
      t.id AS thoughtId,m.title,t.text,m.title_author AS titleAuthor,t.author,t.kind,t.created_at AS createdAt
      FROM search_discoveries d JOIN thoughts t ON t.id=d.thought_id JOIN thought_titles m ON m.thought_id=t.id
      WHERE d.session_id=CAST(? AS TEXT) AND d.position>? AND d.position<=? ORDER BY d.position LIMIT ?`)
      .all(id, after, highWater, limit) as DiscoveryRow[];
    return rows.map(row => Object.freeze({ id: row.id, position: row.position, addedAt: row.addedAt, removedAt: row.removedAt,
      thought: Object.freeze({ id: row.thoughtId, title: displayTitle(row), titleAuthor: row.titleAuthor, author: row.author, kind: row.kind, createdAt: row.createdAt }),
      why: row.why, evidenceThoughtIds: evidence(row.evidenceJson), availability: row.targetAvailable === 1 ? "available" : "thought-unavailable",
      reasonStatus: row.available === 1 && row.targetAvailable === 1 ? "available" : "context-unavailable" } satisfies SearchHistoryDiscovery));
  });
  return Object.freeze({ messages, discoveries });
}
