import type { Database } from "bun:sqlite";
import { isRecordId, SEARCH_QUERY_MAX_LENGTH, type SearchAlias } from "@thoughtloom/contracts";
import { compileQuery, type CompiledQuery } from "./fuzzy-matcher";
import { FuzzySearchError, type FuzzySearchWork } from "./fuzzy-search-work";

const MAX_ACTIVATED_RECORDS = 100, MAX_EXPANDED_KEYS = 4_096;
export type SearchVariant = Readonly<{ query: CompiledQuery; alias?: SearchAlias }>;
type Activation = {
  id: string; side: "alias" | "expansion"; canonicalId: string | null;
  aliasBytes: number | null; expansionBytes: number | null;
};
type AliasRow = Pick<SearchAlias, "id" | "alias" | "expansion" | "author">;

function aliasEvidence(db: Database, id: string): string[] {
  const statement = db.prepare<{ sourceId: string }, [string]>(
    "SELECT source_id AS sourceId FROM alias_evidence WHERE alias_id=? ORDER BY position");
  const ids: string[] = [];
  try {
    for (const row of statement.iterate(id)) {
      // Never silently truncate attribution to fit the wire contract.
      if (!isRecordId(row.sourceId) || ids.length >= 16 || ids.includes(row.sourceId)) {
        throw new FuzzySearchError("projection", "Unsupported alias evidence metadata");
      }
      ids.push(row.sourceId);
    }
    if (!ids.length) throw new FuzzySearchError("projection", "Missing alias evidence metadata");
    return ids;
  } finally { statement.finalize(); }
}

// One exact whole-key lookup, never a lookup on an expanded query. Ordered
// activation consumes <=100 records (not directions), with <=4096 keys across
// distinct normalized expansions. The first excluded expansion ends admission;
// no later smaller expansion is skipped in. Neither bound depends on result K.
export async function selectAliasVariants(
  db: Database, query: CompiledQuery, work: FuzzySearchWork,
): Promise<{ variants: readonly SearchVariant[]; truncated: boolean; longestQuery: number }> {
  const key = JSON.stringify(query.keys);
  const statement = db.prepare<Activation, [string]>(`SELECT k.alias_id AS id,k.side,a.id AS canonicalId,
    length(CAST(a.alias AS BLOB)) AS aliasBytes,length(CAST(a.expansion AS BLOB)) AS expansionBytes
    FROM fuzzy_alias_keys k LEFT JOIN search_aliases a ON a.id=k.alias_id
    WHERE k.normalized_key=? ORDER BY k.alias_id COLLATE BINARY,k.side COLLATE BINARY`);
  const read = db.prepare<AliasRow, [string]>("SELECT id,alias,expansion,author FROM search_aliases WHERE id=?");
  const variants = new Map<string, SearchVariant>();
  let records = 0, expandedKeys = 0, lastId: string | null = null, truncated = false, longestQuery = query.keys.length;
  try {
    for (const activation of statement.iterate(key)) {
      work.check();
      const newRecord = activation.id !== lastId;
      if (newRecord && records === MAX_ACTIVATED_RECORDS) { truncated = true; break; }
      await work.yield();
      if (activation.canonicalId === null || activation.aliasBytes === null || activation.expansionBytes === null ||
          !isRecordId(activation.id) || (activation.side !== "alias" && activation.side !== "expansion")) {
        throw new FuzzySearchError("projection", "Invalid alias lookup identity");
      }
      // A well-formed <=512-UTF16 alias side uses at most 3 UTF-8 bytes/unit.
      // Reject an unrepresentable expansion before materializing huge TEXT.
      if (activation.aliasBytes > SEARCH_QUERY_MAX_LENGTH * 3 || activation.expansionBytes > SEARCH_QUERY_MAX_LENGTH * 3) {
        truncated = true; break;
      }
      work.checkChunk(activation.aliasBytes + activation.expansionBytes);
      const row = read.get(activation.id);
      if (!row || (row.author !== "user" && row.author !== "ai")) throw new FuzzySearchError("projection", "Missing canonical alias");
      const active = compileQuery(row[activation.side]);
      if (!active || JSON.stringify(active.keys) !== key) throw new FuzzySearchError("projection", "Stale alias lookup key");
      const expandedQuery = row[activation.side === "alias" ? "expansion" : "alias"];
      const expanded = compileQuery(expandedQuery);
      if (!expanded) { truncated = true; break; }
      const expandedKey = JSON.stringify(expanded.keys), duplicate = variants.has(expandedKey);
      if (!duplicate && expandedKeys + expanded.keys.length > MAX_EXPANDED_KEYS) { truncated = true; break; }
      if (newRecord) { records++; lastId = activation.id; work.aliasRecords = records; }
      if (work.record(active.keys.length + expanded.keys.length)) await work.yield();
      if (duplicate) continue;
      // Identical normalized variants have identical matches/ranks. The first
      // binary alias-ID/direction is their canonical provenance for every target.
      const evidenceSourceIds = aliasEvidence(db, row.id);
      work.reserve(expanded.keys.reduce((bytes, part) => bytes + part.length * 2 + 96, 0) + expandedKey.length * 2 +
        (row.id.length + row.alias.length + row.expansion.length + evidenceSourceIds.join("").length) * 2 + 1_024);
      variants.set(expandedKey, { query: expanded, alias: { ...row, evidenceSourceIds,
        direction: activation.side === "alias" ? "alias-to-expansion" : "expansion-to-alias", expandedQuery } });
      expandedKeys += expanded.keys.length;
      longestQuery = Math.max(longestQuery, expanded.keys.length);
      work.aliasVariants = variants.size;
      work.aliasKeys = expandedKeys;
    }
  } finally { statement.finalize(); read.finalize(); }
  work.aliasExpansionTruncated = truncated;
  return { variants: [...variants.values()], truncated, longestQuery };
}
