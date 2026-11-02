import { isAllowedRequestOrigin } from "@thoughtloom/contracts";
import { forwardCapture, privateJSON } from "../../../lib/daemon";

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedRequestOrigin(request)) return privateJSON({ error: "Cross-origin capture is not allowed" }, 403);
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
