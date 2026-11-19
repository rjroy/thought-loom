import type { OrdinaryAgentRunView } from "./agent";
import type { RunStatus } from "./run";
import { nonEmpty, oneOf, record, ValidationError } from "./validation";

export interface EvolveSession {
  readonly id: string;
  readonly anchorThoughtId: string;
  readonly continuationThoughtId: string;
  readonly mode: "ideas-only";
  readonly createdAt: string;
}
export interface EvolveTurn {
  readonly id: string;
  readonly parentId: string;
  readonly text: string;
  readonly status: RunStatus | "pending";
  readonly admittedAt: string;
  readonly runId: string | null;
  readonly reply: string | null;
  readonly saves: readonly EvolveSave[];
}
export interface EvolveReceipt { readonly sessionId: string; readonly turnId: string; readonly admittedAt: string }
export type EvolveSpeaker = "user" | "ai";
export interface EvolvePassage {
  readonly speaker: EvolveSpeaker;
  readonly text: string;
  readonly parentId: string;
}
export interface EvolveSave extends EvolvePassage {
  readonly thoughtId: string;
  readonly selectedBy: EvolveSpeaker;
  readonly source: "passage" | "synthesis";
  /** An earlier source turn for a recalled passage. Omitted for the current turn or a synthesis. */
  readonly sourceTurnId?: string;
  /** UTF-16 offset in the indicated speaker's stored message; null for synthesis. */
  readonly start: number | null;
}
export interface EvolveAdmissionView { readonly receipt: EvolveReceipt; readonly turn: EvolveTurn; readonly run: OrdinaryAgentRunView | null }
export interface EvolveSessions {
  create(anchor: string): EvolveSession;
  read(id: string): { session: EvolveSession; turns: EvolveTurn[] };
  admit(id: string, key: string, input: { parentId: string; text: string }): EvolveAdmissionView & { replayed: boolean };
  byKey(id: string, key: string): EvolveAdmissionView | null;
  keep(id: string, turnId: string, key: string, input: EvolvePassage): { receipt: EvolveSave; replayed: boolean };
  saveByKey(id: string, turnId: string, key: string): EvolveSave | null;
  continueAt(id: string, thoughtId: string): EvolveSession;
}
export class EvolveNotFoundError extends Error {}
export class EvolveConflictError extends Error {
  constructor(readonly code: "idempotency-conflict" | "turn-active" | "invalid-continuation" | "invalid-passage") { super(code); }
}
/** Reject values UTF-8 cannot represent exactly before they reach SQLite. */
export function evolveValue(value: unknown, field: string): string {
  const input = nonEmpty(value,field);
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 0) throw new ValidationError(`${field} contains invalid text`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ValidationError(`${field} contains invalid text`);
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new ValidationError(`${field} contains invalid text`);
  }
  return input;
}
export function evolveTurnText(value: unknown): string {
  const text = evolveValue(value,"text");
  if (new TextEncoder().encode(text).length > 4096) throw new ValidationError("text exceeds 4096 UTF-8 bytes");
  return text;
}
export const evolveReplyBytes = 16 * 1024;
export function evolveReplyText(value: unknown): string {
  const text = evolveValue(value,"reply");
  if (new TextEncoder().encode(text).length > evolveReplyBytes) throw new ValidationError("reply exceeds 16384 UTF-8 bytes");
  return text;
}
export interface IdeasSelection {
  readonly speaker: EvolveSpeaker;
  readonly text: string;
  readonly source: "passage" | "synthesis";
  readonly sourceTurnId?: string;
  readonly parentSelection?: number;
}
export function ideasSelections(value: unknown): IdeasSelection[] {
  if (!Array.isArray(value) || value.length > 16) throw new ValidationError("Invalid idea selections");
  return value.map(item => {
    const data = record(item);
    if (Object.keys(data).some(key => !["speaker","text","source","parentSelection","sourceTurnId"].includes(key))) throw new ValidationError("Invalid idea selection");
    const speaker = oneOf(data.speaker,"speaker",["user","ai"]);
    const source = data.source === undefined ? "passage" : oneOf(data.source,"source",["passage","synthesis"]);
    const parent = data.parentSelection;
    if ((speaker === "user" && (source !== "passage" || parent !== undefined)) ||
        (parent !== undefined && (typeof parent !== "number" || !Number.isSafeInteger(parent) || parent < 0))) {
      throw new ValidationError("Invalid idea attribution or parent");
    }
    return {speaker,source,text:evolveTurnText(data.text),...priorPassage(data,source),
      ...(typeof parent === "number" ? {parentSelection:parent} : {})};
  });
}
function priorPassage(data: Record<string,unknown>, source: IdeasSelection["source"]): Pick<IdeasSelection,"sourceTurnId"> {
  if (data.sourceTurnId === undefined) return {};
  if (source !== "passage") throw new ValidationError("Only a passage can cite a source turn");
  return {sourceTurnId:evolveValue(data.sourceTurnId,"sourceTurnId")};
}
export function ideasSaveRequest(value: unknown): EvolvePassage & Pick<IdeasSelection,"source" | "sourceTurnId"> {
  const data = record(value);
  if (Object.keys(data).some(key => !["speaker","text","parentId","source","sourceTurnId"].includes(key))) throw new ValidationError("Invalid saveIdea arguments");
  const speaker = oneOf(data.speaker,"speaker",["user","ai"]);
  const source = data.source === undefined ? "passage" : oneOf(data.source,"source",["passage","synthesis"]);
  const prior = priorPassage(data,source);
  if (speaker === "user" && source !== "passage" || speaker === "ai" && source === "passage" && prior.sourceTurnId === undefined) {
    throw new ValidationError("Incremental saves require a user excerpt, prior finalized passage or AI synthesis");
  }
  return {speaker,source,parentId:evolveValue(data.parentId,"parentId"),text:evolveTurnText(data.text),...prior};
}

