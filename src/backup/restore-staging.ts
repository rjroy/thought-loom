import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, type BigIntStats } from "node:fs";
import { opendir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createLogger, type Logger } from "../logging";
import { assertRestoreFenceSchema } from "../storage/restore-fences-schema";
import { BackupCaptureError, childDirectory, fingerprint, newFile, openDirectory, outsideGit, owned, sameInode, unchanged,
  verifyDirectory, verifyFile, type Directory, type File, type Guard } from "./capture-files";
import { decodeTable } from "./decode";
import { BackupFormatError, encodeTable, type BackupManifest } from "./format";
import { BackupSchemaError, backupTableShapes } from "./schema";
import { bytes, integer, readSqlSnapshot, table, text, validateBytes, type CapturedTable, type SqlSnapshot } from "./records";
import { BackupSnapshotError, inspectSnapshot, payloadParent, readSnapshotFile, verifySnapshotMembership, type SnapshotTree } from "./snapshot";
import { applyRestoreRecovery } from "./restore-recovery";
import { compareRestoreRecords, loadRestoreDatabase, RestoreLoadError, restoreSchemaFingerprint } from "./restore-load";
import { installRecoveredTarget, RestoreTargetError, RestoreTargetLocation, type RestoreTargetCode } from "./restore-target";

export interface RestoreStageLimits {
  readonly manifestBytes: number;
  readonly tableBytes: number;
  readonly totalJsonBytes: number;
}

export interface RestoreStageOptions {
  readonly snapshotDirectory: string;
  readonly stagingParentDirectory: string;
  readonly expectedManifestSha256?: string;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly limits?: Partial<RestoreStageLimits>;
}

export interface RestoreStage {
  readonly stagingDirectory: string;
  readonly databasePath: string;
  readonly mediaDirectory: string;
  readonly manifestSha256: string;
  dispose(): Promise<void>;
}

export type RestoreStagingCode = "invalid-snapshot" | "invalid-records" | "unsafe-path" | "aborted" | "storage-failed" | "cleanup-conflict";
export class RestoreStagingError extends Error {
  constructor(readonly code: RestoreStagingCode) { super(`Restore staging failed: ${code}`); }
}
const defaults: RestoreStageLimits = { manifestBytes: 16*1024*1024, tableBytes: 64*1024*1024, totalJsonBytes: 256*1024*1024 };
const encoder = new TextEncoder();
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
function requireStage(condition: boolean, code: RestoreStagingCode): asserts condition { if (!condition) throw new RestoreStagingError(code); }
function limits(input: Partial<RestoreStageLimits> = {}): RestoreStageLimits {
  requireStage(typeof input === "object" && input !== null && !Array.isArray(input),"invalid-snapshot");
  requireStage(Object.keys(input).every(key => Object.hasOwn(defaults,key)),"invalid-snapshot");
  const result = {...defaults,...input};
  requireStage(Object.values(result).every(value => Number.isSafeInteger(value) && value > 0),"invalid-snapshot"); return result;
}
interface OwnedFile { readonly parent: Directory; readonly name: string; identity: BigIntStats }

