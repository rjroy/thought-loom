import type { MaterialKind, ThoughtAuthor } from "./thought";
import type { ConnectionCategory } from "./connection";

export interface InvestigationRequest {
  readonly query: string | null;
  readonly authors: readonly ThoughtAuthor[];
  readonly kinds: readonly MaterialKind[];
  readonly from: string | null;
  readonly until: string | null;
  readonly sort: "relevance" | "newest" | "oldest";
  readonly limit?: number;
  /** Opaque process-local continuation; invalid after restart, requiring a fresh walk. */
  readonly cursor?: string | null;
}
export interface InvestigationCandidate {
  readonly kind: "thought" | "response";
  readonly id: string;
  readonly thoughtId: string;
  readonly snippet: string;
  readonly author: ThoughtAuthor;
  readonly materialKind: MaterialKind;
  readonly createdAt: string;
}
export type InvestigationResult = { readonly type: "page"; readonly items: readonly InvestigationCandidate[]; readonly nextCursor: string | null }
  | { readonly type: "retrieval-changed" };
export type RelatedRelation = "connections" | "children" | "parent" | "sources" | "responses";
export interface RelatedRequest {
  readonly thoughtId: string;
  readonly relation: RelatedRelation;
  readonly limit?: number;
  readonly cursor?: string | null;
}
export type RelatedItem = { readonly kind: "thought" | "response"; readonly id: string }
  | { readonly kind: "connection"; readonly id: string; readonly fromId: string; readonly toId: string; readonly category: ConnectionCategory };
export type RelatedResult = { readonly type: "page"; readonly items: readonly RelatedItem[]; readonly nextCursor: string | null }
  | { readonly type: "retrieval-changed" };
export interface SearchInvestigation {
  findThoughts(request: InvestigationRequest): InvestigationResult;
  related(request: RelatedRequest): RelatedResult;
}
