import { handleBrowse } from "../../../../server/browse";
import { callDaemon } from "../../../../server/client";
import { readWebConfig } from "../../../../server/config";
import { isTrustedRequest } from "../../../../server/request-guard";

/** Browser reads use the configured server-only user credential, never a browser-selected role. */
export function GET(request: Request): Promise<Response> | Response {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN });
    if (isTrustedRequest(config, request)) return handleBrowse(request, { callDaemon });
  } catch { /* Fail closed without exposing configuration values. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
