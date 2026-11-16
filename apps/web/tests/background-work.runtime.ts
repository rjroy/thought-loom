import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { expect, type Page } from "@playwright/test";

// Test-owned transport and DTOs; this file does not import the unimplemented client.
type Request = Pick<IncomingMessage,"method" | "url" | "headers"> & AsyncIterable<Uint8Array>;
interface Response { writeHead(status:number,headers:Record<string,string>):{end(body?:string):void} }
type Attempt = {method:string | undefined;path:string;authorization:string | undefined;cookie:string | undefined;
  key:string | undefined;body:string};
const target = {type:"run",id:"owned:run-1"} as const;
const key = "owned:key-1";
const identity = (generation = "9007199254740993") => ({type:"run",id:target.id,kind:"weave",generation} as const);
const item = (generation = "9007199254740993") => ({
  target,kind:"weave",status:"interrupted",createdAt:null,owner:{type:"thought",id:null,title:null},
  reason:"unverified",actions:{checkStatus:true,stopLocalTracking:true},
  localStop:{identity:identity(generation),eligible:true,reason:null},
});
const receipt = (requestKey:string,expected = identity()) => ({
  target,requestKey,identity:expected,stoppedAt:"2032-01-02T03:04:05.000Z",
  state:"local-tracking-stopped",remoteState:"unknown",
});
const api = "/api/background-work";
const daemonPath = "/background-work";
type Probe = (method:string,path:string,headers:string,body?:string) => Promise<{status:number;headers:string;body:string}>;

export function backgroundWorkDaemon(token:string) {
  const attempts:Attempt[] = [];
  let generation = identity().generation, mode:"normal"|"read-failure"|"hold-lost-ack" = "normal";
  let release:(() => void) | undefined, saved:ReturnType<typeof receipt> | null = null;
  let nullReceipt=false;
  const respond = (response:Response,status:number,data:unknown) =>
    response.writeHead(status,{"content-type":"application/json","cache-control":"private, no-store"}).end(JSON.stringify(data));
  return {
    attempts,
    reset() { assert.equal(release,undefined); attempts.length=0; generation=identity().generation; mode="normal"; saved=null; nullReceipt=false; },
    setGeneration(value:string) { generation=value; },
    setMode(value:typeof mode) { mode=value; },
    setNullReceipt(value:boolean) { nullReceipt=value; },
    release() { release?.(); release=undefined; },
    async handler(request:Request,response:Response) {
      const chunks:Buffer[]=[]; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url=new URL(request.url ?? "/", "http://owned.invalid"), path=url.pathname;
      const call:Attempt={method:request.method,path:request.url ?? "",authorization:request.headers.authorization,
        cookie:request.headers.cookie,key:request.headers["idempotency-key"] as string | undefined,body:Buffer.concat(chunks).toString("utf8")};
      attempts.push(call);
      if (call.authorization !== `Bearer ${token}`) return respond(response,401,{error:"Unauthorized"});
      if (mode==="read-failure" && request.method==="GET") return respond(response,500,{error:`private-diagnostic ${token}`});
      if (path===`${daemonPath}/summary`) return respond(response,200,{counts:{"needs-attention":1,"in-progress":0,"locally-closed":saved ? 1 : 0}});
      if (path===daemonPath) {
        const view=url.searchParams.get("view") ?? "needs-attention";
        if (view==="needs-attention" && !saved) {
          if (url.searchParams.get("cursor")==="owned-cursor") return respond(response,200,{items:[],nextCursor:null});
          return respond(response,200,{items:[item(generation)],nextCursor:"owned-cursor"});
        }
        return respond(response,200,{items:[],nextCursor:null});
      }
      const base=`${daemonPath}/runs/${encodeURIComponent(target.id)}`;
      if (path===base && request.method==="GET") return respond(response,200,{item:item(generation)});
      if (path===`${base}/local-stop` && request.method==="POST") {
        if (!call.key) return respond(response,400,{error:"missing key"});
        const payload:unknown=JSON.parse(call.body);
        if (!payload || typeof payload!=="object" || !("expected" in payload)) return respond(response,400,{error:"missing identity"});
        saved=receipt(call.key,(payload as {expected:ReturnType<typeof identity>}).expected);
        if (mode==="hold-lost-ack") {
          await new Promise<void>(resolve => { release=resolve; });
          return respond(response,503,{error:`private-diagnostic ${token}`});
        }
        return respond(response,201,{receipt:saved});
      }
      if (path.startsWith(`${base}/local-stop/by-key/`) && request.method==="GET") {
        const requested=decodeURIComponent(path.slice(`${base}/local-stop/by-key/`.length));
        return respond(response,200,{receipt:!nullReceipt && saved?.requestKey===requested ? saved : null});
      }
      return respond(response,404,{error:"not found"});
    },
  };
}

