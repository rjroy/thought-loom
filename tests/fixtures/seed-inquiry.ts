import { KnowledgeService, type KnowledgeContext } from "../../apps/daemon/src/knowledge";
import { saveCapture } from "../../apps/daemon/src/storage";
import { inquiryExample as example } from "./inquiry-content";

// Imported ONLY by the browser harness. Never loaded by a production entrypoint.
// All mutations use existing services against the harness-owned temporary DB.
export function seedInquiryExample(databasePath: string): void {
  console.info("browser.fixture.seed attempt");
  const capture = (key: string, text: string) => {
    const result = saveCapture(databasePath, `browser-example-${key}`, { text, provenance: example.provenance });
    if (result.kind !== "created") throw new Error("Browser example must be seeded into a fresh test database");
    return result.source;
  };
  const short = capture("sdk", example.sdk);
  const expanded = capture("expanded-sdk", example.expandedSDK);
  const original = capture("original", example.original);
  const knowledge = new KnowledgeService(databasePath);
  const ai = (operationId: string): KnowledgeContext => ({ actor: "ai", operationId: `browser-example-${operationId}`, runId: "browser-example-not-a-model-run" });

  knowledge.recordAlias({ actor: "user", operationId: "browser-example-sdk-alias" }, {
    alias: "SDK", expansion: "software development kit", evidenceSourceIds: [short.id, expanded.id],
  });
  const initial = knowledge.createItem(ai("initial-interpretation"), {
    kind: "interpretation", sourceId: original.id, text: example.initialInterpretation, evidenceSourceIds: [original.id],
  });
  const current = knowledge.reviseItem(ai("revised-interpretation"), {
    itemId: initial.id, expectedVersionId: initial.current.id, text: example.currentInterpretation, evidenceSourceIds: [original.id],
  });
  knowledge.createItem(ai("alternate-interpretation"), {
    kind: "interpretation", sourceId: original.id, text: example.alternateInterpretation, evidenceSourceIds: [original.id],
  });
  const connected = knowledge.createItem(ai("connected-interpretation"), {
    kind: "interpretation", sourceId: expanded.id, text: example.connectedInterpretation, evidenceSourceIds: [expanded.id],
  });
  const relationship = knowledge.createRelationship(ai("initial-connection"), {
    fromItemId: current.id, toItemId: connected.id, type: "suggests", rationale: example.initialRationale, evidenceSourceIds: [original.id, expanded.id],
  });
  knowledge.reviseRelationship(ai("revised-connection"), {
    relationshipId: relationship.id, expectedVersionId: relationship.current.id, status: "active", rationale: example.currentRationale, evidenceSourceIds: [original.id, expanded.id],
  });
  console.info("browser.fixture.seed succeeded", { sources: 3, interpretations: 3, relationships: 1, content: "example_only" });
}
