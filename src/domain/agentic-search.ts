import type { Actor } from "./rejection";
import type { ThoughtAuthor, MaterialKind, TitleAuthor } from "./thought";
import type { Logger } from "../logging";
import { createLogger } from "../logging";
import { protocolJson } from "./run-protocol";
import { nonEmpty, record, ValidationError } from "./validation";
import type { ContextRef, RunStatus } from "./run";

export class SearchForbiddenError extends Error {}
export class SearchNotFoundError extends Error {}
export class SearchConflictError extends Error {
  constructor(readonly code: "session-deleted" | "revision-conflict" | "list-changed" | "native-cleanup-required"
    | "context-changed" | "idempotency-conflict" | "turn-active") { super(code); }
}
export class SearchStorageError extends Error {}

export interface SearchSessionView {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly revision: number;
}
/** Internal retention identity; tombstones are never consumer session views. */
export interface SearchSessionRecord extends Omit<SearchSessionView, "title"> {
  readonly title: string | null;
  readonly createRequestKey: string;
  readonly deletedAt: string | null;
}
export interface SearchSessionCreation { readonly session: SearchSessionView; readonly replayed: boolean }
export interface SearchSessionSources { readonly id: () => string; readonly now: () => string; readonly logger?: Logger }
export interface SearchRequestClock { readonly at: string; readonly timeZone: string }
export interface SearchTurnRequest {
  readonly text: string; readonly startingThoughtIds: readonly string[]; readonly requestClock: SearchRequestClock;
  readonly effort: "quick" | "standard" | "thorough"; readonly contextMode: "continue" | "restart";
  readonly composerId: string; readonly contextToken: string;
}
export interface SearchContextClaims {
  readonly sessionId: string; readonly composerId: string; readonly composerRevision: number; readonly eligibilityRevision: number;
}
export interface SearchComposerView { readonly composerId: string; readonly contextToken: string; readonly eligibilityRevision: number }
export interface SearchMessageView extends Omit<SearchHistoryMessage, "text"> { readonly text: string | null }
export interface SearchMessageOffer extends SearchComposerView { readonly message: SearchMessageView; readonly sessionRevision: number }
export interface SearchRunView {
  readonly id: string; readonly kind: "search"; readonly status: RunStatus; readonly searchSessionId: string;
  readonly userMessageId: string; readonly assistantMessageId: string | null;
  readonly outcomeReason: "stopped" | "context-invalidated" | "failed" | null;
  readonly cancellation: "none" | "pending" | "settled";
}
export interface SearchTurnReceipt {
  readonly searchSessionId: string; readonly runId: string; readonly userMessageId: string; readonly admittedAt: string;
}
/** Deliberately contains no recovered/submitted conversation prose. */
export interface SearchTurnControlView { readonly receipt: SearchTurnReceipt; readonly run: SearchRunView; readonly session: SearchSessionView }
export interface SearchRetainedTurn { readonly request: SearchTurnRequest; readonly control: SearchTurnControlView }
export type SearchComposerOutcome<T> = { readonly valid: true; readonly value: T } | { readonly valid: false };
export interface SearchPreparedAdmission { readonly claims: SearchContextClaims; readonly dependencies: readonly ContextRef[] }
export interface SearchTurnAdmission {
  readonly sessionId: string; readonly requestKey: string; readonly request: SearchTurnRequest; readonly context: SearchPreparedAdmission;
  readonly runId: string; readonly userMessageId: string; readonly nativeSessionId: string; readonly promptId: string; readonly admittedAt: string;
}
/** Internal keyset continuation. A future transport must authenticate it, not trust browser-selected fields. */
export interface SearchCatalogCursor {
  readonly kind: "search-sessions"; readonly scope: "user"; readonly order: "last-activity-desc";
  readonly limit: number; readonly catalogRevision: number; readonly highWater: number;
  readonly lastActivityAt: string; readonly sequence: number;
}
export interface SearchCatalogQuery { readonly limit: number; readonly cursor: SearchCatalogCursor | null }
export interface SearchCatalogRequest { readonly limit?: number; readonly cursor?: SearchCatalogCursor | null }
export interface SearchCatalogPage { readonly items: readonly SearchSessionView[]; readonly nextCursor: SearchCatalogCursor | null }
export interface SearchHistoryCursor {
  readonly kind: "messages" | "discoveries"; readonly scope: "history"; readonly sessionId: string;
  readonly limit: number; readonly after: number; readonly highWater: number;
}
export interface SearchHistoryQuery { readonly limit: number; readonly cursor: SearchHistoryCursor | null }
export interface SearchHistoryPageRequest { readonly limit?: number; readonly cursor?: SearchHistoryCursor | null }
export interface SearchHistoryRequest { readonly messages?: SearchHistoryPageRequest; readonly discoveries?: SearchHistoryPageRequest }
export interface SearchHistoryQueries { readonly messages: SearchHistoryQuery; readonly discoveries: SearchHistoryQuery }
export interface SearchHistoryPage<T> { readonly items: readonly T[]; readonly nextCursor: SearchHistoryCursor | null }
export interface SearchThoughtSummary {
  readonly id: string; readonly title: string; readonly titleAuthor: TitleAuthor | null;
  readonly author: ThoughtAuthor; readonly kind: MaterialKind; readonly createdAt: string;
}
/** Exact retained prose is deliberate human history, never normal workspace or agent context. */
export interface SearchHistoryMessage {
  readonly id: string; readonly runId: string; readonly position: number; readonly role: "user" | "assistant";
  readonly text: string; readonly createdAt: string; readonly disposition: "awaiting-user" | "done" | null;
  readonly evidenceThoughtIds: readonly string[]; readonly availability: "available" | "context-unavailable";
}
export interface SearchHistoryDiscovery {
  readonly id: string; readonly position: number; readonly addedAt: string; readonly removedAt: string | null;
  readonly thought: SearchThoughtSummary; readonly why: string; readonly evidenceThoughtIds: readonly string[];
  readonly availability: "available" | "thought-unavailable"; readonly reasonStatus: "available" | "context-unavailable";
}
export interface SearchHistoryContent {
  readonly messages: SearchHistoryPage<SearchHistoryMessage>;
  readonly discoveries: SearchHistoryPage<SearchHistoryDiscovery>;
}
export interface SearchSessionHistory extends SearchHistoryContent {
  readonly scope: "history";
  readonly session: SearchSessionView;
}
export interface SearchSessionTransaction {
  get(id: string): SearchSessionRecord | null;
  byCreateKey(requestKey: string): SearchSessionRecord | null;
  list(query: SearchCatalogQuery): { readonly items: readonly SearchSessionRecord[]; readonly nextCursor: SearchCatalogCursor | null };
  insert(session: SearchSessionRecord): void;
  rename(id: string, expectedRevision: number, title: string, at: string): void;
  history(sessionId: string, query: SearchHistoryQueries): SearchHistoryContent;
  /** Must reject unproved native ownership/drain before changing or purging any local row. */
  purge(sessionId: string, at: string): void;
  openComposer(sessionId: string, composerId: string, at: string): SearchComposerView;
  offerMessage(sessionId: string, composerId: string, messageId: string): SearchComposerOutcome<SearchMessageOffer>;
  turnByKey(sessionId: string, requestKey: string): SearchRetainedTurn | null;
  hasActiveTurn(sessionId: string): boolean;
  prepareAdmission(sessionId: string, request: SearchTurnRequest): SearchComposerOutcome<SearchPreparedAdmission>;
  admitTurn(admission: SearchTurnAdmission): SearchTurnControlView;
  removeDiscovery(sessionId: string, entryId: string, at: () => string): boolean;
}
export type SearchSessionOperation = "create" | "list" | "get" | "rename" | "history" | "delete"
  | "openComposer" | "offerMessage" | "admitTurn" | "turnByKey" | "removeDiscovery";
