import { Database, SQLiteError } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { constants, lstatSync, type BigIntStats } from "node:fs";
import { mkdir, open, opendir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Logger } from "../logging";
import { ExecutionOwnerHeldError, ExecutionOwnerLease, ExecutionOwnerLostError } from "../storage/execution-owner";
import { ExecutionOwnerPathError } from "../storage/execution-owner-path";
import { assertRestoreFenceSchema } from "../storage/restore-fences-schema";
import { absent, childDirectory, empty, fingerprint, newFile, openDirectory, openFile, outsideGit,
  owned, sameInode, smallFile, unchanged, verifyDirectory, verifyFile, type Directory, type File, type Guard } from "./capture-files";
import type { BackupManifest } from "./format";
import { readSqlSnapshot, validateBytes, type SqlSnapshot } from "./records";
import { compareRestoreRecords, loadRestoreDatabase, RestoreLoadError, restoreSchemaFingerprint } from "./restore-load";

export type RestoreTargetCode = "invalid-snapshot" | "invalid-records" | "unsafe-path" | "aborted" | "storage-failed" | "cleanup-conflict"
  | "target-not-empty" | "target-busy" | "publication-uncertain";
export class RestoreTargetError extends Error {
  constructor(readonly code: RestoreTargetCode) { super(`Restore target failed: ${code}`); }
}
function requireTarget(condition: boolean, code: RestoreTargetCode): asserts condition { if (!condition) throw new RestoreTargetError(code); }
const encoder = new TextEncoder();
const databaseName = "thoughtloom.sqlite", sidecarName = `${databaseName}.execution-owner.sqlite`, markerName = ".restore-in-progress";
const leaseJournalName = `${sidecarName}-journal`;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function ancestor(path: string, identity: BigIntStats): boolean {
  for (let current = path;; current = dirname(current)) {
    if (sameInode(lstatSync(current,{bigint:true}),identity)) return true;
    if (current === dirname(current)) return false;
  }
}
function separate(a: Directory, b: Directory): void {
  requireTarget(!ancestor(a.path,b.identity) && !ancestor(b.path,a.identity),"unsafe-path");
}
async function members(directory: Directory, expected: ReadonlySet<string>, guard: Guard): Promise<void> {
  const remaining = new Set(expected); verifyDirectory(directory);
  for await (const entry of await opendir(directory.anchor)) { guard(); requireTarget(remaining.delete(entry.name),"unsafe-path"); }
  requireTarget(remaining.size === 0,"unsafe-path"); verifyDirectory(directory);
}
/** Classification only: never adopt an existing placeholder or mutate its sidecar to discover contention. */
async function busyPlaceholder(root: Directory, hasJournal: boolean, guard: Guard): Promise<boolean> {
  const files: File[] = []; let db: Database | undefined, busy = false;
  let sidecar: BigIntStats | undefined;
  const expected = new Set([databaseName,sidecarName,...(hasJournal ? [leaseJournalName] : [])]);
  const verifySidecar = () => {
    if (!sidecar) return;
    verifyDirectory(root); const current = lstatSync(join(root.anchor,sidecarName),{bigint:true}); owned(current,false);
    requireTarget(unchanged(current,sidecar),"unsafe-path");
  };
  try {
    await members(root,expected,guard);
    const main = lstatSync(join(root.anchor,databaseName),{bigint:true}); owned(main,false);
    if (main.size !== 0n) return false;
    files.push(await openFile(root,databaseName));
    if (files[0].identity.size !== 0n) return false;
    // A raw sidecar FD close could unlock another SQLite connection's same-process POSIX lease.
    sidecar = lstatSync(join(root.anchor,sidecarName),{bigint:true}); owned(sidecar,false);
    if (hasJournal) files.push(await openFile(root,leaseJournalName));
    verifySidecar();
    db = new Database(join(root.path,sidecarName),{readonly:true,create:false,strict:true});
    db.exec("PRAGMA busy_timeout=0; BEGIN"); db.query("SELECT 1 FROM main.sqlite_schema LIMIT 1").get();
  } catch (error) {
    busy = error instanceof SQLiteError && typeof error.code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)/.test(error.code);
  } finally {
    try {
      try { if (db?.inTransaction) db.exec("ROLLBACK"); } finally { db?.close(true); }
    } finally {
      try {
        if (files[0]) verifyFile(root,databaseName,files[0]);
        verifySidecar();
        if (files[1]) verifyFile(root,leaseJournalName,files[1],false);
        await members(root,expected,guard);
      } finally { await Promise.all(files.map(file => file.handle.close())); }
    }
  }
  return busy;
}

