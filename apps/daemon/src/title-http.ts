import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import { isIdempotencyKey, isRecordId, isThoughtTitleText } from "@thoughtloom/contracts";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./storage";
import { readTitle } from "./title-projection";

type Target = { kind: "source" } | { kind: "item"; itemId: string; versionId: string };
function validTarget(db: Database, sourceId: string, target: Target): boolean {
  return target.kind === "source"
    ? !!db.query("SELECT 1 FROM sources WHERE id=?").get(sourceId)
    : !!db.query("SELECT 1 FROM knowledge_items i JOIN formulations f ON f.item_id=i.id WHERE i.source_id=? AND i.id=? AND f.id=?").get(sourceId, target.itemId, target.versionId);
}
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
        const receipt = db.query<{ hash: string; revisionId: string; text: string; author: "user" }, [string]>(`SELECT c.payload_hash AS hash,r.id AS revisionId,r.text,r.author FROM title_receipts c JOIN title_revisions r ON r.id=c.revision_id WHERE c.idempotency_key=?`).get(key);
        if (receipt) return receipt.hash === hash ? { status: 200 as const, body: { revisionId: receipt.revisionId, text: receipt.text, author: receipt.author } } : { status: 409 as const, body: { error: "operation_conflict" } };
        if (!validTarget(db, sourceId, target)) return { status: 404 as const, body: { error: "invalid_reference" } };
        const itemId = target.kind === "item" ? target.itemId : undefined;
        const current = readTitle(db, sourceId, itemId, target.kind === "item" ? target.versionId : undefined);
        if (current.headRevisionId !== expected) return { status: 409 as const, body: { error: "version_conflict" } };
        let entity = db.query<{ id: string }, [string]>(`SELECT id FROM title_entities WHERE ${itemId ? "item_id" : "source_id"}=?`).get(itemId ?? sourceId);
        if (!entity) { entity = { id: crypto.randomUUID() }; db.run("INSERT INTO title_entities(id,source_id,item_id) VALUES (?,?,?)", [entity.id, itemId ? null : sourceId, itemId ?? null]); }
        const revisionId = crypto.randomUUID();
        db.run("INSERT INTO title_revisions(id,entity_id,text,author,formulation_id,created_at) VALUES (?,?,?,'user',?,?)", [revisionId, entity.id, text, target.kind === "item" ? target.versionId : null, new Date().toISOString()]);
        db.run("INSERT INTO title_heads(entity_id,revision_id,user_revision_id) VALUES (?,?,?) ON CONFLICT(entity_id) DO UPDATE SET revision_id=excluded.revision_id,user_revision_id=excluded.user_revision_id", [entity.id, revisionId, revisionId]);
        db.run("INSERT INTO title_receipts(idempotency_key,payload_hash,revision_id) VALUES (?,?,?)", [key, hash, revisionId]);
        db.run("DELETE FROM title_search WHERE entity_id=?", [entity.id]);
        db.run("INSERT INTO title_search(entity_id,text) VALUES (?,?)", [entity.id, text]);
        return { status: 200 as const, body: { revisionId, text, author: "user" as const } };
      }).immediate();
      console.info("title.edit completed", { sourceId, status: result.status });
      context.header("cache-control", "no-store");
      return context.json(result.body, result.status);
    } catch (error) { console.error("title.edit failed", { sourceId, category: "storage_error" }); throw error; }
    finally { db.close(); }
  });
  return app;
}
