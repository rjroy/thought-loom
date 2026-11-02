export type CaptureInput = {
  text: string;
  provenance: string;
};

export type Source = CaptureInput & {
  id: string;
  createdAt: string;
  origin?: SourceOrigin;
  title?: ThoughtTitle;
};
export type ThoughtTitle = { revisionId: string; text: string; author: "user" | "ai" };
export type SourceOrigin = { kind: "capture" } | { kind: "discussion-turn"; dialogueId: string; turnId: string; rootSourceId: string };

export type SourceSearchResult = {
  sourceId: string;
  matchOrigin: "source";
};

export * from "./inspection";
export * from "./tools";
export * from "./native-capabilities";
export * from "./weaving";
export * from "./dialogue";
export * from "./user-commands";
export * from "./follow-up";
export * from "./local-request";
export * from "./springboard";
export * from "./search";

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
