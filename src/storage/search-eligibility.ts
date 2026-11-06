import type { Database } from "bun:sqlite";
import type { ContextRef } from "../domain/run";
import { SearchStorageError, searchString } from "../domain/agentic-search";
import { references } from "../domain/validation";

/** Trusted SQL expressions only; source existence/visibility is read from this transaction's real library state. */
export function searchEligibilitySql(kind: string, id: string): string {
  return `CASE ${kind}
    WHEN 'thought' THEN EXISTS (SELECT 1 FROM thoughts t WHERE t.id=${id}
      AND NOT EXISTS (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id))
    WHEN 'connection' THEN EXISTS (SELECT 1 FROM connections c WHERE c.id=${id}
      AND NOT EXISTS (SELECT 1 FROM rejected_connections r WHERE r.connection_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM rejected_thoughts r WHERE r.thought_id IN (c.from_id,c.to_id)))
    WHEN 'response' THEN EXISTS (SELECT 1 FROM responses r WHERE r.id=${id}
      AND EXISTS (SELECT 1 FROM response_thoughts a WHERE a.response_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM response_thoughts a JOIN rejected_thoughts x ON x.thought_id=a.thought_id WHERE a.response_id=r.id))
    ELSE 0 END`;
}
export function searchEvidence(json: string): readonly string[] {
  try {
    const ids = references(JSON.parse(json), "evidenceThoughtIds").map(id => searchString(id, "evidence thought ID"));
    if (new Set(ids).size !== ids.length) throw new SearchStorageError();
    return Object.freeze(ids);
  } catch { throw new SearchStorageError("invalid-retained-search-evidence"); }
}
export function mergeSearchReferences(...groups: readonly (readonly ContextRef[])[]): readonly ContextRef[] {
  const refs = new Map<string, ContextRef>();
  for (const group of groups) for (const ref of group) refs.set(`${ref.kind}\0${ref.id}`, ref);
  return Object.freeze([...refs.values()].map(ref => Object.freeze({ ...ref })));
}
export function searchReferencesEligible(db: Database, refs: readonly ContextRef[]): boolean {
  return !db.query(`SELECT 1 FROM json_each(CAST(? AS TEXT)) source
    WHERE NOT (${searchEligibilitySql("json_extract(source.value,'$.kind')", "json_extract(source.value,'$.id')")}) LIMIT 1`)
    .get(new TextEncoder().encode(JSON.stringify(refs)));
}
