import { NextResponse, type NextRequest } from "next/server";
import { readWebConfig } from "./server/config";
import { isTrustedRequest } from "./server/request-guard";

/** Applies before routes, server components, and server actions; forwarded authority is ignored. */
export function proxy(request: NextRequest): NextResponse {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN });
    if (isTrustedRequest(config, request)) {
      const response = NextResponse.next();
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
  } catch {
    // Do not expose configuration values in the response.
  }
  return new NextResponse("Forbidden", { status: 403, headers: { "Cache-Control": "private, no-store" } });
}
