import type { Database } from "bun:sqlite";
import { parseSourceOrigin, type SourceOrigin } from "@thoughtloom/contracts";

// Relational origin, never inferred from a client-set provenance label.
export function sourceOrigin(db: Database, id: string): SourceOrigin {
  const turn = db.query<{ dialogueId: string; turnId: string; rootSourceId: string }, [string]>(`SELECT t.dialogue_id AS dialogueId,t.id AS turnId,d.source_id AS rootSourceId
    FROM dialogue_turns t JOIN dialogues d ON d.id=t.dialogue_id WHERE t.source_id=?`).get(id);
  const origin = parseSourceOrigin(turn ? { kind: "discussion-turn", ...turn } : { kind: "capture" });
  if (!origin) throw new Error("Invalid source origin");
  return origin;
}
