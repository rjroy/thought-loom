import { Hono } from "hono";
import { evolveKey, evolveReplyBytes, evolveReplyText, evolveTurnText, evolveValue, EvolveNotFoundError, type EvolveSessions } from "../domain/evolve-sessions";
import { oneOf } from "../domain/validation";
import { object, params, SearchHttpError, type SearchEnv } from "./search-http";

export function createEvolveSessionRoutes(sessions: EvolveSessions, notify?: () => void): Hono<SearchEnv> {
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
    const key = evolveKey(c.req.header("idempotency-key")), input = await object(c,["parentId","text"],4096 * 6 + 4096);
    const result = sessions.admit(evolveValue(c.req.param("id"),"session id"),key,{parentId:evolveValue(input.parentId,"parentId"),text:evolveTurnText(input.text)});
    if (!result.replayed && result.run) notify?.();
    return c.json({receipt:result.receipt,turn:result.turn,run:result.run},result.replayed ? 200 : 201);
  });
  app.put("/evolve-sessions/:id/continuation",async c => {
    params(c,[]);
    const input = await object(c,["thoughtId"]);
    return c.json({session:sessions.continueAt(c.req.param("id"),evolveValue(input.thoughtId,"thoughtId"))});
  });
  app.post("/evolve-sessions/:id/turns/:turnId/saves",async c => {
    params(c,[]);
    const key = evolveKey(c.req.header("idempotency-key")), input = await object(c,["speaker","text","parentId"],evolveReplyBytes * 6 + 4096);
    const result = sessions.keep(c.req.param("id"),c.req.param("turnId"),key,{speaker:oneOf(input.speaker,"speaker",["user","ai"]),
      text:evolveReplyText(input.text),parentId:evolveValue(input.parentId,"parentId")});
    if (!result.replayed) notify?.();
    return c.json({receipt:result.receipt},result.replayed ? 200 : 201);
  });
  app.get("/evolve-sessions/:id/turns/:turnId/saves/by-key/:key",c => {
    params(c,[]);
    const receipt = sessions.saveByKey(c.req.param("id"),c.req.param("turnId"),evolveKey(c.req.param("key")));
    if (!receipt) throw new EvolveNotFoundError();
    return c.json({receipt});
  });
  app.get("/evolve-sessions/:id/turns/by-key/:key",c => {
    params(c,[]);
    const result = sessions.byKey(evolveValue(c.req.param("id"),"session id"),evolveKey(c.req.param("key")));
    if (!result) throw new EvolveNotFoundError();
    return c.json(result);
  });
  return app;
}
