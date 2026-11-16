import { sameIdentity, sameTarget, stopIdentity, stopKey, stopReceipt, workTarget, type StopIdentity, type StopReceipt, type WorkCounts, type WorkItem, type WorkTarget, type WorkView } from "./types";
import type { BackgroundClient } from "./request";

export const backgroundRecoveryKey="thoughtloom.background-local-stop.v1";
export interface PendingStop {readonly target:WorkTarget;readonly identity:StopIdentity;readonly key:string}
interface StorageAccess {getItem(key:string):string|null;setItem(key:string,value:string):void}
export interface BackgroundState {
  readonly view:WorkView; readonly counts:WorkCounts|null; readonly items:readonly WorkItem[]; readonly nextCursor:string|null;
  readonly loading:boolean; readonly listError:boolean; readonly summaryError:boolean;
  readonly preparing:boolean; readonly confirmation:WorkItem|null; readonly stopping:boolean;
  readonly pending:readonly PendingStop[]; readonly receipt:StopReceipt|null;
  readonly notice:"none"|"read-error"|"changed"|"storage-error"|"unconfirmed"|"stopped";
}
interface Options {readonly storage?:()=>StorageAccess;readonly newKey?:()=>string;readonly limit?:number}
const object=(v:unknown):v is Record<string,unknown> => typeof v==="object" && v!==null && !Array.isArray(v);
function parse(raw:string|null):PendingStop[] {
  if (raw===null) return [];
  const v:unknown=JSON.parse(raw);
  if (!object(v) || Object.keys(v).length!==2 || v.version!==1 || !Array.isArray(v.entries)) throw new Error("Invalid recovery");
  const entries:PendingStop[]=[];
  for (const entry of v.entries) {
    if (!object(entry) || Object.keys(entry).length!==3 || !workTarget(entry.target) || !stopIdentity(entry.identity) ||
      !sameTarget(entry.target,entry.identity) || !stopKey(entry.key)) throw new Error("Invalid recovery");
    const target=entry.target, key=entry.key;
    if (entries.some(old => sameTarget(old.target,target) || old.key===key)) throw new Error("Invalid recovery");
    entries.push({target:entry.target,identity:entry.identity,key:entry.key});
  }
  return entries;
}
const initial=():BackgroundState => ({view:"needs-attention",counts:null,items:[],nextCursor:null,loading:false,
  listError:false,summaryError:false,preparing:false,confirmation:null,stopping:false,pending:[],receipt:null,notice:"none"});

