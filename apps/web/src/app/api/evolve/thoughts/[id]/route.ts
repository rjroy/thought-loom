import { callDaemon } from "../../../../../server/client";
import { readWebConfig } from "../../../../../server/config";
import { handleEvolveAdmission, handleEvolveThought } from "../../../../../server/evolve";
import { isTrustedRequest } from "../../../../../server/request-guard";

type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context): Promise<Response> {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN });
    if (isTrustedRequest(config, request)) {
      const { id } = await context.params;
      return request.method === "POST" ? handleEvolveAdmission(request, id, { callDaemon }) : handleEvolveThought(request, id, { callDaemon });
    }
  } catch { /* Fail closed without request or configuration details. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
export function GET(request: Request, context: Context): Promise<Response> { return handle(request, context); }
export function POST(request: Request, context: Context): Promise<Response> { return handle(request, context); }
