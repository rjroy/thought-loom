import { expect, test } from "bun:test";
import { backgroundRecoveryKey, createBackgroundController } from "../apps/web/src/features/background-work/controller";
import type { BackgroundClient } from "../apps/web/src/features/background-work/request";
import type { StopIdentity, StopReceipt, WorkItem } from "../apps/web/src/features/background-work/types";

const runIdentity:StopIdentity = {type:"run",id:"run:owned",kind:"weave",generation:"9007199254740993"};
const fileIdentity:StopIdentity = {type:"import-file",id:"file:owned",importId:"batch:owned",runId:null,generation:null,waitingOnFileId:"holder:owned",outcome:null};
const runItem = (identity:StopIdentity = runIdentity):WorkItem => ({
  target:{type:identity.type,id:identity.id},kind:identity.type==="run" ? identity.kind : "import",
  status:"interrupted",createdAt:null,owner:{type:"unknown",id:null,title:null},reason:"unverified",
  actions:{checkStatus:true,stopLocalTracking:true},localStop:{identity,eligible:true,reason:null},
});
const counts = {"needs-attention":1,"in-progress":0,"locally-closed":0};
const found = <T>(value:T) => ({kind:"found" as const,value});
const error = {kind:"error" as const};
function setup() {
  let raw:string|null=null, details:WorkItem=runItem(), keyCalls=0;
  let failStore=false;
  const storage = {getItem:(_key:string) => raw,setItem:(_key:string,value:string) => {if (failStore) throw new Error("owned storage failure"); raw=value;}};
  const calls:{operation:string;args:unknown[]}[]=[];
  let stop:BackgroundClient["stop"] = async () => error;
  let receipt:BackgroundClient["receipt"] = async () => found(null);
  let list:BackgroundClient["list"] = async () => found({items:[runItem()],nextCursor:"next-owned"});
  let summary:BackgroundClient["summary"] = async () => found(counts);
  const client:BackgroundClient = {
    summary:() => summary(),
    list:(...args) => {calls.push({operation:"list",args});return list(...args);},
    detail:async target => {calls.push({operation:"detail",args:[target]});return found(details);},
    stop:(...args) => {calls.push({operation:"stop",args});return stop(...args);},
    receipt:(...args) => {calls.push({operation:"receipt",args});return receipt(...args);},
  };
  const make = () => createBackgroundController(client,{storage:() => storage,newKey:() => {keyCalls++;return "key:owned";},limit:2});
  return {make,calls,storage,get raw() {return raw;},get keyCalls() {return keyCalls;},
    details:(v:WorkItem) => {details=v;}, failStore:() => {failStore=true;},
    setStop:(v:BackgroundClient["stop"]) => {stop=v;},setReceipt:(v:BackgroundClient["receipt"]) => {receipt=v;},
    setList:(v:BackgroundClient["list"]) => {list=v;},setSummary:(v:BackgroundClient["summary"]) => {summary=v;}};
}
function listOnly(item:WorkItem):WorkItem {
  const {localStop: _localStop,...result}=item;
  return result;
}
function stopped(identity:StopIdentity = runIdentity):StopReceipt {
  return {target:{type:identity.type,id:identity.id},requestKey:"key:owned",identity,stoppedAt:"2032-01-01T00:00:00Z",
    state:"local-tracking-stopped",remoteState:"unknown"};
}

test("list row without snapshot opens confirmation only after fresh exact detail", async () => {
  const f=setup(), controller=f.make();
  await controller.prepareStop(listOnly(runItem()));
  expect(f.calls).toEqual([{operation:"detail",args:[{type:"run",id:"run:owned"}]}]);
  expect(controller.getSnapshot().confirmation).toEqual(runItem());
  expect(f.raw).toBeNull();
});

