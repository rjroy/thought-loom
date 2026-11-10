import { decodeAgentInstructions, instructionReceiptMatches, type AgentInstructions } from "./types";

export type InstructionReadResult =
  | { readonly kind: "success"; readonly instructions: AgentInstructions }
  | { readonly kind: "error" };
export type InstructionSaveResult =
  | { readonly kind: "success"; readonly instructions: AgentInstructions }
  | { readonly kind: "conflict" }
  | { readonly kind: "error"; readonly reason: "invalid" | "forbidden" | "unavailable" };

export interface AgentInstructionsClient {
  read(signal?: AbortSignal): Promise<InstructionReadResult>;
  save(snapshot: AgentInstructions, signal?: AbortSignal): Promise<InstructionSaveResult>;
}

const path = "/api/settings/agent-instructions";

/** Release discarded bodies without delaying or changing the classified result. */
function discardBody(response: Response): void {
  try {
    if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
  } catch { /* Cleanup is best-effort, including synchronous cancellation failures. */ }
}

/** The browser knows only this same-origin endpoint, never daemon configuration. */
export function createAgentInstructionsClient(fetcher: typeof fetch): AgentInstructionsClient {
  return {
    async read(signal) {
      try {
        const response = await fetcher(path, { method: "GET", cache: "no-store", redirect: "error", signal });
        if (response.status !== 200) { discardBody(response); return { kind: "error" }; }
        const instructions = decodeAgentInstructions(await response.json());
        return instructions ? { kind: "success", instructions } : { kind: "error" };
      } catch { return { kind: "error" }; }
    },
    async save(snapshot, signal) {
      const unavailable: InstructionSaveResult = { kind: "error", reason: "unavailable" };
      try {
        const response = await fetcher(path, { method: "PUT", cache: "no-store", redirect: "error", signal,
          headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot) });
        if (response.status !== 200) discardBody(response);
        if (response.status === 409) return { kind: "conflict" };
        if (response.status === 400 || response.status === 413 || response.status === 415) return { kind: "error", reason: "invalid" };
        if (response.status === 401 || response.status === 403) return { kind: "error", reason: "forbidden" };
        if (response.status !== 200) return unavailable;
        const instructions = decodeAgentInstructions(await response.json());
        return instructions && instructionReceiptMatches(instructions, snapshot) ? { kind: "success", instructions } : unavailable;
      } catch { return unavailable; }
    },
  };
}
