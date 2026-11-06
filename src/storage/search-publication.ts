import type { Database } from "bun:sqlite";
import { createLogger, type Logger } from "../logging";
import { SearchStorageError, searchRecordTime, searchRevision, searchString, type SearchSessionSources } from "../domain/agentic-search";
import { parseDiscoveryReceipt, parseSearchPublication, type DiscoveryProposal, type DiscoveryReceipt, type SearchPublication } from "../domain/search-publication";
import { RunConflictError, RunFenceError, RunForbiddenError, type Claim } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { ValidationError } from "../domain/validation";
import { immediate } from "./transaction";
import { searchReferencesEligible } from "./search-eligibility";
import { fenceSearchPublication, requireCurrentSearchPublication, requireSearchFullReads, searchPublicationOwner, type SearchPublicationOwner } from "./search-publication-guard";
import { touchSearchSession } from "./search-session-activity";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Trusted dispatcher-only control persistence. It has no transport, native tools or knowledge writer. */
export class SqliteSearchPublication implements SearchPublication {
  private readonly logger: Logger;
  constructor(private readonly db: Database, private readonly sources: SearchSessionSources) { this.logger = sources.logger ?? createLogger(); }
  private guarded<T>(operation: string, claim: Claim, promptId: string, action: (owner: SearchPublicationOwner) => T): T {
    this.logger.verbose(`[search publication] ${operation} attempt`, { runId: claim.runId, promptId });
    try {
      const outcome = immediate(this.db, () => {
        const owner = searchPublicationOwner(this.db, claim, promptId);
        if (!searchReferencesEligible(this.db, owner.exposures)) {
          fenceSearchPublication(this.db, owner);
          return { valid: false } as const;
        }
        return { valid: true, value: action(owner) } as const;
      });
      if (!outcome.valid) {
        this.logger.info("[search publication] rejected context fenced", { runId: claim.runId, promptId });
        throw new RunFenceError("Search publication context is unavailable");
      }
      this.logger.verbose(`[search publication] ${operation} succeeded`, { runId: claim.runId, promptId });
      return outcome.value;
    } catch (error) {
      this.logger.verbose(`[search publication] ${operation} failed`, { runId: claim.runId, promptId });
      if (error instanceof SearchStorageError || error instanceof ValidationError || error instanceof RunFenceError ||
          error instanceof RunForbiddenError || error instanceof RunConflictError) throw error;
      throw new SearchStorageError("search-persistence-failed", { cause: error });
    }
  }
  private recheck(claim: Claim, promptId: string, snapshot?: SearchPublicationOwner): SearchPublicationOwner {
    const current = searchPublicationOwner(this.db, claim, promptId);
    requireCurrentSearchPublication(current);
    if (!searchReferencesEligible(this.db, current.exposures)) throw new RunFenceError("Search publication context changed before commit");
    if (snapshot && protocolJson(current.exposures) !== protocolJson(snapshot.exposures)) throw new RunFenceError("Search publication exposure set changed before commit");
    return current;
  }
  private receipt(owner: SearchPublicationOwner, proposal: DiscoveryProposal): DiscoveryReceipt | null {
    if (owner.resultJson === null) return null;
    const receipt = parseDiscoveryReceipt(owner.resultJson);
    if (owner.promptId !== owner.currentPromptId && owner.state !== "processed") throw new RunFenceError("Historical discovery receipt is not processed");
    const entry = this.db.query(`SELECT added_run_id AS runId,added_prompt_id AS promptId,why,evidence_json AS evidenceJson FROM search_discoveries
      WHERE id=CAST(? AS TEXT) AND session_id=CAST(? AS TEXT) AND thought_id=CAST(? AS TEXT)`)
      .get(text(receipt.entryId), text(owner.sessionId), text(proposal.thoughtId)) as { runId: string; promptId: string; why: string; evidenceJson: string } | null;
    if (!entry || (receipt.outcome === "added" && (entry.runId !== owner.runId || entry.promptId !== owner.promptId || entry.why !== proposal.why ||
        protocolJson(JSON.parse(entry.evidenceJson)) !== protocolJson(proposal.evidenceThoughtIds)))) throw new RunConflictError("Discovery receipt ownership differs");
    return receipt;
  }
  addDiscovery(claim: Claim, promptId: string): DiscoveryReceipt {
    const outcome = this.guarded("add discovery", claim, promptId, owner => {
      const envelope = parseSearchPublication(owner.envelopeJson);
      if (envelope.kind !== "discovery") throw new RunForbiddenError("A completed addDiscovery request is required");
      const proposal = envelope.proposal;
      requireSearchFullReads(this.db, owner, [proposal.thoughtId, ...proposal.evidenceThoughtIds]);
      const prior = this.receipt(owner, proposal);
      if (prior) return { receipt: prior, changed: false };
      requireCurrentSearchPublication(owner);
      const active = this.db.query("SELECT id FROM search_discoveries WHERE session_id=CAST(? AS TEXT) AND thought_id=CAST(? AS TEXT) AND removed_at IS NULL")
        .get(text(owner.sessionId), text(proposal.thoughtId)) as { id: string } | null;
      const entryId = active?.id ?? searchString(this.sources.id(), "discoveryId");
      const receipt: DiscoveryReceipt = Object.freeze({ type: "discovery-add", entryId, outcome: active ? "already-active" : "added" });
      const at = active ? null : searchRecordTime(this.sources.now());
      const publishing = this.recheck(claim, promptId);
      // The structural occurrence guard requires the owning completed step's matching result first.
      this.db.run("UPDATE run_steps SET result_json=CAST(? AS TEXT) WHERE run_id=CAST(? AS TEXT) AND prompt_id=CAST(? AS TEXT)",
        [text(protocolJson(receipt)), text(owner.runId), text(promptId)]);
      if (at !== null) {
        const position = searchRevision((this.db.query("SELECT COALESCE(MAX(position)+1,0) AS n FROM search_discoveries WHERE session_id=CAST(? AS TEXT)")
          .get(text(owner.sessionId)) as { n: number }).n);
        this.db.run(`INSERT INTO search_discoveries(id,session_id,thought_id,position,why,evidence_json,added_run_id,added_prompt_id,added_at)
          VALUES (CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),?,CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),?)`,
        [text(entryId), text(owner.sessionId), text(proposal.thoughtId), position, text(proposal.why), text(protocolJson(proposal.evidenceThoughtIds)), text(owner.runId), text(promptId), at]);
        this.dependencies(publishing, "discovery_id", entryId);
        this.recheck(claim, promptId, publishing);
        touchSearchSession(this.db, owner.sessionId, at);
      } else this.recheck(claim, promptId, publishing);
      return { receipt, changed: at !== null };
    });
    if (outcome.changed) this.logger.info("[search publication] discovery added", { runId: claim.runId, promptId, entryId: outcome.receipt.entryId });
    return outcome.receipt;
  }
  private dependencies(owner: SearchPublicationOwner, column: "message_id" | "discovery_id", id: string): void {
    const insert = this.db.query(`INSERT INTO search_content_dependencies(session_id,${column},ref_kind,ref_id)
      VALUES (CAST(? AS TEXT),CAST(? AS TEXT),?,CAST(? AS TEXT))`);
    for (const ref of owner.exposures) insert.run(text(owner.sessionId), text(id), ref.kind, text(ref.id));
  }
  finalizeReply(claim: Claim, promptId: string): void {
    this.guarded("finalize reply", claim, promptId, owner => {
      requireCurrentSearchPublication(owner);
      const envelope = parseSearchPublication(owner.envelopeJson);
      if (envelope.kind !== "reply" || owner.resultJson !== null) throw new RunForbiddenError("A completed search-reply is required");
      const reply = envelope.reply;
      requireSearchFullReads(this.db, owner, reply.sourceThoughtIds);
      const messageId = searchString(this.sources.id(), "assistantMessageId"), at = searchRecordTime(this.sources.now());
      const publishing = this.recheck(claim, promptId);
      const position = searchRevision((this.db.query("SELECT COALESCE(MAX(position)+1,0) AS n FROM search_messages WHERE session_id=CAST(? AS TEXT)")
        .get(text(owner.sessionId)) as { n: number }).n);
      this.db.run(`INSERT INTO search_messages(id,session_id,run_id,position,role,text,created_at,disposition,evidence_json)
        VALUES (CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),?,'assistant',CAST(? AS TEXT),?,?,CAST(? AS TEXT))`,
      [text(messageId), text(owner.sessionId), text(owner.runId), position, text(reply.reply), at, reply.disposition, text(protocolJson(reply.sourceThoughtIds))]);
      this.dependencies(publishing, "message_id", messageId);
      this.recheck(claim, promptId, publishing);
      touchSearchSession(this.db, owner.sessionId, at);
      searchRevision(owner.generation + 1);
      this.db.run("UPDATE runs SET status='completed',generation=generation+1 WHERE id=CAST(? AS TEXT)", [text(owner.runId)]);
    });
    this.logger.info("[search publication] reply finalized", { runId: claim.runId, promptId });
  }
}
