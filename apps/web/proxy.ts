import { isLocalRequest } from "@thoughtloom/contracts";
import { NextResponse, type NextRequest } from "next/server";

// Runs before every page and API route; Next's request URL may be normalized,
// so the shared check validates the actual Host header independently.
export function proxy(request: NextRequest) {
  if (!isLocalRequest(request)) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  return NextResponse.next();
}
