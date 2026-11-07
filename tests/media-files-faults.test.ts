import { describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, readFile, readdir, readlink, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaFiles } from "../src/storage/media-files";
import { bounded, fileBytes, fileChunks, fileDigest, fileId, fileSourceId, fileStoreId,
  mediaFileFaults, mediaFileFixture, type MediaFileFaultBoundary, type MediaFileFixture } from "./fixtures/media-files";

const protectedId = fileId(50);
const objectPath = (f: MediaFileFixture, id = fileSourceId): string => join(f.directory,"objects",id);
const bytesAt = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));
function onlyProtectedSource(f: MediaFileFixture): void {
  expect(f.db.query("SELECT id FROM media_sources ORDER BY id").all()).toEqual([{id:protectedId}]);
  expect(f.db.query("SELECT id FROM thoughts WHERE kind='media-original' ORDER BY id").all()).toEqual([{id:`thought-${protectedId}`}]);
  expect(f.db.query("SELECT thought_id FROM thought_source_seals ORDER BY thought_id").all()).toEqual([{thought_id:`thought-${protectedId}`}]);
  expect(f.db.query("SELECT * FROM runs").all()).toEqual([]);
}
async function completeSweep(files: MediaFiles): Promise<number> {
  let removed = 0;
  for (let page = 0; page < 32; page++) {
    const result = await files.cleanup();
    expect(result.scanned).toBeLessThanOrEqual(1);
    expect(result.removed).toBeLessThanOrEqual(result.scanned);
    removed += result.removed;
    if (!result.hasMore) return removed;
  }
  throw new Error("Owned orphan cleanup did not finish its bounded pass");
}

