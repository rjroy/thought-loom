import type { Database } from "bun:sqlite";
import type { ContextRef } from "../domain/run";
import { SearchConflictError, SearchNotFoundError, SearchStorageError, searchRevision,
  type SearchComposerOutcome, type SearchComposerView, type SearchContextClaims, type SearchMessageOffer,
  type SearchMessageView, type SearchPreparedAdmission, type SearchTurnRequest } from "../domain/agentic-search";
import { mergeSearchReferences, searchEvidence, searchReferencesEligible } from "./search-eligibility";
import { signSearchContext, verifySearchContext } from "./search-context-token";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
interface ComposerRow { readonly id: string; readonly sessionId: string; readonly revision: number; readonly state: string }
interface MessageRow extends Omit<SearchMessageView, "availability" | "evidenceThoughtIds"> { readonly evidenceJson: string }

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
  offerMessage(sessionId: string, composerId: string, messageId: string): SearchComposerOutcome<SearchMessageOffer> {
    this.requireTransaction();
    const composer = this.row(sessionId, composerId), coverage = this.validateCoverage(composer);
    if (!coverage.valid) return coverage;
    const row = this.db.query(`SELECT id,run_id AS runId,position,role,text,created_at AS createdAt,disposition,evidence_json AS evidenceJson
      FROM search_messages WHERE id=CAST(? AS TEXT) AND session_id=CAST(? AS TEXT)`).get(text(messageId), text(sessionId)) as MessageRow | null;
    if (!row) throw new SearchNotFoundError("search-message-not-found");
    const evidence = searchEvidence(row.evidenceJson);
    const dependencies = mergeSearchReferences(this.db.query(`SELECT ref_kind AS kind,ref_id AS id FROM search_content_dependencies
      WHERE message_id=CAST(? AS TEXT) AND session_id=CAST(? AS TEXT)`).all(text(messageId), text(sessionId)) as ContextRef[],
    evidence.map(id => ({ kind: "thought", id })));
    const available = searchReferencesEligible(this.db, dependencies);
    if (available) {
      let added = 0;
      const insert = this.db.query(`INSERT OR IGNORE INTO search_composer_dependencies(composer_id,ref_kind,ref_id)
        VALUES (CAST(? AS TEXT),?,CAST(? AS TEXT))`);
      for (const ref of dependencies) added += insert.run(text(composerId), ref.kind, text(ref.id)).changes;
      if (added) {
        searchRevision(composer.revision + 1);
        this.db.run("UPDATE search_composer_contexts SET revision=revision+1 WHERE id=CAST(? AS TEXT)", [text(composerId)]);
      }
    }
    const { evidenceJson: _evidence, ...message } = row;
    const session = this.db.query("SELECT revision FROM search_sessions WHERE id=CAST(? AS TEXT)").get(text(sessionId)) as { revision: number } | null;
    if (!session) throw new SearchStorageError("search-composer-session-unavailable");
    return { valid: true, value: Object.freeze({ ...this.view(this.row(sessionId, composerId)), sessionRevision: searchRevision(session.revision),
      message: Object.freeze({ ...message, text: available ? row.text : null, evidenceThoughtIds: available ? evidence : Object.freeze([]),
        availability: available ? "available" : "context-unavailable" }) }) };
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
