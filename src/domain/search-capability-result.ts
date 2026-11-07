import { createConnection } from "./connection";
import type { InvestigationCandidate, RelatedItem } from "./investigative-retrieval";
import { RunConflictError, type ContextRef } from "./run";
import { protocolJson } from "./run-protocol";
import { searchCapabilityFields as fields, searchCapabilityIds as ids, type SearchActiveDiscovery, type SearchCapabilityRequest,
  type SearchCapabilityResult, type SearchConversationMessage } from "./search-capability";
import { parseDiscoveryReceipt } from "./search-publication";
import { searchRevision, searchString } from "./search-session-guards";
import { normalizeSearchTimeRange } from "./search-time";
import { createSharedResponse } from "./shared-response";
import { createThought } from "./thought";
import { oneOf, record } from "./validation";

const string = (input: unknown): string => searchString(input,"result field");
const position = (input: unknown): number | null => input === null ? null : searchRevision(input);
const authors = ["user","ai","source"] as const;
const kinds = ["captured-original","user-contribution","ai-interpretation","developing-idea","imported-original","media-original"] as const;
function cursor(input: unknown): string | null {
  if (input === null) return null;
  const value = string(input);
  if (value.length > 8192) throw new RunConflictError();
  return value;
}
function page<T>(input: unknown, limit: number, decode: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(input) || input.length > limit) throw new RunConflictError();
  return Object.freeze(input.map(decode));
}
function candidate(input: unknown): InvestigationCandidate {
  const item = fields(input,["kind","id","thoughtId","snippet","author","materialKind","createdAt"]);
  if (typeof item.snippet !== "string") throw new RunConflictError();
  return { kind: oneOf(item.kind,"candidate kind",["thought","response"]), id: string(item.id), thoughtId: string(item.thoughtId),
    snippet: item.snippet, author: oneOf(item.author,"author",authors), materialKind: oneOf(item.materialKind,"kind",kinds), createdAt: string(item.createdAt) };
}
function related(input: unknown): RelatedItem {
  const item = record(input);
  if (item.kind === "connection") {
    fields(item,["kind","id","fromId","toId","category"]);
    return { kind: item.kind, id: string(item.id), fromId: string(item.fromId), toId: string(item.toId),
      category: oneOf(item.category,"category",["supports","contradicts","extends","related"]) };
  }
  fields(item,["kind","id"]);
  return { kind: oneOf(item.kind,"reference kind",["thought","response"]), id: string(item.id) };
}
function message(input: unknown): SearchConversationMessage {
  const data = fields(input,["id","runId","position","role","text","createdAt","disposition","evidenceThoughtIds","availability","intentTurnPosition"]);
  const role = oneOf(data.role,"message role",["user","assistant"]);
  const disposition = data.disposition === null ? null : oneOf(data.disposition,"disposition",["awaiting-user","done"]);
  if (data.availability !== "available" || (role === "user") !== (disposition === null)) throw new RunConflictError();
  return { id: string(data.id), runId: string(data.runId), position: searchRevision(data.position), role, text: string(data.text),
    createdAt: string(data.createdAt), disposition, evidenceThoughtIds: ids(data.evidenceThoughtIds), availability: "available",
    intentTurnPosition: searchRevision(data.intentTurnPosition) };
}
function discovery(input: unknown): SearchActiveDiscovery {
  const data = fields(input,["id","position","addedAt","removedAt","thought","why","evidenceThoughtIds","availability","reasonStatus"]);
  if (data.removedAt !== null || data.availability !== "available") throw new RunConflictError();
  const thought = fields(data.thought,["id","title","titleAuthor","author","kind","createdAt"]);
  const reasonStatus = oneOf(data.reasonStatus,"rationale availability",["available","context-unavailable"]), evidenceThoughtIds = ids(data.evidenceThoughtIds);
  if (reasonStatus === "context-unavailable" && (data.why !== null || evidenceThoughtIds.length !== 0)) throw new RunConflictError();
  return { id: string(data.id), position: searchRevision(data.position), addedAt: string(data.addedAt), removedAt: null,
    thought: { id: string(thought.id), title: string(thought.title), titleAuthor: thought.titleAuthor === null ? null : oneOf(thought.titleAuthor,"title author",["user","ai"]),
      author: oneOf(thought.author,"author",authors), kind: oneOf(thought.kind,"kind",kinds), createdAt: string(thought.createdAt) },
    why: reasonStatus === "available" ? string(data.why) : null, evidenceThoughtIds, availability: "available", reasonStatus };
}