export interface SearchSessionRepository {
  transaction<T>(operation: SearchSessionOperation, action: (tx: SearchSessionTransaction) => T): T;
}
export interface SearchSessions {
  create(actor: Actor, requestKey: string, payload: unknown): SearchSessionCreation;
  list(actor: Actor, request?: unknown): SearchCatalogPage;
  get(actor: Actor, sessionId: string): SearchSessionView | null;
  rename(actor: Actor, sessionId: string, expectedRevision: number, payload: unknown): SearchSessionView;
  history(actor: Actor, sessionId: string, request?: unknown): SearchSessionHistory;
  delete(actor: Actor, sessionId: string): void;
  openComposer(actor: Actor, sessionId: string): SearchComposerView;
  offerMessage(actor: Actor, sessionId: string, composerId: string, messageId: string): SearchMessageOffer;
  admitTurn(actor: Actor, sessionId: string, requestKey: string, input: unknown): SearchTurnControlView;
  turnByKey(actor: Actor, sessionId: string, requestKey: string): SearchTurnControlView | null;
  removeDiscovery(actor: Actor, sessionId: string, entryId: string): void;
}

export function requireSearchUser(actor: Actor): void {
  if (actor !== "user") throw new SearchForbiddenError("Search sessions are user-only");
}
export function searchRequestKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ValidationError("Invalid search request key");
  return value;
}
export function searchRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ValidationError("Invalid search revision");
  return value;
}
export function searchString(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  if (text.includes("\0") || !text.isWellFormed()) throw new ValidationError(`Invalid search ${field}`);
  return text;
}
/** Daemon record times are canonical UTC instants, not caller clock samples. */
export function searchRecordTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new ValidationError("Invalid search record time");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ValidationError("Invalid search record time");
  return value;
}
function fields(input: unknown, expected: readonly string[]): Record<string, unknown> {
  try {
    protocolJson(input);
    const data = record(input);
    if (Object.keys(data).length !== expected.length || expected.some(key => !Object.hasOwn(data, key))) throw new ValidationError();
    return data;
  } catch { throw new ValidationError("Invalid search request fields"); }
}
function optionalFields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  try {
    protocolJson(input);
    const data = record(input);
    if (Object.keys(data).some(key => !allowed.includes(key))) throw new ValidationError();
    return data;
  } catch { throw new ValidationError("Invalid search request fields"); }
}
export function searchTurnRequest(input: unknown): SearchTurnRequest {
  const data = optionalFields(input, ["text", "startingThoughtIds", "requestClock", "effort", "contextMode", "composerId", "contextToken"]);
  const clock = fields(data.requestClock, ["at", "timeZone"]);
  const starting = data.startingThoughtIds === undefined ? [] : data.startingThoughtIds;
  if (!Array.isArray(starting)) throw new ValidationError("Invalid starting thought IDs");
  const startingThoughtIds = Object.freeze(starting.map((id: unknown) => searchString(id, "startingThoughtId")));
  if (new Set(startingThoughtIds).size !== startingThoughtIds.length) throw new ValidationError("Duplicate starting thought ID");
  const effort = data.effort === undefined ? "standard" : data.effort;
  const contextMode = data.contextMode === undefined ? "continue" : data.contextMode;
  if (effort !== "quick" && effort !== "standard" && effort !== "thorough") throw new ValidationError("Invalid search effort");
  if (contextMode !== "continue" && contextMode !== "restart") throw new ValidationError("Invalid search context mode");
  return Object.freeze({ text: searchString(data.text, "text"), startingThoughtIds, effort, contextMode,
    requestClock: Object.freeze({ at: searchString(clock.at, "request clock"), timeZone: searchString(clock.timeZone, "time zone") }),
    composerId: searchString(data.composerId, "composerId"), contextToken: searchString(data.contextToken, "context token") });
}
/** Validate the user's calendar/zone/offset without rebasing it against the daemon clock or parsing prose. */
export function validateSearchRequestClock(clock: SearchRequestClock): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(clock.at);
  if (!match || !/^[A-Za-z_][A-Za-z0-9_+./-]*$/.test(clock.timeZone)) throw new ValidationError("Invalid search request clock");
  const instant = new Date(clock.at);
  if (!Number.isFinite(instant.getTime())) throw new ValidationError("Invalid search request clock");
  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", { timeZone: clock.timeZone,
      era: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const parts = new Map(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    const keys = ["year", "month", "day", "hour", "minute", "second"] as const;
    if (keys.some((key, index) => {
      const value = Number(parts.get(key));
      return (key === "year" && parts.get("era") === "BC" ? 1 - value : value) !== Number(match[index + 1]);
    })) throw new ValidationError();
  } catch { throw new ValidationError("Search request clock contradicts its time zone or calendar"); }
}
function pageLimit(input: unknown): number {
  const value = searchRevision(input);
  if (value < 1 || value > 200) throw new ValidationError("Invalid search page limit");
  return value;
}
export function searchCatalogQuery(input: unknown): SearchCatalogQuery {
  const data = optionalFields(input, ["limit", "cursor"]);
  let cursor: SearchCatalogCursor | null = null;
  if (data.cursor !== undefined && data.cursor !== null) {
    const c = fields(data.cursor, ["kind", "scope", "order", "limit", "catalogRevision", "highWater", "lastActivityAt", "sequence"]);
    if (c.kind !== "search-sessions" || c.scope !== "user" || c.order !== "last-activity-desc") throw new ValidationError("Invalid search catalog continuation");
    const sequence = searchRevision(c.sequence), highWater = searchRevision(c.highWater);
    if (sequence < 1 || sequence > highWater) throw new ValidationError("Invalid search catalog position");
    cursor = Object.freeze({ kind: c.kind, scope: c.scope, order: c.order, limit: pageLimit(c.limit),
      catalogRevision: searchRevision(c.catalogRevision), highWater, sequence, lastActivityAt: searchRecordTime(c.lastActivityAt) });
  }
  const limit = pageLimit(data.limit === undefined ? cursor?.limit ?? 50 : data.limit);
  if (cursor && cursor.limit !== limit) throw new ValidationError("Search catalog limit changed");
  return { limit, cursor };
}
export function searchHistoryQueries(sessionId: string, input: unknown): SearchHistoryQueries {
  const data = optionalFields(input, ["messages", "discoveries"]);
  function query(kind: SearchHistoryCursor["kind"]): SearchHistoryQuery {
    const page = optionalFields(data[kind] === undefined ? {} : data[kind], ["limit", "cursor"]);
    let cursor: SearchHistoryCursor | null = null;
    if (page.cursor !== undefined && page.cursor !== null) {
      const c = fields(page.cursor, ["kind", "scope", "sessionId", "limit", "after", "highWater"]);
      const after = searchRevision(c.after), highWater = searchRevision(c.highWater);
      if (c.kind !== kind || c.scope !== "history" || c.sessionId !== sessionId || after > highWater) throw new ValidationError("Invalid search history continuation");
      cursor = Object.freeze({ kind, scope: "history", sessionId, limit: pageLimit(c.limit), after, highWater });
    }
    const limit = pageLimit(page.limit === undefined ? cursor?.limit ?? 50 : page.limit);
    if (cursor && cursor.limit !== limit) throw new ValidationError("Search history limit changed");
    return { limit, cursor };
  }
  return { messages: query("messages"), discoveries: query("discoveries") };
}
export function searchSessionView(row: SearchSessionRecord): SearchSessionView {
  if (row.deletedAt !== null || row.title === null) throw new SearchNotFoundError("search-session-not-found");
  return Object.freeze({ id: row.id, title: row.title, createdAt: row.createdAt, lastActivityAt: row.lastActivityAt, revision: searchRevision(row.revision) });
}
function requireSession(tx: SearchSessionTransaction, id: string): SearchSessionView {
  const row = tx.get(id);
  if (!row) throw new SearchNotFoundError("search-session-not-found");
  return searchSessionView(row);
}

