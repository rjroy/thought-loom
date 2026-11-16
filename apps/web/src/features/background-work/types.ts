export type WorkKind = "weave" | "evolve" | "search" | "export" | "import";
export type WorkView = "needs-attention" | "in-progress" | "locally-closed";
export type WorkTarget = {readonly type:"run" | "import-file"; readonly id:string};
export type StopIdentity =
  | {readonly type:"run"; readonly id:string; readonly kind:WorkKind; readonly generation:string | null}
  | {readonly type:"import-file"; readonly id:string; readonly importId:string; readonly runId:string | null;
     readonly generation:string | null; readonly waitingOnFileId:string | null; readonly outcome:string | null};
export interface StopReceipt {
  readonly target:WorkTarget; readonly requestKey:string; readonly identity:StopIdentity; readonly stoppedAt:string;
  readonly state:"local-tracking-stopped"; readonly remoteState:"unknown";
}
export interface WorkItem {
  readonly target:WorkTarget; readonly kind:WorkKind;
  readonly status:"queued"|"submitting"|"running"|"uncertain"|"completed"|"interrupted"|"failed"|"waiting"|"imported"|"skipped-identical"|"skipped-changed"|"pending"|"settled"|"ownership-conflict";
  readonly createdAt:string | null;
  readonly owner:{readonly type:"thought"|"search-session"|"import"|"export"|"unknown";readonly id:string|null;readonly title:string|null};
  readonly reason:"uncertain"|"cancellation-pending"|"failed"|"interrupted"|"ownership-conflict"|"waiting"|"unverified"|null;
  readonly actions:{readonly checkStatus:boolean;readonly stopLocalTracking:boolean};
  readonly localStop?:{readonly identity:StopIdentity;readonly eligible:boolean;readonly reason:"already-stopped"|"already-inert"|"nothing-outstanding"|"owner-unavailable"|null};
}
export type WorkCounts = Readonly<Record<WorkView,number>>;
export interface WorkPage {readonly items:readonly WorkItem[];readonly nextCursor:string|null}

const object = (v:unknown):v is Record<string,unknown> => typeof v==="object" && v!==null && !Array.isArray(v);
const exact = (v:Record<string,unknown>, keys:readonly string[]) => Object.keys(v).length===keys.length && keys.every(k => Object.hasOwn(v,k));
const member = <T extends string>(v:unknown, values:readonly T[]):v is T => typeof v==="string" && values.some(x => x===v);
const kinds = ["weave","evolve","search","export","import"] as const;
const statuses = ["queued","submitting","running","uncertain","completed","interrupted","failed","waiting","imported","skipped-identical","skipped-changed","pending","settled","ownership-conflict"] as const;
const reasons = ["uncertain","cancellation-pending","failed","interrupted","ownership-conflict","waiting","unverified"] as const;
const stopReasons = ["already-stopped","already-inert","nothing-outstanding","owner-unavailable"] as const;
export const workId = (v:unknown):v is string => typeof v==="string" && /^[A-Za-z0-9_~.:-]{1,512}$/.test(v) && v!=="." && v!=="..";
export const stopKey = (v:unknown):v is string => typeof v==="string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
const nullableId = (v:unknown):v is string|null => v===null || workId(v);
const nullableText = (v:unknown):v is string|null => v===null || typeof v==="string";
const generation = (v:unknown):v is string|null => v===null || (typeof v==="string" && /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v)<=9223372036854775807n);
export function workTarget(v:unknown):v is WorkTarget {
  return object(v) && exact(v,["type","id"]) && member(v.type,["run","import-file"]) && workId(v.id);
}
export function stopIdentity(v:unknown):v is StopIdentity {
  if (!object(v) || !workId(v.id) || !generation(v.generation)) return false;
  if (v.type==="run") return exact(v,["type","id","kind","generation"]) && member(v.kind,kinds) &&
    (v.generation!==null || v.kind==="search") &&
    (v.kind!=="search" || v.generation===null || BigInt(v.generation)<=BigInt(Number.MAX_SAFE_INTEGER));
  return v.type==="import-file" && exact(v,["type","id","importId","runId","generation","waitingOnFileId","outcome"]) &&
    workId(v.importId) && nullableId(v.runId) && nullableId(v.waitingOnFileId) &&
    (v.outcome===null || member(v.outcome,["imported","skipped-identical","skipped-changed","failed","interrupted"])) &&
    (v.runId===null)===(v.generation===null) && (v.runId===null || v.waitingOnFileId===null);
}
export const sameTarget = (a:WorkTarget,b:WorkTarget) => a.type===b.type && a.id===b.id;
export function sameIdentity(a:StopIdentity,b:StopIdentity):boolean {
  if (a.type!==b.type || a.id!==b.id || a.generation!==b.generation) return false;
  if (a.type==="run" && b.type==="run") return a.kind===b.kind;
  return a.type==="import-file" && b.type==="import-file" && a.importId===b.importId && a.runId===b.runId &&
    a.waitingOnFileId===b.waitingOnFileId && a.outcome===b.outcome;
}
export function workItem(v:unknown):v is WorkItem {
  if (!object(v) || !(exact(v,["target","kind","status","createdAt","owner","reason","actions"]) ||
      exact(v,["target","kind","status","createdAt","owner","reason","actions","localStop"])) ||
      !workTarget(v.target) || !member(v.kind,kinds) || !member(v.status,statuses) || !nullableText(v.createdAt) ||
      !object(v.owner) || !exact(v.owner,["type","id","title"]) || !member(v.owner.type,["thought","search-session","import","export","unknown"]) ||
      !nullableId(v.owner.id) || !nullableText(v.owner.title) || !(v.reason===null || member(v.reason,reasons)) ||
      !object(v.actions) || !exact(v.actions,["checkStatus","stopLocalTracking"]) ||
      typeof v.actions.checkStatus!=="boolean" || typeof v.actions.stopLocalTracking!=="boolean") return false;
  if (!Object.hasOwn(v,"localStop")) return true;
  return object(v.localStop) && exact(v.localStop,["identity","eligible","reason"]) && stopIdentity(v.localStop.identity) &&
    sameTarget(v.target,v.localStop.identity) && typeof v.localStop.eligible==="boolean" &&
    (v.localStop.reason===null || member(v.localStop.reason,stopReasons));
}
export function workCounts(v:unknown):v is WorkCounts {
  return object(v) && exact(v,["needs-attention","in-progress","locally-closed"]) &&
    ["needs-attention","in-progress","locally-closed"].every(k => typeof v[k]==="number" && Number.isSafeInteger(v[k]) && v[k]>=0);
}
export function workPage(v:unknown):v is WorkPage {
  return object(v) && exact(v,["items","nextCursor"]) && Array.isArray(v.items) && v.items.every(workItem) &&
    (v.nextCursor===null || (typeof v.nextCursor==="string" && v.nextCursor.length>0 && v.nextCursor.length<=2048));
}
export function stopReceipt(v:unknown,target:WorkTarget,key:string,expected?:StopIdentity):v is StopReceipt {
  return object(v) && exact(v,["target","requestKey","identity","stoppedAt","state","remoteState"]) &&
    workTarget(v.target) && sameTarget(v.target,target) && v.requestKey===key && stopIdentity(v.identity) &&
    sameTarget(v.identity,target) && (!expected || sameIdentity(v.identity,expected)) &&
    typeof v.stoppedAt==="string" && Number.isFinite(Date.parse(v.stoppedAt)) &&
    v.state==="local-tracking-stopped" && v.remoteState==="unknown";
}
