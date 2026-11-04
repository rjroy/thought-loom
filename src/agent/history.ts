import type { InboxItem, NativeMessage, Observation, PersistedPrompt } from "./opencode-adapter";
import { AgentBindingError } from "./binding";
import { AgentUncertainError } from "./errors";

/** Authorize existing native context against a claim-fenced snapshot of all persisted run inputs. */
export function authorizeSubmissionHistory(prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[]): void {
  const known = new Map(prompts.map((prompt,index) => [prompt.promptId,{...prompt,index}]));
  const seen = new Set<string>();
  let users = 0;
  let uncertain = false;
  for (const message of messages) {
    if (message.type === "other" || ((message.type === "user" || message.type === "assistant") && message.unsafe)) throw new AgentBindingError("Session contains untracked native context");
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
    users++;
  }
  if (uncertain || users < prompts.length-1) throw new AgentUncertainError("Native prior context is not fully reconciled");
  if (prompts.length > 0 && users === prompts.length) throw new AgentUncertainError("Prompt already admitted; observe the existing step");
}

/** Correlate one outstanding prompt using the complete ordered history, never idle/absence alone. */
export function correlateHistory(sessionId: string, prompts: readonly PersistedPrompt[], messages: readonly NativeMessage[], inbox: readonly InboxItem[], active: Readonly<Record<string,unknown>>): Observation {
  const current = prompts.at(-1);
  if (!current || new Set(prompts.map(item => item.promptId)).size !== prompts.length) return {state:"quarantined"};
  const known = new Map(prompts.map((item,index) => [item.promptId,{...item,index}]));
  const seen = new Set<string>();
  let userCount = 0;
  let currentIndex = -1;
  for (const [index,message] of messages.entries()) {
    if (typeof message.id !== "string" || !message.id || !Number.isFinite(message.time.created)) return {state:"uncertain"};
    if (seen.has(message.id)) return {state:"uncertain"};
    if (message.type === "other" || ((message.type === "user" || message.type === "assistant") && message.unsafe)) return {state:"quarantined"};
    seen.add(message.id);
    if (message.type !== "user") {
      if (userCount === 0) return {state:"uncertain"};
      continue;
    }
    const owned = known.get(message.id);
    if (!owned || owned.input !== message.text || owned.index !== userCount) return {state:"quarantined"};
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
  if (queued.has(current.promptId)) return {state:"pending"};
  if (Object.hasOwn(active,sessionId)) return {state:currentIndex >= 0 ? "running" : "uncertain"};
  if (currentIndex < 0 || userCount !== prompts.length) return {state:"uncertain"};
  const turn = messages.slice(currentIndex+1);
  const assistants = turn.filter(item => item.type === "assistant");
  const assistant = assistants[0];
  const terminal = turn.at(-1);
  if (turn.length !== 2 || turn[0]?.type !== "assistant" || assistants.length !== 1 || !assistant || assistant.error || assistant.finish !== "stop" || !Number.isFinite(assistant.time.completed) ||
      !terminal || terminal.type !== "idle" || terminal.error || terminal.outcome !== "succeeded") return {state:"uncertain"};
  const output = assistant.content.map(item => item.text).join("");
  return output.trim() ? {state:"completed",output} : {state:"uncertain"};
}
