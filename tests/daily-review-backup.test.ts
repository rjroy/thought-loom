import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureBackup } from "../src/backup/capture";
import { decodeManifest, decodeTable } from "../src/backup/decode";
import { encodeManifest, encodeTable, type RawRow } from "../src/backup/format";
import { compareRestoreRecords } from "../src/backup/restore-load";
import { recoverRestoreStage, restoreBackup, stageRestoreSnapshot } from "../src/backup/restore-staging";
import { readSqlSnapshot } from "../src/backup/records";
import { shapesForSchema, type BackupAppSchema } from "../src/backup/schema";
import { screeningPolicy } from "../src/domain/connection-screening";
import { RunFenceError } from "../src/domain/run";
import { SqliteDailyReviews } from "../src/storage/daily-review";
import { SqliteReinterpretations } from "../src/storage/reinterpretation";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteScheduledTitles } from "../src/storage/title-scheduling";
import { migrate } from "../src/storage/sqlite";
import { dailyReviewFixture, reviewPolicy, type DailyReviewFixture } from "./fixtures/daily-review";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const restoredAt = "2032-01-01T00:00:00.000Z";
interface BackupFixture extends DailyReviewFixture {readonly snapshot:string;readonly reviewsBefore:ReturnType<typeof reviewRows>;readonly runIds:readonly string[];readonly retiredId:string}
function reviewRows(db: Database) {
  return ["daily_review_batches","daily_review_items"].map(table => ({table,rows:db.query(`SELECT * FROM ${table} ORDER BY ${table === "daily_review_batches" ? "review_date" : "run_id"}`).all()}));
}
async function owned(action: (fixture: BackupFixture) => Promise<void>, reviews = true) {
  await dailyReviewFixture(async f => {
    for (const id of ["a","b","c","d","e"]) f.seed(id);
    const runIds: string[] = [];
    if (reviews) {
      const batch = f.admitLegacy(); if (batch.kind !== "admitted") throw new Error("Expected owned batch");
      runIds.push(...batch.runIds);
      if (!runIds[0] || !runIds[1]) throw new Error("Expected two owned members");
      f.complete(f.prepare(runIds[0])); f.prepare(runIds[1]);
    }
    // Retain real logical-5 screening/retirement history, so older projections cannot accidentally default it away.
    f.seed("zz-legacy");
    const old = f.ops.admitWeave("user",{subjectId:"zz-legacy",triggerId:"owned-pre-review"}), claim = f.runs.claim(old.id);
    f.state.beginScreening(claim,"zz-legacy",screeningPolicy("owned-backup-judge"));
    f.state.screeningPair(claim,"zz-legacy","a"); f.state.recordScreeningJudgment(claim,"zz-legacy","a",0.75);
    f.runs.stop(old.id); f.state.settleUnsubmitted(old.id);
    new SqliteReinterpretations(f.db,f.sources).prepareRetirement("zz-legacy",old.id)();
    const output = join(f.dir,"output"); await mkdir(output,{mode:0o700});
    const snapshot = await captureBackup({databasePath:f.path,mediaDirectory:f.media,outputDirectory:output,logger:f.sources.logger});
    await action({...f,snapshot:snapshot.snapshotDirectory,reviewsBefore:reviewRows(f.db),runIds,retiredId:old.id});
  });
}

