import { createLogger, type Logger } from "../logging";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AgentBindings, NativePhase, PersistedPrompt } from "../agent/opencode-adapter";
import { AgentBindingError, allowsNativeTools, assertBindingPermissions, normalizeBinding, sameBinding, type AgentBinding } from "../agent/binding";
import { AgentUncertainError } from "../agent/errors";
import { requireExecutionRun, RunFenceError, type Claim, type RunRecord } from "../domain/run";
import { protocolJson, ProtocolValidationError, type OrdinaryCancellationJournal } from "../domain/run-protocol";
import { ImportPreservationError } from "../domain/markdown-import-contract";
import { ValidationError } from "../domain/validation";
import { SqliteRunAggregate } from "./run-aggregate";
import { assertImportRunNotRestoreFenced, readOwnedImportInput, type ImportOwnedStep } from "./import-authority";
import { ExecutionOwnerLease } from "./execution-owner";
import { readAgentBinding } from "./run-record";
import { assertOrdinaryCancellationJournal, ordinaryCancellationJournal } from "./run-cancellation";
import { weaveDispatchAllowed } from "./weave-work";
import { assertRunNotRestoreFenced } from "./restore-fences";

// Isolated workers without a deployed lease remain explicitly unqualified. Never backfill this into the registry.
const processSubmitOwner = randomUUID();

