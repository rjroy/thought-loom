import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, readlink, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, type LogRecord } from "../../src/logging";
import { openMediaFiles, type MediaFileArtifact, type MediaFiles, type MediaFilesOptions } from "../../src/storage/media-files";
import { migrate, SqliteStore } from "../../src/storage/sqlite";
import { mediaThought, mediaTime } from "./media-source";
import type { MediaFileOperations } from "../../src/storage/media-file-paths";

export type MediaFileFaultBoundary = "staged-file-sync" | "published-file-sync" |
  "objects-directory-sync" | "staging-directory-sync" | "link" | "staging-unlink";
type FaultTiming = "before" | "after";
interface FileFault {
  readonly boundary: MediaFileFaultBoundary;
  readonly timing: FaultTiming;
  readonly mode: "fail" | "hold";
  readonly entered: ReturnType<typeof Promise.withResolvers<void>>;
  readonly released: ReturnType<typeof Promise.withResolvers<void>>;
}
/** Instance-local wrappers delegate to the real owned filesystem, never patch node:fs globally. */
export function mediaFileFaults(): {
  readonly io: MediaFileOperations;
  readonly hits: number;
  fail(boundary: MediaFileFaultBoundary, timing?: FaultTiming): void;
  hold(boundary: MediaFileFaultBoundary, timing?: FaultTiming): { readonly entered: Promise<void>; release(): void };
} {
  let armed: FileFault | undefined, hits = 0;
  function arm(boundary: MediaFileFaultBoundary, timing: FaultTiming, mode: FileFault["mode"]): FileFault {
    if (armed) throw new Error("An owned file fault is already armed");
    const fault: FileFault = {boundary,timing,mode,entered:Promise.withResolvers<void>(),released:Promise.withResolvers<void>()};
    armed = fault; return fault;
  }
  async function perform(boundary: MediaFileFaultBoundary | undefined, action: () => Promise<void>): Promise<void> {
    const fault = armed?.boundary === boundary ? armed : undefined;
    if (!fault) return action();
    const selected = fault;
    armed = undefined; hits++;
    async function trigger(): Promise<void> {
      selected.entered.resolve();
      if (selected.mode === "fail") throw Object.assign(new Error("test-owned filesystem failure"),{code:"EIO"});
      await selected.released.promise;
    }
    if (fault.timing === "before") await trigger();
    await action();
    if (fault.timing === "after") await trigger();
  }
  const io: MediaFileOperations = {
    async sync(handle) {
      const target = await readlink(`/proc/self/fd/${handle.fd}`);
      let boundary: MediaFileFaultBoundary | undefined;
      if (target.endsWith("/objects")) boundary = "objects-directory-sync";
      else if (target.endsWith("/staging")) boundary = "staging-directory-sync";
      else if (target.endsWith(".partial (deleted)")) boundary = "published-file-sync";
      else if (target.endsWith(".partial")) boundary = "staged-file-sync";
      await perform(boundary,() => handle.sync());
    },
    async link(source,destination) { await perform("link",() => link(source,destination)); },
    async unlink(path) { await perform(path.endsWith(".partial") ? "staging-unlink" : undefined,() => unlink(path)); },
  };
  return {io,get hits() { return hits; },
    fail(boundary,timing = "before") { arm(boundary,timing,"fail"); },
    hold(boundary,timing = "after") {
      const fault = arm(boundary,timing,"hold");
      return {entered:fault.entered.promise,release:() => fault.released.resolve()};
    },
  };
}

export const fileId = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12,"0")}`;
export const fileSourceId = fileId(2), fileStoreId = fileId(1);
// Deliberately not a real image: this cycle tests file ownership, not parser acceptance.
export const fileBytes = new Uint8Array([0,255,239,187,191,13,10,...new TextEncoder().encode("private-original-sentinel")]);
export const fileDigest = new Uint8Array(createHash("sha256").update(fileBytes).digest());
export async function* fileChunks(bytes: Uint8Array = fileBytes): AsyncIterable<Uint8Array> {
  yield bytes.subarray(0,7);
  yield bytes.subarray(7);
}
export async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise,new Promise<never>((_,reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)),3000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
export interface MediaFileFixture {
  readonly dir: string;
  readonly directory: string;
  readonly db: Database;
  readonly store: SqliteStore;
  readonly logs: LogRecord[];
  readonly options: MediaFilesOptions;
  open(overrides?: Partial<MediaFilesOptions>): Promise<MediaFiles>;
  save(artifact: MediaFileArtifact): void;
  now(): number;
  advance(ms: number): void;
  expire(): void;
}

export async function mediaFileFixture(action: (fixture: MediaFileFixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join("/tmp/opencode","media-files-test-")), directory = join(dir,"media");
  const db = new Database(join(dir,"owned.sqlite")), opened: MediaFiles[] = [], logs: LogRecord[] = [];
  const logger = createLogger("verbose",record => logs.push(record));
  let serial = 100, clock = Date.parse(mediaTime), held = true;
  const store = new SqliteStore(db,undefined,logger);
  const options: MediaFilesOptions = { db,directory,storeId:fileStoreId,id:() => fileId(++serial),now:() => clock,
    assertHeld() { if (!held) throw new Error("test execution lease expired"); },logger,
    async validate(input) {
      expect(db.inTransaction).toBe(false);
      expect(input.signal.aborted).toBe(false);
      const bytes = await readFile(`/proc/self/fd/${input.fd}`);
      expect(bytes.byteLength).toBe(input.byteLength);
      return { mimeType:"image/png" };
    },
    limits:{maxBytes:64,orphanGraceMs:1000,cleanupBatchSize:1},
  };
  try {
    migrate(db,logger);
    await action({ dir,directory,db,store,logs,options,
      async open(overrides = {}) {
        const files = await openMediaFiles({...options,...overrides}); opened.push(files); return files;
      },
      save(artifact) {
        expect(db.inTransaction).toBe(false);
        store.saveMediaSource({ thought:{...mediaThought,id:`thought-${artifact.sourceId}`,
          mediaSource:{...mediaThought.mediaSource,id:artifact.sourceId,name:"display-only.png",mimeType:artifact.mimeType,byteLength:artifact.byteLength}},
        requestKey:`file-${artifact.sourceId}`,sha256:artifact.sha256 });
      },
      now:() => clock,advance(ms) { clock += ms; },expire() { held = false; },
    });
  } finally {
    try { for (const files of [...opened].reverse()) await bounded(files.close(),"media file fixture drain"); }
    finally { db.close(); await rm(dir,{recursive:true,force:true}); }
  }
}
