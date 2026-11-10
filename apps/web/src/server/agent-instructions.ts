import { decodeAgentInstructions, instructionMaxBytes, instructionReceiptMatches, type AgentInstructions } from "../features/settings/types";
import type { DaemonRequest } from "./daemon";

interface Dependencies { readonly callDaemon: (request: DaemonRequest) => Promise<Response> }
const maxJsonBytes = 4 * 6 * instructionMaxBytes + 4096;
class BodyTooLarge extends Error {}

async function boundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxJsonBytes) { await reader.cancel(); throw new BodyTooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** One closed Settings operation, never a caller-selected daemon path or role. */
export async function handleAgentInstructions(request: Request, deps: Dependencies): Promise<Response> {
  const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
  const problem = (code: string, message: string, status: number) => json({ code, message }, status);
  const invalid = () => problem("invalid-agent-instructions", "Invalid agent instructions.", 400);
  const tooLarge = () => problem("agent-instructions-too-large", "The Settings request is too large.", 413);
  const unsupported = () => problem("unsupported-media-type", "Use an application/json request.", 415);
  const unavailable = () => problem("agent-instructions-unavailable", request.method === "GET" ? "Instructions could not be loaded." : "Changes were not saved or could not be confirmed.", 502);
  if (new URL(request.url).search) return invalid();
  if (request.method !== "GET" && request.method !== "PUT") return problem("method-not-allowed", "Method not allowed.", 405);
  let input: AgentInstructions | undefined, body: string | undefined;
  if (request.method === "PUT") {
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(request.headers.get("content-type") ?? "")) {
      return unsupported();
    }
    try {
      body = await boundedBody(request);
      input = decodeAgentInstructions(JSON.parse(body));
    } catch (error) {
      return error instanceof BodyTooLarge ? tooLarge() : invalid();
    }
    if (!input) return invalid();
  }
  try {
    // Forward the original JSON so duplicate keys are still refused by the daemon's strict parser.
    const response = await deps.callDaemon({ method: request.method === "GET" ? "GET" : "PUT", path: "/settings/agent-instructions", ...(body === undefined ? {} : { body }) });
    if (request.method === "PUT" && response.status === 409) return problem("agent-instructions-conflict", "Instructions changed elsewhere. Your edits were not saved.", 409);
    if (response.status === 401 || response.status === 403) return problem("agent-instructions-forbidden", "Settings access is unavailable.", response.status);
    if (request.method === "PUT" && response.status === 400) return invalid();
    if (request.method === "PUT" && response.status === 413) return tooLarge();
    if (request.method === "PUT" && response.status === 415) return unsupported();
    if (response.status !== 200) return unavailable();
    const instructions = decodeAgentInstructions(await response.json());
    if (!instructions || (input && !instructionReceiptMatches(instructions, input))) return unavailable();
    return json(instructions, 200);
  } catch { return unavailable(); }
}
