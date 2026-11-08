import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Actor } from "../domain/rejection";
import { reinterpretationRequestKey, type ReinterpretationService } from "../domain/reinterpretation";
import { RunForbiddenError } from "../domain/run";
import { ValidationError } from "../domain/validation";
import { createLogger, type Logger } from "../logging";
import { ImportHttpError, metadataLimit, readBytes, strictObject, utf8 } from "./import-body";

type Env = {Variables:{actor:Actor}};
const bad = (): never => { throw new ValidationError("Invalid reinterpretation request"); };
function noQuery(c: Context<Env>): void { if (new URL(c.req.url).searchParams.size) bad(); }

/** Fixed user-only command and control-receipt paths; neither returns thought or native content. */
export function createReinterpretationRoutes(service: Pick<ReinterpretationService,"admit"|"byKey">,
  notify: () => void, logger: Logger = createLogger()): Hono<Env> {
  const app = new Hono<Env>();
  const user: MiddlewareHandler<Env> = async (c,next) => {
    c.header("cache-control","private, no-store");
    if (c.get("actor") !== "user") throw new RunForbiddenError();
    await next();
  };
  app.post("/thoughts/:id/reinterpret",user,async c => {
    noQuery(c);
    const key = reinterpretationRequestKey(c.req.header("idempotency-key"));
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(c.req.header("content-type") ?? "")) {
      throw new ImportHttpError(415,"unsupported-media-type");
    }
    let bytes: Uint8Array;
    try { bytes = await readBytes(c.req.raw,metadataLimit); }
    catch (error) {
      if (error instanceof ImportHttpError && error.status === 413) throw new ImportHttpError(413,"request-too-large");
      throw error;
    }
    const input = strictObject(utf8(bytes,bad),[],bad);
    const result = service.admit("user",c.req.param("id"),key,input);
    if (!result.replayed) {
      try { notify(); }
      catch { logger.warning("[reinterpretation] worker notification deferred",{runId:result.snapshot.receipt?.runId}); }
    }
    return c.json(result.snapshot,result.replayed ? 200 : 202);
  });
  app.get("/thoughts/:id/reinterpret/by-key/:key",user,c => {
    noQuery(c);
    return c.json(service.byKey("user",c.req.param("id"),reinterpretationRequestKey(c.req.param("key"))));
  });
  return app;
}
