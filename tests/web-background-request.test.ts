import { expect, test } from "bun:test";
import { createBackgroundClient } from "../apps/web/src/features/background-work/request";
import { stopIdentity, workItem, workPage } from "../apps/web/src/features/background-work/types";
import { readWebConfig } from "../apps/web/src/server/config";
import { requestDaemon } from "../apps/web/src/server/daemon";
import { isTrustedRequest } from "../apps/web/src/server/request-guard";
import { createLogger, type LogRecord } from "../src/logging";

const identity = {type:"run",id:"run:owned",kind:"weave",generation:"9007199254740993"} as const;
const target = {type:"run",id:"run:owned"} as const;
const item = {target,kind:"weave",status:"interrupted",createdAt:null,owner:{type:"unknown",id:null,title:null},
  reason:"unverified",actions:{checkStatus:true,stopLocalTracking:true}} as const;
const receipt = {target,requestKey:"key:owned",identity,stoppedAt:"2032-01-01T00:00:00Z",state:"local-tracking-stopped",remoteState:"unknown"} as const;

test("background client sends encoded identities and exact string generations only through same-origin routes", async () => {
  const calls:{url:string;init:RequestInit}[]=[];
  const fetcher:typeof fetch = Object.assign(async (input:RequestInfo | URL,init?:RequestInit) => {
    calls.push({url:String(input),init:init ?? {}});
    return Response.json({receipt},{status:init?.method==="POST" ? 201 : 200});
  },{preconnect:() => {}});
  const client=createBackgroundClient(fetcher);
  expect(await client.stop(target,"key:owned",identity)).toEqual({kind:"found",value:receipt});
  expect(await client.receipt(target,"key:owned",identity)).toEqual({kind:"found",value:receipt});
  expect(calls.map(call => call.url)).toEqual(["/api/background-work/runs/run%3Aowned/local-stop","/api/background-work/runs/run%3Aowned/local-stop/by-key/key%3Aowned"]);
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({acknowledgeRemoteUncertainty:true,expected:identity});
  expect(new Headers(calls[0]?.init.headers).get("idempotency-key")).toBe("key:owned");
  expect(calls.every(call => call.init.cache==="no-store" && call.init.redirect==="error")).toBe(true);
  expect(calls.every(call => !new Headers(call.init.headers).has("authorization"))).toBe(true);
});

test("background DTO parsing refuses injected private fields, invalid identities and untrusted receipts", async () => {
  expect(workItem(item)).toBe(true);
  expect(workPage({items:[item],nextCursor:null})).toBe(true);
  expect(workItem({...item,rawError:"PRIVATE FAILURE"})).toBe(false);
  expect(workItem({...item,owner:{...item.owner,credential:"PRIVATE TOKEN"}})).toBe(false);
  expect(stopIdentity({...identity,generation:9007199254740993})).toBe(false);
  expect(stopIdentity({...identity,generation:"9223372036854775808"})).toBe(false);
  for (const malformed of [{...receipt,requestKey:"wrong"},{...receipt,identity:{...identity,generation:"9007199254740994"}},
    {...receipt,remoteState:"settled"},{...receipt,rawError:"PRIVATE FAILURE"}]) {
    const fetcher:typeof fetch=Object.assign(async () => Response.json({receipt:malformed}),{preconnect:() => {}});
    const client=createBackgroundClient(fetcher);
    expect(await client.receipt(target,"key:owned",identity)).toEqual({kind:"error"});
  }
});

test("background bridge primitives enforce host/origin, server credentials and sanitized boundary logging", async () => {
  const origin="http://127.0.0.1:4310", token="owned-background-token";
  const config=readWebConfig({THOUGHTLOOM_WEB_ORIGIN:origin,THOUGHTLOOM_DAEMON_URL:"http://127.0.0.1:4311",THOUGHTLOOM_USER_TOKEN:token});
  const req=(method:string,headers:Record<string,string>) => new Request(`${origin}/api/background-work/runs/run%3Aowned/local-stop`,{method,headers});
  expect(isTrustedRequest(config,req("GET",{host:"127.0.0.1:4310"}))).toBe(true);
  expect(isTrustedRequest(config,req("GET",{host:"foreign.invalid","x-forwarded-host":"127.0.0.1:4310"}))).toBe(false);
  expect(isTrustedRequest(config,req("POST",{host:"127.0.0.1:4310",origin}))).toBe(true);
  expect(isTrustedRequest(config,req("POST",{host:"127.0.0.1:4310",origin:"https://foreign.invalid"}))).toBe(false);
  const calls:{url:string;init:RequestInit}[]=[], logs:LogRecord[]=[];
  const fetcher:typeof fetch=Object.assign(async (url:RequestInfo | URL,init?:RequestInit) => {calls.push({url:String(url),init:init ?? {}});return Response.json({receipt});},{preconnect:() => {}});
  await requestDaemon(config,{method:"POST",path:"/background-work/runs/run%3Aowned/local-stop",idempotencyKey:"key:owned",
    body:JSON.stringify({acknowledgeRemoteUncertainty:true,expected:identity})},{fetch:fetcher,logger:createLogger("verbose",record => logs.push(record)),timeoutMs:1000});
  expect(calls[0]?.url).toBe("http://127.0.0.1:4311/background-work/runs/run%3Aowned/local-stop");
  const headers=new Headers(calls[0]?.init.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(headers.get("idempotency-key")).toBe("key:owned");
  expect(headers.has("cookie")).toBe(false);
  expect(calls[0]?.init.cache).toBe("no-store");
  expect(JSON.stringify(logs)).not.toContain(token);
  expect(JSON.stringify(logs)).not.toContain(identity.generation);
});
