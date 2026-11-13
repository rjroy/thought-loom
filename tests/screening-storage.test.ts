import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { shapesForSchema, validateSourceSchema } from "../src/backup/schema";
import { decodeManifest, decodeTable } from "../src/backup/decode";
import { BackupFormatError, encodeManifest, encodeTable } from "../src/backup/format";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunRepository } from "../src/storage/run";
import { screeningPolicy, screeningJudgment, parseScreeningJudgment } from "../src/domain/connection-screening";
import { RunFenceError } from "../src/domain/run";
import { createLogger } from "../src/logging";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { readSqlSnapshot, validateBytes } from "../src/backup/records";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const logger = createLogger("verbose",() => {});
const policy = screeningPolicy("owned-judge-v1");
function owned(action: (f: ReturnType<typeof setup>) => void): void {
  const db = new Database(":memory:");
  try { migrate(db,logger); action(setup(db)); } finally { db.close(); }
}
function setup(db: Database) {
  let n=0;
  const sources = {id:() => `owned-${++n}`,now:() => "2030",logger};
  const store = new SqliteStore(db);
  for (const id of ["root","a","b"]) store.saveThought({id,text:`owned ${id}`,title:null,author:"user",kind:"captured-original",createdAt:"2030",origin:"fixture",parentId:null,sourceIds:[]});
  const ops = new SqliteRunOperations(db,sources), runs = new SqliteRunRepository(db,sources);
  const run = ops.admitWeave("user",{subjectId:"root",triggerId:"owned-screen"}), claim = runs.claim(run.id);
  const state = new SqliteRunWorkerState(db,sources);
  return {db,sources,store,ops,runs,run,claim,state};
}

