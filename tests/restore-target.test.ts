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
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteAgentInstructions } from "../src/storage/agent-instructions";
import { readSqlSnapshot } from "../src/backup/records";
import { encodeTable } from "../src/backup/format";
import { insertMediaSource, mediaBytes, mediaThought } from "./fixtures/media-source";
import { SqliteAgenticExports } from "../src/storage/agentic-export";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { AgentService } from "../src/domain/agent";
import { SqliteAgentRuns } from "../src/storage/agent";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const logger = createLogger("verbose", () => {}), restoredAt = "2031-02-03T04:05:06.000Z";
const thought = "\uFEFFownedrestoretargettoken\r\nprivate-owned-text";
const guidance = "\uFEFF  retained per-run guidance café\r\n";
const settings = {weaver:"\uFEFF  weaver café\r\n",evolve:"evolve",search:"search",export:"export"};

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
      const instructions = new SqliteAgentInstructions(db,logger);
      instructions.save({...settings,revision:0}); instructions.save({...settings,revision:1});
      db.run("UPDATE run_steps SET input=?,guidance=CAST(? AS TEXT) WHERE run_id=? AND position=0",
        ["owned exact prepared input",new TextEncoder().encode(guidance),runId]);
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

function expectGuidance(path: string, runId: string): void {
  const db = new Database(path,{readonly:true,create:false});
  try {
    expect(new SqliteAgentInstructions(db,logger).get()).toEqual({...settings,revision:2});
    expect(db.query("SELECT hex(CAST(guidance AS BLOB)) AS bytes FROM run_steps WHERE run_id=? AND position=0").get(runId))
      .toEqual({bytes:Buffer.from(guidance,"utf8").toString("hex").toUpperCase()});
  } finally { db.close(); }
}

