import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import type { AgentBindings, NativePhase, PersistedPrompt } from "../agent/opencode-adapter";
import { AgentBindingError, normalizeBinding, sameBinding, type AgentBinding } from "../agent/binding";
import { AgentUncertainError } from "../agent/errors";
import { requireOrdinaryRun, RunFenceError, type Claim, type RunRecord } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { SqliteRunAggregate } from "./run-aggregate";
import { readOwnedImportInput, type ImportOwnedStep } from "./import-authority";

/** Binding belongs to the existing run aggregate and uses authoritative core migration. */
export class SqliteAgentBindings extends SqliteRunAggregate implements AgentBindings {
  constructor(db: Database, logger: Logger = createLogger()) { super(db,logger); }
  bind(runId: string, input: AgentBinding, claim?: Claim): void {
    const binding = normalizeBinding(input);
    const valid = this.transaction("bind agent",runId,() => {
      const run = this.loadRun(runId);
      if (!run) throw new AgentBindingError("Run does not exist for agent binding");
      requireOrdinaryRun(run);
      if (claim !== undefined && claim.runId !== runId) throw new RunFenceError();
      this.active(claim ?? {runId,generation:run.generation});
      if (!this.contextValid(run,this.visibility())) { this.finalInterrupt(run); return false; }
      const saved = this.get(runId);
      if (saved) {
        if (!sameBinding(saved,binding)) throw new AgentBindingError("Agent binding is immutable");
        return true;
      }
      const step = this.currentStep(runId);
      if (run.status !== "queued" || step.position !== 0 || step.state !== "prepared" || run.nativeState !== "unknown") throw new AgentBindingError("Cannot infer a new binding for an already submitted run");
      this.db.run(`INSERT INTO agent_bindings (run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version)
        VALUES (?,?,?,?,?,?,?)`,[runId,binding.sessionId,binding.serviceUrl,binding.location.directory,protocolJson(binding.model),protocolJson(binding.permissions),binding.protocolVersion]);
      return true;
    });
    if (!valid) throw new RunFenceError();
  }
  get(runId: string): AgentBinding | null {
    const row = this.db.query(`SELECT session_id AS sessionId,service_url AS serviceUrl,directory,model_json AS model,
      permissions_json AS permissions,protocol_version AS protocolVersion FROM agent_bindings WHERE run_id=?`).get(runId) as {
      sessionId:string; serviceUrl:string; directory:string; model:string; permissions:string; protocolVersion:number;
    } | null;
    return row === null ? null : normalizeBinding({sessionId:row.sessionId,serviceUrl:row.serviceUrl,location:{directory:row.directory},
      model:JSON.parse(row.model),permissions:JSON.parse(row.permissions),protocolVersion:row.protocolVersion});
  }
  private importStep(claim: Claim): {readonly run:RunRecord;readonly step:ImportOwnedStep} {
    const run=this.active(claim);
    if (run.kind!=="import" || run.inputThoughtId!==null || this.contextRefs(run.id).length!==0 ||
      this.db.query(`SELECT 1 FROM runs WHERE id=? AND (weave_subject_id IS NOT NULL OR weave_trigger_id IS NOT NULL)
        UNION ALL SELECT 1 FROM run_operation_receipts WHERE run_id=? UNION ALL SELECT 1 FROM run_replies WHERE run_id=?
        UNION ALL SELECT 1 FROM run_issued_thoughts WHERE run_id=? LIMIT 1`).get(run.id,run.id,run.id,run.id)) throw new RunFenceError("Restricted import authority required");
    try {
      const {step}=readOwnedImportInput(this.db,run);
      if (step.input===null || step.result!==null || this.db.query("SELECT 1 FROM run_steps WHERE run_id=? AND envelope_json IS NOT NULL").get(run.id)) throw new RunFenceError("Import observation authority has ended or was not prepared");
      return {run,step};
    } catch { throw new RunFenceError("Import input ownership is unavailable"); }
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
    return this.guarded("authorize native call",claim,run => {
      if (prompt !== undefined) {
        const step = this.currentStep(run.id);
        if (step.promptId !== prompt.promptId || step.input !== prompt.input) throw new RunFenceError("Native call does not match the current persisted prompt");
      }
      if (phase === "quarantined") { this.finalInterrupt(run); return; }
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
        this.transitionNative(claim,"submitting",undefined,prompt.promptId);
      } else if (phase === "acknowledged") this.transitionNative(claim,"running",undefined,prompt.promptId);
      else if (phase === "running") this.transitionNative(claim,"running","running",prompt.promptId);
      else if (phase === "completed") this.transitionNative(claim,"uncertain","completed",prompt.promptId);
      else if (run.status !== "queued") this.transitionNative(claim,"uncertain",undefined,prompt.promptId);
    });
  }
}
