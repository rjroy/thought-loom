import type { DaemonRequest } from "./daemon";
import { record, thought } from "../features/idea/validation";
import { publicExportRun, validAgentic, validExportRun, validSimple } from "../features/export/types";

export interface ExportDependencies { readonly callDaemon: (request: DaemonRequest) => Promise<Response>; }
const headers = { "cache-control": "private, no-store" };
const json = (value: unknown, status: number) => Response.json(value, { status, headers });
const problem = (status: number) => json({ message: status === 400 ? "Invalid request." : status === 404 ? "Unavailable." : status === 503 ? "Export is not configured." : "Export unavailable." }, status);
const safeId = (id: string) => /^[A-Za-z0-9_~.-]+$/.test(id) && id !== "." && id !== "..";
async function markdown(response: Response): Promise<Response> {
  if (response.status !== 200 || !/^text\/markdown(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) return problem(502);
  return new Response(await response.arrayBuffer(), { status: 200, headers: { ...headers, "content-type": "text/markdown; charset=utf-8" } });
}
export async function handleSimpleExport(request: Request, deps: ExportDependencies): Promise<Response> {
  if (new URL(request.url).search) return problem(400);
  let input: unknown;
  try { input = await request.json(); } catch { return problem(400); }
  if (!validSimple(input)) return problem(400);
  try {
    const response = await deps.callDaemon({ method: "POST", path: "/exports/simple", body: JSON.stringify(input) });
    if ([400, 401, 403, 404].includes(response.status)) return problem(response.status);
    return await markdown(response);
  } catch { return problem(502); }
}
export async function handleExportAdmission(request: Request, deps: ExportDependencies): Promise<Response> {
  if (new URL(request.url).search) return problem(400);
  let input: unknown;
  try { input = await request.json(); } catch { return problem(400); }
  if (!validAgentic(input)) return problem(400);
  try {
    const response = await deps.callDaemon({ method: "POST", path: "/exports/agentic", body: JSON.stringify(input) });
    if ([400, 401, 403, 404, 503].includes(response.status)) return problem(response.status);
    if (response.status !== 201) return problem(502);
    const value: unknown = await response.json();
    return record(value) && validExportRun(value.run) ? json({ run: publicExportRun(value.run) }, 201) : problem(502);
  } catch { return problem(502); }
}
export async function handleExportRun(request: Request, id: string, deps: ExportDependencies): Promise<Response> {
  if (!safeId(id) || new URL(request.url).search || (request.method !== "GET" && request.method !== "POST")) return problem(400);
  if (request.method === "POST") {
    let input: unknown;
    try { input = await request.json(); } catch { return problem(400); }
    if (!record(input) || Object.keys(input).length !== 0) return problem(400);
  }
  try {
    const operation: DaemonRequest = request.method === "POST" ? { method: "POST", path: `/runs/${id}/stop`, body: "{}" } : { method: "GET", path: `/runs/${id}` };
    const response = await deps.callDaemon(operation);
    if (response.status === 404) return problem(404);
    if (response.status !== 200) return problem(502);
    const value: unknown = await response.json();
    return validExportRun(value, id) ? json(publicExportRun(value), 200) : problem(502);
  } catch { return problem(502); }
}
export async function handleExportArtifact(request: Request, id: string, deps: ExportDependencies): Promise<Response> {
  if (!safeId(id) || new URL(request.url).search) return problem(400);
  try {
    const response = await deps.callDaemon({ method: "GET", path: `/exports/agentic/${id}` });
    if (response.status === 404 || response.status === 409) return problem(response.status);
    return await markdown(response);
  } catch { return problem(502); }
}
export async function handleExportThought(request: Request, id: string, deps: ExportDependencies): Promise<Response> {
  if (!safeId(id) || new URL(request.url).search) return problem(400);
  try {
    const response = await deps.callDaemon({ method: "GET", path: `/thoughts/${id}?scope=normal` });
    if (response.status === 404) return problem(404);
    if (response.status !== 200) return problem(502);
    const value: unknown = await response.json();
    return thought(value) && value.id === id && value.rejected !== true ? json(value, 200) : problem(502);
  } catch { return problem(502); }
}