/** Owns live reads and exact-identity recovery, without storing library content. */
export function createBackgroundController(client:BackgroundClient,options:Options={}) {
  const storage=options.storage ?? (() => sessionStorage), newKey=options.newKey ?? (() => crypto.randomUUID()), limit=options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error("Invalid page size");
  let state=initial(), revision=0, command=false, activeTarget:WorkTarget|null=null;
  const listeners=new Set<()=>void>();
  const update=(next:Partial<BackgroundState>) => {state={...state,...next}; for (const listener of listeners) listener();};
  const load=() => parse(storage().getItem(backgroundRecoveryKey));
  function save(entries:PendingStop[]) {
    const value=JSON.stringify({version:1,entries}), store=storage();
    store.setItem(backgroundRecoveryKey,value);
    if (store.getItem(backgroundRecoveryKey)!==value) throw new Error("Recovery storage failed");
  }
  function protectedTarget(target:WorkTarget):boolean {
    return (activeTarget!==null && sameTarget(activeTarget,target)) ||
      (state.confirmation!==null && sameTarget(state.confirmation.target,target)) ||
      state.pending.some(entry => sameTarget(entry.target,target));
  }
  function retainProtected(incoming:readonly WorkItem[]):readonly WorkItem[] {
    const previous=state.items, pinned=previous.filter(item => protectedTarget(item.target));
    const result=incoming.map(item => pinned.find(old => sameTarget(old.target,item.target)) ?? item);
    for (const item of pinned) {
      if (!result.some(current => sameTarget(current.target,item.target))) {
        result.splice(Math.min(previous.indexOf(item),result.length),0,item);
      }
    }
    return result;
  }
  async function refresh() {
    const epoch=++revision, view=state.view;
    update({loading:true});
    const [summary,page]=await Promise.all([client.summary(),client.list(view,limit,null)]);
    if (epoch!==revision) return;
    update({loading:false,counts:summary.kind==="found" ? summary.value : state.counts,summaryError:summary.kind==="error",
      items:page.kind==="found" ? retainProtected(page.value.items) : state.items,
      nextCursor:page.kind==="found" ? page.value.nextCursor : state.nextCursor,listError:page.kind==="error"});
  }
  async function prepare() {
    try {const pending=load(); update({pending,notice:pending.length ? "unconfirmed" : "none"});}
    catch {update({notice:"storage-error"});}
    await refresh();
  }
  async function selectView(view:WorkView) {
    if (view===state.view || command || state.confirmation!==null || state.items.some(item => protectedTarget(item.target))) return;
    update({view,items:[],nextCursor:null,listError:false}); await refresh();
  }
  async function more() {
    if (state.loading || state.listError || !state.nextCursor) return;
    const epoch=revision, view=state.view, cursor=state.nextCursor;
    update({loading:true});
    const result=await client.list(view,limit,cursor);
    if (epoch!==revision) return;
    if (result.kind==="error") {update({loading:false,listError:true}); return;}
    const items=[...state.items];
    for (const item of result.value.items) if (!items.some(old => sameTarget(old.target,item.target))) items.push(item);
    update({loading:false,listError:false,items,nextCursor:result.value.nextCursor});
  }
  async function prepareStop(item:WorkItem) {
    if (command || state.confirmation!==null || !item.actions.stopLocalTracking || (item.localStop && !item.localStop.eligible) || state.pending.some(p => sameTarget(p.target,item.target))) return;
    command=true; activeTarget=item.target; revision++; update({loading:false,preparing:true,confirmation:null,notice:"none"});
    try {
      const current=await client.detail(item.target);
      if (current.kind!=="found") update({notice:"read-error"});
      else if (!current.value.localStop?.eligible || !current.value.actions.stopLocalTracking ||
        (item.localStop && !sameIdentity(item.localStop.identity,current.value.localStop.identity))) update({notice:"changed"});
      else update({confirmation:current.value});
    } catch {update({notice:"read-error"});}
    finally {activeTarget=null; command=false; update({preparing:false});}
  }
  function cancelStop() {if (!command) update({confirmation:null});}
  async function confirmStop() {
    const item=state.confirmation;
    if (command || !item?.localStop?.eligible) return;
    command=true; activeTarget=item.target; update({stopping:true,notice:"none"});
    try {
      const current=await client.detail(item.target);
      if (current.kind!=="found") {update({notice:"read-error"}); return;}
      if (!current.value.localStop?.eligible || !current.value.actions.stopLocalTracking ||
        !sameIdentity(item.localStop.identity,current.value.localStop.identity)) {update({confirmation:null,notice:"changed"}); return;}
      let pending:PendingStop;
      try {
        const entries=load(), key=newKey();
        if (!stopKey(key) || entries.some(entry => entry.key===key || sameTarget(entry.target,item.target))) throw new Error("Invalid recovery identity");
        pending={target:item.target,identity:item.localStop.identity,key};
        save([...entries,pending]); update({pending:[...entries,pending],confirmation:null});
      } catch {update({notice:"storage-error"}); return;}
      const result=await client.stop(pending.target,pending.key,pending.identity);
      if (result.kind!=="found" || !stopReceipt(result.value,pending.target,pending.key,pending.identity)) {update({notice:"unconfirmed"}); return;}
      try {
        const entries=load().filter(entry => !(entry.key===pending.key && sameTarget(entry.target,pending.target) && sameIdentity(entry.identity,pending.identity)));
        save(entries); update({pending:entries,receipt:result.value,notice:"stopped"});
      } catch {update({receipt:result.value,notice:"storage-error"});}
    } catch {update({notice:"unconfirmed"});}
    finally {activeTarget=null; command=false; update({stopping:false});}
  }
  async function checkStop(pending:PendingStop) {
    if (command || !state.pending.some(entry => entry.key===pending.key && sameTarget(entry.target,pending.target) && sameIdentity(entry.identity,pending.identity))) return;
    command=true; update({stopping:true});
    try {
      const result=await client.receipt(pending.target,pending.key,pending.identity);
      if (result.kind!=="found" || result.value===null || !stopReceipt(result.value,pending.target,pending.key,pending.identity)) {update({notice:"unconfirmed"}); return;}
      try {
        const entries=load().filter(entry => !(entry.key===pending.key && sameTarget(entry.target,pending.target) && sameIdentity(entry.identity,pending.identity)));
        save(entries); update({pending:entries,receipt:result.value,notice:"stopped"});
      } catch {update({receipt:result.value,notice:"storage-error"});}
    } catch {update({notice:"unconfirmed"});}
    finally {command=false; update({stopping:false});}
  }
  return {getSnapshot:()=>state,subscribe(listener:()=>void) {listeners.add(listener); return () => listeners.delete(listener);},
    prepare,refresh,selectView,more,prepareStop,cancelStop,confirmStop,checkStop};
}
export type BackgroundController=ReturnType<typeof createBackgroundController>;
