import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Actor, ReadScope } from "../domain/rejection";
import type { RunSources } from "../domain/run";
import { nonEmpty, ValidationError } from "../domain/validation";
import { requireImportUser, requireSourceInspection, safeInteger, ImportNotFoundError, ImportPreservationError,
  type ImportBatch, type ImportFile, type ImportPage, type ImportPageCursor, type ImportPageRequest, type ImportPart,
  type ImportInspectionRepository, type ImportProvenance, type ImportSource, type Segmentation } from "../domain/markdown-import";
import { SqliteRunAggregate } from "./run-aggregate";
import { SqliteMarkdownImports } from "./markdown-import";

const sourceColumns = `d.id,d.original_namespace_id AS originalNamespaceId,d.original_path AS originalPath,
  lower(hex(d.sha256)) AS sha256,d.byte_length AS byteLength,d.encoding,d.created_at AS createdAt,d.parser_version AS parserVersion,
  d.segmentation_method AS method,d.segmentation_reason AS reason,
  (SELECT count(*) FROM import_document_parts p WHERE p.document_id=d.id AND p.kind='thought') AS thoughtCount`;
type SourceRow = Omit<ImportSource,"segmentation"> & {method:Segmentation["method"];reason:Segmentation["reason"]};

/** Explicit user inspection only. No joins into library/agent snapshots or automatic source expansion. */
export class SqliteImportInspection extends SqliteRunAggregate implements ImportInspectionRepository {
  private readonly imports: SqliteMarkdownImports;
  constructor(db: Database, sources: RunSources) { super(db,sources.logger); this.imports=new SqliteMarkdownImports(db,sources); }
  source(scope: ReadScope, documentId: string): ImportSource | null {
    requireSourceInspection(scope); nonEmpty(documentId,"documentId");
    return this.transaction("inspect import source",documentId,() => this.readSource(documentId));
  }
  private readSource(documentId: string): ImportSource | null {
    const row=this.db.query(`SELECT ${sourceColumns} FROM import_documents d JOIN import_document_seals s ON s.document_id=d.id WHERE d.id=?`).get(documentId) as SourceRow|null;
    if (!row) return null;
    const {method,reason,...source}=row;
    return {...source,segmentation:{method,reason} as Segmentation};
  }
  raw(scope: ReadScope, documentId: string): Uint8Array | null {
    requireSourceInspection(scope); nonEmpty(documentId,"documentId");
    return this.transaction("inspect original import bytes",documentId,() => {
      const row=this.db.query(`SELECT d.original_bytes AS bytes FROM import_documents d JOIN import_document_seals s ON s.document_id=d.id WHERE d.id=?`).get(documentId) as {bytes:Uint8Array}|null;
      return row ? new Uint8Array(row.bytes) : null;
    });
  }
  provenance(scope: ReadScope, thoughtId: string): {readonly importSource:ImportProvenance|null} | null {
    requireImportUser(scope?.actor);
    if (!["normal","history","show-rejected"].includes(scope.mode)) throw new ValidationError("Invalid read scope");
    nonEmpty(thoughtId,"thoughtId");
    return this.transaction("inspect thought import provenance",thoughtId,() => {
      const thought=this.db.query(`SELECT import_document_id AS documentId FROM thoughts WHERE id=? AND
        (?=1 OR NOT EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=thoughts.id))`).get(thoughtId,scope.mode==="normal" ? 0 : 1) as {documentId:string|null}|null;
      if (!thought) return null;
      if (thought.documentId===null) return {importSource:null};
      const part=this.db.query(`SELECT p.document_id AS documentId,p.thought_ordinal AS ordinal,p.start_byte AS startByte,p.end_byte AS endByte
        FROM import_document_parts p JOIN import_document_seals s ON s.document_id=p.document_id WHERE p.thought_id=? AND p.document_id=?`).get(thoughtId,thought.documentId) as ImportProvenance|null;
      if (!part) throw new ImportPreservationError("Imported thought has no sealed source mapping");
      return {importSource:part};
    });
  }
  sources(scope: ReadScope, request: ImportPageRequest = {}): ImportPage<ImportSource> {
    requireSourceInspection(scope);
    return this.transaction("list import sources","sources",() => this.page("sources",null,"history",request,"import_documents d JOIN import_document_seals s ON s.document_id=d.id","d.sequence","1",[],id => {
      const source=this.readSource(id); if (!source) throw new ImportPreservationError("Sealed source disappeared"); return source;
    },"d.id"));
  }
  parts(scope: ReadScope, documentId: string, request: ImportPageRequest = {}): ImportPage<ImportPart> {
    requireSourceInspection(scope); nonEmpty(documentId,"documentId");
    return this.transaction("list import parts",documentId,() => {
      if (!this.db.query("SELECT 1 FROM import_document_seals WHERE document_id=?").get(documentId)) throw new ImportNotFoundError();
      return this.page("parts",documentId,"history",request,"import_document_parts","position","document_id=?",[documentId],id => {
        const part=this.db.query(`SELECT position,kind,start_byte AS startByte,end_byte AS endByte,thought_id AS thoughtId,thought_ordinal AS ordinal,
          EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=p.thought_id) AS rejected
          FROM import_document_parts p WHERE document_id=? AND position=?`).get(documentId,Number(id)) as Omit<ImportPart,"rejected"> & {rejected:number}|null;
        if (!part) throw new ImportPreservationError("Sealed part disappeared");
        const {rejected,...value}=part;
        return part.kind==="thought" ? {...value,rejected:rejected===1} : value;
      },"CAST(position AS TEXT)");
    });
  }
  batches(actor: Actor, request: ImportPageRequest = {}): ImportPage<ImportBatch> {
    requireImportUser(actor);
    return this.transaction("list import batches","batches",() => this.page("batches",null,"user",request,"markdown_imports","sequence","1",[],id => {
      const batch=this.imports.batch(actor,id); if (!batch) throw new ImportNotFoundError(); return batch;
    },"id"));
  }
  files(actor: Actor, importId: string, request: ImportPageRequest = {}): ImportPage<ImportFile> {
    requireImportUser(actor); nonEmpty(importId,"importId");
    return this.transaction("list import files",importId,() => {
      if (!this.imports.batch(actor,importId)) throw new ImportNotFoundError();
      return this.page("files",importId,"user",request,"markdown_import_files","position","import_id=?",[importId],id => {
        const file=this.imports.file(actor,importId,id); if (!file) throw new ImportNotFoundError(); return file;
      },"id");
    });
  }
  private page<T>(kind: ImportPageCursor["kind"], parentId: string|null, scope: ImportPageCursor["scope"], request: ImportPageRequest,
    table: string, order: string, filter: string, params: SQLQueryBindings[], read: (id:string) => T, idColumn: string): ImportPage<T> {
    const limit=request.limit ?? request.cursor?.limit ?? 50;
    safeInteger(limit,"page limit"); if (limit<1 || limit>200) throw new ValidationError("Invalid import page limit");
    const cursor=request.cursor;
    if (cursor && (cursor.kind!==kind || cursor.parentId!==parentId || cursor.scope!==scope || cursor.limit!==limit ||
      safeInteger(cursor.after,"page after")>safeInteger(cursor.highWater,"page high-water"))) throw new ValidationError("Invalid import page continuation");
    const highWater=cursor?.highWater ?? (this.db.query(`SELECT COALESCE(MAX(${order}),-1) AS n FROM ${table} WHERE ${filter}`).get(...params) as {n:number}).n;
    const rows=this.db.query(`SELECT ${idColumn} AS id,${order} AS position FROM ${table} WHERE ${filter} AND ${order}>? AND ${order}<=? ORDER BY ${order} LIMIT ?`)
      .all(...params,cursor?.after ?? -1,highWater,limit+1) as {id:string;position:number}[];
    const items=rows.slice(0,limit).map(row => read(row.id)), last=rows[Math.min(limit,rows.length)-1];
    return {items,nextCursor:rows.length>limit && last ? {kind,parentId,scope,limit,after:last.position,highWater} : null};
  }
}
