import { Hono } from "hono";
import { BranchConfirmationError, ForbiddenActorError, type Actor, type BranchPreview, type ReadScope, type RejectionService } from "../domain/rejection";
import { nonEmpty, nullableString, oneOf, record, references, ValidationError } from "../domain/validation";
import type { Context } from "hono";
import { CreationForbiddenError, CreationNotFoundError, type CreationService, type ThoughtInput } from "../domain/creation";
import { TitleConflictError, TitleForbiddenError, TitleNotFoundError, type TitleService } from "../domain/title";
import type { SearchService } from "../domain/search";
import { SimpleExportNotFoundError, type SimpleExportService } from "../domain/simple-export";
import { createLogger, type Logger } from "../logging";
import { AgentNotConfiguredError, type AgentService } from "../domain/agent";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError } from "../domain/run";
import { ImportConflictError, ImportForbiddenError, ImportNotFoundError, ImportPreservationError, type ImportInspectionRepository, type MarkdownImportRepository } from "../domain/markdown-import";
import { createMarkdownImportRoutes } from "./markdown-import-routes";
import { ImportHttpError } from "./import-body";
import { createMediaRoutes } from "./media-routes";
import { MediaImportError, type MediaImports } from "../domain/media-import";
import { createSearchSessionRoutes } from "./search-session-routes";
import { object, SearchHttpError, type SearchEnv } from "./search-http";
import { SearchConflictError, SearchForbiddenError, SearchNotFoundError, type SearchSessions } from "../domain/agentic-search";
import { parseSearchClockHeaders, type SearchClockReceipts } from "./search-clock-receipts";
import { ReinterpretationConflictError, type ReinterpretationService } from "../domain/reinterpretation";
import { createReinterpretationRoutes } from "./reinterpretation-routes";

export interface BoundaryEvent {
  readonly phase: "attempt" | "outcome";
  readonly method: string;
  readonly path: string;
  readonly status?: number;
}

export interface AppOptions {
  readonly rejection: RejectionService;
  readonly credentials: { readonly user: string; readonly ai: string };
  readonly logger: (event: BoundaryEvent) => void;
  readonly creation: CreationService;
  readonly titles: TitleService;
  readonly search?: SearchService;
  readonly searchSessions?: SearchSessions;
  readonly searchAgentsConfigured?: boolean;
  readonly notifySearchAdmission?: () => void;
  readonly searchClockReceipts?: SearchClockReceipts;
  readonly simpleExport?: SimpleExportService;
  readonly diagnostics?: Logger;
  readonly agents?: Pick<AgentService,"evolve" | "export" | "report" | "status" | "stop">;
  readonly imports?: { readonly commands: MarkdownImportRepository; readonly inspection: ImportInspectionRepository; readonly maxBytes: number };
  readonly media?: { readonly commands: MediaImports; readonly maxBytes: number; readonly notify: () => void };
  readonly reinterpretations?: {readonly commands:Pick<ReinterpretationService,"admit"|"byKey">;readonly notify:() => void};
}

type AppEnv = SearchEnv;
type ApiContext = Context<AppEnv>;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 503;

class ApiError extends Error {
  constructor(readonly status: ErrorStatus) { super(); }
}

function scope(c: ApiContext, allowed: readonly string[] = []): ReadScope {
  const params = new URL(c.req.url).searchParams;
  if ([...params.keys()].some(key => key !== "scope" && !allowed.includes(key))) throw new ApiError(400);
  const values = params.getAll("scope");
  if (values.length > 1) throw new ApiError(400);
  const mode = values[0] ?? "normal";
  if (mode !== "normal" && mode !== "history" && mode !== "show-rejected") throw new ApiError(400);
  const actor = c.get("actor");
  if (actor === "ai") {
    if (mode !== "normal") throw new ApiError(403);
    return { actor, mode: "normal" };
  }
  return { actor, mode };
}

function noQuery(c: ApiContext): void {
  if (new URL(c.req.url).searchParams.size) throw new ApiError(400);
}

