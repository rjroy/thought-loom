import { SPRINGBOARD_RECENT_MAX, SPRINGBOARD_EXCERPT_MAX, parseRecentThoughts, type RecentThoughtsView } from "@thoughtloom/contracts";
import { openDatabase } from "./storage";

// Capture sources and current formulations are read in one bounded snapshot.
export function readRecentThoughts(databasePath: string, limit: number): RecentThoughtsView {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SPRINGBOARD_RECENT_MAX) throw new Error("Invalid recent limit");
  const db = openDatabase(databasePath);
  try {
    return db.transaction(() => {
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
      // Omit the inapplicable version field rather than representing it as null.
      const view = parseRecentThoughts({ items: items.map((row) => {
        if (typeof row !== "object" || row === null || !("versionId" in row) || !("excerpt" in row) || typeof row.excerpt !== "string") return row;
        const excerpt = row.excerpt.slice(0, SPRINGBOARD_EXCERPT_MAX).replace(/[\uD800-\uDBFF]$/u, "");
        if (row.versionId !== null) return { ...row, excerpt };
        const { versionId: _versionId, ...source } = row; return { ...source, excerpt };
      }) });
      if (!view) throw new Error("Invalid recent projection");
      return view;
    }).deferred();
  } finally { db.close(); }
}
