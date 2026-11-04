import { RunFenceError, type Claim } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { AgentBindingError, normalizeBinding, sameBinding, sameModel, type AgentBinding, type ModelRef } from "./binding";
import { AgentSessionMissingError, AgentUncertainError, AgentUnavailableError } from "./errors";
import { authorizeSubmissionHistory, correlateHistory } from "./history";
export { AgentBindingError } from "./binding";
export type { AgentBinding, ModelRef } from "./binding";
export { AgentUncertainError, AgentUnavailableError } from "./errors";
export { createPublicClient } from "./opencode-client";
export { requireAgentConfig, resolveAgentService } from "./service";
export interface PersistedPrompt { readonly promptId: string; readonly input: string }
export type NativeMessage =
  | { readonly id: string; readonly type: "user"; readonly time: { readonly created: number }; readonly text: string; readonly unsafe?: boolean }
  | { readonly id: string; readonly type: "assistant"; readonly time: { readonly created: number; readonly completed?: number }; readonly content: readonly { readonly type: "text"; readonly text: string }[]; readonly finish?: string; readonly error?: boolean; readonly unsafe?: boolean }
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
export interface InboxItem { readonly id: string; readonly sessionID: string; readonly type: "user"; readonly payload: { readonly text: string }; readonly delivery: "queue" | "steer"; readonly time: { readonly created: number } }

/** Narrow injected facade over the maintained promise client's decoded values. */
export interface PublicClient {
  /** Always supplied by the real factory; injected test facades need not own an HTTP endpoint. */
  readonly serviceUrl?: string;
  serverInfo(): Promise<{ readonly version: string }>;
  sessionCreate(input: { readonly id: string; readonly location: AgentBinding["location"]; readonly model: ModelRef; readonly permissions: AgentBinding["permissions"]; readonly metadata: Readonly<Record<string, string>> }): Promise<NativeSession>;
  sessionGet(input: { readonly sessionID: string }): Promise<NativeSession>;
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
}
export type Observation = { readonly state: "pending" | "running" | "uncertain" | "quarantined" } | { readonly state: "completed"; readonly output: string };
/** Discovery wrapper normalizes the SDK's Service.discover plus Service.headers result. */
export interface AgentDiscovery { discover(): Promise<{ readonly url: string; readonly headers?: Readonly<Record<string, string>> } | null> }
/** Synchronous aggregate transitions surrounding native calls; never an independent adapter journal. */
export type NativePhase = "history" | "submit" | "acknowledged" | "pending" | "running" | "completed" | "uncertain" | "quarantined";

