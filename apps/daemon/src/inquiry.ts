import type { Database } from "bun:sqlite";
import { INQUIRY_LIMITS as limits, parseInquiryView, type InquiryView, type Source, type ItemView, type RelationshipView, type FormulationView, type RelationshipVersionView, type EvidenceSource, type FollowUpVersionOrigin } from "@thoughtloom/contracts";
import { openDatabase, sourceRecord, sourceOrigin } from "./storage";
import { readIdeaDerivation } from "./knowledge";

function evidence(db: Database, table: "formulation_evidence" | "relationship_evidence", column: "formulation_id" | "revision_id", id: string): string[] {
  const rows = db.query<{ id: string }, [string]>(`SELECT source_id AS id FROM ${table} WHERE ${column}=? ORDER BY position LIMIT ${limits.evidencePerVersion + 1}`).all(id);
  if (rows.length > limits.evidencePerVersion) throw new Error("Inquiry evidence limit exceeded");
  return rows.map((row) => row.id);
}

// Classify each projected version from its actual mutation receipt/run, including
// neighboring roots. Source-local job lists are bounded status, not provenance.
function followUpOrigin(db: Database, table: "formulations" | "relationship_revisions", id: string): { followUp?: FollowUpVersionOrigin } {
  const entityColumn = table === "formulations" ? "item_id" : "relationship_id";
  const origin = db.query<FollowUpVersionOrigin, [string]>(`SELECT j.id AS jobId,j.source_id AS sourceId FROM ${table} v
    JOIN knowledge_receipts k ON k.operation_id=v.operation_id AND k.result_id=v.${entityColumn} AND k.revision_id=v.id
    JOIN weaving_runs r ON r.id=v.run_id JOIN jobs j ON j.id=r.job_id
    WHERE v.id=? AND v.author='ai' AND j.kind='follow_up'`).get(id);
  return origin ? { followUp: origin } : {};
}

function readItem(db: Database, id: string, selectedVersionId?: string): ItemView {
  const item = db.query<Pick<ItemView, "id" | "kind" | "sourceId">, [string]>("SELECT id,kind,source_id AS sourceId FROM knowledge_items WHERE id=?").get(id);
  if (!item) throw new Error("Missing inquiry item");
  const versions = db.query<Omit<FormulationView, "evidenceSourceIds"> & { sequence: number }, [string]>(`SELECT id,text,author,rowid AS sequence FROM formulations WHERE item_id=? ORDER BY rowid DESC LIMIT ${limits.history + 1}`).all(id);
  const retained = versions.slice(0, limits.history);
  if (selectedVersionId && !retained.some((version) => version.id === selectedVersionId)) {
    const selected = db.query<Omit<FormulationView, "evidenceSourceIds"> & { sequence: number }, [string, string]>("SELECT id,text,author,rowid AS sequence FROM formulations WHERE item_id=? AND id=?").get(id, selectedVersionId);
    if (!selected) throw new Error("Missing selected formulation");
    retained.pop(); retained.push(selected);
  }
  const history = retained.sort((a, b) => a.sequence - b.sequence).map(({ sequence: _sequence, ...version }) => ({ ...version, evidenceSourceIds: evidence(db, "formulation_evidence", "formulation_id", version.id), ...followUpOrigin(db, "formulations", version.id) }));
  const current = history.at(-1);
  if (!current) throw new Error("Missing inquiry formulation");
  const derivation = readIdeaDerivation(db, id);
  return { ...item, current, history, historyTruncated: versions.length > limits.history, ...(derivation ? { derivation } : {}) };
}

function readRelationship(db: Database, id: string): RelationshipView {
  const relation = db.query<Pick<RelationshipView, "id" | "fromItemId" | "toItemId" | "type">, [string]>("SELECT id,from_item_id AS fromItemId,to_item_id AS toItemId,type FROM relationships WHERE id=?").get(id);
  if (!relation) throw new Error("Missing inquiry relationship");
  const versions = db.query<Omit<RelationshipVersionView, "evidenceSourceIds">, [string]>(`SELECT id,status,rationale,author FROM relationship_revisions WHERE relationship_id=? ORDER BY rowid DESC LIMIT ${limits.history + 1}`).all(id);
  const history = versions.slice(0, limits.history).reverse().map((version) => ({ ...version, evidenceSourceIds: evidence(db, "relationship_evidence", "revision_id", version.id), ...followUpOrigin(db, "relationship_revisions", version.id) }));
  const current = history.at(-1);
  if (!current) throw new Error("Missing inquiry relationship revision");
  return { ...relation, current, history, historyTruncated: versions.length > limits.history };
}

