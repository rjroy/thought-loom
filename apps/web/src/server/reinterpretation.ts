import type { DaemonRequest } from "./daemon";
import { reinterpretationId, reinterpretationKey, reinterpretationSnapshot } from "../features/idea/reinterpretation";

export interface ReinterpretationDependencies { readonly callDaemon: (request: DaemonRequest) => Promise<Response> }
const headers = {"cache-control":"private, no-store"};
const problem = (status: number) => Response.json({message:status === 400 ? "Invalid request." : status === 404 ? "Idea unavailable." : "Unable to confirm outcome."},{status,headers});
const record = (value: unknown): value is Record<string,unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function bounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader(), decoder = new TextDecoder("utf-8",{fatal:true});
  let size = 0, text = "";
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); return null; }
      text += decoder.decode(value,{stream:true});
    }
  } finally { reader.releaseLock(); }
}

/** Fixed control boundary; receipts remain readable after rejection, without reading the subject. */
export async function handleReinterpretation(request: Request, subjectId: string, key: string | null, deps: ReinterpretationDependencies): Promise<Response> {
  if (!reinterpretationId(subjectId) || !key || !reinterpretationKey(key) || new URL(request.url).search
      || (request.method !== "POST" && request.method !== "GET")) return problem(400);
  if (request.method === "POST") {
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(request.headers.get("content-type") ?? "")) return problem(415);
    try {
      const text = await bounded(request.body,4096);
      if (text === null) return problem(413);
      const data: unknown = JSON.parse(text);
      if (!record(data) || Object.keys(data).length !== 0) return problem(400);
    } catch { return problem(400); }
  }
  const path = `/thoughts/${subjectId}/reinterpret`;
  const operation: DaemonRequest = request.method === "POST"
    ? {method:"POST",path,body:"{}",idempotencyKey:key,preserveErrorBody:true}
    : {method:"GET",path:`${path}/by-key/${encodeURIComponent(key)}`,preserveErrorBody:true};
  try {
    const response = await deps.callDaemon(operation);
    if ([400,401,403,404,413,415].includes(response.status)) return problem(response.status);
    if (!(request.method === "POST" ? [200,202,409].includes(response.status) : response.status === 200)) return problem(502);
    const text = await bounded(response.body,1024*1024);
    if (text === null) return problem(502);
    const value: unknown = JSON.parse(text);
    if (!record(value)) return problem(502);
    if (response.status === 409) {
      if (Object.keys(value).length !== 5 || value.error !== "Conflict" || (value.code !== "interpretation-active" && value.code !== "interpretation-unsettled")) return problem(502);
      const snapshot: unknown = {receipt:value.receipt,run:value.run,eligibility:value.eligibility};
      if (!reinterpretationSnapshot(snapshot,subjectId,key) || snapshot.receipt !== null || snapshot.eligibility.eligible
          || (value.code === "interpretation-active" ? snapshot.eligibility.reason !== "work-active" : !["work-unsettled","work-unverified"].includes(snapshot.eligibility.reason))) return problem(502);
      return Response.json({error:"Conflict",code:value.code,...snapshot},{status:409,headers});
    }
    if (!reinterpretationSnapshot(value,subjectId,key) || (request.method === "POST" && value.receipt === null)) return problem(502);
    return Response.json(value,{status:response.status,headers});
  } catch { return problem(502); }
}
