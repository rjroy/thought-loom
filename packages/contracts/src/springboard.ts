import { isRecordId } from "./inspection";

export const SPRINGBOARD_RECENT_MAX = 32;
export const SPRINGBOARD_RANDOM_MAX = 32;
export const SPRINGBOARD_EXCERPT_MAX = 240;
export type RecentThought = { id: string; sourceId: string; kind: "source" | "interpretation" | "developing-idea";
  versionId?: string; author: "user" | "ai"; createdAt: string; excerpt: string };
export type RecentThoughtsView = { items: RecentThought[] };
export type SpringboardThought = Omit<RecentThought, "createdAt"> & { createdAt: string | null; selection: "recent" | "random" };
export type SpringboardView = { items: SpringboardThought[] };

function thought(value: unknown, allowUnknownDate: boolean): Omit<SpringboardThought, "selection"> | null {
  if (typeof value !== "object" || value === null || !("id" in value) || !("sourceId" in value) || !("kind" in value) || !("author" in value) || !("createdAt" in value) || !("excerpt" in value)) return null;
  if (!isRecordId(value.id) || !isRecordId(value.sourceId) ||
      (value.kind !== "source" && value.kind !== "interpretation" && value.kind !== "developing-idea") ||
      (value.author !== "user" && value.author !== "ai") ||
      (!(typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))) && !(allowUnknownDate && value.createdAt === null)) ||
      typeof value.excerpt !== "string" || !value.excerpt.trim() || value.excerpt.length > SPRINGBOARD_EXCERPT_MAX) return null;
  const createdAt = value.createdAt;
  if (typeof createdAt !== "string" && createdAt !== null) return null;
  if (value.kind === "source") {
    if (value.id !== value.sourceId || value.author !== "user" || ("versionId" in value && value.versionId !== undefined) || createdAt === null) return null;
    return { id: value.id, sourceId: value.sourceId, kind: value.kind, author: value.author, createdAt, excerpt: value.excerpt };
  }
  if (!("versionId" in value) || !isRecordId(value.versionId)) return null;
  return { id: value.id, sourceId: value.sourceId, kind: value.kind, versionId: value.versionId, author: value.author, createdAt, excerpt: value.excerpt };
}

export function parseRecentThoughts(value: unknown): RecentThoughtsView | null {
  if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items) || value.items.length > SPRINGBOARD_RECENT_MAX) return null;
  const items: RecentThought[] = [];
  for (const entry of value.items) {
    const parsed = thought(entry, false);
    if (!parsed || parsed.createdAt === null) return null;
    items.push({ ...parsed, createdAt: parsed.createdAt });
  }
  return new Set(items.map((entry) => `${entry.kind === "source" ? "source" : "item"}:${entry.id}`)).size === items.length ? { items } : null;
}

export function parseSpringboardView(value: unknown): SpringboardView | null {
  if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items) || value.items.length > SPRINGBOARD_RECENT_MAX + SPRINGBOARD_RANDOM_MAX) return null;
  const items: SpringboardThought[] = [];
  let randomSeen = false, recentCount = 0, randomCount = 0;
  for (const entry of value.items) {
    if (typeof entry !== "object" || entry === null || !("selection" in entry) || (entry.selection !== "recent" && entry.selection !== "random")) return null;
    const parsed = thought(entry, entry.selection === "random");
    if (!parsed || (entry.selection === "recent" && (randomSeen || parsed.createdAt === null))) return null;
    if (entry.selection === "random") { randomSeen = true; randomCount++; } else recentCount++;
    items.push({ ...parsed, selection: entry.selection });
  }
  if (recentCount > SPRINGBOARD_RECENT_MAX || randomCount > SPRINGBOARD_RANDOM_MAX || new Set(items.map((entry) => `${entry.kind === "source" ? "source" : "item"}:${entry.id}`)).size !== items.length) return null;
  return { items };
}
