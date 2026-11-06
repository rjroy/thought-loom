import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Actor, ReadScope } from "../domain/rejection";
import { uniqueKeys } from "../domain/run-protocol";
import { importRequestKey, type ImportInspectionRepository, type ImportPage, type ImportPageCursor, type MarkdownImportRepository } from "../domain/markdown-import";

type Env = { Variables: { actor: Actor } };
type Ctx = Context<Env>;
export class ImportHttpError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 415 | 503, readonly code: string) { super(code); }
}
const bad = (): never => { throw new ImportHttpError(400,"invalid-import-request"); };
const invalidCursor = (): never => { throw new ImportHttpError(400,"invalid-cursor"); };
const metadataLimit = 4096;
const multipartOverhead = 65536;

function params(c: Ctx, allowed: readonly string[]): URLSearchParams {
  const p = new URL(c.req.url).searchParams;
  for (const key of p.keys()) if (!allowed.includes(key) || p.getAll(key).length !== 1) bad();
  return p;
}
function key(c: Ctx): string {
  const value = c.req.header("idempotency-key");
  if (value === undefined) return bad();
  return importRequestKey(value);
}
function strictObject(text: string, allowed: readonly string[]): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    uniqueKeys(text);
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(name => !allowed.includes(name))) return bad();
    return value as Record<string, unknown>;
  } catch { return bad(); }
}
async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0, complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) { complete = true; break; }
      length += item.value.byteLength;
      if (length > limit) throw new ImportHttpError(413,"source-too-large");
      chunks.push(item.value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.length; }
    return result;
  } finally {
    if (!complete) { try { await reader.cancel(); } catch { /* Request is already gone. */ } }
    reader.releaseLock();
  }
}
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8",{fatal:true}).decode(bytes); } catch { return bad(); }
}
async function jsonBody(c: Ctx, allowed: readonly string[]): Promise<Record<string,unknown>> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(c.req.header("content-type") ?? "")) throw new ImportHttpError(415,"unsupported-media-type");
  return strictObject(utf8(await readBytes(c.req.raw,metadataLimit)),allowed);
}
/** Parse only the two permitted parts, retaining metadata bytes for fatal UTF-8 decoding. */
function multipart(bytes: Uint8Array, boundary: string): {metadata: string; metadataBytes: number; file: Uint8Array} {
  const data=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const marker=Buffer.from(`--${boundary}`), delimiter=Buffer.from(`\r\n--${boundary}`);
  if (!data.subarray(0,marker.length).equals(marker)) return bad();
  let position=marker.length, metadata: string|undefined, metadataBytes=0, file: Uint8Array|undefined;
  while (true) {
    if (data.subarray(position,position+2).equals(Buffer.from("--"))) {
      position+=2;
      if (position!==data.length && !(position+2===data.length && data.subarray(position).equals(Buffer.from("\r\n")))) return bad();
      break;
    }
    if (!data.subarray(position,position+2).equals(Buffer.from("\r\n"))) return bad();
    position+=2;
    const endHeaders=data.indexOf("\r\n\r\n",position);
    if (endHeaders<0 || endHeaders-position>multipartOverhead) return bad();
    const headerBytes=data.subarray(position,endHeaders);
    if (headerBytes.some(byte => byte<32 && byte!==13 && byte!==10 && byte!==9)) return bad();
    const headers=new Map<string,string>();
    for (const line of utf8(headerBytes).split("\r\n")) {
      const match=/^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
      if (!match || !match[1] || match[2]===undefined) return bad();
      const name=match[1].toLowerCase();
      if (headers.has(name) || (name!=="content-disposition" && name!=="content-type")) return bad();
      headers.set(name,match[2]);
    }
    const disposition=headers.get("content-disposition") ?? "";
    const part=/^form-data;\s*name="(metadata|file)"(?:;\s*filename="(?:[^"\\\r\n]|\\["\\])*")?\s*$/i.exec(disposition);
    if (!part) return bad();
    const start=endHeaders+4;
    let end=data.indexOf(delimiter,start);
    while (end>=0) {
      const suffix=data.subarray(end+delimiter.length,end+delimiter.length+2);
      if (suffix.equals(Buffer.from("\r\n")) || suffix.equals(Buffer.from("--"))) break;
      end=data.indexOf(delimiter,end+delimiter.length);
    }
    if (end<0) return bad();
    if (part[1]==="metadata") {
      if (metadata!==undefined || /;\s*filename=/i.test(disposition) || end-start>metadataLimit) return bad();
      metadata=utf8(data.subarray(start,end));
      metadataBytes=end-start;
    } else if (part[1]==="file") {
      if (file!==undefined) return bad();
      file=data.subarray(start,end);
    } else return bad();
    position=end+2+marker.length;
  }
  if (metadata===undefined || file===undefined) return bad();
  return {metadata,metadataBytes,file};
}
function inspection(c: Ctx, allowed: readonly string[] = []): ReadScope {
  const p = params(c,["scope",...allowed]);
  if (p.get("scope") !== "history") throw new ImportHttpError(400,"inspection-scope-required");
  return {actor:"user",mode:"history"};
}
function thoughtScope(c: Ctx): ReadScope {
  const p=params(c,["scope"]), mode=p.get("scope") ?? "normal";
  if (mode!=="normal" && mode!=="history" && mode!=="show-rejected") return bad();
  return {actor:"user",mode};
}

