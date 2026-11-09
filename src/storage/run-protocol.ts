import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { requireExecutionRun, RunConflictError, RunFenceError, RunForbiddenError, type Claim, type RunRecord } from "../domain/run";
import { parseEnvelope, protocolJson, type CancellationState, type NextStep, type ProtocolEnvelope, type RunProtocolRepository, type RunStep } from "../domain/run-protocol";
import { nonEmpty } from "../domain/validation";
import { SqliteRunAggregate } from "./run-aggregate";
import { isSearchOnlyCapability, parseSearchCapabilityRequest, searchCapabilityResultInput } from "../domain/search-capability";
import { readSearchCapabilityResult } from "../domain/search-capability-result";
import { searchString } from "../domain/search-session-guards";
import { confirmSearchResult } from "./search-capability-result";
import { requireCurrentSearchPublication, requireSearchFullReads, searchPublicationOwner } from "./search-publication-guard";
import { retainedSearchSuccessorClock, type SqliteSearchPromptClock } from "./search-prompt-clock";
import { assertRunNotRestoreFenced } from "./restore-fences";
import { assertImportRunNotRestoreFenced } from "./import-authority";

/** Extends the existing run aggregate, core migration, transaction and claim fencing; no independent run state. */
export class SqliteRunProtocolRepository extends SqliteRunAggregate implements RunProtocolRepository {
  constructor(db: Database, logger: Logger = createLogger(), private readonly searchClock?: SqliteSearchPromptClock) { super(db,logger); }
  steps(runId: string): readonly RunStep[] {
    return this.transaction("read steps",runId,() => { requireExecutionRun(this.require(runId)); return this.readSteps(runId); });
  }
  private current(run: RunRecord, promptId: string): RunStep {
    if (run.promptId !== promptId) throw new RunFenceError("Prompt is no longer current");
    return this.currentStep(run.id);
  }
  prepare(claim: Claim, input: NextStep): RunStep {
    const prepared = this.guarded("prepare prompt",claim,run => {
      const promptId = nonEmpty(input.promptId,"promptId");
      const text = nonEmpty(input.input,"input");
      const step = this.current(run,promptId);
      if (step.input !== null) {
        if (step.input !== text) throw new RunConflictError("Prompt input differs from prepared input");
        return step;
      }
      if (step.state !== "prepared" || run.status !== "queued" || run.nativeState !== "unknown") throw new RunConflictError("Legacy prompt input is unknown and cannot be replaced");
      this.db.run("UPDATE run_steps SET input=? WHERE run_id=? AND prompt_id=?",[text,run.id,promptId]);
      return { ...step, input: text };
    });
    this.logger.verbose("[run storage] prompt input confirmed", { runId: claim.runId, promptId: prepared.promptId, position: prepared.position, state: prepared.state });
    return prepared;
  }
  setStepState(claim: Claim, promptId: string, state: "submitting" | "uncertain"): void {
    this.guarded("prompt state",claim,run => {
      const step = this.current(run,promptId);
      if (step.input === null) throw new RunConflictError("Exact prompt input was not retained");
      const allowed = state === "submitting" ? step.state === "prepared" : state === "uncertain" && ["submitting","uncertain"].includes(step.state);
      if (!allowed) throw new RunConflictError("Invalid prompt transition");
      this.db.run("UPDATE run_steps SET state=? WHERE run_id=? AND prompt_id=?",[state,run.id,promptId]);
      this.db.run("UPDATE runs SET status=? WHERE id=?",[state,run.id]);
    });
    this.logger.verbose("[run storage] prompt state committed", { runId: claim.runId, promptId, state, generation: claim.generation });
  }
  completeStep(claim: Claim, promptId: string, envelope: ProtocolEnvelope): void {
    const kind = this.guardedExecution("complete prompt",claim,run => {
      const step = this.current(run,promptId);
      const value = parseEnvelope(protocolJson(envelope));
      if (run.kind === "search") {
        if (value.kind === "request") parseSearchCapabilityRequest(value.request);
        else if (value.kind !== "search-reply") throw new RunForbiddenError("Search envelope authority required");
      } else if (value.kind === "search-reply" ||
          (value.kind === "request" && isSearchOnlyCapability(value.request.capability))) {
        throw new RunForbiddenError("Search run authority required");
      }
      if ((value.kind === "report" && run.kind !== "export") || (value.kind === "complete" && run.kind === "export")) {
        throw new RunForbiddenError("Final envelope does not match the run kind");
      }
      const encoded = protocolJson(value);
      if (step.envelope !== null) {
        if (protocolJson(step.envelope) !== encoded) throw new RunConflictError("Completed prompt envelope differs");
        return value.kind;
      }
      this.db.run("UPDATE run_steps SET state='completed',native_state='completed',envelope_json=? WHERE run_id=? AND prompt_id=?",[encoded,run.id,promptId]);
      // Native completion settles this prompt only. Canonical user reply finalization is a separate run operation.
      this.db.run("UPDATE runs SET status='uncertain' WHERE id=?",[run.id]);
      return value.kind;
    });
    this.logger.verbose("[run storage] prompt completion confirmed", { runId: claim.runId, promptId, kind, generation: claim.generation });
  }
  advance(claim: Claim, promptId: string, result: unknown, next: NextStep): RunStep {
    const successor = this.guarded<RunStep>("advance prompt",claim,run => {
      const step = this.readStep(run.id,promptId);
      if (!step) throw new RunConflictError("Prompt does not belong to this run");
      if (step.envelope?.kind === "request") this.requireWeaveCapability(run,step.envelope.request.capability);
      const resultJson = this.confirmedStepResult(step,result);
      const nextPromptId = nonEmpty(next.promptId,"promptId");
      const nextInput = nonEmpty(next.input,"input");
      if (step.state === "processed") {
        const successor = this.readStep(run.id,nextPromptId);
        if (protocolJson(step.result) !== resultJson || !successor || successor.position !== step.position+1 || successor.input !== nextInput) {
          throw new RunConflictError("Processed prompt result or successor differs");
        }
        return successor;
      }
      this.current(run,promptId);
      if (step.state !== "completed" || step.envelope?.kind !== "request") throw new RunConflictError("Only a completed capability request can advance");
      return this.appendSuccessor(run,step,resultJson,nextPromptId,nextInput);
    });
    this.logger.verbose("[run storage] prompt successor confirmed", { runId: claim.runId, from: promptId, to: successor.promptId, position: successor.position, generation: claim.generation });
    return successor;
  }
  /** Search cannot supply result or next-input bytes: derive them from its confirmed, fenced step journal. */
  advanceSearch(claim: Claim, promptId: string, nextPromptId: () => string): RunStep {
    const prepared = this.guardedExecution("advance search prompt",claim,run => {
      if (run.kind !== "search") throw new RunForbiddenError("Search run authority required");
      const owner = searchPublicationOwner(this.db,claim,promptId), step = this.readStep(run.id,promptId);
      if (!step || step.envelope?.kind !== "request" || step.result === null) throw new RunConflictError("Confirmed search capability result required");
      const request = parseSearchCapabilityRequest(step.envelope.request), result = readSearchCapabilityResult(request,step.result);
      confirmSearchResult(this.db,run.id,result);
      if (request.capability === "addDiscovery") requireSearchFullReads(this.db,owner,[request.arguments.thoughtId,...request.arguments.evidenceThoughtIds]);
      const resultJson = protocolJson(result);
      if (protocolJson(step.result) !== resultJson) throw new RunConflictError("Retained search result differs from its canonical form");
      if (step.state === "processed") {
        const row = this.db.query("SELECT prompt_id AS promptId FROM run_steps WHERE run_id=? AND position=?").get(run.id,step.position+1) as {promptId:string} | null;
        const existing = row ? this.readStep(run.id,row.promptId) : null;
        if (!existing || existing.input !== searchCapabilityResultInput(request,result,retainedSearchSuccessorClock(this.db,run,existing))) {
          throw new RunConflictError("Search successor differs from its confirmed result");
        }
        return { step: existing, clock: null };
      }
      requireCurrentSearchPublication(owner);
      if (!this.searchClock) throw new RunConflictError("Search successor clock preparation is required");
      const identity = searchString(nextPromptId(),"prompt ID");
      if (!identity.startsWith("msg_")) throw new RunConflictError("Search prompt requires its native message prefix");
      const clock = this.searchClock.prepare(run,step,identity), input = searchCapabilityResultInput(request,result,clock.context ?? undefined);
      return { step: this.appendSuccessor(run,step,resultJson,identity,input), clock };
    });
    prepared.clock?.committed();
    const successor = prepared.step;
    this.logger.verbose("[run storage] search prompt successor confirmed",{runId:claim.runId,from:promptId,to:successor.promptId,position:successor.position,generation:claim.generation});
    return successor;
  }
  private appendSuccessor(run: RunRecord, step: RunStep, resultJson: string, promptId: string, input: string): RunStep {
    if (this.db.query("SELECT 1 FROM run_steps WHERE prompt_id=?").get(promptId)) throw new RunConflictError("Prompt identity already issued");
    this.db.run("UPDATE run_steps SET state='processed',result_json=? WHERE run_id=? AND prompt_id=?",[resultJson,run.id,step.promptId]);
    this.db.run("INSERT INTO run_steps (run_id,position,prompt_id,input,state,native_state) VALUES (?,?,?,?,'prepared','unknown')",
      [run.id,step.position+1,promptId,input]);
    this.db.run("UPDATE runs SET status='queued' WHERE id=?",[run.id]);
    return { runId: run.id, position: step.position+1, promptId, input, state: "prepared", envelope: null, result: null };
  }
  cancellation(runId: string): CancellationState {
    this.require(runId);
    const row = this.db.query("SELECT cancellation_state AS state FROM runs WHERE id=?").get(runId) as { state: CancellationState };
    return row.state;
  }
  settleCancellation(runId: string): void {
    this.transaction("settle cancellation",runId,() => {
      assertRunNotRestoreFenced(this.db,runId);
      const run = this.require(runId);
      if (run.kind === "import") assertImportRunNotRestoreFenced(this.db,runId);
      if (run.kind === "search") throw new RunForbiddenError("Search cancellation requires owned drain evidence");
      if (run.status !== "interrupted" && run.status !== "failed" && !(run.kind === "import" && run.status === "completed")) throw new RunFenceError("Only fenced runs have native cancellation to settle");
      const state = this.cancellation(runId);
      if (state === "settled") return;
      if (state !== "pending") throw new RunConflictError("No pending native cancellation");
      this.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=?",[runId]);
    });
  }
}
