import type { Database } from "bun:sqlite";
import type { Logger } from "../logging";
import type { BigIntStats, Dir } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { initializeMediaStore, mediaStoreId } from "./media-source";
import { createMediaFile, defaultMediaFileOperations, guardedFileIo, hasFileCode, inspectMediaFile, mediaChild, mediaFileId, MediaStoragePathError,
  openMediaFile, openMediaLayout, openMediaScan, sameMediaInode, verifyMediaFile,
  type MediaDirectory, type MediaFileGuard, type MediaFileOperations, type OwnedMediaFile, type OwnedMediaLayout } from "./media-file-paths";

export type MediaFileMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf";
export interface MediaFileArtifact {
  readonly sourceId: string;
  readonly mimeType: MediaFileMime;
  readonly byteLength: number;
  readonly sha256: Uint8Array;
}
export interface MediaFileValidationInput {
  /** Borrowed read-only for validation; the store owns and closes this staged-file descriptor. */
  readonly fd: number;
  readonly byteLength: number;
  readonly signal: AbortSignal;
}
export interface MediaFilesOptions {
  readonly db: Database;
  readonly directory: string;
  /** Explicit daemon-owned identity, coordinated with SqliteStore.initializeMediaStore and store.json. */
  readonly storeId: string;
  readonly id: () => string;
  readonly now: () => number;
  readonly assertHeld: () => void;
  readonly logger: Logger;
  readonly validate: (input: MediaFileValidationInput) => Promise<{ readonly mimeType: MediaFileMime }>;
  readonly limits: { readonly maxBytes: number; readonly orphanGraceMs: number; readonly cleanupBatchSize: number };
  readonly io?: MediaFileOperations;
}
export interface MediaFiles {
  readonly storeId: string;
  /** File-first publication; admission is synchronous SQL-only work under the shared cleanup gate. */
  publish(sourceId: string, input: AsyncIterable<Uint8Array>, admit: (artifact: MediaFileArtifact) => void): Promise<MediaFileArtifact>;
  /** Trusted internal verified read; callers must separately enforce consumer/AI read scope. */
  readOriginal(sourceId: string): Promise<Uint8Array>;
  cleanup(): Promise<{ readonly scanned: number; readonly removed: number; readonly hasMore: boolean }>;
  /** Seal new work, cancel and join entered producers, then release owned descriptors; idempotent. */
  close(): Promise<void>;
}

type FailureCode = "storage-closed" | "ownership-lost" | "invalid-input" | "source-too-large" | "invalid-media" |
  "source-exists" | "original-unavailable" | "admission-failed" | "storage-failed";
