import type { InboxItem, NativeInboxItem, NativeMessage, Observation, PersistedPrompt, ImportObservation, ImportTerminalEvidence, PublicClient } from "./opencode-adapter";
import { createHash } from "node:crypto";
import { AgentBindingError, allowsNativeTools, type AgentBinding } from "./binding";
import { AgentUncertainError } from "./errors";

/** Shared SDK pagination; callers supply their existing authority/lifetime-fenced read around every page. */
export async function readNativeHistory(sessionId: string, read: PublicClient["history"]): Promise<readonly NativeMessage[]> {
  const messages: NativeMessage[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const input: Parameters<PublicClient["history"]>[0] = cursor === undefined ? {sessionID:sessionId,order:"asc"} : {sessionID:sessionId,cursor};
    const page = await read(input);
    for (const message of page.data) messages.push(message);
    cursor = page.cursor.next;
    if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) throw new AgentUncertainError("Native history cursor made no progress");
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  return messages;
}

/** Restricted protocols and cleanup use the deny-tools default, regardless of any other caller's binding. */
export function hasUntrackedNativeContext(message: NativeMessage, nativeTools = false): boolean {
  if (message.type === "other") return !nativeTools && (message.nativeType === "tool" || message.nativeType === "shell");
  if (message.type === "user") return Boolean(message.unsafe);
  return message.type === "assistant" && !nativeTools && message.hasTools === true;
}

/** Unexpected pending context cannot be admitted by text matching alone. */
export function hasUntrackedInboxContext(item: InboxItem): boolean {
  return Boolean(item.unsafe);
}

/** Native has no assistant-to-user parent field; the last parent assistant and its idle close the owned turn. */
function completedOutput(turn: readonly NativeMessage[]): string | null {
  const boundaries = turn.filter(message => message.type === "assistant" || message.type === "idle");
  const terminal = boundaries.at(-1), final = boundaries.at(-2);
  if (terminal?.type !== "idle" || terminal.error || terminal.outcome !== "succeeded" ||
      boundaries.filter(message => message.type === "idle").length !== 1 || final?.type !== "assistant" ||
      final.error || final.unsafe || typeof final.time.completed !== "number" || !Number.isFinite(final.time.completed) ||
      final.time.completed < final.time.created || final.time.completed > terminal.time.created ||
      final.finish !== "stop" || final.hasTools) return null;
  const output = final?.content.map(item => item.text).join("") ?? "";
  return output.trim() ? output : null;
}

/** Authorize existing native context against a claim-fenced snapshot of all persisted run inputs. */
export function authorizeSubmissionHistory(prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], binding?: AgentBinding): void {
  const nativeTools = binding !== undefined && allowsNativeTools(binding);
  const known = new Map(prompts.map((prompt,index) => [prompt.promptId,{...prompt,index}]));
  const seen = new Set<string>();
  let users = 0;
  let uncertain = false;
  for (const message of messages) {
    if (hasUntrackedNativeContext(message,nativeTools)) throw new AgentBindingError("Session contains untracked native context");
    if (typeof message.id !== "string" || !message.id || !Number.isFinite(message.time.created)) uncertain = true;
    const duplicate = seen.has(message.id);
    if (duplicate) uncertain = true;
    seen.add(message.id);
    if (message.type !== "user") {
      continue;
    }
    const owned = known.get(message.id);
    if (!owned || owned.input !== message.text) throw new AgentBindingError("Native input differs from the persisted run history");
    if (duplicate) continue;
    if (owned.index !== users) throw new AgentBindingError("Native input order differs from the persisted run history");
    users++;
  }
  if (uncertain || users < prompts.length-1) throw new AgentUncertainError("Native prior context is not fully reconciled");
  if (prompts.length > 0 && users === prompts.length) throw new AgentUncertainError("Prompt already admitted; observe the existing step");
}

type CorrelatedTurn = {readonly state:"pending"|"running"|"uncertain"|"quarantined"}
  | {readonly state:"idle";readonly current:PersistedPrompt;readonly turn:readonly NativeMessage[]};