for (const scenario of ["kind","generation","reservation","eligibility"] as const) test(`confirmation refuses changed ${scenario} without persisting or dispatching`, async () => {
  const f=setup(), controller=f.make();
  const original=scenario==="reservation" ? fileIdentity : runIdentity;
  f.details(runItem(original));
  await controller.prepareStop(listOnly(runItem(original)));
  expect(controller.getSnapshot().confirmation).not.toBeNull();
  if (scenario==="kind") f.details(runItem({type:"run",id:"run:owned",kind:"evolve",generation:"9007199254740993"}));
  if (scenario==="generation") f.details(runItem({type:"run",id:"run:owned",kind:"weave",generation:"9007199254740994"}));
  if (scenario==="reservation") f.details(runItem({...fileIdentity,waitingOnFileId:"different-holder"}));
  if (scenario==="eligibility") f.details({...runItem(),localStop:{identity:runIdentity,eligible:false,reason:"already-inert"}});
  await controller.confirmStop();
  expect(controller.getSnapshot()).toMatchObject({confirmation:null,notice:"changed",pending:[]});
  expect(f.calls.filter(call => call.operation==="stop")).toEqual([]);
  expect(f.keyCalls).toBe(0); expect(f.raw).toBeNull();
});

test("persistence precedes a single exact write; a lost acknowledgement reloads with receipt-only recovery", async () => {
  const f=setup(), held=Promise.withResolvers<ReturnType<typeof found<StopReceipt>> | typeof error>();
  f.setStop(async (target,key,identity) => {
    expect(JSON.parse(f.storage.getItem(backgroundRecoveryKey) ?? "null")).toEqual({version:1,entries:[{target,identity,key}]});
    return held.promise;
  });
  const controller=f.make();
  await controller.prepareStop(listOnly(runItem()));
  const first=controller.confirmStop(), duplicate=controller.confirmStop();
  for (let i=0;i<30 && !f.calls.some(call => call.operation==="stop");i++) await Promise.resolve();
  expect(f.calls.filter(call => call.operation==="stop")).toEqual([{operation:"stop",args:[{type:"run",id:"run:owned"},"key:owned",runIdentity]}]);
  held.resolve(error); await Promise.all([first,duplicate]);
  expect(controller.getSnapshot().notice).toBe("unconfirmed");
  const restored=f.make(); await restored.prepare();
  expect(restored.getSnapshot().pending).toEqual([{target:{type:"run",id:"run:owned"},identity:runIdentity,key:"key:owned"}]);
  const pending=restored.getSnapshot().pending[0]; if (!pending) throw new Error("Expected persisted recovery");
  await restored.checkStop(pending);
  expect(restored.getSnapshot()).toMatchObject({notice:"unconfirmed",pending:[pending],receipt:null});
  expect(f.keyCalls).toBe(1); expect(f.calls.filter(call => call.operation==="stop")).toHaveLength(1);
  f.setReceipt(async () => found(stopped()));
  await restored.checkStop(pending);
  expect(restored.getSnapshot()).toMatchObject({notice:"stopped",pending:[],receipt:stopped()});
  expect(f.calls.filter(call => call.operation==="receipt")).toHaveLength(2);
  expect(f.calls.filter(call => call.operation==="stop")).toHaveLength(1);
});

test("storage failure and invalid or mismatched receipts cannot claim a local stop", async () => {
  const blocked=setup(), first=blocked.make();
  await first.prepareStop(listOnly(runItem())); blocked.failStore(); await first.confirmStop();
  expect(first.getSnapshot().notice).toBe("storage-error");
  expect(blocked.calls.filter(call => call.operation==="stop")).toHaveLength(0);
  for (const value of [{...stopped(),requestKey:"other"}, {...stopped(),remoteState:"settled"}, {...stopped(),identity:{...runIdentity,generation:"9007199254740994"}}]) {
    const f=setup(), controller=f.make();
    // Exercise controller validation even if an injected client misclassifies an upstream DTO.
    f.setStop(async () => found(value as StopReceipt));
    await controller.prepareStop(listOnly(runItem())); await controller.confirmStop();
    expect(controller.getSnapshot()).toMatchObject({notice:"unconfirmed",receipt:null});
    expect(controller.getSnapshot().pending).toHaveLength(1);
  }
});

