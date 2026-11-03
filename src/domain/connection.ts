import type { Author } from "./thought";
import { nonEmpty, oneOf, record, references } from "./validation";

export type ConnectionCategory = "supports" | "contradicts" | "extends" | "related";

export interface Connection {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly category: ConnectionCategory;
  readonly proposedBy: Author;
  readonly explanation: string;
  readonly sourceIds: readonly string[];
}

export function createConnection(input: unknown): Connection {
  const data = record(input);
  return Object.freeze({
    id: nonEmpty(data.id, "id"),
    fromId: nonEmpty(data.fromId, "fromId"),
    toId: nonEmpty(data.toId, "toId"),
    category: oneOf(data.category, "category", ["supports", "contradicts", "extends", "related"]),
    proposedBy: oneOf(data.proposedBy, "proposedBy", ["user", "ai"]),
    explanation: nonEmpty(data.explanation, "explanation"),
    sourceIds: references(data.sourceIds, "sourceIds"),
  });
}
