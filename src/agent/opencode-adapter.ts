import { createLogger, type Logger } from "../logging";
import type { JsonValue, SessionMessageAssistantTool } from "@opencode/client";
import { RunFenceError, type Claim } from "../domain/run";
import { AgentBindingError, assertNativeSessionBinding, assertNativeSessionOwner, normalizeBinding, sameBinding, type AgentBinding, type ModelRef } from "./binding";
import { AgentSessionMissingError, AgentUncertainError, AgentUnavailableError } from "./errors";
import { authorizeSubmissionHistory, cancellationHistorySettled, correlateHistory, correlateImportHistory, hasUntrackedInboxContext, readNativeHistory } from "./history";
import { searchInputHash } from "./search-cleanup-history";
import { reconcileSearchCancellation } from "./search-cancellation";
import type { SearchAdmissionFact, SearchCleanupIdentity, SearchCleanupObservation } from "./search-cleanup-contract";
import type { ImportTerminalEvidence } from "../domain/markdown-import-contract";
import type { OrdinaryCancellationJournal } from "../domain/run-protocol";
export type { ImportTerminalEvidence } from "../domain/markdown-import-contract";
export { AgentBindingError } from "./binding";
export type { AgentBinding, ModelRef } from "./binding";
export { AgentUncertainError, AgentUnavailableError } from "./errors";
export { createPublicClient } from "./opencode-client";
export { requireAgentConfig, resolveAgentService } from "./service";
export interface PersistedPrompt { readonly promptId: string; readonly input: string }
/** Enclosing assistant identity associates the call; arguments, results, metadata and raw errors stay native-private. */
export interface NativeTool {
  readonly id: string;
  readonly name: string;
  readonly status: SessionMessageAssistantTool["state"]["status"];
  readonly time: Readonly<SessionMessageAssistantTool["time"]>;
  readonly executed?: boolean;
}
export type NativeMessage =
  | { readonly id: string; readonly type: "user"; readonly time: { readonly created: number }; readonly text: string; readonly unsafe?: boolean }
  | { readonly id: string; readonly type: "assistant"; readonly time: { readonly created: number; readonly completed?: number }; readonly content: readonly { readonly type: "text"; readonly text: string }[]; readonly tools?: readonly NativeTool[]; readonly finish?: string; readonly error?: boolean; readonly unsafe?: boolean }
  | { readonly id: string; readonly type: "idle"; readonly time: { readonly created: number }; readonly outcome: string; readonly error?: boolean }
  | { readonly id: string; readonly type: "other"; readonly nativeType: string; readonly time: { readonly created: number } };
