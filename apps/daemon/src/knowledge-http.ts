import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import { INQUIRY_LIMITS, isRecordId, isIdempotencyKey, parseRelationshipRejectInput, parseRelationshipRestoreInput, parseRelationshipView,
  parseItemCorrectionInput, parseItemRestoreInput, parseItemView } from "@thoughtloom/contracts";
import { KnowledgeError, KnowledgeService, type Relationship } from "./knowledge";

export function createKnowledgeHttpApp(options: { databasePath: string }) {
  const app = new Hono(), service = new KnowledgeService(options.databasePath);
  app.onError((error, context) => {
    const code = error instanceof KnowledgeError ? error.code : "storage_error";
    console.error("knowledge.user request failed", { category: code });
    return context.json({ error: code }, code === "operation_conflict" || code === "version_conflict" ? 409 : code === "forbidden" ? 403 : code === "invalid_input" || code === "invalid_reference" ? 400 : 503);
  });
  for (const action of ["reject", "restore"] as const) app.post(`/relationships/:id/${action}`, bodyLimit({ maxSize: 131_072, onError: (context) => context.json({ error: "invalid_input" }, 413) }), async (context) => {
    context.header("cache-control", "no-store");
    const id = context.req.param("id"), key = context.req.header("idempotency-key");
    if (!isRecordId(id) || !isIdempotencyKey(key)) return context.json({ error: "invalid_input" }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_input" }, 400); }
    const actor = { actor: "user" as const, operationId: `user_relationship_${createHash("sha256").update(key).digest("hex")}` };
    const attempt = () => console.info("knowledge.user request attempt", { relationshipId: id, action, operationId: actor.operationId });
    let result: Relationship;
    if (action === "reject") {
      const input = parseRelationshipRejectInput(body);
      if (!input) return context.json({ error: "invalid_input" }, 400);
      attempt();
      result = service.reviseRelationship(actor, { relationshipId: id, status: "rejected", ...input });
    } else {
      const input = parseRelationshipRestoreInput(body);
      if (!input) return context.json({ error: "invalid_input" }, 400);
      attempt();
      result = service.restoreRelationship(actor, { relationshipId: id, ...input });
    }
    const view = parseRelationshipView({ ...result, history: result.history.slice(-INQUIRY_LIMITS.history), historyTruncated: result.history.length > INQUIRY_LIMITS.history });
    if (!view) throw new KnowledgeError("storage_error");
    console.info("knowledge.user request succeeded", { relationshipId: id, action, operationId: actor.operationId });
    return context.json(view);
  });
  for (const action of ["correct", "restore"] as const) app.post(`/items/:id/${action}`, bodyLimit({ maxSize: 131_072, onError: (context) => context.json({ error: "invalid_input" }, 413) }), async (context) => {
    context.header("cache-control", "no-store");
    const id = context.req.param("id"), key = context.req.header("idempotency-key");
    if (!isRecordId(id) || !isIdempotencyKey(key)) return context.json({ error: "invalid_input" }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_input" }, 400); }
    const actor = { actor: "user" as const, operationId: `user_item_${createHash("sha256").update(key).digest("hex")}` };
    const input = action === "correct" ? parseItemCorrectionInput(body) : parseItemRestoreInput(body);
    if (!input) return context.json({ error: "invalid_input" }, 400);
    console.info("knowledge.user request attempt", { itemId: id, action, operationId: actor.operationId });
    const result = "sourceId" in input ? service.correctItem(actor, { itemId: id, ...input }) : service.restoreItem(actor, { itemId: id, ...input });
    const view = parseItemView({ ...result, history: result.history.slice(-INQUIRY_LIMITS.history), historyTruncated: result.history.length > INQUIRY_LIMITS.history });
    if (!view) throw new KnowledgeError("storage_error");
    console.info("knowledge.user request succeeded", { itemId: id, action, operationId: actor.operationId });
    return context.json(view);
  });
  return app;
}
