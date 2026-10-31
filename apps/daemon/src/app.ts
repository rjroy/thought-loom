import { Hono } from "hono";
import { parseCaptureInput } from "@thoughtloom/contracts";
import { findSource, saveCapture } from "./storage";

export function createApp(options: { databasePath: string }) {
  const app = new Hono();

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
    if (!key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key)) {
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

  return app;
}
