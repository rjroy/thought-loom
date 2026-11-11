import { callDaemon } from "../../../../server/client";
import { readWebConfig } from "../../../../server/config";
import { handleExportAdmission, handleExportHistory } from "../../../../server/export";
import { isTrustedRequest } from "../../../../server/request-guard";

export async function POST(request: Request): Promise<Response> {
  try {
    if (isTrustedRequest(readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN }), request)) return handleExportAdmission(request, { callDaemon });
  } catch { /* Fail closed. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (isTrustedRequest(readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN }), request)) return handleExportHistory(request, { callDaemon });
  } catch { /* Fail closed. */ }
  return Response.json({ message: "Forbidden." }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
