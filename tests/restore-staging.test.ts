import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { captureBackup, type CaptureResult } from "../src/backup/capture";
import { backupTableShapes } from "../src/backup/schema";
import { stageRestoreSnapshot } from "../src/backup/restore-staging";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { partitionMarkdown, prepareMarkdown } from "../src/domain/markdown-import";
import { createLogger } from "../src/logging";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteStore } from "../src/storage/sqlite";
import { insertMediaSource, mediaBytes, mediaThought } from "./fixtures/media-source";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const logger = createLogger("verbose", () => {}), timestamp = "2030-01-02T03:04:05.000Z";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
interface Fixture { readonly dir: string; readonly dbPath: string; readonly snapshot: CaptureResult; readonly stagingParent: string; readonly markdown: Uint8Array }

async function fixture(action: (f: Fixture) => Promise<void>, retired = false): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/restore-stage-"), dbPath = join(dir, "source.sqlite"), media = `${dbPath}.media`;
  const output = join(dir, "capture"), stagingParent = join(dir, "stage"), markdown = new TextEncoder().encode("\uFEFFowned Markdown\r\n\r\nsecond paragraph\r\n");
  let daemon: RunningDaemon | undefined;
  try {
    await mkdir(output, { mode: 0o700 }); await mkdir(stagingParent, { mode: 0o700 });
    daemon = await startDaemon({ dbPath, port: 0, credentials }, () => {}, { logSink: () => {} });
    await daemon.stop(); daemon = undefined;
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON");
      const store = new SqliteStore(db);
      store.saveThought({ id: "root", text: "\uFEFFownedsearchtoken\r\n{\"nested\": 1}", title: null, author: "user", kind: "captured-original",
        createdAt: timestamp, origin: "fixture", parentId: null, sourceIds: [] });
      store.saveThought({ id: "child", text: "owned child", title: null, author: "ai", kind: "ai-interpretation",
        createdAt: timestamp, origin: "weave", parentId: "root", sourceIds: ["root"] });
      db.exec(`UPDATE thought_titles SET title='later user title',title_author='user' WHERE thought_id='root';
        INSERT INTO rejected_thoughts VALUES ('child');
        INSERT INTO runs(rowid,id,kind,status,session_id,prompt_id,created_at,generation,weave_subject_id,weave_trigger_id)
          VALUES (101,'historical-run','weave','running','native-history','prompt-history','2030',7,'root','capture:root');
        INSERT INTO run_context(rowid,run_id,kind,ref_id,full_read) VALUES (77,'historical-run','thought','root',1);
        INSERT INTO restore_fences VALUES ('run','historical-run','${"a".repeat(64)}','2030','{}');`);
      if (retired) db.run("UPDATE runs SET status='interrupted',cancellation_state='pending',weave_retired_at=? WHERE id='historical-run'", [timestamp]);
      await writeFile(join(media, "objects", mediaThought.mediaSource.id), mediaBytes, { mode: 0o600 });
      insertMediaSource(db);
      let n = 0;
      const imports = new SqliteMarkdownImports(db, { id: () => `import-owned-${++n}`, now: () => timestamp, logger });
      const batch = imports.createBatch("user", "source-batch"), file = imports.admitFile("user", batch.id, "source-file", "owned.md", markdown);
      const claim = imports.claim(file.id), prepared = prepareMarkdown(markdown);
      imports.prepare(claim, prepared.manifest);
      const input = imports.privateInput(claim);
      if (input.input === null) throw new Error("Owned import input missing");
      const partition = partitionMarkdown(markdown, prepared, prepared.fallbackCuts, { method: "structural", reason: "ai-unconfigured" });
      imports.finalize(imports.choose(claim, partition, { state: "not-submitted", promptId: input.promptId,
        inputSha256: createHash("sha256").update(input.input).digest("hex") }));
      db.exec("UPDATE sqlite_sequence SET seq=42 WHERE name='import_documents'");
    } finally { db.close(); }
    const snapshot = await captureBackup({ databasePath: dbPath, mediaDirectory: media, outputDirectory: output, logger });
    await action({ dir, dbPath, snapshot, stagingParent, markdown });
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}

