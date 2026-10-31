import { forwardCapture, privateJSON } from "../../../lib/daemon";

export async function POST(request: Request): Promise<Response> {
  // Loopback-only today. Reject cross-origin mutations; this is not authentication.
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const browserOrigin = new URL(origin);
      // Next's internal request URL may normalize the listening hostname. Match
      // the actual Host header, not that internal URL or forwarded headers.
      if (browserOrigin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(browserOrigin.hostname) ||
          browserOrigin.host !== request.headers.get("host")) {
        return privateJSON({ error: "Cross-origin capture is not allowed" }, 403);
      }
    } catch {
      return privateJSON({ error: "Invalid request origin" }, 403);
    }
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return privateJSON({ error: "Capture requires JSON" }, 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return privateJSON({ error: "Invalid JSON" }, 400);
  }
  return forwardCapture(body, request.headers.get("idempotency-key"));
}
