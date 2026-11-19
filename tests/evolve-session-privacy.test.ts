import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createEvolveSessionRoutes } from "../src/daemon/evolve-session-routes";
import { SearchHttpError, type SearchEnv } from "../src/daemon/search-http";
import type { EvolveSessions } from "../src/domain/evolve-sessions";

test("matched session handlers and their authorization errors are private without relying on a parent pathname classifier", async () => {
  const session = { id:"session", anchorThoughtId:"anchor", continuationThoughtId:"anchor", mode:"ideas-only" as const, createdAt:"2030-01-01T00:00:00.000Z" };
  const turn = { id:"turn", parentId:"anchor", text:"test-owned text", status:"pending" as const, admittedAt:"2030-01-01T00:00:00.000Z", runId:null, reply:null, saves:[] };
  const receipt = { sessionId:session.id, turnId:turn.id, admittedAt:turn.admittedAt };
  const save = { thoughtId:"thought", speaker:"user" as const, selectedBy:"user" as const, source:"passage" as const,
    text:turn.text, parentId:"anchor", start:0 };
  const sessions: EvolveSessions = {
    create: () => session,
    read: () => ({ session, turns:[turn] }),
    admit: () => ({ receipt, turn, run:null, replayed:false }),
    byKey: () => ({ receipt, turn, run:null }),
    keep: () => ({ receipt:save, replayed:false }),
    saveByKey: () => save,
    continueAt: () => session,
  };
  const app = new Hono<SearchEnv>();
  app.onError((error,c) => c.json({error:"request failed"}, error instanceof SearchHttpError ? error.status : 500));
  app.use("*",async (c,next) => { c.set("actor",c.req.header("x-test-actor") === "ai" ? "ai" : "user"); await next(); });
  app.route("/",createEvolveSessionRoutes(sessions));
  const cases: { path: string; init: RequestInit; status: number }[] = [
    { path:"/evolve-sessions", init:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({anchorThoughtId:"anchor"})}, status:201 },
    { path:"/evolve-sessions/session", init:{}, status:200 },
    { path:"/evolve-sessions/session/turns", init:{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"owned-key"},body:JSON.stringify({parentId:"anchor",text:"test-owned text"})}, status:201 },
    { path:"/evolve-sessions/session/turns/by-key/owned-key", init:{}, status:200 },
    { path:"/evolve-sessions/session/continuation", init:{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({thoughtId:"anchor"})}, status:200 },
    { path:"/evolve-sessions/session/turns/turn/saves", init:{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"save"},body:JSON.stringify({speaker:"user",text:turn.text,parentId:"anchor"})}, status:201 },
    { path:"/evolve-sessions/session/turns/turn/saves/by-key/save", init:{}, status:200 },
    { path:"/evolve-sessions/session", init:{headers:{"x-test-actor":"ai"}}, status:403 },
  ];
  for (const item of cases) {
    const response = await app.request(item.path,item.init);
    expect(response.status).toBe(item.status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});
