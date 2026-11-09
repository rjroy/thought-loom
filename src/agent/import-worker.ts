import { SQLiteError, type Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createLogger, type Logger } from "../logging";
import { RunFenceError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import { ValidationError } from "../domain/validation";
import { ImportConflictError, ImportPreservationError, partitionMarkdown, prepareMarkdown, validateMarkdownSelection,
  type ImportEvidence, type ImportFailureCode, type ImportPrivateInput, type PreparedMarkdown, type Segmentation } from "../domain/markdown-import";
import type { MarkdownParser } from "../domain/markdown-import-parser";
import { SqliteMarkdownImports, type ImportLocalWork } from "../storage/markdown-import";
import { SqliteAgentBindings } from "../storage/agent-binding";
import { SqliteRunRepository } from "../storage/run";
import { SqliteRunProtocolRepository } from "../storage/run-protocol";
import { AgentBindingError } from "./binding";
import { AgentUnavailableError, AgentUncertainError } from "./errors";
import type { AgentBinding, ImportObservation, PersistedPrompt } from "./opencode-adapter";
import { assertImportRunNotRestoreFenced, isImportRunRestoreFenced } from "../storage/import-authority";
import { isRestoreFenced, isRunRestoreFenced } from "../storage/restore-fences";

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
  readonly parser?: MarkdownParser;
}
export const importTurn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
export const importBusy = (error: unknown): boolean => error instanceof SQLiteError && typeof error.code==="string" && (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"));
const terminal = (run: RunRecord): boolean => ["completed","failed","interrupted"].includes(run.status);
const inputHash = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
const preparationLimit = 4;
interface InputIdentity {
  readonly fileId: string; readonly promptId: string; readonly inputSha256: string;
  readonly sourceSha256: string; readonly byteLength: number;
}
interface OwnedImport {
  claim: Claim;
  verified?: InputIdentity & {readonly hasAtoms:boolean};
  fenced: boolean;
  unavailable: boolean;
}
interface CachedPreparation extends InputIdentity { readonly generation: number; readonly prepared: PreparedMarkdown }
interface PreparedInput { readonly source: ImportPrivateInput; readonly prompt: PersistedPrompt; readonly prepared: PreparedMarkdown }
class ImportParseError extends Error {}
const sameInput = (a: InputIdentity, b: InputIdentity): boolean => a.fileId===b.fileId && a.promptId===b.promptId &&
  a.inputSha256===b.inputSha256 && a.sourceSha256===b.sourceSha256 && a.byteLength===b.byteLength;

/** One local/native import implementation over the existing immutable run journal, never ordinary knowledge operations. */
export class MarkdownImportWorker {
  private readonly imports: SqliteMarkdownImports;
  private readonly bindings: SqliteAgentBindings;
  private readonly runs: SqliteRunRepository;
  private readonly protocol: SqliteRunProtocolRepository;
  private readonly logger: Logger;
  private readonly parser: MarkdownParser;
  // Only fixed-size execution metadata per live claimed run; no source, prompt or native history is retained here.
  private readonly owners = new Map<string,OwnedImport>();
  private readonly preparations = new Map<string,CachedPreparation>();
  private native: ImportNative | undefined;
  private paused = false;
  constructor(private readonly dependencies: ImportWorkerDependencies) {
    this.logger=dependencies.logger ?? createLogger();
    this.parser=dependencies.parser ?? {prepareMarkdown,partitionMarkdown};
    this.imports=new SqliteMarkdownImports(dependencies.db,dependencies);
    this.bindings=new SqliteAgentBindings(dependencies.db,this.logger);
    this.runs=new SqliteRunRepository(dependencies.db,dependencies);
    this.protocol=new SqliteRunProtocolRepository(dependencies.db,this.logger);
  }
  candidates(after: number, through: number | null, limit: number) {
    this.reapOwners();
    return this.dependencies.native ? this.imports.nativeCandidates(after,through,limit) : this.imports.localCandidates(after,through,limit);
  }
  private discardPreparation(runId: string, owner: OwnedImport): void {
    this.preparations.delete(runId); owner.verified=undefined; owner.unavailable=false;
  }
  private forget(runId: string): void { this.preparations.delete(runId); this.owners.delete(runId); }
  private fence(runId: string, owner: OwnedImport): void {
    this.discardPreparation(runId,owner);
    // Retain only the stale claim while its run is live: this worker must never reclaim a successor generation.
    owner.fenced=true;
  }
  private reapOwners(): void {
    const count=Math.min(preparationLimit,this.owners.size), entries=this.owners.entries();
    for (let i=0;i<count;i++) {
      const item=entries.next(); if (item.done) break;
      const [runId,owner]=item.value, run=this.runs.get(runId);
      if (!run || terminal(run) || isImportRunRestoreFenced(this.dependencies.db,runId)) this.forget(runId);
      else {
        if (run.generation!==owner.claim.generation) this.fence(runId,owner);
        // Round-robin bounded cleanup also finds runs settled elsewhere that are no longer scan candidates.
        this.owners.delete(runId); this.owners.set(runId,owner);
      }
    }
  }
  private localFence(): void { if (this.paused) throw new RunFenceError("Import worker is paused"); }
  private transport(): ImportNative {
    this.localFence();
    const factory=this.dependencies.native;
    if (!factory) throw new AgentUnavailableError("Import agent is unconfigured");
    return this.native ??= factory(this.bindings,() => this.localFence());
  }
  private assertCurrent(claim: Claim): void {
    this.localFence();
    assertImportRunNotRestoreFenced(this.dependencies.db,claim.runId);
    const run=this.runs.get(claim.runId);
    if (!run || run.generation!==claim.generation || terminal(run)) throw new RunFenceError();
  }
  private identity(source: ImportPrivateInput): InputIdentity {
    if (source.input===null) throw new ImportPreservationError("Prepared import input is missing");
    return {fileId:source.fileId,promptId:source.promptId,inputSha256:inputHash(source.input),
      sourceSha256:inputHash(source.bytes),byteLength:source.bytes.length};
  }
  private prompt(source: ImportPrivateInput): PersistedPrompt {
    if (source.input===null) throw new ImportPreservationError("Prepared import input is missing");
    return {promptId:source.promptId,input:source.input};
  }
  private verifyInput(owner: OwnedImport, source: ImportPrivateInput): void {
    if (owner.verified && (source.input===null || !sameInput(owner.verified,this.identity(source)))) throw new ImportPreservationError("Verified import input changed");
  }
  /** Used only for initial preparation or a real partition decision, never for waiting observation. */
  private async preparation(owner: OwnedImport, source: ImportPrivateInput): Promise<PreparedInput> {
    const claim=owner.claim;
    this.assertCurrent(claim); this.verifyInput(owner,source);
    const identity=source.input===null ? null : this.identity(source), cached=this.preparations.get(claim.runId);
    if (identity && cached && cached.generation===claim.generation && sameInput(cached,identity)) {
      this.preparations.delete(claim.runId); this.preparations.set(claim.runId,cached);
      return {source,prompt:this.prompt(source),prepared:cached.prepared};
    }
    // The parser owns the runtime proof and snapshots bytes. Stored manifest JSON cannot create that proof.
    let prepared: PreparedMarkdown;
    try { prepared=this.parser.prepareMarkdown(source.bytes); }
    catch (error) { if (error instanceof ImportPreservationError) throw error; throw new ImportParseError("Markdown preparation failed"); }
    await importTurn(); this.assertCurrent(claim);
    this.imports.prepare(claim,prepared.manifest); // Existing input must match the complete immutable daemon-rendered job.
    const current=this.imports.privateInput(claim), confirmed=this.identity(current);
    if (current.fileId!==source.fileId || current.promptId!==source.promptId || confirmed.byteLength!==source.bytes.length ||
      confirmed.sourceSha256!==inputHash(source.bytes) || (identity && !sameInput(identity,confirmed))) throw new ImportPreservationError("Import input changed during preparation");
    this.assertCurrent(claim);
    owner.verified={...confirmed,hasAtoms:prepared.manifest.atoms.length>0};
    this.preparations.delete(claim.runId);
    if (this.preparations.size>=preparationLimit) {
      const oldest=this.preparations.keys().next();
      if (!oldest.done) this.preparations.delete(oldest.value);
    }
    this.preparations.set(claim.runId,{...confirmed,generation:claim.generation,prepared});
    return {source:current,prompt:this.prompt(current),prepared};
  }
  private choose(owner: OwnedImport, source: ImportPrivateInput, prepared: PreparedMarkdown, cuts: readonly string[], segmentation: Segmentation, evidence: ImportEvidence): Claim {
    this.assertCurrent(owner.claim); this.verifyInput(owner,source);
    const claim=this.imports.choose(owner.claim,this.parser.partitionMarkdown(source.bytes,prepared,cuts,segmentation),evidence);
    this.discardPreparation(claim.runId,owner);
    owner.claim=claim;
    return claim;
  }
  async tick(work: ImportLocalWork): Promise<void> {
    if (this.paused) return;
    let owner=this.owners.get(work.runId), claim=owner?.claim;
    let phase="claim";
    try {
      if (isRunRestoreFenced(this.dependencies.db,work.runId) || isRestoreFenced(this.dependencies.db,"import-file",work.fileId)) {
        this.forget(work.runId); return;
      }
      const run=this.runs.get(work.runId);
      if (!run || run.kind!=="import") { this.forget(work.runId); return; }
      if (isImportRunRestoreFenced(this.dependencies.db,work.runId)) { this.forget(work.runId); return; }
      if (terminal(run)) { this.forget(run.id); await this.cancel(run); return; }
      if (owner?.fenced) return;
      if (!owner) {
        claim=this.dependencies.native ? this.imports.claimNative(work) ?? undefined : this.imports.claimLocal(work)?.claim;
        if (!claim) {
          this.owners.set(run.id,{claim:{runId:run.id,generation:work.generation},fenced:true,unavailable:false}); return;
        }
        owner={claim,fenced:false,unavailable:false};
        this.owners.set(run.id,owner);
      }
      claim=owner.claim;
      this.assertCurrent(claim);
      const progress=this.imports.progress(claim);
      if (!progress.chosen) {
        phase="input";
        const source=this.imports.privateInput(claim);
        this.verifyInput(owner,source);
        phase="selection";
        const selected=progress.submitted ? await this.observe(owner,run,source) : await this.initial(owner,run,source);
        if (!selected) return;
        claim=selected;
      } else this.discardPreparation(run.id,owner);
      await importTurn(); this.assertCurrent(claim);
      phase="finalize";
      const result=this.imports.finalize(claim);
      this.forget(work.runId);
      this.logger.info("[import worker] file completed",{runId:work.runId,fileId:work.fileId,thoughtCount:result.thoughtCount});
    } catch (error) {
      if (this.paused) return;
      if (importBusy(error)) { this.logger.warning("[import worker] local work busy",{runId:work.runId,phase}); return; }
      if (!claim) { this.logger.error("[import worker] claim failed",{runId:work.runId}); return; }
      const current=this.runs.get(work.runId);
      if (error instanceof RunFenceError && (!current || terminal(current) || current.generation!==claim.generation)) {
        if (!current || terminal(current)) this.forget(work.runId);
        else if (owner) this.fence(work.runId,owner);
        return;
      }
      const code: ImportFailureCode=error instanceof AgentBindingError || error instanceof RunFenceError ? "ownership-conflict" :
        error instanceof ImportPreservationError ? "preservation-failed" : error instanceof ImportConflictError ? "ownership-conflict" :
        error instanceof ImportParseError ? "parse-failed" : "persistence-failed";
      if (owner) this.discardPreparation(work.runId,owner);
      try { this.imports.fail(claim,code); this.forget(work.runId); }
      catch (failure) {
        if (failure instanceof RunFenceError && owner) {
          const settled=this.runs.get(work.runId);
          if (!settled || terminal(settled)) this.forget(work.runId);
          else this.fence(work.runId,owner);
        }
        else this.logger.error("[import worker] failure settlement deferred",{runId:work.runId,code});
      }
    }
  }
  private async localChoice(owner: OwnedImport, source: ImportPrivateInput, segmentation: Segmentation): Promise<Claim> {
    const ready=await this.preparation(owner,source);
    return this.choose(owner,ready.source,ready.prepared,ready.prepared.fallbackCuts,segmentation,
      {state:"not-submitted",promptId:ready.prompt.promptId,inputSha256:inputHash(ready.prompt.input)});
  }
  private async initial(owner: OwnedImport, run: RunRecord, source: ImportPrivateInput): Promise<Claim | null> {
    const claim=owner.claim;
    if (source.input===null || !owner.verified) source=(await this.preparation(owner,source)).source;
    this.assertCurrent(claim);
    const verified=owner.verified;
    if (!verified) throw new ImportPreservationError("Initial import preparation was not verified");
    if (!verified.hasAtoms) return this.localChoice(owner,source,{method:"not-needed",reason:null});
    if (!this.dependencies.native) return this.localChoice(owner,source,{method:"structural",reason:"ai-unconfigured"});
    const prompt=this.prompt(source);
    const native=this.transport();
    let binding=this.bindings.get(run.id);
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
        return this.localChoice(owner,this.imports.privateInput(claim),{method:"structural",reason:"ai-unavailable"});
      }
      if (!(error instanceof AgentUnavailableError || error instanceof AgentUncertainError)) throw error;
      if (this.imports.progress(claim).submitted) this.bindings.recordImportObservation(claim,[prompt],"uncertain");
      this.outage(run.id,owner); return null;
    }
  }
  private async observe(owner: OwnedImport, run: RunRecord, source: ImportPrivateInput): Promise<Claim | null> {
    if (!this.dependencies.native) return null;
    const claim=owner.claim, prompt=this.prompt(source), native=this.transport(), binding=this.bindings.get(run.id);
    if (!binding) throw new AgentBindingError("Submitted import has no immutable native binding");
    let observed: ImportObservation;
    try { observed=await native.observe(claim,binding,[prompt]); this.assertCurrent(claim); }
    catch (error) {
      this.assertCurrent(claim);
      if (!(error instanceof AgentUnavailableError || error instanceof AgentUncertainError)) throw error;
      this.bindings.recordImportObservation(claim,[prompt],"uncertain"); this.outage(run.id,owner); return null;
    }
    this.bindings.assertImportOwnership(claim,[prompt]);
    if (observed.state==="quarantined") throw new AgentBindingError("Import native ownership is quarantined");
    if (observed.state!=="terminal-failure" && observed.state!=="terminal-completion") {
      this.bindings.recordImportObservation(claim,[prompt],observed.state); return null;
    }
    if (owner.unavailable) { owner.unavailable=false; this.logger.info("[import worker] native service recovered",{runId:run.id}); }
    const ready=await this.preparation(owner,this.imports.privateInput(claim)), prepared=ready.prepared;
    let segmentation: Segmentation={method:"structural",reason:observed.state==="terminal-failure" ? "ai-failed" : "ai-invalid"};
    let cuts=prepared.fallbackCuts;
    if (observed.state==="terminal-completion" && observed.evidence.finish==="stop") {
      try { cuts=validateMarkdownSelection(prepared.manifest,observed.output); segmentation={method:"ai",reason:null}; }
      catch (error) { if (!(error instanceof ValidationError)) throw error; }
    }
    const evidence: ImportEvidence={...observed.evidence,state:observed.state};
    return this.choose(owner,ready.source,prepared,cuts,segmentation,evidence);
  }
  private outage(runId: string, owner: OwnedImport): void {
    if (!owner.unavailable) { owner.unavailable=true; this.logger.warning("[import worker] native outcome unresolved",{runId}); }
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
      assertImportRunNotRestoreFenced(this.dependencies.db,run.id);
      if (result==="settled") this.protocol.settleCancellation(run.id);
      this.logger.verbose("[import worker] cancellation outcome",{runId:run.id,state:result});
    } catch { if (!this.paused) this.logger.verbose("[import worker] cancellation remains pending",{runId:run.id}); }
  }
  pause(): void { this.paused=true; this.preparations.clear(); this.owners.clear(); }
}