/** No service startup; all calls are fenced to an existing application claim. */
export class OpenCodeAdapter {
  /** Production callers supply SqliteAgentBindings.assertActive bound to its receiver; tests may inject controlled fences. */
  constructor(private readonly client: PublicClient, private readonly bindings: AgentBindings,
    private readonly assertActive: (claim: Claim, prompt?: PersistedPrompt, phase?: NativePhase) => readonly PersistedPrompt[] | void) {}
  private bound(runId: string, requested: AgentBinding): AgentBinding {
    const binding = normalizeBinding(requested);
    const saved = this.bindings.get(runId);
    if (!saved || !sameBinding(binding,normalizeBinding(saved)) || (this.client.serviceUrl !== undefined && this.client.serviceUrl !== saved.serviceUrl)) throw new AgentBindingError("Run-owned agent binding differs");
    return normalizeBinding(saved);
  }
  private verifyOwner(runId: string, binding: AgentBinding, session: NativeSession): void {
    if (session.id !== binding.sessionId || session.metadata.owner !== "thoughtloom" || session.metadata.runId !== runId || session.metadata.protocolVersion !== "1") throw new AgentBindingError("Native session ownership differs");
  }
  private verify(runId: string, binding: AgentBinding, session: NativeSession): void {
    this.verifyOwner(runId,binding,session);
    const metadata = {owner:"thoughtloom",runId,protocolVersion:"1"};
    if (session.unsafe || session.location.directory !== binding.location.directory || !sameModel(binding.model,session.model) ||
        protocolJson(session.permissions) !== protocolJson(binding.permissions) || protocolJson(session.metadata) !== protocolJson(metadata)) throw new AgentBindingError("Native session does not match its owned binding");
  }
  private async call<T>(claim: Claim, operation: string, action: () => Promise<T>, prompt?: PersistedPrompt): Promise<T> {
    this.assertActive(claim,prompt);
    console.info("[agent] native call attempt",{runId:claim.runId,operation,promptId:prompt?.promptId,generation:claim.generation});
    let value: T;
    try { value = await action(); }
    catch (error) {
      this.assertActive(claim,prompt);
      console.error("[agent] native call failed",{runId:claim.runId,operation,promptId:prompt?.promptId,generation:claim.generation});
      if (error instanceof AgentBindingError || error instanceof AgentSessionMissingError || error instanceof RunFenceError) throw error;
      throw new AgentUncertainError("Native operation outcome is uncertain");
    }
    this.assertActive(claim,prompt);
    console.info("[agent] native call succeeded",{runId:claim.runId,operation,promptId:prompt?.promptId,generation:claim.generation});
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
  private async history(claim: Claim, binding: AgentBinding, prompt: PersistedPrompt): Promise<readonly NativeMessage[]> {
    const messages: NativeMessage[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const input: Parameters<PublicClient["history"]>[0] = cursor === undefined ? {sessionID:binding.sessionId,order:"asc"} : {sessionID:binding.sessionId,cursor};
      const page = await this.call(claim,"message.list",() => this.client.history(input),prompt);
      for (const message of page.data) messages.push(message);
      cursor = page.cursor.next;
      if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) throw new AgentUncertainError("Native history cursor made no progress");
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    return messages;
  }
  async submit(claim: Claim, requested: AgentBinding, input: PersistedPrompt): Promise<void> {
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
      const messages = await this.history(claim,binding,prompt);
      authorizeSubmissionHistory(known,messages);
      const inbox = await this.call(claim,"inbox.list",() => this.client.inbox({sessionID:binding.sessionId}),prompt);
      if (inbox.some(item => item.id !== prompt.promptId || item.sessionID !== binding.sessionId || item.payload.text !== prompt.input)) throw new AgentBindingError("Unexpected native pending input");
      if (inbox.length || Object.hasOwn(await this.call(claim,"session.active",() => this.client.active(),prompt),binding.sessionId)) throw new AgentUncertainError("Existing native work must be observed before submission");
      this.verify(claim.runId,binding,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:binding.sessionId}),prompt));
      // The concrete storage callback records submitting in the existing run/step transaction before dispatch.
      this.assertActive(claim,prompt,"submit");
      try {
        const receipt = await this.call(claim,"session.prompt",() => this.client.prompt({sessionID:binding.sessionId,id:prompt.promptId,text:prompt.input}),prompt);
        if (receipt.id !== prompt.promptId || receipt.sessionID !== binding.sessionId || receipt.type !== "user" || receipt.payload.text !== prompt.input) throw new AgentBindingError("Native admission identity differs");
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
    try {
      this.verify(claim.runId,binding,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:binding.sessionId}),current));
      const messages = await this.history(claim,binding,current);
      const inbox = await this.call(claim,"inbox.list",() => this.client.inbox({sessionID:binding.sessionId}),current);
      const active = await this.call(claim,"session.active",() => this.client.active(),current);
      this.verify(claim.runId,binding,await this.call(claim,"session.get",() => this.client.sessionGet({sessionID:binding.sessionId}),current));
      const observed = correlateHistory(binding.sessionId,prompts,messages,inbox,active);
      this.assertActive(claim,current,observed.state);
      return observed;
    } catch (error) {
      if (error instanceof RunFenceError) throw error;
      if (error instanceof AgentBindingError) { this.assertActive(claim,current,"quarantined"); return {state:"quarantined"}; }
      this.assertActive(claim,current,"uncertain");
      return {state:"uncertain"};
    }
  }
  async cancel(runId: string, requested: AgentBinding, input: PersistedPrompt): Promise<"pending" | "settled"> {
    const binding = this.bound(runId,requested);
    const prompt = this.prompt(input);
    console.info("[agent] native cancellation attempt",{runId,promptId:prompt.promptId});
    try {
      // Cleanup can stop an owned but quarantined session whose model/location/rules have drifted. It cannot adopt it.
      this.verifyOwner(runId,binding,await this.client.sessionGet({sessionID:binding.sessionId}));
      await this.client.cancelInbox({sessionID:binding.sessionId,inboxID:prompt.promptId});
      await this.client.interrupt({sessionID:binding.sessionId});
      const inbox = await this.client.inbox({sessionID:binding.sessionId});
      const active = await this.client.active();
      this.verifyOwner(runId,binding,await this.client.sessionGet({sessionID:binding.sessionId}));
      const state = inbox.length === 0 && !Object.hasOwn(active,binding.sessionId) ? "settled" : "pending";
      console.info("[agent] native cancellation observed",{runId,promptId:prompt.promptId,state});
      return state;
    } catch (error) {
      console.error("[agent] native cancellation unresolved",{runId,promptId:prompt.promptId});
      if (error instanceof AgentBindingError) throw error;
      return "pending";
    }
  }
}