describe("owned media publication fault boundaries", () => {
  const cases: readonly { readonly boundary: MediaFileFaultBoundary; readonly published: boolean }[] = [
    {boundary:"staged-file-sync",published:false},
    {boundary:"link",published:false},
    {boundary:"objects-directory-sync",published:true},
    {boundary:"staging-unlink",published:true},
    {boundary:"staging-directory-sync",published:true},
    {boundary:"published-file-sync",published:true},
  ];
  for (const {boundary,published} of cases) test(`${boundary} failure cannot falsely admit SQL or lose an existing original`, async () => mediaFileFixture(async f => {
    const faults = mediaFileFaults(), files = await f.open({io:faults.io});
    await files.publish(protectedId,fileChunks(),f.save);
    const protectedBefore = await lstat(objectPath(f,protectedId),{bigint:true});
    let admitted = 0, validated = 0;
    // Reopen with the same test-owned I/O delegate so validation attempts can be observed independently.
    await files.close();
    const active = await f.open({io:faults.io,async validate(input) { validated++; return f.options.validate(input); }});
    faults.fail(boundary);
    const outcome = await active.publish(fileSourceId,fileChunks(),artifact => { admitted++; f.save(artifact); })
      .then(() => "published",() => "rejected");
    // These are the primary assertions, before checking whether the injected seam was exercised.
    onlyProtectedSource(f);
    expect(admitted).toBe(0); expect(outcome).toBe("rejected");
    expect(faults.hits).toBe(1);
    expect(validated).toBe(boundary === "staged-file-sync" ? 0 : 1);
    expect(await readdir(join(f.directory,"staging"))).toEqual([]);
    expect((await readdir(join(f.directory,"objects"))).sort()).toEqual((published ? [protectedId,fileSourceId] : [protectedId]).sort());
    if (published) {
      expect(await bytesAt(objectPath(f))).toEqual(fileBytes);
      expect((await lstat(objectPath(f))).nlink).toBe(1);
      await expect(active.readOriginal(fileSourceId)).rejects.toThrow();
      const old = new Date(f.now()-2000); await utimes(objectPath(f),old,old);
    }
    expect(await completeSweep(active)).toBe(published ? 1 : 0);
    expect(await readdir(join(f.directory,"objects"))).toEqual([protectedId]);
    expect(await active.readOriginal(protectedId)).toEqual(fileBytes);
    expect((await lstat(objectPath(f,protectedId),{bigint:true})).ino).toBe(protectedBefore.ino);
    onlyProtectedSource(f);
  }));

  test("an ambiguous link failure preserves its real bytes without admitting or exposing an unreferenced original", async () => mediaFileFixture(async f => {
    const faults = mediaFileFaults(), files = await f.open({io:faults.io});
    await files.publish(protectedId,fileChunks(),f.save);
    faults.fail("link","after");
    let admitted = 0;
    const outcome = await files.publish(fileSourceId,fileChunks(),artifact => { admitted++; f.save(artifact); })
      .then(() => "published",() => "rejected");
    onlyProtectedSource(f);
    expect(admitted).toBe(0); expect(outcome).toBe("rejected"); expect(faults.hits).toBe(1);
    expect(await bytesAt(objectPath(f))).toEqual(fileBytes);
    const object = await lstat(objectPath(f),{bigint:true}), staged = await readdir(join(f.directory,"staging"));
    expect(staged.length).toBeLessThanOrEqual(1);
    if (staged.length) {
      const name = staged[0]; if (name === undefined) throw new Error("Missing interrupted staging alias");
      const alias = await lstat(join(f.directory,"staging",name),{bigint:true});
      expect(alias.ino).toBe(object.ino); expect(alias.dev).toBe(object.dev);
      expect(alias.nlink).toBe(2n); expect(object.nlink).toBe(2n);
      expect(await bytesAt(join(f.directory,"staging",name))).toEqual(fileBytes);
    } else expect(object.nlink).toBe(1n);
    await expect(files.readOriginal(fileSourceId)).rejects.toThrow();
    expect(await files.readOriginal(protectedId)).toEqual(fileBytes);
  }));

  test("a real no-replace collision preserves an unreferenced existing object and refuses source admission", async () => mediaFileFixture(async f => {
    const files = await f.open(), existing = Uint8Array.of(91,92,93);
    await writeFile(objectPath(f),existing,{mode:0o600});
    const before = await lstat(objectPath(f),{bigint:true});
    let admitted = false;
    await expect(files.publish(fileSourceId,fileChunks(),artifact => { admitted = true; f.save(artifact); })).rejects.toThrow();
    expect(admitted).toBe(false); expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM thoughts").all()).toEqual([]);
    expect(await bytesAt(objectPath(f))).toEqual(existing);
    expect((await lstat(objectPath(f),{bigint:true})).ino).toBe(before.ino);
    expect(await readdir(join(f.directory,"staging"))).toEqual([]);
    await expect(files.readOriginal(fileSourceId)).rejects.toThrow();
  }));

  test("SQL admission throwing before a write leaves only an unreferenced durable orphan for bounded cleanup", async () => mediaFileFixture(async f => {
    const files = await f.open(); let entered = false;
    await expect(files.publish(fileSourceId,fileChunks(),() => {
      entered = true; expect(f.db.inTransaction).toBe(false);
      throw new Error("test-owned admission rejected before SQL");
    })).rejects.toThrow();
    expect(entered).toBe(true);
    expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM thoughts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM thought_source_seals").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM runs").all()).toEqual([]);
    expect(await bytesAt(objectPath(f))).toEqual(fileBytes);
    expect((await lstat(objectPath(f))).nlink).toBe(1);
    await expect(files.readOriginal(fileSourceId)).rejects.toThrow();
    await utimes(objectPath(f),new Date(f.now()-2000),new Date(f.now()-2000));
    expect(await completeSweep(files)).toBe(1);
    expect(await readdir(join(f.directory,"objects"))).toEqual([]);
    expect(await readdir(join(f.directory,"staging"))).toEqual([]);
  }));

  test("SQL admission throwing after a matching commit never deletes the original during failure, cleanup, or reopen", async () => mediaFileFixture(async f => {
    const files = await f.open(); let entered = 0;
    await expect(files.publish(fileSourceId,fileChunks(),artifact => {
      entered++; f.save(artifact); throw new Error("test-owned ambiguous result after SQL commit");
    })).rejects.toThrow();
    expect(entered).toBe(1);
    expect(f.db.query("SELECT id,sha256,byte_length FROM media_sources").all()).toEqual([{id:fileSourceId,sha256:fileDigest,byte_length:fileBytes.length}]);
    expect(f.db.query("SELECT id FROM thoughts").all()).toEqual([{id:`thought-${fileSourceId}`}]);
    expect(f.db.query("SELECT thought_id FROM thought_source_seals").all()).toEqual([{thought_id:`thought-${fileSourceId}`}]);
    expect(f.db.query("SELECT * FROM runs").all()).toEqual([]);
    expect(await files.readOriginal(fileSourceId)).toEqual(fileBytes);
    const before = await lstat(objectPath(f),{bigint:true});
    await utimes(objectPath(f),new Date(f.now()-2000),new Date(f.now()-2000));
    expect(await completeSweep(files)).toBe(0);
    await files.close(); const reopened = await f.open();
    expect(await reopened.readOriginal(fileSourceId)).toEqual(fileBytes);
    expect((await lstat(objectPath(f),{bigint:true})).ino).toBe(before.ino);
    expect(await readdir(join(f.directory,"staging"))).toEqual([]);
    let retried = false;
    await expect(reopened.publish(fileSourceId,fileChunks(),() => { retried = true; })).rejects.toThrow();
    expect(retried).toBe(false);
    expect(await reopened.readOriginal(fileSourceId)).toEqual(fileBytes);
  }));
});