/** A fresh, private capability only. Never adopts an existing workspace or cleans the caller's parent. */
class StageWorkspace {
  readonly directories: Directory[];
  private readonly files = new Map<string,OwnedFile>();
  private disposal: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private constructor(readonly parent: Directory, readonly root: Directory) { this.directories = [root]; }
  static async create(path: string, snapshot: Directory, guard: Guard): Promise<StageWorkspace> {
    const parent = await openDirectory(path);
    try {
      guard(); outsideGit(parent.path);
      requireStage(parent.path !== snapshot.path && !parent.path.startsWith(`${snapshot.path}/`),"unsafe-path");
      const root = await childDirectory(parent,`.restore-${randomUUID()}`,true);
      return new StageWorkspace(parent,root);
    } catch (error) { await parent.handle.close(); throw error; }
  }
  guard(): void {
    verifyDirectory(this.parent); verifyDirectory(this.root);
    for (const name of [".restore-in-progress","thoughtloom.sqlite"]) {
      const file = this.files.get(join(this.root.path,name));
      if (file) {
        const current = lstatSync(join(file.parent.anchor,file.name),{bigint:true}); owned(current,false);
        requireStage(sameInode(file.identity,current),"unsafe-path");
      }
    }
  }
  checkDatabase(): void {
    this.guard(); const database = this.files.get(join(this.root.path,"thoughtloom.sqlite"));
    requireStage(database !== undefined,"storage-failed"); this.checkFile(database);
  }
  async directory(parent: Directory, name: string): Promise<Directory> {
    this.guard(); const directory = await childDirectory(parent,name,true); this.directories.push(directory); return directory;
  }
  async file(parent: Directory, name: string): Promise<File> {
    this.guard(); const file = await newFile(parent,name);
    this.files.set(join(parent.path,name),{parent,name,identity:file.identity}); return file;
  }
  seal(parent: Directory, name: string, file: File): void {
    const saved = this.files.get(join(parent.path,name)); requireStage(saved !== undefined,"storage-failed");
    saved.identity = verifyFile(parent,name,file,false);
  }
  refreshDatabase(): void {
    this.guard(); const saved = this.files.get(join(this.root.path,"thoughtloom.sqlite")); requireStage(saved !== undefined,"storage-failed");
    const current = lstatSync(join(saved.parent.anchor,saved.name),{bigint:true}); owned(current,false);
    requireStage(sameInode(saved.identity,current),"unsafe-path"); saved.identity = current;
  }
  async write(parent: Directory, name: string, value: Uint8Array, guard: Guard): Promise<void> {
    const file = await this.file(parent,name);
    try {
      for (let offset = 0; offset < value.length;) {
        guard(); const result = await file.handle.write(value,offset,Math.min(65536,value.length-offset),offset);
        requireStage(result.bytesWritten > 0,"storage-failed"); offset += result.bytesWritten;
      }
      await file.handle.sync(); guard();
    } finally { try { this.seal(parent,name,file); } finally { await file.handle.close(); } }
  }
  private checkFile(file: OwnedFile): void {
    verifyDirectory(file.parent); const current = lstatSync(join(file.parent.anchor,file.name),{bigint:true}); owned(current,false);
    requireStage(unchanged(current,file.identity),"cleanup-conflict");
  }
  private async preflight(): Promise<void> {
    this.guard();
    requireStage(/^\.restore-[0-9a-f-]{36}$/.test(basename(this.root.path)),"cleanup-conflict");
    for (const directory of this.directories) {
      verifyDirectory(directory);
      const expected = new Set<string>();
      for (const child of this.directories) if (child !== this.root && dirname(child.path) === directory.path) expected.add(basename(child.path));
      for (const file of this.files.values()) if (file.parent === directory) { this.checkFile(file); expected.add(file.name); }
      for await (const entry of await opendir(directory.anchor)) requireStage(expected.delete(entry.name),"cleanup-conflict");
      requireStage(expected.size === 0,"cleanup-conflict");
    }
  }
  verify(): Promise<void> { return this.preflight(); }
  private async remove(): Promise<void> {
    try {
      // Inspect the entire set before deleting anything: an unknown entry preserves the whole staged tree.
      await this.preflight();
      const marker = this.files.get(join(this.root.path,".restore-in-progress"));
      for (const file of this.files.values()) if (file !== marker) {
        this.guard(); this.checkFile(file); await unlink(join(file.parent.anchor,file.name));
        this.files.delete(join(file.parent.path,file.name));
      }
      for (const directory of [...this.directories].reverse()) if (directory !== this.root) {
        this.guard(); verifyDirectory(directory); await rmdir(directory.path);
      }
      // A partial disposal must never leave the historical DB behind after removing its startup gate.
      this.guard(); if (marker) {
        this.checkFile(marker); await unlink(join(marker.parent.anchor,marker.name)); this.files.delete(join(marker.parent.path,marker.name));
      }
      verifyDirectory(this.root); await rmdir(this.root.path);
      await this.parent.handle.sync();
    } catch { throw new RestoreStagingError("cleanup-conflict"); }
    finally { await this.closeHandles(); }
  }
  closeHandles(): Promise<void> {
    return this.closing ??= Promise.allSettled([...this.directories].reverse().map(directory => directory.handle.close()).concat([this.parent.handle.close()]))
      .then(results => { requireStage(results.every(result => result.status === "fulfilled"),"cleanup-conflict"); });
  }
  dispose(): Promise<void> { return this.disposal ??= this.remove(); }
}

