import { callDaemon } from "../../../../server/client";
import { readWebConfig } from "../../../../server/config";
import { handleEvolveSession } from "../../../../server/evolve-sessions";
import { isTrustedRequest } from "../../../../server/request-guard";

async function handle(request: Request): Promise<Response> {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN, THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS: process.env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS });
    if (isTrustedRequest(config, request)) return handleEvolveSession(request, callDaemon);
  } catch { /* Fail closed without request or configuration details. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
export function GET(request: Request): Promise<Response> { return handle(request); }
export function POST(request: Request): Promise<Response> { return handle(request); }
export function PUT(request: Request): Promise<Response> { return handle(request); }
