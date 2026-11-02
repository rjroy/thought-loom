import type { Database } from "bun:sqlite";
import type { ThoughtTitle } from "@thoughtloom/contracts";

// Resolve the protected USER override/current-formulation decision once for all
// canonical readers and the derived indexed-search projection.
export function readTitle(db: Database, sourceId: string, itemId?: string, versionId?: string): { headRevisionId: string | null; title: ThoughtTitle | null } {
  const row = db.query<{ entityId: string; headRevisionId: string; revisionId: string; author: "user" | "ai"; text: string; formulationId: string | null }, [string]>(`
    SELECT e.id AS entityId,h.revision_id AS headRevisionId,r.id AS revisionId,r.author,r.text,r.formulation_id AS formulationId
    FROM title_entities e JOIN title_heads h ON h.entity_id=e.id
    JOIN title_revisions r ON r.id=COALESCE(h.user_revision_id,h.revision_id)
    WHERE ${itemId ? "e.item_id=?" : "e.source_id=?"}`).get(itemId ?? sourceId);
  if (!row) return { headRevisionId: null, title: null };
  const visible = row.author === "user" || !itemId || row.formulationId === versionId;
  if (visible) return { headRevisionId: row.headRevisionId, title: { revisionId: row.revisionId, author: row.author, text: row.text } };
  // A later formulation's generated title must not hide an older formulation's
  // own label. The entity-wide head is still the CAS fence, not this revision.
  const historical = versionId === undefined ? null : db.query<ThoughtTitle, [string, string]>(`SELECT id AS revisionId,author,text FROM title_revisions
    WHERE entity_id=? AND author='ai' AND formulation_id=? ORDER BY rowid DESC LIMIT 1`).get(row.entityId, versionId);
  return { headRevisionId: row.headRevisionId, title: historical };
}
