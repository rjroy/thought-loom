import { handleAgentInstructions } from "../../../../server/agent-instructions";
import { callDaemon } from "../../../../server/client";
import { readWebConfig } from "../../../../server/config";
import { isTrustedRequest } from "../../../../server/request-guard";

/** Credentials stay in the existing server-only client, behind the web authority guard. */
function handle(request: Request): Promise<Response> | Response {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN });
    if (isTrustedRequest(config, request)) return handleAgentInstructions(request, { callDaemon });
  } catch { /* Refuse without exposing configuration or request content. */ }
  return Response.json({ code: "agent-instructions-forbidden", message: "Forbidden." }, {
    status: 403, headers: { "cache-control": "private, no-store" },
  });
}

export const GET = handle;
export const PUT = handle;
