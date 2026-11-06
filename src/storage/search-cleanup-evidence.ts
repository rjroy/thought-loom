import type { SearchAdmissionFact, SearchCleanupIdentity, SearchTerminalCertificate } from "../agent/search-cleanup-contract";
import { protocolJson, uniqueKeys } from "../domain/run-protocol";
import { nonEmpty, oneOf, record } from "../domain/validation";
import { SearchCleanupJournalError, type SearchCleanupPrompt } from "./search-cleanup-manifest";

export interface SearchCleanupEvidence {
  readonly version: 1;
  readonly drainOwnerId: string | null;
  readonly admissions: readonly SearchAdmissionFact[];
  readonly prompts: readonly SearchTerminalCertificate[];
  readonly inboxEmpty: boolean | null;
  readonly inactive: boolean | null;
}
const exact = (value: Record<string,unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) throw new SearchCleanupJournalError();
};
function id(value: unknown): string {
  const result = nonEmpty(value,"cleanup evidence identity");
  if (/[\u0000-\u0020\u007f]/.test(result)) throw new SearchCleanupJournalError();
  return result;
}
function flag(value: unknown): boolean | null {
  if (value !== null && typeof value !== "boolean") throw new SearchCleanupJournalError();
  return value;
}
function ownedHash(steps: ReadonlyMap<string,SearchCleanupPrompt>, promptId: unknown, hash: unknown): { promptId: string; inputSha256: string } {
  if (typeof promptId !== "string") throw new SearchCleanupJournalError();
  const step = steps.get(promptId);
  if (!step || step.authorization !== "authorized-uncertain" || step.inputSha256 === null || hash !== step.inputSha256) throw new SearchCleanupJournalError();
  return {promptId:step.promptId,inputSha256:step.inputSha256};
}
export function parseSearchCleanupEvidence(identity: SearchCleanupIdentity, input: string | null): SearchCleanupEvidence {
  if (input === null) return Object.freeze({version:1,drainOwnerId:null,admissions:Object.freeze([]),prompts:Object.freeze([]),inboxEmpty:null,inactive:null});
  try {
    const data = record(JSON.parse(input)); uniqueKeys(input);
    exact(data,["version","drainOwnerId","admissions","prompts","inboxEmpty","inactive"]);
    if (data.version !== 1 || !Array.isArray(data.admissions) || !Array.isArray(data.prompts) ||
      data.admissions.length > identity.manifest.steps.length || data.prompts.length > identity.manifest.steps.length) throw new SearchCleanupJournalError();
    const steps = new Map(identity.manifest.steps.map(step => [step.promptId,step]));
    const admissions = data.admissions.map((input: unknown) => {
      const value = record(input); exact(value,["runId","nativeSessionId","promptId","inputSha256"]);
      if (value.runId !== identity.runId || value.nativeSessionId !== identity.binding.sessionId) throw new SearchCleanupJournalError();
      return Object.freeze({runId:identity.runId,nativeSessionId:identity.binding.sessionId,...ownedHash(steps,value.promptId,value.inputSha256)});
    });
    const prompts = data.prompts.map((input: unknown) => {
      const value = record(input); exact(value,["promptId","inputSha256","userMessageId","assistantMessageId","idleMessageId","outcome"]);
      const owned = ownedHash(steps,value.promptId,value.inputSha256);
      if (value.userMessageId !== owned.promptId) throw new SearchCleanupJournalError();
      return Object.freeze({...owned,userMessageId:owned.promptId,assistantMessageId:value.assistantMessageId === null ? null : id(value.assistantMessageId),
        idleMessageId:id(value.idleMessageId),outcome:oneOf(value.outcome,"cleanup outcome",["completed","failed","interrupted"])});
    });
    if (new Set(admissions.map(item => item.promptId)).size !== admissions.length || new Set(prompts.map(item => item.promptId)).size !== prompts.length) throw new SearchCleanupJournalError();
    return Object.freeze({version:1,drainOwnerId:data.drainOwnerId === null ? null : id(data.drainOwnerId),
      admissions:Object.freeze(admissions),prompts:Object.freeze(prompts),inboxEmpty:flag(data.inboxEmpty),inactive:flag(data.inactive)});
  } catch { throw new SearchCleanupJournalError(); }
}

/** Bounded by the sealed manifest. Conflicting certificates cannot overwrite previously confirmed metadata. */
export function mergeCleanupFacts<T extends {readonly promptId:string}>(old: readonly T[], incoming: readonly T[]): readonly T[] {
  const items = new Map(old.map(item => [item.promptId,item]));
  for (const item of incoming) {
    const prior = items.get(item.promptId);
    if (prior && protocolJson(prior) !== protocolJson(item)) throw new SearchCleanupJournalError();
    items.set(item.promptId,item);
  }
  return [...items.values()];
}
