import { Hono } from "hono";
import { createThought, type Thought } from "../domain/thought";
import { createConnection, type Connection } from "../domain/connection";
import { BranchConfirmationError, ForbiddenActorError, type Actor, type BranchPreview, type ReadScope, type RejectionService } from "../domain/rejection";
import { record, ValidationError } from "../domain/validation";
import type { Context } from "hono";

/** Writes receive validated domain values; reference checks remain an API precondition. */
export interface CreationPort {
  createThought(thought: Thought): void;
  createConnection(connection: Connection): void;
}

export interface BoundaryEvent {
  readonly phase: "attempt" | "outcome";
  readonly method: string;
  readonly path: string;
  readonly status?: number;
}

export interface AppOptions {
  readonly rejection: RejectionService;
  readonly writes: CreationPort;
  readonly credentials: { readonly user: string; readonly ai: string };
  readonly logger: (event: BoundaryEvent) => void;
}

type AppEnv = { Variables: { actor: Actor } };
type ApiContext = Context<AppEnv>;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

class ApiError extends Error {
  constructor(readonly status: ErrorStatus) { super(); }
}

function scope(c: ApiContext): ReadScope {
  const params = new URL(c.req.url).searchParams;
  if ([...params.keys()].some(key => key !== "scope")) throw new ApiError(400);
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

function safePath(path: string): string {
  const parts = path.split("/");
  if (!["thoughts", "connections", "responses"].includes(parts[1] ?? "")) return "/other";
  return "/" + parts[1] + (parts.length > 2 ? "/:id" : "") +
    (parts[3] === "branch" ? "/branch" : "") +
    (["reject", "restore", "preview"].includes(parts.at(-1) ?? "") && parts.length > 3 ? "/" + parts.at(-1) : "");
}

/** Construct a server-side transport around scoped reads and validated commands. */
export function createApp(options: AppOptions): Hono<AppEnv> {
  const { rejection, writes, credentials, logger } = options;
  if (!credentials.user.trim() || !credentials.ai.trim() || credentials.user === credentials.ai) {
    throw new Error("Invalid credentials configuration");
  }
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    const status: ErrorStatus = error instanceof ApiError ? error.status :
      error instanceof BranchConfirmationError ? 409 :
      error instanceof ForbiddenActorError ? 403 :
      error instanceof ValidationError ? 400 : 500;
    return c.json({ error: status === 500 ? "Internal server error" :
      ({ 400: "Bad request", 401: "Unauthorized", 403: "Forbidden", 404: "Not found", 409: "Conflict" } as const)[status] }, status);
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
    noQuery(c);
    const data = await body(c, ["id", "text", "title", "kind", "createdAt", "origin", "parentId", "sourceIds"]);
    const actor = c.get("actor");
    const thought = createThought({ ...data, author: actor });
    const visible = rejection.listThoughts({ actor, mode: "normal" });
    const ids = new Set(visible.map(item => item.id));
    if ((thought.parentId !== null && !ids.has(thought.parentId)) || thought.sourceIds.some(id => !ids.has(id))) throw new ApiError(404);
    const existing = actor === "user" ? rejection.listThoughts({ actor, mode: "history" }) : visible;
    if (existing.some(item => item.id === thought.id)) throw new ApiError(409);
    writes.createThought(thought);
    return c.json(thought, 201);
  });
  app.post("/connections", async c => {
    noQuery(c);
    const data = await body(c, ["id", "fromId", "toId", "category", "explanation", "sourceIds"]);
    const actor = c.get("actor");
    const connection = createConnection({ ...data, proposedBy: actor });
    const ids = new Set(rejection.listThoughts({ actor, mode: "normal" }).map(item => item.id));
    if (![connection.fromId, connection.toId, ...connection.sourceIds].every(id => ids.has(id))) throw new ApiError(404);
    const existing = actor === "user" ? rejection.listConnections({ actor, mode: "history" }) : rejection.listConnections({ actor, mode: "normal" });
    if (existing.some(item => item.id === connection.id)) throw new ApiError(409);
    writes.createConnection(connection);
    return c.json(connection, 201);
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
