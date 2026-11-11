import { callDaemon } from "../../../../../server/client";
import { readWebConfig } from "../../../../../server/config";
import { handleExportArtifact, handleExportDelete } from "../../../../../server/export";
import { isTrustedRequest } from "../../../../../server/request-guard";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    if (isTrustedRequest(readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN }), request)) return handleExportArtifact(request, (await context.params).id, { callDaemon });
  } catch { /* Fail closed. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    if (isTrustedRequest(readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN }), request)) return handleExportDelete(request, (await context.params).id, { callDaemon });
  } catch { /* Fail closed. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
