import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createThought, type TextThought } from "../../src/domain/thought";
import type { SqliteStore } from "../../src/storage/sqlite";
import { mediaAdmissionSnapshot } from "./media-admission";
import { mediaTime } from "./media-source";

export function unjournaledMediaInterpretation(parentId: string): TextThought {
  const thought: TextThought = { id: "unjournaled-media-interpretation", text: "A structurally valid AI interpretation without delivery evidence",
    title: "Unjournaled interpretation", titleAuthor: "ai", author: "ai", kind: "ai-interpretation",
    createdAt: mediaTime, origin: "weave", parentId, sourceIds: [] };
  // A malformed Thought or absent parent must not satisfy the publication-policy denial under test.
  expect(createThought(thought)).toEqual(thought);
  return thought;
}

export function mediaPublicationSnapshot(db: Database) {
  return [...mediaAdmissionSnapshot(db), ...["media_store", "run_media_parts", "search_revision", "search_revisions", "thought_search_fts"]
    .map(table => ({ table, rows: db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() }))];
}

/** Exercise only the supported generic facade. There is no media-specific public error protocol to invent here. */
export function expectGenericPublicationDenied(db: Database, other: Database, store: SqliteStore, child: TextThought): void {
  if (child.parentId === null) throw new Error("Expected the candidate's explicit media parent");
  const parent = store.getThought(child.parentId);
  expect(parent).not.toBeNull();
  if (parent === null || parent.kind !== "media-original") throw new Error("Expected a genuinely persisted media parent");
  expect(store.getThought(child.id)).toBeNull();
  const before = mediaPublicationSnapshot(db);
  let denied = false;
  // Setup, domain-validity and existing-row witnesses are outside the catch; only saveThought's own refusal is captured.
  try { store.saveThought(child); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    denied = true;
  }

  // First desired assertion exposes an actual wrongly committed child on RED, rather than a missing import or error label.
  expect(db.query("SELECT id,author,kind,parent_id FROM thoughts WHERE id=?").all(child.id)).toEqual([]);
  expect(denied).toBe(true);
  expect(store.getThought(child.id)).toBeNull();
  expect(db.query("SELECT * FROM thought_titles WHERE thought_id=?").all(child.id)).toEqual([]);
  expect(db.query("SELECT * FROM thought_source_seals WHERE thought_id=?").all(child.id)).toEqual([]);
  expect(db.query("SELECT * FROM thought_sources WHERE thought_id=?").all(child.id)).toEqual([]);
  expect(db.inTransaction).toBe(false);
  expect(mediaPublicationSnapshot(db)).toEqual(before);
  expect(mediaPublicationSnapshot(other)).toEqual(before);
  expect(store.getThought(parent.id)).toEqual(parent);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}
