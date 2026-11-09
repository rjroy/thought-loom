import type { IdeaConnection, IdeaThought } from "../idea/types";
import type { BrowseQuery } from "./query";
import { connection, record, thought } from "../idea/validation";

/** Existing client ThoughtRead union, not a search hit or conversational response. */
export interface BrowsePage {
  readonly items: readonly IdeaThought[];
  readonly nextCursor: string | null;
}

/** Validate the existing thought union and publish only its documented fields. */
export function decodeBrowsePage(value: unknown, query: BrowseQuery): BrowsePage | undefined {
  if (!record(value) || !Array.isArray(value.items)
      || !(value.nextCursor === null || typeof value.nextCursor === "string" && !!value.nextCursor.trim())) return undefined;
  const items: IdeaThought[] = [];
  for (const item of value.items) {
    if (!thought(item) || (query.scope === "show-rejected" ? typeof item.rejected !== "boolean" : item.rejected === true)) return undefined;
    const common = { id: item.id, title: item.title, ...(item.titleAuthor === undefined ? {} : { titleAuthor: item.titleAuthor }),
      createdAt: item.createdAt, origin: item.origin, sourceIds: [...item.sourceIds],
      ...(item.rejected === undefined ? {} : { rejected: item.rejected }) };
    if (item.kind === "media-original") {
      items.push({ ...common, author: "source", kind: item.kind, origin: "media-import", text: null, parentId: null,
        mediaSource: { ...item.mediaSource } });
    } else {
      items.push({ ...common, author: item.author, kind: item.kind, text: item.text, parentId: item.parentId });
    }
  }
  return { items, nextCursor: value.nextCursor };
}

/** Stable edge identities are opaque and distinct from any nested connection identity. */
export type NeighborhoodEdge =
  | { readonly kind: "evolution"; readonly id: string; readonly fromId: string; readonly toId: string }
  | { readonly kind: "provenance"; readonly id: string; readonly fromId: string; readonly toId: string; readonly position: number }
  | { readonly kind: "connection"; readonly id: string; readonly fromId: string; readonly toId: string; readonly connection: IdeaConnection };

export interface BrowseNeighborhoodPage {
  readonly thought: IdeaThought;
  readonly nodes: readonly IdeaThought[];
  readonly edges: readonly NeighborhoodEdge[];
  readonly nextCursor: string | null;
}

/**
 * HTTP JSON boundary, reusing the existing thought/connection validators.
 * Validate focus, direct incidence, endpoint resolution, scoped flags and occurrence identity;
 * connection evidence is retained metadata, never another adjacency list.
 */
export function decodeBrowseNeighborhood(
  value: unknown, id: string, scope: BrowseQuery["scope"],
): BrowseNeighborhoodPage | undefined {
  if (!record(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return undefined;
  const decoded = decodeBrowsePage({ items: [value.thought, ...value.nodes], nextCursor: value.nextCursor }, { sort: "newest", author: [], scope });
  const focus = decoded?.items[0];
  if (!decoded || !focus || focus.id !== id) return undefined;
  const nodes = decoded.items.slice(1), nodeIds = new Set(nodes.map(node => node.id));
  if (nodeIds.size !== nodes.length || nodeIds.has(id)) return undefined;
  const known = new Set([id, ...nodeIds]), keys = new Set<string>(), edges: NeighborhoodEdge[] = [];
  for (const edge of value.edges) {
    if (!record(edge) || typeof edge.id !== "string" || !edge.id || keys.has(edge.id)
        || typeof edge.fromId !== "string" || typeof edge.toId !== "string"
        || !known.has(edge.fromId) || !known.has(edge.toId) || edge.fromId !== id && edge.toId !== id) return undefined;
    keys.add(edge.id);
    const base = { id: edge.id, fromId: edge.fromId, toId: edge.toId };
    if (edge.kind === "evolution") edges.push({ ...base, kind: edge.kind });
    else if (edge.kind === "provenance" && typeof edge.position === "number" && Number.isSafeInteger(edge.position) && edge.position >= 0) {
      edges.push({ ...base, kind: edge.kind, position: edge.position });
    } else if (edge.kind === "connection" && connection(edge.connection)) {
      const item = edge.connection;
      if (item.id === edge.id || item.fromId !== edge.fromId || item.toId !== edge.toId
          || (scope === "show-rejected" ? typeof item.rejected !== "boolean" : item.rejected === true)) return undefined;
      edges.push({ ...base, kind: edge.kind, connection: { id: item.id, fromId: item.fromId, toId: item.toId,
        category: item.category, proposedBy: item.proposedBy, explanation: item.explanation, sourceIds: [...item.sourceIds],
        ...(item.rejected === undefined ? {} : { rejected: item.rejected }) } });
    } else return undefined;
  }
  if (nodes.some(node => !edges.some(edge => edge.fromId === node.id || edge.toId === node.id))) return undefined;
  return { thought: focus, nodes, edges, nextCursor: decoded.nextCursor };
}
