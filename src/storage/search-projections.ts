import type { Database } from "bun:sqlite";

/** Rebuild derived content only. Caller controls trigger lifetime; no canonical row or visibility epoch is changed. */
export function rebuildThoughtSearch(db: Database): void {
  db.exec(`DELETE FROM thought_search_fts;
    INSERT INTO thought_search_fts(thought_id,text,title)
      SELECT t.id,CASE WHEN t.kind='media-original' THEN coalesce(s.clarification,'') ELSE t.text END,m.title
      FROM thoughts t JOIN thought_titles m ON m.thought_id=t.id LEFT JOIN media_sources s ON s.source_thought_id=t.id;`);
}
export function rebuildResponseSearch(db: Database): void {
  db.exec(`DELETE FROM response_search_fts;
    INSERT INTO response_search_fts(response_id,text) SELECT id,text FROM responses;`);
}
