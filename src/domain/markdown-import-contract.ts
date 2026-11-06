import type { Actor, ReadScope } from "./rejection";
import type { Claim, RunStatus } from "./run";
import { protocolJson } from "./run-protocol";
import { nonEmpty, oneOf, record, ValidationError } from "./validation";


export class ImportConflictError extends Error {}
export class ImportNotFoundError extends Error {}
export class ImportPreservationError extends Error {}
export class ImportForbiddenError extends Error {}
export type ImportFailureCode = "parse-failed" | "preservation-failed" | "digest-collision" | "persistence-failed" | "ownership-conflict";
export interface ImportNamespace { readonly id: string; readonly kind: string; readonly label: string; readonly createdAt: string }
export type Segmentation = { readonly method: "ai" | "not-needed"; readonly reason: null }
  | { readonly method: "structural"; readonly reason: "ai-unconfigured" | "ai-unavailable" | "ai-failed" | "ai-invalid" | "ai-context-unavailable" };
export interface ByteRange { readonly startByte: number; readonly endByte: number }
export interface ImportPartRange extends ByteRange { readonly kind: "thought" | "separator" | "frontmatter" | "bom" }
/** Parser-owned, complete top-level/dependency-safe atoms; cuts precede atoms, with one final endpoint. */
export interface ImportManifest {
  readonly version: 1;
  readonly parserVersion: string;
  readonly atoms: readonly ByteRange[];
  readonly cuts: readonly { readonly id: string; readonly offset: number }[];
}
export interface ImportPartition {
  readonly manifest: ImportManifest;
  readonly cuts: readonly string[];
  readonly parts: readonly ImportPartRange[];
  readonly segmentation: Segmentation;
}
/** Private, daemon-observed native facts; never a model-selected completion or consumer artifact. */
export interface ImportTerminalEvidence {
  readonly sessionId: string; readonly promptId: string;
  readonly inputSha256: string; readonly userMessageId: string; readonly assistantMessageId: string | null;
  readonly idleMessageId: string; readonly idleOutcome: "succeeded" | "failed" | "interrupted";
  readonly completedAt: number | null; readonly finish: string | null; readonly assistantError: boolean; readonly idleError: boolean;
  readonly outputByteLength: number; readonly outputSha256: string;
}
export type ImportEvidence = { readonly state: "not-submitted"; readonly promptId: string; readonly inputSha256: string }
  | (ImportTerminalEvidence & { readonly state: "terminal-failure" | "terminal-completion" });
export interface ImportPartitionResult {
  readonly type: "import-partition"; readonly fileId: string; readonly sha256: string;
  readonly partition: ImportPartition; readonly evidence: ImportEvidence;
}
export interface ImportBatch {
  readonly id: string; readonly namespaceId: string; readonly createdAt: string; readonly sealedAt: string | null;
  readonly state: "open" | "processing" | "completed";
  readonly counts: { readonly admitted: number; readonly pending: number; readonly imported: number; readonly skippedIdentical: number;
    readonly skippedChanged: number; readonly failed: number; readonly interrupted: number };
}
export type ImportOutcome = "imported" | "skipped-identical" | "skipped-changed" | "failed" | "interrupted";
export interface ImportFile {
  readonly id: string; readonly importId: string; readonly position: number; readonly relativePath: string; readonly byteLength: number;
  readonly createdAt: string; readonly state: "waiting" | Exclude<RunStatus,"completed" | "failed" | "interrupted"> | ImportOutcome;
  readonly runId: string | null; readonly documentId: string | null; readonly thoughtCount: number | null;
  readonly segmentation: Segmentation | null; readonly error: { readonly code: string; readonly retryable: boolean } | null;
}
export interface ImportSource {
  readonly id: string; readonly originalNamespaceId: string; readonly originalPath: string; readonly sha256: string;
  readonly byteLength: number; readonly encoding: "utf-8"; readonly createdAt: string; readonly parserVersion: string;
  readonly segmentation: Segmentation; readonly thoughtCount: number;
}
export type ImportPart = ImportPartRange & { readonly position: number; readonly thoughtId: string | null; readonly ordinal: number | null; readonly rejected?: boolean };
export interface ImportProvenance extends ByteRange { readonly documentId: string; readonly ordinal: number }
/** Internal, typed keyset continuation. HTTP encoding/authentication belongs to the future route boundary. */
export interface ImportPageCursor {
  readonly kind: "batches" | "files" | "sources" | "parts";
  readonly parentId: string | null; readonly scope: "user" | "history"; readonly limit: number; readonly after: number; readonly highWater: number;
}
export interface ImportPageRequest { readonly limit?: number; readonly cursor?: ImportPageCursor }
export interface ImportPage<T> { readonly items: readonly T[]; readonly nextCursor: ImportPageCursor | null }
export interface ImportPrivateInput { readonly fileId: string; readonly bytes: Uint8Array; readonly promptId: string; readonly input: string | null }
/** Command metadata, separate from the persisted entity and its public representation. */
export interface ImportBatchAdmission { readonly batch: ImportBatch; readonly replayed: boolean }
export interface ImportFileAdmission { readonly file: ImportFile; readonly replayed: boolean }
export interface MarkdownImportRepository {
  namespaces(actor: Actor): readonly ImportNamespace[];
  createBatch(actor: Actor, requestKey: string, namespaceId?: string): ImportBatch;
  createBatchAdmission(actor: Actor, requestKey: string, namespaceId?: string): ImportBatchAdmission;
  sealBatch(actor: Actor, importId: string): ImportBatch;
  admitFile(actor: Actor, importId: string, requestKey: string, relativePath: string, bytes: Uint8Array): ImportFile;
  admitFileAdmission(actor: Actor, importId: string, requestKey: string, relativePath: string, bytes: Uint8Array): ImportFileAdmission;
  batch(actor: Actor, importId: string): ImportBatch | null;
  file(actor: Actor, importId: string, fileId: string): ImportFile | null;
  claim(fileId: string): Claim;
  privateInput(claim: Claim): ImportPrivateInput;
  prepare(claim: Claim, manifest: ImportManifest): void;
  choose(claim: Claim, partition: ImportPartition, evidence: ImportEvidence): Claim;
  finalize(claim: Claim): ImportFile;
  fail(claim: Claim, code: ImportFailureCode): void;
  resolveWaiters(limit?: number): number;
}
export interface ImportInspectionRepository {
  source(scope: ReadScope, documentId: string): ImportSource | null;
  raw(scope: ReadScope, documentId: string): Uint8Array | null;
  provenance(scope: ReadScope, thoughtId: string): {readonly importSource:ImportProvenance|null} | null;
  sources(scope: ReadScope, request?: ImportPageRequest): ImportPage<ImportSource>;
  parts(scope: ReadScope, documentId: string, request?: ImportPageRequest): ImportPage<ImportPart>;
  batches(actor: Actor, request?: ImportPageRequest): ImportPage<ImportBatch>;
  files(actor: Actor, importId: string, request?: ImportPageRequest): ImportPage<ImportFile>;
}

