export type CaptureInput = {
  text: string;
  provenance: string;
};

export type Source = CaptureInput & {
  id: string;
  createdAt: string;
};

export type SourceSearchResult = {
  sourceId: string;
  matchOrigin: "source";
};

export * from "./inspection";
export * from "./tools";
export * from "./weaving";

// Expanded search response contract; source text is an excerpt, not a replacement
// for fetching the immutable original. Knowledge is present for formulation hits.
export type SearchResult = {
  sourceId: string;
  matchOrigin: "source" | "interpretation" | "alias";
  source: { excerpt: string; provenance: string; createdAt: string };
  item?: { id: string; kind: "interpretation" | "developing-idea"; formulationId: string; text: string; author: "user" | "ai" };
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
