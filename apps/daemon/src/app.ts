import { Hono } from "hono";
import { isIdempotencyKey, isLocalRequest, isRecordId, parseCaptureInput, type FollowUpLimits } from "@thoughtloom/contracts";
import { readInquiry } from "./inquiry";
import { findSource, saveCapture, searchSources } from "./storage";
import type { SearchLimits } from "./storage";
import { createToolApp } from "./tool-boundary";
import { createWeavingHttpApp, type WeavingHttpOptions } from "./weaving-http";
import { createDialogueApp } from "./dialogue-http";
import { createKnowledgeHttpApp } from "./knowledge-http";
import { createFollowUpHttpApp } from "./follow-up-http";

export function createApp(options: WeavingHttpOptions & { searchLimits?: Partial<SearchLimits>; followUpLimits?: Partial<FollowUpLimits>; tools?: { transportCredential: string; location: string } }) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    if (!isLocalRequest(context.req.raw)) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    await next();
  });
  if (options.tools) app.route("/", createToolApp({ databasePath: options.databasePath, ...options.tools }));
  else app.all("/internal/tools/*", (context) => context.json({ error: "Unauthorized" }, 401));
  app.route("/", createWeavingHttpApp(options));
  app.route("/", createFollowUpHttpApp(options));
  app.route("/", createDialogueApp({ databasePath: options.databasePath, weavingWorker: options.weavingWorker }));
  app.route("/", createKnowledgeHttpApp({ databasePath: options.databasePath }));

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

  app.get("/search", (context) => {
    const query = context.req.query("q") ?? "";
    if (query.length > 512 || (query.match(/[\p{L}\p{N}\p{M}]+/gu)?.length ?? 0) > 16) {
      return context.json({ error: "Search query is too long" }, 400);
    }
    console.info("source.search attempt");
    try {
      const results = searchSources(options.databasePath, query, options.searchLimits);
      console.info("source.search completed", { count: results.length });
      return context.json({ results }, 200);
    } catch {
      console.error("source.search failed", { category: "storage_error" });
      return context.json({ error: "Search unavailable" }, 500);
    }
  });

  app.get("/sources/:id/inquiry", (context) => {
    const id = context.req.param("id");
    if (!isRecordId(id)) return context.json({ error: "Source not found" }, 404);
    try {
      const view = readInquiry(options.databasePath, id);
      return view ? context.json(view, 200) : context.json({ error: "Source not found" }, 404);
    } catch {
      return context.json({ error: "Inquiry could not be read" }, 503);
    }
  });

  return app;
}
