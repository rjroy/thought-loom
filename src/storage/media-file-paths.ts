import { constants, type BigIntStats, type Dir } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, statfs, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export type MediaFileGuard = () => void;
/** Narrow file-publication operations; defaults remain the actual owned filesystem. */
export interface MediaFileOperations {
  readonly sync: (handle: FileHandle) => Promise<void>;
  readonly link: (source: string, destination: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}
export const defaultMediaFileOperations: MediaFileOperations = Object.freeze({
  sync: (handle: FileHandle) => handle.sync(), link, unlink,
});
export class MediaStoragePathError extends Error {
  constructor(readonly code: "unsupported-storage" | "unsafe-storage" | "store-identity-conflict" = "unsafe-storage") {
    super("Media storage ownership or identity is unavailable");
  }
}
// Match the daemon execution-owner's supported local Linux filesystem boundary.
const localFilesystems = new Set([0xef53,0x58465342,0x9123683e,0x01021994,0x794c7630,0x2fc12fc1,0xf2f52010]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function mediaFileId(value: string): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new MediaStoragePathError();
  return value;
}
export function hasFileCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
export async function guardedFileIo<T>(guard: MediaFileGuard, action: () => Promise<T>): Promise<T> {
  guard();
  try { const result = await action(); guard(); return result; }
  catch (error) { guard(); throw error; }
}
async function guardedResource<T extends { close(): Promise<void> }>(guard: MediaFileGuard, action: () => Promise<T>): Promise<T> {
  guard();
  const resource = await action();
  try { guard(); return resource; }
  catch (error) { await resource.close(); throw error; }
}
export function sameMediaInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function owned(info: BigIntStats, directory: boolean, links = 1n): void {
  if (info.uid !== BigInt(process.getuid?.() ?? -1) || (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o7777n) !== (directory ? 0o700n : 0o600n) || (!directory && info.nlink !== links)) throw new MediaStoragePathError();
}
export interface MediaDirectory {
  readonly handle: FileHandle;
  readonly identity: BigIntStats;
  readonly anchor: string;
}
export interface OwnedMediaLayout {
  readonly root: MediaDirectory;
  readonly objects: MediaDirectory;
  readonly staging: MediaDirectory;
  readonly prepared: MediaDirectory;
  verify(guard: MediaFileGuard): Promise<void>;
  close(): Promise<void>;
}
export interface OwnedMediaFile {
  readonly handle: FileHandle;
  readonly identity: BigIntStats;
}
/** Only store-generated names and the fixed layout names may cross the anchored path boundary. */
export function mediaChild(directory: MediaDirectory, name: string): string {
  if (!["store.json","objects","staging","prepared"].includes(name) && !uuid.test(name) &&
    !(name.endsWith(".partial") && uuid.test(name.slice(0,-8)))) throw new MediaStoragePathError();
  return `${directory.anchor}/${name}`;
}
export async function inspectMediaFile(directory: MediaDirectory, name: string, guard: MediaFileGuard, links = 1n): Promise<BigIntStats> {
  const info = await guardedFileIo(guard,() => lstat(mediaChild(directory,name),{bigint:true}));
  owned(info,false,links);
  return info;
}
export async function verifyMediaFile(directory: MediaDirectory, name: string, file: OwnedMediaFile,
  guard: MediaFileGuard, links = 1n): Promise<BigIntStats> {
  const current = await guardedFileIo(guard,() => file.handle.stat({bigint:true}));
  owned(current,false,links);
  const named = await inspectMediaFile(directory,name,guard,links);
  if (!sameMediaInode(file.identity,current) || !sameMediaInode(current,named) || current.size !== named.size) throw new MediaStoragePathError();
  return current;
}
export async function openMediaFile(directory: MediaDirectory, name: string, guard: MediaFileGuard): Promise<OwnedMediaFile> {
  const named = await inspectMediaFile(directory,name,guard);
  const handle = await guardedResource(guard,() => open(mediaChild(directory,name),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const identity = await guardedFileIo(guard,() => handle.stat({bigint:true}));
    owned(identity,false);
    if (!sameMediaInode(identity,named)) throw new MediaStoragePathError();
    return {handle,identity};
  } catch (error) { await handle.close(); throw error; }
}
export async function createMediaFile(directory: MediaDirectory, name: string, guard: MediaFileGuard): Promise<OwnedMediaFile> {
  const handle = await guardedResource(guard,() => open(mediaChild(directory,name),
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600));
  try {
    const identity = await guardedFileIo(guard,() => handle.stat({bigint:true}));
    owned(identity,false);
    const file = {handle,identity};
    await verifyMediaFile(directory,name,file,guard);
    return file;
  } catch (error) { await handle.close(); throw error; }
}
async function directoryAt(path: string, guard: MediaFileGuard, privateDirectory = true): Promise<MediaDirectory> {
  const named = await guardedFileIo(guard,() => lstat(path,{bigint:true}));
  if (!named.isDirectory() || named.uid !== BigInt(process.getuid?.() ?? -1) || (named.mode & 0o022n) !== 0n) throw new MediaStoragePathError();
  if (privateDirectory) owned(named,true);
  const handle = await guardedResource(guard,() => open(path,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  try {
    const identity = await guardedFileIo(guard,() => handle.stat({bigint:true}));
    if (!sameMediaInode(identity,named)) throw new MediaStoragePathError();
    if (!localFilesystems.has(Number((await guardedFileIo(guard,() => statfs(`/proc/self/fd/${handle.fd}`,{bigint:true}))).type & 0xffffffffn))) {
      throw new MediaStoragePathError("unsupported-storage");
    }
    return {handle,identity,anchor:`/proc/self/fd/${handle.fd}`};
  } catch (error) { await handle.close(); throw error; }
}
async function verifyDirectory(directory: MediaDirectory, path: string, guard: MediaFileGuard): Promise<void> {
  const held = await guardedFileIo(guard,() => directory.handle.stat({bigint:true}));
  const named = await guardedFileIo(guard,() => lstat(path,{bigint:true}));
  owned(held,true); owned(named,true);
  if (!sameMediaInode(held,directory.identity) || !sameMediaInode(held,named)) throw new MediaStoragePathError();
}
async function emptyDirectory(directory: MediaDirectory, guard: MediaFileGuard): Promise<boolean> {
  const reader = await openMediaScan(directory,guard);
  try { return (await guardedFileIo(guard,() => reader.read())) === null; }
  finally { await reader.close(); }
}
export function openMediaScan(directory: MediaDirectory, guard: MediaFileGuard): Promise<Dir> {
  return guardedResource(guard,() => opendir(directory.anchor));
}
async function readMarker(root: MediaDirectory, marker: OwnedMediaFile, storeId: string, guard: MediaFileGuard): Promise<void> {
  const info = await verifyMediaFile(root,"store.json",marker,guard);
  if (info.size > 1024n || info.size === 0n) throw new MediaStoragePathError("store-identity-conflict");
  const bytes = new Uint8Array(Number(info.size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await guardedFileIo(guard,() => marker.handle.read(bytes,offset,bytes.length-offset,offset));
    if (result.bytesRead === 0) throw new MediaStoragePathError("store-identity-conflict");
    offset += result.bytesRead;
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); }
  catch { throw new MediaStoragePathError("store-identity-conflict"); }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2 ||
    !("version" in value) || value.version !== 1 || !("storeId" in value) || value.storeId !== storeId) throw new MediaStoragePathError("store-identity-conflict");
  const after = await verifyMediaFile(root,"store.json",marker,guard);
  if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) throw new MediaStoragePathError();
}

/** Filesystem phase only. The caller initializes SQLite identity after the marker/directories are durable. */
export async function openMediaLayout(path: string, storeId: string, allowInitialize: boolean,
  allowExistingMarker: boolean, guard: MediaFileGuard, io: MediaFileOperations = defaultMediaFileOperations): Promise<OwnedMediaLayout> {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || !isAbsolute(path) || path.includes("\0")) {
    throw new MediaStoragePathError("unsupported-storage");
  }
  mediaFileId(storeId);
  const requested = resolve(path), parentPath = await guardedFileIo(guard,() => realpath(dirname(requested)));
  const parent = await directoryAt(parentPath,guard,false), handles: FileHandle[] = [parent.handle];
  const rootPath = `${parent.anchor}/${basename(requested)}`;
  try {
    // The configured root is trusted configuration, never a client-selected artifact path.
    try { await guardedFileIo(guard,() => lstat(rootPath)); }
    catch (error) {
      if (!hasFileCode(error,"ENOENT") || !allowInitialize) throw error;
      await guardedFileIo(guard,() => mkdir(rootPath,{mode:0o700}));
      await guardedFileIo(guard,() => io.sync(parent.handle));
    }
    const root = await directoryAt(rootPath,guard); handles.push(root.handle);
    let initialize = false;
    try { await guardedFileIo(guard,() => lstat(mediaChild(root,"store.json"))); }
    catch (error) {
      if (!hasFileCode(error,"ENOENT")) throw error;
      if (!allowInitialize || !await emptyDirectory(root,guard)) throw new MediaStoragePathError("store-identity-conflict");
      initialize = true;
    }
    if (!initialize && !allowExistingMarker) throw new MediaStoragePathError("store-identity-conflict");
    let marker: OwnedMediaFile | undefined;
    if (!initialize) {
      marker = await openMediaFile(root,"store.json",guard); handles.push(marker.handle);
      await readMarker(root,marker,storeId,guard);
    }
    const directories: MediaDirectory[] = [];
    for (const name of ["objects","staging","prepared"]) {
      if (initialize) await guardedFileIo(guard,() => mkdir(mediaChild(root,name),{mode:0o700}));
      const directory = await directoryAt(mediaChild(root,name),guard);
      if (directory.identity.dev !== root.identity.dev) { await directory.handle.close(); throw new MediaStoragePathError("unsupported-storage"); }
      handles.push(directory.handle); directories.push(directory);
      if (initialize) await guardedFileIo(guard,() => io.sync(directory.handle));
    }
    const [objects,staging,prepared] = directories;
    if (!objects || !staging || !prepared) throw new MediaStoragePathError();
    if (initialize) {
      marker = await createMediaFile(root,"store.json",guard); handles.push(marker.handle);
      const newMarker = marker;
      const bytes = new TextEncoder().encode(`${JSON.stringify({version:1,storeId})}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await guardedFileIo(guard,() => newMarker.handle.write(bytes,offset,bytes.length-offset,offset));
        if (result.bytesWritten === 0) throw new MediaStoragePathError();
        offset += result.bytesWritten;
      }
      await guardedFileIo(guard,() => io.sync(newMarker.handle));
      await guardedFileIo(guard,() => io.sync(root.handle));
      await guardedFileIo(guard,() => io.sync(parent.handle));
    }
    if (!marker) throw new MediaStoragePathError();
    const ownedMarker = marker;
    await readMarker(root,ownedMarker,storeId,guard);
    return {root,objects,staging,prepared,
      async verify(check) {
        await verifyDirectory(root,rootPath,check);
        for (const [name,directory] of [["objects",objects],["staging",staging],["prepared",prepared]] as const) {
          await verifyDirectory(directory,mediaChild(root,name),check);
        }
        await readMarker(root,ownedMarker,storeId,check);
      },
      async close() {
        const results = await Promise.allSettled([...handles].reverse().map(handle => handle.close()));
        if (results.some(result => result.status === "rejected")) throw new MediaStoragePathError();
      },
    };
  } catch (error) { await Promise.allSettled([...handles].reverse().map(handle => handle.close())); throw error; }
}
