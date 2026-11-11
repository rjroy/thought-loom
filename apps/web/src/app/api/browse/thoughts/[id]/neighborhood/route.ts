import { handleBrowseNeighborhood } from "../../../../../../server/browse";
import { callDaemon } from "../../../../../../server/client";
import { readWebConfig } from "../../../../../../server/config";
import { isTrustedRequest } from "../../../../../../server/request-guard";

type Context = { params: Promise<{ id: string }> };

/** Fixed-purpose user read; credentials and daemon configuration remain server-only. */
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN, THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS: process.env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS });
    if (isTrustedRequest(config, request)) {
      const { id } = await context.params;
      return handleBrowseNeighborhood(request, id, { callDaemon });
    }
  } catch { /* Fail closed without exposing configuration values. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
