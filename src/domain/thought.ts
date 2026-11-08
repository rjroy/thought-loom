import { nonEmpty, nullableString, oneOf, record, references, ValidationError } from "./validation";

export type Author = "user" | "ai";
export type TitleAuthor = Author;
/** Imported wording has unverified original authorship, not user or AI authority. */
export type ThoughtAuthor = Author | "source";
export type TextMaterialKind = "captured-original" | "user-contribution" | "ai-interpretation" | "developing-idea" | "imported-original";
export type MaterialKind = TextMaterialKind | "media-original";

interface ThoughtBase {
  readonly id: string;
  readonly title: string | null;
  readonly titleAuthor?: TitleAuthor | null;
  readonly createdAt: string;
  readonly origin: string;
  readonly parentId: string | null;
  readonly sourceIds: readonly string[];
}
export interface MediaSource {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly fileAuthorship: "unverified";
  readonly clarification: string | null;
  readonly clarificationAuthor: "user" | null;
}
export type TextThought = ThoughtBase & { readonly text: string; readonly author: ThoughtAuthor; readonly kind: TextMaterialKind };
export type MediaThought = ThoughtBase & { readonly text: null; readonly author: "source"; readonly kind: "media-original";
  readonly origin: "media-import"; readonly parentId: null; readonly mediaSource: MediaSource };
export type Thought = TextThought | MediaThought;

/** Validate the same descriptor for full thoughts and lightweight persisted search projections. */
export function createMediaSource(input: unknown): MediaSource {
  const source = record(input);
  if (typeof source.byteLength !== "number" || !Number.isSafeInteger(source.byteLength) || source.byteLength <= 0) throw new ValidationError("Invalid media byte length");
  const clarification = nullableString(source.clarification, "clarification");
  const clarificationAuthor = source.clarificationAuthor === null ? null : oneOf(source.clarificationAuthor, "clarificationAuthor", ["user"]);
  if ((clarification === null) !== (clarificationAuthor === null)) throw new ValidationError("Invalid clarification attribution");
  return Object.freeze({ id: nonEmpty(source.id, "mediaSource.id"), name: nonEmpty(source.name, "mediaSource.name"),
    mimeType: nonEmpty(source.mimeType, "mediaSource.mimeType"), byteLength: source.byteLength,
    fileAuthorship: oneOf(source.fileAuthorship, "fileAuthorship", ["unverified"]), clarification, clarificationAuthor });
}

/** Validate and construct a thought from data crossing a storage boundary. */
export function createThought(input: unknown): Thought {
  const data = record(input);
  const title = nullableString(data.title, "title");
  const titleAuthor = data.titleAuthor === undefined ? undefined : data.titleAuthor === null ? null : oneOf(data.titleAuthor, "titleAuthor", ["user", "ai"]);
  if (titleAuthor !== undefined && ((title === null) !== (titleAuthor === null))) throw new ValidationError("Title attribution is invalid");
  const author = oneOf(data.author, "author", ["user", "ai", "source"]);
  const kind = oneOf(data.kind, "kind", ["captured-original", "user-contribution", "ai-interpretation", "developing-idea", "imported-original", "media-original"]);
  const origin = nonEmpty(data.origin, "origin");
  const parentId = nullableString(data.parentId, "parentId");
  const sourceIds = references(data.sourceIds, "sourceIds");
  if ((author === "source") !== (kind === "imported-original" || kind === "media-original")) throw new ValidationError("Original source requires source authorship");
  if (kind === "imported-original" && (origin !== "markdown-import" || parentId !== null || sourceIds.length !== 0)) {
    throw new ValidationError("Imported-original requires markdown-import origin, no evolution parent and no supporting sources");
  }
  const common = {
    id: nonEmpty(data.id, "id"),
    title,
    ...(titleAuthor === undefined ? {} : { titleAuthor }),
    createdAt: nonEmpty(data.createdAt, "createdAt"),
    origin,
    parentId,
    sourceIds,
  };
  if (kind === "media-original") {
    if (data.text !== null || origin !== "media-import" || parentId !== null || sourceIds.length !== 0 || author !== "source") {
      throw new ValidationError("Media-original requires null text, media-import origin, source authorship and no parent or supporting sources");
    }
    const mediaSource = createMediaSource(data.mediaSource);
    return Object.freeze({ ...common, text: null, author, kind, origin: "media-import", parentId: null, mediaSource });
  }
  if (data.mediaSource !== undefined) throw new ValidationError("Text thoughts cannot have a media source");
  return Object.freeze({ ...common, text: nonEmpty(data.text, "text"), author, kind });
}

export function displayTitle(thought: { readonly title: string | null; readonly text: string } | Thought): string {
  return thought.title ?? (thought.text === null ? thought.mediaSource.name : thought.text.trim().split(/\s+/).slice(0, 5).join(" "));
}
