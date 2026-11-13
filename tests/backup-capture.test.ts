import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { captureBackup, type CaptureOptions } from "../src/backup/capture";
import { validateSourceSchema } from "../src/backup/schema";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { migrate } from "../src/storage/sqlite";
import { createLogger, type LogRecord } from "../src/logging";
import { insertMediaSource, mediaBytes, mediaDigest, mediaThought } from "./fixtures/media-source";
import { bounded, receipt, upload } from "./fixtures/media-import-api";
import { independentPng } from "./fixtures/media-rasters";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Cell = string | null | { readonly $integer: string } | { readonly $blob: string };
interface TableFile { readonly columns: string[]; readonly rows: { readonly rowid: null | { readonly $integer: string }; readonly values: Cell[] }[] }
interface Manifest {
  readonly format: string; readonly version: number; readonly appSchema: string; readonly mediaStoreId: string | null;
  readonly tables: { readonly name: string; readonly path: string; readonly rowCount: string; readonly byteLength: string; readonly sha256: string }[];
  readonly originals: { readonly sourceId: string; readonly path: string; readonly byteLength: string; readonly sha256: string }[];
  readonly mediaMarker: { readonly path: string; readonly byteLength: string; readonly sha256: string } | null;
}
interface Fixture { readonly dir: string; readonly dbPath: string; readonly media: string; readonly output: string; readonly daemon: RunningDaemon; readonly options: CaptureOptions }

async function owned(action: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join("/tmp/opencode", "backup-capture-"));
  const dbPath = join(dir, "knowledge.sqlite"), media = `${dbPath}.media`, output = join(dir, "output");
  let daemon: RunningDaemon | undefined;
  try {
    await mkdir(output, { mode: 0o700 });
    daemon = await startDaemon({ dbPath, port: 0, credentials }, () => {}, { logSink: () => {} });
    await action({ dir, dbPath, media, output, daemon, options: { databasePath: dbPath, mediaDirectory: media, outputDirectory: output } });
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}

async function files(root: string): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.set(relative(root, path), new Uint8Array(await readFile(path)));
      else throw new Error("Snapshot contains a non-regular entry");
    }
  }
  await walk(root);
  return found;
}

function parse<T>(bytes: Uint8Array | undefined): T {
  if (!bytes) throw new Error("Missing snapshot file");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
}
function records(table: TableFile): Record<string, Cell>[] {
  return table.rows.map(row => Object.fromEntries(table.columns.map((column, i) => [column, row.values[i]])));
}
function table(tree: Map<string, Uint8Array>, name: string): TableFile { return parse<TableFile>(tree.get(`tables/${name}.json`)); }

async function seed(f: Fixture): Promise<string> {
  const db = new Database(f.dbPath);
  try {
    const store = db.query<{ store_id: string }, []>("SELECT store_id FROM media_store").get();
    if (!store) throw new Error("Daemon did not initialize its media store");
    await writeFile(join(f.media, "objects", mediaThought.mediaSource.id), mediaBytes, { mode: 0o600 });
    insertMediaSource(db);
    db.exec(`BEGIN;
      INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id) VALUES
        ('root','retained root','user','captured-original','2030','capture',NULL),
        ('child','retained child','ai','ai-interpretation','2031','weave','root');
      INSERT INTO thought_titles VALUES ('root',NULL,NULL),('child',NULL,NULL);
      INSERT INTO thought_sources VALUES ('child',0,'root');
      INSERT INTO thought_source_seals VALUES ('root'),('child');
      INSERT INTO rejected_thoughts VALUES ('root');
      INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation,weave_subject_id,weave_trigger_id)
        VALUES ('run','weave','completed','session','prompt','2030',3,'root','capture:root');
      INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES ('run','thought','root',1);
      COMMIT;`);
    return store.store_id;
  } finally { db.close(); }
}

