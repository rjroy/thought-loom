import type { Context } from "hono";
import type { Actor } from "../domain/rejection";
import { uniqueKeys } from "../domain/run-protocol";
import type { SearchClockReceipt } from "./search-clock-receipts";

export type SearchEnv = { Variables: { actor: Actor; searchClockReceipt: SearchClockReceipt | null } };
export type SearchContext = Context<SearchEnv>;
export class SearchHttpError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 415, readonly code: string) { super(code); }
}
export const bad = (): never => { throw new SearchHttpError(400,"invalid-search-request"); };
export function params(c: SearchContext, allowed: readonly string[]): URLSearchParams {
  const p = new URL(c.req.url).searchParams;
  for (const key of p.keys()) if (!allowed.includes(key) || p.getAll(key).length !== 1) return bad();
  return p;
}
export async function bytes(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0, complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) { complete = true; break; }
      length += item.value.length;
      if (length > limit) throw new SearchHttpError(413,"request-too-large");
      chunks.push(item.value);
    }
    const result = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.length; }
    return result;
  } finally { if (!complete) { try { await reader.cancel(); } catch {} } reader.releaseLock(); }
}
export async function object(c: SearchContext, allowed: readonly string[]): Promise<Record<string,unknown>> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(c.req.header("content-type") ?? "")) throw new SearchHttpError(415,"unsupported-media-type");
  const input = await bytes(c.req.raw,4096);
  try {
    const text = new TextDecoder("utf-8",{fatal:true}).decode(input), value: unknown = JSON.parse(text);
    uniqueKeys(text);
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return bad();
    return value as Record<string,unknown>;
  } catch { return bad(); }
}
