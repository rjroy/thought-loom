import type { Database } from "bun:sqlite";
import { importRequestKey } from "../domain/markdown-import-contract";
import { createMediaSource, createThought, type MediaSource, type MediaThought, type Thought } from "../domain/thought";
import { nonEmpty, record, ValidationError } from "../domain/validation";
import { immediate } from "./transaction";

export interface MediaSourceWrite { readonly thought: MediaThought; readonly requestKey: string; readonly sha256: Uint8Array }
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
interface SourceRow { readonly thoughtId: string; readonly id: string; readonly name: string; readonly mimeType: string;
  readonly byteLength: number; readonly clarification: string | null }

/** Trusted internal metadata, never a file-open capability. Callers apply their existing read scope first. */
export function storedThoughts(db: Database, inputs: readonly unknown[]): Thought[] {
  const rows = inputs.map(record), ids = rows.filter(row => row.kind === "media-original").map(row => nonEmpty(row.id,"id"));
  const byThought = storedMediaSources(db, ids);
  return rows.map(row => row.kind === "media-original"
    ? createThought({...row,mediaSource:requiredMediaSource(byThought,nonEmpty(row.id,"id"))}) : createThought(row));
}

/** Batch descriptor projection. This supplies metadata, not authorization to retrieve original bytes. */
export function storedMediaSources(db: Database, ids: readonly string[]): ReadonlyMap<string, MediaSource> {
  const sources = ids.length ? db.query<SourceRow, [string]>(`SELECT source_thought_id AS thoughtId,id,display_name AS name,
    mime_type AS mimeType,byte_length AS byteLength,clarification FROM media_sources
    WHERE source_thought_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) : [];
  return new Map(sources.map(({thoughtId,...source}): [string, MediaSource] => [thoughtId,createMediaSource({
    ...source,fileAuthorship:"unverified",clarificationAuthor:source.clarification === null ? null : "user",
  })]));
}
export function requiredMediaSource(sources: ReadonlyMap<string, MediaSource>, thoughtId: string): MediaSource {
  const source = sources.get(thoughtId);
  if (!source) throw new ValidationError("Media source association unavailable");
  return source;
}
export function storedThought(db: Database, input: unknown): Thought {
  const thought = storedThoughts(db,[input])[0];
  if (!thought) throw new ValidationError("Thought unavailable");
  return thought;
}

export function mediaStoreId(db: Database): string | null {
  const row = db.query<{ store_id: string }, []>("SELECT store_id FROM media_store WHERE singleton=1").get();
  return row === null ? null : nonEmpty(row.store_id,"storeId");
}
export function initializeMediaStore(db: Database, supplied: string): string {
  const id = nonEmpty(supplied,"storeId");
  return immediate(db,() => {
    const saved = mediaStoreId(db);
    if (saved !== null) {
      if (saved !== id) throw new ValidationError("Media store identity differs");
      return saved;
    }
    db.run("INSERT INTO media_store(singleton,store_id) VALUES (1,CAST(? AS TEXT))",[text(id)]);
    return id;
  });
}
/** Supplied IDs/digest are daemon-owned inputs. Filesystem publication and normal weave scheduling are separate operations. */
export function saveMediaSource(db: Database, input: MediaSourceWrite): void {
  const thought = createThought(input.thought), key = importRequestKey(input.requestKey);
  if (thought.kind !== "media-original" || thought.title !== null || thought.titleAuthor != null) throw new ValidationError("A new media root must be untitled");
  if (!(input.sha256 instanceof Uint8Array) || input.sha256.length !== 32) throw new ValidationError("Invalid media digest");
  const digest = new Uint8Array(input.sha256), source = thought.mediaSource;
  immediate(db,() => {
    if (mediaStoreId(db) === null) throw new ValidationError("Media store identity is not initialized");
    db.run(`INSERT INTO media_sources(id,source_thought_id,request_key,display_name,mime_type,byte_length,sha256,clarification,created_at)
      VALUES (CAST(? AS TEXT),CAST(? AS TEXT),?,CAST(? AS TEXT),?,?,?,CAST(? AS TEXT),?)`,
    [text(source.id),text(thought.id),key,text(source.name),source.mimeType,source.byteLength,digest,
      source.clarification === null ? null : text(source.clarification),thought.createdAt]);
    db.run(`INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id)
      VALUES (CAST(? AS TEXT),NULL,'source','media-original',?,'media-import',NULL)`,[text(thought.id),thought.createdAt]);
    db.run("INSERT INTO thought_titles(thought_id,title,title_author) VALUES (CAST(? AS TEXT),NULL,NULL)",[text(thought.id)]);
    db.run("INSERT INTO thought_source_seals(thought_id) VALUES (CAST(? AS TEXT))",[text(thought.id)]);
  });
}