async function snapshot(path: string) {
  const info = await lstat(path,{bigint:true});
  return {path,dev:info.dev,ino:info.ino,uid:info.uid,mode:info.mode,nlink:info.nlink,size:info.size,mtime:info.mtimeNs,ctime:info.ctimeNs,
    content:info.isSymbolicLink() ? await readlink(path) : info.isFile() ? await bytesAt(path) : (await readdir(path)).sort()};
}

describe("unsafe media initialization preserves existing storage", () => {
  for (const scenario of ["corrupt-marker","mismatched-marker","writable-marker","hardlinked-marker","symlink-marker",
    "writable-root","symlink-root","symlink-objects","writable-staging","non-directory-prepared"] as const) {
    test(`refuses ${scenario} without repairing, adopting, or changing existing bytes`, async () => mediaFileFixture(async f => {
      const files = await f.open(); await files.publish(fileSourceId,fileChunks(),f.save); await files.close();
      let root = f.directory, objects = join(root,"objects"), markerBytesPath = join(root,"store.json");
      const extra: string[] = [];
      if (scenario === "corrupt-marker") await writeFile(markerBytesPath,"{test-owned invalid JSON",{mode:0o600});
      if (scenario === "mismatched-marker") await writeFile(markerBytesPath,JSON.stringify({version:1,storeId:fileId(99)}),{mode:0o600});
      if (scenario === "writable-marker") await chmod(markerBytesPath,0o660);
      if (scenario === "hardlinked-marker") { const alias = join(f.dir,"marker-alias"); await link(markerBytesPath,alias); extra.push(alias); }
      if (scenario === "symlink-marker") {
        const kept = join(f.dir,"kept-marker"); await rename(markerBytesPath,kept); await symlink(kept,markerBytesPath);
        markerBytesPath = kept; extra.push(kept);
      }
      if (scenario === "writable-root") await chmod(root,0o770);
      if (scenario === "symlink-root") {
        root = join(f.dir,"kept-root"); await rename(f.directory,root); await symlink(root,f.directory);
        objects = join(root,"objects"); markerBytesPath = join(root,"store.json");
      }
      if (scenario === "symlink-objects") {
        const kept = join(f.dir,"kept-objects"); await rename(objects,kept); await symlink(kept,objects); objects = kept; extra.push(kept);
      }
      if (scenario === "writable-staging") await chmod(join(root,"staging"),0o770);
      if (scenario === "non-directory-prepared") {
        const kept = join(f.dir,"kept-prepared"); await rename(join(root,"prepared"),kept);
        await writeFile(join(root,"prepared"),"test-owned non-directory",{mode:0o600}); extra.push(kept);
      }
      const paths = [...new Set([f.directory,root,...["store.json","objects","staging","prepared"].map(name => join(root,name)),
        join(objects,fileSourceId),...extra])];
      const before = await Promise.all(paths.map(snapshot)), markerBefore = await bytesAt(markerBytesPath);
      await expect(f.open()).rejects.toThrow();
      expect(await Promise.all(paths.map(snapshot))).toEqual(before);
      expect(await bytesAt(markerBytesPath)).toEqual(markerBefore);
      expect(await bytesAt(join(objects,fileSourceId))).toEqual(fileBytes);
      expect(f.store.mediaStoreId()).toBe(fileStoreId);
      expect(f.db.query("SELECT id,sha256 FROM media_sources").all()).toEqual([{id:fileSourceId,sha256:fileDigest}]);
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }));
  }

  test("a valid populated filesystem marker cannot initialize an uninitialized database by adoption", async () => mediaFileFixture(async f => {
    await mkdir(f.directory,{mode:0o700});
    for (const name of ["objects","staging","prepared"]) await mkdir(join(f.directory,name),{mode:0o700});
    const marker = join(f.directory,"store.json");
    await writeFile(marker,JSON.stringify({version:1,storeId:fileStoreId}),{mode:0o600});
    await writeFile(objectPath(f),fileBytes,{mode:0o600});
    const paths = [f.directory,marker,objectPath(f),...["objects","staging","prepared"].map(name => join(f.directory,name))];
    const before = await Promise.all(paths.map(snapshot));
    expect(f.store.mediaStoreId()).toBeNull();
    await expect(f.open()).rejects.toThrow();
    expect(f.store.mediaStoreId()).toBeNull();
    expect(await Promise.all(paths.map(snapshot))).toEqual(before);
    expect(await bytesAt(objectPath(f))).toEqual(fileBytes);
    expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
  }));
});