test("screening storage is additive and logical-5 does not change the frozen logical-4 inventory", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const current = validateSourceSchema(db), legacy = shapesForSchema("thoughtloom-logical-4");
    expect(current.filter(shape => !legacy.some(old => old.name === shape.name)).map(shape => shape.name))
      .toEqual(["run_screening_pairs","run_screening_passes"]);
    for (const old of legacy) expect(current.find(shape => shape.name === old.name)).toEqual(old);
    migrate(db);
    expect(db.query("SELECT * FROM run_screening_passes").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("logical-5 codecs require progress tables while logical-4 refuses their mixed inventory", () => {
  const current = shapesForSchema("thoughtloom-logical-5"), legacy = shapesForSchema("thoughtloom-logical-4");
  const common = {mediaStoreId:null,mediaMarker:null,originals:[],sequences:[]};
  const entries = (shapes: typeof current) => shapes.map(shape => ({name:shape.name,path:`tables/${shape.name}.json`,rowCount:"0",byteLength:"1",sha256:"a".repeat(64)}));
  const manifest = {...common,appSchema:"thoughtloom-logical-5" as const,tables:entries(current)};
  expect(decodeManifest(encodeManifest(manifest))).toEqual(manifest);
  expect(() => encodeManifest({...manifest,tables:entries(legacy)})).toThrow(BackupFormatError);
  expect(() => encodeManifest({...manifest,appSchema:"thoughtloom-logical-4"})).toThrow(BackupFormatError);
  const pairs = current.find(shape => shape.name === "run_screening_pairs");
  if (!pairs) throw new Error("Missing screening inventory");
  const bytes = encodeTable(pairs,[]);
  expect(decodeTable(pairs.name,bytes,"thoughtloom-logical-5")).toEqual([]);
  expect(() => decodeTable(pairs.name,bytes,"thoughtloom-logical-4")).toThrow(BackupFormatError);
});

test("screening judgments survive claim changes while incompatible unfinished policy becomes sticky fallback", () => owned(f => {
  expect(f.state.beginScreening(f.claim,"root",policy)).toEqual(["a","b"]);
  f.state.screeningPair(f.claim,"root","a"); f.state.recordScreeningJudgment(f.claim,"root","a",0.75);
  const successor = f.runs.claim(f.run.id);
  expect(successor.generation).toBeGreaterThan(f.claim.generation);
  expect(f.state.beginScreening(successor,"root",policy)).toEqual(["b"]);
  expect(() => f.state.recordScreeningJudgment(f.claim,"root","b",1)).toThrow(RunFenceError);
  expect(f.state.beginScreening(successor,"root",screeningPolicy("owned-judge-v2"))).toEqual([]);
  expect(f.db.query("SELECT status,failure_code,policy_json FROM run_screening_passes").get())
    .toEqual({status:"fallback",failure_code:"configuration-changed",policy_json:policy});
  expect(f.state.beginScreening(successor,"root",policy)).toEqual([]);
  expect(f.db.query("SELECT judgment_json FROM run_screening_pairs ORDER BY position").all()).toEqual([{judgment_json:'{"score":0.75}'},{judgment_json:null}]);
}));

test("screening consumption, full reads and exact initial prompt roll back together", () => owned(f => {
  f.state.beginScreening(f.claim,"root",policy);
  for (const [id,score] of [["a",0.6],["b",0.599]] as const) {
    f.state.screeningPair(f.claim,"root",id); f.state.recordScreeningJudgment(f.claim,"root",id,score);
  }
  const witnesses = () => f.db.query("SELECT ref_id,full_read FROM run_context ORDER BY ref_id").all();
  expect(witnesses()).toEqual([{ref_id:"a",full_read:0},{ref_id:"b",full_read:0},{ref_id:"root",full_read:0}]);
  expect(() => f.state.prepareInitial(f.claim,() => "fallback",() => { throw new Error("owned renderer fault"); })).toThrow("owned renderer fault");
  expect(f.db.query("SELECT status FROM run_screening_passes").get()).toEqual({status:"collecting"});
  expect(f.db.query("SELECT input FROM run_steps").get()).toEqual({input:null});
  expect(witnesses()).toEqual([{ref_id:"a",full_read:0},{ref_id:"b",full_read:0},{ref_id:"root",full_read:0}]);
  const exact = "\uFEFF exact owned prompt\r\n";
  const step = f.state.prepareInitial(f.claim,() => "fallback",(_context,nominations) => {
    expect(nominations.map(thought => thought.id)).toEqual(["a"]); return exact;
  });
  expect(step.input).toBe(exact);
  expect(f.db.query("SELECT status FROM run_screening_passes").get()).toEqual({status:"complete"});
  expect(() => f.db.exec("UPDATE run_screening_passes SET status='fallback',failure_code='screening-unavailable'")).toThrow();
  expect(witnesses()).toEqual([{ref_id:"a",full_read:1},{ref_id:"b",full_read:0},{ref_id:"root",full_read:1}]);
  expect(f.state.prepareInitial(f.claim,() => { throw new Error("Must not regenerate"); }).input).toBe(exact);
}));

test("screening candidates stay frozen and eligibility drift produces durable fallback", () => owned(f => {
  f.state.beginScreening(f.claim,"root",policy);
  f.store.saveThought({id:"late",text:"new owned thought",title:null,author:"user",kind:"captured-original",createdAt:"2030",origin:"fixture",parentId:null,sourceIds:[]});
  expect(f.state.beginScreening(f.claim,"root",policy)).toEqual([]);
  expect(f.db.query("SELECT candidate_id FROM run_screening_pairs ORDER BY position").all()).toEqual([{candidate_id:"a"},{candidate_id:"b"}]);
  expect(f.db.query("SELECT status,failure_code FROM run_screening_passes").get()).toEqual({status:"fallback",failure_code:"eligibility-changed"});
}));

test("removing screening configuration during collection selects durable fallback", () => owned(f => {
  f.state.beginScreening(f.claim,"root",policy);
  expect(f.state.beginScreening(f.claim,"root",null)).toEqual([]);
  expect(f.db.query("SELECT status,failure_code FROM run_screening_passes").get()).toEqual({status:"fallback",failure_code:"configuration-changed"});
  expect(f.state.beginScreening(f.claim,"root",policy)).toEqual([]);
}));

test("Stop, reject-restore and restore fences reject late screening commits", () => {
  for (const reason of ["stop","reject-restore","restore"] as const) owned(f => {
    f.state.beginScreening(f.claim,"root",policy); f.state.screeningPair(f.claim,"root","a");
    if (reason === "stop") f.runs.stop(f.run.id);
    if (reason === "reject-restore") {
      const rejection = new RejectionService(new SqliteRejectionRepository(f.db,logger));
      rejection.rejectThought("user","a"); rejection.restoreThought("user","a");
      expect(f.runs.get(f.run.id)?.status).toBe("interrupted");
    }
    if (reason === "restore") f.db.run(`INSERT INTO restore_fences(entity_kind,entity_id,snapshot_sha256,restored_at,original_state_json)
      VALUES ('run',?,?,?,'{}')`,[f.run.id,"a".repeat(64),"2031"]);
    expect(() => f.state.recordScreeningJudgment(f.claim,"root","a",1)).toThrow(RunFenceError);
    expect(() => f.state.screeningPair(f.claim,"root","b")).toThrow(RunFenceError);
    expect(f.db.query("SELECT judgment_json FROM run_screening_pairs WHERE candidate_id='a'").get()).toEqual({judgment_json:null});
  });
});

test("screening JSON is canonical finite probability history and immutable after completion", () => owned(f => {
  f.state.beginScreening(f.claim,"root",policy); f.state.screeningPair(f.claim,"root","a");
  for (const score of [NaN,Infinity,-Infinity,-0.1,1.1]) expect(() => screeningJudgment(score)).toThrow();
  for (const json of ['{"score":0.70}','{"score":null}','{"score":0.7,"extra":1}','{"score":1e999}']) expect(() => parseScreeningJudgment(json)).toThrow();
  f.state.recordScreeningJudgment(f.claim,"root","a",0.7);
  expect(() => f.db.exec("UPDATE run_screening_passes SET policy_json='{}'")).toThrow();
  expect(() => f.db.exec("UPDATE run_screening_pairs SET judgment_json='{\"score\":0.9}' WHERE candidate_id='a'")).toThrow();
  expect(() => f.db.exec("UPDATE run_screening_passes SET status='complete'")).toThrow();
  expect(() => f.db.exec("DELETE FROM run_screening_pairs")).toThrow();
}));

test("backup refuses noncanonical judgment JSON even when SQLite accepts its numeric value", () => {
  const dir = mkdtempSync(join("/tmp/opencode","screening-codec-")), path = join(dir,"owned.sqlite");
  const writer = new Database(path);
  try {
    migrate(writer,logger); const f = setup(writer);
    f.state.beginScreening(f.claim,"root",policy); f.state.screeningPair(f.claim,"root","a");
    writer.run("UPDATE run_screening_pairs SET judgment_json=? WHERE candidate_id='a'",['{"score":0.70}']);
    const exact = new Database(path,{readonly:true,create:false,safeIntegers:true});
    try { expect(() => validateBytes(readSqlSnapshot(exact,() => {}))).toThrow(); }
    finally { exact.close(); }
  } finally { writer.close(); rmSync(dir,{recursive:true,force:true}); }
});