async function body(c: ApiContext, allowed: readonly string[]): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await c.req.json(); } catch { throw new ApiError(400); }
  const data = record(value);
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new ApiError(400);
  return data;
}

function user(c: ApiContext): void {
  if (c.get("actor") !== "user") throw new ApiError(403);
}

function ai(c: ApiContext): void {
  if (c.get("actor") !== "ai") throw new ApiError(403);
}

function thoughtInput(data: Record<string, unknown>): ThoughtInput {
  return { text: nonEmpty(data.text, "text"), ...(data.title === undefined ? {} : { title: nullableString(data.title, "title") }) };
}

function safePath(path: string): string {
  const parts = path.split("/");
  if (path === "/search") return "/search";
  if (parts[1] === "search-sessions") return "/search-sessions" + (parts.length > 2 ? "/:id" : "");
  if (path === "/exports/simple") return "/exports/simple";
  if (path === "/exports/agentic") return "/exports/agentic";
  if (parts[1] === "imports" && parts[2] === "media") return "/imports/media" + (parts[3] === "by-key" ? "/by-key/:key" : "");
  if (parts[1] === "media-sources") return "/media-sources" + (parts.length > 2 ? "/:id" : "") + (["raw","retry"].includes(parts[3] ?? "") ? "/" + parts[3] : "");
  if (path === "/import-namespaces") return "/import-namespaces";
  if (parts[1] === "imports" && parts[2] === "markdown") return "/imports/markdown" + (parts.length > 3 ? "/:id" : "") + (parts[4] === "files" ? "/files" + (parts.length > 5 ? "/:fileId" : "") : parts[4] === "seal" ? "/seal" : "");
  if (parts[1] === "import-sources") return "/import-sources" + (parts.length > 2 ? "/:id" : "") + (["parts","raw"].includes(parts[3] ?? "") ? "/" + parts[3] : "");
  if (parts[1] === "thoughts" && parts.length === 4 && parts[3] === "import-source") return "/thoughts/:id/import-source";
  if (parts[1] === "thoughts" && parts[3] === "reinterpret") return "/thoughts/:id/reinterpret" + (parts[4] === "by-key" ? "/by-key/:key" : "");
  if (parts.length === 4 && parts[1] === "exports" && parts[2] === "agentic") return "/exports/agentic/:id";
  if (!["thoughts", "connections", "responses", "runs"].includes(parts[1] ?? "")) return "/other";
  return "/" + parts[1] + (parts.length > 2 ? "/:id" : "") +
    (parts[3] === "branch" ? "/branch" : "") +
    (["reject", "restore", "preview", "evolve", "stop", "children", "connections", "responses"].includes(parts.at(-1) ?? "") && parts.length > 3 ? "/" + parts.at(-1) : "");
}