/** Decode only a result already persisted by the trusted dispatcher, never model-provided result JSON. */
export function readSearchCapabilityResult(request: SearchCapabilityRequest, input: unknown): SearchCapabilityResult {
  try {
    protocolJson(input);
    if (request.capability === "addDiscovery") return parseDiscoveryReceipt(protocolJson(input));
    const data = record(input);
    switch (request.capability) {
      case "readThought": {
        fields(data,["type","thought"]);
        if (data.type !== "thought") throw new RunConflictError();
        if (data.thought !== null) {
          const thought = record(data.thought);
          fields(thought,["id","text","title","titleAuthor","author","kind","createdAt","origin","parentId","sourceIds", ...(thought.kind === "media-original" ? ["mediaSource"] : [])]);
          if (thought.kind === "media-original") fields(thought.mediaSource,["id","name","mimeType","byteLength","fileAuthorship","clarification","clarificationAuthor"]);
        }
        const thought = data.thought === null ? null : createThought(data.thought);
        if (thought && thought.id !== request.arguments.id) throw new RunConflictError();
        return { type: "thought", thought };
      }
      case "readConnection": {
        fields(data,["type","connection"]);
        if (data.type !== "connection-read") throw new RunConflictError();
        if (data.connection !== null) fields(data.connection,["id","fromId","toId","category","proposedBy","explanation","sourceIds"]);
        const connection = data.connection === null ? null : createConnection(data.connection);
        if (connection && connection.id !== request.arguments.id) throw new RunConflictError();
        return { type: "connection-read", connection };
      }
      case "readResponse": {
        fields(data,["type","response"]);
        if (data.type !== "response") throw new RunConflictError();
        if (data.response !== null) fields(data.response,["id","text","role","state","thoughtIds"]);
        const response = data.response === null ? null : createSharedResponse(data.response);
        if (response && response.id !== request.arguments.id) throw new RunConflictError();
        return { type: "response", response };
      }
      case "findThoughts":
        if (data.type === "retrieval-changed") { fields(data,["type"]); return { type: "retrieval-changed" }; }
        fields(data,["type","items","nextCursor"]);
        if (data.type !== "page") throw new RunConflictError();
        return { type: "page", items: page(data.items,request.arguments.limit,candidate), nextCursor: cursor(data.nextCursor) };
      case "relatedThoughts": {
        if (data.type === "retrieval-changed") { fields(data,["type"]); return { type: "retrieval-changed" }; }
        fields(data,["type","thoughtId","relation","items","nextCursor"]);
        if (data.type !== "related" || data.thoughtId !== request.arguments.thoughtId || data.relation !== request.arguments.relation) throw new RunConflictError();
        const items = page(data.items,request.arguments.limit,related);
        const expectedKind = request.arguments.relation === "connections" ? "connection" : request.arguments.relation === "responses" ? "response" : "thought";
        if (items.some(item => item.kind !== expectedKind)) throw new RunConflictError();
        return { type: "related", thoughtId: request.arguments.thoughtId, relation: request.arguments.relation, items, nextCursor: cursor(data.nextCursor) };
      }
      case "readSearchConversation": {
        fields(data,["type","messages","nextBeforePosition"]);
        if (data.type !== "search-conversation") throw new RunConflictError();
        const messages = page(data.messages,request.arguments.limit,message), nextBeforePosition = position(data.nextBeforePosition);
        let before = request.arguments.beforePosition ?? Infinity;
        for (const item of messages) { if (item.position >= before) throw new RunConflictError(); before = item.position; }
        if (nextBeforePosition !== null && nextBeforePosition !== messages.at(-1)?.position) throw new RunConflictError();
        return { type: "search-conversation", messages, nextBeforePosition };
      }
      case "listDiscoveries": {
        fields(data,["type","items","nextAfterPosition"]);
        if (data.type !== "discoveries") throw new RunConflictError();
        const items = page(data.items,request.arguments.limit,discovery), nextAfterPosition = position(data.nextAfterPosition);
        let after = request.arguments.afterPosition ?? -1;
        for (const item of items) { if (item.position <= after) throw new RunConflictError(); after = item.position; }
        if (nextAfterPosition !== null && nextAfterPosition !== items.at(-1)?.position) throw new RunConflictError();
        return { type: "discoveries", items, nextAfterPosition };
      }
      case "normalizeTimeRange": {
        fields(data,["type","range"]);
        if (data.type !== "time-range") throw new RunConflictError();
        const range = fields(data.range,["basis","intentTurnPosition","interpretation","from","until","timeZone","fromUtc","untilUtc","requestAnchor"]);
        const anchor = fields(range.requestAnchor,["clock","daemonObservedAt"]), clock = fields(anchor.clock,["at","timeZone"]);
        const canonical = normalizeSearchTimeRange(request.arguments,{ clock: { at: string(clock.at), timeZone: string(clock.timeZone) }, daemonObservedAt: string(anchor.daemonObservedAt) });
        if (protocolJson(canonical) !== protocolJson(range)) throw new RunConflictError();
        return { type: "time-range", range: canonical };
      }
    }
  } catch { throw new RunConflictError("Invalid retained search capability result"); }
}

