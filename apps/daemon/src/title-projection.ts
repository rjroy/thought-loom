import type { Database } from "bun:sqlite";
import type { ThoughtTitle } from "@thoughtloom/contracts";

type TitleIdentity = Pick<ThoughtTitle, "revisionId" | "author">;

// Identity-only resolution lets the streaming reader check an effective head
// without loading a potentially huge canonical title. Both readers share this
// USER-override/current-formulation decision, not a second title policy.
export function readTitleIdentity(db: Database, sourceId: string, itemId?: string, versionId?: string): { headRevisionId: string | null; title: TitleIdentity | null } {
  const row = db.query<{ entityId: string; headRevisionId: string; revisionId: string; author: "user" | "ai"; formulationId: string | null }, [string]>(`
    SELECT e.id AS entityId,h.revision_id AS headRevisionId,r.id AS revisionId,r.author,r.formulation_id AS formulationId
    FROM title_entities e JOIN title_heads h ON h.entity_id=e.id
    JOIN title_revisions r ON r.id=COALESCE(h.user_revision_id,h.revision_id)
    WHERE ${itemId ? "e.item_id=?" : "e.source_id=?"}`).get(itemId ?? sourceId);
  if (!row) return { headRevisionId: null, title: null };
  const visible = row.author === "user" || !itemId || row.formulationId === versionId;
  if (visible) return { headRevisionId: row.headRevisionId, title: { revisionId: row.revisionId, author: row.author } };
  // A later formulation's generated title must not hide an older formulation's
  // own label. The entity-wide head is still the CAS fence, not this revision.
  const historical = versionId === undefined ? null : db.query<TitleIdentity, [string, string]>(`SELECT id AS revisionId,author FROM title_revisions
    WHERE entity_id=? AND author='ai' AND formulation_id=? ORDER BY rowid DESC LIMIT 1`).get(row.entityId, versionId);
  return { headRevisionId: row.headRevisionId, title: historical };
}

// The head remains the CAS fence even if an AI label describes another version.
export function readTitle(db: Database, sourceId: string, itemId?: string, versionId?: string): { headRevisionId: string | null; title: ThoughtTitle | null } {
  const resolved = readTitleIdentity(db, sourceId, itemId, versionId);
  if (!resolved.title) return { headRevisionId: resolved.headRevisionId, title: null };
  const row = db.query<{ text: string }, [string]>("SELECT text FROM title_revisions WHERE id=?").get(resolved.title.revisionId);
  if (!row) throw new Error("Effective title revision is missing");
  return { headRevisionId: resolved.headRevisionId, title: { ...resolved.title, text: row.text } };
}
