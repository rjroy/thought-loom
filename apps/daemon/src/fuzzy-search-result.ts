import type { Database } from "bun:sqlite";
import type { SearchAlias, SearchResult } from "@thoughtloom/contracts";
import type { FieldMatch } from "./fuzzy-matcher";
import { boundedSourceExcerpt, type FuzzyPassage } from "./fuzzy-passage";
import { iterateTargetProjectionFields, type ProjectionField, type ProjectionTarget } from "./fuzzy-projection";
import type { FuzzySearchWork } from "./fuzzy-search-work";
import { sourceOrigin } from "./source-origin";
import { readTitle } from "./title-projection";

async function originalContext(db: Database, target: ProjectionTarget, work: FuzzySearchWork): Promise<string> {
  const head = db.query<{ titleRevisionId: string | null }, [string]>(
    "SELECT title_revision_id AS titleRevisionId FROM fuzzy_targets WHERE target_kind='source' AND target_id=?").get(target.sourceId);
  if (!head) throw new Error("Missing original context projection");
  const source: ProjectionTarget = { kind: "source", sourceId: target.sourceId,
    ...(head.titleRevisionId === null ? {} : { titleRevisionId: head.titleRevisionId }) };
  for (const field of iterateTargetProjectionFields(db, source, (length) => work.checkChunk(length))) {
    if (field.kind === "source-body") return boundedSourceExcerpt(field, work);
  }
  throw new Error("Missing original context field");
}

// Hydrate attribution and exact identities INSIDE the selection snapshot. This
// path deliberately never reads a full source/formulation body or creates a read
// witness; excerpts/passages cannot authorize later relationship writes.
export async function hydrateSearchResult(
  db: Database, field: ProjectionField, match: FieldMatch, passage: FuzzyPassage, work: FuzzySearchWork,
  alias?: SearchAlias,
): Promise<SearchResult> {
  const target = field.target;
  const size = db.query<{ bytes: number }, [string]>("SELECT length(CAST(provenance AS BLOB)) AS bytes FROM sources WHERE id=?").get(target.sourceId);
  if (!size) throw new Error("Missing search source attribution");
  work.checkChunk(size.bytes);
  work.reserve(size.bytes * 2);
  const source = db.query<{ provenance: string; createdAt: string }, [string]>(
    "SELECT provenance,created_at AS createdAt FROM sources WHERE id=?").get(target.sourceId);
  if (!source) throw new Error("Missing search source");
  let item: SearchResult["item"];
  if (target.kind === "item") {
    const row = db.query<{ kind: "interpretation" | "developing-idea"; author: "user" | "ai" }, [string, string]>(`
      SELECT i.kind,f.author FROM knowledge_items i JOIN formulations f ON f.item_id=i.id WHERE i.id=? AND f.id=?`)
      .get(target.itemId, target.formulationId);
    if (!row) throw new Error("Missing exact search formulation attribution");
    item = { id: target.itemId, formulationId: target.formulationId, ...row };
  }
  const title = readTitle(db, target.sourceId, target.kind === "item" ? target.itemId : undefined,
    target.kind === "item" ? target.formulationId : undefined).title;
  if ((title?.revisionId ?? undefined) !== target.titleRevisionId) throw new Error("Search title hydration identity mismatch");
  const fieldRevisionId = field.kind === "title" ? title?.revisionId : target.kind === "item" ? target.formulationId : target.sourceId;
  if (!fieldRevisionId) throw new Error("Missing matched field revision");
  const excerpt = field.kind === "source-body" ? passage.fragments[0]?.text ?? "" : await originalContext(db, target, work);
  return { sourceId: target.sourceId, matchOrigin: alias ? "alias" : field.kind === "title" ? "title" : item ? "interpretation" : "source",
    source: { ...source, excerpt, origin: sourceOrigin(db, target.sourceId) }, ...(item ? { item } : {}), ...(title ? { title } : {}),
    match: { ...match, field: field.kind, route: alias ? "alias" : "direct", fieldRevisionId }, passage, ...(alias ? { alias } : {}) };
}
