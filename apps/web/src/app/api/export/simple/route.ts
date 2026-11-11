import { callDaemon } from "../../../../server/client";
import { readWebConfig } from "../../../../server/config";
import { handleSimpleExport } from "../../../../server/export";
import { isTrustedRequest } from "../../../../server/request-guard";

export async function POST(request: Request): Promise<Response> {
  try {
    if (isTrustedRequest(readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN, THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS: process.env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS }), request)) return handleSimpleExport(request, { callDaemon });
  } catch { /* Fail closed. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
