import type { Database } from "bun:sqlite";
import type { ContextRef } from "../domain/run";
import { SearchConflictError, SearchNotFoundError, SearchStorageError, searchRevision,
  type SearchComposerOutcome, type SearchComposerView, type SearchContextClaims, type SearchMessageOffer,
  type SearchPreparedAdmission, type SearchTurnRequest } from "../domain/agentic-search";
import { mergeSearchReferences, searchReferencesEligible } from "./search-eligibility";
import { signSearchContext, verifySearchContext } from "./search-context-token";
import { readSearchMessage, type SearchOfferedContent } from "./search-workspace-content";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
interface ComposerRow { readonly id: string; readonly sessionId: string; readonly revision: number; readonly state: string }

/** Trusted normal reads extend the same draft ledger before any prose is returned. No native/knowledge authority. */
export class SqliteSearchComposers {
  constructor(private readonly db: Database) {}
  private requireTransaction(): void {
    if (!this.db.inTransaction) throw new SearchStorageError("search-composer-requires-transaction");
  }
  private row(sessionId: string, composerId: string): ComposerRow {
    const row = this.db.query(`SELECT id,session_id AS sessionId,revision,state FROM search_composer_contexts
      WHERE id=CAST(? AS TEXT) AND session_id=CAST(? AS TEXT)`).get(text(composerId), text(sessionId)) as ComposerRow | null;
    if (!row) throw new SearchNotFoundError("search-composer-not-found");
    if (row.state !== "active") throw new SearchConflictError("context-changed");
    return row;
  }
  private eligibilityRevision(): number {
    const row = this.db.query("SELECT eligibility FROM search_revisions WHERE id=1").get() as { eligibility: number } | null;
    if (!row) throw new SearchStorageError("search-eligibility-revision-unavailable");
    return searchRevision(row.eligibility);
  }
  private dependencies(composerId: string): readonly ContextRef[] {
    return this.db.query(`SELECT ref_kind AS kind,ref_id AS id FROM search_composer_dependencies
      WHERE composer_id=CAST(? AS TEXT) ORDER BY ref_kind,ref_id`).all(text(composerId)) as ContextRef[];
  }
  private validateCoverage(row: ComposerRow): SearchComposerOutcome<readonly ContextRef[]> {
    const dependencies = this.dependencies(row.id);
    if (searchReferencesEligible(this.db, dependencies)) return { valid: true, value: dependencies };
    this.db.run("UPDATE search_composer_contexts SET state='invalidated' WHERE id=CAST(? AS TEXT)", [text(row.id)]);
    // The owning transaction commits this fence; the domain throws only after it has committed.
    return { valid: false };
  }
  private claims(row: ComposerRow): SearchContextClaims {
    return Object.freeze({ sessionId: row.sessionId, composerId: row.id, composerRevision: searchRevision(row.revision), eligibilityRevision: this.eligibilityRevision() });
  }
  private view(row: ComposerRow): SearchComposerView {
    const claims = this.claims(row);
    return Object.freeze({ composerId: row.id, contextToken: signSearchContext(claims), eligibilityRevision: claims.eligibilityRevision });
  }
  open(sessionId: string, composerId: string, at: string): SearchComposerView {
    this.requireTransaction();
    this.db.run(`INSERT INTO search_composer_contexts(id,session_id,state,created_at)
      VALUES (CAST(? AS TEXT),CAST(? AS TEXT),'active',?)`, [text(composerId), text(sessionId), at]);
    return this.view(this.row(sessionId, composerId));
  }
  discard(sessionId: string, composerId: string): void {
    this.requireTransaction();
    const row = this.db.query(`SELECT state FROM search_composer_contexts WHERE id=CAST(? AS TEXT) AND session_id=CAST(? AS TEXT)`)
      .get(text(composerId),text(sessionId)) as { state: string } | null;
    if (!row) throw new SearchNotFoundError("search-composer-not-found");
    if (row.state === "active") this.db.run("UPDATE search_composer_contexts SET state='discarded' WHERE id=CAST(? AS TEXT)",[text(composerId)]);
  }
  offerMessage(sessionId: string, composerId: string, messageId: string): SearchComposerOutcome<SearchMessageOffer> {
    return this.offer(sessionId, composerId, () => readSearchMessage(this.db, sessionId, messageId));
  }
  refresh(sessionId: string, composerId: string): SearchComposerOutcome<SearchComposerView> {
    this.requireTransaction();
    const composer = this.row(sessionId, composerId), coverage = this.validateCoverage(composer);
    if (!coverage.valid) return coverage;
    return { valid: true, value: this.view(composer) };
  }
  offer<T>(sessionId: string, composerId: string, read: () => SearchOfferedContent<T>): SearchComposerOutcome<T & SearchComposerView & { readonly sessionRevision: number }> {
    this.requireTransaction();
    const composer = this.row(sessionId, composerId), coverage = this.validateCoverage(composer);
    if (!coverage.valid) return coverage;
    const offered = read();
    if (!searchReferencesEligible(this.db, offered.dependencies)) throw new SearchStorageError("unsafe-search-offer");
    let added = 0;
    const insert = this.db.query(`INSERT OR IGNORE INTO search_composer_dependencies(composer_id,ref_kind,ref_id)
      VALUES (CAST(? AS TEXT),?,CAST(? AS TEXT))`);
    for (const ref of offered.dependencies) added += insert.run(text(composerId), ref.kind, text(ref.id)).changes;
    if (added) {
      searchRevision(composer.revision + 1);
      this.db.run("UPDATE search_composer_contexts SET revision=revision+1 WHERE id=CAST(? AS TEXT)", [text(composerId)]);
    }
    const session = this.db.query("SELECT revision FROM search_sessions WHERE id=CAST(? AS TEXT)").get(text(sessionId)) as { revision: number } | null;
    if (!session) throw new SearchStorageError("search-composer-session-unavailable");
    return { valid: true, value: Object.freeze({ ...offered.value, ...this.view(this.row(sessionId, composerId)), sessionRevision: searchRevision(session.revision) }) };
  }
  prepareAdmission(sessionId: string, request: SearchTurnRequest): SearchComposerOutcome<SearchPreparedAdmission> {
    this.requireTransaction();
    const claims = verifySearchContext(request.contextToken);
    if (claims.sessionId !== sessionId || claims.composerId !== request.composerId) throw new SearchConflictError("context-changed");
    const composer = this.row(sessionId, request.composerId), coverage = this.validateCoverage(composer);
    if (!coverage.valid) return coverage;
    if (claims.composerRevision !== composer.revision || claims.eligibilityRevision !== this.eligibilityRevision()) throw new SearchConflictError("context-changed");
    const starting: readonly ContextRef[] = request.startingThoughtIds.map(id => ({ kind: "thought", id }));
    if (!searchReferencesEligible(this.db, starting)) throw new SearchNotFoundError("starting-thought-not-found");
    return { valid: true, value: Object.freeze({ claims, dependencies: mergeSearchReferences(coverage.value, starting) }) };
  }
}
