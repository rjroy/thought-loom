import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import { isIdempotencyKey, isRecordId, isThoughtTitleText } from "@thoughtloom/contracts";
import { openDatabase } from "./storage";
import { readTitle } from "./title-projection";
import { KnowledgeError } from "./knowledge";
import { validTitleTarget as validTarget, writeTitle, type TitleTarget as Target } from "./title-write";

function targetFrom(value: unknown): Target | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("kind" in value)) return null;
  if (value.kind === "source" && Object.keys(value).length === 1) return { kind: "source" };
  if (value.kind === "item" && "itemId" in value && "versionId" in value && isRecordId(value.itemId) && isRecordId(value.versionId) && Object.keys(value).length === 3) return { kind: "item", itemId: value.itemId, versionId: value.versionId };
  return null;
}

export function createTitleHttpApp(databasePath: string) {
  const app = new Hono();
  app.get("/sources/:id/title", (context) => {
    const sourceId = context.req.param("id"), params = new URL(context.req.url).searchParams;
    const items = params.getAll("itemId"), versions = params.getAll("versionId");
    if (!isRecordId(sourceId) || items.length !== versions.length || items.length > 1 || (items.length === 1 && (!isRecordId(items[0]) || !isRecordId(versions[0])))) return context.json({ error: "invalid_input" }, 400);
    const target: Target = items.length ? { kind: "item", itemId: items[0], versionId: versions[0] } : { kind: "source" };
    console.info("title.read attempt", { sourceId });
    const db = openDatabase(databasePath);
    try {
      const result = db.transaction(() => validTarget(db, sourceId, target) ? readTitle(db, sourceId, target.kind === "item" ? target.itemId : undefined, target.kind === "item" ? target.versionId : undefined) : null).deferred();
      console.info("title.read completed", { found: result !== null });
      context.header("cache-control", "no-store");
      return result ? context.json(result, 200) : context.json({ error: "invalid_reference" }, 404);
    } finally { db.close(); }
  });
  app.post("/sources/:id/title", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "invalid_input" }, 413) }), async (context) => {
    const sourceId = context.req.param("id"), key = context.req.header("idempotency-key");
    if (!isRecordId(sourceId) || !isIdempotencyKey(key)) return context.json({ error: "invalid_input" }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_input" }, 400); }
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => !["target", "text", "expectedTitleRevisionId"].includes(k)) || !("target" in body) || !("text" in body) || !("expectedTitleRevisionId" in body)) return context.json({ error: "invalid_input" }, 400);
    const target = targetFrom(body.target), text = body.text, expected = body.expectedTitleRevisionId;
    if (!target || !isThoughtTitleText(text) || (expected !== null && !isRecordId(expected))) return context.json({ error: "invalid_input" }, 400);
    const hash = createHash("sha256").update(JSON.stringify({ sourceId, target, text, expected })).digest("hex");
    console.info("title.edit attempt", { sourceId });
    const db = openDatabase(databasePath);
    try {
      const result = db.transaction(() => {
        try {
          return { status: 200 as const, body: writeTitle(db, { sourceId, target, text, expectedTitleRevisionId: expected, author: "user", key, payloadHash: hash }) };
        } catch (error) {
          if (error instanceof KnowledgeError && error.code === "invalid_reference") return { status: 404 as const, body: { error: error.code } };
          if (error instanceof KnowledgeError && (error.code === "operation_conflict" || error.code === "version_conflict")) return { status: 409 as const, body: { error: error.code } };
          throw error;
        }
      }).immediate();
      console.info("title.edit completed", { sourceId, status: result.status });
      context.header("cache-control", "no-store");
      return context.json(result.body, result.status);
    } catch (error) { console.error("title.edit failed", { sourceId, category: "storage_error" }); throw error; }
    finally { db.close(); }
  });
  return app;
}