export interface NativeSession {
  readonly id: string;
  readonly location: { readonly directory: string };
  readonly model: ModelRef;
  readonly permissions: readonly { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly unsafe?: boolean;
}
export interface InboxItem {
  readonly id: string;
  readonly sessionID: string;
  readonly type: "user";
  readonly payload: { readonly text: string };
  readonly delivery: "queue" | "steer";
  readonly time: { readonly created: number };
  readonly unsafe?: boolean;
}

/** Narrow injected facade over the maintained promise client's decoded values. */
export interface PublicClient {
  /** Always supplied by the real factory; injected test facades need not own an HTTP endpoint. */
  readonly serviceUrl?: string;
  serverInfo(): Promise<{ readonly version: string }>;
  sessionCreate(input: { readonly id: string; readonly location: AgentBinding["location"]; readonly model: ModelRef; readonly permissions: AgentBinding["permissions"]; readonly metadata: Readonly<Record<string, string>> }): Promise<NativeSession>;
  sessionGet(input: { readonly sessionID: string }): Promise<NativeSession>;
  instructionList(input: { readonly sessionID: string }): Promise<readonly { readonly key: string; readonly value: JsonValue }[]>;
  instructionPut(input: { readonly sessionID: string; readonly key: string; readonly value: JsonValue }): Promise<void>;
  instructionRemove(input: { readonly sessionID: string; readonly key: string }): Promise<void>;
  prompt(input: { readonly sessionID: string; readonly id: string; readonly text: string }): Promise<InboxItem>;
  inbox(input: { readonly sessionID: string }): Promise<readonly InboxItem[]>;
  history(input: { readonly sessionID: string; readonly order?: "asc"; readonly cursor?: string }): Promise<{ readonly data: readonly NativeMessage[]; readonly cursor: { readonly next?: string } }>;
  active(): Promise<Readonly<Record<string, unknown>>>;
  cancelInbox(input: { readonly sessionID: string; readonly inboxID: string }): Promise<void>;
  interrupt(input: { readonly sessionID: string }): Promise<{ readonly interrupted: boolean }>;
}
/** Authentication headers remain server-side and are never persisted in AgentBinding. */
export interface ResolvedAgentService { readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly token?: string }
export interface AgentBindings {
  bind(runId: string, binding: AgentBinding, claim?: Claim): void;
  get(runId: string): AgentBinding | null;
  /** Optional for isolated legacy facades; production reads the immutable prepared initial-step witness. */
  initialGuidance?(claim: Claim, prompt: PersistedPrompt): string | null;
  /** Concrete ordinary storage supplies the complete terminal journal and rechecks it around cleanup calls. */
  cancellationJournal?(runId: string, prompt: PersistedPrompt): OrdinaryCancellationJournal;
  assertCancellationJournal?(journal: OrdinaryCancellationJournal): void;
  /** Required by observeImport; ordinary-only bindings intentionally have no import authority. */
  assertImportOwnership?(claim: Claim, prompts: readonly PersistedPrompt[]): void;
  assertImportPreparation?(claim: Claim, prompts: readonly PersistedPrompt[]): void;
  recordImportSubmission?(claim: Claim, prompt: PersistedPrompt): void;
  assertImportCancellation?(claim: Claim, prompt: PersistedPrompt): void;
}
export type Observation = { readonly state: "pending" | "running" | "uncertain" | "quarantined" } | { readonly state: "completed"; readonly output: string };
export type ImportObservation = {readonly state:"pending"|"running"|"uncertain"|"quarantined"}
  | {readonly state:"terminal-failure";readonly evidence:ImportTerminalEvidence}
  | {readonly state:"terminal-completion";readonly output:string;readonly evidence:ImportTerminalEvidence};
/** Discovery wrapper normalizes the SDK's Service.discover plus Service.headers result. */
export interface AgentDiscovery { discover(): Promise<{ readonly url: string; readonly headers?: Readonly<Record<string, string>> } | null> }
/** Synchronous aggregate transitions surrounding native calls; never an independent adapter journal. */
export type NativePhase = "history" | "submit" | "acknowledged" | "pending" | "running" | "completed" | "uncertain" | "quarantined";
type OrdinaryFence = (claim: Claim, prompt?: PersistedPrompt, phase?: NativePhase) => readonly PersistedPrompt[] | void;
export interface AdapterFences {
  readonly ordinary: OrdinaryFence;
  /** Local pause gate only; it cannot replace the bindings repository's persisted import authority. */
  readonly import: (claim: Claim, prompts: readonly PersistedPrompt[]) => void;
  /** Runtime lifetime ownership only; it grants no run, import or cancellation authority. */
  readonly runtime?: () => void;
}

/** No service startup; all calls are fenced to an existing application claim. */
export class OpenCodeAdapter {
  private readonly observationOutages = new Set<string>();
  private readonly assertActive: OrdinaryFence;
  private readonly importFence: AdapterFences["import"];
  private readonly runtimeFence: () => void;
  /** Production callers supply SqliteAgentBindings.assertActive bound to its receiver; tests may inject controlled fences. */
  constructor(private readonly client: PublicClient, private readonly bindings: AgentBindings,
    fences: OrdinaryFence | AdapterFences, private readonly logger: Logger = createLogger()) {
    this.assertActive=typeof fences==="function" ? fences : fences.ordinary;
    this.importFence=typeof fences==="function" ? (claim,prompts) => { fences(claim,prompts.at(-1)); } : fences.import;
    this.runtimeFence=typeof fences==="function" ? () => {} : fences.runtime ?? (() => {});
  }
  private bound(runId: string, requested: AgentBinding): AgentBinding {
    const binding = normalizeBinding(requested);
    const saved = this.bindings.get(runId);
    if (!saved || !sameBinding(binding,normalizeBinding(saved)) || (this.client.serviceUrl !== undefined && this.client.serviceUrl !== saved.serviceUrl)) throw new AgentBindingError("Run-owned agent binding differs");
    return normalizeBinding(saved);
  }
  private verifyOwner(runId: string, binding: AgentBinding, session: NativeSession): void {
    assertNativeSessionOwner(runId,binding,session);
  }
  private verify(runId: string, binding: AgentBinding, session: NativeSession): void {
    assertNativeSessionBinding(runId,binding,session);
  }
  private async call<T>(claim: Claim, operation: string, action: () => Promise<T>, prompt?: PersistedPrompt, onTransportFailure?: () => void,
    onValue?: (value: T) => void): Promise<T> {
    return this.fencedCall(claim,operation,action,() => { this.assertActive(claim,prompt); },prompt,onTransportFailure,onValue);
  }
  private async fencedCall<T>(claim: Claim, operation: string, action: () => Promise<T>, authorize: () => void,
    prompt?: PersistedPrompt, onTransportFailure?: () => void, onValue?: (value: T) => void): Promise<T> {
    const guard=() => { this.runtimeFence(); authorize(); };
    guard();
    this.logger.verbose("[agent] native call attempt",{runId:claim.runId,operation,promptId:prompt?.promptId,generation:claim.generation});
    let value: T;
    try { value = await action(); onValue?.(value); }
    catch (error) {
      guard();
      this.logger.verbose("[agent] native call failed",{runId:claim.runId,operation,promptId:prompt?.promptId,generation:claim.generation});
      if (error instanceof AgentBindingError || error instanceof AgentSessionMissingError || error instanceof RunFenceError) throw error;
      onTransportFailure?.();
      throw new AgentUncertainError("Native operation outcome is uncertain");
    }
    guard();
    this.logger.verbose("[agent] native call succeeded",{runId:claim.runId,operation,promptId:prompt?.promptId,generation:claim.generation});
    return value;
  }
  private prompt(value: PersistedPrompt): PersistedPrompt {
    if (typeof value.promptId !== "string" || !value.promptId.trim() || typeof value.input !== "string" || !value.input.trim() || Object.keys(value).some(key => key !== "promptId" && key !== "input")) throw new AgentBindingError("Invalid persisted prompt identity");
    return Object.freeze({promptId:value.promptId,input:value.input});
  }
  async ensureSession(claim: Claim, requested: AgentBinding): Promise<void> {
    this.assertActive(claim);
    const binding = normalizeBinding(requested);
    const existing = this.bindings.get(claim.runId);
    if (existing && !sameBinding(normalizeBinding(existing),binding)) throw new AgentBindingError("Run-owned agent binding differs");
    if (!existing) this.bindings.bind(claim.runId,binding,claim);
    const owned = this.bound(claim.runId,binding);
    try {
      const info = await this.call(claim,"service.info",() => this.client.serverInfo());
      if (typeof info.version !== "string" || !info.version.trim()) throw new AgentUnavailableError("Native service identity is unavailable");
      if (existing) {
        try {
          const session = await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:owned.sessionId}));
          this.verify(claim.runId,owned,session);
          return;
        } catch (error) { if (!(error instanceof AgentSessionMissingError)) throw error; }
      }
      try {
        const session = await this.call(claim,"session.create",() => this.client.sessionCreate({id:owned.sessionId,location:owned.location,model:owned.model,permissions:owned.permissions,
          metadata:{owner:"thoughtloom",runId:claim.runId,protocolVersion:"1"}}));
        this.verify(claim.runId,owned,session);
      } catch (error) {
        if (error instanceof RunFenceError || error instanceof AgentBindingError) throw error;
        // Ambiguous creation is reconciled against the same durable ID, never a replacement session.
        const session = await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:owned.sessionId}));
        this.verify(claim.runId,owned,session);
        return;
      }
      this.verify(claim.runId,owned,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:owned.sessionId})));
    } catch (error) {
      if (error instanceof AgentBindingError) this.assertActive(claim,undefined,"quarantined");
      if (error instanceof AgentSessionMissingError) throw new AgentUncertainError("Native session creation remains uncertain");
      throw error;
    }
  }
  private async history(binding: AgentBinding, read: (input: Parameters<PublicClient["history"]>[0]) => ReturnType<PublicClient["history"]>): Promise<readonly NativeMessage[]> {
    return readNativeHistory(binding.sessionId,read);
  }
  private async syncInitialGuidance(claim: Claim, binding: AgentBinding, prompt: PersistedPrompt): Promise<void> {
    const guidance = this.bindings.initialGuidance?.(claim,prompt) ?? null;
    // Fresh run-owned sessions cannot contain our key; empty and legacy snapshots need no experimental endpoint.
    if (guidance === null || guidance === "") return;
    const key = "thoughtloom.agent-guidance", sessionID = binding.sessionId;
    let operation = "instruction.list";
    try {
      const entries = await this.call(claim,operation,() => this.client.instructionList({sessionID}),prompt);
      const existing = entries.filter(entry => entry.key === key);
      if (existing.length > 1) throw new AgentBindingError("Duplicate native guidance entry");
      if (existing[0]?.value === guidance) return;
      operation = "instruction.put";
      await this.call(claim,operation,() => this.client.instructionPut({sessionID,key,value:guidance}),prompt);
      operation = "instruction.list";
      const confirmed = await this.call(claim,operation,() => this.client.instructionList({sessionID}),prompt);
      const matching = confirmed.filter(entry => entry.key === key);
      if (matching.length !== 1 || matching[0]?.value !== guidance) throw new AgentBindingError("Native guidance readback differs");
    } catch (error) {
      this.logger.warning("[agent] instruction synchronization failed",{runId:claim.runId,operation});
      throw error;
    }
  }
  async submit(claim: Claim, requested: AgentBinding, input: PersistedPrompt, onAdmission?: (fact: SearchAdmissionFact) => void): Promise<void> {
    const prompt = this.prompt(input);
    this.assertActive(claim,prompt);
    const binding = this.bound(claim.runId,requested);
    try {
      this.verify(claim.runId,binding,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:binding.sessionId}),prompt));
      const snapshot = this.assertActive(claim,prompt,"history");
      // A fence without a durable witness can authorize only an empty native history, never caller-supplied prior inputs.
      const known = snapshot === undefined ? [] : snapshot.map(input => this.prompt(input));
      const current = known.at(-1);
      if (snapshot !== undefined && (!current || current.promptId !== prompt.promptId || current.input !== prompt.input || new Set(known.map(input => input.promptId)).size !== known.length)) throw new RunFenceError("Native history witness does not match the current persisted prompt");
      const messages = await this.history(binding,input => this.call(claim,"message.list",() => this.client.history(input),prompt));
      authorizeSubmissionHistory(known,messages,binding);
      const inbox = await this.call(claim,"inbox.list",() => this.client.inbox({sessionID:binding.sessionId}),prompt);
      if (inbox.some(item => hasUntrackedInboxContext(item) || item.id !== prompt.promptId || item.sessionID !== binding.sessionId || item.payload.text !== prompt.input)) throw new AgentBindingError("Unexpected native pending input");
      if (inbox.length || Object.hasOwn(await this.call(claim,"session.active",() => this.client.active(),prompt),binding.sessionId)) throw new AgentUncertainError("Existing native work must be observed before submission");
      this.verify(claim.runId,binding,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:binding.sessionId}),prompt));
      if (known.length === 1) await this.syncInitialGuidance(claim,binding,prompt);
      // The concrete storage callback records submitting in the existing run/step transaction before dispatch.
      this.assertActive(claim,prompt,"submit");
      try {
        const receipt = await this.call(claim,"session.prompt",() => this.client.prompt({sessionID:binding.sessionId,id:prompt.promptId,text:prompt.input}),prompt,undefined,
          onAdmission === undefined ? undefined : receipt => {
            if (hasUntrackedInboxContext(receipt) || receipt.id !== prompt.promptId || receipt.sessionID !== binding.sessionId || receipt.type !== "user" || receipt.payload.text !== prompt.input) throw new AgentBindingError("Native admission identity differs");
            // Persist only a matching sealed cleanup fact before the post-await active fence can discard this ACK.
            onAdmission({runId:claim.runId,nativeSessionId:binding.sessionId,promptId:prompt.promptId,inputSha256:searchInputHash(prompt.input)});
          });
        if (hasUntrackedInboxContext(receipt) || receipt.id !== prompt.promptId || receipt.sessionID !== binding.sessionId || receipt.type !== "user" || receipt.payload.text !== prompt.input) throw new AgentBindingError("Native admission identity differs");
        this.verify(claim.runId,binding,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:binding.sessionId}),prompt));
      } catch (error) {
        if (!(error instanceof AgentBindingError)) this.assertActive(claim,prompt,"uncertain");
        throw error;
      }
      this.assertActive(claim,prompt,"acknowledged");
    } catch (error) {
      if (error instanceof AgentBindingError) this.assertActive(claim,prompt,"quarantined");
      if (error instanceof AgentSessionMissingError) throw new AgentUncertainError("The run-owned native session is not available");
      throw error;
    }
  }
  async observe(claim: Claim, requested: AgentBinding, inputs: readonly PersistedPrompt[]): Promise<Observation> {
    const prompts = inputs.map(input => this.prompt(input));
    const current = prompts.at(-1);
    this.assertActive(claim,current);
    const binding = this.bound(claim.runId,requested);
    if (!current) return {state:"uncertain"};
    let transportFailed = false;
    const failed = () => { transportFailed = true; };
    try {
      this.verify(claim.runId,binding,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:binding.sessionId}),current,failed));
      const messages = await this.history(binding,input => this.call(claim,"message.list",() => this.client.history(input),current,failed));
      const inbox = await this.call(claim,"inbox.list",() => this.client.inbox({sessionID:binding.sessionId}),current,failed);
      const active = await this.call(claim,"session.active",() => this.client.active(),current,failed);
      this.verify(claim.runId,binding,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:binding.sessionId}),current,failed));
      this.assertActive(claim,current);
      if (this.observationOutages.delete(binding.sessionId)) this.logger.info("[agent] observation service recovered", { runId: claim.runId });
      const observed = correlateHistory(binding.sessionId,prompts,messages,inbox,active,binding);
      this.assertActive(claim,current,observed.state);
      return observed;
    } catch (error) {
      if (error instanceof RunFenceError) throw error;
      if (error instanceof AgentBindingError) { this.assertActive(claim,current,"quarantined"); return {state:"quarantined"}; }
      this.assertActive(claim,current,"uncertain");
      if (transportFailed && !this.observationOutages.has(binding.sessionId)) {
        this.observationOutages.add(binding.sessionId);
        this.logger.warning("[agent] observation service unavailable", { runId: claim.runId });
      }
      return {state:"uncertain"};
    }
  }
  private importPreparation(claim: Claim, requested: AgentBinding, prompt: PersistedPrompt): () => void {
    const authority=this.bindings.assertImportPreparation;
    if (!authority) throw new RunFenceError("Persisted import preparation authority is required");
    return () => {
      authority.call(this.bindings,claim,[prompt]);
      this.importFence(claim,[prompt]);
      this.bound(claim.runId,requested);
    };
  }
  /** Only a never-submitted prepared import may create its one restricted native session. */
  async ensureImportSession(claim: Claim, requested: AgentBinding, input: PersistedPrompt): Promise<void> {
    const prompt=this.prompt(input), authorize=this.importPreparation(claim,requested,prompt);
    authorize();
    const binding=this.bound(claim.runId,requested);
    let transportFailed=false;
    const read=<T>(operation:string,action:()=>Promise<T>):Promise<T> => this.fencedCall(claim,operation,action,authorize,prompt,() => { transportFailed=true; });
    try {
      const info=await read("service.info",() => this.client.serverInfo());
      if (typeof info.version!=="string" || !info.version.trim()) throw new AgentUnavailableError("Native service identity is unavailable");
      try {
        this.verify(claim.runId,binding,await read("session.get",() => this.client.sessionGet({sessionID:binding.sessionId})));
        return;
      } catch (error) { if (!(error instanceof AgentSessionMissingError)) throw error; }
      try {
        this.verify(claim.runId,binding,await read("session.create",() => this.client.sessionCreate({id:binding.sessionId,location:binding.location,
          model:binding.model,permissions:binding.permissions,metadata:{owner:"thoughtloom",runId:claim.runId,protocolVersion:"1"}})));
      } catch (error) {
        if (error instanceof RunFenceError || error instanceof AgentBindingError) throw error;
        // A lost creation acknowledgement may be reconciled only against this same saved identity.
        this.verify(claim.runId,binding,await read("session.get",() => this.client.sessionGet({sessionID:binding.sessionId})));
        return;
      }
      this.verify(claim.runId,binding,await read("session.get",() => this.client.sessionGet({sessionID:binding.sessionId})));
    } catch (error) {
      authorize();
      if (error instanceof RunFenceError || error instanceof AgentBindingError) throw error;
      if (transportFailed) throw new AgentUnavailableError("Never-submitted import service is unavailable");
      if (error instanceof AgentSessionMissingError) throw new AgentUncertainError("Import session creation remains uncertain");
      throw error;
    }
  }
  /** Preflight is readonly; the repository records exact submission intent immediately before the sole prompt call. */
  async submitImport(claim: Claim, requested: AgentBinding, input: PersistedPrompt): Promise<void> {
    const prompt=this.prompt(input), prepared=this.importPreparation(claim,requested,prompt);
    const record=this.bindings.recordImportSubmission, ownership=this.bindings.assertImportOwnership;
    if (!record || !ownership) throw new RunFenceError("Persisted import submission authority is required");
    let submitted=false, transportFailed=false;
    const authorize=() => {
      if (!submitted) prepared();
      else { ownership.call(this.bindings,claim,[prompt]); this.importFence(claim,[prompt]); this.bound(claim.runId,requested); }
    };
    authorize();
    const binding=this.bound(claim.runId,requested);
    const read=<T>(operation:string,action:()=>Promise<T>):Promise<T> => this.fencedCall(claim,operation,action,authorize,prompt,() => { transportFailed=true; });
    try {
      this.verify(claim.runId,binding,await read("session.get",() => this.client.sessionGet({sessionID:binding.sessionId})));
      const messages=await this.history(binding,input => read("message.list",() => this.client.history(input)));
      authorizeSubmissionHistory([],messages);
      if (messages.length) throw new AgentBindingError("Initial import session contains unexpected native history");
      const inbox=await read("inbox.list",() => this.client.inbox({sessionID:binding.sessionId}));
      if (inbox.some(item => hasUntrackedInboxContext(item) || item.id!==prompt.promptId || item.sessionID!==binding.sessionId || item.payload.text!==prompt.input)) throw new AgentBindingError("Unexpected import pending input");
      if (inbox.length || Object.hasOwn(await read("session.active",() => this.client.active()),binding.sessionId)) throw new AgentUncertainError("Existing native work must settle before import submission");
      this.verify(claim.runId,binding,await read("session.get",() => this.client.sessionGet({sessionID:binding.sessionId})));
      authorize();
      record.call(this.bindings,claim,prompt);
      submitted=true;
      const receipt=await read("session.prompt",() => this.client.prompt({sessionID:binding.sessionId,id:prompt.promptId,text:prompt.input}));
      if (hasUntrackedInboxContext(receipt) || receipt.id!==prompt.promptId || receipt.sessionID!==binding.sessionId || receipt.type!=="user" || receipt.payload.text!==prompt.input) throw new AgentBindingError("Import admission identity differs");
      this.verify(claim.runId,binding,await read("session.get",() => this.client.sessionGet({sessionID:binding.sessionId})));
    } catch (error) {
      authorize();
      if (error instanceof RunFenceError || error instanceof AgentBindingError) throw error;
      if (!submitted && transportFailed) throw new AgentUnavailableError("Never-submitted import service is unavailable");
      if (error instanceof AgentSessionMissingError) throw new AgentUncertainError("The owned import session is unavailable");
      throw error;
    }
  }
  /** Read-only import observation. Terminal facts never enter the ordinary NativePhase transition callback. */
  async observeImport(claim: Claim, requested: AgentBinding, inputs: readonly PersistedPrompt[]): Promise<ImportObservation> {
    const prompts=Object.freeze(inputs.map(input => this.prompt(input)));
    const current=prompts.at(-1);
    const authority=this.bindings.assertImportOwnership;
    if (!authority || !current) throw new RunFenceError("Persisted import observation authority is required");
    const authorize=() => {
      authority.call(this.bindings,claim,prompts);
      this.importFence(claim,prompts);
      this.bound(claim.runId,requested);
    };
    // Authority failure is not a native failure or a reason to select structural fallback.
    authorize();
    const binding=this.bound(claim.runId,requested);
    let transportFailed=false;
    const failed=() => { transportFailed=true; };
    const read=<T>(operation:string,action:()=>Promise<T>):Promise<T> => this.fencedCall(claim,operation,action,authorize,current,failed);
    try {
      this.verify(claim.runId,binding,await read("session.get",() => this.client.sessionGet({sessionID:binding.sessionId})));
      const messages=await this.history(binding,input => read("message.list",() => this.client.history(input)));
      const inbox=await read("inbox.list",() => this.client.inbox({sessionID:binding.sessionId}));
      const active=await read("session.active",() => this.client.active());
      this.verify(claim.runId,binding,await read("session.get",() => this.client.sessionGet({sessionID:binding.sessionId})));
      authorize();
      if (this.observationOutages.delete(binding.sessionId)) this.logger.info("[agent] import observation service recovered",{runId:claim.runId});
      return correlateImportHistory(binding.sessionId,prompts,messages,inbox,active);
    } catch (error) {
      if (error instanceof RunFenceError) throw error;
      authorize();
      if (error instanceof AgentBindingError) return {state:"quarantined"};
      if (transportFailed && !this.observationOutages.has(binding.sessionId)) {
        this.observationOutages.add(binding.sessionId);
        this.logger.warning("[agent] import observation service unavailable",{runId:claim.runId});
      }
      return {state:"uncertain"};
    }
  }
  async cancel(runId: string, requested: AgentBinding, input: PersistedPrompt): Promise<"pending" | "settled"> {
    this.runtimeFence();
    const prompt = this.prompt(input), binding = this.bound(runId,requested);
    const journal = this.bindings.cancellationJournal?.(runId,prompt);
    const authority = this.bindings.assertCancellationJournal;
    if (journal && !authority) throw new RunFenceError("Ordinary cancellation journal fence is required");
    const guard = () => {
      this.runtimeFence();
      if (journal && authority) authority.call(this.bindings,journal);
      this.bound(runId,requested);
    };
    // An injected single-prompt port has no authority to adopt other native inputs. Production always supplies the SQL journal.
    const prompts = journal ? journal.steps.filter(step => step.state !== "prepared").map(step => this.prompt({promptId:step.promptId,input:step.input})) : [prompt];
    const read = async <T>(action: () => Promise<T>): Promise<T> => { guard(); try { return await action(); } finally { guard(); } };
    const observe = async () => {
      this.verifyOwner(runId,binding,await read(() => this.client.sessionGet({sessionID:binding.sessionId})));
      const messages = await this.history(binding,input => read(() => this.client.history(input)));
      const inbox = await read(() => this.client.inbox({sessionID:binding.sessionId}));
      const active = await read(() => this.client.active());
      this.verifyOwner(runId,binding,await read(() => this.client.sessionGet({sessionID:binding.sessionId})));
      const settled = cancellationHistorySettled(binding.sessionId,prompts,messages,inbox,active,binding);
      return {messages,inbox,active,settled};
    };
    this.logger.verbose("[agent] native cancellation attempt",{runId,promptId:prompt.promptId});
    try {
      const before = await observe();
      for (const item of before.inbox) {
        this.verifyOwner(runId,binding,await read(() => this.client.sessionGet({sessionID:binding.sessionId})));
        await read(() => this.client.cancelInbox({sessionID:binding.sessionId,inboxID:item.id}));
      }
      const represented = new Set([...before.messages.filter(message => message.type === "user").map(message => message.id),...before.inbox.map(item => item.id)]);
      // An active flag alone cannot identify missing input. Idle interrupt is harmless but is never settlement proof.
      if (!Object.hasOwn(before.active,binding.sessionId) || (prompts.length > 0 && prompts.every(item => represented.has(item.promptId)))) {
        this.verifyOwner(runId,binding,await read(() => this.client.sessionGet({sessionID:binding.sessionId})));
        await read(() => this.client.interrupt({sessionID:binding.sessionId}));
      }
      const after = await observe();
      guard();
      const state = after.settled ? "settled" : "pending";
      this.logger.verbose("[agent] native cancellation observed",{runId,promptId:prompt.promptId,state});
      return state;
    } catch (error) {
      this.logger.verbose("[agent] native cancellation unresolved",{runId,promptId:prompt.promptId});
      if (error instanceof AgentBindingError || error instanceof RunFenceError) throw error;
      return "pending";
    }
  }
  /** Search cancellation deliberately does not use active-run authority, retained prompt input or ordinary drift tolerance. */
  async cancelSearch(identity: SearchCleanupIdentity, authorize: () => void): Promise<SearchCleanupObservation> {
    return reconcileSearchCancellation(this.client,identity,() => { this.runtimeFence(); authorize(); },
      session => this.verify(identity.runId,identity.binding,session),this.logger);
  }
  async cancelImport(claim: Claim, requested: AgentBinding, input: PersistedPrompt): Promise<"pending" | "settled"> {
    const prompt=this.prompt(input), authority=this.bindings.assertImportCancellation;
    if (!authority) throw new RunFenceError("Persisted import cleanup authority is required");
    return this.cancelOwned(claim.runId,requested,prompt,() => {
      authority.call(this.bindings,claim,prompt); this.importFence(claim,[prompt]); this.bound(claim.runId,requested);
    });
  }
  private async cancelOwned(runId: string, requested: AgentBinding, input: PersistedPrompt, authorize: () => void): Promise<"pending" | "settled"> {
    const guard=() => { this.runtimeFence(); authorize(); };
    guard();
    const binding = this.bound(runId,requested);
    const prompt = this.prompt(input);
    const read=async <T>(action:()=>Promise<T>):Promise<T> => { guard(); try { return await action(); } finally { guard(); } };
    this.logger.verbose("[agent] native cancellation attempt",{runId,promptId:prompt.promptId});
    try {
      // Cleanup can stop an owned but quarantined session whose model/location/rules have drifted. It cannot adopt it.
      this.verifyOwner(runId,binding,await read(() => this.client.sessionGet({sessionID:binding.sessionId})));
      await read(() => this.client.cancelInbox({sessionID:binding.sessionId,inboxID:prompt.promptId}));
      await read(() => this.client.interrupt({sessionID:binding.sessionId}));
      const inbox = await read(() => this.client.inbox({sessionID:binding.sessionId}));
      if (inbox.some(hasUntrackedInboxContext)) throw new AgentBindingError("Unexpected native cancellation context");
      const active = await read(() => this.client.active());
      this.verifyOwner(runId,binding,await read(() => this.client.sessionGet({sessionID:binding.sessionId})));
      const state = inbox.length === 0 && !Object.hasOwn(active,binding.sessionId) ? "settled" : "pending";
      this.logger.verbose("[agent] native cancellation observed",{runId,promptId:prompt.promptId,state});
      return state;
    } catch (error) {
      this.logger.verbose("[agent] native cancellation unresolved",{runId,promptId:prompt.promptId});
      if (error instanceof AgentBindingError || error instanceof RunFenceError) throw error;
      return "pending";
    }
  }
}