/** Visible record identities only. Private context adapters also retain the complete flattened source closure. */
export function searchCapabilityReferences(result: SearchCapabilityResult): readonly ContextRef[] {
  switch (result.type) {
    case "page": return result.items.flatMap(item => [{ kind: item.kind, id: item.id }, { kind: "thought" as const, id: item.thoughtId }]);
    case "related": return [{ kind: "thought", id: result.thoughtId },...result.items.flatMap((item): ContextRef[] => item.kind === "connection"
      ? [{ kind: "connection", id: item.id },{ kind: "thought", id: item.fromId },{ kind: "thought", id: item.toId }] : [{kind:item.kind,id:item.id}])];
    case "thought": return result.thought === null ? [] : [result.thought.id,...(result.thought.parentId === null ? [] : [result.thought.parentId]),...result.thought.sourceIds].map(id => ({ kind: "thought", id }));
    case "connection-read": return result.connection === null ? [] : [{ kind: "connection", id: result.connection.id },
      ...[result.connection.fromId,result.connection.toId,...result.connection.sourceIds].map((id): ContextRef => ({ kind: "thought", id }))];
    case "response": return result.response === null ? [] : [{ kind: "response", id: result.response.id },...result.response.thoughtIds.map((id): ContextRef => ({ kind: "thought", id }))];
    case "search-conversation": return result.messages.flatMap(item => item.evidenceThoughtIds.map((id): ContextRef => ({kind:"thought",id})));
    case "discoveries": return result.items.flatMap(item => [item.thought.id,...item.evidenceThoughtIds].map((id): ContextRef => ({kind:"thought",id})));
    default: return [];
  }
}
export function searchCapabilityFullRead(result: SearchCapabilityResult): ContextRef | null {
  if (result.type === "thought" && result.thought) return { kind: "thought", id: result.thought.id };
  if (result.type === "connection-read" && result.connection) return { kind: "connection", id: result.connection.id };
  if (result.type === "response" && result.response) return { kind: "response", id: result.response.id };
  return null;
}
