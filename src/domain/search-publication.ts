import type { Claim } from "./run";
import { protocolJson, uniqueKeys } from "./run-protocol";
import { record, ValidationError } from "./validation";
import { searchString } from "./agentic-search";

export interface DiscoveryProposal { readonly thoughtId: string; readonly why: string; readonly evidenceThoughtIds: readonly string[] }
export interface DiscoveryReceipt { readonly type: "discovery-add"; readonly entryId: string; readonly outcome: "added" | "already-active" }
export interface SearchReply {
  readonly version: 1; readonly kind: "search-reply"; readonly reply: string;
  readonly disposition: "awaiting-user" | "done"; readonly sourceThoughtIds: readonly string[];
}
export type SearchPublicationEnvelope = { readonly kind: "discovery"; readonly proposal: DiscoveryProposal }
  | { readonly kind: "reply"; readonly reply: SearchReply };
/** Trusted dispatcher-only persistence. No actor argument can grant this authority to a user request. */
export interface SearchPublication {
  addDiscovery(claim: Claim, promptId: string): DiscoveryReceipt;
  finalizeReply(claim: Claim, promptId: string): void;
}

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = record(input);
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new ValidationError();
  return value;
}
function thoughtIds(input: unknown): readonly string[] {
  if (!Array.isArray(input)) throw new ValidationError();
  const ids = input.map((id: unknown) => searchString(id, "publication thought ID"));
  if (new Set(ids).size !== ids.length) throw new ValidationError();
  return Object.freeze(ids);
}
export function parseSearchPublication(input: string): SearchPublicationEnvelope {
  try {
    uniqueKeys(input);
    const value = record(JSON.parse(input));
    protocolJson(value);
    if (value.version !== 1) throw new ValidationError();
    if (value.kind === "search-reply") {
      fields(value, ["version", "kind", "reply", "disposition", "sourceThoughtIds"]);
      if (value.disposition !== "awaiting-user" && value.disposition !== "done") throw new ValidationError();
      return Object.freeze({ kind: "reply", reply: Object.freeze({ version: 1, kind: "search-reply",
        reply: searchString(value.reply, "reply"), disposition: value.disposition, sourceThoughtIds: thoughtIds(value.sourceThoughtIds) }) });
    }
    fields(value, ["version", "kind", "request"]);
    if (value.kind !== "request") throw new ValidationError();
    const request = fields(value.request, ["capability", "arguments"]);
    if (request.capability !== "addDiscovery") throw new ValidationError();
    const args = fields(request.arguments, ["thoughtId", "why", "evidenceThoughtIds"]);
    return Object.freeze({ kind: "discovery", proposal: Object.freeze({ thoughtId: searchString(args.thoughtId, "thoughtId"),
      why: searchString(args.why, "why"), evidenceThoughtIds: thoughtIds(args.evidenceThoughtIds) }) });
  } catch { throw new ValidationError("Invalid completed search publication envelope"); }
}
export function parseDiscoveryReceipt(input: string): DiscoveryReceipt {
  try {
    uniqueKeys(input);
    const value = fields(JSON.parse(input), ["type", "entryId", "outcome"]);
    if (value.type !== "discovery-add" || (value.outcome !== "added" && value.outcome !== "already-active")) throw new ValidationError();
    return Object.freeze({ type: "discovery-add", entryId: searchString(value.entryId, "entryId"), outcome: value.outcome });
  } catch { throw new ValidationError("Invalid retained discovery receipt"); }
}
