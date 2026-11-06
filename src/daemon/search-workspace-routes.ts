import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { searchHistoryQueries, type SearchHistoryCursor, type SearchSessions } from "../domain/agentic-search";
import { bad, bytes, object, params, type SearchEnv } from "./search-http";

type Collection = "messages" | "discoveries";

/** History continuations never become normal-workspace cursors or caller-selected SQL positions. */
function historyCursors() {
  const secret = randomBytes(32), sign = (value: string) => createHmac("sha256",secret).update(value).digest();
  return {
    encode(cursor: SearchHistoryCursor | null): string | null {
      if (!cursor) return null;
      const value = Buffer.from(JSON.stringify({version:1,cursor})).toString("base64url");
      return `${value}.${sign(value).toString("base64url")}`;
    },
    decode(token: string, kind: Collection, sessionId: string, limit: number | undefined): SearchHistoryCursor {
      if (token.length > 2048) return bad();
      const parts = token.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return bad();
      const supplied = Buffer.from(parts[1],"base64url"), expected = sign(parts[0]);
      if (supplied.toString("base64url") !== parts[1] || supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) return bad();
      try {
        const data: unknown = JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)) return bad();
        const payload = data as Record<string,unknown>;
        if (payload.version !== 1 || Object.keys(payload).length !== 2 || !Object.hasOwn(payload,"cursor")) return bad();
        const query = searchHistoryQueries(sessionId,{[kind]:{cursor:payload.cursor,...(limit === undefined ? {} : {limit})}})[kind];
        return query.cursor ?? bad();
      } catch { return bad(); }
    },
  };
}

export function createSearchWorkspaceRoutes(sessions: SearchSessions): Hono<SearchEnv> {
  const app = new Hono<SearchEnv>(), cursors = historyCursors(), base = "/search-sessions/:id";
  app.post(`${base}/composer-contexts`,async c => {
    params(c,[]); await object(c,[]);
    return c.json(sessions.openComposer("user",c.req.param("id")),201);
  });
  app.get(`${base}/composer-contexts/:composerId`,c => {
    params(c,[]); return c.json(sessions.refreshComposer("user",c.req.param("id"),c.req.param("composerId")));
  });
  app.delete(`${base}/composer-contexts/:composerId`,async c => {
    params(c,[]); if ((await bytes(c.req.raw,4096)).length) return bad();
    sessions.discardComposer("user",c.req.param("id"),c.req.param("composerId")); return c.body(null,204);
  });
  app.get(`${base}/composer-contexts/:composerId/thoughts/:thoughtId`,c => {
    params(c,[]); return c.json(sessions.previewThought("user",c.req.param("id"),c.req.param("composerId"),c.req.param("thoughtId")));
  });
  for (const kind of ["messages","discoveries"] as const) app.get(`${base}/${kind}`,c => {
    const p = params(c,["scope","composerId","limit","cursor"]), scope = p.get("scope") ?? "normal";
    const composerId = p.get("composerId"), raw = p.get("limit"), token = p.get("cursor"), sessionId = c.req.param("id");
    if (scope !== "normal" && scope !== "history") return bad();
    if (raw !== null && !/^[1-9]\d*$/.test(raw)) return bad();
    const limit = raw === null ? undefined : Number(raw);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit > 200)) return bad();
    if (scope === "normal") {
      if (!composerId || (token !== null && (!token || token.length > 16384))) return bad();
      return c.json(sessions[kind]("user",sessionId,{composerId,...(limit === undefined ? {} : {limit}),...(token === null ? {} : {cursor:token})}));
    }
    if (composerId !== null) return bad();
    const cursor = token === null ? undefined : cursors.decode(token,kind,sessionId,limit);
    const page = sessions.history("user",sessionId,{[kind]:{...(limit === undefined ? {} : {limit}),...(cursor === undefined ? {} : {cursor})}})[kind];
    return c.json({items:page.items,nextCursor:cursors.encode(page.nextCursor)});
  });
  app.delete(`${base}/discoveries/:entryId`,async c => {
    params(c,[]); if ((await bytes(c.req.raw,4096)).length) return bad();
    const revision = sessions.removeDiscoveryWithRevision("user",c.req.param("id"),c.req.param("entryId"));
    c.header("Search-Session-Revision",String(revision)); return c.body(null,204);
  });
  return app;
}
