import { sameTarget, stopIdentity, stopKey, stopReceipt, workCounts, workId, workItem, workPage,
  type StopIdentity, type StopReceipt, type WorkCounts, type WorkItem, type WorkPage, type WorkTarget, type WorkView } from "./types";

type Result<T> = {readonly kind:"found";readonly value:T} | {readonly kind:"error"};
export interface BackgroundClient {
  summary():Promise<Result<WorkCounts>>;
  list(view:WorkView,limit:number,cursor:string|null):Promise<Result<WorkPage>>;
  detail(target:WorkTarget):Promise<Result<WorkItem>>;
  stop(target:WorkTarget,key:string,identity:StopIdentity):Promise<Result<StopReceipt>>;
  receipt(target:WorkTarget,key:string,identity:StopIdentity):Promise<Result<StopReceipt|null>>;
}
const object=(v:unknown):v is Record<string,unknown> => typeof v==="object" && v!==null && !Array.isArray(v);
const exact=(v:Record<string,unknown>,k:string) => Object.keys(v).length===1 && Object.hasOwn(v,k);
function discard(response:Response) { try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort. */ } }
const path=(target:WorkTarget) => `/api/background-work/${target.type==="run" ? "runs" : "import-files"}/${encodeURIComponent(target.id)}`;

/** Browser requests stay on fixed same-origin routes and never replay uncertain writes. */
export function createBackgroundClient(fetcher:typeof fetch = fetch):BackgroundClient {
  async function read(url:string,init:RequestInit = {}):Promise<unknown> {
    try {
      const response=await fetcher(url,{...init,cache:"no-store",redirect:"error"});
      if (response.status!==200 && !(init.method==="POST" && response.status===201)) {discard(response); return undefined;}
      return await response.json();
    } catch { return undefined; }
  }
  return {
    async summary() { const v=await read("/api/background-work/summary"); return object(v) && exact(v,"counts") && workCounts(v.counts) ? {kind:"found",value:v.counts} : {kind:"error"}; },
    async list(view,limit,cursor) {
      if (!["needs-attention","in-progress","locally-closed"].includes(view) || !Number.isSafeInteger(limit) || limit<1 || limit>100 || (cursor!==null && (!cursor || cursor.length>2048))) return {kind:"error"};
      const query=new URLSearchParams({view,limit:String(limit)}); if (cursor!==null) query.set("cursor",cursor);
      const v=await read(`/api/background-work?${query}`); return workPage(v) ? {kind:"found",value:v} : {kind:"error"};
    },
    async detail(target) {
      if (!workId(target.id)) return {kind:"error"};
      const v=await read(path(target));
      return object(v) && exact(v,"item") && workItem(v.item) && sameTarget(v.item.target,target) ? {kind:"found",value:v.item} : {kind:"error"};
    },
    async stop(target,key,identity) {
      if (!workId(target.id) || !stopKey(key) || !stopIdentity(identity) || !sameTarget(target,identity)) return {kind:"error"};
      const v=await read(`${path(target)}/local-stop`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key},body:JSON.stringify({acknowledgeRemoteUncertainty:true,expected:identity})});
      return object(v) && exact(v,"receipt") && stopReceipt(v.receipt,target,key,identity) ? {kind:"found",value:v.receipt} : {kind:"error"};
    },
    async receipt(target,key,identity) {
      if (!workId(target.id) || !stopKey(key) || !stopIdentity(identity) || !sameTarget(target,identity)) return {kind:"error"};
      const v=await read(`${path(target)}/local-stop/by-key/${encodeURIComponent(key)}`);
      return object(v) && exact(v,"receipt") && (v.receipt===null || stopReceipt(v.receipt,target,key,identity)) ? {kind:"found",value:v.receipt} : {kind:"error"};
    },
  };
}
