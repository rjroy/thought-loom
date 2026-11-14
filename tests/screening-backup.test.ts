import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureBackup } from "../src/backup/capture";
import { stageRestoreSnapshot, recoverRestoreStage, restoreBackup } from "../src/backup/restore-staging";
import { decodeManifest } from "../src/backup/decode";
import { encodeManifest } from "../src/backup/format";
import { startDaemon } from "../src/daemon/runtime";
import { screeningPolicy } from "../src/domain/connection-screening";
import { RunAdmissionService, RunFenceError } from "../src/domain/run";
import { createLogger } from "../src/logging";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { SqliteStore } from "../src/storage/sqlite";

const logger = createLogger("verbose",() => {}), now = () => "2030", restoredAt = "2031-02-03T04:05:06.000Z";
const credentials = {user:"user-0123456789-0123456789-abcdef",ai:"agent-0123456789-0123456789-abcdef"};
interface Fixture {readonly dir:string;readonly snapshot:string;readonly runIds:readonly string[];readonly history:unknown;
  readonly discovery:{readonly origin:string;readonly subjects:readonly string[];readonly owners:readonly string[]};
  readonly direct:{readonly subjects:readonly string[];readonly owners:readonly string[]}}
function history(db: Database): unknown {
  return ["run_screening_passes","run_screening_pairs"].map(name => ({name,rows:db.query(`SELECT * FROM ${name} ORDER BY run_id${name === "run_screening_pairs" ? ",position" : ""}`).all()}));
}
async function owned(action: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/screening-backup-"), path = join(dir,"owned.sqlite"), output = join(dir,"output");
  try {
    await mkdir(output,{mode:0o700});
    const daemon = await startDaemon({dbPath:path,port:0,credentials},() => {},{logSink:() => {}});
    await daemon.stop();
    const db = new Database(path); let saved: unknown; const runIds: string[] = [];
    let discovery: Fixture["discovery"], direct: Fixture["direct"];
    try {
      let n=0; const sources = {id:() => `backup-screen-${++n}`,now,logger};
      const store = new SqliteStore(db);
      for (const id of ["root","candidate"]) store.saveThought({id,text:`owned ${id}`,title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
      const ops = new SqliteRunOperations(db,sources), runs = new SqliteRunRepository(db,sources), state = new SqliteRunWorkerState(db,sources);
      for (const status of ["collecting","complete","fallback"] as const) {
        const run = ops.admitWeave("user",{subjectId:"root",triggerId:`backup-${status}`}), claim = runs.claim(run.id);
        runIds.push(run.id); state.beginScreening(claim,"root",screeningPolicy("owned-backup-judge"));
        state.screeningPair(claim,"root","candidate");
        if (status !== "fallback") state.recordScreeningJudgment(claim,"root","candidate",0.75);
        else state.screeningFailed(claim);
        if (status === "complete") state.prepareInitial(claim,() => "fallback",() => "owned exact prompt\r\n");
        // Terminal history permits the next distinct invitation on this subject, without inventing native submission.
        if (status !== "fallback") { runs.stop(run.id); expect(state.settleUnsubmitted(run.id)).toBe(true); }
      }
      const admission = new RunAdmissionService({...sources,repository:runs}).admit("user","evolve",{parentId:"root",text:"Owned backup contribution"});
      if (!admission.contribution) throw new Error("Expected contribution");
      const development = runs.commit(runs.claim(admission.run.id),{id:"owned-legacy-development",type:"development",parentId:admission.contribution.id,text:"Owned backup development",sourceIds:[]}).thought;
      const subjects = [admission.contribution.id,development.id];
      const owners = subjects.map(subject => {
        const owner = db.query<{id:string},[string]>("SELECT id FROM runs WHERE weave_subject_id=? AND weave_trigger_id LIKE 'connection-discovery:%'").get(subject);
        if (!owner) throw new Error("Expected durable creation owner"); return owner.id;
      });
      discovery = {origin:admission.run.id,subjects,owners};
      const directStore = new SqliteStore(db,sources), directSubjects = ["owned-direct-contribution","owned-direct-development"];
      for (const [index,id] of directSubjects.entries()) directStore.saveThought({id,text:`Owned direct text ${index}`,title:null,
        author:index === 0 ? "user" : "ai",kind:index === 0 ? "user-contribution" : "developing-idea",createdAt:now(),
        origin:index === 0 ? "contribution" : "development",parentId:"root",sourceIds:[]});
      direct = {subjects:directSubjects,owners:directSubjects.map(subject => {
        const owner = db.query<{id:string},[string]>("SELECT id FROM runs WHERE weave_subject_id=? AND weave_trigger_id LIKE 'connection-discovery-direct:%'").get(subject);
        if (!owner) throw new Error("Expected direct creation owner"); return owner.id;
      })};
      saved = history(db);
    } finally { db.close(); }
    const snapshot = await captureBackup({databasePath:path,mediaDirectory:`${path}.media`,outputDirectory:output,logger});
    await action({dir,snapshot:snapshot.snapshotDirectory,runIds,history:saved,discovery,direct});
  } finally { await rm(dir,{recursive:true,force:true}); }
}

test("current capture, staged recovery and offline installation preserve screening history and fence execution", async () => owned(async f => {
  const manifest = decodeManifest(await readFile(join(f.snapshot,"manifest.json")));
  expect(manifest.appSchema).toBe("thoughtloom-logical-6");
  expect(manifest.tables.filter(table => table.name.startsWith("run_screening_")).map(table => table.rowCount)).toEqual(["3","3"]);
  const parent = join(f.dir,"stage"); await mkdir(parent,{mode:0o700});
  const stage = await stageRestoreSnapshot({snapshotDirectory:f.snapshot,stagingParentDirectory:parent,logger});
  function verify(path: string, fenced: boolean): void {
    const db = new Database(path,{create:false,readwrite:true});
    try {
      expect(history(db)).toEqual(f.history);
      expect(db.query("SELECT input FROM run_steps WHERE input IS NOT NULL").all()).toEqual([{input:"owned exact prompt\r\n"}]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const [index,owner] of f.discovery.owners.entries()) {
        expect(db.query("SELECT weave_subject_id AS subject,weave_trigger_id AS origin FROM runs WHERE id=?").get(owner))
          .toEqual({subject:f.discovery.subjects[index],origin:`connection-discovery:${f.discovery.origin}`});
      }
      for (const [index,owner] of f.direct.owners.entries()) {
        const subject = f.direct.subjects[index];
        expect(db.query("SELECT weave_subject_id AS subject,weave_trigger_id AS trigger FROM runs WHERE id=?").get(owner))
          .toEqual({subject,trigger:`connection-discovery-direct:${subject}`});
      }
      if (fenced) {
        const sources = {id:() => "unused",now,logger}, state = new SqliteRunWorkerState(db,sources), runs = new SqliteRunRepository(db,sources);
        for (const runId of [...f.runIds,f.discovery.origin,...f.discovery.owners,...f.direct.owners]) {
          expect(() => runs.claim(runId)).toThrow(RunFenceError);
          const claim = {runId,generation:runs.get(runId)?.generation ?? -1};
          expect(() => state.beginScreening(claim,"root",screeningPolicy("new-config"))).toThrow(RunFenceError);
          expect(() => state.recordScreeningJudgment(claim,"root","candidate",1)).toThrow(RunFenceError);
          expect(() => state.screeningPair(claim,"root","candidate")).toThrow(RunFenceError);
        }
      }
    } finally { db.close(); }
  }
  try {
    verify(stage.databasePath,false); await recoverRestoreStage(stage,{restoredAt,logger}); verify(stage.databasePath,true);
  } finally { await stage.dispose(); }
  verify((await restoreBackup({snapshotDirectory:f.snapshot,targetDirectory:join(f.dir,"target"),restoredAt,logger})).databasePath,true);
}),45000);

test.each(["empty-subject","mismatched-subject","invalid-source"] as const)("restore refuses a hash-consistent direct discovery %s", async fault => owned(async f => {
  const path = join(f.snapshot,"tables","runs.json"), payload = JSON.parse(await readFile(path,"utf8")) as {
    columns:string[];rows:{rowid:unknown;values:(string|{$integer:string}|null)[]}[];
  };
  const id = payload.columns.indexOf("id"), trigger = payload.columns.indexOf("weave_trigger_id"), subject = payload.columns.indexOf("weave_subject_id");
  const row = payload.rows.find(row => row.values[id] === f.direct.owners[0]);
  if (!row) throw new Error("Missing direct discovery run");
  row.values[trigger] = fault === "empty-subject" ? "connection-discovery-direct:" : "connection-discovery-direct:root";
  if (fault === "invalid-source") row.values[subject] = "root";
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload)}\n`); await writeFile(path,bytes,{mode:0o600});
  const manifestPath = join(f.snapshot,"manifest.json"), manifest = decodeManifest(await readFile(manifestPath));
  await writeFile(manifestPath,encodeManifest({...manifest,tables:manifest.tables.map(entry => entry.name === "runs" ? {
    ...entry,byteLength:String(bytes.length),sha256:createHash("sha256").update(bytes).digest("hex"),
  } : entry)}),{mode:0o600});
  const parent = join(f.dir,"stage"); await mkdir(parent,{mode:0o700});
  await expect(stageRestoreSnapshot({snapshotDirectory:f.snapshot,stagingParentDirectory:parent,logger})).rejects.toMatchObject({code:"invalid-records"});
}),45000);

test("restore refuses a hash-consistent discovery trigger without its retained creation origin", async () => owned(async f => {
  const path = join(f.snapshot,"tables","runs.json"), payload = JSON.parse(await readFile(path,"utf8")) as {
    columns:string[];rows:{rowid:unknown;values:(string|{$integer:string}|null)[]}[];
  };
  const id = payload.columns.indexOf("id"), trigger = payload.columns.indexOf("weave_trigger_id");
  const row = payload.rows.find(row => row.values[id] === f.discovery.owners[0]);
  if (!row) throw new Error("Missing owned discovery run");
  row.values[trigger] = "connection-discovery:missing-origin";
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload)}\n`); await writeFile(path,bytes,{mode:0o600});
  const manifestPath = join(f.snapshot,"manifest.json"), manifest = decodeManifest(await readFile(manifestPath));
  await writeFile(manifestPath,encodeManifest({...manifest,tables:manifest.tables.map(entry => entry.name === "runs" ? {
    ...entry,byteLength:String(bytes.length),sha256:createHash("sha256").update(bytes).digest("hex"),
  } : entry)}),{mode:0o600});
  const parent = join(f.dir,"stage"); await mkdir(parent,{mode:0o700});
  let stage: Awaited<ReturnType<typeof stageRestoreSnapshot>> | undefined, failure: unknown;
  try { stage = await stageRestoreSnapshot({snapshotDirectory:f.snapshot,stagingParentDirectory:parent,logger}); }
  catch (error) { failure = error; }
  finally { await stage?.dispose(); }
  expect(failure).toMatchObject({code:"invalid-records"});
}),45000);