type Fixture = ReturnType<typeof backgroundWorkDaemon>;
export async function checkBackgroundRoutes({origin,host,probe,daemon,token}:
  {origin:string;host:string;probe:Probe;daemon:Fixture;token:string}):Promise<void> {
  daemon.reset();
  const base=`${api}/runs/${encodeURIComponent(target.id)}`, remote=`${daemonPath}/runs/${encodeURIComponent(target.id)}`;
  for (const [path,expected] of [[`${api}/summary`,`${daemonPath}/summary`],[`${api}?view=needs-attention&limit=2`,`${daemonPath}?view=needs-attention&limit=2`],
    [base,remote],[`${base}/local-stop/by-key/${encodeURIComponent(key)}`,`${remote}/local-stop/by-key/${encodeURIComponent(key)}`]] as const) {
    const response=await fetch(`${origin}${path}`,{headers:{authorization:"Bearer browser-sentinel",cookie:"browser-cookie"}});
    assert.equal(response.status,200,`Missing or failing fixed bridge: ${path}`);
    assert.match(response.headers.get("cache-control") ?? "",/no-store/i);
    const last=daemon.attempts.at(-1); assert.ok(last);
    assert.equal(last.path,expected); assert.equal(last.authorization,`Bearer ${token}`); assert.equal(last.cookie,undefined);
  }
  const input={acknowledgeRemoteUncertainty:true,expected:identity()};
  const write=await fetch(`${origin}${base}/local-stop`,{method:"POST",headers:{origin,"content-type":"application/json","idempotency-key":key,
    authorization:"Bearer browser-sentinel",cookie:"browser-cookie"},body:JSON.stringify(input)});
  assert.equal(write.status,201);
  assert.deepEqual(await write.json(),{receipt:receipt(key)});
  const sent=daemon.attempts.at(-1); assert.ok(sent);
  assert.equal(sent.path,`${remote}/local-stop`); assert.equal(sent.key,key); assert.deepEqual(JSON.parse(sent.body),input);
  assert.equal(sent.authorization,`Bearer ${token}`); assert.equal(sent.cookie,undefined);
  const before=daemon.attempts.length, body=JSON.stringify(input);
  const content=`Content-Type: application/json\r\nIdempotency-Key: ${key}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
  assert.equal((await probe("GET",`${api}/summary`,`Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status,403);
  assert.equal((await probe("POST",`${base}/local-stop`,`Host: ${host}\r\nOrigin: https://foreign.invalid\r\n${content}`,body)).status,403);
  assert.equal(daemon.attempts.length,before,"untrusted requests must not reach daemon");
}

