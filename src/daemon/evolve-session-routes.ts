import { Hono } from "hono";
import { evolveKey, evolveTurnText, evolveValue, EvolveNotFoundError, type EvolveSessions } from "../domain/evolve-sessions";
import { object, params, SearchHttpError, type SearchEnv } from "./search-http";

export function createEvolveSessionRoutes(sessions: EvolveSessions): Hono<SearchEnv> {
  const app = new Hono<SearchEnv>();
  app.use("/evolve-sessions", async (c,next) => { c.header("cache-control","private, no-store"); if (c.get("actor") !== "user") throw new SearchHttpError(403,"forbidden"); await next(); });
  app.use("/evolve-sessions/*", async (c,next) => { c.header("cache-control","private, no-store"); if (c.get("actor") !== "user") throw new SearchHttpError(403,"forbidden"); await next(); });
  app.post("/evolve-sessions",async c => {
    params(c,[]);
    const input = await object(c,["anchorThoughtId"]);
    return c.json({session:sessions.create(evolveValue(input.anchorThoughtId,"anchorThoughtId"))},201);
  });
  app.get("/evolve-sessions/:id",c => {
    params(c,[]);
    return c.json(sessions.read(evolveValue(c.req.param("id"),"session id")));
  });
  app.post("/evolve-sessions/:id/turns",async c => {
    params(c,[]);
    const key = evolveKey(c.req.header("idempotency-key")), input = await object(c,["parentId","text"]);
    const result = sessions.admit(evolveValue(c.req.param("id"),"session id"),key,{parentId:evolveValue(input.parentId,"parentId"),text:evolveTurnText(input.text)});
    return c.json({receipt:result.receipt,turn:result.turn},result.replayed ? 200 : 201);
  });
  app.get("/evolve-sessions/:id/turns/by-key/:key",c => {
    params(c,[]);
    const result = sessions.byKey(evolveValue(c.req.param("id"),"session id"),evolveKey(c.req.param("key")));
    if (!result) throw new EvolveNotFoundError();
    return c.json(result);
  });
  return app;
}