describe("publication I/O lifetime boundaries", () => {
  for (const lifecycle of ["close","fence-loss"] as const) test(`${lifecycle} joins held published I/O and prevents late SQL admission`, async () => mediaFileFixture(async f => {
    const faults = mediaFileFaults(), files = await f.open({io:faults.io});
    // Close while both publication aliases exist; lose ownership after staging removal is already real.
    const held = faults.hold(lifecycle === "close" ? "link" : "staging-directory-sync","after");
    let admitted = false, closed = false;
    const publishing = files.publish(fileSourceId,fileChunks(),artifact => { admitted = true; f.save(artifact); });
    const publication = publishing.then(() => "published",() => "rejected");
    let closing: Promise<void> | undefined;
    try {
      const entered = await bounded(Promise.race([held.entered.then(() => "held"),publication.then(() => "finished")]),"held publication I/O");
      expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
      expect(entered).toBe("held"); expect(faults.hits).toBe(1);
      expect(await bytesAt(objectPath(f))).toEqual(fileBytes);
      if (lifecycle === "close") {
        expect((await lstat(objectPath(f))).nlink).toBe(2);
        closing = files.close().then(() => { closed = true; });
        await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
        await expect(files.publish(fileId(3),fileChunks(),f.save)).rejects.toThrow();
      } else {
        expect((await lstat(objectPath(f))).nlink).toBe(1);
        f.expire();
        await expect(files.cleanup()).rejects.toThrow();
        closing = files.close().then(() => { closed = true; });
        await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
      }
      held.release();
      expect(await bounded(publication,"fenced publication completion")).toBe("rejected");
      if (!closing) throw new Error("Missing owned file shutdown");
      await bounded(closing,"joined publication file handles");
      expect(closed).toBe(true); expect(admitted).toBe(false);
      expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
      expect(f.db.query("SELECT * FROM thoughts").all()).toEqual([]);
      expect(f.db.query("SELECT * FROM runs").all()).toEqual([]);
      expect(await bytesAt(objectPath(f))).toEqual(fileBytes);
      expect((await lstat(objectPath(f))).nlink).toBe(1);
      expect(await readdir(join(f.directory,"staging"))).toEqual([]);
      await expect(files.readOriginal(fileSourceId)).rejects.toThrow();
      if (lifecycle === "close") {
        const reopened = await f.open();
        await utimes(objectPath(f),new Date(f.now()-2000),new Date(f.now()-2000));
        expect(await completeSweep(reopened)).toBe(1);
        expect(await readdir(join(f.directory,"objects"))).toEqual([]);
      }
    } finally { held.release(); await Promise.allSettled([publishing,...(closing ? [closing] : [])]); }
  }));
});
