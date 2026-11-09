import type { IdeaThought } from "../idea/types";
import type { BrowseQuery } from "./query";
import { record, thought } from "../idea/validation";

/** Existing client ThoughtRead union, not a search hit or conversational response. */
export interface BrowsePage {
  readonly items: readonly IdeaThought[];
  readonly nextCursor: string | null;
}

/** Validate the existing thought union and publish only its documented fields. */
export function decodeBrowsePage(value: unknown, query: BrowseQuery): BrowsePage | undefined {
  if (!record(value) || !Array.isArray(value.items)
      || !(value.nextCursor === null || typeof value.nextCursor === "string" && !!value.nextCursor.trim())) return undefined;
  const items: IdeaThought[] = [];
  for (const item of value.items) {
    if (!thought(item) || (query.scope === "show-rejected" ? typeof item.rejected !== "boolean" : item.rejected === true)) return undefined;
    const common = { id: item.id, title: item.title, ...(item.titleAuthor === undefined ? {} : { titleAuthor: item.titleAuthor }),
      createdAt: item.createdAt, origin: item.origin, sourceIds: [...item.sourceIds],
      ...(item.rejected === undefined ? {} : { rejected: item.rejected }) };
    if (item.kind === "media-original") {
      items.push({ ...common, author: "source", kind: item.kind, origin: "media-import", text: null, parentId: null,
        mediaSource: { ...item.mediaSource } });
    } else {
      items.push({ ...common, author: item.author, kind: item.kind, text: item.text, parentId: item.parentId });
    }
  }
  return { items, nextCursor: value.nextCursor };
}
