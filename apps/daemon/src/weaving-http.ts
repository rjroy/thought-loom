import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isIdempotencyKey, isRecordId, parseWeavingRetryInput, parseWeavingWorkerView, type WeavingWorkerState } from "@thoughtloom/contracts";
import { WeavingError, WeavingWorker } from "./weaving";

export type WeavingHttpOptions = {
  databasePath: string;
  weavingWorker?: WeavingWorker;
  weavingConfigured?: boolean;
  weavingStatus?: () => WeavingWorkerState;
};

export function createWeavingHttpApp(options: WeavingHttpOptions) {
  const app = new Hono();
  // A read-only fallback reports saved queue state even without native setup.
  // Neither this object nor any HTTP handler starts or schedules native work.
  const worker = options.weavingWorker ?? new WeavingWorker({ databasePath: options.databasePath, adapter: null });
  function availability() {
    const configured = options.weavingConfigured === true && worker.configured;
    const view = parseWeavingWorkerView({ configured, state: configured ? options.weavingStatus?.() ?? "unavailable" : "unavailable" });
    if (!view) throw new WeavingError("invalid_configuration");
    return view;
  }
  app.onError((error, context) => {
    console.error("weaving.http failed", { category: error instanceof WeavingError ? error.code : "request_failed" });
    context.header("cache-control", "no-store");
    return context.json({ error: "weaving_unavailable" }, 503);
  });
  app.get("/weaving/status", (context) => {
    context.header("cache-control", "no-store");
    return context.json({ state: availability().state });
  });
  app.get("/sources/:id/weaving", (context) => {
    context.header("cache-control", "no-store");
    const id = context.req.param("id");
    if (!isRecordId(id)) return context.json({ error: "Source not found" }, 404);
    console.info("weaving.status read attempt", { sourceId: id });
    const view = worker.readStatus(id, availability());
    console.info("weaving.status read outcome", { sourceId: id, found: view !== null });
    return view ? context.json(view) : context.json({ error: "Source not found" }, 404);
  });
  app.post("/sources/:id/weaving/retry", bodyLimit({ maxSize: 4096, onError: (context) => context.json({ error: "Invalid retry request" }, 413) }), async (context) => {
    context.header("cache-control", "no-store");
    const id = context.req.param("id"), key = context.req.header("idempotency-key");
    if (!isRecordId(id)) return context.json({ error: "Source not found" }, 404);
    if (!isIdempotencyKey(key)) return context.json({ error: "Invalid Idempotency-Key" }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "Invalid JSON" }, 400); }
    const input = parseWeavingRetryInput(body);
    if (!input) return context.json({ error: "Invalid retry request" }, 400);
    console.info("weaving.retry request attempt", { sourceId: id, expectedRunId: input.expectedRunId });
    const result = worker.retry(id, key, input, availability());
    console.info("weaving.retry request outcome", { sourceId: id, outcome: result.kind });
    switch (result.kind) {
      case "accepted": return context.json(result.receipt, 202);
      case "not_found": return context.json({ error: "Source not found" }, 404);
      case "unavailable": return context.json({ error: "weaving_unavailable" }, 503);
      case "conflict": return context.json({ error: "retry_conflict" }, 409);
    }
  });
  return app;
}
