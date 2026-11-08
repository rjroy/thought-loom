import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { MediaThought } from "../../src/domain/thought";
import type { SqliteStore } from "../../src/storage/sqlite";
import { immediate } from "../../src/storage/transaction";

export const mediaTime = "2030-01-02T03:04:05.000Z";
export const mediaStoreId = "00000000-0000-4000-8000-000000000001";
// Metadata persistence has no format-decoding responsibility. No binary is stored in SQLite.
export const mediaBytes = new TextEncoder().encode("binarypayloadvault extractedtextvault");
export const mediaDigest = new Uint8Array(createHash("sha256").update(mediaBytes).digest());
export const mediaThought: MediaThought = {
  id: "media-root", text: null, title: null, titleAuthor: null, author: "source", kind: "media-original",
  createdAt: mediaTime, origin: "media-import", parentId: null, sourceIds: [],
  mediaSource: { id: "00000000-0000-4000-8000-000000000002", name: "filenamevault.png", mimeType: "image/png",
    byteLength: mediaBytes.length, fileAuthorship: "unverified", clarification: "\uFEFF  Zircon clarification\r\n  漢字  ", clarificationAuthor: "user" },
};

/** Assert the missing migration behavior before any test queries a new table. */
export function requireMediaSchema(db: Database): void {
  const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
  expect(names).toEqual(expect.arrayContaining(["media_store", "media_sources"]));
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
}

export interface MediaSourceWrite {
  readonly thought: MediaThought;
  readonly requestKey: string;
  readonly sha256: Uint8Array;
}
export interface MediaMetadataWrites {
  mediaStoreId(): string | null;
  initializeMediaStore(storeId: string): string;
  saveMediaSource(input: MediaSourceWrite): void;
}

/** New internal facade methods fail as behavior assertions, never unresolved imports. */
export function requireMediaWriter(store: SqliteStore): asserts store is SqliteStore & MediaMetadataWrites {
  for (const name of ["mediaStoreId", "initializeMediaStore", "saveMediaSource"]) {
    expect(typeof Reflect.get(store, name)).toBe("function");
    if (typeof Reflect.get(store, name) !== "function") throw new Error(`Missing media metadata storage operation: ${name}`);
  }
}

/** Controlled SQL isolates projection/constraint tests from the dedicated writer's implementation. */
export function insertMediaSource(db: Database, thought: MediaThought = mediaThought, requestKey = "media-fixture"): void {
  immediate(db, () => {
    db.run(`INSERT INTO media_sources(id,source_thought_id,request_key,display_name,mime_type,byte_length,sha256,clarification,created_at)
      VALUES (?,?,?,?,?,?,?,CAST(? AS TEXT),?)`, [thought.mediaSource.id, thought.id, requestKey, thought.mediaSource.name,
      thought.mediaSource.mimeType, thought.mediaSource.byteLength, mediaDigest,
      thought.mediaSource.clarification === null ? null : new TextEncoder().encode(thought.mediaSource.clarification), thought.createdAt]);
    db.run(`INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id)
      VALUES (?,NULL,'source','media-original',?,'media-import',NULL)`, [thought.id, thought.createdAt]);
    db.run("INSERT INTO thought_titles(thought_id,title,title_author) VALUES (?,?,?)", [thought.id, thought.title, thought.titleAuthor ?? null]);
    db.run("INSERT INTO thought_source_seals(thought_id) VALUES (?)", [thought.id]);
  });
}

export function initializeSqlMediaStore(db: Database): void {
  requireMediaSchema(db);
  expect(db.query("SELECT * FROM media_store").all()).toEqual([]);
  db.run("INSERT INTO media_store(singleton,store_id) VALUES (1,?)", [mediaStoreId]);
}
