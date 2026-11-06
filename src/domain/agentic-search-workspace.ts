import { createLogger, type Logger } from "../logging";
import type { Actor } from "./rejection";
import type { Thought } from "./thought";
import { protocolJson } from "./run-protocol";
import { record, ValidationError } from "./validation";
import { requireSearchUser, SearchConflictError, SearchNotFoundError, searchPageLimit, searchSessionView, searchString } from "./search-session-guards";
import type { SearchComposerOutcome, SearchComposerView, SearchMessageView, SearchSessionOperation,
  SearchSessionRepository, SearchSessionTransaction, SearchThoughtSummary } from "./agentic-search";

export type SearchWorkspaceCollection = "messages" | "discoveries";
export interface SearchWorkspaceQuery { readonly composerId: string; readonly limit: number | null; readonly cursor: string | null }
export interface SearchWorkspacePage<T> extends SearchComposerView {
  readonly items: readonly T[]; readonly nextCursor: string | null; readonly sessionRevision: number;
}
export interface SearchDiscoveryView {
  readonly id: string; readonly position: number; readonly addedAt: string; readonly removedAt: null;
  readonly thought: SearchThoughtSummary | null; readonly why: string | null; readonly evidenceThoughtIds: readonly string[];
  readonly availability: "available" | "thought-unavailable"; readonly reasonStatus: "available" | "context-unavailable";
}
export interface SearchThoughtPreview extends SearchComposerView { readonly thought: Thought; readonly sessionRevision: number }
export interface SearchWorkspace {
  messages(actor: Actor, sessionId: string, request: unknown): SearchWorkspacePage<SearchMessageView>;
  discoveries(actor: Actor, sessionId: string, request: unknown): SearchWorkspacePage<SearchDiscoveryView>;
  previewThought(actor: Actor, sessionId: string, composerId: string, thoughtId: string): SearchThoughtPreview;
  refreshComposer(actor: Actor, sessionId: string, composerId: string): SearchComposerView;
}

export function searchWorkspaceQuery(input: unknown): SearchWorkspaceQuery {
  protocolJson(input);
  const data = record(input);
  if (Object.keys(data).some(key => !["composerId", "limit", "cursor"].includes(key))) throw new ValidationError("Invalid search workspace fields");
  const cursor = data.cursor === undefined || data.cursor === null ? null : searchString(data.cursor, "workspace cursor");
  if (cursor !== null && cursor.length > 16384) throw new ValidationError("Invalid search workspace cursor");
  return { composerId: searchString(data.composerId, "composerId"), limit: data.limit === undefined ? null : searchPageLimit(data.limit), cursor };
}

/** Normal user display only. Every prose read is one ledger transaction, never a history fallback or agent port. */
export class SearchWorkspaceService implements SearchWorkspace {
  constructor(private readonly repository: SearchSessionRepository, private readonly logger: Logger = createLogger()) {}
  private read<T>(operation: SearchSessionOperation, actor: Actor, sessionId: string, composerId: string,
    action: (tx: SearchSessionTransaction) => SearchComposerOutcome<T>): T {
    requireSearchUser(actor); searchString(sessionId, "sessionId"); searchString(composerId, "composerId");
    const outcome = this.repository.transaction(operation, tx => {
      const session = tx.get(sessionId);
      if (!session) throw new SearchNotFoundError("search-session-not-found");
      searchSessionView(session);
      return action(tx);
    });
    if (!outcome.valid) {
      this.logger.info("[search sessions] composer context invalidated", { sessionId, composerId });
      throw new SearchConflictError("context-changed");
    }
    return outcome.value;
  }
  messages(actor: Actor, sessionId: string, request: unknown): SearchWorkspacePage<SearchMessageView> {
    requireSearchUser(actor);
    const query = searchWorkspaceQuery(request);
    return this.read("messages", actor, sessionId, query.composerId, tx => tx.messages(sessionId, query));
  }
  discoveries(actor: Actor, sessionId: string, request: unknown): SearchWorkspacePage<SearchDiscoveryView> {
    requireSearchUser(actor);
    const query = searchWorkspaceQuery(request);
    return this.read("discoveries", actor, sessionId, query.composerId, tx => tx.discoveries(sessionId, query));
  }
  previewThought(actor: Actor, sessionId: string, composerId: string, thoughtId: string): SearchThoughtPreview {
    requireSearchUser(actor); searchString(thoughtId, "thoughtId");
    return this.read("previewThought", actor, sessionId, composerId, tx => tx.previewThought(sessionId, composerId, thoughtId));
  }
  refreshComposer(actor: Actor, sessionId: string, composerId: string): SearchComposerView {
    return this.read("refreshComposer", actor, sessionId, composerId, tx => tx.refreshComposer(sessionId, composerId));
  }
}
