import { Hono } from "hono";
import { isIdempotencyKey, isLocalRequest, isRecordId, parseCaptureInput, parseSearchParameters, SPRINGBOARD_RECENT_MAX, SPRINGBOARD_RANDOM_MAX, type FollowUpLimits } from "@thoughtloom/contracts";
import { readInquiry } from "./inquiry";
import { findSource, saveCapture } from "./storage";
import { createSearchService } from "./search";
import { FuzzySearchError } from "./fuzzy-retrieval";
import type { FuzzyReadPolicy } from "./fuzzy-search-work";
import { createToolApp } from "./tool-boundary";
import { createWeavingHttpApp, type WeavingHttpOptions } from "./weaving-http";
import { createDialogueApp } from "./dialogue-http";
import { createKnowledgeHttpApp } from "./knowledge-http";
import { createFollowUpHttpApp } from "./follow-up-http";
import { readRecentThoughts, readSpringboard } from "./springboard";
import { createTitleHttpApp } from "./title-http";

export function createApp(options: WeavingHttpOptions & { searchPolicy?: FuzzyReadPolicy; followUpLimits?: Partial<FollowUpLimits>; tools?: { transportCredential: string; location: string } }) {
  const app = new Hono();
  const search = createSearchService({ databasePath: options.databasePath, policy: options.searchPolicy });
  app.use("*", async (context, next) => {
    if (!isLocalRequest(context.req.raw)) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    await next();
  });
  if (options.tools) app.route("/", createToolApp({ databasePath: options.databasePath, ...options.tools, search }));
  else app.all("/internal/tools/*", (context) => context.json({ error: "Unauthorized" }, 401));
  app.route("/", createWeavingHttpApp(options));
  app.route("/", createFollowUpHttpApp(options));
  app.route("/", createDialogueApp({ databasePath: options.databasePath, weavingWorker: options.weavingWorker }));
  app.route("/", createKnowledgeHttpApp({ databasePath: options.databasePath }));
  app.route("/", createTitleHttpApp(options.databasePath));

  app.post("/captures", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "Invalid JSON" }, 400);
    }
    const input = parseCaptureInput(body);
    if (!input) return context.json({ error: "Invalid capture" }, 400);
    const key = context.req.header("idempotency-key");
    if (!isIdempotencyKey(key)) {
      return context.json({ error: "Invalid Idempotency-Key" }, 400);
    }

    console.info("capture.save attempt");
    try {
      const result = saveCapture(options.databasePath, key, input);
      if (result.kind === "conflict") {
        console.info("capture.save conflict");
        return context.json({ error: "Idempotency-Key already used with different capture" }, 409);
      }
      console.info("capture.save succeeded", { sourceId: result.source.id, result: result.kind });
      return result.kind === "created"
        ? context.json(result.source, 201)
        : context.json(result.source, 200);
    } catch {
      console.error("capture.save failed", { category: "storage_error" });
      return context.json({ error: "Capture could not be saved" }, 500);
    }
  });

  app.get("/sources/:id", (context) => {
    const id = context.req.param("id");
    console.info("source.read attempt");
    try {
      const source = findSource(options.databasePath, id);
      console.info("source.read completed", { found: source !== null });
      return source ? context.json(source, 200) : context.json({ error: "Source not found" }, 404);
    } catch {
      console.error("source.read failed", { category: "storage_error" });
      return context.json({ error: "Source could not be read" }, 500);
    }
  });

  app.get("/search", async (context) => {
    context.header("cache-control", "no-store");
    const input = parseSearchParameters(new URL(context.req.url).searchParams);
    if (!input) return context.json({ error: "invalid_input" }, 400);
    try {
      return context.json(await search.search(input, context.req.raw.signal), 200);
    } catch (error) {
      const code = error instanceof FuzzySearchError ? error.code : "unavailable";
      return context.json({ error: code === "invalid" ? "invalid_input" : code }, code === "invalid" ? 400 : 503);
    }
  });

  app.get("/springboard/recent", (context) => {
    const values = new URL(context.req.url).searchParams.getAll("limit");
    if (values.length > 1 || (values.length === 1 && !/^[1-9]\d*$/.test(values[0]))) return context.json({ error: "Invalid recent limit" }, 400);
    const limit = values.length ? Number(values[0]) : 2;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SPRINGBOARD_RECENT_MAX) return context.json({ error: "Invalid recent limit" }, 400);
    console.info("springboard.recent attempt", { limit });
    try { const view = readRecentThoughts(options.databasePath, limit); console.info("springboard.recent completed", { count: view.items.length }); return context.json(view, 200); }
    catch { console.error("springboard.recent failed", { category: "read_model_unavailable" }); return context.json({ error: "Recent thoughts unavailable" }, 503); }
  });

  app.get("/springboard", (context) => {
    const params = new URL(context.req.url).searchParams;
    const limit = (name: string, maximum: number): number | null => {
      const values = params.getAll(name);
      if (values.length > 1 || (values.length === 1 && !/^[1-9]\d*$/.test(values[0]))) return null;
      const value = values.length ? Number(values[0]) : 2;
      return Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : null;
    };
    const recent = limit("recent", SPRINGBOARD_RECENT_MAX), random = limit("random", SPRINGBOARD_RANDOM_MAX);
    if (recent === null || random === null) return context.json({ error: "Invalid springboard limit" }, 400);
    console.info("springboard.read attempt", { recent, random });
    try { const view = readSpringboard(options.databasePath, recent, random); console.info("springboard.read completed", { count: view.items.length }); return context.json(view, 200); }
    catch { console.error("springboard.read failed", { category: "read_model_unavailable" }); return context.json({ error: "Thoughts unavailable" }, 503); }
  });

  app.get("/sources/:id/inquiry", (context) => {
    const id = context.req.param("id");
    if (!isRecordId(id)) return context.json({ error: "Source not found" }, 404);
    const params = new URL(context.req.url).searchParams, itemIds = params.getAll("itemId"), versionIds = params.getAll("versionId");
    if (itemIds.length > 1 || versionIds.length > 1 || itemIds.length !== versionIds.length ||
        (itemIds.length === 1 && (!isRecordId(itemIds[0]) || !isRecordId(versionIds[0])))) return context.json({ error: "Invalid selected target" }, 400);
    try {
      const view = readInquiry(options.databasePath, id, itemIds.length ? { itemId: itemIds[0], versionId: versionIds[0] } : undefined);
      return view ? context.json(view, 200) : context.json({ error: "Source not found" }, 404);
    } catch {
      return context.json({ error: "Inquiry could not be read" }, 503);
    }
  });

  return app;
}