test("restore refuses a run-created thought disguised as a direct discovery source", async () => owned(async f => {
  const path = join(f.snapshot,"tables","runs.json"), payload = JSON.parse(await readFile(path,"utf8")) as {
    columns:string[];rows:{rowid:unknown;values:(string|{$integer:string}|null)[]}[];
  };
  const id = payload.columns.indexOf("id"), trigger = payload.columns.indexOf("weave_trigger_id");
  const row = payload.rows.find(row => row.values[id] === f.discovery.owners[0]);
  if (!row) throw new Error("Missing owned discovery run");
  row.values[trigger] = `connection-discovery-direct:${f.discovery.subjects[0]}`;
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload)}\n`); await writeFile(path,bytes,{mode:0o600});
  const manifestPath = join(f.snapshot,"manifest.json"), manifest = decodeManifest(await readFile(manifestPath));
  await writeFile(manifestPath,encodeManifest({...manifest,tables:manifest.tables.map(entry => entry.name === "runs" ? {
    ...entry,byteLength:String(bytes.length),sha256:createHash("sha256").update(bytes).digest("hex"),
  } : entry)}),{mode:0o600});
  const parent = join(f.dir,"stage"); await mkdir(parent,{mode:0o700});
  let stage: Awaited<ReturnType<typeof stageRestoreSnapshot>> | undefined, failure: unknown;
  try { stage = await stageRestoreSnapshot({snapshotDirectory:f.snapshot,stagingParentDirectory:parent,logger}); }
  catch (error) { failure = error; }
  finally { await stage?.dispose(); }
  expect(failure).toMatchObject({code:"invalid-records"});
}),45000);

test("restore rejects a hash-consistent screening completion without its nominated full-read witness", async () => owned(async f => {
  const path = join(f.snapshot,"tables","run_context.json"), table = JSON.parse(await readFile(path,"utf8")) as {
    columns:string[];rows:{rowid:unknown;values:(string|{$integer:string}|null)[]}[];
  };
  const run = table.columns.indexOf("run_id"), ref = table.columns.indexOf("ref_id"), full = table.columns.indexOf("full_read");
  const row = table.rows.find(row => row.values[run] === f.runIds[1] && row.values[ref] === "candidate");
  if (!row) throw new Error("Missing owned full-read witness");
  row.values[full] = {$integer:"0"};
  const bytes = new TextEncoder().encode(`${JSON.stringify(table)}\n`); await writeFile(path,bytes,{mode:0o600});
  const manifestPath = join(f.snapshot,"manifest.json"), manifest = decodeManifest(await readFile(manifestPath));
  await writeFile(manifestPath,encodeManifest({...manifest,tables:manifest.tables.map(entry => entry.name === "run_context" ? {
    ...entry,byteLength:String(bytes.length),sha256:createHash("sha256").update(bytes).digest("hex"),
  } : entry)}),{mode:0o600});
  const parent = join(f.dir,"stage"); await mkdir(parent,{mode:0o700});
  await expect(stageRestoreSnapshot({snapshotDirectory:f.snapshot,stagingParentDirectory:parent,logger})).rejects.toMatchObject({code:"invalid-records"});
}),45000);
