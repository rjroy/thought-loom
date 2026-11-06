import type { InboxItem, NativeMessage, Observation, PersistedPrompt, ImportObservation, ImportTerminalEvidence } from "./opencode-adapter";
import { createHash } from "node:crypto";
import { AgentBindingError, allowsNativeTools, type AgentBinding } from "./binding";
import { AgentUncertainError } from "./errors";

/** Restricted protocols and cleanup use the deny-tools default, regardless of any other caller's binding. */
export function hasUntrackedNativeContext(message: NativeMessage, nativeTools = false): boolean {
  if (message.type === "other") return true;
  if (message.type === "user") return Boolean(message.unsafe);
  return message.type === "assistant" && (Boolean(message.unsafe) || (!nativeTools && (message.tools?.length ?? 0) > 0));
}

/** Native has no assistant-to-user parent field. Only a closed, contiguous owned turn supplies output. */
function completedOutput(turn: readonly NativeMessage[], nativeTools: boolean): string | null {
  const terminal = turn.at(-1);
  if (turn.length < 2 || (!nativeTools && turn.length !== 2) || terminal?.type !== "idle" || terminal.error || terminal.outcome !== "succeeded") return null;
  let final: Extract<NativeMessage,{type:"assistant"}> | undefined;
  for (let index = 0; index < turn.length - 1; index++) {
    const message = turn[index];
    if (!message || message.type !== "assistant" || message.error || !Number.isFinite(message.time.completed)) return null;
    const tools = message.tools ?? [], seen = new Set<string>();
    for (const tool of tools) {
      // A tool error is settled; a later assistant can recover without turning it into a run failure.
      if (!nativeTools || typeof tool.id !== "string" || !tool.id.trim() || typeof tool.name !== "string" || !tool.name.trim() || seen.has(tool.id) ||
          (tool.status !== "completed" && tool.status !== "error") || !tool.time || !Number.isFinite(tool.time.created) || !Number.isFinite(tool.time.completed)) return null;
      seen.add(tool.id); // Call IDs belong to this assistant, not a session-global namespace.
    }
    const last = index === turn.length - 2;
    if (last ? message.finish !== "stop" : message.finish !== "tool-calls" || tools.length === 0) return null;
    final = message;
  }
  const output = final?.content.map(item => item.text).join("") ?? "";
  return output.trim() ? output : null;
}

/** Authorize existing native context against a claim-fenced snapshot of all persisted run inputs. */
export function authorizeSubmissionHistory(prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], binding?: AgentBinding): void {
  const nativeTools = binding !== undefined && allowsNativeTools(binding);
  const known = new Map(prompts.map((prompt,index) => [prompt.promptId,{...prompt,index}]));
  const seen = new Set<string>();
  let users = 0, turnStart = -1;
  let uncertain = false;
  for (const [index,message] of messages.entries()) {
    if (hasUntrackedNativeContext(message,nativeTools)) throw new AgentBindingError("Session contains untracked native context");
    if (typeof message.id !== "string" || !message.id || !Number.isFinite(message.time.created)) uncertain = true;
    const duplicate = seen.has(message.id);
    if (duplicate) uncertain = true;
    seen.add(message.id);
    if (message.type !== "user") {
      if (users === 0) uncertain = true;
      continue;
    }
    const owned = known.get(message.id);
    if (!owned || owned.input !== message.text) throw new AgentBindingError("Native input differs from the persisted run history");
    if (duplicate) continue;
    if (owned.index !== users) throw new AgentBindingError("Native input order differs from the persisted run history");
    if (nativeTools && turnStart >= 0 && completedOutput(messages.slice(turnStart+1,index),true) === null) uncertain = true;
    turnStart = index;
    users++;
  }
  if (nativeTools && turnStart >= 0 && completedOutput(messages.slice(turnStart+1),true) === null) uncertain = true;
  if (uncertain || users < prompts.length-1) throw new AgentUncertainError("Native prior context is not fully reconciled");
  if (prompts.length > 0 && users === prompts.length) throw new AgentUncertainError("Prompt already admitted; observe the existing step");
}