test("online capture publishes deterministic complete canonical history and exact originals", async () => owned(async f => {
  const storeId = await seed(f);
  await writeFile(join(f.media, "staging", "ignored.partial"), "scratch", { mode: 0o600 });
  const first = await captureBackup(f.options);
  const one = await files(first.snapshotDirectory);
  const manifestBytes = one.get("manifest.json");
  const manifest = parse<Manifest>(manifestBytes);
  if (!manifestBytes) throw new Error("Missing manifest");
  expect(first.manifestSha256).toBe(sha256(manifestBytes));
  expect(manifest).toMatchObject({ format: "thoughtloom-backup", version: 1, appSchema: "thoughtloom-logical-6", mediaStoreId: storeId });
  const source = new Database(f.dbPath, { readonly: true, create: false, safeIntegers: true });
  try { expect(manifest.tables.map(entry => entry.name)).toEqual(validateSourceSchema(source).map(shape => shape.name)); }
  finally { source.close(); }
  for (const entry of manifest.tables) {
    const bytes = one.get(entry.path);
    if (!bytes) throw new Error(`Missing table ${entry.name}`);
    expect(entry.byteLength).toBe(String(bytes.byteLength));
    expect(entry.sha256).toBe(sha256(bytes));
    expect(entry.rowCount).toBe(String(parse<TableFile>(bytes).rows.length));
  }
  expect(records(table(one, "thoughts"))).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "root", text: "retained root" }), expect.objectContaining({ id: "child", parent_id: "root" }),
  ]));
  expect(records(table(one, "rejected_thoughts"))).toContainEqual({ thought_id: "root" });
  expect(records(table(one, "thought_sources"))).toContainEqual({ thought_id: "child", source_id: "root", position: { $integer: "0" } });
  expect(records(table(one, "runs"))).toEqual(expect.arrayContaining([expect.objectContaining({ id: "run", status: "completed", generation: { $integer: "3" } })]));
  expect(table(one, "runs").rows.some(row => row.rowid !== null)).toBe(true);
  expect(records(table(one, "run_context"))).toEqual(expect.arrayContaining([expect.objectContaining({ run_id: "run", ref_id: "root" })]));
  expect(records(table(one, "media_sources"))).toEqual(expect.arrayContaining([expect.objectContaining({ id: mediaThought.mediaSource.id, sha256: { $blob: Buffer.from(mediaDigest).toString("base64") } })]));
  const objectPath = `media/objects/${mediaThought.mediaSource.id}`;
  expect(one.get(objectPath)).toEqual(mediaBytes);
  expect(manifest.originals).toEqual([{ sourceId: mediaThought.mediaSource.id, path: objectPath, byteLength: String(mediaBytes.length), sha256: sha256(mediaBytes) }]);
  expect(one.get("media/store.json")).toEqual(new TextEncoder().encode(`${JSON.stringify({ version: 1, storeId })}\n`));
  expect([...one.keys()].sort()).toEqual(["manifest.json", "media/store.json", objectPath, ...manifest.tables.map(entry => entry.path)].sort());
  const second = await captureBackup(f.options);
  expect(second.manifestSha256).toBe(first.manifestSha256);
  expect(await files(second.snapshotDirectory)).toEqual(one);
}), 20000);

test("failed and pre-aborted captures leave the last good snapshot and unrelated output untouched", async () => owned(async f => {
  await seed(f);
  const sentinel = join(f.output, "caller-owned.txt");
  await writeFile(sentinel, "keep", { mode: 0o600 });
  const good = await captureBackup(f.options), baseline = await files(good.snapshotDirectory);
  const before = (await readdir(f.output)).sort();
  const object = join(f.media, "objects", mediaThought.mediaSource.id), marker = join(f.media, "store.json");
  const markerBytes = await readFile(marker);
  const checkFailure = async () => {
    await expect(captureBackup(f.options)).rejects.toThrow();
    expect(await files(good.snapshotDirectory)).toEqual(baseline);
    expect((await readdir(f.output)).sort()).toEqual(before);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  };
  await unlink(object); await checkFailure();
  await writeFile(object, new Uint8Array(mediaBytes.length).fill(7), { mode: 0o600 }); await checkFailure();
  await writeFile(object, mediaBytes); await writeFile(marker, JSON.stringify({ version: 1, storeId: "00000000-0000-4000-8000-000000000099" }));
  await checkFailure(); await writeFile(marker, markerBytes);
  const controller = new AbortController(); controller.abort();
  await expect(captureBackup({ ...f.options, signal: controller.signal })).rejects.toThrow();
  expect(await files(good.snapshotDirectory)).toEqual(baseline);
  expect((await readdir(f.output)).sort()).toEqual(before);
}), 20000);

