import "server-only";
import { callDaemon } from "../../server/client";
import { readWebConfig } from "../../server/config";
import { isTrustedRequest } from "../../server/request-guard";
import { sameTarget, stopIdentity, stopKey, stopReceipt, workCounts, workId, workItem, workPage, type WorkTarget } from "./types";

type Operation = "summary"|"list"|"detail"|"stop"|"receipt";
type Params = {type?:string;id?:string;key?:string};
const headers={"cache-control":"private, no-store"};
const problem=(status:number) => Response.json({message:status===400 ? "Invalid request." : status===403 ? "Forbidden." : status===404 ? "Work unavailable." : "Unable to confirm background work."},{status,headers});
const object=(v:unknown):v is Record<string,unknown> => typeof v==="object" && v!==null && !Array.isArray(v);
const exact=(v:Record<string,unknown>,key:string) => Object.keys(v).length===1 && Object.hasOwn(v,key);
function discard(response:Response) { try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort. */ } }
async function bounded(body:ReadableStream<Uint8Array>|null,limit:number):Promise<string|null> {
  if (!body) return "";
  const reader=body.getReader(), decoder=new TextDecoder("utf-8",{fatal:true}); let size=0,text="";
  try { while (true) { const {done,value}=await reader.read(); if (done) return text+decoder.decode();
    size+=value.byteLength; if (size>limit) { void reader.cancel().catch(() => {}); return null; }
    text+=decoder.decode(value,{stream:true}); } } finally { reader.releaseLock(); }
}
export async function backgroundRoute(request:Request,operation:Operation,params:Promise<Params> = Promise.resolve({})):Promise<Response> {
  try {
    const config=readWebConfig({THOUGHTLOOM_WEB_ORIGIN:process.env.THOUGHTLOOM_WEB_ORIGIN,THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS:process.env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS});
    if (!isTrustedRequest(config,request)) return problem(403);
  } catch {return problem(403);}
  const p=await params, query=new URL(request.url).searchParams;
  if (operation!=="list" && query.size) return problem(400);
  if (operation==="list") {
    for (const k of query.keys()) if (!["view","limit","cursor"].includes(k) || query.getAll(k).length!==1) return problem(400);
    const view=query.get("view"), limit=query.get("limit"), cursor=query.get("cursor");
    if ((view!==null && !["needs-attention","in-progress","locally-closed"].includes(view)) ||
      (limit!==null && (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit)>100)) ||
      (cursor!==null && (!cursor || cursor.length>2048))) return problem(400);
  }
  let target:WorkTarget|undefined;
  if (operation==="detail" || operation==="stop" || operation==="receipt") {
    if ((p.type!=="runs" && p.type!=="import-files") || !workId(p.id)) return problem(400);
    target={type:p.type==="runs" ? "run" : "import-file",id:p.id};
  }
  const key=operation==="stop" ? request.headers.get("idempotency-key") : p.key;
  if ((operation==="stop" || operation==="receipt") && !stopKey(key)) return problem(400);
  let expected:unknown;
  if (operation==="stop") {
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(request.headers.get("content-type") ?? "")) return problem(415);
    try {
      const body=await bounded(request.body,4096); if (body===null) return problem(413);
      const data:unknown=JSON.parse(body);
      if (!object(data) || Object.keys(data).length!==2 || data.acknowledgeRemoteUncertainty!==true || !stopIdentity(data.expected) ||
        !target || !sameTarget(target,data.expected)) return problem(400);
      expected=data.expected;
    } catch { return problem(400); }
  }
  const base=target ? `/background-work/${target.type==="run" ? "runs" : "import-files"}/${encodeURIComponent(target.id)}` : "/background-work";
  const path=operation==="summary" ? `${base}/summary` : operation==="list" ? base+(query.size ? `?${query}` : "") :
    operation==="stop" ? `${base}/local-stop` : operation==="receipt" && stopKey(key) ? `${base}/local-stop/by-key/${encodeURIComponent(key)}` : base;
  try {
    const response=await callDaemon({path,method:operation==="stop" ? "POST" : "GET",
      ...(operation==="stop" && stopKey(key) ? {idempotencyKey:key,body:JSON.stringify({acknowledgeRemoteUncertainty:true,expected})} : {})});
    if (![200,...(operation==="stop" ? [201] : [])].includes(response.status)) {
      const status=[400,401,403,404,409,413,415].includes(response.status) ? response.status : 502;
      discard(response); return problem(status);
    }
    const text=await bounded(response.body,1024*1024); if (text===null) return problem(502);
    const data:unknown=JSON.parse(text);
    const valid=operation==="summary" ? object(data) && exact(data,"counts") && workCounts(data.counts) :
      operation==="list" ? workPage(data) :
      operation==="detail" ? object(data) && exact(data,"item") && workItem(data.item) && !!target && sameTarget(target,data.item.target) :
      object(data) && exact(data,"receipt") && !!target && stopKey(key) &&
        (operation==="receipt" && data.receipt===null || stopReceipt(data.receipt,target,key,stopIdentity(expected) ? expected : undefined));
    return valid ? Response.json(data,{status:response.status,headers}) : problem(502);
  } catch { return problem(502); }
}
