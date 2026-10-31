import { parseCaptureInput, type Source } from "@thoughtloom/contracts";

export function isSourceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSource(value: unknown): Source | null {
  const input = parseCaptureInput(value);
  if (!input || typeof value !== "object" || value === null) return null;
  if (!("id" in value) || typeof value.id !== "string" || !isSourceId(value.id)) return null;
  if (!("createdAt" in value) || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return null;
  return { ...input, id: value.id, createdAt: value.createdAt };
}