/** Read-only reservation until reserve(). No recursive creation, adoption, overwrite, or target cleanup. */
export class RestoreTargetLocation {
  private root: Directory | undefined;
  private rootClosing: Promise<void> | undefined;
  private constructor(readonly path: string, readonly parent: Directory, private readonly snapshot: Directory) {}
  static async prepare(path: string, snapshotPath: string, guard: Guard): Promise<RestoreTargetLocation> {
    requireTarget(typeof path === "string" && isAbsolute(path) && resolve(path) === path && !path.includes("\0") && dirname(path) !== path,"unsafe-path");
    guard(); const snapshot = await openDirectory(snapshotPath); let parent: Directory | undefined, location: RestoreTargetLocation | undefined;
    try {
      parent = await openDirectory(dirname(path),false); outsideGit(parent.path);
      requireTarget(!ancestor(parent.path,snapshot.identity),"unsafe-path");
      location = new RestoreTargetLocation(path,parent,snapshot);
      try { lstatSync(join(parent.anchor,basename(path))); }
      catch (error) { if (absent(error)) return location; throw error; }
      location.root = await openDirectory(path); separate(location.root,snapshot);
      const entries: string[] = [];
      for await (const entry of await opendir(location.root.anchor)) { entries.push(entry.name); if (entries.length > 3) break; }
      if (entries.length) {
        const hasJournal = entries.includes(leaseJournalName);
        if (entries.length === (hasJournal ? 3 : 2) && entries.includes(databaseName) && entries.includes(sidecarName) &&
          await busyPlaceholder(location.root,hasJournal,guard)) {
          throw new RestoreTargetError("target-busy");
        }
        throw new RestoreTargetError("target-not-empty");
      }
      guard(); location.guard(); return location;
    } catch (error) {
      await Promise.allSettled([location?.root?.handle.close(),parent?.handle.close(),snapshot.handle.close()]); throw error;
    }
  }
  identity(): void {
    verifyDirectory(this.parent);
    if (this.root) verifyDirectory(this.root);
  }
  guard(): void {
    this.identity(); verifyDirectory(this.snapshot);
    if (!this.root) {
      try { lstatSync(join(this.parent.anchor,basename(this.path))); }
      catch (error) { if (absent(error)) return; throw error; }
      throw new RestoreTargetError("target-not-empty");
    }
  }
  async scratch(): Promise<Directory> {
    this.guard(); const name = `.restore-work-${randomUUID()}`;
    requireTarget(join(this.parent.path,name) !== this.path,"unsafe-path"); return childDirectory(this.parent,name,true);
  }
  async removeScratch(scratch: Directory): Promise<void> {
    try {
      verifyDirectory(this.parent); verifyDirectory(scratch);
      requireTarget(/^\.restore-work-[0-9a-f-]{36}$/.test(basename(scratch.path)) && dirname(scratch.path) === this.parent.path && await empty(scratch),"cleanup-conflict");
      await rmdir(join(this.parent.anchor,basename(scratch.path))); await this.parent.handle.sync();
    } finally { await scratch.handle.close(); }
  }
  async reserve(stage: Directory): Promise<Directory> {
    this.guard(); requireTarget(!ancestor(this.parent.path,stage.identity),"unsafe-path");
    if (!this.root) {
      const path = join(this.parent.anchor,basename(this.path)); await mkdir(path,{mode:0o700}); const created = lstatSync(path,{bigint:true});
      this.root = await openDirectory(this.path); requireTarget(sameInode(this.root.identity,created),"unsafe-path");
    }
    separate(this.root,this.snapshot); separate(this.root,stage);
    requireTarget(await empty(this.root),"target-not-empty"); this.guard(); return this.root;
  }
  closeRoot(): Promise<void> { return this.rootClosing ??= this.root?.handle.close() ?? Promise.resolve(); }
  async close(): Promise<void> {
    const result = await Promise.allSettled([this.closeRoot(),this.parent.handle.close(),this.snapshot.handle.close()]);
    requireTarget(result.every(entry => entry.status === "fulfilled"),"storage-failed");
  }
}

