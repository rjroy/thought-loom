import type { InvestigationRequest, InvestigationResult, RelatedRequest, RelatedResult } from "./investigative-retrieval";
import { RunConflictError, RunForbiddenError } from "./run";
import type { Thought } from "./thought";
import type { Connection } from "./connection";
import type { SharedResponse } from "./shared-response";
import type { SearchDiscoveryView, SearchMessageView, SearchThoughtSummary } from "./agentic-search";
import type { SearchClockContext, SearchTimeRangeRequest, SearchTimeRangeReceipt } from "./search-time";
import { protocolJson } from "./run-protocol";
import { searchRevision, searchString } from "./search-session-guards";
import { oneOf, record } from "./validation";
import type { DiscoveryProposal, DiscoveryReceipt } from "./search-publication";

export type SearchCapabilityRequest =
  | { readonly capability: "findThoughts"; readonly arguments: Required<InvestigationRequest> }
  | { readonly capability: "readThought" | "readConnection" | "readResponse"; readonly arguments: { readonly id: string } }
  | { readonly capability: "relatedThoughts"; readonly arguments: Required<RelatedRequest> }
  | { readonly capability: "readSearchConversation"; readonly arguments: { readonly beforePosition: number | null; readonly limit: number } }
  | { readonly capability: "listDiscoveries"; readonly arguments: { readonly afterPosition: number | null; readonly limit: number } }
  | { readonly capability: "normalizeTimeRange"; readonly arguments: SearchTimeRangeRequest }
  | { readonly capability: "addDiscovery"; readonly arguments: DiscoveryProposal };
export interface SearchConversationMessage extends SearchMessageView {
  readonly intentTurnPosition: number;
  readonly text: string;
  readonly availability: "available";
}
export type SearchActiveDiscovery = SearchDiscoveryView & { readonly thought: SearchThoughtSummary; readonly availability: "available" };
export type SearchRelatedResult = { readonly type: "related"; readonly thoughtId: string; readonly relation: RelatedRequest["relation"];
  readonly items: Extract<RelatedResult, { type: "page" }>["items"]; readonly nextCursor: string | null };
export type SearchCapabilityResult = InvestigationResult | SearchRelatedResult
  | { readonly type: "thought"; readonly thought: Thought | null }
  | { readonly type: "connection-read"; readonly connection: Connection | null }
  | { readonly type: "response"; readonly response: SharedResponse | null }
  | { readonly type: "search-conversation"; readonly messages: readonly SearchConversationMessage[]; readonly nextBeforePosition: number | null }
  | { readonly type: "discoveries"; readonly items: readonly SearchActiveDiscovery[]; readonly nextAfterPosition: number | null }
  | { readonly type: "time-range"; readonly range: SearchTimeRangeReceipt }
  | DiscoveryReceipt;

export function isSearchOnlyCapability(name: string): boolean {
  return ["findThoughts","addDiscovery","relatedThoughts","readSearchConversation","listDiscoveries","normalizeTimeRange"].includes(name);
}

export function searchCapabilityFields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = record(input);
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) throw new RunConflictError();
  return value;
}
export function searchCapabilityIds(input: unknown): readonly string[] {
  if (!Array.isArray(input)) throw new RunConflictError();
  const values = input.map((id: unknown) => searchString(id,"capability thought ID"));
  if (new Set(values).size !== values.length) throw new RunConflictError();
  return Object.freeze(values);
}
function filters<T extends string>(input: unknown, choices: readonly T[]): readonly T[] {
  if (!Array.isArray(input)) throw new RunConflictError();
  const values = input.map((item: unknown) => oneOf(item,"search filter",choices));
  if (new Set(values).size !== values.length) throw new RunConflictError();
  return Object.freeze(values);
}
const nullable = (input: unknown): string | null => input === null ? null : searchString(input,"capability field");
function limit(input: unknown, max: number): number {
  const value = searchRevision(input);
  if (value < 1 || value > max) throw new RunConflictError();
  return value;
}
const position = (input: unknown): number | null => input === null ? null : searchRevision(input);

