import { forwardWeavingRetry, privateJSON } from "../../../../../../lib/daemon";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.host !== request.headers.get("host")) return privateJSON({ error: "Cross-origin retry is not allowed" }, 403);
    } catch { return privateJSON({ error: "Invalid request origin" }, 403); }
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return privateJSON({ error: "Retry requires JSON" }, 415);
  let body: unknown;
  try { body = await request.json(); } catch { return privateJSON({ error: "Invalid JSON" }, 400); }
  return forwardWeavingRetry((await params).id, body, request.headers.get("idempotency-key"));
}