// A read-only projection in the daemon, not a second domain-write service.
// Indexed lookups, finite fan-out/history and one transaction prevent a graph
// dump or a mixture of revisions from separate snapshots.
export function readInquiry(databasePath: string, sourceId: string, target?: { itemId: string; versionId: string }): InquiryView | null {
  console.info("inquiry.read attempt", { sourceId });
  let connection: Database | undefined;
  try {
    const db = openDatabase(databasePath);
    connection = db;
    const result = db.transaction((): InquiryView | null => {
      const source = sourceRecord(db, sourceId);
      if (!source) return null;
      if (target && !db.query(`SELECT 1 FROM knowledge_items i JOIN formulations f ON f.item_id=i.id WHERE i.id=? AND i.source_id=? AND f.id=?`).get(target.itemId, sourceId, target.versionId)) return null;
      const rootRows = db.query<{ id: string }, [string]>(`SELECT id FROM knowledge_items WHERE source_id=? ORDER BY rowid LIMIT ${limits.rootItems + 1}`).all(sourceId);
      const rootIds = rootRows.slice(0, limits.rootItems).map((row) => row.id);
      if (target && !rootIds.includes(target.itemId)) { if (rootIds.length === limits.rootItems) rootIds.pop(); rootIds.push(target.itemId); }
      const incident: { id: string; fromItemId: string; toItemId: string }[] = [];
      if (rootIds.length) {
        const parameters = rootIds.map(() => "?").join(",");
        // Separate indexed directions keep each scan finite even for a hub.
        for (const column of ["from_item_id", "to_item_id"]) {
          incident.push(...db.query<{ id: string; fromItemId: string; toItemId: string }, string[]>(`SELECT id,from_item_id AS fromItemId,to_item_id AS toItemId FROM relationships WHERE ${column} IN (${parameters}) LIMIT ${limits.relationships + 1}`).all(...rootIds));
        }
      }
      const unique = [...new Map(incident.map((row) => [row.id, row])).values()];
      const selected = unique.slice(0, limits.relationships);
      const itemIds = new Set(rootIds);
      for (const row of selected) { itemIds.add(row.fromItemId); itemIds.add(row.toItemId); }
      const items = [...itemIds].map((id) => readItem(db, id, target?.itemId === id ? target.versionId : undefined));
      const relationships = selected.map((row) => readRelationship(db, row.id));
      const sourceIds = new Set([sourceId, ...items.map((item) => item.sourceId)]);
      for (const item of items) for (const version of item.history) for (const id of version.evidenceSourceIds) sourceIds.add(id);
      for (const relation of relationships) for (const version of relation.history) for (const id of version.evidenceSourceIds) sourceIds.add(id);
      if (sourceIds.size > limits.evidenceSources) throw new Error("Inquiry source closure limit exceeded");
      const reference = db.query<EvidenceSource, [string]>("SELECT id,substr(text,1,240) AS excerpt,provenance,created_at AS createdAt FROM sources WHERE id=?");
      const evidenceSources = [...sourceIds].map((id) => {
        const ref = reference.get(id);
        if (!ref) throw new Error("Missing inquiry evidence source");
        return { ...ref, origin: sourceOrigin(db, id) };
      });
      const selectedVersion = target ? items.find((item) => item.id === target.itemId)?.history.find((version) => version.id === target.versionId) : undefined;
      if (target && !selectedVersion) throw new Error("Missing selected formulation");
      const view = parseInquiryView({ source, items, relationships, evidenceSources, truncated: rootRows.length > limits.rootItems || unique.length > limits.relationships,
        ...(target && selectedVersion ? { selectedTarget: { kind: "item", id: target.itemId, versionId: target.versionId, text: selectedVersion.text, author: selectedVersion.author, evidenceSourceIds: selectedVersion.evidenceSourceIds } } : {}) });
      if (!view) throw new Error("Invalid inquiry closure");
      return view;
    }).deferred();
    console.info("inquiry.read completed", { sourceId, found: result !== null });
    return result;
  } catch {
    console.error("inquiry.read failed", { sourceId, category: "read_model_unavailable" });
    throw new Error("Inquiry unavailable");
  } finally { connection?.close(); }
}