/** Shared identity/context/inbox gates; terminal interpretation belongs to each protocol. */
function correlateTurn(sessionId: string, prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], inbox: readonly NativeInboxItem[], active: Readonly<Record<string,unknown>>, nativeTools = false): CorrelatedTurn {
  const current = prompts.at(-1);
  if (!current || new Set(prompts.map(item => item.promptId)).size !== prompts.length) return {state:"quarantined"};
  const known = new Map(prompts.map((item,index) => [item.promptId,{...item,index}]));
  const seen = new Set<string>();
  let userCount = 0;
  let currentIndex = -1;
  for (const [index,message] of messages.entries()) {
    if (typeof message.id !== "string" || !message.id || !Number.isFinite(message.time.created)) return {state:"uncertain"};
    if (seen.has(message.id)) return {state:"uncertain"};
    if (hasUntrackedNativeContext(message,nativeTools)) return {state:"quarantined"};
    seen.add(message.id);
    if (message.type !== "user") {
      continue;
    }
    const owned = known.get(message.id);
    if (!owned || owned.input !== message.text || owned.index !== userCount) return {state:"quarantined"};
    userCount++;
    if (message.id === current.promptId) currentIndex = index;
  }
  const queued = new Set<string>();
  let auxiliary = false;
  for (const item of inbox) {
    if (item.sessionID !== sessionId) return {state:"quarantined"};
    if (item.type !== "user") { auxiliary = true; continue; }
    if (hasUntrackedInboxContext(item) || !known.has(item.id) || known.get(item.id)?.input !== item.payload.text || queued.has(item.id)) return {state:"quarantined"};
    queued.add(item.id);
    // Earlier prompts cannot still be pending while this later daemon step is outstanding.
    if (item.id !== current.promptId) return {state:"uncertain"};
  }
  if (auxiliary || queued.has(current.promptId)) return {state:"pending"};
  if (Object.hasOwn(active,sessionId)) return {state:currentIndex >= 0 ? "running" : "uncertain"};
  if (currentIndex < 0 || userCount !== prompts.length) return {state:"uncertain"};
  return {state:"idle",current,turn:messages.slice(currentIndex+1)};
}

/** Deny-bound sessions reject tool evidence separately from output correlation. */
export function correlateHistory(sessionId: string, prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], inbox: readonly NativeInboxItem[], active: Readonly<Record<string,unknown>>, binding?: AgentBinding): Observation {
  const nativeTools = binding !== undefined && allowsNativeTools(binding);
  const correlated=correlateTurn(sessionId,prompts,messages,inbox,active,nativeTools);
  if (correlated.state!=="idle") return correlated;
  const output = completedOutput(correlated.turn);
  return output === null ? {state:"uncertain"} : {state:"completed",output};
}

