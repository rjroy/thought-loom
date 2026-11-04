import type { DaemonRequest } from "./daemon";
import { record, sharedResponse, thought } from "../features/idea/validation";
import { publicRun, validReceipt, validRun } from "../features/evolve/validation";

export interface EvolveDependencies { readonly callDaemon: (request: DaemonRequest) => Promise<Response>; }
/** Fixed associated-response seam; production wrapper must supply Host guard and server credentials. */
export async function handleEvolveResponse(request: Request, thoughtId: string, responseId: string, deps: EvolveDependencies): Promise<Response> {
  if (!safeId(thoughtId) || !safeId(responseId) || new URL(request.url).search) return problem(400);
  try {
    const base = `/thoughts/${thoughtId}`;
    const focus = await deps.callDaemon({ method: "GET", path: `${base}?scope=normal` });
    if (focus.status === 404) return problem(404);
    if (focus.status !== 200) return problem(502);
    const selected: unknown = await focus.json();
    if (!thought(selected) || selected.id !== thoughtId || selected.rejected === true) return problem(502);
    const response = await deps.callDaemon({ method: "GET", path: `${base}/responses?scope=normal` });
    if (response.status === 404) return problem(404);
    if (response.status !== 200) return problem(502);
    const values: unknown = await response.json();
    if (!Array.isArray(values) || !values.every(sharedResponse)) return problem(502);
    const reply = values.find(item => item.id === responseId && item.thoughtIds.includes(thoughtId));
    return reply ? json(reply, 200) : problem(404);
  } catch { return problem(502); }
}
const headers = { "cache-control": "private, no-store" };
const json = (value: unknown, status: number) => Response.json(value, { status, headers });
const problem = (status: number) => json({ message: status === 400 ? "Invalid request." : status === 404 ? "Unavailable." : status === 503 ? "Evolve is not configured." : "Unable to confirm outcome." }, status);
const safeId = (id: string) => /^[A-Za-z0-9_~.-]+$/.test(id) && id !== "." && id !== "..";

export async function handleEvolveThought(request: Request, id: string, deps: EvolveDependencies): Promise<Response> {
  if (!safeId(id) || new URL(request.url).search) return problem(400);
  try {
    const response = await deps.callDaemon({ method: "GET", path: `/thoughts/${id}?scope=normal` });
    if (response.status === 404) return problem(404);
    if (response.status !== 200) return problem(502);
    const value: unknown = await response.json();
    return thought(value) && value.id === id && value.rejected !== true ? json(value, 200) : problem(502);
  } catch { return problem(502); }
}
export async function handleEvolveAdmission(request: Request, id: string, deps: EvolveDependencies): Promise<Response> {
  if (!safeId(id) || new URL(request.url).search) return problem(400);
  let input: unknown;
  try { input = await request.json(); } catch { return problem(400); }
  if (!record(input) || Object.keys(input).length !== 1 || typeof input.text !== "string" || !input.text.trim()) return problem(400);
  const snapshot = { thoughtId: id, text: input.text };
  try {
    const response = await deps.callDaemon({ method: "POST", path: `/thoughts/${id}/evolve`, body: JSON.stringify({ text: snapshot.text }) });
    if ([400, 401, 403, 404, 503].includes(response.status)) return problem(response.status);
    if (response.status !== 201) return problem(502);
    const value: unknown = await response.json();
    return validReceipt(value, snapshot) ? json({ contribution: value.contribution, run: publicRun(value.run) }, 201) : problem(502);
  } catch { return problem(502); }
}
export async function handleEvolveRun(request: Request, id: string, deps: EvolveDependencies): Promise<Response> {
  if (!safeId(id) || new URL(request.url).search || (request.method !== "GET" && request.method !== "POST")) return problem(400);
  if (request.method === "POST") {
    let input: unknown;
    try { input = await request.json(); } catch { return problem(400); }
    if (!record(input) || Object.keys(input).length !== 0) return problem(400);
  }
  try {
    const operation: DaemonRequest = request.method === "POST"
      ? { method: "POST", path: `/runs/${id}/stop`, body: "{}" }
      : { method: "GET", path: `/runs/${id}` };
    const response = await deps.callDaemon(operation);
    if (response.status === 404) return problem(404);
    if (response.status !== 200) return problem(502);
    const value: unknown = await response.json();
    return validRun(value, id) ? json(publicRun(value), 200) : problem(502);
  } catch { return problem(502); }
}
