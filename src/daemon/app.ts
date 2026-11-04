import { Hono } from "hono";
import { BranchConfirmationError, ForbiddenActorError, type Actor, type BranchPreview, type ReadScope, type RejectionService } from "../domain/rejection";
import { nonEmpty, nullableString, oneOf, record, references, ValidationError } from "../domain/validation";
import type { Context } from "hono";
import { CreationForbiddenError, CreationNotFoundError, type CreationService, type ThoughtInput } from "../domain/creation";
import { TitleConflictError, TitleForbiddenError, TitleNotFoundError, type TitleService } from "../domain/title";
import type { SearchService } from "../domain/search";
import { SimpleExportNotFoundError, type SimpleExportService } from "../domain/simple-export";
import { AgentNotConfiguredError, type AgentService } from "../domain/agent";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError } from "../domain/run";

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
  readonly simpleExport?: SimpleExportService;
  readonly agents?: Pick<AgentService,"evolve" | "export" | "report" | "status" | "stop">;
}

type AppEnv = { Variables: { actor: Actor } };
type ApiContext = Context<AppEnv>;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 503;

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
  if (path === "/exports/simple") return "/exports/simple";
  if (path === "/exports/agentic") return "/exports/agentic";
  if (parts.length === 4 && parts[1] === "exports" && parts[2] === "agentic") return "/exports/agentic/:id";
  if (!["thoughts", "connections", "responses", "runs"].includes(parts[1] ?? "")) return "/other";
  return "/" + parts[1] + (parts.length > 2 ? "/:id" : "") +
    (parts[3] === "branch" ? "/branch" : "") +
    (["reject", "restore", "preview", "evolve", "stop"].includes(parts.at(-1) ?? "") && parts.length > 3 ? "/" + parts.at(-1) : "");
}

/** Construct a server-side transport around scoped reads and validated commands. */
export function createApp(options: AppOptions): Hono<AppEnv> {
  const { rejection, creation, titles, credentials, logger } = options;
  if (!credentials.user.trim() || !credentials.ai.trim() || credentials.user === credentials.ai) {
    throw new Error("Invalid credentials configuration");
  }
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    const status: ErrorStatus = error instanceof ApiError ? error.status :
      error instanceof AgentNotConfiguredError ? 503 :
      error instanceof BranchConfirmationError || error instanceof TitleConflictError || error instanceof RunConflictError || error instanceof RunFenceError ? 409 :
      error instanceof ForbiddenActorError || error instanceof CreationForbiddenError || error instanceof TitleForbiddenError || error instanceof RunForbiddenError ? 403 :
      error instanceof CreationNotFoundError || error instanceof TitleNotFoundError || error instanceof SimpleExportNotFoundError || error instanceof RunNotFoundError ? 404 :
      error instanceof ValidationError ? 400 : 500;
    return c.json({ error: status === 500 ? "Internal server error" :
      ({ 400: "Bad request", 401: "Unauthorized", 403: "Forbidden", 404: "Not found", 409: "Conflict", 503: "Agents are not configured; set THOUGHTLOOM_AGENT_CONFIG" } as const)[status] }, status);
  });
  app.use("*", async (c, next) => {
    const event = { method: c.req.method, path: safePath(new URL(c.req.url).pathname) };
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

  if (options.search) {
    const search = options.search;
    app.get("/search", c => {
      const params = new URL(c.req.url).searchParams;
      const readScope = scope(c, ["q", "author", "kind", "from", "to", "sort"]);
      for (const key of ["q", "from", "to", "sort"]) if (params.getAll(key).length > 1) throw new ApiError(400);
      const q = nonEmpty(params.get("q"), "q");
      const authors = params.getAll("author").map(value => oneOf(value, "author", ["user", "ai"]));
      const kinds = params.getAll("kind").map(value => oneOf(value, "kind", ["captured-original", "user-contribution", "ai-interpretation", "developing-idea"]));
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
    return c.json(options.agents.export(c.get("actor"),data),201);
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
    return c.json(creation.capture("user", thoughtInput(await body(c, ["text", "title"]))), 201);
  });
  app.post("/thoughts/:id/evolve", async c => {
    user(c); noQuery(c);
    const data = await body(c,["text"]);
    const text = nonEmpty(data.text,"text");
    if (!options.agents) throw new ApiError(503);
    return c.json(options.agents.evolve(c.get("actor"),c.req.param("id"),text),201);
  });
  app.get("/runs/:id", c => {
    user(c); noQuery(c);
    if (!options.agents) throw new ApiError(503);
    return c.json(options.agents.status(c.get("actor"),c.req.param("id")));
  });
  app.post("/runs/:id/stop", async c => {
    user(c); noQuery(c);
    await body(c,[]);
    if (!options.agents) throw new ApiError(503);
    return c.json(options.agents.stop(c.get("actor"),c.req.param("id")));
  });
  app.post("/thoughts/:id/contributions", async c => {
    user(c); noQuery(c);
    return c.json(creation.contribute("user", c.req.param("id"), thoughtInput(await body(c, ["text", "title"]))), 201);
  });
  app.post("/thoughts/:id/developments", async c => {
    ai(c); noQuery(c);
    const data = await body(c, ["text", "title", "sourceIds"]);
    return c.json(creation.develop("ai", c.req.param("id"), { ...thoughtInput(data),
      ...(data.sourceIds === undefined ? {} : { sourceIds: references(data.sourceIds, "sourceIds") }) }), 201);
  });
  app.post("/connections", async c => {
    noQuery(c);
    const data = await body(c, ["fromId", "toId", "category", "explanation", "sourceIds"]);
    return c.json(creation.connect(c.get("actor"), { fromId: nonEmpty(data.fromId, "fromId"), toId: nonEmpty(data.toId, "toId"),
      category: oneOf(data.category, "category", ["supports", "contradicts", "extends", "related"]),
      explanation: nonEmpty(data.explanation, "explanation"),
      ...(data.sourceIds === undefined ? {} : { sourceIds: references(data.sourceIds, "sourceIds") }) }), 201);
  });

  app.put("/thoughts/:id/title", async c => {
    user(c); noQuery(c);
    const data = await body(c, ["title"]);
    const state = titles.setUser("user", c.req.param("id"), nullableString(data.title, "title"));
    const thought = rejection.listThoughts({ actor: "user", mode: "history" }).find(item => item.id === c.req.param("id"));
    if (!thought) throw new ApiError(404);
    return c.json({ ...thought, ...state });
  });
  app.post("/thoughts/:id/title/fill", async c => {
    ai(c); noQuery(c);
    const data = await body(c, ["title"]);
    const state = titles.fillAi("ai", c.req.param("id"), nonEmpty(data.title, "title"));
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
    return c.body(null, 204);
  });
  app.post("/thoughts/:id/branch/restore", c => {
    user(c); noQuery(c);
    try { rejection.restoreBranch("user", c.req.param("id")); }
    catch (error) { if (error instanceof ValidationError) throw new ApiError(404); throw error; }
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
        return c.body(null, 204);
      });
    }
  }
  return app;
}
