import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DIALOGUE_LIMITS, isIdempotencyKey, isRecordId, parseDialogueInput, parseDialogueTurnInput, parseDialogueStopInput } from "@thoughtloom/contracts";
import { DialogueError, DialogueService } from "./dialogue";
import type { WeavingWorker } from "./weaving";

export function createDialogueApp(options: { databasePath: string; weavingWorker?: WeavingWorker }) {
  const app = new Hono();
  const dialogues = new DialogueService(options.databasePath);
  app.onError((error, context) => {
    const code = error instanceof DialogueError ? error.code : "storage_error";
    const status = code === "not_found" ? 404 : code === "operation_conflict" || code === "turn_conflict" ? 409 : code === "invalid_input" || code === "invalid_selection" ? 400 : 503;
    console.error("dialogue.http failed", { category: code });
    context.header("cache-control", "no-store");
    return context.json({ error: code }, status);
  });
  app.post("/sources/:id/dialogues", bodyLimit({ maxSize: 4096, onError: (context) => context.json({ error: "invalid_input" }, 413) }), async (context) => {
    context.header("cache-control", "no-store");
    const id = context.req.param("id");
    if (!isRecordId(id)) return context.json({ error: "not_found" }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_input" }, 400); }
    const input = parseDialogueInput(body);
    if (!input) return context.json({ error: "invalid_input" }, 400);
    const key = context.req.header("idempotency-key");
    if (key !== undefined && !isIdempotencyKey(key)) return context.json({ error: "invalid_input" }, 400);
    return context.json(dialogues.create(id, input, key), 201);
  });
  app.post("/dialogues/:id/turns", bodyLimit({ maxSize: DIALOGUE_LIMITS.turnText * 4 + 512, onError: (context) => context.json({ error: "invalid_input" }, 413) }), async (context) => {
    context.header("cache-control", "no-store");
    const id = context.req.param("id"), key = context.req.header("idempotency-key");
    if (!isRecordId(id)) return context.json({ error: "not_found" }, 404);
    if (!isIdempotencyKey(key)) return context.json({ error: "invalid_input" }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_input" }, 400); }
    const input = parseDialogueTurnInput(body);
    if (!input) return context.json({ error: "invalid_input" }, 400);
    const result = dialogues.submit(id, key, input);
    return context.json(result.receipt, result.kind === "created" ? 201 : 200);
  });
  app.get("/dialogues/:id", (context) => {
    context.header("cache-control", "no-store");
    const id = context.req.param("id");
    if (!isRecordId(id)) return context.json({ error: "not_found" }, 404);
    const result = dialogues.get(id);
    return result ? context.json(result) : context.json({ error: "not_found" }, 404);
  });
  app.post("/dialogues/:id/turns/:turnId/stop", bodyLimit({ maxSize: 1024, onError: (context) => context.json({ error: "invalid_input" }, 413) }), async (context) => {
    context.header("cache-control", "no-store");
    const id = context.req.param("id"), turnId = context.req.param("turnId"), key = context.req.header("idempotency-key");
    if (!isRecordId(id) || !isRecordId(turnId) || !isIdempotencyKey(key)) return context.json({ error: "invalid_input" }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_input" }, 400); }
    const input = parseDialogueStopInput(body);
    if (!input) return context.json({ error: "invalid_input" }, 400);
    const receipt = dialogues.stop(id, turnId, key, input);
    // The acknowledgment and write revocation are already committed. A failed
    // RPC cannot undo acceptance, and replay never repeats an attempted RPC.
    try { await options.weavingWorker?.dispatchStops(turnId); }
    catch { console.error("dialogue.stop dispatch unresolved", { turnId, category: "storage_error" }); }
    return context.json(receipt, 202);
  });
  return app;
}