type CorrelatedTurn = {readonly state:"pending"|"running"|"uncertain"|"quarantined"}
  | {readonly state:"idle";readonly current:PersistedPrompt;readonly turn:readonly NativeMessage[]};

/** Shared identity/context/inbox gates; terminal interpretation belongs to each protocol. */
function correlateTurn(sessionId: string, prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], inbox: readonly InboxItem[], active: Readonly<Record<string,unknown>>, nativeTools = false): CorrelatedTurn {
  const current = prompts.at(-1);
  if (!current || new Set(prompts.map(item => item.promptId)).size !== prompts.length) return {state:"quarantined"};
  const known = new Map(prompts.map((item,index) => [item.promptId,{...item,index}]));
  const seen = new Set<string>();
  let userCount = 0;
  let currentIndex = -1, turnStart = -1;
  let priorUncertain = false;
  for (const [index,message] of messages.entries()) {
    if (typeof message.id !== "string" || !message.id || !Number.isFinite(message.time.created)) return {state:"uncertain"};
    if (seen.has(message.id)) return {state:"uncertain"};
    if (hasUntrackedNativeContext(message,nativeTools)) return {state:"quarantined"};
    seen.add(message.id);
    if (message.type !== "user") {
      if (userCount === 0) return {state:"uncertain"};
      continue;
    }
    const owned = known.get(message.id);
    if (!owned || owned.input !== message.text || owned.index !== userCount) return {state:"quarantined"};
    if (nativeTools && turnStart >= 0 && completedOutput(messages.slice(turnStart+1,index),true) === null) priorUncertain = true;
    turnStart = index;
    userCount++;
    if (message.id === current.promptId) currentIndex = index;
  }
  const queued = new Set<string>();
  for (const item of inbox) {
    if (item.sessionID !== sessionId || item.type !== "user" || !known.has(item.id) || known.get(item.id)?.input !== item.payload.text || queued.has(item.id)) return {state:"quarantined"};
    queued.add(item.id);
    // Earlier prompts cannot still be pending while this later daemon step is outstanding.
    if (item.id !== current.promptId) return {state:"uncertain"};
  }
  if (priorUncertain) return {state:"uncertain"};
  if (queued.has(current.promptId)) return {state:"pending"};
  if (Object.hasOwn(active,sessionId)) return {state:currentIndex >= 0 ? "running" : "uncertain"};
  if (currentIndex < 0 || userCount !== prompts.length) return {state:"uncertain"};
  return {state:"idle",current,turn:messages.slice(currentIndex+1)};
}

/** Only permissive bindings accept tool-calling intermediate assistants; failed/empty final output stays uncertain. */
export function correlateHistory(sessionId: string, prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], inbox: readonly InboxItem[], active: Readonly<Record<string,unknown>>, binding?: AgentBinding): Observation {
  const nativeTools = binding !== undefined && allowsNativeTools(binding);
  const correlated=correlateTurn(sessionId,prompts,messages,inbox,active,nativeTools);
  if (correlated.state!=="idle") return correlated;
  const output = completedOutput(correlated.turn,nativeTools);
  return output === null ? {state:"uncertain"} : {state:"completed",output};
}

/** Import-only terminal facts. These do not validate segmentation or authorize canonical writes. */
export function correlateImportHistory(sessionId: string, prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], inbox: readonly InboxItem[], active: Readonly<Record<string,unknown>>): ImportObservation {
  if (messages.some(message => hasUntrackedNativeContext(message))) return {state:"quarantined"};
  const correlated=correlateTurn(sessionId,prompts,messages,inbox,active);
  if (correlated.state!=="idle") return correlated;
  let previous=-Infinity;
  for (const message of messages) {
    if (message.time.created<previous) return {state:"uncertain"};
    previous=message.time.created;
  }
  const {turn,current}=correlated;
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
