import { SQLiteError, type Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createLogger, type Logger } from "../logging";
import { RunFenceError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import { ValidationError } from "../domain/validation";
import { ImportConflictError, ImportPreservationError, partitionMarkdown, prepareMarkdown, validateMarkdownSelection,
  type ImportEvidence, type ImportFailureCode, type PreparedMarkdown, type Segmentation } from "../domain/markdown-import";
import { SqliteMarkdownImports, type ImportLocalWork } from "../storage/markdown-import";
import { SqliteAgentBindings } from "../storage/agent-binding";
import { SqliteRunRepository } from "../storage/run";
import { SqliteRunProtocolRepository } from "../storage/run-protocol";
import { AgentBindingError } from "./binding";
import { AgentUnavailableError, AgentUncertainError } from "./errors";
import type { AgentBinding, ImportObservation, PersistedPrompt } from "./opencode-adapter";

export interface ImportNative {
  bindingFor(run: RunRecord): Promise<AgentBinding>;
  ensureSession(claim: Claim, binding: AgentBinding, prompt: PersistedPrompt): Promise<void>;
  submit(claim: Claim, binding: AgentBinding, prompt: PersistedPrompt): Promise<void>;
  observe(claim: Claim, binding: AgentBinding, prompts: readonly PersistedPrompt[]): Promise<ImportObservation>;
  cancel(claim: Claim, binding: AgentBinding, prompt: PersistedPrompt): Promise<"pending" | "settled">;
}
export interface ImportWorkerDependencies extends RunSources {
  readonly db: Database;
  readonly native?: (bindings: SqliteAgentBindings, localFence: () => void) => ImportNative;
}
export const importTurn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
export const importBusy = (error: unknown): boolean => error instanceof SQLiteError && typeof error.code==="string" && (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"));
const terminal = (run: RunRecord): boolean => ["completed","failed","interrupted"].includes(run.status);
const inputHash = (input: string): string => createHash("sha256").update(input).digest("hex");

/** One local/native import implementation over the existing immutable run journal, never ordinary knowledge operations. */
export class MarkdownImportWorker {
  private readonly imports: SqliteMarkdownImports;
  private readonly bindings: SqliteAgentBindings;
  private readonly runs: SqliteRunRepository;
  private readonly protocol: SqliteRunProtocolRepository;
  private readonly logger: Logger;
  private readonly owners = new Map<string,Claim>();
  private readonly fenced = new Set<string>();
  private readonly unavailable = new Set<string>();
  private native: ImportNative | undefined;
  private paused = false;
  constructor(private readonly dependencies: ImportWorkerDependencies) {
    this.logger=dependencies.logger ?? createLogger();
    this.imports=new SqliteMarkdownImports(dependencies.db,dependencies);
    this.bindings=new SqliteAgentBindings(dependencies.db,this.logger);
    this.runs=new SqliteRunRepository(dependencies.db,dependencies);
    this.protocol=new SqliteRunProtocolRepository(dependencies.db,this.logger);
  }
  candidates(after: number, through: number | null, limit: number) {
    return this.dependencies.native ? this.imports.nativeCandidates(after,through,limit) : this.imports.localCandidates(after,through,limit);
  }
  private localFence(): void { if (this.paused) throw new RunFenceError("Import worker is paused"); }
  private transport(): ImportNative {
    const factory=this.dependencies.native;
    if (!factory) throw new AgentUnavailableError("Import agent is unconfigured");
    return this.native ??= factory(this.bindings,() => this.localFence());
  }
  private assertCurrent(claim: Claim): void {
    this.localFence();
    const run=this.runs.get(claim.runId);
    if (!run || run.generation!==claim.generation || terminal(run)) throw new RunFenceError();
  }
  async tick(work: ImportLocalWork): Promise<void> {
    if (this.paused) return;
    let claim=this.owners.get(work.runId);
    let phase="claim";
    try {
      const run=this.runs.get(work.runId);
      if (!run || run.kind!=="import") return;
      if (terminal(run)) { this.owners.delete(run.id); await this.cancel(run); return; }
      if (this.fenced.has(run.id)) return;
      if (!claim) {
        claim=this.dependencies.native ? this.imports.claimNative(work) ?? undefined : this.imports.claimLocal(work)?.claim;
        if (!claim) { this.fenced.add(run.id); return; }
        this.owners.set(run.id,claim);
      }
      this.assertCurrent(claim);
      const progress=this.imports.progress(claim);
      if (!progress.chosen) {
        phase="input";
        const source=this.imports.privateInput(claim);
        phase="parse";
        const prepared=prepareMarkdown(source.bytes);
        await importTurn(); this.assertCurrent(claim);
        phase="prepare";
        this.imports.prepare(claim,prepared.manifest);
        const input=this.imports.privateInput(claim);
        if (input.input===null) throw new ImportPreservationError("Prepared import input is missing");
        const prompt={promptId:input.promptId,input:input.input};
        phase="selection";
        const selected=await this.select(claim,run,prompt,source.bytes,prepared,progress.submitted);
        if (!selected) return;
        claim=selected;
        this.owners.set(run.id,claim);
      }
      await importTurn(); this.assertCurrent(claim);
      phase="finalize";
      const result=this.imports.finalize(claim);
      this.owners.delete(work.runId); this.unavailable.delete(work.runId);
      this.logger.info("[import worker] file completed",{runId:work.runId,fileId:work.fileId,thoughtCount:result.thoughtCount});
    } catch (error) {
      if (this.paused) return;
      if (importBusy(error)) { this.logger.warning("[import worker] local work busy",{runId:work.runId,phase}); return; }
      if (!claim) { this.logger.error("[import worker] claim failed",{runId:work.runId}); return; }
      const current=this.runs.get(work.runId);
      if (error instanceof RunFenceError && (!current || terminal(current) || current.generation!==claim.generation)) {
        this.fenced.add(work.runId); this.owners.delete(work.runId); return;
      }
      const code: ImportFailureCode=error instanceof AgentBindingError || error instanceof RunFenceError ? "ownership-conflict" :
        error instanceof ImportPreservationError ? "preservation-failed" : error instanceof ImportConflictError ? "ownership-conflict" :
        phase==="parse" ? "parse-failed" : "persistence-failed";
      try { this.imports.fail(claim,code); this.owners.delete(work.runId); }
      catch (failure) {
        if (failure instanceof RunFenceError) this.fenced.add(work.runId);
        else this.logger.error("[import worker] failure settlement deferred",{runId:work.runId,code});
      }
    }
  }
  private localChoice(claim: Claim, prompt: PersistedPrompt, bytes: Uint8Array, prepared: PreparedMarkdown, segmentation: Segmentation): Claim {
    this.assertCurrent(claim);
    return this.imports.choose(claim,partitionMarkdown(bytes,prepared,prepared.fallbackCuts,segmentation),
      {state:"not-submitted",promptId:prompt.promptId,inputSha256:inputHash(prompt.input)});
  }
  private async select(claim: Claim, run: RunRecord, prompt: PersistedPrompt, bytes: Uint8Array, prepared: PreparedMarkdown, submitted: boolean): Promise<Claim | null> {
    if (!submitted && prepared.manifest.atoms.length===0) return this.localChoice(claim,prompt,bytes,prepared,{method:"not-needed",reason:null});
    if (!this.dependencies.native) return submitted ? null : this.localChoice(claim,prompt,bytes,prepared,{method:"structural",reason:"ai-unconfigured"});
    const native=this.transport();
    let binding=this.bindings.get(run.id);
    if (!submitted) {
      try {
        if (!binding) {
          binding=await native.bindingFor(run); this.assertCurrent(claim);
          this.bindings.bindImport(claim,binding);
        }
        await native.ensureSession(claim,binding,prompt); this.assertCurrent(claim);
        await native.submit(claim,binding,prompt); this.assertCurrent(claim);
        // Successful dispatch without a committed intent must fail closed, not be sent again on the next poll.
        if (!this.imports.progress(claim).submitted) throw new ImportPreservationError("Import dispatch omitted durable intent");
        this.bindings.recordImportObservation(claim,[prompt],"pending");
        return null;
      } catch (error) {
        this.assertCurrent(claim);
        if (error instanceof AgentUnavailableError && !this.imports.progress(claim).submitted) {
          return this.localChoice(claim,prompt,bytes,prepared,{method:"structural",reason:"ai-unavailable"});
        }
        if (!(error instanceof AgentUnavailableError || error instanceof AgentUncertainError)) throw error;
        if (this.imports.progress(claim).submitted) this.bindings.recordImportObservation(claim,[prompt],"uncertain");
        this.outage(run.id); return null;
      }
    }
    if (!binding) throw new AgentBindingError("Submitted import has no immutable native binding");
    let observed: ImportObservation;
    try { observed=await native.observe(claim,binding,[prompt]); this.assertCurrent(claim); }
    catch (error) {
      this.assertCurrent(claim);
      if (!(error instanceof AgentUnavailableError || error instanceof AgentUncertainError)) throw error;
      this.bindings.recordImportObservation(claim,[prompt],"uncertain"); this.outage(run.id); return null;
    }
    this.bindings.assertImportOwnership(claim,[prompt]);
    if (observed.state==="quarantined") throw new AgentBindingError("Import native ownership is quarantined");
    if (observed.state!=="terminal-failure" && observed.state!=="terminal-completion") {
      this.bindings.recordImportObservation(claim,[prompt],observed.state); return null;
    }
    if (this.unavailable.delete(run.id)) this.logger.info("[import worker] native service recovered",{runId:run.id});
    let segmentation: Segmentation={method:"structural",reason:observed.state==="terminal-failure" ? "ai-failed" : "ai-invalid"};
    let cuts=prepared.fallbackCuts;
    if (observed.state==="terminal-completion" && observed.evidence.finish==="stop") {
      try { cuts=validateMarkdownSelection(prepared.manifest,observed.output); segmentation={method:"ai",reason:null}; }
      catch (error) { if (!(error instanceof ValidationError)) throw error; }
    }
    const evidence: ImportEvidence={...observed.evidence,state:observed.state};
    return this.imports.choose(claim,partitionMarkdown(bytes,prepared,cuts,segmentation),evidence);
  }
  private outage(runId: string): void {
    if (!this.unavailable.has(runId)) { this.unavailable.add(runId); this.logger.warning("[import worker] native outcome unresolved",{runId}); }
    else this.logger.verbose("[import worker] native outcome remains unresolved",{runId});
  }
  private async cancel(run: RunRecord): Promise<void> {
    if (!this.dependencies.native || this.paused) return;
    const prompt=this.imports.cancellationPrompt(run.id), binding=this.bindings.get(run.id);
    if (!prompt || !binding) return;
    this.logger.verbose("[import worker] cancellation attempt",{runId:run.id,promptId:prompt.promptId});
    try {
      const result=await this.transport().cancel({runId:run.id,generation:run.generation},binding,prompt);
      this.localFence();
      if (result==="settled") this.protocol.settleCancellation(run.id);
      this.logger.verbose("[import worker] cancellation outcome",{runId:run.id,state:result});
    } catch { if (!this.paused) this.logger.verbose("[import worker] cancellation remains pending",{runId:run.id}); }
  }
  pause(): void { this.paused=true; }
}