test("current capture/recovery/installation preserve successful review metadata and seal without reviving incomplete work", async () => owned(async f => {
  const manifest = decodeManifest(await readFile(join(f.snapshot,"manifest.json")));
  expect(manifest.appSchema).toBe("thoughtloom-logical-10");
  const parent = join(f.dir,"stage"); await mkdir(parent,{mode:0o700});
  const stage = await stageRestoreSnapshot({snapshotDirectory:f.snapshot,stagingParentDirectory:parent,logger:f.sources.logger});
  try {
    const before = new Database(stage.databasePath);
    try { expect(reviewRows(before)).toEqual(f.reviewsBefore); } finally { before.close(); }
    await recoverRestoreStage(stage,{restoredAt,logger:f.sources.logger});
    const recovered = new Database(stage.databasePath);
    try {
      expect(reviewRows(recovered)).toEqual(f.reviewsBefore);
      expect(recovered.query("SELECT status FROM runs WHERE id=?").get(f.runIds[1] ?? "missing")).toEqual({status:"interrupted"});
    } finally { recovered.close(); }
  } finally { await stage.dispose(); }
  const target = await restoreBackup({snapshotDirectory:f.snapshot,targetDirectory:join(f.dir,"target"),restoredAt,logger:f.sources.logger});
  const db = new Database(target.databasePath);
  try {
    expect(reviewRows(db)).toEqual(f.reviewsBefore);
    const reviews = new SqliteDailyReviews(db,f.sources,reviewPolicy);
    expect(reviews.lastReviewedAt("a")).toBe(f.clock.now); expect(reviews.lastReviewedAt("b")).toBeNull();
    expect(reviews.admitDueBatch(f.clock.now,true).kind).toBe("already-admitted");
    for (const id of f.runIds) expect(() => new SqliteRunRepository(db,f.sources).claim(id)).toThrow(RunFenceError);
    const next = reviews.admitDueBatch("2031-01-02T12:00:00Z",true);
    expect(next.kind).toBe("admitted");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
}),45000);

const legacySchemas: readonly BackupAppSchema[] = ["thoughtloom-logical-1","thoughtloom-logical-2","thoughtloom-logical-3","thoughtloom-logical-4","thoughtloom-logical-5","thoughtloom-logical-6","thoughtloom-logical-7"];
test.each(legacySchemas)("%s restoration verifies additive defaults and preserves every original projection byte", async schema => owned(async f => {
  const original = decodeManifest(await readFile(join(f.snapshot,"manifest.json"))), destination = join(f.dir,`legacy-${schema}`);
  await mkdir(join(destination,"tables"),{recursive:true,mode:0o700});
  const tables = [];
  for (const shape of shapesForSchema(schema)) {
    const current = decodeTable(shape.name,await readFile(join(f.snapshot,"tables",`${shape.name}.json`)));
    const rows: RawRow[] = current.map(row => ({rowid:row.rowid,values:Object.fromEntries(shape.columns.map(name => [name,row.values[name]]))}));
    const bytes = encodeTable(shape,rows), path = `tables/${shape.name}.json`;
    await writeFile(join(destination,path),bytes,{mode:0o600});
    tables.push({name:shape.name,path,rowCount:String(rows.length),byteLength:String(bytes.length),sha256:digest(bytes)});
  }
  const manifest = {...original,appSchema:schema,tables};
  await writeFile(join(destination,"manifest.json"),encodeManifest(manifest),{mode:0o600});
  const parent = join(f.dir,"stage"); await mkdir(parent,{mode:0o700});
  const stage = await stageRestoreSnapshot({snapshotDirectory:destination,stagingParentDirectory:parent,logger:f.sources.logger});
  try {
    const db = new Database(stage.databasePath,{safeIntegers:true});
    try {
      if (schema === "thoughtloom-logical-6" || schema === "thoughtloom-logical-7") {
        const numeric = new Database(stage.databasePath);
        try { expect(reviewRows(numeric)).toEqual(f.reviewsBefore); } finally { numeric.close(); }
        expect(f.reviewsBefore[0]?.rows.length).toBeGreaterThan(0);
      } else {
        expect(db.query("SELECT * FROM daily_review_batches").all()).toEqual([]);
        expect(db.query("SELECT * FROM daily_review_items").all()).toEqual([]);
      }
      expect(db.query("SELECT 1 FROM run_screening_pairs WHERE excluded_connection_id IS NOT NULL").get()).toBeNull();
      compareRestoreRecords(readSqlSnapshot(db,() => {},shapesForSchema(schema)),manifest);
      if (schema === "thoughtloom-logical-5" || schema === "thoughtloom-logical-6") expect(db.query("SELECT judgment_json FROM run_screening_pairs WHERE judgment_json IS NOT NULL").all()).toEqual([{judgment_json:'{"score":0.75}'}]);
      if (schema === "thoughtloom-logical-4" || schema === "thoughtloom-logical-5" || schema === "thoughtloom-logical-6") {
        expect(db.query("SELECT weave_retired_at FROM runs WHERE id=?").get(f.retiredId)).toEqual({weave_retired_at:f.clock.now});
      }
    } finally { db.close(); }
  } finally { await stage.dispose(); }
},schema === "thoughtloom-logical-6" || schema === "thoughtloom-logical-7"),45000);

test("logical-8 roundtrip preserves legacy and new review protocols and title work without reviving runs", async () => dailyReviewFixture(async f => {
  for (const id of ["a","b","c","d","e"]) f.seed(id);
  const legacy = f.admitLegacy();
  if (legacy.kind !== "admitted" || !legacy.runIds[0]) throw new Error("Expected legacy review");
  for (const id of legacy.runIds) f.complete(f.prepare(id));
  const current = f.admit("2031-01-02T12:00:00.000Z");
  if (current.kind !== "admitted" || !current.runIds[0]) throw new Error("Expected connection review");
  for (const id of current.runIds) f.complete(f.prepare(id));
  const titles = new SqliteScheduledTitles(f.db,f.sources).admitDueBatch(f.clock.now,true);
  if (titles.kind !== "admitted" || !titles.runIds[0]) throw new Error("Expected scheduled titles");
  const titleId = titles.runIds[0], claim = f.prepare(titleId), run = f.run(titleId);
  const titledSubject = f.ops.weaveIntent(titleId)?.subjectId;
  if (!titledSubject) throw new Error("Expected title subject");
  const request = {capability:"title-fill",arguments:{title:"Owned scheduled title"}} as const;
  f.steps.completeStep(claim,run.promptId,{version:1,kind:"request",request});
  const result = f.capabilities.dispatch(claim,run.promptId,request);
  const next = f.steps.advance(claim,run.promptId,result,{promptId:f.sources.id(),input:"Owned confirmed title result"});
  f.steps.completeStep(claim,next.promptId,{version:1,kind:"complete",reply:"Title saved"});
  f.state.finish(claim,next.promptId);
  expect(f.run(titleId).status).toBe("completed"); expect(f.runs.reply(titleId)).toBeNull();
  const ids = [...legacy.runIds,...current.runIds,...titles.runIds];
  const rows = f.db.query("SELECT id,weave_subject_id,weave_trigger_id,status FROM runs ORDER BY rowid").all();
  const steps = f.db.query("SELECT run_id,position,prompt_id,input,envelope_json,result_json FROM run_steps ORDER BY run_id,position").all();
  const reviewsBeforeMigration = reviewRows(f.db);
  migrate(f.db,f.sources.logger);
  expect(f.db.query("SELECT id,weave_subject_id,weave_trigger_id,status FROM runs ORDER BY rowid").all()).toEqual(rows);
  expect(f.db.query("SELECT run_id,position,prompt_id,input,envelope_json,result_json FROM run_steps ORDER BY run_id,position").all()).toEqual(steps);
  expect(reviewRows(f.db)).toEqual(reviewsBeforeMigration);
  const output = join(f.dir,"mixed-output"); await mkdir(output,{mode:0o700});
  const backup = await captureBackup({databasePath:f.path,mediaDirectory:f.media,outputDirectory:output,logger:f.sources.logger});
  expect(decodeManifest(await readFile(join(backup.snapshotDirectory,"manifest.json"))).appSchema).toBe("thoughtloom-logical-10");
  // Logical-8 has the same review/run shapes, but not the logical-9 local-stop table.
  const logical8 = join(f.dir,"projected-logical-8");
  await cp(backup.snapshotDirectory,logical8,{recursive:true,errorOnExist:true});
  const logical8ManifestPath = join(logical8,"manifest.json"), capturedManifest = decodeManifest(await readFile(logical8ManifestPath));
  const logical8Names = new Set(shapesForSchema("thoughtloom-logical-8").map(shape => shape.name));
  for (const entry of capturedManifest.tables) if (!logical8Names.has(entry.name)) await rm(join(logical8,entry.path));
  await writeFile(logical8ManifestPath,encodeManifest({...capturedManifest,appSchema:"thoughtloom-logical-8",
    tables:capturedManifest.tables.filter(entry => logical8Names.has(entry.name))}),{mode:0o600});
  const mislabeled = join(f.dir,"mislabeled-logical-7");
  await cp(logical8,mislabeled,{recursive:true,errorOnExist:true});
  const manifestPath = join(mislabeled,"manifest.json"), currentManifest = decodeManifest(await readFile(manifestPath));
  await writeFile(manifestPath,encodeManifest({...currentManifest,appSchema:"thoughtloom-logical-7"}),{mode:0o600});
  const stagingParent = join(f.dir,"mislabeled-stage"); await mkdir(stagingParent,{mode:0o700});
  await expect(stageRestoreSnapshot({snapshotDirectory:mislabeled,stagingParentDirectory:stagingParent,logger:f.sources.logger}))
    .rejects.toMatchObject({code:"invalid-snapshot"});
  const restored = await restoreBackup({snapshotDirectory:logical8,targetDirectory:join(f.dir,"mixed-target"),restoredAt,logger:f.sources.logger});
  const db = new Database(restored.databasePath);
  try {
    const historical = db.query("SELECT id,weave_subject_id,weave_trigger_id,status FROM runs ORDER BY rowid").all() as {id:string;status:string}[];
    const original = rows as {id:string;status:string}[];
    expect(historical.map(row => ({...row,status:original.find(item => item.id === row.id)?.status}))).toEqual(original);
    for (const row of historical) expect(row.status).toBe(original.find(item => item.id === row.id)?.status === "queued" ? "interrupted" : "completed");
    expect(db.query("SELECT run_id,position,prompt_id,input,envelope_json,result_json FROM run_steps ORDER BY run_id,position").all()).toEqual(steps);
    expect(new SqliteRunRepository(db,f.sources).reply(titleId)).toBeNull();
    expect(db.query("SELECT title,title_author FROM thought_titles WHERE thought_id=?").get(titledSubject)).toEqual({title:"Owned scheduled title",title_author:"ai"});
    for (const id of ids) expect(() => new SqliteRunRepository(db,f.sources).claim(id)).toThrow(RunFenceError);
    expect(new SqliteScheduledTitles(db,f.sources).admitDueBatch(f.clock.now,true).kind).toBe("already-admitted");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
}),45000);

test.each(["wrong-trigger","wrong-policy","wrong-ceiling","missing-success","false-success","incomplete-envelope"] as const)(
  "restore refuses hash-consistent daily review %s corruption", async fault => owned(async f => {
    const copy = join(f.dir,"corrupt"); await cp(f.snapshot,copy,{recursive:true,errorOnExist:true});
    const name = fault === "wrong-trigger" ? "runs" : fault === "wrong-policy" || fault === "wrong-ceiling" ? "daily_review_batches" : fault === "incomplete-envelope" ? "run_steps" : "daily_review_items";
    const path = join(copy,"tables",`${name}.json`);
    const table = JSON.parse(await readFile(path,"utf8")) as {columns:string[];rows:{rowid:unknown;values:(string|{$integer:string}|null)[]}[]};
    const key = table.columns.indexOf(name === "runs" ? "id" : name === "daily_review_batches" ? "review_date" : "run_id");
    const row = table.rows.find(row => row.values[key] === (name === "daily_review_batches" ? "2031-01-01" : f.runIds[fault === "false-success" ? 1 : 0]));
    if (!row) throw new Error("Expected owned corruption target");
    const field = fault === "wrong-trigger" ? "weave_trigger_id" : fault === "wrong-policy" ? "policy_json" : fault === "wrong-ceiling" ? "ceiling" : fault === "incomplete-envelope" ? "envelope_json" : "completed_at";
    row.values[table.columns.indexOf(field)] = fault === "wrong-trigger" ? "daily-review:2031-02-29" : fault === "wrong-policy" ? '{"rotationDays":0,"maxPerDay":3}' :
      fault === "wrong-ceiling" ? {$integer:"1"} : fault === "missing-success" ? null : fault === "false-success" ? f.clock.now : '{"version":1,"kind":"review-complete","titleCheck":"complete"}';
    const bytes = new TextEncoder().encode(`${JSON.stringify(table)}\n`); await writeFile(path,bytes,{mode:0o600});
    const manifest = decodeManifest(await readFile(join(copy,"manifest.json")));
    await writeFile(join(copy,"manifest.json"),encodeManifest({...manifest,tables:manifest.tables.map(entry => entry.name === name ? {...entry,byteLength:String(bytes.length),sha256:digest(bytes)} : entry)}),{mode:0o600});
    const parent = join(f.dir,"stage"); await mkdir(parent,{mode:0o700});
    await expect(stageRestoreSnapshot({snapshotDirectory:copy,stagingParentDirectory:parent,logger:f.sources.logger})).rejects.toMatchObject({code:"invalid-records"});
  }),45000);
