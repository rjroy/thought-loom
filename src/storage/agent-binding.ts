import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import type { AgentBindings, NativePhase, PersistedPrompt } from "../agent/opencode-adapter";
import { AgentBindingError, normalizeBinding, sameBinding, type AgentBinding } from "../agent/binding";
import { AgentUncertainError } from "../agent/errors";
import { requireOrdinaryRun, RunFenceError, type Claim } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { SqliteRunAggregate } from "./run-aggregate";

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
