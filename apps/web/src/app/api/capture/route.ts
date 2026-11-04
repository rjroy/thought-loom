import { handleCapture } from "../../../server/capture";
import { callDaemon } from "../../../server/client";
import { readWebConfig } from "../../../server/config";
import { isTrustedRequest } from "../../../server/request-guard";

export function POST(request: Request): Promise<Response> | Response {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN });
    if (isTrustedRequest(config, request)) return handleCapture(request, { callDaemon });
  } catch {
    // Fail closed without exposing configuration values.
  }
  return Response.json({ message: "Your thought was not saved." }, {
    status: 403, headers: { "cache-control": "private, no-store" },
  });
}