// The complete frozen logical-1 inventory, independent of the current compiled table list.
const legacyNames = [
  "thoughts","thought_titles","thought_sources","thought_source_seals","connections","connection_sources",
  "responses","response_thoughts","response_seals","rejected_thoughts","rejected_connections",
  "runs","run_steps","agent_bindings","run_context","run_operation_receipts","run_issued_thoughts","run_replies","execution_owners",
  "export_intents","export_reports","import_namespaces","import_documents","import_locations","import_document_parts","import_document_seals",
  "markdown_imports","markdown_import_files","markdown_import_payloads","media_store","media_sources",
  "search_sessions","search_turns","search_messages","search_discoveries","search_content_dependencies","search_composer_contexts",
  "search_composer_dependencies","search_revisions","search_native_cleanup","restore_fences",
].sort();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Freeze the changed historical table shapes; other controlled fixture tables use the shared inventory. */
async function legacySnapshot(root: string, version: 1 | 2 = 1): Promise<string> {
  const dbPath = join(root,"legacy-source.sqlite"), output = join(root,"legacy-snapshot");
  const writer = new Database(dbPath);
  try {
    migrate(writer);
    const store = new SqliteStore(writer);
    store.saveThought({id:"legacy-root",text:"legacy controlled thought",title:null,author:"user",kind:"captured-original",createdAt:"2030",origin:"fixture",parentId:null,sourceIds:[]});
    const sources = {id:(() => { let n=0; return () => `legacy-${++n}`; })(),now:() => "2030",logger};
    new SqliteRunOperations(writer,sources)
      .admitWeave("user",{subjectId:"legacy-root",triggerId:"legacy-trigger"});
    writer.run("UPDATE run_steps SET input='legacy exact input' WHERE position=0");
    const exports = new SqliteAgenticExports(writer,sources), run = exports.admit("user",{request:"Legacy report question",effort:"quick"});
    const claim = new SqliteRunRepository(writer,sources).claim(run.id), steps = new SqliteRunProtocolRepository(writer,logger);
    steps.prepare(claim,{promptId:run.promptId,input:"legacy export input"});
    steps.completeStep(claim,run.promptId,{version:1,kind:"report",markdown:"Legacy report body.",sourceThoughtIds:[]});
    exports.finalize(claim,run.promptId);
    if (version === 2) new SqliteAgentInstructions(writer,logger).save({...settings,revision:0});
  } finally { writer.close(); }
  const reader = new Database(dbPath,{readonly:true,create:false,safeIntegers:true});
  try {
    const names = version === 1 ? legacyNames : [...legacyNames,"agent_instructions"].sort();
    const oldSteps = ["envelope_json",...(version === 2 ? ["guidance"] : []),"input","native_state","position","prompt_id","result_json","run_id","state","submit_owner"];
    const shapes = backupTableShapes.filter(shape => names.includes(shape.name)).map(shape => ({...shape,columns:
      shape.name === "export_intents" ? ["effort","request","run_id"] : shape.name === "run_steps" ? oldSteps : shape.columns}));
    expect(shapes.map(shape => shape.name).sort()).toEqual(names);
    expect(shapes.find(shape => shape.name === "export_intents")?.columns).toEqual(["effort","request","run_id"]);
    expect(shapes.find(shape => shape.name === "run_steps")?.columns.includes("guidance")).toBe(version === 2);
    const snapshot = readSqlSnapshot(reader,() => {},shapes);
    await mkdir(output,{mode:0o700}); await mkdir(join(output,"tables"),{mode:0o700});
    const tables = [];
    for (const table of snapshot.tables) {
      const bytes = encodeTable(table.shape,table.rows), name = table.shape.name;
      await writeFile(join(output,"tables",`${name}.json`),bytes,{mode:0o600});
      tables.push({byteLength:String(bytes.length),name,path:`tables/${name}.json`,rowCount:String(table.rows.length),sha256:digest(bytes)});
    }
    tables.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const sequences = snapshot.sequences.map(entry => ({name:entry.name,value:{$integer:entry.value.toString()}}));
    const manifest = {appSchema:`thoughtloom-logical-${version}`,format:"thoughtloom-backup",mediaMarker:null,mediaStoreId:null,originals:[],sequences,tables,version:1};
    await writeFile(join(output,"manifest.json"),`${JSON.stringify(manifest)}\n`,{mode:0o600});
    return output;
  } finally { reader.close(); }
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

test("logical-1 snapshot restores into current schema with empty settings and null historical guidance", async () => {
  const dir = await mkdtemp("/tmp/opencode/restore-legacy-guidance-");
  try {
    const snapshot = await legacySnapshot(dir), parent = join(dir,"stage"), target = join(dir,"target");
    await mkdir(parent,{mode:0o700}); await mkdir(target,{mode:0o700});
    function legacyDefaults(path: string): void {
      const db = new Database(path,{readonly:true,create:false});
      try {
        expect(new SqliteAgentInstructions(db,logger).get()).toEqual({weaver:"",evolve:"",search:"",export:"",revision:0});
        expect(db.query("SELECT input,guidance FROM run_steps WHERE input='legacy exact input'").all()).toEqual([{input:"legacy exact input",guidance:null}]);
        expect(db.query("SELECT request,effort,local_disposition FROM export_intents").get()).toEqual({request:"Legacy report question",effort:"quick",local_disposition:"retained"});
        expect(db.query("SELECT markdown FROM export_reports").get()).toEqual({markdown:"Legacy report body.\n\n## Sources\n\nNo source thoughts were cited; this report has no validated thought citations.\n"});
        expect(db.query("SELECT status FROM runs WHERE kind='export'").get()).toEqual({status:"completed"});
        expect(db.query("SELECT text FROM thoughts WHERE id='legacy-root'").get()).toEqual({text:"legacy controlled thought"});
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { db.close(); }
    }
    const stage = await stageRestoreSnapshot({snapshotDirectory:snapshot,stagingParentDirectory:parent,logger});
    try {
      legacyDefaults(stage.databasePath);
      await recoverRestoreStage(stage,{restoredAt,logger});
      legacyDefaults(stage.databasePath);
    } finally { await stage.dispose(); }
    const installed = await restoreBackup({snapshotDirectory:snapshot,targetDirectory:target,restoredAt,logger});
    legacyDefaults(installed.databasePath);
  } finally { await rm(dir,{recursive:true,force:true}); }
},45000);

test("logical-2 export records restore with retained disposition and unchanged report", async () => {
  const dir = await mkdtemp("/tmp/opencode/restore-legacy-export-");
  try {
    const snapshot = await legacySnapshot(dir,2), target = join(dir,"target");
    const restored = await restoreBackup({snapshotDirectory:snapshot,targetDirectory:target,restoredAt,logger});
    const db = new Database(restored.databasePath,{readonly:true,create:false});
    try {
      expect(new SqliteAgentInstructions(db,logger).get()).toEqual({...settings,revision:1});
      expect(db.query("SELECT request,effort,local_disposition FROM export_intents").get()).toEqual({request:"Legacy report question",effort:"quick",local_disposition:"retained"});
      expect(db.query("SELECT status FROM runs WHERE kind='export'").get()).toEqual({status:"completed"});
      expect((db.query<{markdown:string},[]>("SELECT markdown FROM export_reports").get())?.markdown).toContain("Legacy report body.");
      expect(db.query("SELECT text FROM thoughts WHERE id='legacy-root'").get()).toEqual({text:"legacy controlled thought"});
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  } finally { await rm(dir,{recursive:true,force:true}); }
},45000);

test("logical-3 preserves restored export local Stop across capture and restore, then deletes without provider calls", async () => fixture(async f => {
  let sequence = 0;
  const sources = {id:() => `roundtrip-export-${++sequence}`,now:() => "2030",logger};
  const source = new Database(f.source); let exportId: string;
  try { exportId = new SqliteAgenticExports(source,sources).admit("user",{request:"Roundtrip export",effort:"thorough"}).id; }
  finally { source.close(); }
  const output = join(f.dir,"export-capture"); await mkdir(output,{mode:0o700});
  const first = await captureBackup({databasePath:f.source,mediaDirectory:`${f.source}.media`,outputDirectory:output,logger});
  expect((JSON.parse(await readFile(join(first.snapshotDirectory,"manifest.json"),"utf8")) as {appSchema:string}).appSchema).toBe("thoughtloom-logical-3");
  const restored = await restoreBackup({snapshotDirectory:first.snapshotDirectory,targetDirectory:join(f.dir,"export-first"),restoredAt,logger});
  const firstDb = new Database(restored.databasePath);
  let originalFence: unknown;
  try {
    firstDb.exec("PRAGMA journal_mode=WAL");
    const exports = new SqliteAgenticExports(firstDb,sources);
    expect(exports.get("user",exportId)).toMatchObject({status:"interrupted",restored:true,deletionState:"stop-required"});
    const before = firstDb.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(exportId);
    new AgentService(new SqliteAgentRuns(firstDb,sources),false).stop("user",exportId);
    expect(firstDb.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(exportId)).toEqual(before);
    expect(firstDb.query("SELECT local_disposition FROM export_intents WHERE run_id=?").get(exportId)).toEqual({local_disposition:"local-stopped"});
    originalFence = firstDb.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(f.runId);
  } finally { firstDb.close(); }
  const nextOutput = join(f.dir,"export-recapture"); await mkdir(nextOutput,{mode:0o700});
  const next = await captureBackup({databasePath:restored.databasePath,mediaDirectory:restored.mediaDirectory,outputDirectory:nextOutput,logger});
  const intentTable = JSON.parse(await readFile(join(next.snapshotDirectory,"tables/export_intents.json"),"utf8")) as {columns:string[];rows:{values:unknown[]}[]};
  const dispositionIndex = intentTable.columns.indexOf("local_disposition");
  expect(dispositionIndex).toBeGreaterThanOrEqual(0);
  expect(intentTable.rows.some(row => row.values[dispositionIndex] === "local-stopped")).toBe(true);
  const second = await restoreBackup({snapshotDirectory:next.snapshotDirectory,targetDirectory:join(f.dir,"export-second"),restoredAt,logger});
  const db = new Database(second.databasePath); let resolutions = 0, clients = 0;
  const worker = new ConfiguredRunWorker({db,...sources,config:{service:{url:"http://127.0.0.1:44991"},directory:"/tmp/opencode/owned-restore-agent",
    model:{providerID:"fixture",id:"fixture"},effort:{quick:null,standard:null,thorough:null}},
    async resolve() { resolutions++; throw new Error("unexpected historical resolver"); }, client() { clients++; throw new Error("unexpected historical client"); }});
  try {
    const exports = new SqliteAgenticExports(db,sources);
    expect(exports.get("user",exportId)).toMatchObject({restored:true,deletionState:"ready"});
    await worker.tick(exportId);
    exports.delete("user",exportId);
    await worker.tick(exportId);
    expect(resolutions).toBe(0); expect(clients).toBe(0);
    expect(db.query("SELECT * FROM runs WHERE id=?").get(exportId)).toBeNull();
    expect(db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(exportId)).toBeNull();
    expect(db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(f.runId)).toEqual(originalFence);
    expect(db.query("SELECT text FROM thoughts WHERE id='root'").get()).toEqual({text:thought});
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { worker.pause(); await worker.drain(); db.close(); }
}),45000);

test("unknown or mixed logical schema snapshots are rejected before staging", async () => {
  const dir = await mkdtemp("/tmp/opencode/restore-mixed-guidance-");
  try {
    const snapshot = await legacySnapshot(dir), parent = join(dir,"stage");
    await mkdir(parent,{mode:0o700});
    for (const [name,schema] of [["unknown","thoughtloom-logical-999"],["mixed","thoughtloom-logical-2"]] as const) {
      const copy = join(dir,name); await cp(snapshot,copy,{recursive:true,errorOnExist:true});
      const path = join(copy,"manifest.json"), manifest = JSON.parse(await readFile(path,"utf8")) as {appSchema:string};
      manifest.appSchema = schema; await writeFile(path,`${JSON.stringify(manifest)}\n`);
      const result = await failure(stageRestoreSnapshot({snapshotDirectory:copy,stagingParentDirectory:parent,logger}));
      expect(code(result)).toBe("invalid-snapshot");
      expect(await readdir(parent)).toEqual([]);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
},45000);

test("final restore installs the exact recovered snapshot on one exclusively owned inode", async () => fixture(async f => {
  const referenceParent = join(f.dir, "reference"), target = join(f.dir, "target"), dbPath = join(target, "thoughtloom.sqlite");
  await mkdir(referenceParent, { mode: 0o700 }); await mkdir(target, { mode: 0o700 });
  const reference = await stageRestoreSnapshot({ snapshotDirectory: f.snapshot.snapshotDirectory, stagingParentDirectory: referenceParent, logger });
  let expected: ReturnType<typeof tables>;
  try {
    expectGuidance(reference.databasePath,f.runId);
    await recoverRestoreStage(reference, { restoredAt, logger });
    expectGuidance(reference.databasePath,f.runId);
    expected = tables(reference.databasePath);
  }
  finally { await reference.dispose(); }
  const sourceBefore = tables(f.source), manifest = await readFile(join(f.snapshot.snapshotDirectory, "manifest.json"));
  expect((JSON.parse(manifest.toString()) as {appSchema:string}).appSchema).toBe("thoughtloom-logical-3");
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
  expectGuidance(dbPath,f.runId);
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