test("backup and restore retain an acknowledged retirement separately from native cancellation", async () => fixture(async f => {
  const stage = await stageRestoreSnapshot({ snapshotDirectory: f.snapshot.snapshotDirectory,
    stagingParentDirectory: f.stagingParent, expectedManifestSha256: f.snapshot.manifestSha256, logger });
  try {
    const restored = new Database(stage.databasePath, { readonly: true });
    try {
      expect(restored.query("SELECT status,cancellation_state,weave_retired_at FROM runs WHERE id='historical-run'").get())
        .toEqual({ status: "interrupted", cancellation_state: "pending", weave_retired_at: timestamp });
    } finally { restored.close(); }
  } finally { await stage.dispose(); }
}, true), 30000);

function rawTables(path: string) {
  const db = new Database(path, { readonly: true, create: false, safeIntegers: true });
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    return backupTableShapes.map(table => {
      const projection = table.columns.flatMap(column => [
        `typeof(${quote(column)}) AS ${quote(`${column}_storage`)}`,
        `CASE WHEN typeof(${quote(column)}) IN ('text','blob') THEN hex(CAST(${quote(column)} AS BLOB)) ELSE ${quote(column)} END AS ${quote(`${column}_value`)}`,
      ]);
      const order = table.preserveRowid ? "rowid" : table.primaryKey.map(quote).join(",");
      return { name: table.name, rows: db.query(`SELECT ${table.preserveRowid ? "rowid AS preserved_rowid," : ""}${projection.join(",")} FROM ${quote(table.name)} ORDER BY ${order}`).all() };
    });
  } finally { db.close(); }
}

test("staging genuine current-schema capture preserves typed tables, sequences, rowids, media and guards without recovery", async () => fixture(async f => {
  const before = rawTables(f.dbPath), stage = await stageRestoreSnapshot({ snapshotDirectory: f.snapshot.snapshotDirectory,
    stagingParentDirectory: f.stagingParent, expectedManifestSha256: f.snapshot.manifestSha256, logger });
  try {
    expect(stage.manifestSha256).toBe(f.snapshot.manifestSha256);
    expect(dirname(stage.stagingDirectory)).toBe(f.stagingParent);
    expect(basename(stage.stagingDirectory)).toMatch(/^\.restore-[0-9a-f-]{36}$/);
    expect(stage.databasePath).toBe(join(stage.stagingDirectory, "thoughtloom.sqlite"));
    expect(stage.mediaDirectory).toBe(join(stage.stagingDirectory, "thoughtloom.sqlite.media"));
    expect((await lstat(stage.stagingDirectory)).mode & 0o777).toBe(0o700);
    const marker = await lstat(join(stage.stagingDirectory, ".restore-in-progress"));
    expect(marker.isFile()).toBe(true); expect(marker.mode & 0o777).toBe(0o600);
    expect(rawTables(stage.databasePath)).toEqual(before);
    expect(Array.from(await readFile(join(stage.mediaDirectory, "objects", mediaThought.mediaSource.id)))).toEqual(Array.from(mediaBytes));
    expect(await readdir(join(stage.mediaDirectory, "staging"))).toEqual([]);
    expect(await readdir(join(stage.mediaDirectory, "prepared"))).toEqual([]);
    const source = new Database(f.dbPath, { readonly: true, safeIntegers: true }), restored = new Database(stage.databasePath, { safeIntegers: true });
    try {
      const sequences = "SELECT name,seq FROM sqlite_sequence WHERE name IN ('import_documents','markdown_imports','search_sessions') ORDER BY name";
      expect(restored.query(sequences).all()).toEqual(source.query(sequences).all());
      expect(restored.query("SELECT seq FROM sqlite_sequence WHERE name='import_documents'").get()).toEqual({ seq: 42n });
      expect(restored.query("SELECT status,generation FROM runs WHERE id='historical-run'").get()).toEqual({ status: "running", generation: 7n });
      expect(restored.query("SELECT entity_kind,entity_id FROM restore_fences").all()).toEqual([{ entity_kind: "run", entity_id: "historical-run" }]);
      const original = restored.query<{ original_bytes: Uint8Array }, []>("SELECT original_bytes FROM import_documents").get();
      expect(original && Array.from(original.original_bytes)).toEqual(Array.from(f.markdown));
      expect(restored.query("SELECT thought_id FROM thought_search_fts WHERE thought_search_fts MATCH 'ownedsearchtoken'").all()).toEqual([{ thought_id: "root" }]);
      expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(() => restored.run("UPDATE thoughts SET text='changed' WHERE id='root'")).toThrow();
      expect(() => restored.run("DELETE FROM restore_fences WHERE entity_id='historical-run'")).toThrow();
    } finally { source.close(); restored.close(); }
  } finally { await stage.dispose(); }
  await expect(lstat(stage.stagingDirectory)).rejects.toThrow();
  await stage.dispose();
}), 30000);