/** Construct a server-side transport around scoped reads and validated commands. */
export function createApp(options: AppOptions): Hono<AppEnv> {
  const { rejection, creation, titles, credentials, logger } = options;
  const diagnostics = options.diagnostics ?? createLogger();
  if (!credentials.user.trim() || !credentials.ai.trim() || credentials.user === credentials.ai) {
    throw new Error("Invalid credentials configuration");
  }
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    const status: ErrorStatus = error instanceof ApiError || error instanceof ImportHttpError || error instanceof SearchHttpError ? error.status :
      error instanceof AgentNotConfiguredError ? 503 :
      error instanceof MediaImportError ? error.code === "invalid-media" ? 422 : 503 :
      error instanceof BranchConfirmationError || error instanceof TitleConflictError || error instanceof RunConflictError || error instanceof RunFenceError || error instanceof ImportConflictError || error instanceof SearchConflictError ? 409 :
      error instanceof ForbiddenActorError || error instanceof CreationForbiddenError || error instanceof TitleForbiddenError || error instanceof RunForbiddenError || error instanceof ImportForbiddenError || error instanceof SearchForbiddenError ? 403 :
      error instanceof CreationNotFoundError || error instanceof TitleNotFoundError || error instanceof SimpleExportNotFoundError || error instanceof RunNotFoundError || error instanceof ImportNotFoundError || error instanceof SearchNotFoundError ? 404 :
      error instanceof ImportPreservationError && error.message.startsWith("Unsupported source") ? 422 :
      error instanceof ValidationError ? 400 : 500;
    if (status === 500) diagnostics.error("[daemon] request failed", { method: c.req.method, path: safePath(new URL(c.req.url).pathname) });
    if (error instanceof ReinterpretationConflictError) return c.json({error:"Conflict",code:error.code,...error.snapshot},409);
    const mediaPath = safePath(new URL(c.req.url).pathname);
    if (mediaPath.startsWith("/imports/media") || mediaPath.startsWith("/media-sources")) {
      const code = error instanceof ImportHttpError ? error.code : error instanceof MediaImportError ? error.code === "invalid-media" ? "unsupported-source-content" : error.code :
        error instanceof RunConflictError && error.message === "Media idempotency conflict" ? "idempotency-conflict" :
        status === 409 ? "media-processing-conflict" : status === 400 ? "invalid-media-request" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "media-request-failed";
      return c.json({error:status === 400 ? "Bad request" : status === 403 ? "Forbidden" : status === 404 ? "Not found" : status === 409 ? "Conflict" :
        status === 413 ? "Payload too large" : status === 415 ? "Unsupported media type" : status === 422 ? "Unsupported source" : status === 503 ? "Service unavailable" : "Internal server error",code},status);
    }
    if (error instanceof ImportHttpError) return c.json({error:status===403 ? "Forbidden" : status===404 ? "Not found" : status===503 ? "Service unavailable" : "Bad request",code:error.code},status);
    if (error instanceof ImportConflictError) return c.json({error:"Conflict",code:error.message === "import-sealed" ? "import-sealed" : "idempotency-conflict"},status);
    if (error instanceof ImportPreservationError && status===422) return c.json({error:"Unsupported source",code:error.message === "Unsupported source content" ? "unsupported-source-content" : "unsupported-source-encoding"},status);
    const path=safePath(new URL(c.req.url).pathname);
    if (path.startsWith("/search-sessions")) {
      const code = error instanceof SearchHttpError ? error.code : error instanceof SearchConflictError ? error.code : error instanceof AgentNotConfiguredError ? "agents-not-configured" :
        status === 400 ? "invalid-search-request" : status === 403 ? "forbidden" : status === 404 ? "search-session-not-found" : "search-request-failed";
      return c.json({error: status === 400 ? "Bad request" : status === 403 ? "Forbidden" : status === 404 ? "Not found" : status === 409 ? "Conflict" : status === 413 ? "Payload too large" : status === 415 ? "Unsupported media type" : status === 503 ? "Agents are not configured" : "Internal server error",code},status);
    }
    if (path.startsWith("/runs/") && error instanceof SearchHttpError) return c.json({error:"Bad request",code:error.code},error.status);
    if ((path.startsWith("/imports/markdown") || path.startsWith("/import-sources") || path==="/import-namespaces" || path==="/thoughts/:id/import-source") && (status===400 || status===500)) return c.json({error:status===400 ? "Bad request" : "Internal server error",code:status===400 ? "invalid-import-request" : "import-admission-failed"},status);
    return c.json({ error: status === 500 ? "Internal server error" :
      ({ 400: "Bad request", 401: "Unauthorized", 403: "Forbidden", 404: "Not found", 409: "Conflict", 413: "Payload too large", 415:"Unsupported media type", 422:"Unsupported source", 503: "Agents are not configured; set THOUGHTLOOM_AGENT_CONFIG" } as const)[status] }, status);
  });

  app.use("*", async (c, next) => {
    const event = { method: c.req.method, path: safePath(new URL(c.req.url).pathname) };
    if (event.path.startsWith("/search-sessions") || event.path.startsWith("/runs/") || event.path.startsWith("/imports/markdown") || event.path.startsWith("/import-sources") || event.path.startsWith("/imports/media") || event.path.startsWith("/media-sources") || event.path.startsWith("/thoughts/:id/reinterpret") || event.path === "/import-namespaces" || event.path === "/thoughts/:id/import-source") c.header("cache-control","private, no-store");
    logger({ phase: "attempt", ...event });
    try {
      const auth = c.req.header("authorization");
      const actor = auth === `Bearer ${credentials.user}` ? "user" : auth === `Bearer ${credentials.ai}` ? "ai" : null;
      if (!actor) { c.res = c.json({ error: "Unauthorized" }, 401); return; }
      c.set("actor", actor);
      await next();
    } finally {
      logger({ phase: "outcome", ...event, status: c.res.status });
    }
  });

  if (options.imports) app.route("/",createMarkdownImportRoutes(options.imports.commands,options.imports.inspection,options.imports.maxBytes));
  if (options.media) app.route("/",createMediaRoutes(options.media.commands,options.media.maxBytes,options.media.notify));
  if (options.searchSessions) app.route("/",createSearchSessionRoutes(options.searchSessions,options.searchAgentsConfigured === true,options.notifySearchAdmission,options.searchClockReceipts));
  if (options.reinterpretations) app.route("/",createReinterpretationRoutes(options.reinterpretations.commands,options.reinterpretations.notify,diagnostics));

  if (options.search) {
    const search = options.search;
    app.get("/search", c => {
      const params = new URL(c.req.url).searchParams;
      const readScope = scope(c, ["q", "author", "kind", "from", "to", "sort"]);
      for (const key of ["q", "from", "to", "sort"]) if (params.getAll(key).length > 1) throw new ApiError(400);
      const q = nonEmpty(params.get("q"), "q");
      const authors = params.getAll("author").map(value => oneOf(value, "author", ["user", "ai", "source"]));
      const kinds = params.getAll("kind").map(value => oneOf(value, "kind", ["captured-original", "user-contribution", "ai-interpretation", "developing-idea", "imported-original", "media-original"]));
      const sortValue = params.get("sort");
      const sort = sortValue === null ? undefined : oneOf(sortValue, "sort", ["relevance", "newest", "oldest"]);
      return c.json(search.query(readScope, q, { authors, kinds, from: params.get("from") ?? undefined, to: params.get("to") ?? undefined, sort }));
    });
  }

  if (options.simpleExport) {
    const simpleExport = options.simpleExport;
    app.post("/exports/simple", async c => {
      user(c); noQuery(c);
      const data = await body(c, ["rootId", "count", "traversal"]);
      const rootId = nonEmpty(data.rootId, "rootId");
      if (typeof data.count !== "number" || !Number.isInteger(data.count) || data.count <= 0) throw new ApiError(400);
      const traversal = oneOf(data.traversal, "traversal", ["breadth", "depth"]);
      return c.body(simpleExport.render("user", { rootId, count: data.count, traversal }), 200, { "content-type": "text/markdown; charset=utf-8" });
    });
  }

  app.post("/exports/agentic", async c => {
    user(c); noQuery(c);
    const data = await body(c,["request","effort"]);
    if (!options.agents) throw new ApiError(503);
    const admission = options.agents.export(c.get("actor"),data);
    diagnostics.info("[agent] export admitted", { runId: admission.run.id });
    return c.json(admission,201);
  });
  app.get("/exports/agentic/:id", c => {
    user(c); noQuery(c);
    if (!options.agents) throw new ApiError(503);
    return c.body(options.agents.report(c.get("actor"),c.req.param("id")),200,{"content-type":"text/markdown; charset=utf-8"});
  });

  app.get("/thoughts", c => c.json(rejection.listThoughts(scope(c))));
  app.get("/thoughts/:id", c => {
    const item = rejection.listThoughts(scope(c)).find(t => t.id === c.req.param("id"));
    if (!item) throw new ApiError(404);
    return c.json(item);
  });
  for (const relation of ["children", "connections", "responses"] as const) {
    app.get(`/thoughts/:id/${relation}`, c => {
      const readScope = scope(c);
      const id = c.req.param("id");
      const items = relation === "children" ? rejection.listChildren(readScope, id) :
        relation === "connections" ? rejection.listThoughtConnections(readScope, id) : rejection.listThoughtResponses(readScope, id);
      if (!items) throw new ApiError(404);
      return c.json(items);
    });
  }
  app.get("/connections", c => c.json(rejection.listConnections(scope(c))));
  app.get("/connections/:id", c => {
    const item = rejection.listConnections(scope(c)).find(t => t.id === c.req.param("id"));
    if (!item) throw new ApiError(404);
    return c.json(item);
  });
  app.get("/responses/:id", c => {
    const item = rejection.getResponse(scope(c), c.req.param("id"));
    if (!item) throw new ApiError(404);
    return c.json(item);
  });

  app.post("/thoughts", async c => {
    user(c); noQuery(c);
    const thought = creation.capture("user", thoughtInput(await body(c, ["text", "title"])));
    diagnostics.info("[thought] capture succeeded", { thoughtId: thought.id });
    return c.json(thought, 201);
  });
  app.post("/thoughts/:id/evolve", async c => {
    user(c); noQuery(c);
    const data = await body(c,["text"]);
    const text = nonEmpty(data.text,"text");
    if (!options.agents) throw new ApiError(503);
    const admission = options.agents.evolve(c.get("actor"),c.req.param("id"),text);
    diagnostics.info("[agent] evolve admitted", { runId: admission.run.id });
    return c.json(admission,201);
  });
  app.get("/runs/:id", c => {
    user(c); noQuery(c);
    const searchRun = options.searchSessions?.searchRun("user",c.req.param("id"));
    if (searchRun) {
      const receipt = options.searchClockReceipts ? options.searchClockReceipts.parse(c.req.raw.headers) : parseSearchClockHeaders(c.req.raw.headers);
      if (options.searchClockReceipts && receipt) options.searchClockReceipts.record(options.searchClockReceipts.ownerRun(searchRun.id),receipt);
      return c.json(searchRun);
    }
    if (!options.agents) throw new ApiError(503);
    return c.json(options.agents.status(c.get("actor"),c.req.param("id")));
  });
  app.post("/runs/:id/stop", async c => {
    user(c); noQuery(c);
    if (options.searchSessions) {
      // Determine the scoped owner before invoking either mutation path.
      const searchRun = options.searchSessions.searchRun("user",c.req.param("id"));
      if (searchRun) {
        if (options.searchClockReceipts) options.searchClockReceipts.parse(c.req.raw.headers); else parseSearchClockHeaders(c.req.raw.headers);
        await object(c,[]);
        const stopped = options.searchSessions.stopSearchRun("user",c.req.param("id"));
        if (!stopped) throw new ApiError(404);
        options.searchClockReceipts?.forgetRun(searchRun.id);
        return c.json(stopped);
      }
    }
    await body(c,[]);
    if (!options.agents) throw new ApiError(503);
    const run = options.agents.stop(c.get("actor"),c.req.param("id"));
    diagnostics.info("[agent] stop requested", { runId: run.id });
    return c.json(run);
  });
  app.post("/thoughts/:id/contributions", async c => {
    user(c); noQuery(c);
    const thought = creation.contribute("user", c.req.param("id"), thoughtInput(await body(c, ["text", "title"])));
    diagnostics.info("[thought] contribution created", { thoughtId: thought.id });
    return c.json(thought, 201);
  });
  app.post("/thoughts/:id/developments", async c => {
    ai(c); noQuery(c);
    const data = await body(c, ["text", "title", "sourceIds"]);
    const thought = creation.develop("ai", c.req.param("id"), { ...thoughtInput(data),
      ...(data.sourceIds === undefined ? {} : { sourceIds: references(data.sourceIds, "sourceIds") }) });
    diagnostics.info("[thought] development created", { thoughtId: thought.id });
    return c.json(thought, 201);
  });
  app.post("/connections", async c => {
    noQuery(c);
    const data = await body(c, ["fromId", "toId", "category", "explanation", "sourceIds"]);
    const connection = creation.connect(c.get("actor"), { fromId: nonEmpty(data.fromId, "fromId"), toId: nonEmpty(data.toId, "toId"),
      category: oneOf(data.category, "category", ["supports", "contradicts", "extends", "related"]),
      explanation: nonEmpty(data.explanation, "explanation"),
      ...(data.sourceIds === undefined ? {} : { sourceIds: references(data.sourceIds, "sourceIds") }) });
    diagnostics.info("[connection] created", { connectionId: connection.id });
    return c.json(connection, 201);
  });

  app.put("/thoughts/:id/title", async c => {
    user(c); noQuery(c);
    const data = await body(c, ["title"]);
    const state = titles.setUser("user", c.req.param("id"), nullableString(data.title, "title"));
    diagnostics.info("[thought] title changed", { thoughtId: c.req.param("id"), cleared: state.title === null });
    const thought = rejection.listThoughts({ actor: "user", mode: "history" }).find(item => item.id === c.req.param("id"));
    if (!thought) throw new ApiError(404);
    const { rejected: _rejected, ...canonical } = thought;
    return c.json({ ...canonical, ...state });
  });
  app.post("/thoughts/:id/title/fill", async c => {
    ai(c); noQuery(c);
    const data = await body(c, ["title"]);
    const state = titles.fillAi("ai", c.req.param("id"), nonEmpty(data.title, "title"));
    diagnostics.info("[thought] title filled", { thoughtId: c.req.param("id") });
    const thought = rejection.listThoughts({ actor: "ai", mode: "normal" }).find(item => item.id === c.req.param("id"));
    if (!thought) throw new ApiError(404);
    return c.json({ ...thought, ...state });
  });

  app.get("/thoughts/:id/branch/preview", c => {
    user(c); noQuery(c);
    try { return c.json(rejection.previewBranch("user", c.req.param("id"))); }
    catch (error) { if (error instanceof ValidationError) throw new ApiError(404); throw error; }
  });
  app.post("/thoughts/:id/branch/reject", async c => {
    user(c); noQuery(c);
    const data = await body(c, ["rootId", "branchIds", "affectedIds", "count"]);
    if (data.rootId !== c.req.param("id")) throw new ApiError(409);
    if (typeof data.rootId !== "string" || !Array.isArray(data.branchIds) || !data.branchIds.every((id: unknown) => typeof id === "string") ||
        !Array.isArray(data.affectedIds) || !data.affectedIds.every((id: unknown) => typeof id === "string") || typeof data.count !== "number") throw new ApiError(409);
    const confirmation: BranchPreview = { rootId: data.rootId, branchIds: data.branchIds, affectedIds: data.affectedIds, count: data.count };
    rejection.rejectBranch("user", confirmation);
    diagnostics.info("[thought] branch rejected", { thoughtId: c.req.param("id") });
    return c.body(null, 204);
  });
  app.post("/thoughts/:id/branch/restore", c => {
    user(c); noQuery(c);
    try { rejection.restoreBranch("user", c.req.param("id")); }
    catch (error) { if (error instanceof ValidationError) throw new ApiError(404); throw error; }
    diagnostics.info("[thought] branch restored", { thoughtId: c.req.param("id") });
    return c.body(null, 204);
  });
  for (const kind of ["thoughts", "connections"] as const) {
    for (const action of ["reject", "restore"] as const) {
      app.post(`/${kind}/:id/${action}`, c => {
        user(c); noQuery(c);
        const id = c.req.param("id");
        try {
          if (kind === "thoughts") {
            if (action === "reject") rejection.rejectThought("user", id); else rejection.restoreThought("user", id);
          } else {
            if (action === "reject") rejection.rejectConnection("user", id); else rejection.restoreConnection("user", id);
          }
        } catch (error) { if (error instanceof ValidationError) throw new ApiError(404); throw error; }
        diagnostics.info("[rejection] state changed", { kind, action, id });
        return c.body(null, 204);
      });
    }
  }
  return app;
}