/** Cancellation needs terminal execution facts for every dispatched input, not a successful protocol reply. */
export function cancellationHistorySettled(sessionId: string, prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[],
  inbox: readonly NativeInboxItem[], active: Readonly<Record<string,unknown>>, binding: AgentBinding): boolean {
  const nativeTools = allowsNativeTools(binding), seen = new Set<string>();
  const known = new Map(prompts.map((prompt,index) => [prompt.promptId,{...prompt,index}]));
  if (known.size !== prompts.length) throw new AgentBindingError("Cancellation prompt identity is duplicated");
  let users = 0, userCreated = 0, turn: NativeMessage[] = [], terminal = true, previous = -Infinity;
  const finished = (): boolean => {
    const boundaries = turn.filter(message => message.type === "assistant" || message.type === "idle");
    const idle = boundaries.at(-1);
    if (!idle || idle.type !== "idle" || !["succeeded","failed","interrupted"].includes(idle.outcome) || idle.time.created < userCreated) return false;
    if (boundaries.filter(message => message.type === "idle").length !== 1) return false;
    // Interrupted/failed execution can terminate before an assistant is complete, or before one exists at all.
    if (idle.outcome !== "succeeded") return true;
    const final = boundaries.at(-2);
    return final?.type === "assistant" && typeof final.time.completed === "number" && Number.isFinite(final.time.completed) &&
      final.time.completed >= final.time.created && final.time.completed <= idle.time.created &&
      !final.hasTools && ["stop","length","error"].includes(final.finish ?? "");
  };
  for (const message of messages) {
    if (hasUntrackedNativeContext(message,nativeTools)) throw new AgentBindingError("Cancellation history contains untracked native context");
    if (typeof message.id !== "string" || !message.id.trim() || seen.has(message.id) ||
        !Number.isFinite(message.time.created) || message.time.created < previous) throw new AgentBindingError("Cancellation native history order is invalid");
    seen.add(message.id); previous = message.time.created;
    if (message.type === "user") {
      const expected = known.get(message.id);
      if (!expected || expected.index !== users || expected.input !== message.text) throw new AgentBindingError("Cancellation native input differs from the run journal");
      if (users > 0 && !finished()) terminal = false;
      users++; userCreated = message.time.created; turn = [];
    } else {
      if (users > 0) turn.push(message);
    }
  }
  const queued = new Set<string>();
  for (const item of inbox) {
    if (item.sessionID !== sessionId) throw new AgentBindingError("Cancellation native inbox differs from the run journal");
    if (item.type !== "user") continue;
    const expected = known.get(item.id);
    if (hasUntrackedInboxContext(item) || !expected ||
        expected.input !== item.payload.text || queued.has(item.id) || !Number.isFinite(item.time.created)) {
      throw new AgentBindingError("Cancellation native inbox differs from the run journal");
    }
    queued.add(item.id);
  }
  return prompts.length > 0 && terminal && users === prompts.length && finished() &&
    inbox.length === 0 && !Object.hasOwn(active,sessionId);
}

/** Import-only terminal facts. These do not validate segmentation or authorize canonical writes. */
export function correlateImportHistory(sessionId: string, prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], inbox: readonly NativeInboxItem[], active: Readonly<Record<string,unknown>>): ImportObservation {
  if (messages.some(message => hasUntrackedNativeContext(message))) return {state:"quarantined"};
  const correlated=correlateTurn(sessionId,prompts,messages,inbox,active);
  if (correlated.state!=="idle") return correlated;
  let previous=-Infinity;
  for (const message of messages) {
    if (message.time.created<previous) return {state:"uncertain"};
    previous=message.time.created;
  }
  const {current}=correlated;
  const turn=correlated.turn.filter(message => message.type !== "other");
  const terminal=turn.at(-1);
  const first=turn[0];
  const assistant=first?.type==="assistant" ? first : undefined;
  if (!terminal || terminal.type!=="idle" || !((turn.length===1 && first?.type==="idle") || (turn.length===2 && assistant))) return {state:"uncertain"};
  const outcome=terminal.outcome;
  if (outcome!=="succeeded" && outcome!=="failed" && outcome!=="interrupted") return {state:"uncertain"};
  const completed=assistant?.time.completed;
  if (completed!==undefined && !Number.isFinite(completed)) return {state:"uncertain"};
  const output=assistant?.content.map(item => item.text).join("") ?? "";
  const sha256=(text:string):string => createHash("sha256").update(text).digest("hex");
  const evidence:ImportTerminalEvidence={sessionId,promptId:current.promptId,inputSha256:sha256(current.input),userMessageId:current.promptId,
    assistantMessageId:assistant?.id ?? null,idleMessageId:terminal.id,idleOutcome:outcome,
    completedAt:completed ?? null,finish:assistant?.finish ?? null,assistantError:assistant?.error===true,idleError:terminal.error===true,
    outputByteLength:new TextEncoder().encode(output).length,outputSha256:sha256(output)};
  if (outcome==="failed" || outcome==="interrupted") return {state:"terminal-failure",evidence};
  if (!assistant || completed===undefined) return {state:"uncertain"};
  if (assistant.error || terminal.error || assistant.finish==="error") return {state:"terminal-failure",evidence};
  return {state:"terminal-completion",output,evidence};
}
