import { protocolJson, uniqueKeys, type StepState } from "../domain/run-protocol";
import type { NativeState } from "../domain/run";
import { nonEmpty, oneOf, record } from "../domain/validation";

export type SearchPromptAuthorization = "never-authorized" | "authorized-uncertain" | "unattributed";
export interface SearchCleanupPrompt {
  readonly position: number;
  readonly promptId: string;
  /** Lowercase SHA-256 of exact UTF-8 input, or honest missing historical input. Never the input itself. */
  readonly inputSha256: string | null;
  readonly submitOwnerId: string | null;
  readonly authorization: SearchPromptAuthorization;
  readonly state: StepState;
  readonly nativeState: NativeState;
}
export interface SearchCleanupManifest {
  readonly version: 1;
  readonly runId: string;
  readonly searchSessionId: string;
  readonly nativeSessionId: string;
  readonly fencedGeneration: number;
  readonly setupOwnerId: string | null;
  readonly steps: readonly SearchCleanupPrompt[];
}
export class SearchCleanupJournalError extends Error {
  constructor() { super("Search cleanup journal is unavailable or invalid"); }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) throw new SearchCleanupJournalError();
}
function identity(input: unknown): string {
  const value = nonEmpty(input,"cleanup identity");
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new SearchCleanupJournalError();
  return value;
}
const nullableIdentity = (input: unknown): string | null => input === null ? null : identity(input);
function integer(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) throw new SearchCleanupJournalError();
  return input;
}
function prompt(input: unknown, position: number): SearchCleanupPrompt {
  const data = record(input);
  exact(data,["position","promptId","inputSha256","submitOwnerId","authorization","state","nativeState"]);
  if (integer(data.position) !== position || (data.inputSha256 !== null &&
    (typeof data.inputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.inputSha256)))) throw new SearchCleanupJournalError();
  const state = oneOf(data.state,"cleanup step state",["prepared","submitting","uncertain","completed","processed"]);
  const nativeState = oneOf(data.nativeState,"cleanup native state",["unknown","running","completed"]);
  const authorization = oneOf(data.authorization,"cleanup authorization",["never-authorized","authorized-uncertain","unattributed"]);
  const submitOwnerId = nullableIdentity(data.submitOwnerId);
  const expected = state === "prepared" ? "never-authorized" : submitOwnerId === null ? "unattributed" : "authorized-uncertain";
  if (authorization !== expected || (state === "prepared" && (submitOwnerId !== null || nativeState !== "unknown")) ||
    ((state === "completed" || state === "processed") !== (nativeState === "completed"))) throw new SearchCleanupJournalError();
  return Object.freeze({position,promptId:identity(data.promptId),inputSha256:data.inputSha256,submitOwnerId,authorization,state,nativeState});
}

/** Exact whitelist, including duplicate-key rejection. Missing hashes are retained uncertainty, not native proof. */
export function parseSearchCleanupManifest(input: string): SearchCleanupManifest {
  try {
    const data = record(JSON.parse(input));
    uniqueKeys(input);
    exact(data,["version","runId","searchSessionId","nativeSessionId","fencedGeneration","setupOwnerId","steps"]);
    if (data.version !== 1 || !Array.isArray(data.steps) || data.steps.length === 0) throw new SearchCleanupJournalError();
    const steps = data.steps.map((value: unknown,index: number) => prompt(value,index));
    if (new Set(steps.map(step => step.promptId)).size !== steps.length) throw new SearchCleanupJournalError();
    return Object.freeze({version:1,runId:identity(data.runId),searchSessionId:identity(data.searchSessionId),
      nativeSessionId:identity(data.nativeSessionId),fencedGeneration:integer(data.fencedGeneration),
      setupOwnerId:nullableIdentity(data.setupOwnerId),steps:Object.freeze(steps)});
  } catch { throw new SearchCleanupJournalError(); }
}

export function encodeSearchCleanupManifest(input: SearchCleanupManifest): string {
  try { return protocolJson(parseSearchCleanupManifest(protocolJson(input))); }
  catch { throw new SearchCleanupJournalError(); }
}

/** Last possibly authorized prompt, not an unsubmitted successor. All issued prompts remain in the manifest. */
export function searchCleanupFocus(manifest: SearchCleanupManifest): SearchCleanupPrompt {
  const step = manifest.steps.findLast(step => step.authorization !== "never-authorized") ?? manifest.steps.at(-1);
  if (!step) throw new SearchCleanupJournalError();
  return step;
}
