import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MediaThought } from "../../src/domain/thought";
import { migrate } from "../../src/storage/sqlite";
import { immediate } from "../../src/storage/transaction";
import { initializeSqlMediaStore, insertMediaSource, mediaTime } from "./media-source";

const retainedTables = ["media_store", "media_sources", "thoughts", "thought_titles", "thought_sources", "thought_source_seals"];
export interface RetainedMediaChild { readonly id: string; readonly text: string }
function retained(db: Database) {
  return retainedTables.map(table => ({ table, rows: db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() }));
}

/** Pre-firewall data, not an independently frozen released schema: the change was an application-writer guard.
 * Bootstrap the compatible SQL schema, retain only a historical child/title/empty source seal, then retire that connection.
 * No production writer mode, run receipt, issued association, media attempt or binary observation is manufactured.
 */
export function mediaChildPredecessor(thought: MediaThought, child: RetainedMediaChild, action: (db: Database) => void): void {
  const directory = mkdtempSync(join("/tmp/opencode", "media-child-predecessor-")), path = join(directory, "owned.sqlite");
  try {
    const predecessor = new Database(path);
    let before: ReturnType<typeof retained>;
    try {
      migrate(predecessor);
      initializeSqlMediaStore(predecessor);
      insertMediaSource(predecessor, thought);
      immediate(predecessor, () => {
        predecessor.run(`INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id,import_document_id)
          VALUES (?,CAST(? AS TEXT),'ai','ai-interpretation',?,'weave',?,NULL)`, [child.id, new TextEncoder().encode(child.text), mediaTime, thought.id]);
        predecessor.run("INSERT INTO thought_titles(thought_id,title,title_author) VALUES (?,NULL,NULL)", [child.id]);
        predecessor.run("INSERT INTO thought_source_seals(thought_id) VALUES (?)", [child.id]);
      });
      expect(predecessor.query(`SELECT child.id,child.parent_id,parent.kind AS parent_kind FROM thoughts child
        JOIN thoughts parent ON parent.id=child.parent_id WHERE child.id=?`).get(child.id))
        .toEqual({ id: child.id, parent_id: thought.id, parent_kind: "media-original" });
      for (const table of ["run_operation_receipts", "run_issued_thoughts", "media_weave_attempts", "run_media_parts"]) {
        expect(predecessor.query(`SELECT * FROM ${table}`).all()).toEqual([]);
      }
      expect(predecessor.query("PRAGMA foreign_key_check").all()).toEqual([]);
      before = retained(predecessor);
    } finally { predecessor.close(); }

    const upgraded = new Database(path);
    try {
      migrate(upgraded);
      expect(retained(upgraded)).toEqual(before);
      expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { upgraded.close(); }

    const reopened = new Database(path);
    try {
      migrate(reopened);
      expect(retained(reopened)).toEqual(before);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      action(reopened);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