export function requireImportUser(actor: Actor): void { if (actor !== "user") throw new ImportForbiddenError("Imports are user-only"); }
export function requireSourceInspection(scope: ReadScope): void {
  if (!scope || scope.actor !== "user") throw new ImportForbiddenError("Sources are user-only");
  if (scope.mode !== "history") throw new ValidationError("Source inspection requires history scope");
}
export function importRequestKey(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ValidationError("Invalid import request key");
  return value;
}
export function importRelativePath(value: string): string {
  if (typeof value!=="string" || value.length===0 || /^[A-Za-z]:/.test(value) || /[\\\p{Cc}]/u.test(value) || value.split('/').some(part => part === "" || part === "." || part === "..")) throw new ValidationError("Invalid import relative path");
  return value;
}
export function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value<0) throw new ValidationError(`Invalid ${field}`);
  return value;
}
export function sourceText(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.includes(0)) throw new ImportPreservationError("Unsupported source content");
  try {
    const text = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
    if (!equalBytes(new TextEncoder().encode(text),bytes)) throw new ImportPreservationError("Source UTF-8 round trip failed");
    return text;
  } catch { throw new ImportPreservationError("Unsupported source encoding"); }
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean { return a.length===b.length && a.every((value,index) => value===b[index]); }
function fields(data: Record<string,unknown>, keys: readonly string[]): void {
  if (Object.keys(data).length!==keys.length || keys.some(key => !Object.hasOwn(data,key))) throw new ValidationError("Invalid import partition fields");
}
function array(value: unknown): readonly unknown[] { if (!Array.isArray(value)) throw new ValidationError("Invalid import partition array"); return value; }
function range(value: unknown): ByteRange {
  const data = record(value); fields(data,["startByte","endByte"]);
  const startByte = safeInteger(data.startByte,"startByte"), endByte = safeInteger(data.endByte,"endByte");
  if (endByte<=startByte) throw new ValidationError("Empty import range");
  return {startByte,endByte};
}
export function importManifest(bytes: Uint8Array, input: unknown): ImportManifest {
  sourceText(bytes);
  const m = record(JSON.parse(protocolJson(input))); fields(m,["version","parserVersion","atoms","cuts"]);
  if (m.version!==1) throw new ValidationError("Invalid import manifest version");
  const atoms = array(m.atoms).map(range);
  const cuts = array(m.cuts).map((item,index) => {
    const cut = record(item); fields(cut,["id","offset"]);
    if (cut.id!==`b${index}`) throw new ValidationError("Invalid manifest cut identity");
    return {id:cut.id,offset:safeInteger(cut.offset,"cut offset")};
  });
  const scalar = (offset: number): boolean => offset<=bytes.length && (offset===bytes.length || ((bytes[offset] ?? 0) & 0xc0)!==0x80);
  if (cuts.length!==atoms.length+1) throw new ValidationError("Incomplete manifest endpoints");
  for (const [index,atom] of atoms.entries()) {
    const previous=atoms[index-1];
    if (!scalar(atom.startByte) || !scalar(atom.endByte) || (previous!==undefined && atom.startByte<previous.endByte)) throw new ImportPreservationError("Invalid atom boundaries");
  }
  cuts.forEach((cut,index) => {
    const offset = atoms[index]?.startByte ?? atoms.at(-1)?.endByte ?? bytes.length;
    if (cut.offset!==offset) throw new ValidationError("Manifest cut differs from atom boundary");
  });
  return {version:1,parserVersion:nonEmpty(m.parserVersion,"parserVersion"),atoms,cuts};
}
/** Storage validates scalar boundaries, complete coverage and exact slices, not Markdown block semantics. */
export function importPartition(bytes: Uint8Array, input: unknown): ImportPartition {
  const data = record(JSON.parse(protocolJson(input))); fields(data,["manifest","cuts","parts","segmentation"]);
  const manifest=importManifest(bytes,data.manifest), {atoms,cuts}=manifest;
  const scalar = (offset: number): boolean => offset<=bytes.length && (offset===bytes.length || ((bytes[offset] ?? 0) & 0xc0)!==0x80);
  const cutPositions=new Map(cuts.map((cut,index) => [cut.id,index]));
  const selected: number[]=[];
  let previous=-1;
  for (const id of array(data.cuts)) {
    const position=typeof id==="string" ? cutPositions.get(id) : undefined;
    if (position===undefined || position<=previous) throw new ValidationError("Invalid selected cuts");
    selected.push(position); previous=position;
  }
  if (selected[0]!==0 || selected.at(-1)!==atoms.length) throw new ValidationError("Selected cuts omit endpoints");
  const parts = array(data.parts).map(item => {
    const p = record(item); fields(p,["kind","startByte","endByte"]);
    return {...range({startByte:p.startByte,endByte:p.endByte}),kind:oneOf(p.kind,"part kind",["thought","separator","bom","frontmatter"])};
  });
  let end = 0, ordinal = 0, frontmatter = false;
  for (const part of parts) {
    if (part.startByte!==end || !scalar(part.startByte) || !scalar(part.endByte)) throw new ImportPreservationError("Import parts must cover scalar-aligned original bytes");
    end = part.endByte;
    const slice = sourceText(bytes.slice(part.startByte,part.endByte));
    if (part.kind==="thought") {
      const first = atoms[selected[ordinal] ?? -1], last = atoms[(selected[ordinal+1] ?? 0)-1];
      if (!first || !last || first.startByte!==part.startByte || last.endByte!==part.endByte || !slice.trim()) throw new ImportPreservationError("Thought differs from selected complete atoms");
      ordinal++;
    } else if (part.kind==="separator" && slice.trim()!=="") throw new ImportPreservationError("Unclassified source prose");
    else if (part.kind==="bom" && (part.startByte!==0 || part.endByte!==3 || slice!=="\ufeff")) throw new ImportPreservationError("Invalid BOM part");
    else if (part.kind==="frontmatter") {
      const start = bytes[0]===0xef && bytes[1]===0xbb && bytes[2]===0xbf ? 3 : 0;
      const lines=slice.split(/\r\n|\r|\n/);
      const closing=lines.findIndex((line,index) => index>0 && (line==="---" || line==="..."));
      const last=lines.length-(lines.at(-1)==="" ? 2 : 1);
      if (frontmatter || part.startByte!==start || lines[0]!=="---" || closing<1 || closing!==last) throw new ImportPreservationError("Invalid leading frontmatter");
      frontmatter = true;
    }
  }
  if (end!==bytes.length || ordinal!==Math.max(0,selected.length-1)) throw new ImportPreservationError("Incomplete import partition");
  const s = record(data.segmentation); fields(s,["method","reason"]);
  const method = oneOf(s.method,"segmentation method",["ai","structural","not-needed"]);
  const segmentation: Segmentation = method==="structural" ? {method,reason:oneOf(s.reason,"fallback reason",["ai-unconfigured","ai-unavailable","ai-failed","ai-invalid","ai-context-unavailable"])} : {method,reason:null};
  if ((method!=="structural" && s.reason!==null) || ((method==="not-needed")!==(ordinal===0))) throw new ValidationError("Invalid segmentation attribution");
  return {manifest,cuts:selected.map(index => {
    const cut=cuts[index]; if (!cut) throw new ValidationError("Unknown selected cut"); return cut.id;
  }),parts,segmentation};
}
