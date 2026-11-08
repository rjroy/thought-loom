import { reinterpretationId, reinterpretationKey, type ReinterpretationEligibility, type ReinterpretationRun, type ReinterpretationSnapshot } from "./reinterpretation";
import type { ReinterpretationClient } from "./reinterpretation-request";

type Identity = {readonly subjectId:string; readonly requestKey:string; readonly kind:"pending" | "confirmed"};
interface Stored {readonly version:1; readonly entries:readonly Identity[]}
export const reinterpretationStorageKey = "thoughtloom.reinterpretation.v1";
export interface ReinterpretationState {
  readonly phase:"idle" | "ready" | "error" | "storage-error";
  readonly request:"idle" | "pending" | "uncertain" | "confirmed";
  readonly requestKey:string | null;
  readonly receipt:ReinterpretationSnapshot["receipt"];
  readonly run:ReinterpretationRun | null;
  readonly eligibility:ReinterpretationEligibility | null;
  readonly fresh:boolean; readonly checking:boolean; readonly stopping:boolean;
  readonly unconfirmedStop:string | null;
  readonly notice:"none" | "storage-error" | "request-refused" | "request-uncertain" | "conflict" | "read-error" | "stop-uncertain" | "stop-requested";
  /** Changes only when confirmed output identities change; caller refreshes the canonical Idea reader. */
  readonly outputRevision:number;
}
interface StorageAccess {getItem(key:string):string | null; setItem(key:string,value:string):void}
export interface ReinterpretationOptions {
  readonly storage?: () => StorageAccess;
  readonly newKey?: () => string;
  readonly schedule?: (callback:() => void,delayMs:number) => () => void;
}
const terminal = (run:ReinterpretationRun) => ["completed","failed","interrupted"].includes(run.status);
const initial = ():ReinterpretationState => ({phase:"idle",request:"idle",requestKey:null,receipt:null,run:null,eligibility:null,
  fresh:false,checking:false,stopping:false,unconfirmedStop:null,notice:"none",outputRevision:0});
function parseStored(raw:string | null): Stored {
  if (raw === null) return {version:1,entries:[]};
  const value:unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2 || !("version" in value) || value.version !== 1 || !("entries" in value) || !Array.isArray(value.entries)) throw new Error("Invalid stored identities");
  const entries:Identity[] = [], seen = new Set<string>();
  for (const item of value.entries) {
    if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).length !== 3
        || !("subjectId" in item) || !reinterpretationId(item.subjectId) || !("requestKey" in item) || typeof item.requestKey !== "string" || !reinterpretationKey(item.requestKey)
        || !("kind" in item) || (item.kind !== "pending" && item.kind !== "confirmed")) throw new Error("Invalid stored identity");
    const identity = `${item.subjectId}:${item.kind}`;
    if (seen.has(identity)) throw new Error("Duplicate stored identity");
    seen.add(identity); entries.push({subjectId:item.subjectId,requestKey:item.requestKey,kind:item.kind});
  }
  return {version:1,entries};
}

