import { handleSearch } from "../../../server/search";
import { callDaemon } from "../../../server/client";
import { readWebConfig } from "../../../server/config";
import { isTrustedRequest } from "../../../server/request-guard";

export function GET(request: Request): Promise<Response> | Response {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN });
    if (isTrustedRequest(config, request)) return handleSearch(request, { callDaemon });
  } catch { /* Fail closed without exposing configuration values. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
