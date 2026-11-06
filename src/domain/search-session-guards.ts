import type { Actor } from "./rejection";
import type { SearchSessionRecord, SearchSessionView } from "./agentic-search";
import { nonEmpty, ValidationError } from "./validation";

export class SearchForbiddenError extends Error {}
export class SearchNotFoundError extends Error {}
export class SearchConflictError extends Error {
  constructor(readonly code: "session-deleted" | "revision-conflict" | "list-changed" | "native-cleanup-required"
    | "context-changed" | "idempotency-conflict" | "turn-active") { super(code); }
}
export class SearchStorageError extends Error {}

export function requireSearchUser(actor: Actor): void {
  if (actor !== "user") throw new SearchForbiddenError("Search sessions are user-only");
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
export function searchPageLimit(input: unknown): number {
  const value = searchRevision(input);
  if (value < 1 || value > 200) throw new ValidationError("Invalid search page limit");
  return value;
}
export function searchSessionView(row: SearchSessionRecord): SearchSessionView {
  if (row.deletedAt !== null || row.title === null) throw new SearchNotFoundError("search-session-not-found");
  return Object.freeze({ id: row.id, title: row.title, createdAt: row.createdAt, lastActivityAt: row.lastActivityAt, revision: searchRevision(row.revision) });
}
