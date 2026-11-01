import type { Database } from "bun:sqlite";
import type { ThoughtTitle } from "@thoughtloom/contracts";
import { KnowledgeError } from "./knowledge";
import { readTitle } from "./title-projection";

export type TitleTarget = { kind: "source" } | { kind: "item"; itemId: string; versionId: string };
type TitleWrite = {
  sourceId: string; target: TitleTarget; text: string; expectedTitleRevisionId: string | null;
  author: "user" | "ai"; key: string; payloadHash: string;
};

export function validTitleTarget(db: Database, sourceId: string, target: TitleTarget): boolean {
  return target.kind === "source"
    ? !!db.query("SELECT 1 FROM sources WHERE id=?").get(sourceId)
    : !!db.query("SELECT 1 FROM knowledge_items i JOIN formulations f ON f.item_id=i.id WHERE i.source_id=? AND i.id=? AND f.id=?").get(sourceId, target.itemId, target.versionId);
}

// Callers validate input/authority and hold one IMMEDIATE transaction, including
// receipt replay. Title metadata never passes through semantic knowledge writes.
export function writeTitle(db: Database, input: TitleWrite): ThoughtTitle {
  const receipt = db.query<ThoughtTitle & { hash: string }, [string]>(`SELECT c.payload_hash AS hash,r.id AS revisionId,r.text,r.author
    FROM title_receipts c JOIN title_revisions r ON r.id=c.revision_id WHERE c.idempotency_key=?`).get(input.key);
  if (receipt) {
    if (receipt.hash !== input.payloadHash || receipt.author !== input.author) throw new KnowledgeError("operation_conflict");
    return { revisionId: receipt.revisionId, text: receipt.text, author: receipt.author };
  }
  const { sourceId, target } = input;
  if (!validTitleTarget(db, sourceId, target)) throw new KnowledgeError("invalid_reference");
  if (input.author === "ai" && target.kind === "item") {
    // Only NEW writes require the current formulation. An exact receipt replay
    // above acknowledges its original version without retargeting or writing.
    const current = db.query<{ id: string }, [string]>("SELECT id FROM formulations WHERE item_id=? ORDER BY rowid DESC LIMIT 1").get(target.itemId);
    if (current?.id !== target.versionId) throw new KnowledgeError("version_conflict");
  }
  const itemId = target.kind === "item" ? target.itemId : undefined;
  const versionId = target.kind === "item" ? target.versionId : undefined;
  if (readTitle(db, sourceId, itemId, versionId).headRevisionId !== input.expectedTitleRevisionId) throw new KnowledgeError("version_conflict");
  let entity = db.query<{ id: string }, [string]>(`SELECT id FROM title_entities WHERE ${itemId ? "item_id" : "source_id"}=?`).get(itemId ?? sourceId);
  if (!entity) {
    entity = { id: crypto.randomUUID() };
    db.run("INSERT INTO title_entities(id,source_id,item_id) VALUES (?,?,?)", [entity.id, itemId ? null : sourceId, itemId ?? null]);
  }
  const revisionId = crypto.randomUUID();
  db.run("INSERT INTO title_revisions(id,entity_id,text,author,formulation_id,created_at) VALUES (?,?,?,?,?,?)",
    [revisionId, entity.id, input.text, input.author, versionId ?? null, new Date().toISOString()]);
  // A generated revision advances the CAS head, never the entity-wide user label.
  db.run(`INSERT INTO title_heads(entity_id,revision_id,user_revision_id) VALUES (?,?,?) ON CONFLICT(entity_id) DO UPDATE SET
    revision_id=excluded.revision_id,user_revision_id=COALESCE(excluded.user_revision_id,title_heads.user_revision_id)`,
    [entity.id, revisionId, input.author === "user" ? revisionId : null]);
  db.run("INSERT INTO title_receipts(idempotency_key,payload_hash,revision_id) VALUES (?,?,?)", [input.key, input.payloadHash, revisionId]);
  const effective = readTitle(db, sourceId, itemId, versionId).title;
  if (!effective) throw new KnowledgeError("storage_error");
  db.run("DELETE FROM title_search WHERE entity_id=?", [entity.id]);
  db.run("INSERT INTO title_search(entity_id,text) VALUES (?,?)", [entity.id, effective.text]);
  return { revisionId, text: input.text, author: input.author };
}