function risksClippingStraightSingleQuote(message: string, start: number, end: number): boolean {
  // A possible opening quote makes this excerpt ambiguous: a later apostrophe
  // may be a possessive, not a closing delimiter. Retaining the whole message
  // preserves attribution context. Apostrophes after a word do not open quotes.
  if (start === 0 && end === message.length) return false;
  return /(?<![\p{L}\p{M}\p{N}_])'(?=\S)/u.test(message.slice(0,end));
}

/** Text matching establishes provenance, not endorsement. Reject obvious clipped quotations or sentences for automatic user saves. */
export function automaticUserPassage(message: string, text: string, start: number): boolean {
  const before = message.slice(0,start), after = message.slice(start+text.length);
  if (text !== text.trim() || /^["“”‘’'`>]/u.test(text) || /\?$/u.test(text) ||
      /^(?:maybe|perhaps|suppose|imagine|what if|please|remember this|consider this)\b/i.test(text) ||
      /^(?:yes|no|ok(?:ay)?|thanks|got it)[.!]?$/i.test(text)) return false;
  if (start !== 0 && !/(?:[.!?:]\s*|\n[ \t]*)$/u.test(before)) return false;
  if (after.trim() && !/[.!]$/u.test(text) && !/^[ \t]*\n/u.test(after)) return false;
  if (/^\s*(?:["'”’`]|[,;]|\b(?:but|unless|or|however|although)\b)/iu.test(after)) return false;
  if ((before.match(/(?<!\\)"/g)?.length ?? 0) % 2 || before.lastIndexOf("“") > before.lastIndexOf("”") ||
      (before.match(/(?<!\\)`/g)?.length ?? 0) % 2 || before.lastIndexOf("‘") > before.lastIndexOf("’")) return false;
  if (risksClippingStraightSingleQuote(message,start,start + text.length)) return false;
  if (/(?:^|\n)[ \t]*>.*$/u.test(before) || /\b(?:says?|said|claims?|claimed|wrote|quotes?|quoting|hypothesis|example|according to)\b[^\n.!?]*:\s*$/iu.test(before)) return false;
  return true;
}
/** Stable provenance check shared by publication and the historical backup codec. */
export function exactEvolvePassageStart(message: string | null, text: string, requireUnique: boolean): number {
  if (message === null) throw new EvolveConflictError("invalid-passage");
  const start = message.indexOf(text);
  if (start < 0 || (requireUnique && message.indexOf(text,start+1) !== -1)) throw new EvolveConflictError("invalid-passage");
  return start;
}
export function evolvePassageStart(message: string | null, text: string, requireUnique: boolean, conservativeUser: boolean): number {
  const start = exactEvolvePassageStart(message,text,requireUnique);
  if (conservativeUser && message !== null && !automaticUserPassage(message,text,start)) throw new EvolveConflictError("invalid-passage");
  return start;
}
export function evolveKey(value: unknown): string {
  const key = nonEmpty(value,"request key");
  if (key === "." || key === ".." || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new ValidationError("Invalid request key");
  return key;
}