test("deep relationship and seal corruption with recomputed hashes fails without publishing a stage", async () => fixture(async f => {
  const parentSentinel = join(f.stagingParent, "caller-owned"); await writeFile(parentSentinel, "keep", { mode: 0o600 });
  const before = (await readdir(f.stagingParent)).sort(), originalManifest = await readFile(join(f.snapshot.snapshotDirectory, "manifest.json"));
  for (const scenario of ["missing-parent", "missing-seal"] as const) {
    const copy = join(f.dir, `corrupt-${scenario}`); await cp(f.snapshot.snapshotDirectory, copy, { recursive: true, errorOnExist: true });
    const name = scenario === "missing-parent" ? "thoughts" : "thought_source_seals", path = join(copy, "tables", `${name}.json`);
    const content = JSON.parse(await readFile(path, "utf8")) as { columns: string[]; rows: { rowid: unknown; values: (string | null | object)[] }[] };
    const id = content.columns.indexOf(scenario === "missing-parent" ? "id" : "thought_id");
    const row = content.rows.find(item => item.values[id] === "root");
    if (!row) throw new Error("Owned root row missing");
    if (scenario === "missing-parent") {
      const parent = content.columns.indexOf("parent_id"); if (parent < 0) throw new Error("Owned parent column missing");
      row.values[parent] = "missing-owned-parent";
    } else content.rows = content.rows.filter(item => item !== row);
    const bytes = new TextEncoder().encode(`${JSON.stringify(content)}\n`); await writeFile(path, bytes);
    const manifestPath = join(copy, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { tables: { name: string; byteLength: string; rowCount: string; sha256: string }[] };
    const entry = manifest.tables.find(table => table.name === name); if (!entry) throw new Error("Owned table manifest entry missing");
    entry.byteLength = String(bytes.length); entry.rowCount = String(content.rows.length); entry.sha256 = hash(bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const failure = await stageRestoreSnapshot({ snapshotDirectory: copy, stagingParentDirectory: f.stagingParent, logger })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure && typeof failure === "object" && "code" in failure ? failure.code : null).toBe("invalid-records");
    expect((await readdir(f.stagingParent)).sort()).toEqual(before);
    expect(await readFile(parentSentinel, "utf8")).toBe("keep");
    expect(await readFile(join(f.snapshot.snapshotDirectory, "manifest.json"))).toEqual(originalManifest);
  }
}), 30000);

for (const column of ["eligibility", "retrieval", "catalog"] as const) {
  test(`staging rejects a canonical int64 ${column} epoch outside the application safe-integer range`, async () => fixture(async f => {
    const sentinel = join(f.stagingParent, "caller-owned"); await writeFile(sentinel, "keep", { mode: 0o600 });
    const before = (await readdir(f.stagingParent)).sort();
    const sourceManifest = await readFile(join(f.snapshot.snapshotDirectory, "manifest.json"));
    const sourceTable = await readFile(join(f.snapshot.snapshotDirectory, "tables", "search_revisions.json"));
    const copy = join(f.dir, `oversized-${column}`); await cp(f.snapshot.snapshotDirectory, copy, { recursive: true, errorOnExist: true });
    const path = join(copy, "tables", "search_revisions.json");
    const content = JSON.parse(await readFile(path, "utf8")) as { columns: string[]; rows: { rowid: unknown; values: (string | null | object)[] }[] };
    const index = content.columns.indexOf(column);
    if (index < 0 || content.rows.length !== 1) throw new Error("Expected owned search revision row and column");
    content.rows[0].values[index] = { $integer: "9007199254740993" };
    const bytes = new TextEncoder().encode(`${JSON.stringify(content)}\n`); await writeFile(path, bytes);
    const manifestPath = join(copy, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { tables: { name: string; byteLength: string; sha256: string }[] };
    const entry = manifest.tables.find(table => table.name === "search_revisions");
    if (!entry) throw new Error("Expected owned search revision manifest entry");
    entry.byteLength = String(bytes.length); entry.sha256 = hash(bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const result = await stageRestoreSnapshot({ snapshotDirectory: copy, stagingParentDirectory: f.stagingParent, logger })
      .then(stage => ({ stage, error: null }), (error: unknown) => ({ stage: null, error }));
    if (result.stage) await result.stage.dispose();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : null).toBe("invalid-records");
    expect((await readdir(f.stagingParent)).sort()).toEqual(before); expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect(await readFile(join(f.snapshot.snapshotDirectory, "manifest.json"))).toEqual(sourceManifest);
    expect(await readFile(join(f.snapshot.snapshotDirectory, "tables", "search_revisions.json"))).toEqual(sourceTable);
  }), 30000);
}

async function rewriteInteger(copy: string, tableName: string, column: string, value: string,
  options: { readonly rowId?: boolean; readonly id?: string; readonly sequence?: string } = {}): Promise<void> {
  const path = join(copy, "tables", `${tableName}.json`);
  const table = JSON.parse(await readFile(path, "utf8")) as {
    columns: string[]; rows: { rowid: { $integer: string } | null; values: (string | null | { $integer: string } | { $blob: string })[] }[];
  };
  const idColumn = table.columns.indexOf("id");
  const row = options.id === undefined ? table.rows[0] : table.rows.find(item => item.values[idColumn] === options.id);
  if (!row) throw new Error("Expected owned integer fixture row");
  if (options.rowId) {
    if (row.rowid === null) throw new Error("Expected owned preserved rowid");
    row.rowid = { $integer: value };
  } else {
    const index = table.columns.indexOf(column); if (index < 0) throw new Error("Expected owned integer fixture column");
    row.values[index] = { $integer: value };
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(table)}\n`); await writeFile(path, bytes);
  const manifestPath = join(copy, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    tables: { name: string; byteLength: string; sha256: string }[];
    sequences: { name: string; value: { $integer: string } }[];
  };
  const entry = manifest.tables.find(item => item.name === tableName);
  if (!entry) throw new Error("Expected owned integer fixture manifest entry");
  entry.byteLength = String(bytes.length); entry.sha256 = hash(bytes);
  if (options.sequence) {
    const sequence = manifest.sequences.find(item => item.name === options.sequence);
    if (!sequence) throw new Error("Expected owned AUTOINCREMENT high-water value");
    sequence.value = { $integer: value };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
}

for (const scenario of ["document-sequence", "pending-file-rowid"] as const) {
  test(`staging rejects oversized application ${scenario} despite valid int64 and hashes`, async () => fixture(async f => {
    const sentinel = join(f.stagingParent, "caller-owned"); await writeFile(sentinel, "keep", { mode: 0o600 });
    const before = (await readdir(f.stagingParent)).sort(), original = await readFile(join(f.snapshot.snapshotDirectory, "manifest.json"));
    const copy = join(f.dir, `invalid-range-${scenario}`); await cp(f.snapshot.snapshotDirectory, copy, { recursive: true, errorOnExist: true });
    if (scenario === "document-sequence") await rewriteInteger(copy, "import_documents", "sequence", "9007199254740993", { sequence: "import_documents" });
    else await rewriteInteger(copy, "markdown_import_files", "rowid", "9007199254740993", { rowId: true });
    const result = await stageRestoreSnapshot({ snapshotDirectory: copy, stagingParentDirectory: f.stagingParent, logger })
      .then(stage => ({ stage, error: null }), (error: unknown) => ({ stage: null, error }));
    if (result.stage) await result.stage.dispose();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : null).toBe("invalid-records");
    expect((await readdir(f.stagingParent)).sort()).toEqual(before); expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect(await readFile(join(f.snapshot.snapshotDirectory, "manifest.json"))).toEqual(original);
  }), 30000);
}

test("application safe maximum and unrelated full-int64 ordinary generation remain valid", async () => fixture(async f => {
  const copy = join(f.dir, "valid-boundaries"); await cp(f.snapshot.snapshotDirectory, copy, { recursive: true, errorOnExist: true });
  await rewriteInteger(copy, "search_revisions", "catalog", "9007199254740991");
  await rewriteInteger(copy, "import_documents", "sequence", "9007199254740991", { sequence: "import_documents" });
  await rewriteInteger(copy, "runs", "generation", "9223372036854775807", { id: "historical-run" });
  const manifestPath = join(copy, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { sequences: { name: string; value: { $integer: string } }[] };
  const highWater = manifest.sequences.find(item => item.name === "import_documents");
  if (!highWater) throw new Error("Expected owned AUTOINCREMENT high-water value");
  highWater.value = { $integer: "9223372036854775807" };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const stage = await stageRestoreSnapshot({ snapshotDirectory: copy, stagingParentDirectory: f.stagingParent, logger });
  try {
    const db = new Database(stage.databasePath, { readonly: true, create: false, safeIntegers: true });
    try {
      expect(db.query("SELECT catalog FROM search_revisions").get()).toEqual({ catalog: 9007199254740991n });
      expect(db.query("SELECT sequence FROM import_documents").get()).toEqual({ sequence: 9007199254740991n });
      expect(db.query("SELECT seq FROM sqlite_sequence WHERE name='import_documents'").get()).toEqual({ seq: 9223372036854775807n });
      expect(db.query("SELECT generation FROM runs WHERE id='historical-run'").get()).toEqual({ generation: 9223372036854775807n });
    } finally { db.close(); }
  } finally { await stage.dispose(); }
}), 30000);

test("missing, extra, linked and oversized payloads and pre-abort fail without touching caller entries", async () => fixture(async f => {
  const sentinel = join(f.stagingParent, "caller-owned"); await writeFile(sentinel, "keep", { mode: 0o600 });
  const before = (await readdir(f.stagingParent)).sort();
  for (const scenario of ["missing", "extra", "symlink", "wrong-digest", "manifest-limit", "table-limit", "total-limit", "aborted"] as const) {
    const copy = join(f.dir, `invalid-${scenario}`); await cp(f.snapshot.snapshotDirectory, copy, { recursive: true, errorOnExist: true });
    const table = join(copy, "tables", "thoughts.json");
    if (scenario === "missing") await unlink(table);
    if (scenario === "extra") await writeFile(join(copy, "tables", "unknown.json"), "{}\n", { mode: 0o600 });
    if (scenario === "symlink") { await unlink(table); await symlink(join(f.snapshot.snapshotDirectory, "tables", "thoughts.json"), table); }
    const controller = new AbortController(); if (scenario === "aborted") controller.abort();
    const limits = scenario === "manifest-limit" ? { manifestBytes: 1 } : scenario === "table-limit" ? { tableBytes: 1 } :
      scenario === "total-limit" ? { totalJsonBytes: 1 } : undefined;
    const failure = await stageRestoreSnapshot({ snapshotDirectory: copy, stagingParentDirectory: f.stagingParent, logger,
      ...(limits ? { limits } : {}), ...(scenario === "wrong-digest" ? { expectedManifestSha256: "f".repeat(64) } : {}), signal: controller.signal })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const code = failure && typeof failure === "object" && "code" in failure ? failure.code : null;
    expect(scenario === "aborted" ? code === "aborted" : ["invalid-snapshot", "unsafe-path"].includes(String(code))).toBe(true);
    expect((await readdir(f.stagingParent)).sort()).toEqual(before); expect(await readFile(sentinel, "utf8")).toBe("keep");
  }
}), 30000);

test("disposal refuses unknown content rather than deleting an unowned addition", async () => fixture(async f => {
  const stage = await stageRestoreSnapshot({ snapshotDirectory: f.snapshot.snapshotDirectory, stagingParentDirectory: f.stagingParent, logger });
  const unknown = join(stage.stagingDirectory, "caller-owned"); await writeFile(unknown, "do not remove", { mode: 0o600 });
  const failure = await stage.dispose().then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure && typeof failure === "object" && "code" in failure ? failure.code : null).toBe("cleanup-conflict");
  expect(await readFile(unknown, "utf8")).toBe("do not remove");
  expect((await lstat(stage.stagingDirectory)).isDirectory()).toBe(true);
}), 30000);
