import type { Database } from "bun:sqlite";
import { RunConflictError, RunFenceError, RunForbiddenError, type Claim, type RunSources } from "../domain/run";
import { parseSearchCapabilityRequest, type SearchCapabilityRequest, type SearchCapabilityResult } from "../domain/search-capability";
import { readSearchCapabilityResult, searchCapabilityFullRead } from "../domain/search-capability-result";
import { SearchNotFoundError } from "../domain/search-session-guards";
import { protocolJson } from "../domain/run-protocol";
import { SqliteRunAggregate } from "./run-aggregate";
import { SqliteSearchInvestigation } from "./investigative-retrieval";
import { SqliteSearchRepository } from "./search";
import { SqliteSearchPublication } from "./search-publication";
import { requireCurrentSearchPublication, searchPublicationOwner } from "./search-publication-guard";
import { readSearchThoughtPreview } from "./search-workspace-content";
import { confirmSearchResult, searchResultReferences } from "./search-capability-result";
import { readSearchConnection, readSearchResponse } from "./search-library-read";
import { readSearchAgentConversation, readSearchAgentDiscoveries, readSearchTimeRange } from "./search-capability-context";

/** Trusted claim/persisted-prompt port, not actor-selected browser authority or an ordinary capability subtype. */
export class SqliteSearchCapabilityDispatcher extends SqliteRunAggregate {
  private readonly investigation: SqliteSearchInvestigation;
  private readonly publication: SqliteSearchPublication;
  constructor(db: Database, sources: RunSources) {
    super(db,sources.logger);
    this.investigation = new SqliteSearchInvestigation(db,new SqliteSearchRepository(db,undefined,this.logger),this.logger);
    this.publication = new SqliteSearchPublication(db,sources);
  }
  dispatch(claim: Claim, promptId: string): SearchCapabilityResult {
    const outcome = this.guardedExecution("dispatch search capability",claim,run => {
      if (run.kind !== "search") throw new RunForbiddenError("Search run authority required");
      const owner = searchPublicationOwner(this.db,claim,promptId);
      requireCurrentSearchPublication(owner);
      const step = this.currentStep(run.id);
      if (step.promptId !== promptId) throw new RunFenceError("Search capability prompt is no longer current");
      if (step.envelope?.kind !== "request") throw new RunConflictError("A completed search capability request is required");
      const request = parseSearchCapabilityRequest(step.envelope.request);
      // Publication owns its own transaction/fence. Do not wrap its commit-after-fence path in this transaction.
      if (request.capability === "addDiscovery") return { kind: "publication" } as const;
      if (step.result !== null) {
        const result = readSearchCapabilityResult(request,step.result);
        confirmSearchResult(this.db,run.id,result);
        return { kind: "result", result } as const;
      }
      const result = this.read(owner.sessionId,request);
      const canonical = readSearchCapabilityResult(request,result), fullRead = searchCapabilityFullRead(canonical);
      for (const ref of searchResultReferences(this.db,run.id,canonical)) this.track(run.id,ref,
        fullRead !== null && ref.kind === fullRead.kind && ref.id === fullRead.id);
      confirmSearchResult(this.db,run.id,canonical);
      this.db.run("UPDATE run_steps SET result_json=? WHERE run_id=? AND prompt_id=?",[protocolJson(canonical),run.id,promptId]);
      return { kind: "result", result: canonical } as const;
    });
    return outcome.kind === "publication" ? this.publication.addDiscovery(claim,promptId) : outcome.result;
  }
  private read(sessionId: string, request: Exclude<SearchCapabilityRequest, { capability: "addDiscovery" }>): SearchCapabilityResult {
    switch (request.capability) {
      case "findThoughts": return this.investigation.findThoughts(request.arguments);
      case "relatedThoughts": {
        const result = this.investigation.related(request.arguments);
        return result.type === "retrieval-changed" ? result : { type: "related", thoughtId: request.arguments.thoughtId,
          relation: request.arguments.relation, items: result.items, nextCursor: result.nextCursor };
      }
      case "readConnection": return { type: "connection-read", connection: readSearchConnection(this.db,request.arguments.id) };
      case "readResponse": return { type: "response", response: readSearchResponse(this.db,request.arguments.id) };
      case "readSearchConversation": return readSearchAgentConversation(this.db,sessionId,request.arguments.beforePosition,request.arguments.limit);
      case "listDiscoveries": return readSearchAgentDiscoveries(this.db,sessionId,request.arguments.afterPosition,request.arguments.limit);
      case "normalizeTimeRange": return readSearchTimeRange(this.db,sessionId,request.arguments);
      case "readThought":
        try {
          const offered = readSearchThoughtPreview(this.db,request.arguments.id);
          return { type: "thought", thought: offered.value.thought };
        } catch (error) {
          if (!(error instanceof SearchNotFoundError)) throw error;
          return { type: "thought", thought: null };
        }
    }
  }
}
