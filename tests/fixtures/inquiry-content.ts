// Controlled demonstration content, not generated inference or user material.
// Kept separate from the Bun-only seeder so Playwright's Node runner can read it.
export const inquiryExample = {
  provenance: "Example · browser fixture",
  sdk: "Example source: The SDK makes integrations easier to describe.",
  expandedSDK: "Example source: A software development kit can preserve a caller's contract across a handoff.",
  originalLead: "Example source: When agents disagree about requirements, I keep adding coordination. What if the shared meaning changes between handoffs?",
  original: "  Example source: When agents disagree about requirements, I keep adding coordination. What if the shared meaning changes between handoffs?\n\nI want to keep the question open before choosing another coordinator. A disagreement might reveal an ambiguity, a missing constraint, or a different understanding of the same request. These possibilities should remain distinguishable while I examine what each agent actually received.\n\nThis final line belongs to the full original, beyond its search excerpt.  ",
  initialInterpretation: "Example AI note: More orchestration may help agents resolve a disagreement.",
  currentInterpretation: "Example AI note: Intent preservation may matter more than adding another orchestrator.",
  alternateInterpretation: "Example AI note: Agent disagreement could also expose an ambiguity in the original request.",
  connectedInterpretation: "Example AI note: Explicit contracts may help keep the meaning of a request intact.",
  initialRationale: "Example rationale: Both observations involve a handoff, but the reason for connecting them needs to be made explicit.",
  currentRationale: "Example rationale: Both sources describe meaning changing across a handoff; a preserved contract is a possible countermeasure, not proof that the situations are equivalent.",
} as const;