export async function checkBackgroundBrowser(page:Page,daemon:Fixture,{origin,daemonOrigin,token}:
  {origin:string;daemonOrigin:string;token:string}):Promise<void> {
  daemon.reset();
  const leaks:string[]=[];
  const onRequest=(request:import("@playwright/test").Request) => {
    if (request.url().startsWith(daemonOrigin) || request.url().includes(token) || request.headers().authorization) leaks.push(request.url());
  };
  page.on("request",onRequest);
  try {
    await page.goto(`${origin}/settings`,{waitUntil:"networkidle"});
    const navigation=page.getByRole("navigation",{name:"Main navigation"});
    await expect(navigation.getByRole("link")).toHaveCount(4);
    const entry=page.getByRole("link",{name:/review background work/i});
    await expect(entry).toHaveAttribute("href","/settings/background-work");
    await entry.click();
    await page.waitForURL("**/settings/background-work");
    await expect(navigation.getByRole("link")).toHaveCount(4);
    await expect(page.getByRole("link",{name:"Back to Settings"})).toHaveAttribute("href",/^\/settings(?:#.*)?$/);
    await expect(page.getByRole("heading",{name:/background work/i})).toBeVisible();
    await expect(page.getByText(/unavailable|untitled/i).first()).toBeVisible();
    await expect(page.getByText(/waiting since/i)).toHaveCount(0);
    const load=page.getByRole("button",{name:/load more/i});
    await expect(load).toBeVisible(); await load.click();
    await expect(load).toHaveCount(0);
    await page.getByRole("button",{name:/in progress/i}).click();
    await expect(page.getByText(/nothing|no .*work/i).first()).toBeVisible();
    await page.getByRole("button",{name:/needs attention/i}).click();
    daemon.setMode("read-failure");
    await page.reload({waitUntil:"networkidle"});
    await expect(page.getByText(/could not|unavailable|try loading/i).first()).toBeVisible();
    await expect(page.getByText(/nothing needs your attention/i)).toHaveCount(0);
    daemon.setMode("normal");
    assert.ok(!(await page.content()).includes(token));
    assert.deepEqual(leaks,[]);
  } finally { page.off("request",onRequest); daemon.release(); }
}

export async function checkBackgroundLostAck(page:Page,daemon:Fixture,origin:string):Promise<void> {
  daemon.reset(); daemon.setMode("hold-lost-ack");
  let beforeDispatch:{stored:string;key:string | undefined} | undefined;
  const routePattern="**/api/background-work/**/local-stop";
  await page.route(routePattern,async route => {
    if (route.request().method()==="POST") beforeDispatch={stored:await page.evaluate(() => JSON.stringify({...localStorage,...sessionStorage})),
      key:route.request().headers()["idempotency-key"]};
    await route.continue();
  });
  try {
    await page.goto(`${origin}/settings/background-work`,{waitUntil:"networkidle"});
    const opener=page.getByRole("button",{name:/stop local tracking/i}).first();
    await opener.click();
    const dialog=page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button",{name:/cancel/i})).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(dialog).toBeVisible();
    const confirm=dialog.getByRole("button",{name:/^stop local tracking$/i});
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await confirm.click();
    await expect.poll(() => daemon.attempts.filter(call => call.method==="POST").length).toBe(1);
    const write=daemon.attempts.find(call => call.method==="POST");
    assert.ok(write?.key);
    assert.deepEqual(JSON.parse(write.body),{acknowledgeRemoteUncertainty:true,expected:identity()});
    assert.ok(beforeDispatch); assert.equal(beforeDispatch.key,write.key);
    for (const part of [target.id,write.key,identity().generation]) assert.ok(beforeDispatch.stored.includes(part),"exact recovery identity must be persisted before dispatch");
    const stopping=dialog.getByRole("button",{name:/^stopping local tracking(?:…|\.\.\.)$/i});
    await expect(stopping).toBeDisabled();
    await stopping.evaluate(element => (element as HTMLButtonElement).click());
    assert.equal(daemon.attempts.filter(call => call.method==="POST").length,1,"pending confirmation must not duplicate writes");
    daemon.release();
    await expect(page.getByText(/local stop not confirmed|not confirmed/i).first()).toBeVisible();
    const writes=daemon.attempts.filter(call => call.method==="POST").length;
    daemon.setNullReceipt(true);
    await page.reload({waitUntil:"networkidle"});
    await expect(page.getByText(/local stop not confirmed|not confirmed/i).first()).toBeVisible();
    const receiptPath=`${daemonPath}/runs/${encodeURIComponent(target.id)}/local-stop/by-key/${encodeURIComponent(write.key)}`;
    const browserReceiptPath=`${api}/runs/${encodeURIComponent(target.id)}/local-stop/by-key/${encodeURIComponent(write.key)}`;
    const lookups=() => daemon.attempts.filter(call => call.method==="GET" && call.path.includes("/local-stop/by-key/"));
    const beforeLookups=lookups().length;
    const check=page.getByRole("button",{name:/check local stop/i});
    await expect(check).toBeEnabled();
    const firstResponse=page.waitForResponse(response => response.request().method()==="GET" && new URL(response.url()).pathname===browserReceiptPath);
    await check.click();
    const first=await firstResponse;
    assert.equal(first.status(),200,"first null receipt lookup must succeed");
    assert.deepEqual(await first.json(),{receipt:null},"first lookup must observe the controlled null receipt");
    await expect(check).toBeEnabled();
    await expect(page.getByText(/local stop not confirmed|not confirmed/i).first()).toBeVisible();
    assert.deepEqual(lookups().slice(beforeLookups).map(call => call.path),[receiptPath],"first lookup must use the original target and key once");
    assert.equal(daemon.attempts.filter(call => call.method==="POST").length,writes,"a null receipt is not proof of failure");
    daemon.setNullReceipt(false);
    const secondResponse=page.waitForResponse(response => response.request().method()==="GET" && new URL(response.url()).pathname===browserReceiptPath);
    await expect(check).toBeEnabled();
    await check.click();
    const second=await secondResponse;
    assert.equal(second.status(),200,"second receipt lookup must succeed");
    assert.deepEqual(await second.json(),{receipt:receipt(write.key)},"second lookup must return the exact saved receipt");
    await expect(page.getByText(/local tracking stopped/i).first()).toBeVisible();
    assert.equal(daemon.attempts.filter(call => call.method==="POST").length,writes,"reload and receipt lookup must never resend");
    assert.deepEqual(lookups().slice(beforeLookups).map(call => call.path),[receiptPath,receiptPath],"both lookups must use the original target and key");
  } finally { daemon.release(); await page.unroute(routePattern); }
}

export async function checkBackgroundIdentityChange(page:Page,daemon:Fixture,origin:string):Promise<void> {
  daemon.reset();
  await page.goto(`${origin}/settings/background-work`,{waitUntil:"networkidle"});
  daemon.setGeneration("9007199254740994");
  await page.getByRole("button",{name:/stop local tracking/i}).first().click();
  await expect.poll(() => daemon.attempts.filter(call => call.method==="GET" && call.path.includes("/runs/")).length).toBeGreaterThan(0);
  await expect(page.getByText(/changed|refresh|no longer/i).first()).toBeVisible();
  assert.equal(daemon.attempts.filter(call => call.method==="POST").length,0,"changed identity cannot silently retarget a confirmation");
}
