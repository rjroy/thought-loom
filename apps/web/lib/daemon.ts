import "server-only";
import { parseCaptureInput, type CaptureInput, type Source } from "@thoughtloom/contracts";
import { isSourceId, parseSource } from "./source";

// An operator-controlled loopback destination, never a browser-supplied URL.
function daemonURL(path: string): URL {
  const base = new URL(process.env.THOUGHTLOOM_DAEMON_URL ?? "http://127.0.0.1:3001");
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
      base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Invalid internal daemon configuration");
  }
  return new URL(path, base);
}

export type SourceRead =
  | { kind: "found"; source: Source }
  | { kind: "not-found" }
  | { kind: "unavailable" };

export async function readSource(id: string): Promise<SourceRead> {
  if (!isSourceId(id)) return { kind: "not-found" };
  console.info("bff.source.read attempt", { sourceId: id });
  try {
    const response = await fetch(daemonURL(`/sources/${encodeURIComponent(id)}`), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) {
      console.info("bff.source.read not_found", { sourceId: id });
      return { kind: "not-found" };
    }
    if (response.status !== 200) throw new Error("Source read failed");
    const source = parseSource(await response.json());
    if (!source || source.id !== id) throw new Error("Invalid source receipt");
    console.info("bff.source.read succeeded", { sourceId: id });
    return { kind: "found", source };
  } catch {
    console.error("bff.source.read failed", { sourceId: id, category: "daemon_unavailable" });
    return { kind: "unavailable" };
  }
}

export function privateJSON(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function forwardCapture(body: unknown, key: string | null): Promise<Response> {
  const input: CaptureInput | null = parseCaptureInput(body);
  if (!input || !key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key)) {
    return privateJSON({ error: "Invalid capture or save key" }, 400);
  }
  console.info("bff.capture.save attempt");
  try {
    const response = await fetch(daemonURL("/captures"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(input),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 409) {
      console.info("bff.capture.save conflict");
      return privateJSON({ error: "Save key conflicts with an earlier capture" }, 409);
    }
    if (response.status !== 200 && response.status !== 201) throw new Error("Capture not acknowledged");
    const source = parseSource(await response.json());
    if (!source || source.text !== input.text || source.provenance !== input.provenance) {
      throw new Error("Invalid capture receipt");
    }
    console.info("bff.capture.save succeeded", { sourceId: source.id, status: response.status });
    return privateJSON(source, response.status);
  } catch {
    console.error("bff.capture.save failed", { category: "unconfirmed_save" });
    return privateJSON({ error: "Save could not be confirmed" }, 503);
  }
}
