import type { Database } from "bun:sqlite";
import { SPRINGBOARD_RECENT_MAX, SPRINGBOARD_RANDOM_MAX, SPRINGBOARD_EXCERPT_MAX, parseRecentThoughts, parseSpringboardView, type RecentThoughtsView, type SpringboardView } from "@thoughtloom/contracts";
import { openDatabase } from "./storage";
import { readTitle } from "./title-projection";

function projection(db: Database, row: unknown): unknown {
  if (typeof row !== "object" || row === null || !("versionId" in row) || !("excerpt" in row) || typeof row.excerpt !== "string" || !("sourceId" in row) || typeof row.sourceId !== "string" || !("id" in row) || typeof row.id !== "string") return row;
  const excerpt = row.excerpt.slice(0, SPRINGBOARD_EXCERPT_MAX).replace(/[\uD800-\uDBFF]$/u, "");
  const title = readTitle(db, row.sourceId, row.versionId === null ? undefined : row.id, typeof row.versionId === "string" ? row.versionId : undefined).title;
  if (row.versionId !== null) return { ...row, excerpt, ...(title ? { title } : {}) };
  const { versionId: _versionId, ...source } = row; return { ...source, excerpt, ...(title ? { title } : {}) };
}

function recentInSnapshot(db: Database, limit: number): RecentThoughtsView {
  const items = db.query(`WITH recent_sources AS (
        SELECT s.id AS id,s.id AS sourceId,'source' AS kind,NULL AS versionId,'user' AS author,s.created_at AS createdAt,substr(ltrim(s.text,char(32)||char(9)||char(10)||char(13)),1,?) AS excerpt
          FROM sources s WHERE NOT EXISTS (SELECT 1 FROM dialogue_turns t WHERE t.source_id=s.id)
          ORDER BY s.created_at DESC,s.id ASC LIMIT ?
      ), recent_items AS (
        SELECT i.id,i.source_id AS sourceId,i.kind,f.id AS versionId,f.author,i.created_at AS createdAt,substr(ltrim(f.text,char(32)||char(9)||char(10)||char(13)),1,?) AS excerpt
          FROM knowledge_items i JOIN formulations f ON f.rowid=(SELECT rowid FROM formulations WHERE item_id=i.id ORDER BY rowid DESC LIMIT 1)
          WHERE i.created_at IS NOT NULL
          ORDER BY i.created_at DESC,i.kind ASC,i.id ASC LIMIT ?
      ) SELECT * FROM recent_sources UNION ALL SELECT * FROM recent_items ORDER BY createdAt DESC,kind ASC,id ASC LIMIT ?`).all(SPRINGBOARD_EXCERPT_MAX, limit, SPRINGBOARD_EXCERPT_MAX, limit, limit);
  const view = parseRecentThoughts({ items: items.map((row) => projection(db, row)) });
  if (!view) throw new Error("Invalid recent projection");
  return view;
}

// Capture sources and current formulations are read in one bounded snapshot.
export function readRecentThoughts(databasePath: string, limit: number): RecentThoughtsView {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SPRINGBOARD_RECENT_MAX) throw new Error("Invalid recent limit");
  const db = openDatabase(databasePath);
  try {
    return db.transaction(() => recentInSnapshot(db, limit)).deferred();
  } finally { db.close(); }
}

export function readSpringboard(databasePath: string, recentLimit: number, randomLimit: number): SpringboardView {
  if (!Number.isSafeInteger(recentLimit) || recentLimit < 1 || recentLimit > SPRINGBOARD_RECENT_MAX ||
      !Number.isSafeInteger(randomLimit) || randomLimit < 1 || randomLimit > SPRINGBOARD_RANDOM_MAX) throw new Error("Invalid springboard limits");
  const db = openDatabase(databasePath);
  try {
    return db.transaction(() => {
      const recent = recentInSnapshot(db, recentLimit).items;
      const sources = recent.filter((entry) => entry.kind === "source").map((entry) => entry.id);
      const items = recent.filter((entry) => entry.kind !== "source").map((entry) => entry.id);
      const excludeSources = sources.length ? ` AND s.id NOT IN (${sources.map(() => "?").join(",")})` : "";
      const excludeItems = items.length ? ` AND i.id NOT IN (${items.map(() => "?").join(",")})` : "";
      // SQLite samples the eligible union; only the requested bounded rows cross
      // into JavaScript. Exclusions are exact entity identities, not root IDs.
      const sampled = db.query<unknown, (string | number)[]>(`SELECT * FROM (
        SELECT s.id AS id,s.id AS sourceId,'source' AS kind,NULL AS versionId,'user' AS author,s.created_at AS createdAt,substr(ltrim(s.text,char(32)||char(9)||char(10)||char(13)),1,?) AS excerpt
          FROM sources s WHERE NOT EXISTS (SELECT 1 FROM dialogue_turns t WHERE t.source_id=s.id)${excludeSources}
        UNION ALL
        SELECT i.id,i.source_id AS sourceId,i.kind,f.id AS versionId,f.author,i.created_at AS createdAt,substr(ltrim(f.text,char(32)||char(9)||char(10)||char(13)),1,?) AS excerpt
          FROM knowledge_items i JOIN formulations f ON f.rowid=(SELECT rowid FROM formulations WHERE item_id=i.id ORDER BY rowid DESC LIMIT 1) WHERE 1=1${excludeItems}
      ) ORDER BY random() LIMIT ?`).all(SPRINGBOARD_EXCERPT_MAX, ...sources, SPRINGBOARD_EXCERPT_MAX, ...items, randomLimit);
      const random = sampled.map((row) => {
        const value = projection(db, row);
        return typeof value === "object" && value !== null ? { ...value, selection: "random" } : value;
      });
      const view = parseSpringboardView({ items: [...recent.map((entry) => ({ ...entry, selection: "recent" })), ...random] });
      if (!view) throw new Error("Invalid springboard projection");
      return view;
    }).deferred();
  } finally { db.close(); }
}