class MediaFilesError extends Error {
  constructor(readonly code: FailureCode) { super(`Media file operation failed: ${code}`); }
}
function failure(error: unknown): MediaFilesError | MediaStoragePathError {
  return error instanceof MediaFilesError || error instanceof MediaStoragePathError ? error : new MediaFilesError("storage-failed");
}
function mime(value: unknown): MediaFileMime {
  if (value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp" || value === "application/pdf") return value;
  throw new MediaFilesError("invalid-media");
}
interface SourceFingerprint { readonly mime_type: string; readonly byte_length: number; readonly sha256: Uint8Array }
interface Sweep { readonly cutoff: bigint; directory: number; reader: Dir | null }
interface Fingerprint { readonly byteLength: number; readonly sha256: Uint8Array }
function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return sameMediaInode(before,after) && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/** One instance belongs to the existing daemon execution lease. It owns no separate process/lease engine. */
class OwnedMediaFiles implements MediaFiles {
  readonly storeId: string;
  private readonly flights = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private readonly activeSources = new Set<string>();
  private readonly activeStaging = new Set<string>();
  private gate: Promise<void> = Promise.resolve();
  private stopping = false;
  private lost = false;
  private closing: Promise<void> | undefined;
  private sweep: Sweep | undefined;

  constructor(private readonly options: MediaFilesOptions, private readonly layout: OwnedMediaLayout,
    private readonly io: MediaFileOperations) { this.storeId = options.storeId; }

  private check(allowStopping = false): void {
    // Reject caller-held SQL transactions before invoking a lease guard that can itself inspect files.
    if (this.options.db.inTransaction) throw new MediaFilesError("admission-failed");
    if (this.lost) throw new MediaFilesError("ownership-lost");
    if (this.stopping && !allowStopping) throw new MediaFilesError("storage-closed");
    try { this.options.assertHeld(); }
    catch {
      this.lost = true;
      for (const controller of this.controllers) controller.abort();
      throw new MediaFilesError("ownership-lost");
    }
    if (mediaStoreId(this.options.db) !== this.storeId) throw new MediaStoragePathError("store-identity-conflict");
  }
  private readonly guard: MediaFileGuard = () => this.check();
  private readonly cleanupGuard: MediaFileGuard = () => this.check(true);

  private run<T>(operation: "publish" | "read" | "cleanup", action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.options.logger.verbose(`[media files] ${operation} attempt`);
    const controller = new AbortController();
    const flight = (async () => {
      try {
        this.check(); this.controllers.add(controller);
        const result = await action(controller.signal);
        this.check();
        this.options.logger.verbose(`[media files] ${operation} succeeded`);
        return result;
      } catch (error) {
        const safe = failure(error);
        this.options.logger.verbose(`[media files] ${operation} failed`,{reason:safe.code});
        if (safe.code !== "storage-closed") this.options.logger.warning("[media files] operation refused or unavailable",{operation,reason:safe.code});
        throw safe;
      } finally { this.controllers.delete(controller); }
    })();
    this.flights.add(flight);
    void flight.then(() => this.flights.delete(flight),() => this.flights.delete(flight));
    return flight;
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.gate, released = Promise.withResolvers<void>();
    this.gate = released.promise;
    await previous;
    try { this.check(); return await action(); } finally { released.resolve(); }
  }
  private source(sourceId: string): SourceFingerprint | null {
    return this.options.db.query<SourceFingerprint,[string]>("SELECT mime_type,byte_length,sha256 FROM media_sources WHERE id=?").get(sourceId);
  }
  private referenced(sourceId: string): boolean {
    return this.options.db.query("SELECT 1 FROM media_sources WHERE id=?").get(sourceId) !== null;
  }

  private async receive(file: OwnedMediaFile, input: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Fingerprint> {
    const iterator = input[Symbol.asyncIterator](), hash = createHash("sha256");
    let byteLength = 0, complete = false, returning: Promise<void> | undefined;
    const cancel = () => {
      if (returning) return;
      try {
        returning = Promise.resolve(iterator.return?.()).then(() => {},() => {
          this.options.logger.warning("[media files] input cancellation failed");
        });
      } catch { returning = Promise.resolve(); this.options.logger.warning("[media files] input cancellation failed"); }
    };
    signal.addEventListener("abort",cancel,{once:true});
    try {
      while (true) {
        this.check();
        const next = await iterator.next();
        this.check();
        if (next.done) { complete = true; break; }
        const bytes = next.value;
        if (!(bytes instanceof Uint8Array)) throw new MediaFilesError("invalid-input");
        if (bytes.byteLength > this.options.limits.maxBytes-byteLength) throw new MediaFilesError("source-too-large");
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await guardedFileIo(this.guard,() => file.handle.write(bytes,offset,bytes.length-offset,byteLength+offset));
          if (result.bytesWritten === 0) throw new MediaFilesError("storage-failed");
          offset += result.bytesWritten;
        }
        byteLength += bytes.length;
      }
      if (byteLength === 0) throw new MediaFilesError("invalid-input");
      return {byteLength,sha256:new Uint8Array(hash.digest())};
    } finally {
      signal.removeEventListener("abort",cancel);
      if (!complete) cancel();
      // Never abandon an entered producer merely because cancellation was requested.
      if (returning) await returning;
    }
  }

  private async readAndHash(file: OwnedMediaFile, byteLength: number, keepBytes: boolean): Promise<{ sha256: Uint8Array; bytes: Uint8Array }> {
    const bytes = keepBytes ? new Uint8Array(byteLength) : new Uint8Array(Math.min(byteLength,65536));
    const hash = createHash("sha256");
    let position = 0;
    while (position < byteLength) {
      const offset = keepBytes ? position : 0, length = Math.min(byteLength-position,keepBytes ? 65536 : bytes.length);
      const result = await guardedFileIo(this.guard,() => file.handle.read(bytes,offset,length,position));
      if (result.bytesRead === 0) throw new MediaFilesError("original-unavailable");
      hash.update(bytes.subarray(offset,offset+result.bytesRead)); position += result.bytesRead;
    }
    return {bytes,sha256:new Uint8Array(hash.digest())};
  }
  private async fingerprintStage(name: string, file: OwnedMediaFile, expected: Fingerprint): Promise<BigIntStats> {
    const before = await verifyMediaFile(this.layout.staging,name,file,this.guard);
    if (before.size !== BigInt(expected.byteLength)) throw new MediaFilesError("invalid-media");
    const actual = await this.readAndHash(file,expected.byteLength,false);
    const after = await verifyMediaFile(this.layout.staging,name,file,this.guard);
    if (!unchanged(before,after) || !timingSafeEqual(actual.sha256,expected.sha256)) throw new MediaFilesError("invalid-media");
    return after;
  }

  publish(sourceId: string, input: AsyncIterable<Uint8Array>, admit: (artifact: MediaFileArtifact) => void): Promise<MediaFileArtifact> {
    return this.run("publish",async signal => {
      mediaFileId(sourceId);
      if (this.activeSources.has(sourceId) || this.referenced(sourceId)) throw new MediaFilesError("source-exists");
      const name = `${mediaFileId(this.options.id())}.partial`;
      if (this.activeStaging.has(name)) throw new MediaFilesError("source-exists");
      this.activeSources.add(sourceId); this.activeStaging.add(name);
      let file: OwnedMediaFile | undefined, staged = false, linked = false;
      try {
        await this.layout.verify(this.guard);
        const stagedFile = await createMediaFile(this.layout.staging,name,this.guard); file = stagedFile; staged = true;
        const fingerprint = await this.receive(stagedFile,input,signal);
        await guardedFileIo(this.guard,() => this.io.sync(stagedFile.handle));
        const readOnly = await openMediaFile(this.layout.staging,name,this.guard);
        let mediaType: MediaFileMime;
        try {
          if (!sameMediaInode(file.identity,readOnly.identity)) throw new MediaStoragePathError();
          let result: Awaited<ReturnType<MediaFilesOptions["validate"]>>;
          try { result = await this.options.validate({fd:readOnly.handle.fd,byteLength:fingerprint.byteLength,signal}); }
          catch { this.check(); throw new MediaFilesError("invalid-media"); }
          this.check();
          mediaType = mime(result?.mimeType);
        } finally { await readOnly.handle.close(); }
        const validated = await this.fingerprintStage(name,file,fingerprint);
        const ownedFile = file;
        return await this.exclusive(async () => {
          await this.layout.verify(this.guard);
          if (this.referenced(sourceId)) throw new MediaFilesError("source-exists");
          const beforeLink = await verifyMediaFile(this.layout.staging,name,ownedFile,this.guard);
          if (!unchanged(validated,beforeLink)) throw new MediaFilesError("invalid-media");
          await guardedFileIo(this.guard,() => this.io.sync(ownedFile.handle));
          try { await guardedFileIo(this.guard,async () => {
            await this.io.link(mediaChild(this.layout.staging,name),mediaChild(this.layout.objects,sourceId)); linked = true;
          }); }
          catch (error) { if (hasFileCode(error,"EEXIST")) throw new MediaFilesError("source-exists"); throw error; }
          const alias = await inspectMediaFile(this.layout.objects,sourceId,this.guard,2n);
          const stagedAlias = await verifyMediaFile(this.layout.staging,name,ownedFile,this.guard,2n);
          if (!sameMediaInode(alias,stagedAlias)) throw new MediaStoragePathError();
          await guardedFileIo(this.guard,() => this.io.sync(this.layout.objects.handle));
          await guardedFileIo(this.guard,async () => { await this.io.unlink(mediaChild(this.layout.staging,name)); staged = false; });
          await guardedFileIo(this.guard,() => this.io.sync(this.layout.staging.handle));
          await guardedFileIo(this.guard,() => this.io.sync(ownedFile.handle));
          const published = await verifyMediaFile(this.layout.objects,sourceId,ownedFile,this.guard);
          if (published.size !== validated.size || published.mtimeNs !== validated.mtimeNs) throw new MediaFilesError("invalid-media");
          this.check();
          const artifact: MediaFileArtifact = Object.freeze({sourceId,mimeType:mediaType,byteLength:fingerprint.byteLength,sha256:new Uint8Array(fingerprint.sha256)});
          // The trusted callback owns its synchronous SQL transaction. No file I/O is nested in it.
          // On SQL rollback the published file remains an unreferenced orphan, never an overwritten original.
          const result: unknown = admit({...artifact,sha256:new Uint8Array(fingerprint.sha256)});
          if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
            void Promise.resolve(result).catch(() => {});
            throw new MediaFilesError("admission-failed");
          }
          this.check();
          const source = this.source(sourceId);
          if (!source || source.mime_type !== mediaType || source.byte_length !== fingerprint.byteLength ||
            !(source.sha256 instanceof Uint8Array) || source.sha256.length !== 32 || !timingSafeEqual(source.sha256,fingerprint.sha256)) {
            throw new MediaFilesError("admission-failed");
          }
          this.check();
          this.options.logger.info("[media files] original admitted",{sourceId});
          return artifact;
        });
      } finally {
        try {
          if (file && staged) {
            try {
              this.check(true);
              await verifyMediaFile(this.layout.staging,name,file,this.cleanupGuard,linked ? 2n : 1n);
              await guardedFileIo(this.cleanupGuard,() => this.io.unlink(mediaChild(this.layout.staging,name)));
              await guardedFileIo(this.cleanupGuard,() => this.io.sync(this.layout.staging.handle));
            } catch { this.options.logger.warning("[media files] unadmitted staging retained for owned cleanup",{sourceId}); }
          }
        } finally { try { await file?.handle.close(); } finally { this.activeStaging.delete(name); this.activeSources.delete(sourceId); } }
      }
    });
  }

  readOriginal(sourceId: string): Promise<Uint8Array> {
    return this.run("read",async () => {
      mediaFileId(sourceId);
      const source = this.source(sourceId);
      if (!source || !Number.isSafeInteger(source.byte_length) || source.byte_length <= 0 || source.byte_length > this.options.limits.maxBytes ||
        !(source.sha256 instanceof Uint8Array) || source.sha256.length !== 32) throw new MediaFilesError("original-unavailable");
      let file: OwnedMediaFile | undefined;
      try {
        await this.layout.verify(this.guard);
        file = await openMediaFile(this.layout.objects,sourceId,this.guard);
        const before = await verifyMediaFile(this.layout.objects,sourceId,file,this.guard);
        if (before.size !== BigInt(source.byte_length)) throw new MediaFilesError("original-unavailable");
        const result = await this.readAndHash(file,source.byte_length,true);
        const after = await verifyMediaFile(this.layout.objects,sourceId,file,this.guard);
        if (!unchanged(before,after) || !timingSafeEqual(result.sha256,source.sha256)) throw new MediaFilesError("original-unavailable");
        return result.bytes;
      } catch (error) {
        if (error instanceof MediaFilesError && ["ownership-lost","storage-closed","admission-failed"].includes(error.code)) throw error;
        throw new MediaFilesError("original-unavailable");
      } finally { await file?.handle.close(); }
    });
  }

  private async cleanupEntry(directory: MediaDirectory, kind: "objects" | "staging" | "prepared", name: string, cutoff: bigint): Promise<boolean> {
    // Prepared-part reference/settlement authority is not implemented in this slice. Retain them conservatively.
    if (kind === "prepared") return false;
    const key = kind === "staging" && name.endsWith(".partial") ? name.slice(0,-8) : name;
    try { mediaFileId(key); } catch { return false; }
    if ((kind === "staging" && (!name.endsWith(".partial") || this.activeStaging.has(name))) ||
      (kind === "objects" && (this.activeSources.has(name) || this.referenced(name)))) return false;
    let file: OwnedMediaFile | undefined;
    try {
      file = await openMediaFile(directory,name,this.guard);
      const before = await verifyMediaFile(directory,name,file,this.guard);
      if (before.mtimeMs > cutoff) return false;
      await this.layout.verify(this.guard);
      const after = await verifyMediaFile(directory,name,file,this.guard);
      if (!unchanged(before,after) || after.mtimeMs > cutoff) return false;
      // The same short gate excludes final SQL admission; rejection/attempt status never grants deletion.
      if (kind === "objects" && (this.activeSources.has(name) || this.referenced(name))) return false;
      this.check();
      await guardedFileIo(this.guard,() => this.io.unlink(mediaChild(directory,name)));
      await guardedFileIo(this.guard,() => this.io.sync(directory.handle));
      return true;
    } catch (error) {
      if (hasFileCode(error,"ENOENT") || error instanceof MediaStoragePathError) return false;
      throw error;
    } finally { await file?.handle.close(); }
  }

  cleanup(): Promise<{ readonly scanned: number; readonly removed: number; readonly hasMore: boolean }> {
    return this.run("cleanup",async () => this.exclusive(async () => {
      await this.layout.verify(this.guard);
      if (!this.sweep) {
        const now = this.options.now();
        if (!Number.isSafeInteger(now)) throw new MediaFilesError("invalid-input");
        this.sweep = {cutoff:BigInt(now)-BigInt(this.options.limits.orphanGraceMs),directory:0,reader:null};
      }
      const sweep = this.sweep, directories = [["objects",this.layout.objects],["staging",this.layout.staging],["prepared",this.layout.prepared]] as const;
      let scanned = 0, removed = 0;
      while (scanned < this.options.limits.cleanupBatchSize) {
        const current = directories[sweep.directory];
        if (!current) { this.sweep = undefined; break; }
        const [kind,directory] = current;
        const reader = sweep.reader ?? await openMediaScan(directory,this.guard);
        sweep.reader = reader;
        const entry = await guardedFileIo(this.guard,() => reader.read());
        if (entry === null) { await reader.close(); sweep.reader = null; sweep.directory++; continue; }
        scanned++;
        if (await this.cleanupEntry(directory,kind,entry.name,sweep.cutoff)) removed++;
      }
      if (removed) this.options.logger.info("[media files] unreferenced orphan cleanup applied",{removed});
      return {scanned,removed,hasMore:this.sweep !== undefined};
    }));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.options.logger.verbose("[media files] close attempt");
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    this.closing = (async () => {
      await Promise.allSettled([...this.flights]);
      const reader = this.sweep?.reader; this.sweep = undefined;
      const results = await Promise.allSettled([...(reader ? [reader.close()] : []),this.layout.close()]);
      if (results.some(result => result.status === "rejected")) {
        this.options.logger.error("[media files] resource close failed"); throw new MediaFilesError("storage-failed");
      }
      this.options.logger.info("[media files] closed");
    })();
    return this.closing;
  }
}

