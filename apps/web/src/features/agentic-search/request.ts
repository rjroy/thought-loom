import type { Composer, Control, Discovery, Message, NormalPage, Page, Preview, Run, Session, TurnPayload } from "./types";

export interface Clock { readonly at: string; readonly timeZone: string }
/** Format this instant in the reported zone, preserving its actual offset, not the server's timezone. */
export function clientClock(instant = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Clock {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(instant);
  const get = (name: Intl.DateTimeFormatPartTypes): string => { const part = parts.find(item => item.type === name); if (!part) throw new Error("Clock unavailable"); return part.value; };
  const year = Number(get("year")), month = Number(get("month")), day = Number(get("day")), hour = Number(get("hour")), minute = Number(get("minute")), second = Number(get("second"));
  const wall = new Date(0); wall.setUTCFullYear(year,month-1,day); wall.setUTCHours(hour,minute,second,0);
  const offset = Math.round((wall.getTime()-Math.floor(instant.getTime()/1000)*1000)/60000), sign = offset < 0 ? "-" : "+", absolute = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2,"0");
  return {at:`${String(year).padStart(4,"0")}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${sign}${pad(Math.floor(absolute/60))}:${pad(absolute%60)}`,timeZone};
}
export class SearchRequestError extends Error { constructor(readonly status: number, readonly code: string | null) { super("Search request failed"); } }
export interface SearchClient {
  readonly catalog: (cursor?: string) => Promise<Page<Session>>;
  readonly metadata: (id: string) => Promise<{session: Session; activeRun: Run | null; eligibilityRevision: number}>;
  readonly create: (key: string) => Promise<{session: Session}>;
  readonly rename: (id: string, title: string, revision: number) => Promise<{session: Session}>;
  readonly removeSession: (id: string) => Promise<void>;
  readonly open: (id: string) => Promise<Composer>;
  readonly refresh: (id: string, composer: string) => Promise<Composer>;
  readonly discard: (id: string, composer: string) => Promise<void>;
  readonly messages: (id: string, composer: string | null, cursor?: string) => Promise<NormalPage<Message> | Page<Message>>;
  readonly discoveries: (id: string, composer: string | null, cursor?: string) => Promise<NormalPage<Discovery> | Page<Discovery>>;
  readonly preview: (id: string, composer: string, thought: string) => Promise<Preview>;
  readonly removeOccurrence: (id: string, entry: string) => Promise<number>;
  readonly admit: (id: string, key: string, payload: TurnPayload) => Promise<Control>;
  readonly byKey: (id: string, key: string) => Promise<Control>;
  readonly check: (run: string, sessionId: string) => Promise<Run>;
  readonly stop: (run: string) => Promise<Run>;
  readonly cancelReads: (sessionId: string) => void;
}
export function createSearchClient(fetcher: typeof fetch = fetch, clock: () => Clock = clientClock): SearchClient {
  const reads = new Map<string,Set<AbortController>>();
  async function call<T>(path: string, method = "GET", body?: string, extra: Record<string,string> = {}, owner?: string): Promise<T> {
    const sample = clock(), controller = method === "GET" && owner ? new AbortController() : undefined;
    if (controller && owner) { const current = reads.get(owner) ?? new Set<AbortController>(); current.add(controller); reads.set(owner,current); }
    try {
      const response = await fetcher(path,{method,cache:"no-store",headers:{"x-thoughtloom-client-time":sample.at,"x-thoughtloom-client-zone":sample.timeZone,...(body === undefined ? {} : {"content-type":"application/json"}),...extra},...(body === undefined ? {} : {body}),...(controller ? {signal:controller.signal} : {})});
      if (!response.ok) { let code: string | null = null; try { const data: {code?: string} = await response.json(); if (typeof data.code === "string") code = data.code; } catch { /* Keep the status without exposing upstream text. */ } throw new SearchRequestError(response.status,code); }
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    } finally { if (controller && owner) { const current = reads.get(owner); current?.delete(controller); if (current?.size === 0) reads.delete(owner); } }
  }
  const base = (id: string) => `/api/search-sessions/${encodeURIComponent(id)}`;
  const page = (id: string, kind: string, composer: string | null, cursor?: string) => {
    const p = new URLSearchParams(composer === null ? {scope:"history"} : {composerId:composer}); if (cursor) p.set("cursor",cursor);
    return `${base(id)}/${kind}?${p}`;
  };
  return {
    catalog: cursor => call(`/api/search-sessions${cursor ? `?${new URLSearchParams({cursor})}` : ""}`),
    metadata: id => call(base(id),"GET",undefined,{},id), create: key => call("/api/search-sessions","POST","{}",{"idempotency-key":key}),
    rename: (id,title,revision) => call(base(id),"PATCH",JSON.stringify({title}),{"if-match":String(revision)}),
    removeSession: id => call(base(id),"DELETE"),
    open: id => call(`${base(id)}/composer-contexts`,"POST","{}"),
    refresh: (id,composer) => call(`${base(id)}/composer-contexts/${encodeURIComponent(composer)}`,"GET",undefined,{},id),
    discard: (id,composer) => call(`${base(id)}/composer-contexts/${encodeURIComponent(composer)}`,"DELETE"),
    messages: (id,composer,cursor) => call(page(id,"messages",composer,cursor),"GET",undefined,{},id),
    discoveries: (id,composer,cursor) => call(page(id,"discoveries",composer,cursor),"GET",undefined,{},id),
    preview: (id,composer,thought) => call(`${base(id)}/composer-contexts/${encodeURIComponent(composer)}/thoughts/${encodeURIComponent(thought)}`,"GET",undefined,{},id),
    async removeOccurrence(id,entry) {
      const sample = clock(), response = await fetcher(`${base(id)}/discoveries/${encodeURIComponent(entry)}`,{method:"DELETE",cache:"no-store",headers:{"x-thoughtloom-client-time":sample.at,"x-thoughtloom-client-zone":sample.timeZone}});
      if (response.status !== 204) throw new SearchRequestError(response.status,null);
      const revision = response.headers.get("search-session-revision");
      if (revision === null || !/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new SearchRequestError(502,null);
      return Number(revision);
    },
    admit: (id,key,payload) => call(`${base(id)}/turns`,"POST",JSON.stringify(payload),{"idempotency-key":key}),
    byKey: (id,key) => call(`${base(id)}/turns/by-key/${encodeURIComponent(key)}`,"GET",undefined,{},id),
    check: (run,sessionId) => call(`/api/search-runs/${encodeURIComponent(run)}`,"GET",undefined,{},sessionId),
    stop: run => call(`/api/search-runs/${encodeURIComponent(run)}/stop`,"POST","{}"),
    cancelReads(id) { for (const controller of reads.get(id) ?? []) controller.abort(); reads.delete(id); },
  };
}