interface StageOwner {
  readonly work: StageWorkspace;
  readonly manifest: BackupManifest;
  verified: BackupManifest;
  readonly schema: string;
  active?: Promise<void>;
  disposal?: Promise<void>;
  recovered?: RestoreRecoveryResult;
  poisoned: boolean;
}
const stageOwners = new WeakMap<RestoreStage, StageOwner>();
function disposeStage(owner: StageOwner): Promise<void> {
  return owner.disposal ??= Promise.resolve().then(async () => {
    await owner.active;
    if (owner.poisoned) { await owner.work.closeHandles(); throw new RestoreStagingError("cleanup-conflict"); }
    await owner.work.dispose();
  });
}

function mediaManifest(snapshot: SqlSnapshot, manifest: BackupManifest): void {
  const stores = table(snapshot,"media_store").rows, sources = table(snapshot,"media_sources").rows;
  requireStage(stores.length <= 1 && sources.length === manifest.originals.length,"invalid-records");
  if (!stores.length) { requireStage(manifest.mediaStoreId === null && !sources.length,"invalid-records"); return; }
  requireStage(text(stores[0],"store_id") === manifest.mediaStoreId,"invalid-records");
  for (const source of sources) {
    const id = text(source,"id"), original = manifest.originals.find(entry => entry.sourceId === id);
    requireStage(original !== undefined && original.byteLength === integer(source,"byte_length").toString() &&
      original.sha256 === Buffer.from(bytes(source,"sha256")).toString("hex"),"invalid-records");
  }
}
async function copyMedia(work: StageWorkspace, source: SnapshotTree, guard: Guard): Promise<Directory> {
  const media = await work.directory(work.root,"thoughtloom.sqlite.media"), objects = await work.directory(media,"objects");
  await work.directory(media,"staging"); await work.directory(media,"prepared");
  if (source.manifest.mediaMarker !== null) {
    const marker = encoder.encode(`${JSON.stringify({version:1,storeId:source.manifest.mediaStoreId})}\n`);
    const actual = await readSnapshotFile(source,source.manifest.mediaMarker,1024,guard);
    requireStage(Buffer.from(marker).equals(Buffer.from(actual)),"invalid-snapshot"); await work.write(media,"store.json",marker,guard);
  }
  for (const entry of source.manifest.originals) {
    guard(); const from = payloadParent(source,entry.path), target = await work.file(objects,entry.sourceId);
    try {
      const actual = await fingerprint(from.parent,from.name,guard,target);
      requireStage(actual.byteLength === entry.byteLength && actual.sha256 === entry.sha256,"invalid-snapshot"); guard();
    } finally { try { work.seal(objects,entry.sourceId,target); } finally { await target.handle.close(); } }
    const saved = await fingerprint(objects,entry.sourceId,guard);
    requireStage(saved.byteLength === entry.byteLength && saved.sha256 === entry.sha256,"storage-failed");
  }
  return media;
}
function safeError(error: unknown): RestoreStagingError {
  if (error instanceof RestoreStagingError) return error;
  if (error instanceof RestoreLoadError) return new RestoreStagingError("invalid-records");
  if (error instanceof BackupFormatError) return new RestoreStagingError("invalid-snapshot");
  if (error instanceof BackupSnapshotError) return new RestoreStagingError(error.code === "storage-failed" ? "storage-failed" : "invalid-snapshot");
  if (error instanceof BackupCaptureError) return new RestoreStagingError(
    ["unsafe-path","unsafe-output","unsupported-storage"].includes(error.code) ? "unsafe-path" : error.code === "storage-failed" ? "storage-failed" : "invalid-snapshot");
  if (error instanceof Error && "code" in error && ["ENOENT","ENOTDIR","ELOOP"].includes(String(error.code))) return new RestoreStagingError("invalid-snapshot");
  return new RestoreStagingError("storage-failed");
}

