import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isIdempotencyKey, isRecordId, parseFollowUpRetryInput, parseWeavingWorkerView, type FollowUpLimits } from "@thoughtloom/contracts";
import { WeavingError, WeavingWorker } from "./weaving";
import type { WeavingHttpOptions } from "./weaving-http";

export function createFollowUpHttpApp(options: WeavingHttpOptions & { followUpLimits?: Partial<FollowUpLimits> }) {
  const app = new Hono(), worker = options.weavingWorker ?? new WeavingWorker({ databasePath: options.databasePath, adapter: null });
  function availability() {
    const configured = options.weavingConfigured === true && worker.configured;
    const view = parseWeavingWorkerView({ configured, state: configured ? options.weavingStatus?.() ?? "unavailable" : "unavailable" });
    if (!view) throw new WeavingError("invalid_configuration");
    return view;
  }
  app.onError((error, context) => {
    console.error("follow_up.http failed", { category: error instanceof WeavingError ? error.code : "storage_error" });
    context.header("cache-control", "no-store");
    return context.json({ error: "follow_up_unavailable" }, 503);
  });
  app.get("/sources/:id/follow-ups", (context) => {
    context.header("cache-control", "no-store");
    const sourceId = context.req.param("id");
    if (!isRecordId(sourceId)) return context.json({ error: "Source not found" }, 404);
    console.info("follow_up.http read attempt", { sourceId });
    const view = worker.readFollowUps(sourceId, availability(), options.followUpLimits);
    console.info("follow_up.http read outcome", { sourceId, found: view !== null });
    return view ? context.json(view) : context.json({ error: "Source not found" }, 404);
  });
  app.post("/sources/:id/follow-ups/:jobId/retry", bodyLimit({ maxSize: 4096, onError: (context) => context.json({ error: "invalid_input" }, 413) }), async (context) => {
    context.header("cache-control", "no-store");
    const sourceId = context.req.param("id"), jobId = context.req.param("jobId"), key = context.req.header("idempotency-key");
    if (!isRecordId(sourceId) || !isRecordId(jobId)) return context.json({ error: "Follow-up not found" }, 404);
    if (!isIdempotencyKey(key)) return context.json({ error: "invalid_input" }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_input" }, 400); }
    const input = parseFollowUpRetryInput(body);
    if (!input) return context.json({ error: "invalid_input" }, 400);
    console.info("follow_up.http retry attempt", { sourceId, jobId, expectedRunId: input.expectedRunId });
    const result = worker.retryFollowUp(sourceId, jobId, key, input, availability());
    console.info("follow_up.http retry outcome", { sourceId, jobId, outcome: result.kind });
    switch (result.kind) {
      case "accepted": return context.json(result.receipt, 202);
      case "conflict": return context.json({ error: "retry_conflict" }, 409);
      case "not_found": return context.json({ error: "Follow-up not found" }, 404);
      case "unavailable": return context.json({ error: "follow_up_unavailable" }, 503);
    }
  });
  return app;
}
