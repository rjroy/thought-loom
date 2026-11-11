import { callDaemon } from "../../../../../server/client";
import { readWebConfig } from "../../../../../server/config";
import { handleEvolveRun } from "../../../../../server/evolve";
import { isTrustedRequest } from "../../../../../server/request-guard";

type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context): Promise<Response> {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN, THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS: process.env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS });
    if (isTrustedRequest(config, request)) {
      const { id } = await context.params;
      return handleEvolveRun(request, id, { callDaemon });
    }
  } catch { /* Fail closed without request or configuration details. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
export function GET(request: Request, context: Context): Promise<Response> { return handle(request, context); }
export function POST(request: Request, context: Context): Promise<Response> { return handle(request, context); }