export async function stageRestoreSnapshot(options: RestoreStageOptions): Promise<RestoreStage> {
  const {signal,logger = createLogger()} = options;
  let source: SnapshotTree | undefined, work: StageWorkspace | undefined;
  let transferred = false;
  logger.info("[restore] staging attempt");
  const guard = () => { requireStage(!signal?.aborted,"aborted"); work?.guard(); };
  try {
    guard(); const budgets = limits(options.limits);
    source = await inspectSnapshot(options.snapshotDirectory,options.expectedManifestSha256,guard,budgets);
    const captured: CapturedTable[] = [];
    for (const entry of source.manifest.tables) {
      const raw = await readSnapshotFile(source,entry,budgets.tableBytes,guard), rows = decodeTable(entry.name,raw);
      requireStage(String(rows.length) === entry.rowCount,"invalid-records");
      const shape = backupTableShapes.find(table => table.name === entry.name); requireStage(shape !== undefined,"invalid-snapshot");
      captured.push({shape,rows});
    }
    const decoded: SqlSnapshot = {tables:captured,sequences:source.manifest.sequences,
      rowCount:captured.reduce((count,table) => count+BigInt(table.rows.length),0n).toString()};
    try { validateBytes(decoded); mediaManifest(decoded,source.manifest); }
    catch (error) { if (error instanceof RestoreStagingError) throw error; throw new RestoreStagingError("invalid-records"); }
    guard(); work = await StageWorkspace.create(options.stagingParentDirectory,source.root,guard);
    await work.write(work.root,".restore-in-progress",encoder.encode(`${JSON.stringify({version:1,phase:"staging",manifestSha256:source.manifestSha256})}\n`),guard);
    await work.root.handle.sync();
    const database = await work.file(work.root,"thoughtloom.sqlite"); await database.handle.close();
    const selected = work;
    const schema = loadRestoreDatabase({ path:join(selected.root.path,"thoughtloom.sqlite"),check:() => selected.checkDatabase(),refresh:() => selected.refreshDatabase() },
      captured,source.manifest,logger,guard);
    const media = await copyMedia(work,source,guard);
    await verifySnapshotMembership(source,guard); guard();
    const closed = source; source = undefined; await closed.close();
    await work.verify(); guard();
    for (const directory of [...work.directories].reverse()) await directory.handle.sync();
    await work.parent.handle.sync(); guard();
    const owner: StageOwner = { work, manifest: closed.manifest, verified:closed.manifest, schema, poisoned: false };
    const result: RestoreStage = Object.freeze({stagingDirectory:work.root.path,
      databasePath:join(work.root.path,"thoughtloom.sqlite"),mediaDirectory:media.path,manifestSha256:closed.manifestSha256,
      dispose:async () => {
        logger.verbose("[restore] disposal attempt",{manifestSha256:closed.manifestSha256});
        try { await disposeStage(owner); logger.verbose("[restore] disposal succeeded",{manifestSha256:closed.manifestSha256}); }
        catch (error) { logger.warning("[restore] disposal refused",{reason:"cleanup-conflict"}); throw error; }
      }});
    stageOwners.set(result,owner);
    logger.info("[restore] staging succeeded",{manifestSha256:result.manifestSha256,tables:captured.length,rows:decoded.rowCount});
    transferred = true; return result;
  } catch (error) {
    const safe = signal?.aborted ? new RestoreStagingError("aborted") : safeError(error);
    logger.error("[restore] staging failed",{reason:safe.code}); throw safe;
  } finally {
    if (source) try { await source.close(); } catch { logger.warning("[restore] snapshot descriptor close failed"); }
    if (work && !transferred) try { await work.dispose(); } catch { logger.warning("[restore] owned staging cleanup refused"); }
  }
}

