import { Hono } from "hono";
import { searchRequestKey, type SearchSessions } from "../domain/agentic-search";
import { object, params, SearchHttpError, type SearchEnv } from "./search-http";
import type { SearchClockReceipts } from "./search-clock-receipts";

export function createSearchTurnRoutes(sessions: SearchSessions, configured: boolean, notify?: () => void, receipts?: SearchClockReceipts): Hono<SearchEnv> {
  const app = new Hono<SearchEnv>();
  app.post("/search-sessions/:id/turns",async c => {
    params(c,[]);
    const key = searchRequestKey(c.req.header("idempotency-key"));
    const input = await object(c,["text","startingThoughtIds","requestClock","effort","contextMode","composerId","contextToken"]);
    const result = sessions.admitTurnWithPolicy("user",c.req.param("id"),key,input,configured);
    try { if (receipts) {
      if (!result.replayed) receipts.forgetSession(result.control.receipt.searchSessionId);
      receipts.record(receipts.ownerRun(result.control.run.id),c.get("searchClockReceipt"));
    } }
    catch { /* The admission is committed; missing transient clock falls back to its retained anchor. */ }
    if (!result.replayed) { try { notify?.(); } catch { /* Admission already committed; polling remains available. */ } }
    return c.json(result.control,result.replayed ? 200 : 201);
  });
  app.get("/search-sessions/:id/turns/by-key/:requestKey",c => {
    params(c,[]);
    const result = sessions.turnByKey("user",c.req.param("id"),c.req.param("requestKey"));
    if (!result) throw new SearchHttpError(404,"search-turn-not-found");
    return c.json(result);
  });
  return app;
}
