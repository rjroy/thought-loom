import type { Claim } from "./run";
import { nonEmpty, record, references } from "./validation";
import { searchString } from "./search-session-guards";

export type CapabilityEnvelope = { readonly version: 1; readonly kind: "request"; readonly request: { readonly capability: string; readonly arguments: Readonly<Record<string, unknown>> } };
export type ReplyEnvelope = { readonly version: 1; readonly kind: "complete"; readonly reply: string };
export type ReportEnvelope = { readonly version: 1; readonly kind: "report"; readonly markdown: string; readonly sourceThoughtIds: readonly string[] };
export interface SearchReplyEnvelope {
  readonly version: 1; readonly kind: "search-reply"; readonly reply: string;
  readonly disposition: "awaiting-user" | "done"; readonly sourceThoughtIds: readonly string[];
}
export type ProtocolEnvelope = CapabilityEnvelope | ReplyEnvelope | ReportEnvelope | SearchReplyEnvelope;
export type StepState = "prepared" | "submitting" | "uncertain" | "completed" | "processed";
export interface RunStep {
  readonly runId: string;
  readonly position: number;
  readonly promptId: string;
  /** Null until initial preparation, or when a legacy prompt's exact input was not retained. */
  readonly input: string | null;
  readonly state: StepState;
  readonly envelope: ProtocolEnvelope | null;
  /** Confirmed capability output may be retained before processing binds it to the next exact input. */
  readonly result: unknown | null;
}
/** Internal prepared-original fingerprints, never byte payloads or native observation evidence. */
export interface OriginalMediaPart {
  readonly position: number;
  readonly sourceId: string;
  readonly representation: "original";
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly preparedKey: null;
  readonly recipe: null;
}
export interface OriginalMediaManifest { readonly version: 1; readonly parts: readonly OriginalMediaPart[] }
export interface NextStep {
  readonly promptId: string;
  readonly input: string;
  /** Trusted preparation output for an atomic successor commit, not an agent capability argument. */
  readonly media?: OriginalMediaManifest;
}
export type CancellationState = "none" | "pending" | "settled";
export class ProtocolValidationError extends Error {}

/** JSON-only durable values, with object key order normalized for semantic replay comparisons. */
export function protocolJson(input: unknown): string {
  const ancestors = new Set<object>();
  function encode(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || ancestors.has(value)) throw new ProtocolValidationError("Expected a JSON value");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const fields = Object.getOwnPropertyDescriptors(value);
        if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length+1) throw new ProtocolValidationError("Expected a JSON array");
        return Array.from({ length: value.length },(_item,index) => {
          const field = fields[String(index)];
          if (!field?.enumerable || !("value" in field)) throw new ProtocolValidationError("Expected JSON array elements");
          return encode(field.value);
        });
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ProtocolValidationError("Expected a JSON object");
      const fields = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).length !== Object.keys(fields).length || Object.values(fields).some(field => !field.enumerable || !("value" in field))) {
        throw new ProtocolValidationError("Expected JSON object fields");
      }
      return Object.fromEntries(Object.keys(fields).sort().map(key => [key,encode(fields[key]?.value)]));
    } finally { ancestors.delete(value); }
  }
  return JSON.stringify(encode(input));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) throw new ProtocolValidationError("Invalid envelope fields");
}

/** JSON.parse validates syntax first; this scan rejects duplicate (including escaped) object keys. */
export function uniqueKeys(input: string): void {
  const tokens = input.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  tokens.forEach((token,index) => {
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[index+1] === ":") {
      const keys = stack.at(-1);
      const key: string = JSON.parse(token);
      if (!keys || keys.has(key)) throw new ProtocolValidationError("Duplicate envelope field");
      keys.add(key);
    }
  });
}

/** One whole completed JSON envelope is protocol, never a valid prefix or fallback reply. */
export function parseEnvelope(input: string): ProtocolEnvelope {
  try {
    const data = record(JSON.parse(input));
    uniqueKeys(input);
    if (data.version !== 1) throw new ProtocolValidationError("Unsupported envelope version");
    if (data.kind === "search-reply") {
      exactKeys(data,["version","kind","reply","disposition","sourceThoughtIds"]);
      if (data.disposition !== "awaiting-user" && data.disposition !== "done") throw new ProtocolValidationError();
      const sourceThoughtIds = references(data.sourceThoughtIds,"sourceThoughtIds").map(id => searchString(id,"publication thought ID"));
      if (new Set(sourceThoughtIds).size !== sourceThoughtIds.length) throw new ProtocolValidationError();
      return Object.freeze({version:1,kind:"search-reply",reply:searchString(data.reply,"reply"),disposition:data.disposition,
        sourceThoughtIds:Object.freeze(sourceThoughtIds)});
    }
    if (data.kind === "report") {
      exactKeys(data,["version","kind","markdown","sourceThoughtIds"]);
      const sourceThoughtIds = references(data.sourceThoughtIds,"sourceThoughtIds");
      if (new Set(sourceThoughtIds).size !== sourceThoughtIds.length) throw new ProtocolValidationError("Duplicate report source");
      return Object.freeze({version:1,kind:"report",markdown:nonEmpty(data.markdown,"markdown"),sourceThoughtIds});
    }
    if (data.kind === "complete") {
      exactKeys(data,["version","kind","reply"]);
      return Object.freeze({ version: 1, kind: "complete", reply: nonEmpty(data.reply,"reply") });
    }
    if (data.kind !== "request") throw new ProtocolValidationError("Invalid envelope kind");
    exactKeys(data,["version","kind","request"]);
    const request = record(data.request);
    exactKeys(request,["capability","arguments"]);
    const args = record(request.arguments);
    protocolJson(args);
    return Object.freeze({ version: 1, kind: "request", request: Object.freeze({
      capability: nonEmpty(request.capability,"capability"), arguments: Object.freeze(args),
    }) });
  } catch {
    // Never expose model text, JSON parser excerpts, or partial protocol output as a user response.
    throw new ProtocolValidationError("Expected one strict version 1 protocol envelope");
  }
}
export interface RunProtocolRepository {
  steps(runId: string): readonly RunStep[];
  prepare(claim: Claim, step: NextStep): RunStep;
  setStepState(claim: Claim, promptId: string, state: "submitting" | "uncertain"): void;
  completeStep(claim: Claim, promptId: string, envelope: ProtocolEnvelope): void;
  /** Identify the operation from its persisted step and atomically bind its confirmed result to the next prompt. */
  advance(claim: Claim, promptId: string, result: unknown, next: NextStep): RunStep;
  cancellation(runId: string): CancellationState;
  settleCancellation(runId: string): void;
}
