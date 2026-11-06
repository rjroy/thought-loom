import { validateSearchRequestClock, type SearchSessions, type SearchRequestClock } from "../domain/agentic-search";
import type { SearchClientClockObservation, SearchClockOwner } from "../domain/search-time";
import { bad } from "./search-http";

export interface SearchClockReceipt { readonly clock: SearchRequestClock; readonly daemonObservedAt: string; readonly sequence: number }
const sameOwner = (a: SearchClockOwner, b: SearchClockOwner): boolean => a.runId === b.runId && a.generation === b.generation &&
  a.searchSessionId === b.searchSessionId && a.nativeSessionId === b.nativeSessionId;

/** One daemon's bounded transient receipts. SQL ownership, not a transport ID, controls association. */
export class SearchClockReceipts {
  private sequence = 0;
  private readonly entries = new Map<string,{ readonly owner: SearchClockOwner; readonly receipt: SearchClockReceipt }>();
  constructor(private readonly sessions: SearchSessions, private readonly now: () => string) {}
  parse(headers: Headers): SearchClockReceipt | null { return parseSearchClockHeaders(headers,this.now,() => ++this.sequence); }
  ownerSession(sessionId: string): SearchClockOwner | null { return this.sessions.clockOwner("user",{sessionId}); }
  ownerRun(runId: string): SearchClockOwner | null { return this.sessions.clockOwner("user",{runId}); }
  record(owner: SearchClockOwner | null, receipt: SearchClockReceipt | null): void {
    if (!owner || !receipt) return;
    const current = this.ownerRun(owner.runId);
    if (!current || !sameOwner(owner,current)) return;
    const existing = this.entries.get(owner.runId);
    if (existing && existing.receipt.sequence >= receipt.sequence) return;
    this.entries.delete(owner.runId); this.entries.set(owner.runId,{owner,receipt});
    if (this.entries.size > 128) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
  latest(owner: SearchClockOwner): SearchClientClockObservation | null {
    const entry = this.entries.get(owner.runId), current = this.ownerRun(owner.runId);
    if (!current) this.entries.delete(owner.runId);
    if (!entry || !current || !sameOwner(owner,current) || entry.owner.searchSessionId !== owner.searchSessionId ||
      entry.owner.nativeSessionId !== owner.nativeSessionId) return null;
    // Claims can advance generation within this same immutable run; the provider's current generation is rechecked above.
    return {searchSessionId:owner.searchSessionId,clock:entry.receipt.clock,daemonObservedAt:entry.receipt.daemonObservedAt};
  }
  forgetRun(runId: string): void { this.entries.delete(runId); }
  forgetSession(sessionId: string): void {
    for (const [runId, entry] of this.entries) if (entry.owner.searchSessionId === sessionId) this.entries.delete(runId);
  }
  clear(): void { this.entries.clear(); }
}

export function parseSearchClockHeaders(headers: Headers, now: () => string = () => new Date().toISOString(), sequence: () => number = () => 0): SearchClockReceipt | null {
  const at = headers.get("x-thoughtloom-client-time"), timeZone = headers.get("x-thoughtloom-client-zone");
  if (at === null && timeZone === null) return null;
  if (at === null || timeZone === null || at.includes(",") || timeZone.includes(",")) return bad();
  const clock = {at,timeZone};
  try { validateSearchRequestClock(clock); } catch { return bad(); }
  return Object.freeze({clock:Object.freeze(clock),daemonObservedAt:now(),sequence:sequence()});
}
