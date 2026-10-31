export type CaptureInput = {
  text: string;
  provenance: string;
};

export type Source = CaptureInput & {
  id: string;
  createdAt: string;
};

export function parseCaptureInput(value: unknown): CaptureInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("text" in value) || !("provenance" in value)) return null;
  const { text, provenance } = value;
  if (typeof text !== "string" || !text.trim() ||
      typeof provenance !== "string" || !provenance.trim()) {
    return null;
  }
  return { text, provenance };
}
