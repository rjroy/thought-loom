import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureBackup, type CaptureResult } from "../src/backup/capture";
import { backupTableShapes } from "../src/backup/schema";
import { recoverRestoreStage, restoreBackup, stageRestoreSnapshot } from "../src/backup/restore-staging";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { partitionMarkdown, prepareMarkdown } from "../src/domain/markdown-import";
import { createLogger } from "../src/logging";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { assertRestoreFenceSchema } from "../src/storage/restore-fences-schema";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteStore } from "../src/storage/sqlite";
import { insertMediaSource, mediaBytes, mediaThought } from "./fixtures/media-source";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const logger = createLogger("verbose", () => {}), restoredAt = "2031-02-03T04:05:06.000Z";
const thought = "\uFEFFownedrestoretargettoken\r\nprivate-owned-text";

interface Fixture { readonly dir: string; readonly source: string; readonly snapshot: CaptureResult; readonly runId: string }
async function fixture(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/restore-target-"), source = join(dir, "source.sqlite"), output = join(dir, "capture");
  let daemon: RunningDaemon | undefined;
  try {
    await mkdir(output, { mode: 0o700 });
    daemon = await startDaemon({ dbPath: source, port: 0, credentials }, () => {}, { logSink: () => {} });
    await daemon.stop(); daemon = undefined;
    const db = new Database(source); let runId: string;
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON");
      const store = new SqliteStore(db), now = () => "2030-01-02T03:04:05.000Z";
      let sequence = 0; const id = () => `owned-target-${++sequence}`, sources = { id, now, logger };
      store.saveThought({ id: "root", text: thought, title: null, author: "user", kind: "captured-original",
        createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
      runId = new SqliteRunOperations(db, sources).admitWeave("user", { subjectId: "root", triggerId: "capture:root" }).id;
      db.run("UPDATE runs SET rowid=101 WHERE id=?", [runId]);
      await writeFile(join(`${source}.media`, "objects", mediaThought.mediaSource.id), mediaBytes, { mode: 0o600 });
      insertMediaSource(db);
      const markdown = new TextEncoder().encode("\uFEFFowned markdown\r\n\r\nsecond paragraph\r\n");
      const imports = new SqliteMarkdownImports(db, sources), batch = imports.createBatch("user", "target-batch");
      const file = imports.admitFile("user", batch.id, "target-file", "owned.md", markdown), claim = imports.claim(file.id);
      const prepared = prepareMarkdown(markdown); imports.prepare(claim, prepared.manifest);
      const input = imports.privateInput(claim);
      if (input.input === null) throw new Error("Missing owned import input");
      const partition = partitionMarkdown(markdown, prepared, prepared.fallbackCuts, { method: "structural", reason: "ai-unconfigured" });
      imports.finalize(imports.choose(claim, partition, { state: "not-submitted", promptId: input.promptId,
        inputSha256: createHash("sha256").update(input.input).digest("hex") }));
      db.exec("UPDATE sqlite_sequence SET seq=42 WHERE name='import_documents'");
    } finally { db.close(); }
    const snapshot = await captureBackup({ databasePath: source, mediaDirectory: `${source}.media`, outputDirectory: output, logger });
    await action({ dir, source, snapshot, runId });
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}

function tables(path: string) {
  const db = new Database(path, { readonly: true, create: false, safeIntegers: true });
  try {
    const rows = backupTableShapes.map(shape => ({ name: shape.name,
      rows: db.query(`SELECT ${shape.preserveRowid ? "rowid AS preserved_rowid," : ""}* FROM "${shape.name}" ORDER BY ${shape.preserveRowid ? "rowid" : shape.primaryKey.map(key => `"${key}"`).join(",")}`).all() }));
    return { rows, sequences: db.query("SELECT name,seq FROM sqlite_sequence ORDER BY name").all() };
  } finally { db.close(); }
}

function code(error: unknown): unknown { return error && typeof error === "object" && "code" in error ? error.code : null; }
async function failure(promise: Promise<unknown>): Promise<unknown> { return promise.then(() => null, (error: unknown) => error); }

// The child uses the real sidecar lock while the synchronous diagnostic sink holds the restore at its boundary.
function competingOwner(path: string): number | null {
  const modulePath = new URL("../src/storage/execution-owner.ts", import.meta.url).pathname;
  const script = `import {ExecutionOwnerLease,ExecutionOwnerHeldError} from ${JSON.stringify(modulePath)};
    try { const lease=await ExecutionOwnerLease.acquire(process.argv.at(-1),{verbose(){},info(){},warning(){},error(){}}); lease.release(); process.exitCode=0; }
    catch (error) { process.exitCode=error instanceof ExecutionOwnerHeldError ? 42 : 43; }`;
  const child = Bun.spawnSync({ cmd: [process.execPath, "--no-env-file", "-e", script, path], env: {}, timeout: 5000,
    stdout: "pipe", stderr: "pipe" });
  return child.exitCode;
}

test("final restore installs the exact recovered snapshot on one exclusively owned inode", async () => fixture(async f => {
  const referenceParent = join(f.dir, "reference"), target = join(f.dir, "target"), dbPath = join(target, "thoughtloom.sqlite");
  await mkdir(referenceParent, { mode: 0o700 }); await mkdir(target, { mode: 0o700 });
  const reference = await stageRestoreSnapshot({ snapshotDirectory: f.snapshot.snapshotDirectory, stagingParentDirectory: referenceParent, logger });
  let expected: ReturnType<typeof tables>;
  try { await recoverRestoreStage(reference, { restoredAt, logger }); expected = tables(reference.databasePath); }
  finally { await reference.dispose(); }
  const sourceBefore = tables(f.source), manifest = await readFile(join(f.snapshot.snapshotDirectory, "manifest.json"));
  const boundaries: { message: string; inode: bigint; marker: boolean; competing?: number | null; schemaObjects?: number }[] = [];
  const boundaryLogger = createLogger("verbose", record => {
    if (["[restore] target ownership acquired", "[restore] target marker durable", "[restore] target database committed", "[restore] target validated"].includes(record.message)) {
      let schemaObjects: number | undefined;
      if (record.message === "[restore] target marker durable") {
        if (lstatSync(dbPath).size === 0) schemaObjects = 0;
        else {
          const db = new Database(dbPath, { readonly: true, create: false });
          try { schemaObjects = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_schema").get()?.n; }
          finally { db.close(); }
        }
      }
      boundaries.push({ message: record.message, inode: lstatSync(dbPath, { bigint: true }).ino,
        marker: existsSync(join(target, ".restore-in-progress")),
        ...(record.message === "[restore] target marker durable" || record.message === "[restore] target validated"
          ? { competing: competingOwner(dbPath), schemaObjects } : {}) });
    }
  });
  const result = await restoreBackup({ snapshotDirectory: f.snapshot.snapshotDirectory, targetDirectory: target, restoredAt,
    expectedManifestSha256: f.snapshot.manifestSha256, logger: boundaryLogger });
  expect(result).toEqual({ targetDirectory: target, databasePath: dbPath, mediaDirectory: `${dbPath}.media`,
    manifestSha256: f.snapshot.manifestSha256, restoredAt });
  expect(boundaries.map(item => item.message)).toEqual(["[restore] target ownership acquired", "[restore] target marker durable",
    "[restore] target database committed", "[restore] target validated"]);
  const first = boundaries[0]; if (!first) throw new Error("Missing ownership boundary");
  expect(first.marker).toBe(false);
  for (const item of boundaries.slice(1)) { expect(item.marker).toBe(true); expect(item.inode).toBe(first.inode); }
  expect(boundaries[1]?.competing).toBe(42);
  expect(boundaries[1]?.schemaObjects).toBe(0);
  expect(boundaries[3]?.competing).toBe(42);
  expect((await lstat(dbPath, { bigint: true })).ino).toBe(first.inode);
  expect(existsSync(join(target, ".restore-in-progress"))).toBe(false);
  expect(tables(dbPath)).toEqual(expected); expect(tables(f.source)).toEqual(sourceBefore);
  expect(Array.from(await readFile(join(f.snapshot.snapshotDirectory, "manifest.json")))).toEqual(Array.from(manifest));
  expect(Array.from(await readFile(join(`${dbPath}.media`, "objects", mediaThought.mediaSource.id)))).toEqual(Array.from(mediaBytes));
  expect(await readdir(join(`${dbPath}.media`, "staging"))).toEqual([]);
  expect(await readdir(join(`${dbPath}.media`, "prepared"))).toEqual([]);
  const db = new Database(dbPath, { readonly: true, create: false, safeIntegers: true });
  try {
    expect(db.query("SELECT text FROM thoughts WHERE id='root'").get()).toEqual({ text: thought });
    expect(db.query("SELECT thought_id FROM thought_search_fts WHERE thought_search_fts MATCH 'ownedrestoretargettoken'").all()).toEqual([{ thought_id: "root" }]);
    expect(db.query("SELECT rowid,status,generation FROM runs WHERE id=?").get(f.runId)).toEqual({ rowid: 101n, status: "interrupted", generation: 1n });
    expect(db.query("SELECT entity_id FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(f.runId)).toEqual({ entity_id: f.runId });
    expect(() => assertRestoreFenceSchema(db)).not.toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { db.close(); }
  const lease = await ExecutionOwnerLease.acquire(dbPath, logger); lease.release();
  const absentTarget = join(f.dir, "previously-absent");
  const second = await restoreBackup({ snapshotDirectory: f.snapshot.snapshotDirectory, targetDirectory: absentTarget, restoredAt, logger });
  expect(second.databasePath).toBe(join(absentTarget, "thoughtloom.sqlite"));
  expect(tables(second.databasePath)).toEqual(expected);
  expect(existsSync(join(absentTarget, ".restore-in-progress"))).toBe(false);
}), 45000);

test("nonempty, symlink, invalid snapshot and pre-aborted targets are left untouched", async () => fixture(async f => {
  const sentinel = join(f.dir, "parent-owned"); await writeFile(sentinel, "keep", { mode: 0o600 });
  const occupied = join(f.dir, "occupied"); await mkdir(occupied, { mode: 0o700 });
  await writeFile(join(occupied, "existing"), "unchanged", { mode: 0o600 });
  let error = await failure(restoreBackup({ snapshotDirectory: f.snapshot.snapshotDirectory, targetDirectory: occupied, restoredAt, logger }));
  expect(code(error)).toBe("target-not-empty"); expect(await readdir(occupied)).toEqual(["existing"]);
  expect(await readFile(join(occupied, "existing"), "utf8")).toBe("unchanged");
  const actual = join(f.dir, "actual"), link = join(f.dir, "link"); await mkdir(actual, { mode: 0o700 }); await symlink(actual, link);
  error = await failure(restoreBackup({ snapshotDirectory: f.snapshot.snapshotDirectory, targetDirectory: link, restoredAt, logger }));
  expect(code(error)).toBe("unsafe-path"); expect((await lstat(link)).isSymbolicLink()).toBe(true); expect(await readdir(actual)).toEqual([]);
  const badSnapshot = join(f.dir, "bad-snapshot"), target = join(f.dir, "empty");
  await cp(f.snapshot.snapshotDirectory, badSnapshot, { recursive: true, errorOnExist: true });
  await writeFile(join(badSnapshot, "manifest.json"), "invalid owned manifest\n"); await mkdir(target, { mode: 0o700 });
  error = await failure(restoreBackup({ snapshotDirectory: badSnapshot, targetDirectory: target, restoredAt, logger }));
  expect(code(error)).toBe("invalid-snapshot"); expect(await readdir(target)).toEqual([]);
  const controller = new AbortController(); controller.abort();
  error = await failure(restoreBackup({ snapshotDirectory: f.snapshot.snapshotDirectory, targetDirectory: target, restoredAt, signal: controller.signal, logger }));
  expect(code(error)).toBe("aborted"); expect(await readdir(target)).toEqual([]);
  expect(await readFile(sentinel, "utf8")).toBe("keep");
}), 45000);

test("an actual held target lease prevents installation without overwriting the placeholder", async () => fixture(async f => {
  const target = join(f.dir, "busy"), path = join(target, "thoughtloom.sqlite"); await mkdir(target, { mode: 0o700 });
  const held = await ExecutionOwnerLease.acquire(path, logger);
  try {
    const before = await lstat(path, { bigint: true }), entries = (await readdir(target)).sort();
    const error = await failure(restoreBackup({ snapshotDirectory: f.snapshot.snapshotDirectory, targetDirectory: target, restoredAt, logger }));
    expect(code(error)).toBe("target-busy"); expect(competingOwner(path)).toBe(42);
    expect((await lstat(path, { bigint: true })).ino).toBe(before.ino);
    expect((await lstat(path, { bigint: true })).size).toBe(0n); expect((await readdir(target)).sort()).toEqual(entries);
    expect(existsSync(join(target, ".restore-in-progress"))).toBe(false); held.assertHeld();
  } finally { held.release(); }
}), 45000);

for (const phase of ["[restore] target marker durable", "[restore] target database committed"] as const) {
  test(`abort at ${phase} retains the marker, releases ownership and blocks daemon startup`, async () => fixture(async f => {
    const target = join(f.dir, "interrupted"), path = join(target, "thoughtloom.sqlite"), controller = new AbortController();
    await mkdir(target, { mode: 0o700 }); const sourceBefore = tables(f.source);
    let reached = false, inode: bigint | undefined;
    const phaseLogger = createLogger("verbose", record => {
      if (record.message === phase) { reached = true; inode = lstatSync(path, { bigint: true }).ino; controller.abort(); }
    });
    const error = await failure(restoreBackup({ snapshotDirectory: f.snapshot.snapshotDirectory, targetDirectory: target, restoredAt,
      signal: controller.signal, logger: phaseLogger }));
    expect(code(error)).toBe("aborted"); expect(reached).toBe(true);
    if (inode === undefined) throw new Error("Missing target inode at the restore boundary");
    expect((await lstat(path, { bigint: true })).ino).toBe(inode);
    expect((await lstat(join(target, ".restore-in-progress"))).isFile()).toBe(true); expect(tables(f.source)).toEqual(sourceBefore);
    const lease = await ExecutionOwnerLease.acquire(path, logger); lease.release();
    let daemon: RunningDaemon | undefined, nativeCalls = 0;
    try {
      const startupError = await failure(startDaemon({ dbPath: path, port: 0, credentials }, () => {}, {
        logSink: () => {}, async resolveAgentService() { nativeCalls++; throw new Error("unexpected native resolver"); },
        createPublicClient() { nativeCalls++; throw new Error("unexpected native client"); },
      }).then(value => { daemon = value; }));
      expect(startupError).toBeInstanceOf(Error); expect(nativeCalls).toBe(0);
      expect((await lstat(join(target, ".restore-in-progress"))).isFile()).toBe(true);
    } finally { await daemon?.stop(); }
  }), 45000);
}
