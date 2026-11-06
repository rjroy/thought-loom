import { createHash } from "node:crypto";
import type { SearchAdmissionFact, SearchCleanupIdentity, SearchTerminalCertificate } from "./search-cleanup-contract";
import { AgentBindingError } from "./binding";
import type { InboxItem, NativeMessage } from "./opencode-adapter";

export interface SearchHistoryFacts {
  readonly admissions: readonly SearchAdmissionFact[];
  readonly prompts: readonly SearchTerminalCertificate[];
  readonly inboxIds: readonly string[];
  readonly inactive: boolean;
  readonly whollyOwned: boolean;
  readonly terminal: boolean;
}
export const searchInputHash = (input: string): string => createHash("sha256").update(input,"utf8").digest("hex");

/** Inspect IDs/hashes and terminal boundaries only. Never interpret or retain assistant prose. */
export function searchHistoryFacts(identity: SearchCleanupIdentity, messages: readonly NativeMessage[], inbox: readonly InboxItem[],
  active: Readonly<Record<string,unknown>>): SearchHistoryFacts {
  const authorized = identity.manifest.steps.filter(step => step.authorization === "authorized-uncertain");
  const known = new Map(authorized.map(step => [step.promptId,step]));
  const seen = new Set<string>(), inboxIds = new Set<string>();
  const admissions: SearchAdmissionFact[] = [], prompts: SearchTerminalCertificate[] = [];
  let current: typeof authorized[number] | undefined;
  let userCreated = 0;
  let turn: NativeMessage[] = [];
  const conflict = (): never => { throw new AgentBindingError("Search native cleanup ownership differs"); };
  const finish = () => {
    if (!current) return;
    const terminal = turn.at(-1), first = turn[0];
    const assistant = first?.type === "assistant" ? first : null;
    if (!terminal || terminal.type !== "idle" || !((turn.length === 1 && first?.type === "idle") || (turn.length === 2 && assistant))) return;
    if (terminal.time.created < userCreated || (assistant && (assistant.time.created < userCreated || terminal.time.created < assistant.time.created))) return;
    if (!["succeeded","failed","interrupted"].includes(terminal.outcome)) return;
    if (terminal.outcome === "succeeded" && (!assistant || !Number.isFinite(assistant.time.completed))) return;
    if (assistant && assistant.time.completed !== undefined && !Number.isFinite(assistant.time.completed)) return;
    if (assistant?.time.completed !== undefined && assistant.time.completed < assistant.time.created) return;
    const outcome = terminal.outcome === "interrupted" ? "interrupted" : terminal.outcome === "failed" || terminal.error || assistant?.error || assistant?.finish === "error" ? "failed" : "completed";
    if (current.inputSha256 === null) return;
    prompts.push(Object.freeze({promptId:current.promptId,inputSha256:current.inputSha256,userMessageId:current.promptId,
      assistantMessageId:assistant?.id ?? null,idleMessageId:terminal.id,outcome}));
  };
  for (const message of messages) {
    if (typeof message.id !== "string" || !message.id.trim() || !Number.isFinite(message.time.created) || seen.has(message.id) ||
      message.type === "other" || ((message.type === "user" || message.type === "assistant") && message.unsafe)) conflict();
    seen.add(message.id);
    if (message.type === "user") {
      finish();
      const owned = known.get(message.id);
      const hash = searchInputHash(message.text);
      if (!owned || owned.inputSha256 === null || owned !== authorized[admissions.length] || hash !== owned.inputSha256) conflict();
      current = owned; userCreated = message.time.created; turn = [];
      admissions.push(Object.freeze({runId:identity.runId,nativeSessionId:identity.binding.sessionId,promptId:message.id,inputSha256:hash}));
    } else {
      if (!current) conflict();
      turn.push(message);
    }
  }
  finish();
  for (const item of inbox) {
    const owned = known.get(item.id);
    if (item.type !== "user" || item.sessionID !== identity.binding.sessionId || !Number.isFinite(item.time.created) || !owned ||
      owned.inputSha256 === null || searchInputHash(item.payload.text) !== owned.inputSha256 || inboxIds.has(item.id)) conflict();
    inboxIds.add(item.id);
  }
  const represented = new Set([...admissions.map(item => item.promptId),...inboxIds]);
  const whollyOwned = authorized.length > 0 && authorized.every(step => represented.has(step.promptId));
  const inactive = !Object.hasOwn(active,identity.binding.sessionId);
  return Object.freeze({admissions:Object.freeze(admissions),prompts:Object.freeze(prompts),inboxIds:Object.freeze([...inboxIds]),inactive,whollyOwned,
    terminal:admissions.length === authorized.length && prompts.length === authorized.length && inboxIds.size === 0 && inactive});
}
