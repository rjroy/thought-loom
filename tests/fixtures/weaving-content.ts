export type BrowserWeavingScenario = "unconfigured" | "available" | "uncertain" | "unavailable" | "updates";

// Controlled examples, never live-model output or normal user capture content.
export const weavingExample = {
  original: "  Example source: When agents disagree, I add coordination. Could the meaning of the original request be changing between handoffs?\nKeep this line intact.  ",
  counterpart: "Example source: A contract can preserve a request across a handoff.",
  candidate: "Example user formulation: Preserve the caller's contract during a handoff.",
  interpretation: "Example AI note: Intent preservation may matter more than additional coordination.",
  rationale: "Example rationale: Both sources concern meaning surviving a handoff; an explicit contract is a possible safeguard, not proof of equivalence.",
  draft: "A new, unsaved example draft must not be replaced by a background update.",
  provenance: "Example · scripted browser weaving fixture",
} as const;

// Proposed HTTP view for the production backend lane. No native credentials,
// paths, session tokens or client-supplied authority belong in this response.
export type WeavingStatusExampleContract = {
  sourceId: string;
  worker: { configured: boolean; state: "starting" | "working" | "waiting" | "unavailable" | "failed" | "stopped" };
  job: { id: string; status: "queued" | "running" | "uncertain" | "completed" | "failed" | "interrupted"; attempts: number; recordedChanges: number | null };
  run: { id: string } | null;
  actions: { retry: boolean };
};
