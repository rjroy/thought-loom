import { callDaemon } from "../../../../../server/client";
import { readWebConfig } from "../../../../../server/config";
import { handleExportRun } from "../../../../../server/export";
import { isTrustedRequest } from "../../../../../server/request-guard";

type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context): Promise<Response> {
  try {
    if (isTrustedRequest(readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN }), request)) return handleExportRun(request, (await context.params).id, { callDaemon });
  } catch { /* Fail closed. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
export function GET(request: Request, context: Context): Promise<Response> { return handle(request, context); }
export function POST(request: Request, context: Context): Promise<Response> { return handle(request, context); }
