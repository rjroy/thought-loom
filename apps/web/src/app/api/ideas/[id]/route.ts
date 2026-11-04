import { handleIdeaCommand, handleIdeaRead } from "../../../../server/idea";
import { callDaemon } from "../../../../server/client";
import { readWebConfig } from "../../../../server/config";
import { isTrustedRequest } from "../../../../server/request-guard";

type Context = { params: Promise<{ id: string }> };

async function handle(request: Request, context: Context, method: "read" | "command"): Promise<Response> {
  try {
    const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN });
    if (isTrustedRequest(config, request)) {
      const { id } = await context.params;
      return method === "read" ? handleIdeaRead(request, id, { callDaemon }) : handleIdeaCommand(request, id, { callDaemon });
    }
  } catch { /* Fail closed without exposing request or configuration values. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}

export function GET(request: Request, context: Context): Promise<Response> { return handle(request, context, "read"); }
export function POST(request: Request, context: Context): Promise<Response> { return handle(request, context, "command"); }