export interface RestoreRecoveryOptions {
  readonly restoredAt: string;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export interface RestoreRecoveryResult {
  readonly manifestSha256: string;
  readonly restoredAt: string;
  readonly addedFences: number;
  readonly interruptedRuns: number;
  readonly interruptedImportFiles: number;
  readonly invalidatedComposers: number;
}

function recoveryRecords(db: Database, owner: StageOwner, expected: BackupManifest, guard: Guard): SqlSnapshot {
  guard(); requireStage(restoreSchemaFingerprint(db) === owner.schema,"invalid-records");
  try { assertRestoreFenceSchema(db); } catch { throw new RestoreStagingError("invalid-records"); }
  const snapshot = readSqlSnapshot(db,guard); validateBytes(snapshot); compareRestoreRecords(snapshot,expected); return snapshot;
}
function recoveryManifest(snapshot: SqlSnapshot, original: BackupManifest): BackupManifest {
  return { ...original, tables: snapshot.tables.map(captured => {
    const encoded = encodeTable(captured.shape,captured.rows);
    return { name: captured.shape.name, path: `tables/${captured.shape.name}.json`, rowCount: String(captured.rows.length), byteLength: String(encoded.length), sha256: digest(encoded) };
  }) };
}
function recoverDatabase(owner: StageOwner, manifestSha256: string, restoredAt: string, logger: Logger, guard: Guard): { result:RestoreRecoveryResult; manifest:BackupManifest } {
  const {work} = owner;
  work.checkDatabase();
  const db = new Database(join(work.root.path,"thoughtloom.sqlite"),{create:false,strict:true,safeIntegers:true});
  let refresh = false, committed = false, committing = false;
  try {
    work.checkDatabase(); guard();
    db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;");
    const before = recoveryRecords(db,owner,owner.manifest,guard);
    const changes = applyRestoreRecovery(db,before,manifestSha256,restoredAt,guard);
    const manifest = recoveryManifest(changes.expected,owner.manifest);
    recoveryRecords(db,owner,manifest,guard);
    const result: RestoreRecoveryResult = Object.freeze({ manifestSha256, restoredAt, addedFences:changes.addedFences,
      interruptedRuns:changes.interruptedRuns, interruptedImportFiles:changes.interruptedImportFiles, invalidatedComposers:changes.invalidatedComposers });
    logger.verbose("[restore] recovery validated",{manifestSha256,addedFences:result.addedFences,interruptedRuns:result.interruptedRuns,
      interruptedImportFiles:result.interruptedImportFiles,invalidatedComposers:result.invalidatedComposers});
    guard(); committing = true; db.exec("COMMIT"); committed = true; refresh = true; return { result, manifest };
  } catch (error) {
    try {
      const couldRollback = db.inTransaction;
      if (couldRollback) db.exec("ROLLBACK");
      requireStage(!committed && (!committing || couldRollback),"storage-failed");
      // Cleanup validation deliberately ignores cancellation. Only a proven original state may be re-sealed for disposal/retry.
      db.exec("BEGIN"); recoveryRecords(db,owner,owner.manifest,() => work.guard()); db.exec("COMMIT"); refresh = true;
    } catch {
      owner.poisoned = true;
      try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* Preserve the ambiguous stage; close still releases this connection. */ }
      throw new RestoreStagingError("storage-failed");
    }
    throw error;
  } finally {
    try {
      db.close(true);
      if (refresh) work.refreshDatabase(); else owner.poisoned = true;
    } catch {
      owner.poisoned = true;
      try { db.close(); } catch { /* Best-effort release only; the stage stays ambiguous and cannot be retried or deleted. */ }
      throw new RestoreStagingError("storage-failed");
    }
  }
}

export async function recoverRestoreStage(stage: RestoreStage, options: RestoreRecoveryOptions): Promise<RestoreRecoveryResult> {
  const owner = stageOwners.get(stage), {signal,logger = createLogger(),restoredAt} = options;
  if (owner === undefined || owner.disposal || owner.active || owner.poisoned) {
    logger.warning("[restore] recovery refused",{reason:"unsafe-path"}); throw new RestoreStagingError("unsafe-path");
  }
  const operation = Promise.resolve().then(async () => {
    logger.info("[restore] recovery attempt",{manifestSha256:stage.manifestSha256});
    const guard = () => { requireStage(!signal?.aborted,"aborted"); owner.work.guard(); };
    try {
      requireStage(typeof restoredAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(restoredAt),"invalid-records");
      const time = new Date(restoredAt);
      requireStage(Number.isFinite(time.getTime()) && time.toISOString() === restoredAt,"invalid-records");
      guard(); await owner.work.verify(); guard();
      if (owner.recovered) {
        requireStage(owner.recovered.restoredAt === restoredAt,"invalid-records");
        logger.verbose("[restore] recovery reused",{manifestSha256:stage.manifestSha256}); return owner.recovered;
      }
      const recovered = recoverDatabase(owner,stage.manifestSha256,restoredAt,logger,guard), {result} = recovered;
      // Commit is final even if a later signal is aborted; never replay an uncertain committed recovery.
      owner.poisoned = true;
      await owner.work.verify();
      owner.recovered = result; owner.verified = recovered.manifest; owner.poisoned = false;
      logger.info("[restore] recovery succeeded",{manifestSha256:result.manifestSha256,addedFences:result.addedFences,
        interruptedRuns:result.interruptedRuns,interruptedImportFiles:result.interruptedImportFiles,invalidatedComposers:result.invalidatedComposers});
      return result;
    } catch (error) {
      const safe = error instanceof BackupSchemaError || error instanceof BackupCaptureError && !["unsafe-path","unsafe-output","unsupported-storage","storage-failed"].includes(error.code)
        ? new RestoreStagingError("invalid-records") : safeError(error);
      logger.error("[restore] recovery failed",{reason:safe.code}); throw safe;
    }
  });
  owner.active = operation.then(() => {},() => {});
  try { return await operation; } finally { owner.active = undefined; }
}

