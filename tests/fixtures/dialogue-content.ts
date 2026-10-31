// Illustrative, test-owned content. No personal corpus or live model output.
export const dialogueExample = {
  original: "  Example source: When agents disagree, I add coordination. Could the meaning of the original request change between handoffs?\nKeep this original line intact.  ",
  counterpart: "Example source: Explicit contracts can preserve the intent of a request across a handoff.",
  initialReading: "Example earlier reading: More orchestration could resolve the disagreement.",
  reading: "Example AI reading: The problem may be coordination between agents.",
  alternate: "Example alternate reading: Handoffs may change the intended meaning.",
  neighbor: "Example connected reading: A contract can preserve a request across a handoff.",
  rationale: "Example hypothesis: Handoff contracts might explain a coordination failure; this is not proof of equivalence.",
  changedReading: "Example later user correction: Preserve intent before adding coordination.",
  changedRationale: "Example later user rationale: This connection needs stronger evidence.",
  thought: "  Example challenge: What if orchestration is the wrong framing? Track intent through a zirconium handoff.\nKeep this discussion line intact.  ",
  secondThought: "Example follow-up: Which part of the request must survive the next handoff?",
  correction: "  Example user formulation: The important constraint is intent preservation, not additional coordination.\nRetain my correction.  ",
  reply: "Example agent response: The orchestration framing may hide a change in meaning. An intent-preservation contract is a possible alternative, not an established explanation.",
  partialReply: "Example partial response: The handoff may change the intended meaning. This run ended before the comparison was finished.",
  idea: "Example developing idea: Preserve intent across handoffs rather than merely add orchestration.",
  proseOnly: "Example agent prose: I saved a new idea. This sentence alone is not a domain-write receipt.",
  draftOriginal: "Example unsaved draft for the original source.",
  draftReading: "Example unsaved draft attached to this reading.",
  draftConnection: "Example unsaved draft questioning this connection.",
  blocked: "Example external discussion is already waiting on this same original.",
  provenance: "Example · scripted browser dialogue fixture",
} as const;

export type BrowserDialogueScenario = "available" | "uncertain";
