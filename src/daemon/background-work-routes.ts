import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { BackgroundPosition, BackgroundView, BackgroundWorkRepository } from "../domain/background-work";
import type { Actor } from "../domain/rejection";
import { record } from "../domain/validation";
import { ImportHttpError } from "./import-body";
import { readBytes, strictObject, utf8 } from "./import-body";
import { localStopKey, parseLocalStopIdentity, type LocalStopController } from "../domain/local-work-stop";

type Env = { Variables: { actor: Actor } };
const bad = (): never => { throw new ImportHttpError(400,"invalid-background-work-request"); };
function params(c: Context<Env>, allowed: readonly string[]): URLSearchParams {
  const p = new URL(c.req.url).searchParams;
  for (const key of p.keys()) if (!allowed.includes(key) || p.getAll(key).length !== 1) bad();
  return p;
}

export function createBackgroundWorkRoutes(repository: BackgroundWorkRepository,localStops?:LocalStopController): Hono<Env> {
  const app = new Hono<Env>(), secret = randomBytes(32);
  const sign = (s: string) => createHmac("sha256",secret).update(s).digest();
  app.use("/background-work/*", async (c,next) => {
    c.header("cache-control","private, no-store");
    if (c.get("actor") !== "user") throw new ImportHttpError(403,"forbidden");
    await next();
  });
  app.get("/background-work/summary", c => { params(c,[]); return c.json({counts:repository.summary()}); });
  app.get("/background-work", c => {
    const p=params(c,["view","limit","cursor"]), value=p.get("view") ?? "needs-attention";
    if (value !== "needs-attention" && value !== "in-progress" && value !== "locally-closed") return bad();
    const view: BackgroundView = value, raw=p.get("limit");
    if (raw !== null && !/^[1-9]\d*$/.test(raw)) return bad();
    const limit=raw === null ? 25 : Number(raw);
    if (!Number.isSafeInteger(limit) || limit>100) return bad();
    let after: BackgroundPosition | undefined;
    const token=p.get("cursor");
    if (token !== null) {
      if (token.length>2048) return bad();
      const parts=token.split(".");
      if (parts.length!==2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return bad();
      const supplied=Buffer.from(parts[1],"base64url"), expected=sign(parts[0]);
      if (supplied.toString("base64url")!==parts[1] || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return bad();
      try {
        const data=record(JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8")));
        if (data.v!==1 || data.view!==view || data.limit!==limit || (data.type!=="run" && data.type!=="import-file") ||
          typeof data.id!=="string" || !data.id || (data.createdAt!==null && (typeof data.createdAt!=="string" || !data.createdAt))) return bad();
        after={type:data.type,id:data.id,createdAt:data.createdAt};
      } catch { return bad(); }
    }
    const result=repository.list(view,limit,after), last=result.items.at(-1);
    let nextCursor: string|null=null;
    if (result.hasMore && last) {
      const payload=Buffer.from(JSON.stringify({v:1,view,limit,...last.target,createdAt:last.createdAt})).toString("base64url");
      nextCursor=`${payload}.${sign(payload).toString("base64url")}`;
    }
    return c.json({items:result.items,nextCursor});
  });
  for (const [path,type] of [["runs","run"],["import-files","import-file"]] as const) {
    app.get(`/background-work/${path}/:id`, c => {
      params(c,[]);
      const item=repository.get({type,id:c.req.param("id")});
      if (!item) throw new ImportHttpError(404,"not-found");
      return c.json({item});
    });
    if (localStops) {
      app.get(`/background-work/${path}/:id/local-stop/by-key/:key`,c => {
        params(c,[]);
        return c.json({receipt:localStops.byKey({type,id:c.req.param("id")},localStopKey(c.req.param("key")))});
      });
      app.post(`/background-work/${path}/:id/local-stop`,async c => {
        params(c,[]);
        const key=localStopKey(c.req.header("Idempotency-Key"));
        if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(c.req.header("content-type") ?? "")) throw new ImportHttpError(415,"unsupported-media-type");
        const data=strictObject(utf8(await readBytes(c.req.raw,4096)),["acknowledgeRemoteUncertainty","expected"],bad);
        if (data.acknowledgeRemoteUncertainty !== true) return bad();
        const expected=parseLocalStopIdentity(data.expected);
        const result=await localStops.stop({type,id:c.req.param("id")},key,expected);
        return c.json({receipt:result.receipt},result.replayed ? 200 : 201);
      });
    }
  }
  return app;
}
