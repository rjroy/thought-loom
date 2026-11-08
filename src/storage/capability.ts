import type { Database } from "bun:sqlite";
import { capabilityOperation, parseCapabilityRequest, readCapabilityResult, type CapabilityDispatcher, type CapabilityResult, type ReadCapabilityRequest, type ReadCapabilityResult } from "../domain/capability";
import { RunConflictError, RunFenceError, RunForbiddenError, type Claim, type ContextRef, type RunSources } from "../domain/run";
import { stepOperationScope } from "../domain/run-operations";
import { protocolJson } from "../domain/run-protocol";
import { SearchService } from "../domain/search";
import { SqliteRunAggregate } from "./run-aggregate";
import { SqliteRunOperations } from "./run-operations";
import { SqliteSearchRepository } from "./search";

const scope = { actor: "ai", mode: "normal" } as const;

/** Extends run_context and the existing fenced transaction/effect boundary. */
export class SqliteCapabilityDispatcher extends SqliteRunAggregate implements CapabilityDispatcher {
  private readonly operations: SqliteRunOperations;
  private readonly search: SearchService;
  constructor(db: Database, sources: RunSources) {
    super(db,sources.logger);
    this.operations = new SqliteRunOperations(db,sources);
    this.search = new SearchService(new SqliteSearchRepository(db,undefined,sources.logger));
  }
  dispatch(claim: Claim, promptId: string, input: unknown): CapabilityResult {
    return this.guarded("dispatch capability",claim,run => {
      const request = parseCapabilityRequest(input);
      this.requireWeaveCapability(run,request.capability);
      if (run.promptId !== promptId) throw new RunFenceError("Capability belongs to an earlier prompt");
      const step = this.currentStep(run.id);
      if (step.input === null || step.state !== "completed" || step.envelope?.kind !== "request" || protocolJson(step.envelope.request) !== protocolJson(request)) {
        throw new RunConflictError("Capability differs from the completed prompt request");
      }
      const operation = capabilityOperation(request);
      let result: CapabilityResult;
      if (operation !== null) {
        const { refs } = stepOperationScope(run,this.readWeaveIntent(run.id),operation);
        for (const id of refs) {
          if (!this.db.query("SELECT 1 FROM run_context WHERE run_id=? AND kind='thought' AND ref_id=? AND full_read=1").get(run.id,id)) {
            throw new RunForbiddenError("A full read is required before using a thought as evidence");
          }
        }
        // Same connection and outer transaction: effect, typed receipt, issued order, exposures and result commit together.
        result = this.operations.executeStep(claim,promptId,operation);
        if (result.type === "development" || result.type === "interpretation") this.trackThought(run.id,result.thought);
        else if (result.type === "connection") this.trackConnection(run.id,result.connection);
      } else {
        // The discriminated write cases have already been handled; check the remaining read shape.
        const read = this.readRequest(request);
        if (step.result !== null) return readCapabilityResult(read,step.result);
        result = this.read(run.id,read);
      }
      const encoded = protocolJson(result);
      if (step.result !== null && protocolJson(step.result) !== encoded) throw new RunConflictError("Dispatched capability result differs");
      this.db.run("UPDATE run_steps SET result_json=? WHERE run_id=? AND prompt_id=?",[encoded,run.id,promptId]);
      return result;
    });
  }
  private readRequest(request: ReturnType<typeof parseCapabilityRequest>): ReadCapabilityRequest {
    if (request.capability === "search" || request.capability === "readThought" || request.capability === "readConnection" || request.capability === "readResponse") return request;
    throw new RunForbiddenError();
  }
  private read(runId: string, request: ReadCapabilityRequest): ReadCapabilityResult {
    const rejection = this.rejection();
    if (request.capability === "search") {
      const candidates = this.search.query(scope,request.arguments.query).results.map(({kind,id,thoughtId,title,author,snippet}) => ({kind,id,thoughtId,title,author,snippet}));
      for (const candidate of candidates) {
        this.track(runId,{kind:candidate.kind,id:candidate.id});
        this.track(runId,{kind:"thought",id:candidate.thoughtId});
      }
      return { type: "search", candidates };
    }
    if (request.capability === "readThought") {
      const thought = rejection.listThoughts(scope).find(item => item.id === request.arguments.id) ?? null;
      if (thought) this.trackThought(runId,thought);
      return { type: "thought", thought };
    }
    if (request.capability === "readConnection") {
      const connection = rejection.listConnections(scope).find(item => item.id === request.arguments.id) ?? null;
      if (connection) this.trackConnection(runId,connection);
      return { type: "connection-read", connection };
    }
    const response = rejection.getResponse(scope,request.arguments.id);
    if (response) this.trackResponse(runId,response);
    return { type: "response", response };
  }
  fullReadWitnesses(runId: string): readonly ContextRef[] {
    return this.db.query("SELECT kind,ref_id AS id FROM run_context WHERE run_id=? AND full_read=1 ORDER BY rowid").all(runId) as ContextRef[];
  }
}
