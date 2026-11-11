import { callDaemon } from "../../../../../../../server/client";
import { readWebConfig } from "../../../../../../../server/config";
import { handleEvolveResponse } from "../../../../../../../server/evolve";
import { isTrustedRequest } from "../../../../../../../server/request-guard";

type Context = { params: Promise<{ id: string; responseId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN, THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS: process.env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS });
    if (isTrustedRequest(config, request)) {
      const { id, responseId } = await context.params;
      return handleEvolveResponse(request, id, responseId, { callDaemon });
    }
  } catch { /* Fail closed without request or configuration details. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