/** One subject's command and observation state; no thought content is persisted or fetched here. */
export function createReinterpretationController(subjectId:string, client:ReinterpretationClient, options:ReinterpretationOptions = {}) {
  if (!reinterpretationId(subjectId)) throw new Error("Invalid subject");
  const storage = options.storage ?? (() => sessionStorage), newKey = options.newKey ?? (() => crypto.randomUUID());
  const schedule = options.schedule ?? ((callback,delay) => {const timer = setTimeout(callback,delay); return () => clearTimeout(timer);});
  let state = initial(), generation = 0, watchers = 0, probeKey:string | null = null;
  let abort:AbortController | null = null, reading:Promise<void> | null = null, cancelPoll:(() => void) | null = null;
  const listeners = new Set<() => void>();
  const update = (change:Partial<ReinterpretationState>) => {state = {...state,...change}; for (const listener of listeners) listener();};
  const clearPoll = () => {cancelPoll?.(); cancelPoll = null;};
  const identities = () => parseStored(storage().getItem(reinterpretationStorageKey)).entries;
  function save(entries:readonly Identity[]) {
    const value = JSON.stringify({version:1,entries}), target = storage();
    target.setItem(reinterpretationStorageKey,value);
    if (target.getItem(reinterpretationStorageKey) !== value) throw new Error("Identity storage verification failed");
    parseStored(value);
  }
  function changeIdentity(kind:Identity["kind"], key:string | null) {
    const entries = identities().filter(item => item.subjectId !== subjectId || item.kind !== kind);
    if (key !== null) entries.push({subjectId,requestKey:key,kind});
    save(entries);
  }
  function confirmIdentity(key:string) {
    const entries = identities().filter(item => item.subjectId !== subjectId);
    entries.push({subjectId,requestKey:key,kind:"confirmed"}); save(entries);
  }
  function currentRun():ReinterpretationRun | null {
    const blocker = state.eligibility?.eligible === false ? state.eligibility.blockingRun : null;
    return blocker && !terminal(blocker) ? blocker : state.run ?? blocker;
  }
  function refreshOutput(run:ReinterpretationRun | null) {
    if (!run) return state.outputRevision;
    const blocker = state.eligibility?.eligible === false ? state.eligibility.blockingRun : null;
    const previous = state.run?.id === run.id ? state.run : blocker?.id === run.id ? blocker : null;
    return !previous || JSON.stringify([previous.confirmedThoughtIds,previous.responseId]) !== JSON.stringify([run.confirmedThoughtIds,run.responseId])
      ? state.outputRevision + 1 : state.outputRevision;
  }
  function apply(snapshot:ReinterpretationSnapshot, pending:boolean, key:string) {
    const observed = snapshot.run ?? (snapshot.eligibility.eligible === false ? snapshot.eligibility.blockingRun : null);
    const unconfirmedStop = observed && observed.id === state.unconfirmedStop && terminal(observed) ? null : state.unconfirmedStop;
    if (snapshot.receipt) {
      if (pending) confirmIdentity(key);
      update({phase:"ready",request:"confirmed",requestKey:key,receipt:snapshot.receipt,run:snapshot.run,eligibility:snapshot.eligibility,
        fresh:true,notice:"none",outputRevision:refreshOutput(observed),unconfirmedStop});
    } else {
      update({phase:"ready",eligibility:snapshot.eligibility,fresh:true,notice:"none",outputRevision:refreshOutput(observed),unconfirmedStop,
        ...(pending ? {request:"uncertain" as const,requestKey:key} : {})});
    }
  }
  function poll() {
    clearPoll();
    const observed = currentRun();
    if (watchers && observed && !terminal(observed) && !state.checking && !state.stopping && state.request !== "pending")
      cancelPoll = schedule(() => {cancelPoll = null; void checkReceipt();},2000);
  }
  function invalidate() {
    clearPoll(); generation++; abort?.abort(); abort = null; reading = null;
    update({checking:false,fresh:false});
  }
  function checkReceipt():Promise<void> {
    if (reading) return reading;
    if (state.request === "pending" || state.stopping) return Promise.resolve();
    clearPoll();
    let pending:Identity | undefined, confirmed:Identity | undefined, key:string;
    try {
      const entries = identities(); pending = entries.find(item => item.subjectId === subjectId && item.kind === "pending");
      confirmed = entries.find(item => item.subjectId === subjectId && item.kind === "confirmed");
      if (!pending && !confirmed && !probeKey) { const next = newKey(); if (!reinterpretationKey(next)) throw new Error("Invalid key"); probeKey = next; }
      const selected = pending?.requestKey ?? confirmed?.requestKey ?? probeKey;
      if (!selected) throw new Error("Missing key");
      key = selected;
    } catch { update({phase:"storage-error",notice:"storage-error",fresh:false}); return Promise.resolve(); }
    const epoch = ++generation, controller = new AbortController(); abort = controller;
    const current = () => epoch === generation && !controller.signal.aborted;
    update({checking:true,fresh:false,...(pending ? {request:"uncertain" as const,requestKey:key} : {})});
    const work = (async () => {
      try {
        const result = await client.lookup(subjectId,key,controller.signal);
        if (!current()) return;
        if (result.kind !== "found" || (!pending && !confirmed && result.snapshot.receipt !== null)) { update({phase:"error",notice:"read-error",fresh:false}); return; }
        if (confirmed && !pending && result.snapshot.receipt === null) {
          update({phase:"error",request:"uncertain",requestKey:key,notice:"read-error",fresh:false}); return;
        }
        apply(result.snapshot,!!pending,key);
      } catch { if (current()) update({phase:"storage-error",notice:"storage-error",fresh:false}); }
      finally { if (current()) {reading = null; abort = null; update({checking:false}); poll();} }
    })();
    reading = work; return work;
  }
  async function send(recovering:boolean) {
    if (state.checking || state.stopping || state.request === "pending" || state.unconfirmedStop !== null) return;
    if (recovering ? state.request !== "uncertain" || !state.requestKey : state.request === "uncertain" || !state.fresh || state.eligibility?.eligible !== true) return;
    let key:string;
    try {
      if (recovering) { if (!state.requestKey) return; key = state.requestKey; }
      else {
        key = newKey(); if (!reinterpretationKey(key)) throw new Error("Invalid key");
        const existing = identities().filter(item => item.subjectId === subjectId);
        if (existing.some(item => item.kind === "pending" || item.requestKey === key)) throw new Error("Unresolved or reused identity");
        changeIdentity("pending",key);
      }
    } catch { update({phase:"storage-error",notice:"storage-error",fresh:false}); return; }
    invalidate(); update({request:"pending",requestKey:key,notice:"none"});
    const writeGeneration = generation;
    let result: Awaited<ReturnType<ReinterpretationClient["send"]>>;
    try { result = await client.send(subjectId,key); }
    catch { result = {kind:"uncertain"}; }
    try {
      if (result.kind === "confirmed") apply(result.snapshot,true,key);
      else if (result.kind === "conflict" && !recovering) {
        changeIdentity("pending",null);
        update({phase:"ready",request:state.receipt ? "confirmed" : "idle",requestKey:state.receipt?.requestKey ?? null,
          eligibility:result.snapshot.eligibility,fresh:true,notice:"conflict"});
      } else if (result.kind === "refused" && !recovering) {
        changeIdentity("pending",null);
        update({request:state.receipt ? "confirmed" : "idle",requestKey:state.receipt?.requestKey ?? null,fresh:false,notice:"request-refused"});
      } else update({request:"uncertain",fresh:false,notice:result.kind === "conflict" ? "conflict" : "request-uncertain",
        ...(result.kind === "conflict" ? {eligibility:result.snapshot.eligibility} : {})});
    } catch { update({phase:"storage-error",request:"uncertain",requestKey:key,fresh:false,notice:"storage-error"}); }
    if (generation !== writeGeneration) update({fresh:false});
    poll();
  }
  async function checkRun() {
    const run = currentRun();
    if (!run || state.checking || state.stopping || state.request === "pending") return;
    const epoch = ++generation; update({checking:true,fresh:false});
    try {
      const result = await client.readRun(run.id);
      if (epoch !== generation) return;
      if (result.kind !== "found") {update({notice:"read-error"}); return;}
      const observed = result.run;
      if (state.run?.id === observed.id) update({run:observed,outputRevision:refreshOutput(observed),unconfirmedStop:terminal(observed) ? null : state.unconfirmedStop,notice:"none"});
      else if (state.eligibility?.eligible === false && state.eligibility.reason !== "subject-rejected" && state.eligibility.blockingRun.id === observed.id) update({eligibility:{...state.eligibility,blockingRun:observed},unconfirmedStop:terminal(observed) ? null : state.unconfirmedStop,notice:"none"});
    } catch { if (epoch === generation) update({notice:"read-error"}); }
    finally { if (epoch === generation) {update({checking:false}); poll();} }
  }
  async function stop() {
    const run = currentRun();
    if (!run || terminal(run) || state.unconfirmedStop || state.checking || state.stopping || state.request === "pending") return;
    invalidate(); update({stopping:true,notice:"none"});
    try {
      const result = await client.stop(run.id);
      if (result.kind === "confirmed") {
        if (state.run?.id === run.id) update({run:result.run,outputRevision:refreshOutput(result.run)});
        else if (state.eligibility?.eligible === false && state.eligibility.reason !== "subject-rejected" && state.eligibility.blockingRun.id === run.id) update({eligibility:{...state.eligibility,blockingRun:result.run}});
        update({notice:"stop-requested"});
      } else update({unconfirmedStop:run.id,notice:"stop-uncertain"});
    } catch {update({unconfirmedStop:run.id,notice:"stop-uncertain"});}
    finally {update({stopping:false,fresh:false}); poll();}
  }
  return {getSnapshot:() => state,subscribe(listener:() => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    prepare:checkReceipt,checkReceipt,request:() => send(false),resend:() => send(true),checkRun,stop,invalidate,
    watch() {watchers++; void checkReceipt(); return () => {watchers = Math.max(0,watchers-1); if (!watchers) invalidate();};}};
}
export type ReinterpretationController = ReturnType<typeof createReinterpretationController>;
