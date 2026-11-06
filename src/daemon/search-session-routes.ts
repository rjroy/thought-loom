import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { searchCatalogQuery, searchRequestKey, type SearchCatalogCursor, type SearchSessions } from "../domain/agentic-search";
import { bad, bytes, object, params, SearchHttpError, type SearchEnv } from "./search-http";
import { createSearchWorkspaceRoutes } from "./search-workspace-routes";
import { createSearchTurnRoutes } from "./search-turn-routes";
import { parseSearchClockHeaders, type SearchClockReceipts } from "./search-clock-receipts";
import type { MiddlewareHandler } from "hono";

/** Process-local authentication binds the opaque catalog continuation to its endpoint and page size. */
function catalogCursors() {
  const secret = randomBytes(32), sign = (value: string) => createHmac("sha256",secret).update(value).digest();
  return {
    encode(cursor: SearchCatalogCursor | null): string | null {
      if (!cursor) return null;
      const value = Buffer.from(JSON.stringify({version:1,endpoint:"search-sessions",cursor})).toString("base64url");
      return `${value}.${sign(value).toString("base64url")}`;
    },
    decode(token: string, limit: number | undefined): SearchCatalogCursor {
      if (token.length > 2048) return bad();
      const parts = token.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return bad();
      const supplied = Buffer.from(parts[1],"base64url"), expected = sign(parts[0]);
      if (supplied.toString("base64url") !== parts[1] || supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) return bad();
      try {
        const data: unknown = JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)) return bad();
        const payload = data as Record<string,unknown>;
        if (payload.version !== 1 || payload.endpoint !== "search-sessions") return bad();
        const parsed = searchCatalogQuery({cursor:payload.cursor,...(limit === undefined ? {} : {limit})});
        if (!parsed.cursor) return bad();
        return parsed.cursor;
      } catch { return bad(); }
    },
  };
}
export function createSearchSessionRoutes(sessions: SearchSessions, configured: boolean, notify?: () => void, receipts?: SearchClockReceipts): Hono<SearchEnv> {
  const app = new Hono<SearchEnv>(), cursor = catalogCursors();
  app.use("/search-sessions",async (c,next) => { if (c.get("actor") !== "user") throw new SearchHttpError(403,"forbidden"); await next(); });
  app.use("/search-sessions/*",async (c,next) => { if (c.get("actor") !== "user") throw new SearchHttpError(403,"forbidden"); await next(); });
  const clock: MiddlewareHandler<SearchEnv> = async (c,next) => {
    const receipt = receipts ? receipts.parse(c.req.raw.headers) : parseSearchClockHeaders(c.req.raw.headers);
    c.set("searchClockReceipt",receipt);
    const id = c.req.param("id"), admission = c.req.method === "POST" && /\/turns$/.test(c.req.path);
    const owner = receipt && receipts && id && !admission ? receipts.ownerSession(id) : null;
    await next();
    if (c.res.status < 400 && receipts && id) {
      try {
        if (c.req.method === "DELETE" && /^\/search-sessions\/[^/]+$/.test(c.req.path)) receipts.forgetSession(id);
        else if (!admission) receipts.record(owner,receipt);
      } catch { /* Receipt caching must not turn a committed operation into a failure. */ }
    }
  };
  app.use("/search-sessions",async (c,next) => {
    if (receipts) receipts.parse(c.req.raw.headers); else parseSearchClockHeaders(c.req.raw.headers);
    await next();
  });
  app.use("/search-sessions/:id",clock);
  app.use("/search-sessions/:id/*",clock);
  app.route("/",createSearchWorkspaceRoutes(sessions));
  app.route("/",createSearchTurnRoutes(sessions,configured,notify,receipts));
  app.post("/search-sessions",async c => {
    params(c,[]); const key = searchRequestKey(c.req.header("idempotency-key"));
    const result = sessions.create("user",key,await object(c,[]));
    return c.json({session:result.session},result.replayed ? 200 : 201);
  });
  app.get("/search-sessions",c => {
    const p = params(c,["limit","cursor"]), raw = p.get("limit"), token = p.get("cursor");
    if (raw !== null && !/^[1-9]\d*$/.test(raw)) return bad();
    const limit = raw === null ? undefined : Number(raw);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit > 200)) return bad();
    const page = sessions.list("user",{...(limit === undefined ? {} : {limit}),...(token === null ? {} : {cursor:cursor.decode(token,limit)})});
    return c.json({items:page.items,nextCursor:cursor.encode(page.nextCursor)});
  });
  app.get("/search-sessions/:id",c => {
    params(c,[]); const result = sessions.metadata("user",c.req.param("id"));
    if (!result) throw new SearchHttpError(404,"search-session-not-found");
    return c.json(result);
  });
  app.patch("/search-sessions/:id",async c => {
    params(c,[]); const revision = c.req.header("if-match");
    if (revision === undefined || !/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) return bad();
    const session = sessions.rename("user",c.req.param("id"),Number(revision),await object(c,["title"]));
    return c.json({session});
  });
  app.delete("/search-sessions/:id",async c => {
    params(c,[]); if ((await bytes(c.req.raw,4096)).length !== 0) return bad();
    sessions.delete("user",c.req.param("id")); return c.body(null,204);
  });
  return app;
}