export interface RecoveredRestoreSource {
  readonly root: Directory;
  readonly media: Directory;
  readonly records: SqlSnapshot;
  readonly manifest: BackupManifest;
  readonly schema: string;
  guard(): void;
  verify(): Promise<void>;
}
function mediaMarker(manifest: BackupManifest): Uint8Array {
  return encoder.encode(`${JSON.stringify({version:1,storeId:manifest.mediaStoreId})}\n`);
}
export async function verifyRestoreMedia(media: Directory, manifest: BackupManifest, guard: Guard): Promise<void> {
  const opened: Directory[] = [];
  try {
    // The owner's directory may predate its own file creation. Pin a fresh read baseline without adopting another inode.
    guard(); verifyDirectory(media); const current = await openDirectory(media.path); opened.push(current);
    requireTarget(sameInode(current.identity,media.identity),"unsafe-path");
    const objects = await childDirectory(current,"objects"); opened.push(objects);
    const staging = await childDirectory(current,"staging"); opened.push(staging);
    const prepared = await childDirectory(current,"prepared"); opened.push(prepared);
    await members(current,new Set(["objects","staging","prepared",...(manifest.mediaMarker ? ["store.json"] : [])]),guard);
    requireTarget(await empty(staging) && await empty(prepared),"invalid-records");
    if (manifest.mediaMarker) {
      const marker = await smallFile(current,"store.json",1024);
      requireTarget(Buffer.from(marker).equals(Buffer.from(mediaMarker(manifest))) && String(marker.length) === manifest.mediaMarker.byteLength &&
        digest(marker) === manifest.mediaMarker.sha256,"invalid-records");
    }
    await members(objects,new Set(manifest.originals.map(entry => entry.sourceId)),guard);
    for (const entry of manifest.originals) {
      const actual = await fingerprint(objects,entry.sourceId,guard);
      requireTarget(actual.byteLength === entry.byteLength && actual.sha256 === entry.sha256,"invalid-records");
    }
    for (const directory of opened) verifyDirectory(directory,true); guard();
  } finally {
    const closed = await Promise.allSettled(opened.map(directory => directory.handle.close()));
    requireTarget(closed.every(entry => entry.status === "fulfilled"),"storage-failed");
  }
}