/** User control/history boundary. It has no knowledge writer, agent credential or native dispatcher. */
export class SearchSessionService implements SearchSessions {
  private readonly logger: Logger;
  constructor(private readonly repository: SearchSessionRepository, private readonly sources: SearchSessionSources) {
    this.logger = sources.logger ?? createLogger();
  }
  private command<T>(operation: "create" | "rename" | "delete" | "openComposer" | "admitTurn" | "removeDiscovery", context: { readonly sessionId?: string }, action: () => T): T {
    this.logger.info(`[search sessions] ${operation} attempt`, context);
    try { return action(); }
    catch (error) {
      const reason = error instanceof SearchConflictError ? error.code : error instanceof SearchNotFoundError ? "search-session-not-found"
        : error instanceof ValidationError ? "invalid-search-request" : "search-persistence-failed";
      this.logger.warning(`[search sessions] ${operation} failed`, { ...context, reason });
      throw error;
    }
  }
  create(actor: Actor, requestKey: string, payload: unknown): SearchSessionCreation {
    requireSearchUser(actor); searchRequestKey(requestKey); fields(payload, []);
    const result = this.command("create", {}, () => this.repository.transaction("create", tx => {
      const existing = tx.byCreateKey(requestKey);
      if (existing) {
        if (existing.deletedAt !== null) throw new SearchConflictError("session-deleted");
        return { session: searchSessionView(existing), replayed: true };
      }
      const at = searchRecordTime(this.sources.now());
      const session: SearchSessionRecord = { id: searchString(this.sources.id(), "sessionId"), createRequestKey: requestKey,
        title: `Search — ${at.slice(0, 10)}`, createdAt: at, lastActivityAt: at, revision: 0, deletedAt: null };
      tx.insert(session);
      return { session: searchSessionView(session), replayed: false };
    }));
    if (result.replayed) this.logger.verbose("[search sessions] create replayed", { sessionId: result.session.id });
    else this.logger.info("[search sessions] created", { sessionId: result.session.id });
    return Object.freeze(result);
  }
  list(actor: Actor, request: unknown = {}): SearchCatalogPage {
    requireSearchUser(actor);
    const query = searchCatalogQuery(request);
    return this.repository.transaction("list", tx => {
      const page = tx.list(query);
      return Object.freeze({ items: Object.freeze(page.items.map(searchSessionView)), nextCursor: page.nextCursor });
    });
  }
  get(actor: Actor, sessionId: string): SearchSessionView | null {
    requireSearchUser(actor); searchString(sessionId, "sessionId");
    return this.repository.transaction("get", tx => {
      const row = tx.get(sessionId);
      return row && row.deletedAt === null ? searchSessionView(row) : null;
    });
  }
  rename(actor: Actor, sessionId: string, expectedRevision: number, payload: unknown): SearchSessionView {
    requireSearchUser(actor); searchString(sessionId, "sessionId"); searchRevision(expectedRevision);
    const title = searchString(fields(payload, ["title"]).title, "title");
    const outcome = this.command("rename", { sessionId }, () => this.repository.transaction("rename", tx => {
      const before = requireSession(tx, sessionId);
      if (before.revision !== expectedRevision) throw new SearchConflictError("revision-conflict");
      if (before.title === title) return { session: before, changed: false };
      searchRevision(before.revision + 1);
      tx.rename(sessionId, expectedRevision, title, searchRecordTime(this.sources.now()));
      return { session: requireSession(tx, sessionId), changed: true };
    }));
    if (outcome.changed) this.logger.info("[search sessions] renamed", { sessionId, revision: outcome.session.revision });
    else this.logger.verbose("[search sessions] rename unchanged", { sessionId });
    return outcome.session;
  }
  history(actor: Actor, sessionId: string, request: unknown = {}): SearchSessionHistory {
    requireSearchUser(actor); searchString(sessionId, "sessionId");
    const query = searchHistoryQueries(sessionId, request);
    return this.repository.transaction("history", tx => {
      const session = requireSession(tx, sessionId);
      return Object.freeze({ scope: "history", session, ...tx.history(sessionId, query) });
    });
  }
  delete(actor: Actor, sessionId: string): void {
    requireSearchUser(actor); searchString(sessionId, "sessionId");
    const changed = this.command("delete", { sessionId }, () => this.repository.transaction("delete", tx => {
      const row = tx.get(sessionId);
      if (!row) throw new SearchNotFoundError("search-session-not-found");
      if (row.deletedAt !== null) return false;
      searchRevision(row.revision + 1);
      tx.purge(sessionId, searchRecordTime(this.sources.now()));
      return true;
    }));
    if (changed) this.logger.info("[search sessions] deleted locally", { sessionId });
    else this.logger.verbose("[search sessions] delete replayed", { sessionId });
  }
  openComposer(actor: Actor, sessionId: string): SearchComposerView {
    requireSearchUser(actor); searchString(sessionId, "sessionId");
    const result = this.command("openComposer", { sessionId }, () => this.repository.transaction("openComposer", tx => {
      requireSession(tx, sessionId);
      return tx.openComposer(sessionId, searchString(this.sources.id(), "composerId"), searchRecordTime(this.sources.now()));
    }));
    this.logger.info("[search sessions] blank composer opened", { sessionId, composerId: result.composerId });
    return result;
  }
  offerMessage(actor: Actor, sessionId: string, composerId: string, messageId: string): SearchMessageOffer {
    requireSearchUser(actor); searchString(sessionId, "sessionId"); searchString(composerId, "composerId"); searchString(messageId, "messageId");
    const outcome = this.repository.transaction("offerMessage", tx => {
      requireSession(tx, sessionId);
      return tx.offerMessage(sessionId, composerId, messageId);
    });
    if (!outcome.valid) {
      this.logger.info("[search sessions] composer context invalidated", { sessionId, composerId });
      throw new SearchConflictError("context-changed");
    }
    return outcome.value;
  }
  admitTurn(actor: Actor, sessionId: string, requestKey: string, input: unknown): SearchTurnControlView {
    requireSearchUser(actor); searchString(sessionId, "sessionId"); searchRequestKey(requestKey);
    const request = searchTurnRequest(input);
    const outcome = this.command("admitTurn", { sessionId }, () => this.repository.transaction("admitTurn", tx => {
      requireSession(tx, sessionId);
      const existing = tx.turnByKey(sessionId, requestKey);
      if (existing) {
        if (protocolJson(existing.request) !== protocolJson(request)) throw new SearchConflictError("idempotency-conflict");
        return { valid: true, value: existing.control, replayed: true } as const;
      }
      if (tx.hasActiveTurn(sessionId)) throw new SearchConflictError("turn-active");
      validateSearchRequestClock(request.requestClock);
      const prepared = tx.prepareAdmission(sessionId, request);
      if (!prepared.valid) return prepared;
      const admittedAt = searchRecordTime(this.sources.now());
      const nextId = () => searchString(this.sources.id(), "search identity");
      const value = tx.admitTurn({ sessionId, requestKey, request, context: prepared.value, admittedAt,
        runId: nextId(), userMessageId: nextId(), nativeSessionId: `ses_${nextId()}`, promptId: `msg_${nextId()}` });
      return { valid: true, value, replayed: false } as const;
    }));
    if (!outcome.valid) {
      this.logger.info("[search sessions] composer context invalidated", { sessionId, composerId: request.composerId });
      throw new SearchConflictError("context-changed");
    }
    if (outcome.replayed) this.logger.verbose("[search sessions] turn replayed", { sessionId, runId: outcome.value.run.id });
    else this.logger.info("[search sessions] turn admitted", { sessionId, runId: outcome.value.run.id });
    return outcome.value;
  }
  turnByKey(actor: Actor, sessionId: string, requestKey: string): SearchTurnControlView | null {
    requireSearchUser(actor); searchString(sessionId, "sessionId"); searchRequestKey(requestKey);
    return this.repository.transaction("turnByKey", tx => {
      const session = tx.get(sessionId);
      if (!session || session.deletedAt !== null) return null;
      return tx.turnByKey(sessionId, requestKey)?.control ?? null;
    });
  }
  removeDiscovery(actor: Actor, sessionId: string, entryId: string): void {
    requireSearchUser(actor); searchString(sessionId, "sessionId"); searchString(entryId, "entryId");
    const changed = this.command("removeDiscovery", { sessionId }, () => this.repository.transaction("removeDiscovery", tx => {
      requireSession(tx, sessionId);
      return tx.removeDiscovery(sessionId, entryId, () => searchRecordTime(this.sources.now()));
    }));
    if (changed) this.logger.info("[search sessions] discovery removed", { sessionId, entryId });
    else this.logger.verbose("[search sessions] discovery removal replayed", { sessionId, entryId });
  }
}