export interface RestoreOptions {
  readonly snapshotDirectory: string;
  readonly targetDirectory: string;
  readonly restoredAt: string;
  readonly expectedManifestSha256?: string;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly limits?: Partial<RestoreStageLimits>;
}

export interface RestoreResult {
  readonly targetDirectory: string;
  readonly databasePath: string;
  readonly mediaDirectory: string;
  readonly manifestSha256: string;
  readonly restoredAt: string;
}

export class RestoreError extends Error {
  constructor(readonly code: RestoreTargetCode) { super(`Restore failed: ${code}`); }
}
async function installStage(stage: RestoreStage, location: RestoreTargetLocation, restoredAt: string, logger: Logger, cancelled: Guard): Promise<void> {
  const owner = stageOwners.get(stage);
  requireStage(owner !== undefined && owner.recovered !== undefined && !owner.active && !owner.disposal && !owner.poisoned,"unsafe-path");
  const operation = Promise.resolve().then(async () => {
    const guard = () => { cancelled(); owner.work.guard(); };
    guard(); await owner.work.verify(); owner.work.checkDatabase();
    const db = new Database(stage.databasePath,{readonly:true,create:false,strict:true,safeIntegers:true});
    let records: SqlSnapshot;
    try {
      owner.work.checkDatabase(); guard(); db.exec("PRAGMA query_only=ON; BEGIN");
      records = recoveryRecords(db,owner,owner.verified,guard); db.exec("COMMIT");
    } finally { try { if (db.inTransaction) db.exec("ROLLBACK"); } finally { db.close(true); } }
    owner.work.checkDatabase();
    const media = owner.work.directories.find(directory => directory.path === stage.mediaDirectory); requireStage(media !== undefined,"unsafe-path");
    await installRecoveredTarget(location,{root:owner.work.root,media,records,manifest:owner.verified,schema:owner.schema,
      guard:() => owner.work.guard(),verify:() => owner.work.verify()},stage.manifestSha256,restoredAt,logger,cancelled);
  });
  owner.active = operation.then(() => {},() => {});
  try { await operation; } finally { owner.active = undefined; }
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const {snapshotDirectory,targetDirectory,restoredAt,expectedManifestSha256,signal,logger = createLogger(),limits:bounds} = options;
  let location: RestoreTargetLocation | undefined, scratch: Directory | undefined, stage: RestoreStage | undefined;
  const cancelled = () => { if (signal?.aborted) throw new RestoreError("aborted"); };
  logger.info("[restore] installation attempt");
  try {
    cancelled(); location = await RestoreTargetLocation.prepare(targetDirectory,snapshotDirectory,cancelled); cancelled();
    scratch = await location.scratch(); cancelled();
    stage = await stageRestoreSnapshot({snapshotDirectory,stagingParentDirectory:scratch.path,expectedManifestSha256,signal,logger,limits:bounds});
    await recoverRestoreStage(stage,{restoredAt,signal,logger});
    await installStage(stage,location,restoredAt,logger,cancelled);
    const databasePath = join(targetDirectory,"thoughtloom.sqlite");
    const result: RestoreResult = Object.freeze({targetDirectory,databasePath,mediaDirectory:`${databasePath}.media`,manifestSha256:stage.manifestSha256,restoredAt});
    logger.info("[restore] installation succeeded",{manifestSha256:result.manifestSha256,restoredAt:result.restoredAt}); return result;
  } catch (error) {
    const safe = error instanceof RestoreError ? error : error instanceof RestoreTargetError ? new RestoreError(error.code) :
      error instanceof BackupSchemaError || error instanceof BackupCaptureError && ["inconsistent-source","invalid-storage-class"].includes(error.code)
        ? new RestoreError("invalid-records") : new RestoreError(safeError(error).code);
    logger.error("[restore] installation failed",{reason:safe.code}); throw safe;
  } finally {
    // A confirmed target is never deleted or turned into failure because private scratch cannot safely be removed.
    if (stage) try { await stage.dispose(); } catch { logger.warning("[restore] retained ambiguous private stage"); }
    if (location && scratch) try { await location.removeScratch(scratch); } catch { logger.warning("[restore] retained private staging workspace"); }
    if (location) try { await location.close(); } catch { logger.warning("[restore] source or parent descriptor close failed"); }
  }
}
