import { expect, test } from "bun:test";
import { readWebConfig } from "../apps/web/src/server/config";
import { createSearchWorkspaceBoundary } from "../apps/web/src/server/search-workspace";
import { createLogger } from "../src/logging";
import { ownedMedia } from "./fixtures/web-media";

test("saved-search discovery and preview accept scoped media descriptor without binary access", async () => {
  const summary = {id:ownedMedia.id,title:ownedMedia.mediaSource.name,titleAuthor:null,author:"source",kind:"media-original",createdAt:ownedMedia.createdAt};
  const entry = {id:"discovery-1",position:0,addedAt:ownedMedia.createdAt,removedAt:null,thought:summary,why:"Relevant owned clarification",
    evidenceThoughtIds:[ownedMedia.id],availability:"available",reasonStatus:"available"};
  const normal = {items:[entry],nextCursor:null,sessionRevision:2,eligibilityRevision:1,composerId:"composer-1",contextToken:"owned-context"};
  const history = {items:[entry],nextCursor:null};
  const preview = {thought:ownedMedia,sessionRevision:2,eligibilityRevision:1,composerId:"composer-1",contextToken:"owned-context"};
  const calls: string[] = [];
  let badPreview = false;
  const fetcher = (async (input: RequestInfo | URL,init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(`${init?.method} ${url.pathname}${url.search}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owned-workspace-token");
    if (url.pathname.endsWith("/discoveries")) return Response.json(url.searchParams.get("scope") === "history" ? history : normal);
    return Response.json(badPreview ? {...preview,thought:{...ownedMedia,mediaSource:{...ownedMedia.mediaSource,path:"/private/sentinel"}}} : preview);
  }) as typeof fetch;
  const handle = createSearchWorkspaceBoundary({config:readWebConfig({THOUGHTLOOM_USER_TOKEN:"owned-workspace-token"}),
    fetch:fetcher,logger:createLogger("verbose",() => {}),timeoutMs:1000});
  const base = "/api/search-sessions/session-1", headers = {host:"127.0.0.1:3000"};
  const request = (suffix: string) => new Request(`http://127.0.0.1:3000${base}${suffix}`,{headers});
  const discovered = await handle(request("/discoveries?composerId=composer-1"));
  expect(discovered.status).toBe(200); expect(await discovered.json()).toEqual(normal);
  const historical = await handle(request("/discoveries?scope=history"));
  expect(historical.status).toBe(200); expect(await historical.json()).toEqual(history);
  const source = await handle(request(`/composer-contexts/composer-1/thoughts/${ownedMedia.id}`));
  expect(source.status).toBe(200); expect(await source.json()).toEqual(preview);
  expect(calls).toEqual(["GET /search-sessions/session-1/discoveries?composerId=composer-1",
    "GET /search-sessions/session-1/discoveries?scope=history",`GET /search-sessions/session-1/composer-contexts/composer-1/thoughts/${ownedMedia.id}`]);
  badPreview = true;
  const invalid = await handle(request(`/composer-contexts/composer-1/thoughts/${ownedMedia.id}`));
  expect(invalid.status).toBe(502); expect(await invalid.text()).not.toContain("/private/sentinel");
});
