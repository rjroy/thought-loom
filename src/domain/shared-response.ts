import { ForbiddenActorError, type ReadScope } from "./rejection";
import { nonEmpty, oneOf, record, references, ValidationError } from "./validation";

/** Immutable canonical reply and its thought associations in issued order. */
export interface SharedResponse {
  readonly id: string;
  readonly text: string;
  readonly role: "addendum" | "fallback";
  readonly state: "complete" | "interrupted";
  readonly thoughtIds: readonly string[];
}

export function createSharedResponse(input: unknown): SharedResponse {
  const data = record(input);
  const thoughtIds = references(data.thoughtIds, "thoughtIds");
  const role = oneOf(data.role, "role", ["addendum", "fallback"]);
  if (thoughtIds.length === 0 || new Set(thoughtIds).size !== thoughtIds.length || (role === "fallback" && thoughtIds.length !== 1)) {
    throw new ValidationError("Invalid response associations");
  }
  return Object.freeze({ id: nonEmpty(data.id, "id"), text: nonEmpty(data.text, "text"), role,
    state: oneOf(data.state, "state", ["complete", "interrupted"]), thoughtIds });
}

/** Select saved developments from a scoped response without promoting an interrupted fallback. */
export function latestEligibleDevelopment(response: SharedResponse): string | null {
  return response.state === "interrupted" && response.role === "fallback" ? null : response.thoughtIds.at(-1) ?? null;
}

/** Shared response visibility policy; also used by the rejection consumer boundary. */
export function scopeSharedResponse(scope: ReadScope, response: SharedResponse, rejectedIds: readonly string[]): SharedResponse | null {
  if (!scope || (scope.actor !== "user" && scope.actor !== "ai") ||
      (scope.mode !== "normal" && scope.mode !== "history" && scope.mode !== "show-rejected") ||
      (scope.actor === "ai" && scope.mode !== "normal")) throw new ForbiddenActorError("Invalid read scope");
  const canonical = createSharedResponse(response);
  if (scope.actor === "user" && scope.mode !== "normal") return canonical;
  const rejected = new Set(rejectedIds);
  if (scope.actor === "ai" && canonical.thoughtIds.some(id => rejected.has(id))) return null;
  const thoughtIds = canonical.thoughtIds.filter(id => !rejected.has(id));
  return thoughtIds.length ? createSharedResponse({ ...canonical, thoughtIds }) : null;
}
