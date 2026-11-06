import type { Database } from "bun:sqlite";
import { createConnection, type Connection } from "../domain/connection";
import { scopeActiveConnection } from "../domain/rejection";
import { createSharedResponse, scopeSharedResponse, type SharedResponse } from "../domain/shared-response";
import { searchEligibilitySql } from "./search-eligibility";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Targeted adapters for the existing AI-normal policies, without loading a whole rejection snapshot. */
export function readSearchConnection(db: Database, id: string): Connection | null {
  const row = db.query(`SELECT c.id,c.from_id AS fromId,c.to_id AS toId,c.category,c.proposed_by AS proposedBy,c.explanation
    FROM connections c WHERE c.id=CAST(? AS TEXT) AND ${searchEligibilitySql("'connection'","c.id")}`).get(text(id));
  if (!row) return null;
  const sources = db.query(`SELECT s.source_id AS id,r.thought_id IS NOT NULL AS rejected FROM connection_sources s
    LEFT JOIN rejected_thoughts r ON r.thought_id=s.source_id WHERE s.connection_id=CAST(? AS TEXT) ORDER BY s.position`)
    .all(text(id)) as { id: string; rejected: number }[];
  return scopeActiveConnection("ai",createConnection({ ...row, sourceIds: sources.map(source => source.id) }),
    new Set(sources.filter(source => source.rejected === 1).map(source => source.id)),new Set());
}

export function readSearchResponse(db: Database, id: string): SharedResponse | null {
  const row = db.query("SELECT id,text,role,state FROM responses WHERE id=CAST(? AS TEXT)").get(text(id));
  if (!row) return null;
  const members = db.query(`SELECT a.thought_id AS id,r.thought_id IS NOT NULL AS rejected FROM response_thoughts a
    LEFT JOIN rejected_thoughts r ON r.thought_id=a.thought_id WHERE a.response_id=CAST(? AS TEXT) ORDER BY a.position`)
    .all(text(id)) as { id: string; rejected: number }[];
  return scopeSharedResponse({ actor: "ai", mode: "normal" },createSharedResponse({ ...row, thoughtIds: members.map(member => member.id) }),
    members.filter(member => member.rejected === 1).map(member => member.id));
}
