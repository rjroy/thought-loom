import { record, ValidationError } from "./validation";

export interface AgentInstructions {
  readonly weaver: string;
  readonly evolve: string;
  readonly search: string;
  readonly export: string;
  readonly revision: number;
}

export interface AgentInstructionsRepository {
  get(): AgentInstructions;
  save(input: AgentInstructions): AgentInstructions;
}

export const agentInstructionFields = ["weaver", "evolve", "search", "export"] as const;
export const agentInstructionMaxBytes = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** User-authored guidance is exact text; it is neither trimmed nor interpreted as authority. */
export function parseAgentInstructions(value: unknown): AgentInstructions {
  const data = record(value);
  const keys = [...agentInstructionFields, "revision"];
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data,key))) throw new ValidationError("Invalid agent instructions");
  for (const field of agentInstructionFields) {
    const text = data[field];
    if (typeof text !== "string") throw new ValidationError("Invalid agent instructions");
    const bytes = encoder.encode(text);
    if (bytes.length > agentInstructionMaxBytes || decoder.decode(bytes) !== text) throw new ValidationError("Invalid agent instructions");
  }
  if (typeof data.revision !== "number" || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new ValidationError("Invalid agent instructions revision");
  return {weaver:data.weaver as string,evolve:data.evolve as string,search:data.search as string,export:data.export as string,revision:data.revision};
}
