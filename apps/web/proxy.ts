import { isLocalRequest } from "@thoughtloom/contracts";
import { NextResponse, type NextRequest } from "next/server";
import { isIPv4 } from "node:net";

// Runs before every page and API route; Next's request URL may be normalized,
// so the shared check validates the actual Host header independently.
export function proxy(request: NextRequest) {
  let guardRequest: Request = request;
  // Next constructs the proxy URL from its configured listening hostname, not
  // the wire Host. A listening address is not an authority a client can trust.
  // Normalize only that synthetic URL; leave every wire header for the shared
  // guard to validate, and require Host rather than falling back to this URL.
  const bindHost = process.env.THOUGHTLOOM_WEB_HOST ?? "127.0.0.1";
  if (isIPv4(bindHost) && request.headers.has("host")) {
    const url = new URL(request.url);
    if (url.hostname === bindHost && !url.username && !url.password) {
      url.hostname = "127.0.0.1";
      guardRequest = new Request(url, { headers: request.headers });
    }
  }
  if (!isLocalRequest(guardRequest)) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  return NextResponse.next();
}
