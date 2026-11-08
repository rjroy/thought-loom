import { describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { link, lstat, mkdir, readFile, readdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { bounded, fileBytes, fileChunks, fileDigest, fileId, fileSourceId, fileStoreId, mediaFileFixture } from "./fixtures/media-files";

const readBytes = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));

describe("owned retained media files with an injected validator", () => {
  test("initializes private directories and a matching marker, then reopens without replacing identity", async () => mediaFileFixture(async f => {
    expect(f.store.mediaStoreId()).toBeNull();
    const opening = f.open();
    await expect(opening).resolves.toMatchObject({ storeId:fileStoreId });
    const files = await opening;
    expect(f.store.mediaStoreId()).toBe(fileStoreId);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Owned Linux media fixture requires a process UID");
    for (const directory of [f.directory,...["objects","staging","prepared"].map(name => join(f.directory,name))]) {
      const info = await lstat(directory);
      expect(info.isDirectory()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.mode & 0o777).toBe(0o700);
      expect(info.uid).toBe(uid);
    }
    const marker = join(f.directory,"store.json"), before = await readFile(marker), identity = await lstat(marker,{bigint:true});
    expect(JSON.parse(before.toString("utf8"))).toEqual({ version:1,storeId:fileStoreId });
    expect(identity.isFile()).toBe(true);
    expect(identity.nlink).toBe(1n);
    expect(identity.mode & 0o777n).toBe(0o600n);
    expect(await readdir(join(f.directory,"objects"))).toEqual([]);
    await files.close();
    const reopened = await f.open();
    expect(reopened.storeId).toBe(fileStoreId);
    expect(await readFile(marker)).toEqual(before);
    expect((await stat(marker,{bigint:true})).ino).toBe(identity.ino);
    expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
  }));

  test("stages actual streamed bytes before validation and publishes immutable verified originals before SQL admission", async () => mediaFileFixture(async f => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let commits = 0;
    const files = await f.open({ async validate(input) {
      expect(f.db.inTransaction).toBe(false);
      entered.resolve(); await release.promise;
      return f.options.validate(input);
    } });
    const object = join(f.directory,"objects",fileSourceId);
    const publishing = files.publish(fileSourceId,fileChunks(),artifact => {
      commits++;
      expect(f.db.inTransaction).toBe(false);
      expect(new Uint8Array(readFileSync(object))).toEqual(fileBytes);
      expect(lstatSync(object).nlink).toBe(1);
      expect(readdirSync(join(f.directory,"staging"))).toEqual([]);
      expect(artifact).toMatchObject({ sourceId:fileSourceId,mimeType:"image/png",byteLength:fileBytes.length });
      expect(new Uint8Array(artifact.sha256)).toEqual(fileDigest);
      f.save(artifact);
    });
    try {
      await bounded(entered.promise,"staged validator entry");
      expect(await readdir(join(f.directory,"objects"))).toEqual([]);
      expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
      const staged = await readdir(join(f.directory,"staging"));
      expect(staged).toHaveLength(1);
      const name = staged[0];
      if (name === undefined) throw new Error("Missing owned staging file");
      expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/);
      const info = await lstat(join(f.directory,"staging",name));
      expect(info.mode & 0o777).toBe(0o600); expect(info.nlink).toBe(1);
      release.resolve();
      const artifact = await bounded(publishing,"validated publication");
      expect(commits).toBe(1);
      expect(new Uint8Array(artifact.sha256)).toEqual(fileDigest);
      expect(new Uint8Array(await files.readOriginal(fileSourceId))).toEqual(fileBytes);
      expect(await files.originalPath(fileSourceId)).toBe(object);
      expect(await readBytes(await files.originalPath(fileSourceId))).toEqual(fileBytes);
      expect(f.db.query("SELECT sha256,byte_length FROM media_sources").get()).toEqual({ sha256:fileDigest,byte_length:fileBytes.length });
      expect(f.db.query("SELECT * FROM runs").all()).toEqual([]);
      const retained = await lstat(object);
      expect(retained.mode & 0o777).toBe(0o600); expect(retained.nlink).toBe(1);
      await expect(files.publish(fileSourceId,fileChunks(Uint8Array.of(1,2,3)),() => { commits++; })).rejects.toThrow();
      expect(commits).toBe(1); expect(await readBytes(object)).toEqual(fileBytes);
      const corrupted = new Uint8Array(fileBytes); corrupted[0] = 1;
      await writeFile(object,corrupted);
      await expect(files.readOriginal(fileSourceId)).rejects.toThrow();
      await expect(files.originalPath(fileSourceId)).rejects.toThrow();
      expect(f.db.query("SELECT sha256 FROM media_sources").get()).toEqual({ sha256:fileDigest });
      const logText = JSON.stringify(f.logs);
      for (const sensitive of ["private-original-sentinel","display-only.png","Zircon clarification"]) expect(logText).not.toContain(sensitive);
    } finally { release.resolve(); await Promise.allSettled([publishing]); }
  }));

  test("bounds actual input and cancels oversized streams before validation or canonical publication", async () => mediaFileFixture(async f => {
    let validated = 0, committed = 0, returned = false, pulled = 0;
    const files = await f.open({ limits:{...f.options.limits,maxBytes:8}, async validate(input) {
      validated++; return f.options.validate(input);
    } });
    async function* excessive() {
      try { pulled++; yield new Uint8Array(5); pulled++; yield new Uint8Array(5); pulled++; yield new Uint8Array(5); }
      finally { returned = true; }
    }
    await expect(files.publish(fileSourceId,excessive(),() => { committed++; })).rejects.toThrow();
    expect(returned).toBe(true); expect(pulled).toBe(2);
    await expect(files.publish(fileId(3),fileChunks(new Uint8Array()),() => { committed++; })).rejects.toThrow();
    expect(validated).toBe(0); expect(committed).toBe(0);
    expect(await readdir(join(f.directory,"staging"))).toEqual([]);
    expect(await readdir(join(f.directory,"objects"))).toEqual([]);
    expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
  }));

  test("validation rejection leaves no published original or SQL admission", async () => mediaFileFixture(async f => {
    let committed = false, validated = false;
    const files = await f.open({ async validate(input) {
      validated = true; await f.options.validate(input); throw new Error("test-owned validation rejection");
    } });
    await expect(files.publish(fileSourceId,fileChunks(),() => { committed = true; })).rejects.toThrow();
    expect(validated).toBe(true); expect(committed).toBe(false);
    expect(await readdir(join(f.directory,"staging"))).toEqual([]);
    expect(await readdir(join(f.directory,"objects"))).toEqual([]);
    expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
  }));

  test("refuses mismatched identities and populated missing-marker directories without adopting or repairing them", async () => {
    for (const scenario of ["database-mismatch","marker-mismatch","missing-marker"] as const) await mediaFileFixture(async f => {
      f.store.initializeMediaStore(fileStoreId);
      await mkdir(f.directory,{mode:0o700});
      const sentinel = join(f.directory,"existing-original"), marker = join(f.directory,"store.json");
      await writeFile(sentinel,fileBytes,{mode:0o600});
      if (scenario === "marker-mismatch") await writeFile(marker,JSON.stringify({version:1,storeId:fileId(99)}),{mode:0o600});
      if (scenario === "database-mismatch") await writeFile(marker,JSON.stringify({version:1,storeId:fileStoreId}),{mode:0o600});
      const before = (await readdir(f.directory)).sort(), beforeMarker = scenario === "missing-marker" ? null : await readFile(marker);
      await expect(f.open({storeId:scenario === "database-mismatch" ? fileId(99) : fileStoreId})).rejects.toThrow();
      expect((await readdir(f.directory)).sort()).toEqual(before);
      expect(await readBytes(sentinel)).toEqual(fileBytes);
      if (beforeMarker !== null) expect(await readFile(marker)).toEqual(beforeMarker);
      expect(f.store.mediaStoreId()).toBe(fileStoreId);
    });
  });

  test("verified reads reject same-byte symlink and hardlink substitutions and noncanonical source paths", async () => {
    for (const substitution of ["symlink","hardlink"] as const) await mediaFileFixture(async f => {
      let validated = 0, invalidAdmissions = 0;
      const files = await f.open({ async validate(input) { validated++; return f.options.validate(input); } });
      await files.publish(fileSourceId,fileChunks(),f.save);
      expect(new Uint8Array(await files.readOriginal(fileSourceId))).toEqual(fileBytes);
      const outside = join(f.dir,"not-a-store-object"), object = join(f.directory,"objects",fileSourceId);
      await writeFile(outside,fileBytes,{mode:0o600}); await unlink(object);
      if (substitution === "symlink") await symlink(outside,object); else await link(outside,object);
      await expect(files.readOriginal(fileSourceId)).rejects.toThrow();
      for (const id of ["../not-a-store-object",outside,"00000000-0000-4000-8000-0000000000AF",`file:${outside}`]) {
        await expect(files.readOriginal(id)).rejects.toThrow();
        await expect(files.publish(id,fileChunks(),() => { invalidAdmissions++; })).rejects.toThrow();
      }
      expect(validated).toBe(1); expect(invalidAdmissions).toBe(0);
      expect(await readBytes(outside)).toEqual(fileBytes);
      expect(f.db.query("SELECT source_thought_id FROM media_sources").all()).toHaveLength(1);
    });
  });

  test("cleanup walks bounded pages with grace and never removes SQL-referenced rejected originals or unknown entries", async () => mediaFileFixture(async f => {
    const files = await f.open();
    await files.publish(fileSourceId,fileChunks(),f.save);
    new RejectionService(new SqliteRejectionRepository(f.db,f.options.logger)).rejectThought("user",`thought-${fileSourceId}`);
    const old = new Date(f.now()-2000), fresh = new Date(f.now());
    const object = (id: string) => join(f.directory,"objects",id);
    await utimes(object(fileSourceId),old,old);
    for (const id of [fileId(30),fileId(31),fileId(32)]) await writeFile(object(id),fileBytes,{mode:0o600});
    for (const id of [fileId(30),fileId(31)]) await utimes(object(id),old,old);
    await utimes(object(fileId(32)),fresh,fresh);
    await expect(files.readOriginal(fileId(32))).rejects.toThrow(); // Bytes without a SQL source are not an original read.
    const unknown = join(f.directory,"objects","operator-note.txt");
    await writeFile(unknown,"test-owned unknown entry",{mode:0o600}); await utimes(unknown,old,old);
    let removed = 0, complete = false;
    for (let page = 0; page < 20; page++) {
      const result = await files.cleanup();
      expect(result.scanned).toBeGreaterThanOrEqual(0); expect(result.scanned).toBeLessThanOrEqual(1);
      expect(result.removed).toBeLessThanOrEqual(result.scanned); removed += result.removed;
      if (!result.hasMore) { complete = true; break; }
    }
    expect(complete).toBe(true); expect(removed).toBe(2);
    expect((await readdir(join(f.directory,"objects"))).sort()).toEqual([fileSourceId,fileId(32),"operator-note.txt"].sort());
    expect(await readBytes(object(fileSourceId))).toEqual(fileBytes);
    expect(await readFile(unknown,"utf8")).toBe("test-owned unknown entry");
    expect(f.db.query("SELECT * FROM media_sources").all()).toHaveLength(1);
    expect(f.db.query("SELECT * FROM rejected_thoughts").all()).toEqual([{thought_id:`thought-${fileSourceId}`}]);
    f.advance(1001);
    for (let page = 0; page < 20; page++) { if (!(await files.cleanup()).hasMore) break; }
    expect((await readdir(join(f.directory,"objects"))).sort()).toEqual([fileSourceId,"operator-note.txt"].sort());
  }));

  test("active staging is excluded from cleanup and close joins a held validator before releasing ownership", async () => mediaFileFixture(async f => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined, closed = false, committed = false;
    const files = await f.open({ async validate(input) { signal = input.signal; entered.resolve(); await release.promise; return {mimeType:"image/png"}; } });
    const publishing = files.publish(fileSourceId,fileChunks(),() => { committed = true; });
    const publication = publishing.then(() => "published",() => "rejected");
    let cleaning: Promise<unknown> | undefined, closing: Promise<void> | undefined;
    try {
      await bounded(entered.promise,"held validator entry");
      const names = await readdir(join(f.directory,"staging")), staged = names[0];
      if (staged === undefined) throw new Error("Missing active staging fixture");
      const stage = join(f.directory,"staging",staged), old = new Date(f.now()-2000);
      await utimes(stage,old,old);
      // Validation is outside the short final-admission/cleanup gate. Complete a scan while it is held.
      cleaning = (async () => {
        for (let page = 0; page < 8; page++) {
          const result = await files.cleanup();
          expect(result.removed).toBe(0);
          if (!result.hasMore) return;
        }
        throw new Error("Active-staging cleanup did not finish its bounded walk");
      })();
      await bounded(cleaning,"cleanup during held validation");
      expect(await readBytes(stage)).toEqual(fileBytes);
      closing = files.close().then(() => { closed = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(closed).toBe(false); expect(signal?.aborted).toBe(true);
      await expect(files.publish(fileId(3),fileChunks(),f.save)).rejects.toThrow();
      release.resolve();
      expect(await bounded(publication,"cancelled validation publication")).toBe("rejected");
      await bounded(closing,"joined media close"); await bounded(cleaning,"joined cleanup");
      expect(closed).toBe(true); expect(committed).toBe(false);
      expect(await readdir(join(f.directory,"objects"))).toEqual([]);
      expect(await readdir(join(f.directory,"staging"))).toEqual([]);
      expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
      await expect(files.readOriginal(fileSourceId)).rejects.toThrow();
    } finally { release.resolve(); await Promise.allSettled([publishing,...(cleaning ? [cleaning] : []),...(closing ? [closing] : [])]); }
  }));

  test("lifetime loss during validation fences late publication and admission", async () => mediaFileFixture(async f => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let committed = false;
    const files = await f.open({ async validate() { entered.resolve(); await release.promise; return {mimeType:"image/png"}; } });
    const publishing = files.publish(fileSourceId,fileChunks(),() => { committed = true; });
    const result = publishing.then(() => "published",() => "rejected");
    try {
      await bounded(entered.promise,"lifetime validation entry"); f.expire(); release.resolve();
      expect(await bounded(result,"fenced publication")).toBe("rejected");
      expect(committed).toBe(false);
      expect(f.db.query("SELECT * FROM media_sources").all()).toEqual([]);
      expect(await readdir(join(f.directory,"objects"))).toEqual([]);
      await expect(files.cleanup()).rejects.toThrow();
    } finally { release.resolve(); await Promise.allSettled([publishing]); }
  }));
});