/** Binding belongs to the existing run aggregate and uses authoritative core migration. */
export class SqliteAgentBindings extends SqliteRunAggregate implements AgentBindings {
  constructor(db: Database, logger: Logger = createLogger(), private readonly executionOwner?: ExecutionOwnerLease) {
    super(db,logger);
    if (executionOwner !== undefined) {
      if (!(executionOwner instanceof ExecutionOwnerLease)) throw new RunFenceError("A runtime lease capability is required");
      executionOwner.assertRegistered(db);
    }
  }
  bind(runId: string, input: AgentBinding, claim?: Claim): void {
    const binding = normalizeBinding(input);
    const valid = this.transaction("bind agent",runId,() => {
      assertRunNotRestoreFenced(this.db,runId);
      const run = this.loadRun(runId);
      if (!run) throw new AgentBindingError("Run does not exist for agent binding");
      requireExecutionRun(run);
      assertBindingPermissions(run.kind,binding);
      if (run.kind === "search") this.executionOwner?.assertRegistered(this.db);
      if (run.kind === "search" && binding.sessionId !== run.sessionId) throw new AgentBindingError("Search binding must use its allocated native identity");
      if (claim !== undefined && claim.runId !== runId) throw new RunFenceError();
      this.active(claim ?? {runId,generation:run.generation});
      if (!this.contextValid(run,this.visibility())) { this.finalInterrupt(run,"context-invalidated"); return false; }
      const saved = this.get(runId);
      if (saved) {
        if (!sameBinding(saved,binding)) throw new AgentBindingError("Agent binding is immutable");
        return true;
      }
      const step = this.currentStep(runId);
      if (run.status !== "queued" || step.position !== 0 || step.state !== "prepared" || run.nativeState !== "unknown") throw new AgentBindingError("Cannot infer a new binding for an already submitted run");
      this.db.run(`INSERT INTO agent_bindings (run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version,execution_owner_id)
        VALUES (?,?,?,?,?,?,?,?)`,[runId,binding.sessionId,binding.serviceUrl,binding.location.directory,protocolJson(binding.model),protocolJson(binding.permissions),binding.protocolVersion,
           run.kind === "search" ? this.executionOwner?.id ?? null : null]);
      this.logger.info("[agent] native binding applied in transaction",{runId,kind:run.kind,nativeTools:allowsNativeTools(binding)});
      return true;
    });
    if (!valid) throw new RunFenceError();
  }
  get(runId: string): AgentBinding | null {
    return readAgentBinding(this.db,runId);
  }
  cancellationJournal(runId: string, prompt: PersistedPrompt): OrdinaryCancellationJournal {
    this.executionOwner?.assertHeld();
    return this.transaction("read ordinary cancellation journal",runId,() => {
      const journal = ordinaryCancellationJournal(this.db,runId), current = journal.steps.at(-1);
      if (!this.get(runId) || current?.promptId !== prompt.promptId || current.input !== prompt.input) throw new RunFenceError();
      return journal;
    });
  }
  assertCancellationJournal(journal: OrdinaryCancellationJournal): void {
    this.executionOwner?.assertHeld();
    this.transaction("authorize ordinary cancellation",journal.runId,() => {
      assertOrdinaryCancellationJournal(this.db,journal);
    });
  }
  private importStep(claim: Claim): {readonly run:RunRecord;readonly step:ImportOwnedStep} {
    const run=this.active(claim);
    if (run.kind!=="import" || run.inputThoughtId!==null || this.contextRefs(run.id).length!==0 ||
      this.db.query(`SELECT 1 FROM runs WHERE id=? AND (weave_subject_id IS NOT NULL OR weave_trigger_id IS NOT NULL)
        UNION ALL SELECT 1 FROM run_operation_receipts WHERE run_id=? UNION ALL SELECT 1 FROM run_replies WHERE run_id=?
        UNION ALL SELECT 1 FROM run_issued_thoughts WHERE run_id=? LIMIT 1`).get(run.id,run.id,run.id,run.id)) throw new RunFenceError("Restricted import authority required");
    let step: ImportOwnedStep;
    try { ({step}=readOwnedImportInput(this.db,run)); }
    catch (error) {
      if (error instanceof RunFenceError || error instanceof ImportPreservationError || error instanceof ValidationError ||
        error instanceof ProtocolValidationError || error instanceof SyntaxError) throw new RunFenceError("Import input ownership is unavailable");
      throw error;
    }
    if (step.input===null || step.result!==null || this.db.query("SELECT 1 FROM run_steps WHERE run_id=? AND envelope_json IS NOT NULL").get(run.id)) throw new RunFenceError("Import observation authority has ended or was not prepared");
    return {run,step};
  }
  private matchImportPrompts(step: ImportOwnedStep, prompts: readonly PersistedPrompt[]): void {
    try {
      if (protocolJson(prompts)===protocolJson([{promptId:step.promptId,input:step.input}])) return;
    } catch { /* A non-JSON prompt sequence cannot carry persisted authority. */ }
    throw new RunFenceError("Import prompt history differs from persisted input");
  }
  /** Trusted preparation path, not a caller-selected mode on ordinary bind(). No native call occurs here. */
  bindImport(claim: Claim, input: AgentBinding): void {
    const binding=normalizeBinding(input);
    this.transaction("bind import agent",claim.runId,() => {
      const {run,step}=this.importStep(claim);
      assertBindingPermissions(run.kind,binding);
      const saved=this.get(run.id);
      if (saved) {
        if (!sameBinding(saved,binding)) throw new AgentBindingError("Agent binding is immutable");
        return;
      }
      if (run.status!=="queued" || step.state!=="prepared" || step.nativeState!=="unknown") throw new RunFenceError("Import binding requires a never-submitted initial step");
      this.db.run(`INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version)
        VALUES (?,?,?,?,?,?,?)`,[run.id,binding.sessionId,binding.serviceUrl,binding.location.directory,protocolJson(binding.model),protocolJson(binding.permissions),binding.protocolVersion]);
      this.logger.info("[import] native binding retained",{runId:run.id,sessionId:binding.sessionId});
    });
  }
  /** Persist intent before a future import transport sends this exact prompt. It never submits anything itself. */
  recordImportSubmission(claim: Claim, prompt: PersistedPrompt): void {
    this.transaction("record import submission intent",claim.runId,() => {
      const {run,step}=this.importStep(claim);
      this.matchImportPrompts(step,[prompt]);
      if (!this.get(run.id) || run.status!=="queued" || step.state!=="prepared" || step.nativeState!=="unknown") throw new RunFenceError("Import submission requires its prepared immutable binding");
      this.db.run("UPDATE run_steps SET state='submitting' WHERE run_id=? AND position=0",[run.id]);
      this.db.run("UPDATE runs SET status='submitting' WHERE id=?",[run.id]);
      this.logger.info("[import] submission intent retained",{runId:run.id,promptId:step.promptId,generation:claim.generation});
    });
  }
  /** Session setup and initial dispatch require the same never-submitted, exact prepared input. */
  assertImportPreparation(claim: Claim, prompts: readonly PersistedPrompt[]): void {
    this.transaction("authorize import preparation",claim.runId,() => {
      const {run,step}=this.importStep(claim);
      this.matchImportPrompts(step,prompts);
      if (!this.get(run.id) || run.status!=="queued" || step.state!=="prepared" || step.nativeState!=="unknown") throw new RunFenceError("Import preparation requires a never-submitted binding");
    });
  }
  private submittedImport(claim: Claim, prompts: readonly PersistedPrompt[]): {readonly run:RunRecord;readonly step:ImportOwnedStep} {
    const owned=this.importStep(claim), {run,step}=owned;
    this.matchImportPrompts(step,prompts);
    if (!this.get(run.id) || !["submitting","running","uncertain"].includes(run.status) ||
      !["submitting","uncertain"].includes(step.state) || !["unknown","running"].includes(step.nativeState)) throw new RunFenceError("Import observation requires recorded submission intent");
    return owned;
  }
  /** Read-only observation gate. Stop, another generation, file settlement or durable choice revoke it. */
  assertImportOwnership(claim: Claim, prompts: readonly PersistedPrompt[]): void {
    this.transaction("authorize import observation",claim.runId,() => { this.submittedImport(claim,prompts); });
  }
  /** Nonterminal import observations use existing native vocabulary, never ordinary NativePhase dispatch. */
  recordImportObservation(claim: Claim, prompts: readonly PersistedPrompt[], state: "pending" | "running" | "uncertain"): void {
    this.transaction("record import observation",claim.runId,() => {
      const {run,step}=this.submittedImport(claim,prompts), running=state==="running";
      const status=running ? "running" : "uncertain";
      if (run.status===status && step.state==="uncertain" && (!running || step.nativeState==="running")) return;
      this.db.run("UPDATE run_steps SET state='uncertain',native_state=CASE WHEN ? THEN 'running' ELSE native_state END WHERE run_id=? AND position=0",[running ? 1 : 0,claim.runId]);
      this.db.run("UPDATE runs SET status=? WHERE id=?",[status,claim.runId]);
      this.logger.info("[import] native observation retained",{runId:run.id,promptId:step.promptId,status,nativeState:running ? "running" : step.nativeState});
    });
  }
  assertImportCancellation(claim: Claim, prompt: PersistedPrompt): void {
    this.transaction("authorize import cleanup",claim.runId,() => {
      assertImportRunNotRestoreFenced(this.db,claim.runId);
      const run=this.require(claim.runId);
      if (run.kind!=="import" || run.generation!==claim.generation || !["completed","failed","interrupted"].includes(run.status) || !this.get(run.id)) throw new RunFenceError();
      const step=this.db.query(`SELECT s.position,s.prompt_id AS promptId,s.input,s.state,s.native_state AS nativeState,s.result_json AS result
        FROM run_steps s JOIN runs r ON r.id=s.run_id JOIN markdown_import_files f ON f.run_id=r.id
        WHERE r.id=? AND r.cancellation_state='pending' AND f.outcome IS NOT NULL AND s.position=0 AND s.prompt_id=r.prompt_id
          AND NOT EXISTS(SELECT 1 FROM run_steps later WHERE later.run_id=r.id AND later.position!=0)`).get(run.id) as ImportOwnedStep|null;
      if (!step || step.input===null) throw new RunFenceError();
      this.matchImportPrompts(step,[prompt]);
    });
  }
  /** Adapter callback: short transaction checks ownership/context and supplies immutable ordered inputs when requested. */
  assertActive(claim: Claim, prompt?: PersistedPrompt, phase?: NativePhase): readonly PersistedPrompt[] | void {
    return this.guardedExecution("authorize native call",claim,run => {
      if (run.kind === "search") this.executionOwner?.assertRegistered(this.db);
      if (prompt !== undefined) {
        const step = this.currentStep(run.id);
        if (step.promptId !== prompt.promptId || step.input !== prompt.input) throw new RunFenceError("Native call does not match the current persisted prompt");
      }
      if (phase === "quarantined") {
        this.finalInterrupt(run,run.kind === "search" ? "failed" : "stopped");
        if (run.kind === "search") this.db.run("UPDATE runs SET status='failed' WHERE id=?",[run.id]);
        return;
      }
      if (phase === undefined) return;
      if (!prompt) throw new RunFenceError("Prompt identity is required for a native transition");
      if (phase === "history") {
        const inputs = this.db.query("SELECT prompt_id AS promptId,input FROM run_steps WHERE run_id=? ORDER BY position").all(run.id) as {promptId:string;input:string|null}[];
        return Object.freeze(inputs.map(input => {
          if (input.input === null) throw new AgentBindingError("Exact prior prompt input was not retained");
          return Object.freeze({promptId:input.promptId,input:input.input});
        }));
      } else if (phase === "submit") {
        if (run.status !== "queued" || this.currentStep(run.id).state !== "prepared") throw new AgentUncertainError("Native attempt is already recorded; observe it instead of resubmitting");
        if (run.kind === "weave" && !weaveDispatchAllowed(this.db,run.id)) throw new RunFenceError("Subject weave dispatch is postponed");
        if (run.kind === "search") {
          if (!this.get(run.id)) throw new RunFenceError("Search submission requires its bound owner");
          const submitOwner = this.executionOwner?.id ?? processSubmitOwner;
          this.db.run("UPDATE run_steps SET state='submitting',submit_owner=? WHERE run_id=? AND prompt_id=?",[submitOwner,run.id,prompt.promptId]);
          this.db.run("UPDATE runs SET status='submitting' WHERE id=?",[run.id]);
          this.logger.info("[search execution] submission authorization applied in transaction",{runId:run.id,promptId:prompt.promptId,generation:claim.generation});
        } else this.transitionNative(claim,"submitting",undefined,prompt.promptId);
      } else if (phase === "acknowledged") this.transitionNative(claim,"running",undefined,prompt.promptId);
      else if (phase === "running") this.transitionNative(claim,"running","running",prompt.promptId);
      else if (phase === "completed") this.transitionNative(claim,"uncertain","completed",prompt.promptId);
      else if (run.status !== "queued") this.transitionNative(claim,"uncertain",undefined,prompt.promptId);
    });
  }
}