interface TargetFile { readonly parent: Directory; readonly name: string; identity: BigIntStats }
class TargetWriter {
  // A failed SQLite close cannot authorize closing a raw sidecar FD and dropping its remaining kernel locks.
  private static readonly uncertainReleases = new Set<TargetWriter>();
  readonly directories: Directory[];
  readonly files = new Map<string,TargetFile>();
  lease: ExecutionOwnerLease | undefined;
  private sidecar: File | undefined;
  private leaseJournal: File | undefined;
  private closing: Promise<void> | undefined;
  constructor(readonly root: Directory, private readonly location: RestoreTargetLocation) { this.directories = [root]; }
  identity(includeMarker = true): void {
    this.location.guard(); this.targetIdentity(includeMarker);
  }
  private targetIdentity(includeMarker = true): void {
    this.location.identity(); this.lease?.assertHeld();
    if (this.leaseJournal) verifyFile(this.root,leaseJournalName,this.leaseJournal,false);
    for (const name of [databaseName,sidecarName,...(includeMarker ? [markerName] : [])]) {
      const file = this.files.get(join(this.root.path,name));
      if (file) { const info = lstatSync(join(file.parent.anchor,file.name),{bigint:true}); owned(info,false); requireTarget(sameInode(info,file.identity),"unsafe-path"); }
    }
  }
  private check(file: TargetFile): BigIntStats {
    verifyDirectory(file.parent); const info = lstatSync(join(file.parent.anchor,file.name),{bigint:true}); owned(info,false);
    requireTarget(unchanged(info,file.identity),"unsafe-path"); return info;
  }
  checkDatabase(): void { this.identity(); const file = this.files.get(join(this.root.path,databaseName)); requireTarget(file !== undefined,"storage-failed"); this.check(file); }
  refreshDatabase(): void {
    this.identity(); const file = this.files.get(join(this.root.path,databaseName)); requireTarget(file !== undefined,"storage-failed");
    file.identity = lstatSync(join(this.root.anchor,databaseName),{bigint:true});
  }
  async file(parent: Directory, name: string): Promise<File> {
    this.identity(); const file = await newFile(parent,name); this.files.set(join(parent.path,name),{parent,name,identity:file.identity}); return file;
  }
  seal(parent: Directory, name: string, file: File): void {
    const saved = this.files.get(join(parent.path,name)); requireTarget(saved !== undefined,"storage-failed"); saved.identity = verifyFile(parent,name,file,false);
  }
  async directory(parent: Directory, name: string): Promise<Directory> {
    this.identity(); const directory = await childDirectory(parent,name,true); this.directories.push(directory); return directory;
  }
  async write(parent: Directory, name: string, bytes: Uint8Array, guard: Guard): Promise<void> {
    const file = await this.file(parent,name);
    try {
      for (let offset = 0; offset < bytes.length;) {
        guard(); const result = await file.handle.write(bytes,offset,Math.min(65536,bytes.length-offset),offset);
        requireTarget(result.bytesWritten > 0,"storage-failed"); offset += result.bytesWritten;
      }
      await file.handle.sync(); guard();
    } finally { try { this.seal(parent,name,file); } finally { await file.handle.close(); } }
  }
  async pinSidecar(): Promise<void> {
    this.identity(); const saved = this.files.get(join(this.root.path,sidecarName));
    requireTarget(this.lease !== undefined && this.sidecar === undefined && saved !== undefined,"unsafe-path");
    const before = lstatSync(join(this.root.anchor,sidecarName),{bigint:true}); owned(before,false);
    requireTarget(sameInode(saved.identity,before),"unsafe-path");
    const handle = await open(join(this.root.anchor,sidecarName),constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    // Own the FD before any further fallible check; even failed pinning closes it only after lease release.
    // openFile() cannot be used here because its failure cleanup closes the FD immediately.
    const file: File = {handle,identity:before}; this.sidecar = file;
    const current = await handle.stat({bigint:true}); owned(current,false);
    requireTarget(unchanged(before,current),"unsafe-path"); verifyFile(this.root,sidecarName,file); this.identity();
    saved.identity = current; this.sidecar = {handle,identity:current};
  }
  async pinLeaseJournal(): Promise<void> {
    this.identity(); requireTarget(this.lease !== undefined,"storage-failed");
    try { lstatSync(join(this.root.anchor,leaseJournalName)); }
    catch (error) { if (absent(error)) return; throw error; }
    const file = await openFile(this.root,leaseJournalName);
    try {
      this.identity(); verifyFile(this.root,leaseJournalName,file,false);
      // SQLite owns this live control file, not an immutable restored payload or a file we sync/remove.
      this.leaseJournal = file;
    } catch (error) { await file.handle.close(); throw error; }
  }
  async verify(guard: Guard): Promise<void> {
    this.identity();
    for (const directory of this.directories) {
      const expected = new Set<string>();
      for (const child of this.directories) if (child !== this.root && dirname(child.path) === directory.path) expected.add(basename(child.path));
      for (const file of this.files.values()) if (file.parent === directory) { this.check(file); expected.add(file.name); }
      if (directory === this.root && this.leaseJournal) expected.add(leaseJournalName);
      await members(directory,expected,guard);
    }
  }
  async sync(guard: Guard): Promise<void> {
    for (const file of this.files.values()) {
      guard(); const saved = this.check(file);
      if (file.parent === this.root && file.name === sidecarName) {
        const sidecar = this.sidecar;
        requireTarget(sidecar !== undefined && unchanged(saved,sidecar.identity),"unsafe-path");
        verifyFile(this.root,sidecarName,sidecar); await sidecar.handle.sync(); verifyFile(this.root,sidecarName,sidecar); guard();
        continue;
      }
      const handle = await open(join(file.parent.anchor,file.name),constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const opened = { handle, identity:await handle.stat({bigint:true}) };
        requireTarget(unchanged(saved,opened.identity),"unsafe-path"); verifyFile(file.parent,file.name,opened);
        await handle.sync(); verifyFile(file.parent,file.name,opened); guard();
      } finally { await handle.close(); }
    }
    for (const directory of [...this.directories].reverse()) { guard(); verifyDirectory(directory); await directory.handle.sync(); }
  }
  async publish(guard: Guard): Promise<void> {
    guard(); const marker = this.files.get(join(this.root.path,markerName)); requireTarget(marker !== undefined,"storage-failed"); this.check(marker);
    await unlink(join(this.root.anchor,markerName)); this.files.delete(join(this.root.path,markerName));
    // No cancellation check after unlink: complete the publication boundary, never undo it due to a late signal.
    await this.root.handle.sync();
  }
  async reinstateMarker(bytes: Uint8Array): Promise<void> {
    // Re-gating an uncertain publication depends only on held target ownership, not a surviving source path or signal.
    this.targetIdentity(false);
    try {
      lstatSync(join(this.root.anchor,markerName));
      const saved = this.files.get(join(this.root.path,markerName)); requireTarget(saved !== undefined,"publication-uncertain"); this.check(saved);
    } catch (error) {
      if (!absent(error)) throw error;
      this.files.delete(join(this.root.path,markerName));
      const file = await newFile(this.root,markerName);
      this.files.set(join(this.root.path,markerName),{parent:this.root,name:markerName,identity:file.identity});
      try {
        for (let offset = 0; offset < bytes.length;) {
          this.targetIdentity(false); const result = await file.handle.write(bytes,offset,bytes.length-offset,offset);
          requireTarget(result.bytesWritten > 0,"publication-uncertain"); offset += result.bytesWritten;
        }
        await file.handle.sync(); this.seal(this.root,markerName,file);
      } finally { await file.handle.close(); }
    }
    await this.root.handle.sync();
  }
  close(): Promise<void> {
    return this.closing ??= this.releaseAndClose();
  }
  private async releaseAndClose(): Promise<void> {
    let released = false;
    try { this.lease?.release(); released = true; }
    catch { TargetWriter.uncertainReleases.add(this); }
    const results = await Promise.allSettled([
      ...this.directories.filter(directory => directory !== this.root).map(directory => directory.handle.close()),
      ...(this.leaseJournal ? [this.leaseJournal.handle.close()] : []),
      ...(released && this.sidecar ? [this.sidecar.handle.close()] : []),
    ]);
    requireTarget(released && results.every(result => result.status === "fulfilled"),"storage-failed");
  }
}

async function copyOriginals(writer: TargetWriter, source: RecoveredRestoreSource, guard: Guard): Promise<Directory> {
  const media = await writer.directory(writer.root,`${databaseName}.media`), objects = await writer.directory(media,"objects");
  await writer.directory(media,"staging"); await writer.directory(media,"prepared");
  if (source.manifest.mediaMarker) await writer.write(media,"store.json",mediaMarker(source.manifest),guard);
  const originals = await childDirectory(source.media,"objects");
  try {
    for (const entry of source.manifest.originals) {
      guard(); const file = await writer.file(objects,entry.sourceId);
      try {
        const copied = await fingerprint(originals,entry.sourceId,guard,file);
        requireTarget(copied.byteLength === entry.byteLength && copied.sha256 === entry.sha256,"invalid-records");
      } finally { try { writer.seal(objects,entry.sourceId,file); } finally { await file.handle.close(); } }
      const saved = await fingerprint(objects,entry.sourceId,guard);
      requireTarget(saved.byteLength === entry.byteLength && saved.sha256 === entry.sha256,"storage-failed");
    }
  } finally { await originals.handle.close(); }
  return media;
}
function verifyTargetDatabase(writer: TargetWriter, source: RecoveredRestoreSource, guard: Guard): void {
  writer.checkDatabase(); const db = new Database(join(writer.root.path,databaseName),{readonly:true,create:false,strict:true,safeIntegers:true});
  try {
    writer.checkDatabase(); guard(); db.exec("PRAGMA query_only=ON; BEGIN");
    requireTarget(restoreSchemaFingerprint(db) === source.schema,"invalid-records"); assertRestoreFenceSchema(db);
    const snapshot = readSqlSnapshot(db,guard); validateBytes(snapshot); compareRestoreRecords(snapshot,source.manifest); db.exec("COMMIT");
  } finally { try { if (db.inTransaction) db.exec("ROLLBACK"); } finally { db.close(true); } }
}

/** Caller holds its private recovered-stage capability throughout. No registration, native work, DB file replacement or target cleanup. */
export async function installRecoveredTarget(location: RestoreTargetLocation, source: RecoveredRestoreSource, manifestSha256: string, restoredAt: string,
  logger: Logger, cancelled: Guard): Promise<void> {
  let writer: TargetWriter | undefined, publishing = false;
  const marker = encoder.encode(`${JSON.stringify({version:1,phase:"installing",manifestSha256,restoredAt})}\n`);
  try {
    cancelled(); await source.verify(); await verifyRestoreMedia(source.media,source.manifest,() => { cancelled(); source.guard(); });
    writer = new TargetWriter(await location.reserve(source.root),location); const selected = writer;
    const guard = () => { cancelled(); source.guard(); selected.identity(); };
    const database = await writer.file(writer.root,databaseName);
    try { await database.handle.sync(); } finally { await database.handle.close(); }
    const sidecar = await writer.file(writer.root,sidecarName);
    try { await sidecar.handle.sync(); } finally { await sidecar.handle.close(); }
    await writer.verify(guard); guard();
    writer.lease = await ExecutionOwnerLease.acquire(join(writer.root.path,databaseName),logger);
    await writer.pinSidecar(); await writer.pinLeaseJournal(); await writer.verify(guard); writer.checkDatabase();
    requireTarget(lstatSync(join(writer.root.anchor,databaseName),{bigint:true}).size === 0n,"target-not-empty");
    logger.info("[restore] target ownership acquired"); guard();
    await writer.write(writer.root,markerName,marker,guard); await writer.root.handle.sync(); await location.parent.handle.sync();
    logger.info("[restore] target marker durable"); guard();
    const media = await copyOriginals(writer,source,guard);
    const schema = loadRestoreDatabase({path:join(writer.root.path,databaseName),check:() => selected.checkDatabase(),refresh:() => selected.refreshDatabase()},
      source.records.tables,source.manifest,logger,guard);
    requireTarget(schema === source.schema,"invalid-records"); logger.info("[restore] target database committed"); guard();
    verifyTargetDatabase(writer,source,guard); await verifyRestoreMedia(media,source.manifest,guard); await source.verify();
    await writer.verify(guard); await writer.sync(guard); await location.parent.handle.sync();
    logger.info("[restore] target validated"); guard(); await writer.verify(guard);
    guard(); publishing = true;
    try { await writer.publish(() => selected.identity()); }
    catch {
      try { await writer.reinstateMarker(marker); } catch { /* Preserve the target and report uncertainty even if marker re-creation cannot be confirmed. */ }
      throw new RestoreTargetError("publication-uncertain");
    }
  } catch (error) {
    if (publishing) throw new RestoreTargetError("publication-uncertain");
    if (error instanceof ExecutionOwnerHeldError) throw new RestoreTargetError("target-busy");
    if (error instanceof ExecutionOwnerPathError || error instanceof ExecutionOwnerLostError) throw new RestoreTargetError("unsafe-path");
    if (error instanceof RestoreLoadError) throw new RestoreTargetError("invalid-records");
    throw error;
  } finally {
    let failed = false;
    try { await writer?.close(); } catch { failed = true; }
    try { await location.closeRoot(); } catch { failed = true; }
    if (failed) throw new RestoreTargetError(publishing ? "publication-uncertain" : "storage-failed");
  }
}
