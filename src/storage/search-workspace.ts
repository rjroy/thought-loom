import type { Database } from "bun:sqlite";
import { searchRevision, type SearchComposerOutcome, type SearchDiscoveryView, type SearchMessageView,
  type SearchThoughtPreview, type SearchWorkspacePage, type SearchWorkspaceQuery } from "../domain/agentic-search";
import type { SearchWorkspaceCollection } from "../domain/agentic-search-workspace";
import { SqliteSearchComposers } from "./search-composer";
import { readSearchDiscoveries, readSearchMessages, readSearchThoughtPreview, type SearchOfferedContent } from "./search-workspace-content";
import { signWorkspaceCursor, workspaceContinuation } from "./search-workspace-cursor";

/** Bounded normal projections; the surrounding composer transaction registers exactly the offered page/preview. */
export class SqliteSearchWorkspace {
  constructor(private readonly db: Database, private readonly composers: SqliteSearchComposers) {}
  private page<T extends { readonly position: number }>(sessionId: string, kind: SearchWorkspaceCollection, query: SearchWorkspaceQuery,
    read: (after: number, highWater: number, limit: number) => SearchOfferedContent<{ readonly items: readonly T[]; readonly hasMore: boolean }>):
    SearchComposerOutcome<SearchWorkspacePage<T>> {
    return this.composers.offer(sessionId, query.composerId, () => {
      const { limit, cursor } = workspaceContinuation(query.cursor, kind, sessionId, query.limit);
      const table = kind === "messages" ? "search_messages" : "search_discoveries";
      const highWater = cursor?.highWater ?? (this.db.query(`SELECT COALESCE(MAX(position),-1) AS n FROM ${table} WHERE session_id=CAST(? AS TEXT)`)
        .get(new TextEncoder().encode(sessionId)) as { n: number }).n;
      if (highWater !== -1) searchRevision(highWater);
      const offered = read(cursor?.after ?? -1, highWater, limit), last = offered.value.items.at(-1);
      const nextCursor = offered.value.hasMore && last ? signWorkspaceCursor(kind, sessionId, limit, searchRevision(last.position), highWater) : null;
      return { value: { items: offered.value.items, nextCursor }, dependencies: offered.dependencies };
    });
  }
  messages(sessionId: string, query: SearchWorkspaceQuery): SearchComposerOutcome<SearchWorkspacePage<SearchMessageView>> {
    return this.page(sessionId, "messages", query, (after, highWater, limit) => readSearchMessages(this.db, sessionId, after, highWater, limit));
  }
  discoveries(sessionId: string, query: SearchWorkspaceQuery): SearchComposerOutcome<SearchWorkspacePage<SearchDiscoveryView>> {
    return this.page(sessionId, "discoveries", query, (after, highWater, limit) => readSearchDiscoveries(this.db, sessionId, after, highWater, limit));
  }
  previewThought(sessionId: string, composerId: string, thoughtId: string): SearchComposerOutcome<SearchThoughtPreview> {
    return this.composers.offer(sessionId, composerId, () => readSearchThoughtPreview(this.db, thoughtId));
  }
}
