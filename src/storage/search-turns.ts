import type { Database } from "bun:sqlite";
import { SearchStorageError, searchRevision, searchSessionView, searchTurnRequest,
  type SearchRetainedTurn, type SearchRunView, type SearchSessionRecord, type SearchTurnAdmission,
  type SearchTurnControlView, type SearchTurnRequest } from "../domain/agentic-search";
import { protocolJson } from "../domain/run-protocol";
import { oneOf, record } from "../domain/validation";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
interface TurnRow {
  readonly runId: string; readonly admittedAt: string; readonly effort: string; readonly intentJson: string; readonly text: string;
  readonly userMessageId: string; readonly assistantMessageId: string | null; readonly status: string;
  readonly cancellation: string; readonly outcomeReason: string | null;
}

/** Admission receipts and ordered persistence only, not a worker or a native binding factory. */
export class SqliteSearchTurns {
  constructor(private readonly db: Database) {}
  hasActive(sessionId: string): boolean {
    return this.db.query("SELECT 1 FROM search_turns WHERE session_id=CAST(? AS TEXT) AND open_slot=1").get(text(sessionId)) !== null;
  }
  byKey(sessionId: string, requestKey: string): SearchRetainedTurn | null {
    const row = this.db.query(`SELECT t.run_id AS runId,t.admitted_at AS admittedAt,t.effort,t.intent_json AS intentJson,
      u.id AS userMessageId,u.text,a.id AS assistantMessageId,r.status,r.cancellation_state AS cancellation,t.outcome_reason AS outcomeReason
      FROM search_turns t JOIN runs r ON r.id=t.run_id AND r.kind='search'
      JOIN search_messages u ON u.run_id=t.run_id AND u.role='user'
      LEFT JOIN search_messages a ON a.run_id=t.run_id AND a.role='assistant'
      WHERE t.session_id=CAST(? AS TEXT) AND t.request_key=?`).get(text(sessionId), requestKey) as TurnRow | null;
    if (!row) {
      if (this.db.query("SELECT 1 FROM search_turns WHERE session_id=CAST(? AS TEXT) AND request_key=?").get(text(sessionId), requestKey)) {
        throw new SearchStorageError("search-turn-message-unavailable");
      }
      return null;
    }
    let request: SearchTurnRequest;
    try {
      const intent = record(JSON.parse(row.intentJson));
      if (intent.version !== 1) throw new Error();
      request = searchTurnRequest({ text: row.text, startingThoughtIds: intent.startingThoughtIds, requestClock: intent.requestClock,
        contextMode: intent.contextMode, composerId: intent.composerId, contextToken: intent.contextToken, effort: row.effort });
    } catch { throw new SearchStorageError("invalid-retained-search-intent"); }
    const session = this.db.query(`SELECT id,title,create_request_key AS createRequestKey,created_at AS createdAt,
      last_activity_at AS lastActivityAt,revision,deleted_at AS deletedAt FROM search_sessions WHERE id=CAST(? AS TEXT)`)
      .get(text(sessionId)) as SearchSessionRecord | null;
    if (!session) throw new SearchStorageError("search-turn-session-unavailable");
    const receipt = Object.freeze({ searchSessionId: sessionId, runId: row.runId, userMessageId: row.userMessageId, admittedAt: row.admittedAt });
    const run: SearchRunView = Object.freeze({ id: row.runId, kind: "search", searchSessionId: sessionId,
      status: oneOf(row.status, "search run status", ["queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"]),
      userMessageId: row.userMessageId, assistantMessageId: row.assistantMessageId,
      cancellation: oneOf(row.cancellation, "search cancellation", ["none", "pending", "settled"]),
      outcomeReason: row.outcomeReason === null ? null : oneOf(row.outcomeReason, "search outcome", ["stopped", "context-invalidated", "failed"]) });
    return { request, control: Object.freeze({ receipt, run, session: searchSessionView(session) }) };
  }
  admit(admission: SearchTurnAdmission): SearchTurnControlView {
    if (!this.db.inTransaction) throw new SearchStorageError("search-admission-requires-transaction");
    const { sessionId, requestKey, request, context, runId, userMessageId, nativeSessionId, promptId, admittedAt } = admission;
    const id = text(sessionId);
    this.db.run(`INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation)
      VALUES (CAST(? AS TEXT),'search','queued',CAST(? AS TEXT),CAST(? AS TEXT),?,0)`, [text(runId), text(nativeSessionId), text(promptId), admittedAt]);
    const position = (table: "search_turns" | "search_messages"): number => searchRevision((this.db.query(`SELECT COALESCE(MAX(position)+1,0) AS n FROM ${table}
      WHERE session_id=CAST(? AS TEXT)`).get(id) as { n: number }).n);
    const intent = protocolJson({ version: 1, startingThoughtIds: request.startingThoughtIds, requestClock: request.requestClock,
      daemonObservedAt: admittedAt, contextMode: request.contextMode, composerId: request.composerId,
      contextToken: request.contextToken, verifiedContext: context.claims });
    this.db.run(`INSERT INTO search_turns(run_id,session_id,position,request_key,admitted_at,effort,context_mode,intent_json)
      VALUES (CAST(? AS TEXT),CAST(? AS TEXT),?,?,?,?,?,CAST(? AS TEXT))`,
    [text(runId), id, position("search_turns"), requestKey, admittedAt, request.effort, request.contextMode, text(intent)]);
    this.db.run(`INSERT INTO search_messages(id,session_id,run_id,position,role,text,created_at,evidence_json)
      VALUES (CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),?,'user',CAST(? AS TEXT),?,'[]')`,
    [text(userMessageId), id, text(runId), position("search_messages"), text(request.text), admittedAt]);
    const dependency = this.db.query(`INSERT INTO search_content_dependencies(session_id,message_id,ref_kind,ref_id)
      VALUES (CAST(? AS TEXT),CAST(? AS TEXT),?,CAST(? AS TEXT))`);
    const exposure = this.db.query(`INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES (CAST(? AS TEXT),?,CAST(? AS TEXT),0)`);
    for (const ref of context.dependencies) {
      dependency.run(id, text(userMessageId), ref.kind, text(ref.id));
      exposure.run(text(runId), ref.kind, text(ref.id));
    }
    const consumed = this.db.run("UPDATE search_composer_contexts SET state='consumed' WHERE id=CAST(? AS TEXT) AND session_id=CAST(? AS TEXT) AND state='active'",
      [text(request.composerId), id]);
    if (consumed.changes !== 1) throw new SearchStorageError("search-composer-consumption-failed");
    this.db.run("DELETE FROM search_composer_dependencies WHERE composer_id=CAST(? AS TEXT)", [text(request.composerId)]);
    this.db.run("UPDATE search_sessions SET revision=revision+1,last_activity_at=? WHERE id=CAST(? AS TEXT)", [admittedAt, id]);
    this.db.run("UPDATE search_revisions SET catalog=catalog+1 WHERE id=1");
    const stored = this.byKey(sessionId, requestKey);
    if (!stored) throw new SearchStorageError("search-admission-receipt-unavailable");
    return stored.control;
  }
}