test("failed refresh retains confirmed same-view rows and counts with stale errors", async () => {
  const f=setup(), controller=f.make();
  await controller.prepare();
  expect(controller.getSnapshot()).toMatchObject({items:[runItem()],counts,nextCursor:"next-owned"});
  f.setList(async () => error); f.setSummary(async () => error);
  await controller.refresh();
  expect(controller.getSnapshot()).toMatchObject({items:[runItem()],counts,listError:true,summaryError:true});
});

test("stale pagination cannot overwrite a newer view", async () => {
  const f=setup(), controller=f.make();
  await controller.prepare();
  const hold=Promise.withResolvers<ReturnType<typeof found<{items:WorkItem[];nextCursor:string|null}>>>();
  f.setSummary(async () => found(counts));
  f.setList(async (view,_limit,cursor) => cursor ? hold.promise : found({items:view==="in-progress" ? [runItem(fileIdentity)] : [runItem()],nextCursor:"next-owned"}));
  await controller.refresh();
  const more=controller.more();
  await controller.selectView("in-progress");
  hold.resolve(found({items:[runItem()],nextCursor:null}));
  await more;
  expect(controller.getSnapshot()).toMatchObject({view:"in-progress",items:[runItem(fileIdentity)]});
});

test("first read failure is unavailable rather than a confirmed empty list or zero count", async () => {
  const f=setup(), controller=f.make();
  f.setList(async () => error); f.setSummary(async () => error);
  await controller.prepare();
  expect(controller.getSnapshot()).toMatchObject({items:[],counts:null,listError:true,summaryError:true,loading:false});
});

test("background refresh cannot replace the focused confirmation row or its exact identity", async () => {
  const f=setup(), controller=f.make();
  await controller.prepare();
  await controller.prepareStop(listOnly(runItem()));
  expect(controller.getSnapshot().confirmation).toEqual(runItem());
  const changed = runItem({type:"run",id:"run:owned",kind:"weave",generation:"9007199254740994"});
  f.setList(async () => found({items:[changed],nextCursor:null}));
  await controller.refresh();
  expect(controller.getSnapshot().confirmation).toEqual(runItem());
  expect(controller.getSnapshot().items).toEqual([runItem()]);
  expect(f.calls.filter(call => call.operation==="stop")).toEqual([]);
});

test("pagination and view selection cannot discard a focused confirmation", async () => {
  const f=setup(), controller=f.make();
  await controller.prepare(); await controller.prepareStop(listOnly(runItem()));
  const changed=runItem({type:"run",id:"run:owned",kind:"weave",generation:"9007199254740994"});
  f.setList(async (_view,_limit,cursor) => found({items:cursor ? [changed] : [],nextCursor:null}));
  await controller.more();
  expect(controller.getSnapshot()).toMatchObject({view:"needs-attention",confirmation:runItem(),items:[runItem()]});
  await controller.selectView("in-progress");
  expect(controller.getSnapshot()).toMatchObject({view:"needs-attention",confirmation:runItem(),items:[runItem()]});
});

test("background refresh cannot remove a row whose exact local-stop write is pending", async () => {
  const f=setup(), controller=f.make(), held=Promise.withResolvers<ReturnType<typeof found<StopReceipt>> | typeof error>();
  f.setStop(async () => held.promise);
  await controller.prepare(); await controller.prepareStop(listOnly(runItem()));
  const write=controller.confirmStop();
  try {
    for (let i=0;i<30 && !f.calls.some(call => call.operation==="stop");i++) await Promise.resolve();
    expect(f.calls.filter(call => call.operation==="stop")).toHaveLength(1);
    expect(controller.getSnapshot().pending).toEqual([{target:{type:"run",id:"run:owned"},identity:runIdentity,key:"key:owned"}]);
    f.setList(async () => found({items:[],nextCursor:null}));
    await controller.refresh();
    expect(controller.getSnapshot().items).toEqual([runItem()]);
    expect(controller.getSnapshot().pending).toEqual([{target:{type:"run",id:"run:owned"},identity:runIdentity,key:"key:owned"}]);
    expect(f.calls.filter(call => call.operation==="stop")).toHaveLength(1);
  } finally { held.resolve(error); await write; }
});