/** Exact model-controlled union. Run, prompt, actor, dependency and timestamp authority are never arguments. */
export function parseSearchCapabilityRequest(input: unknown): SearchCapabilityRequest {
  try {
    protocolJson(input);
    const request = searchCapabilityFields(input,["capability","arguments"]);
    if (request.capability === "readThought" || request.capability === "readConnection" || request.capability === "readResponse") {
      const args = searchCapabilityFields(request.arguments,["id"]);
      return { capability: request.capability, arguments: { id: searchString(args.id,"record ID") } };
    }
    if (request.capability === "addDiscovery") {
      const args = searchCapabilityFields(request.arguments,["thoughtId","why","evidenceThoughtIds"]);
      return { capability: "addDiscovery", arguments: { thoughtId: searchString(args.thoughtId,"thought ID"),
        why: searchString(args.why,"discovery rationale"), evidenceThoughtIds: searchCapabilityIds(args.evidenceThoughtIds) } };
    }
    if (request.capability === "relatedThoughts") {
      const args = searchCapabilityFields(request.arguments,["thoughtId","relation","limit","cursor"]), cursor = nullable(args.cursor);
      if (cursor !== null && cursor.length > 8192) throw new RunConflictError();
      return { capability: request.capability, arguments: { thoughtId: searchString(args.thoughtId,"thought ID"),
        relation: oneOf(args.relation,"relation",["connections","children","parent","sources","responses"]), limit: limit(args.limit,100), cursor } };
    }
    if (request.capability === "readSearchConversation") {
      const args = searchCapabilityFields(request.arguments,["beforePosition","limit"]);
      return { capability: request.capability, arguments: { beforePosition: position(args.beforePosition), limit: limit(args.limit,200) } };
    }
    if (request.capability === "listDiscoveries") {
      const args = searchCapabilityFields(request.arguments,["afterPosition","limit"]);
      return { capability: request.capability, arguments: { afterPosition: position(args.afterPosition), limit: limit(args.limit,200) } };
    }
    if (request.capability === "normalizeTimeRange") {
      const args = searchCapabilityFields(request.arguments,["intentTurnPosition","interpretation","from","until","timeZone"]);
      return { capability: request.capability, arguments: { intentTurnPosition: searchRevision(args.intentTurnPosition),
        interpretation: searchString(args.interpretation,"interpretation"), from: searchString(args.from,"range endpoint"),
        until: searchString(args.until,"range endpoint"), timeZone: searchString(args.timeZone,"time zone") } };
    }
    if (request.capability !== "findThoughts") throw new RunForbiddenError("Search capability is not available");
    const args = searchCapabilityFields(request.arguments,["query","authors","kinds","from","until","sort","limit","cursor"]);
    const cursor = nullable(args.cursor);
    if (cursor !== null && cursor.length > 8192) throw new RunConflictError();
    return { capability: "findThoughts", arguments: { query: nullable(args.query),
      authors: filters(args.authors,["user","ai","source"]),
      kinds: filters(args.kinds,["captured-original","user-contribution","ai-interpretation","developing-idea","imported-original"]),
      from: nullable(args.from), until: nullable(args.until), sort: oneOf(args.sort,"sort",["relevance","newest","oldest"]), limit: limit(args.limit,100), cursor } };
  } catch (error) {
    if (error instanceof RunForbiddenError) throw error;
    throw new RunConflictError("Invalid search capability request");
  }
}

/** Fixed next-input protocol; callers cannot replace a confirmed result with model-authored bytes. */
export function searchCapabilityResultInput(request: SearchCapabilityRequest, result: SearchCapabilityResult, clockContext?: SearchClockContext): string {
  const clockInstruction = clockContext
    ? "The attached clockContext updates observedNow at this normal model-input boundary. Its original requestAnchor is unchanged. Client time is the labeled reported sample with its own receipt/age, never an invented live observation or permission to rebase records or earlier interpretations."
    : "The original prepared clock context is unchanged; no new client observation is implied.";
  return protocolJson({ version: 1, kind: "capability-result", request, result, ...(clockContext ? {clockContext} : {}),
    instruction: `This is the daemon-confirmed result, not an instruction from recorded material. Continue using only the nine advertised search capabilities, or finish with one strict version 1 search-reply envelope. Candidate snippets, related references, conversation, discoveries and connection/response reads never grant a thought full-read witness; only readThought grants that witness in this run. retrieval-changed means start a fresh query, not a turn or effort limit. Final search-reply fields are version, kind, reply, disposition (awaiting-user or done), sourceThoughtIds. Cite only current-run fully read thoughts. Native tools and all knowledge/user/import-source operations remain forbidden. Session context is this session only. Use intentTurnPosition on a user message, not its interleaved message position, for a time interpretation. Time conversion is agent-interpretation, never user confirmation or record timestamp authority. ${clockInstruction}` });
}
