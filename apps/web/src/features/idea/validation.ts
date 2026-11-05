import type { BranchPreview, IdeaCommand, IdeaConnection, IdeaThought, IdeaView, SharedResponse } from "./types";

export function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === "string" && item.length > 0);
const actor = (v: unknown) => v === "user" || v === "ai";
const material = (v: unknown) => v === "captured-original" || v === "user-contribution" || v === "ai-interpretation" || v === "developing-idea";
const optionalRejected = (v: unknown) => v === undefined || typeof v === "boolean";
export function thought(v: unknown): v is IdeaThought {
  return record(v) && typeof v.id === "string" && !!v.id && typeof v.text === "string" && !!v.text.trim()
    && (typeof v.title === "string" || v.title === null) && (v.titleAuthor === undefined || v.titleAuthor === null || actor(v.titleAuthor))
    && actor(v.author) && material(v.kind) && typeof v.createdAt === "string" && typeof v.origin === "string"
    && (typeof v.parentId === "string" || v.parentId === null) && strings(v.sourceIds) && optionalRejected(v.rejected);
}
export function connection(v: unknown): v is IdeaConnection {
  return record(v) && typeof v.id === "string" && !!v.id && typeof v.fromId === "string" && typeof v.toId === "string"
    && (v.category === "supports" || v.category === "contradicts" || v.category === "extends" || v.category === "related")
    && actor(v.proposedBy) && typeof v.explanation === "string" && strings(v.sourceIds) && optionalRejected(v.rejected);
}
export function sharedResponse(v: unknown): v is SharedResponse {
  return record(v) && typeof v.id === "string" && !!v.id && typeof v.text === "string"
    && (v.role === "addendum" || v.role === "fallback") && (v.state === "complete" || v.state === "interrupted")
    && strings(v.thoughtIds) && v.thoughtIds.length > 0;
}
export function preview(v: unknown, id: string): v is BranchPreview {
  return record(v) && Object.keys(v).length === 4 && v.rootId === id && strings(v.branchIds) && strings(v.affectedIds)
    && typeof v.count === "number" && Number.isSafeInteger(v.count) && v.count >= 0;
}
export function command(v: unknown, id: string): v is IdeaCommand {
  if (!record(v) || v.thoughtId !== id || typeof v.action !== "string") return false;
  const keys = Object.keys(v);
  switch (v.action) {
    case "title": return keys.length === 3 && (v.title === null || (typeof v.title === "string" && !!v.title.trim()));
    case "reject-thought": case "restore-thought": case "restore-branch": return keys.length === 2;
    case "reject-connection": case "restore-connection": return keys.length === 3 && typeof v.connectionId === "string" && !!v.connectionId.trim();
    case "reject-branch": return keys.length === 3 && preview(v.preview, id);
    default: return false;
  }
}
export function view(v: unknown): v is IdeaView {
  if (!record(v) || !thought(v.thought)) return false;
  const root = v.thought;
  const reference = (x: unknown, id: string) => record(x) && x.id === id && (x.thought === null || (thought(x.thought) && x.thought.id === id));
  return (root.parentId === null ? v.parent === null : reference(v.parent, root.parentId))
    && Array.isArray(v.children) && v.children.every(child => thought(child) && child.parentId === root.id)
    && Array.isArray(v.sources) && v.sources.length === root.sourceIds.length
    && v.sources.every((source, index) => reference(source, root.sourceIds[index]))
    && Array.isArray(v.connections) && v.connections.every(item => {
      if (!record(item) || !connection(item.connection)) return false;
      const edge = item.connection;
      if (edge.fromId !== root.id && edge.toId !== root.id) return false;
      const neighborId = edge.fromId === root.id ? edge.toId : edge.fromId;
      return item.thought === null || (thought(item.thought) && item.thought.id === neighborId);
    })
    && Array.isArray(v.responses) && v.responses.every(reply => sharedResponse(reply) && reply.thoughtIds.includes(root.id))
    && (v.focusedResponse === null || (sharedResponse(v.focusedResponse) && v.focusedResponse.thoughtIds.includes(root.id)
      && v.responses.some(reply => reply.id === (v.focusedResponse as SharedResponse).id)));
}
