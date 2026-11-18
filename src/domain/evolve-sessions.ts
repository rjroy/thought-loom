import { nonEmpty, ValidationError } from "./validation";

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
  readonly status: "pending";
  readonly admittedAt: string;
}
export interface EvolveReceipt { readonly sessionId: string; readonly turnId: string; readonly admittedAt: string }
export interface EvolveSessions {
  create(anchor: string): EvolveSession;
  read(id: string): { session: EvolveSession; turns: EvolveTurn[] };
  admit(id: string, key: string, input: { parentId: string; text: string }): { receipt: EvolveReceipt; turn: EvolveTurn; replayed: boolean };
  byKey(id: string, key: string): { receipt: EvolveReceipt; turn: EvolveTurn } | null;
}
export class EvolveNotFoundError extends Error {}
export class EvolveConflictError extends Error {
  constructor(readonly code: "idempotency-conflict" | "turn-active" | "invalid-continuation") { super(code); }
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
export function evolveKey(value: unknown): string {
  const key = nonEmpty(value,"request key");
  if (key === "." || key === ".." || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new ValidationError("Invalid request key");
  return key;
}
