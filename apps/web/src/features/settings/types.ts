export const instructionFields = ["weaver", "evolve", "search", "export"] as const;
export type InstructionField = typeof instructionFields[number];
export type InstructionDraft = Readonly<Record<InstructionField, string>>;
export type AgentInstructions = InstructionDraft & { readonly revision: number };
export type InstructionErrors = Readonly<Partial<Record<InstructionField, string>>>;
export const instructionMaxBytes = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const emptyInstructionDraft = (): InstructionDraft => ({ weaver: "", evolve: "", search: "", export: "" });
export const instructionDraft = (value: InstructionDraft): InstructionDraft => ({ weaver: value.weaver, evolve: value.evolve, search: value.search, export: value.export });
export const sameInstructions = (first: InstructionDraft, second: InstructionDraft): boolean => instructionFields.every(field => first[field] === second[field]);

/** UTF-8 limits must not trim guidance or silently replace invalid Unicode. */
export function instructionTextError(text: string): string | undefined {
  const bytes = encoder.encode(text);
  if (bytes.byteLength > instructionMaxBytes) return "Use no more than 16 KiB (16,384 UTF-8 bytes) for this field.";
  if (decoder.decode(bytes) !== text) return "This text contains an invalid Unicode character. Replace it before saving.";
  return undefined;
}

export function instructionErrors(draft: InstructionDraft): InstructionErrors {
  const errors: Partial<Record<InstructionField, string>> = {};
  for (const field of instructionFields) {
    const message = instructionTextError(draft[field]);
    if (message) errors[field] = message;
  }
  return errors;
}

/** Closed wire contract, shared by the browser and fixed-purpose Next boundary. */
export function decodeAgentInstructions(value: unknown): AgentInstructions | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const keys = [...instructionFields, "revision"];
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return undefined;
  for (const field of instructionFields) if (typeof data[field] !== "string" || instructionTextError(data[field] as string)) return undefined;
  if (typeof data.revision !== "number" || !Number.isSafeInteger(data.revision) || data.revision < 0) return undefined;
  return { weaver: data.weaver as string, evolve: data.evolve as string, search: data.search as string, export: data.export as string, revision: data.revision };
}

export function instructionReceiptMatches(receipt: AgentInstructions, submitted: AgentInstructions): boolean {
  return receipt.revision === submitted.revision + 1 && sameInstructions(receipt, submitted);
}