/** Authenticate finite keyset continuations with a process-owned key, never a caller credential. */
function cursors() {
  const secret=randomBytes(32);
  const sign=(value:string) => createHmac("sha256",secret).update(value).digest();
  function encode(cursor: ImportPageCursor | null): string | null {
    if (!cursor) return null;
    const value=Buffer.from(JSON.stringify({v:1,...cursor})).toString("base64url");
    return `${value}.${sign(value).toString("base64url")}`;
  }
  function decode(token: string, kind: ImportPageCursor["kind"], parentId: string|null, scope: ImportPageCursor["scope"], limit: number): ImportPageCursor {
    const parts=token.split(".");
    if (parts.length!==2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return invalidCursor();
    const supplied=Buffer.from(parts[1],"base64url"), expected=sign(parts[0]);
    if (supplied.toString("base64url")!==parts[1] || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return invalidCursor();
    let data: Record<string,unknown>;
    try { data=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8")); } catch { return invalidCursor(); }
    if (!data || data.v!==1 || data.kind!==kind || data.parentId!==parentId || data.scope!==scope || data.limit!==limit ||
      typeof data.after!=="number" || !Number.isSafeInteger(data.after) || data.after<0 ||
      typeof data.highWater!=="number" || !Number.isSafeInteger(data.highWater) || data.highWater<data.after) return invalidCursor();
    return {kind,parentId,scope,limit,after:data.after,highWater:data.highWater};
  }
  return {encode,decode};
}

export function createMarkdownImportRoutes(imports: MarkdownImportRepository, inspectionRepo: ImportInspectionRepository, maxBytes: number): Hono<Env> {
  const app=new Hono<Env>(), cursor=cursors();
  let receivers=0;
  const gate: MiddlewareHandler<Env> = async (c,next) => {
    c.header("cache-control","private, no-store");
    if (c.get("actor")!=="user") throw new ImportHttpError(403,"forbidden");
    await next();
  };
  function page(c: Ctx, kind: ImportPageCursor["kind"], parent: string|null, scope: ImportPageCursor["scope"]) {
    const p=params(c,scope==="history" ? ["scope","limit","cursor"] : ["limit","cursor"]);
    const value=p.get("limit");
    if (value!==null && !/^[1-9]\d*$/.test(value)) return bad();
    const limit=value===null ? 50 : Number(value);
    if (!Number.isSafeInteger(limit) || limit>200) return bad();
    const token=p.get("cursor");
    return {limit,...(token===null ? {} : {cursor:cursor.decode(token,kind,parent,scope,limit)})};
  }
  function result<T>(p: ImportPage<T>) { return {items:p.items,nextCursor:cursor.encode(p.nextCursor)}; }
  app.get("/import-namespaces",gate,c => { params(c,[]); return c.json({items:imports.namespaces("user").map(({id,kind,label}) => ({id,kind,label}))}); });
  app.post("/imports/markdown",gate,async c => {
    params(c,[]); const requestKey=key(c), data=await jsonBody(c,["namespaceId"]);
    if (data.namespaceId!==undefined && (typeof data.namespaceId!=="string" || !data.namespaceId.trim())) return bad();
    const receipt=imports.createBatchAdmission("user",requestKey,data.namespaceId as string|undefined);
    return c.json({import:receipt.batch},receipt.replayed ? 200 : 201);
  });
  app.post("/imports/markdown/:id/files",gate,async c => {
    params(c,[]); const requestKey=key(c), contentType=c.req.header("content-type") ?? "";
    const media=/^multipart\/form-data\s*;\s*boundary=(?:([A-Za-z0-9'()+_,.\/:=?-]{1,70})|"([A-Za-z0-9'()+_,.\/:=?-]{1,70})")\s*$/i.exec(contentType);
    const boundary=media?.[1] ?? media?.[2];
    if (!boundary) throw new ImportHttpError(415,"unsupported-media-type");
    if (receivers>=2) { c.header("retry-after","1"); throw new ImportHttpError(503,"receiver-busy"); }
    receivers++;
    try {
      const totalLimit=Math.min(Number.MAX_SAFE_INTEGER,maxBytes+metadataLimit+multipartOverhead);
      const data=await readBytes(c.req.raw,totalLimit);
      const {metadata,metadataBytes,file}=multipart(data,boundary);
      if (file.byteLength>maxBytes) throw new ImportHttpError(413,"source-too-large");
      if (data.byteLength-file.byteLength-metadataBytes>multipartOverhead) throw new ImportHttpError(413,"source-too-large");
      const object=strictObject(metadata,["relativePath"]);
      if (typeof object.relativePath!=="string") return bad();
      const receipt=imports.admitFileAdmission("user",c.req.param("id"),requestKey,object.relativePath,file);
      const done=receipt.file.state==="skipped-identical" || receipt.file.state==="skipped-changed";
      return c.json({file:receipt.file},receipt.replayed || done ? 200 : 202);
    } finally { receivers--; }
  });
  app.post("/imports/markdown/:id/seal",gate,async c => { params(c,[]); await jsonBody(c,[]); return c.json({import:imports.sealBatch("user",c.req.param("id"))}); });
  app.get("/imports/markdown",gate,c => c.json(result(inspectionRepo.batches("user",page(c,"batches",null,"user")))));
  app.get("/imports/markdown/:id",gate,c => { params(c,[]); const item=imports.batch("user",c.req.param("id")); if (!item) throw new ImportHttpError(404,"not-found"); return c.json({import:item}); });
  app.get("/imports/markdown/:id/files",gate,c => { const id=c.req.param("id"); return c.json(result(inspectionRepo.files("user",id,page(c,"files",id,"user")))); });
  app.get("/imports/markdown/:id/files/:fileId",gate,c => { params(c,[]); const file=imports.file("user",c.req.param("id"),c.req.param("fileId")); if (!file) throw new ImportHttpError(404,"not-found"); return c.json({file}); });
  app.get("/import-sources",gate,c => { const s=inspection(c,["limit","cursor"]); return c.json(result(inspectionRepo.sources(s,page(c,"sources",null,"history")))); });
  app.get("/import-sources/:id",gate,c => { const s=inspection(c), source=inspectionRepo.source(s,c.req.param("id")); if (!source) throw new ImportHttpError(404,"not-found"); return c.json({source}); });
  app.get("/import-sources/:id/parts",gate,c => { const s=inspection(c,["limit","cursor"]), id=c.req.param("id"); return c.json(result(inspectionRepo.parts(s,id,page(c,"parts",id,"history")))); });
  app.get("/import-sources/:id/raw",gate,c => { const s=inspection(c), bytes=inspectionRepo.raw(s,c.req.param("id")); if (!bytes) throw new ImportHttpError(404,"not-found"); return c.body(bytes as Uint8Array<ArrayBuffer>,200,{"content-type":"text/markdown; charset=utf-8","content-disposition":"attachment; filename=\"source.md\"","x-content-type-options":"nosniff"}); });
  app.get("/thoughts/:id/import-source",gate,c => { const provenance=inspectionRepo.provenance(thoughtScope(c),c.req.param("id")); if (!provenance) throw new ImportHttpError(404,"not-found"); return c.json(provenance); });
  return app;
}
