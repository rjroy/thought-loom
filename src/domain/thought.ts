import { nonEmpty, nullableString, oneOf, record, references, ValidationError } from "./validation";

export type Author = "user" | "ai";
export type TitleAuthor = Author;
/** Imported wording has unverified original authorship, not user or AI authority. */
export type ThoughtAuthor = Author | "source";
export type MaterialKind = "captured-original" | "user-contribution" | "ai-interpretation" | "developing-idea" | "imported-original";

export interface Thought {
  readonly id: string;
  readonly text: string;
  readonly title: string | null;
  readonly titleAuthor?: TitleAuthor | null;
  readonly author: ThoughtAuthor;
  readonly kind: MaterialKind;
  readonly createdAt: string;
  readonly origin: string;
  readonly parentId: string | null;
  readonly sourceIds: readonly string[];
}

/** Validate and construct a thought from data crossing a storage boundary. */
export function createThought(input: unknown): Thought {
  const data = record(input);
  const title = nullableString(data.title, "title");
  const titleAuthor = data.titleAuthor === undefined ? undefined : data.titleAuthor === null ? null : oneOf(data.titleAuthor, "titleAuthor", ["user", "ai"]);
  if (titleAuthor !== undefined && ((title === null) !== (titleAuthor === null))) throw new ValidationError("Title attribution is invalid");
  const author = oneOf(data.author, "author", ["user", "ai", "source"]);
  const kind = oneOf(data.kind, "kind", ["captured-original", "user-contribution", "ai-interpretation", "developing-idea", "imported-original"]);
  const origin = nonEmpty(data.origin, "origin");
  const parentId = nullableString(data.parentId, "parentId");
  const sourceIds = references(data.sourceIds, "sourceIds");
  if ((author === "source") !== (kind === "imported-original")) throw new ValidationError("Imported-original requires source authorship");
  if (kind === "imported-original" && (origin !== "markdown-import" || parentId !== null || sourceIds.length !== 0)) {
    throw new ValidationError("Imported-original requires markdown-import origin, no evolution parent and no supporting sources");
  }
  return Object.freeze({
    id: nonEmpty(data.id, "id"),
    text: nonEmpty(data.text, "text"),
    title,
    ...(titleAuthor === undefined ? {} : { titleAuthor }),
    author,
    kind,
    createdAt: nonEmpty(data.createdAt, "createdAt"),
    origin,
    parentId,
    sourceIds,
  });
}

export function displayTitle(thought: Pick<Thought, "text" | "title">): string {
  return thought.title ?? thought.text.trim().split(/\s+/).slice(0, 5).join(" ");
}
