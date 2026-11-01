import { isRecordId } from "./inspection";

export const SPRINGBOARD_RECENT_MAX = 32;
export const SPRINGBOARD_EXCERPT_MAX = 240;
export type RecentThought = { id: string; sourceId: string; kind: "source" | "interpretation" | "developing-idea";
  versionId?: string; author: "user" | "ai"; createdAt: string; excerpt: string };
export type RecentThoughtsView = { items: RecentThought[] };

export function parseRecentThoughts(value: unknown): RecentThoughtsView | null {
  if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items) || value.items.length > SPRINGBOARD_RECENT_MAX) return null;
  const items: RecentThought[] = [];
  for (const entry of value.items) {
    if (typeof entry !== "object" || entry === null || !isRecordId(entry.id) || !isRecordId(entry.sourceId) ||
        (entry.kind !== "source" && entry.kind !== "interpretation" && entry.kind !== "developing-idea") ||
        (entry.author !== "user" && entry.author !== "ai") || typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt)) ||
        typeof entry.excerpt !== "string" || !entry.excerpt.trim() || entry.excerpt.length > SPRINGBOARD_EXCERPT_MAX) return null;
    if (entry.kind === "source") {
      if (entry.id !== entry.sourceId || entry.author !== "user" || entry.versionId !== undefined) return null;
      items.push({ id: entry.id, sourceId: entry.sourceId, kind: entry.kind, author: entry.author, createdAt: entry.createdAt, excerpt: entry.excerpt });
    } else {
      if (!isRecordId(entry.versionId)) return null;
      items.push({ id: entry.id, sourceId: entry.sourceId, kind: entry.kind, versionId: entry.versionId, author: entry.author, createdAt: entry.createdAt, excerpt: entry.excerpt });
    }
  }
  return new Set(items.map((entry) => `${entry.kind === "source" ? "source" : "item"}:${entry.id}`)).size === items.length ? { items } : null;
}
