import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Actor, ReadScope } from "../domain/rejection";
import type { MediaImports } from "../domain/media-import";
import { importRequestKey } from "../domain/markdown-import-contract";
import { ImportHttpError, metadataLimit, multipartOverhead, multipartBoundary, multipart, readBytes, strictObject, utf8 } from "./import-body";

type Env = {Variables:{actor:Actor}};
type Ctx = Context<Env>;
const bad = (): never => { throw new ImportHttpError(400,"invalid-media-request"); };
const supported = new Set(["image/png","image/jpeg","image/gif","image/webp","application/pdf"]);
function params(c: Ctx, allowed: readonly string[] = []): URLSearchParams {
  const query = new URL(c.req.url).searchParams;
  for (const name of query.keys()) if (!allowed.includes(name) || query.getAll(name).length !== 1) bad();
  return query;
}
function key(c: Ctx): string {
  const value = c.req.header("idempotency-key");
  return value === undefined ? bad() : importRequestKey(value);
}
function scope(c: Ctx): ReadScope {
  const mode = params(c,["scope"]).get("scope") ?? "normal";
  if (mode !== "normal" && mode !== "history") return bad();
  return {actor:"user",mode};
}

/** User transport only; storage selects managed identities and the normal weave lifecycle. */
export function createMediaRoutes(media: MediaImports, maxBytes: number, notify: () => void): Hono<Env> {
  const app = new Hono<Env>();
  let receivers = 0;
  const user: MiddlewareHandler<Env> = async (c,next) => {
    c.header("cache-control","private, no-store");
    if (c.get("actor") !== "user") throw new ImportHttpError(403,"forbidden");
    await next();
  };
  app.post("/imports/media",user,async c => {
    params(c);
    const requestKey = key(c), boundary = multipartBoundary(c.req.header("content-type") ?? "");
    if (receivers >= 2) { c.header("retry-after","1"); throw new ImportHttpError(503,"receiver-busy"); }
    receivers++;
    try {
      const bytes = await readBytes(c.req.raw,Math.min(Number.MAX_SAFE_INTEGER,maxBytes+metadataLimit+multipartOverhead));
      const part = multipart(bytes,boundary,bad);
      if (part.file.length > maxBytes || bytes.length-part.file.length-part.metadataBytes > multipartOverhead) throw new ImportHttpError(413,"source-too-large");
      if (!part.filename) return bad();
      if (!part.mimeType || !supported.has(part.mimeType)) throw new ImportHttpError(415,"unsupported-media-type");
      const metadata = strictObject(part.metadata,["clarification"],bad), clarification = metadata.clarification ?? null;
      if (clarification !== null && (typeof clarification !== "string" || !clarification.trim())) return bad();
      const result = await media.admit("user",{requestKey,name:part.filename,clarification,bytes:part.file});
      if (!result.replayed) notify();
      return c.json({thought:result.thought,run:result.run},result.replayed ? 200 : 202);
    } finally { receivers--; }
  });
  app.get("/imports/media/by-key/:key",user,c => {
    params(c);
    const result = media.byKey("user",importRequestKey(c.req.param("key")));
    if (!result) throw new ImportHttpError(404,"not-found");
    return c.json({thought:result.thought,run:result.run});
  });
  app.get("/media-sources/:id",user,c => {
    const result = media.inspect(scope(c),c.req.param("id"));
    if (!result) throw new ImportHttpError(404,"not-found");
    return c.json(result);
  });
  app.get("/media-sources/:id/raw",user,async c => {
    const result = await media.raw(scope(c),c.req.param("id"));
    if (!result) throw new ImportHttpError(404,"not-found");
    // A fixed ASCII filename cannot turn the untrusted display name into response headers.
    const extension = result.mimeType === "application/pdf" ? "pdf" : result.mimeType === "image/jpeg" ? "jpg" :
      result.mimeType === "image/gif" ? "gif" : result.mimeType === "image/webp" ? "webp" : "png";
    const bytes = new Uint8Array(result.bytes);
    return c.body(bytes,200,{"content-type":result.mimeType,"content-disposition":`attachment; filename="source.${extension}"`,"x-content-type-options":"nosniff"});
  });
  app.post("/media-sources/:id/retry",user,async c => {
    params(c);
    const requestKey = key(c);
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(c.req.header("content-type") ?? "")) throw new ImportHttpError(415,"unsupported-media-type");
    strictObject(utf8(await readBytes(c.req.raw,metadataLimit),bad),[],bad);
    const result = media.retry("user",c.req.param("id"),requestKey);
    if (!result.replayed) notify();
    return c.json({run:result.run},result.replayed ? 200 : 202);
  });
  return app;
}