test("rollback-mode, restore-in-progress and unsupported schemas are refused without changing source or output", async () => owned(async f => {
  const rollbackPath = join(f.dir, "rollback.sqlite"), rollback = new Database(rollbackPath);
  try { migrate(rollback); } finally { rollback.close(); }
  await writeFile(join(f.output, "caller-owned.txt"), "keep", { mode: 0o600 });
  const originalOutput = (await readdir(f.output)).sort();
  await expect(captureBackup({ ...f.options, databasePath: rollbackPath })).rejects.toThrow();
  const checkRollback = new Database(rollbackPath, { readonly: true, create: false });
  try { expect(checkRollback.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" }); }
  finally { checkRollback.close(); }
  const marker = join(f.dir, ".restore-in-progress");
  await writeFile(marker, "owned incomplete restore", { mode: 0o600 });
  await expect(captureBackup(f.options)).rejects.toThrow();
  expect(await readFile(marker, "utf8")).toBe("owned incomplete restore");
  await unlink(marker);
  const writer = new Database(f.dbPath);
  try {
    writer.exec("CREATE TABLE future_history (id TEXT PRIMARY KEY, fact TEXT); INSERT INTO future_history VALUES ('preserve','value')");
    await expect(captureBackup(f.options)).rejects.toThrow();
    expect(writer.query("SELECT * FROM future_history").all()).toEqual([{ id: "preserve", fact: "value" }]);
  } finally { writer.close(); }
  expect((await readdir(f.output)).sort()).toEqual(originalOutput);
}), 20000);

test("a real WAL writer commits transactional thought groups during capture without torn snapshot membership", async () => owned(async f => {
  const db = new Database(f.dbPath);
  db.exec(`BEGIN IMMEDIATE;
    INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id) VALUES ('concurrent-seed','seed','user','captured-original','2030','test',NULL);
    INSERT INTO thought_titles VALUES ('concurrent-seed',NULL,NULL);
    INSERT INTO thought_source_seals VALUES ('concurrent-seed'); COMMIT;`);
  let finished = false, writes = 0;
  const capturing = captureBackup(f.options);
  void capturing.then(() => { finished = true; }, () => { finished = true; });
  try {
    await Promise.resolve();
    expect(finished).toBe(false);
    while (!finished && writes < 2000) {
      const id = `concurrent-${String(writes).padStart(4, "0")}`;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id) VALUES (?,?,'user','captured-original','2030','test',NULL)", [id, id]);
        db.run("INSERT INTO thought_titles(thought_id,title,title_author) VALUES (?,NULL,NULL)", [id]);
        db.run("INSERT INTO thought_source_seals(thought_id) VALUES (?)", [id]);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      writes++;
      await Bun.sleep(1);
    }
    expect(writes).toBeGreaterThan(0);
    const result = await capturing;
    const tree = await files(result.snapshotDirectory);
    const selected = (name: string, column: string) => records(table(tree, name))
      .map(row => row[column]).filter((value): value is string => typeof value === "string" && value.startsWith("concurrent-")).sort();
    const thoughts = selected("thoughts", "id");
    expect(thoughts).toContain("concurrent-seed");
    expect(selected("thought_titles", "thought_id")).toEqual(thoughts);
    expect(selected("thought_source_seals", "thought_id")).toEqual(thoughts);
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM thoughts WHERE id LIKE 'concurrent-%'").get()?.count).toBe(writes + 1);
  } finally {
    db.close();
    await Promise.allSettled([capturing]);
  }
}), 20000);

test("the established read transaction pins pre-commit knowledge and excludes later retained media", async () => owned(async f => {
  await seed(f);
  const writer = new Database(f.dbPath), ready = Promise.withResolvers<number>(), logs: LogRecord[] = [];
  let stopped: number | undefined;
  const logger = createLogger("verbose", record => {
    logs.push(record);
    if (record.message !== "[backup] source snapshot established") return;
    const pid = record.context?.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Missing owned capture child PID");
    writer.exec(`BEGIN IMMEDIATE;
      UPDATE thought_titles SET title='after snapshot',title_author='user' WHERE thought_id='child';
      INSERT INTO rejected_thoughts VALUES ('child');
      INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id)
        VALUES ('later','later private thought','user','captured-original','2032','capture',NULL);
      INSERT INTO thought_titles VALUES ('later',NULL,NULL);
      INSERT INTO thought_source_seals VALUES ('later'); COMMIT;`);
    process.kill(pid, "SIGSTOP"); stopped = pid; ready.resolve(pid);
  });
  const capturing = captureBackup({ ...f.options, logger, limits: { sourceReadMs: 15000, totalMs: 25000 } });
  void capturing.catch(() => {});
  try {
    await bounded(ready.promise, "capture snapshot boundary", 10000);
    const request = upload(independentPng(), "capture-later-media"), headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${credentials.user}`);
    const admitted = await receipt(await fetch(new URL("/imports/media", f.daemon.url), { ...request, headers, signal: AbortSignal.timeout(10000) }));
    const laterId = admitted.thought.mediaSource.id;
    expect(Array.from(await readFile(join(f.media, "objects", laterId)))).toEqual(Array.from(independentPng()));
    if (stopped === undefined) throw new Error("Capture child was not held");
    process.kill(stopped, "SIGCONT"); stopped = undefined;
    const result = await bounded(capturing, "capture completion", 10000), tree = await files(result.snapshotDirectory);
    expect(records(table(tree, "thought_titles"))).toEqual(expect.arrayContaining([expect.objectContaining({ thought_id: "child", title: null, title_author: null })]));
    expect(records(table(tree, "rejected_thoughts"))).toEqual([{ thought_id: "root" }]);
    expect(records(table(tree, "thoughts")).some(row => row.id === "later")).toBe(false);
    expect(records(table(tree, "media_sources")).some(row => row.id === laterId)).toBe(false);
    expect(tree.has(`media/objects/${laterId}`)).toBe(false);
    expect(tree.get(`media/objects/${mediaThought.mediaSource.id}`)).toEqual(mediaBytes);
    expect(writer.query("SELECT title,title_author FROM thought_titles WHERE thought_id='child'").get()).toEqual({ title: "after snapshot", title_author: "user" });
    expect(writer.query("SELECT thought_id FROM rejected_thoughts WHERE thought_id='child'").get()).toEqual({ thought_id: "child" });
    expect(writer.query("SELECT id FROM thoughts WHERE id='later'").get()).toEqual({ id: "later" });
    expect(writer.query("SELECT id FROM media_sources WHERE id=?").get(laterId)).toEqual({ id: laterId });
    expect(JSON.stringify(logs)).not.toContain("later private thought");
    expect(JSON.stringify(logs)).not.toContain(credentials.user);
  } finally {
    if (stopped !== undefined) process.kill(stopped, "SIGKILL");
    await Promise.allSettled([capturing]); writer.close();
  }
}), 30000);

test("source timeout, total timeout and cancellation kill and join the held owned child", async () => owned(async f => {
  await writeFile(join(f.output, "caller-owned.txt"), "keep", { mode: 0o600 });
  const before = (await readdir(f.output)).sort();
  for (const scenario of ["source", "total", "abort"] as const) {
    const controller = new AbortController(), ready = Promise.withResolvers<number>(), logs: LogRecord[] = [];
    let pid: number | undefined, settled = false;
    const logger = createLogger("verbose", record => {
      logs.push(record);
      if (record.message !== "[backup] source snapshot established") return;
      const value = record.context?.pid;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Missing owned child PID");
      process.kill(value, "SIGSTOP"); pid = value; ready.resolve(value);
      if (scenario === "abort") controller.abort();
    });
    const limits = scenario === "source" ? { sourceReadMs: 3000, totalMs: 9000 } :
      scenario === "total" ? { sourceReadMs: 3000, totalMs: 3000 } : { sourceReadMs: 9000, totalMs: 12000 };
    const capturing = captureBackup({ ...f.options, logger, signal: controller.signal, limits });
    const outcome = capturing.then(() => null, (error: unknown) => error).finally(() => { settled = true; });
    try {
      const child = await bounded(ready.promise, `${scenario} snapshot boundary`, 7000);
      const error = await bounded(outcome, `${scenario} termination and join`, 7000);
      expect(error).toBeInstanceOf(Error);
      expect(error && typeof error === "object" && "code" in error ? error.code : null)
        .toBe(scenario === "source" ? "source-timeout" : scenario === "total" ? "capture-timeout" : "aborted");
      await expect(lstat(`/proc/${child}`)).rejects.toThrow();
      expect((await readdir(f.output)).sort()).toEqual(before);
      expect(await readFile(join(f.output, "caller-owned.txt"), "utf8")).toBe("keep");
      const db = new Database(f.dbPath, { readonly: true, create: false });
      try { expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" }); expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 }); }
      finally { db.close(); }
      expect(JSON.stringify(logs)).not.toContain(credentials.user);
    } finally {
      if (!settled && pid !== undefined) process.kill(pid, "SIGKILL");
      await outcome;
    }
  }
}), 30000);

test("the sampled RSS watchdog refuses an undersized owned capture without publication", async () => owned(async f => {
  await writeFile(join(f.output, "caller-owned.txt"), "keep", { mode: 0o600 });
  const before = (await readdir(f.output)).sort();
  const outcome = await bounded(captureBackup({ ...f.options, logger: createLogger("verbose", () => {}), limits: { maxRssBytes: 1 } })
    .then(() => null, (error: unknown) => error), "RSS watchdog", 10000);
  expect(outcome).toBeInstanceOf(Error);
  expect(outcome && typeof outcome === "object" && "code" in outcome ? outcome.code : null).toBe("memory-limit");
  expect((await readdir(f.output)).sort()).toEqual(before);
  expect(await readFile(join(f.output, "caller-owned.txt"), "utf8")).toBe("keep");
}), 15000);

test("concurrent identical captures reuse only a verified destination and never replace a conflicting tree", async () => owned(async f => {
  await seed(f);
  const first = await captureBackup(f.options), lastGood = await files(first.snapshotDirectory);
  const db = new Database(f.dbPath);
  try { db.run("UPDATE thought_titles SET title='new source state',title_author='user' WHERE thought_id='child'"); }
  finally { db.close(); }
  const [a, b] = await Promise.all([captureBackup(f.options), captureBackup(f.options)]);
  expect(a).toEqual(b);
  expect(a.manifestSha256).not.toBe(first.manifestSha256);
  const target = a.snapshotDirectory, original = await files(target), before = (await readdir(f.output)).sort();
  const manifest = join(target, "manifest.json"), bytes = await readFile(manifest), extra = join(target, "unexpected.txt");
  const failWithoutReplacement = async () => {
    const error = await captureBackup(f.options).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((await readdir(f.output)).sort()).toEqual(before);
    expect(await files(first.snapshotDirectory)).toEqual(lastGood);
  };
  await writeFile(manifest, "corrupted manifest");
  await failWithoutReplacement(); expect(await readFile(manifest, "utf8")).toBe("corrupted manifest");
  await writeFile(manifest, bytes);
  await writeFile(extra, "owned unexpected file", { mode: 0o600 });
  await failWithoutReplacement(); expect(await readFile(extra, "utf8")).toBe("owned unexpected file");
  await unlink(extra);
  const displaced = join(f.dir, "displaced-manifest");
  await rename(manifest, displaced); await symlink(displaced, manifest);
  await failWithoutReplacement(); expect((await lstat(manifest)).isSymbolicLink()).toBe(true);
  await unlink(manifest); await rename(displaced, manifest);
  expect(await files(target)).toEqual(original);
  expect(await captureBackup(f.options)).toEqual(a);
}), 30000);

test("inconsistent source relationships and missing seals fail after snapshot establishment without changing the source", async () => {
  for (const scenario of ["missing-seal", "missing-reference"] as const) await owned(async f => {
    await seed(f);
    const good = await captureBackup(f.options), baseline = await files(good.snapshotDirectory);
    const before = (await readdir(f.output)).sort(), writer = new Database(f.dbPath);
    try {
      if (scenario === "missing-seal") writer.exec(`BEGIN;
        INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id) VALUES ('broken','private broken text','user','captured-original','2030','test',NULL);
        INSERT INTO thought_titles VALUES ('broken',NULL,NULL); COMMIT;`);
      else writer.run("INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES ('run','thought','missing-reference',0)");
      const logs: LogRecord[] = [];
      const error = await captureBackup({ ...f.options, logger: createLogger("verbose", record => logs.push(record)) })
        .then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error && typeof error === "object" && "code" in error ? error.code : null).toBe("inconsistent-source");
      expect(logs.some(record => record.message === "[backup] source snapshot established")).toBe(true);
      expect(JSON.stringify(logs)).not.toContain("private broken text");
      if (scenario === "missing-seal") {
        expect(writer.query("SELECT text FROM thoughts WHERE id='broken'").get()).toEqual({ text: "private broken text" });
        expect(writer.query("SELECT * FROM thought_source_seals WHERE thought_id='broken'").get()).toBeNull();
      } else expect(writer.query("SELECT ref_id FROM run_context WHERE ref_id='missing-reference'").get()).toEqual({ ref_id: "missing-reference" });
      expect((await readdir(f.output)).sort()).toEqual(before);
      expect(await files(good.snapshotDirectory)).toEqual(baseline);
    } finally { writer.close(); }
  });
}, 30000);