/** Initialize one owned, private metadata-matched file store. No format decoder or daemon startup is implicit. */
export async function openMediaFiles(options: MediaFilesOptions): Promise<MediaFiles> {
  options.logger.verbose("[media files] open attempt");
  let layout: OwnedMediaLayout | undefined;
  const guard = () => {
    if (options.db.inTransaction) throw new MediaFilesError("admission-failed");
    try { options.assertHeld(); } catch { throw new MediaFilesError("ownership-lost"); }
  };
  try {
    guard(); mediaFileId(options.storeId);
    const suppliedIo = options.io ?? defaultMediaFileOperations;
    const io: MediaFileOperations = Object.freeze({sync:suppliedIo.sync,link:suppliedIo.link,unlink:suppliedIo.unlink});
    const {maxBytes,orphanGraceMs,cleanupBatchSize} = options.limits;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(orphanGraceMs) || orphanGraceMs < 0 ||
      !Number.isSafeInteger(cleanupBatchSize) || cleanupBatchSize <= 0) throw new MediaFilesError("invalid-input");
    const saved = mediaStoreId(options.db);
    if (saved !== null && saved !== options.storeId) throw new MediaStoragePathError("store-identity-conflict");
    const hasSources = options.db.query("SELECT 1 FROM media_sources LIMIT 1").get() !== null;
    layout = await openMediaLayout(options.directory,options.storeId,!hasSources,saved !== null,guard,io);
    guard();
    initializeMediaStore(options.db,options.storeId);
    guard();
    await layout.verify(guard);
    options.logger.info("[media files] opened");
    return new OwnedMediaFiles(options,layout,io);
  } catch (error) {
    if (layout) await layout.close();
    const safe = failure(error);
    options.logger.warning("[media files] open failed",{reason:safe.code});
    throw safe;
  }
}
