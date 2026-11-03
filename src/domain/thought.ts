import { nonEmpty, nullableString, oneOf, record, references } from "./validation";

export type Author = "user" | "ai";
export type MaterialKind = "captured-original" | "user-contribution" | "ai-interpretation" | "developing-idea";

export interface Thought {
  readonly id: string;
  readonly text: string;
  readonly title: string | null;
  readonly author: Author;
  readonly kind: MaterialKind;
  readonly createdAt: string;
  readonly origin: string;
  readonly parentId: string | null;
  readonly sourceIds: readonly string[];
}

/** Validate and construct a thought from data crossing a storage boundary. */
export function createThought(input: unknown): Thought {
  const data = record(input);
  return Object.freeze({
    id: nonEmpty(data.id, "id"),
    text: nonEmpty(data.text, "text"),
    title: nullableString(data.title, "title"),
    author: oneOf(data.author, "author", ["user", "ai"]),
    kind: oneOf(data.kind, "kind", ["captured-original", "user-contribution", "ai-interpretation", "developing-idea"]),
    createdAt: nonEmpty(data.createdAt, "createdAt"),
    origin: nonEmpty(data.origin, "origin"),
    parentId: nullableString(data.parentId, "parentId"),
    sourceIds: references(data.sourceIds, "sourceIds"),
  });
}

export function displayTitle(thought: Pick<Thought, "text" | "title">): string {
  return thought.title ?? thought.text.trim().split(/\s+/).slice(0, 5).join(" ");
}
