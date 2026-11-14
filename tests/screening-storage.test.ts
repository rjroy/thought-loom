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
const policy = JSON.stringify({version:"connection-screening-1",threshold:0.6,judgeIdentity:"owned-judge-v1"});
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
    const current = shapesForSchema("thoughtloom-logical-5"), legacy = shapesForSchema("thoughtloom-logical-4");
    expect(current.filter(shape => !legacy.some(old => old.name === shape.name)).map(shape => shape.name))
      .toEqual(["run_screening_pairs","run_screening_passes"]);
    for (const old of legacy) expect(current.find(shape => shape.name === old.name)).toEqual(old);
    for (const old of current) {
      const actual = validateSourceSchema(db).find(shape => shape.name === old.name);
      expect(actual).toEqual(old.name === "run_screening_pairs" ? {...old,columns:[...old.columns,"excluded_connection_id"].sort()} : old);
    }
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

test("logical-7 adds only the explicit exclusion column while logical-6 remains frozen", () => {
  const old = shapesForSchema("thoughtloom-logical-6"), current = shapesForSchema("thoughtloom-logical-7");
  expect(current.map(shape => shape.name)).toEqual(old.map(shape => shape.name));
  for (const shape of old) expect(current.find(value => value.name === shape.name)).toEqual(shape.name === "run_screening_pairs"
    ? {...shape,columns:[...shape.columns,"excluded_connection_id"].sort()} : shape);
  const pair = current.find(shape => shape.name === "run_screening_pairs"); if (!pair) throw new Error("Missing pair shape");
  const bytes = encodeTable(pair,[]);
  expect(decodeTable(pair.name,bytes,"thoughtloom-logical-7")).toEqual([]);
  expect(() => decodeTable(pair.name,bytes,"thoughtloom-logical-6")).toThrow(BackupFormatError);
});

test("exclusion migration rolls back real additive DDL and preserves populated logical-6 history across reopen", () => {
  const dir = mkdtempSync(join("/tmp/opencode","screening-exclusion-migration-")), path = join(dir,"owned.sqlite"), db = new Database(path);
  try {
    migrate(db,logger); const f = setup(db);
    f.state.beginScreening(f.claim,"root",policy);
    for (const [id,score] of [["a",0.75],["b",0.1]] as const) { f.state.screeningPair(f.claim,"root",id); f.state.recordScreeningJudgment(f.claim,"root",id,score); }
    f.state.prepareInitial(f.claim,() => "fallback",() => "\uFEFFowned legacy input\r\n");
    // Install the predecessor's actual score-only table/guards, retaining the populated application rows.
    db.exec(`DROP TRIGGER screening_pass_update; DROP TRIGGER screening_pair_insert; DROP TRIGGER screening_pair_update;
      ALTER TABLE run_screening_pairs DROP COLUMN excluded_connection_id;
      CREATE TRIGGER screening_pass_update BEFORE UPDATE ON run_screening_passes
      WHEN NEW.run_id IS NOT OLD.run_id OR NEW.subject_id IS NOT OLD.subject_id OR NEW.policy_json IS NOT OLD.policy_json
        OR NEW.candidate_count IS NOT OLD.candidate_count OR OLD.status!='collecting' OR NEW.status='collecting'
        OR (NEW.status='complete' AND ((SELECT count(*) FROM run_screening_pairs WHERE run_id=OLD.run_id)!=OLD.candidate_count
          OR EXISTS(SELECT 1 FROM run_screening_pairs WHERE run_id=OLD.run_id AND judgment_json IS NULL)))
      BEGIN SELECT RAISE(ABORT,'screening identity or completion immutable'); END;
      CREATE TRIGGER screening_pair_insert BEFORE INSERT ON run_screening_pairs
      WHEN EXISTS(SELECT 1 FROM run_screening_pairs WHERE run_id=NEW.run_id AND candidate_id=NEW.candidate_id)
        OR NEW.judgment_json IS NOT NULL OR NOT EXISTS(SELECT 1 FROM run_screening_passes p JOIN thoughts t ON t.id=NEW.candidate_id
          WHERE p.run_id=NEW.run_id AND p.status='collecting' AND t.kind!='media-original' AND p.subject_id!=NEW.candidate_id
            AND NEW.position=COALESCE((SELECT max(position)+1 FROM run_screening_pairs WHERE run_id=p.run_id),0) AND NEW.position<p.candidate_count)
      BEGIN SELECT RAISE(ABORT,'invalid screening membership'); END;
      CREATE TRIGGER screening_pair_update BEFORE UPDATE ON run_screening_pairs
      WHEN NEW.run_id IS NOT OLD.run_id OR NEW.candidate_id IS NOT OLD.candidate_id OR NEW.position IS NOT OLD.position
        OR OLD.judgment_json IS NOT NULL OR NEW.judgment_json IS NULL
        OR NOT EXISTS(SELECT 1 FROM run_screening_passes WHERE run_id=OLD.run_id AND status='collecting')
      BEGIN SELECT RAISE(ABORT,'screening judgment immutable'); END;`);
    const schema = () => db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const history = (connection: Database) => shapesForSchema("thoughtloom-logical-6").map(shape => ({name:shape.name,
      rows:connection.query(`SELECT rowid,${shape.columns.map(name => `"${name}"`).join(",")} FROM "${shape.name}" ORDER BY rowid`).all()}));
    const beforeSchema = schema(), before = history(db); let injected = false;
    const failing = new Proxy(db,{get(target,key) {
      if (key === "exec") return (sql:string) => {
        const result = target.exec(sql);
        if (sql.startsWith("ALTER TABLE run_screening_pairs ADD COLUMN")) { injected = true; throw new Error("owned exclusion DDL fault"); }
        return result;
      };
      const member = Reflect.get(target,key,target); return typeof member === "function" ? member.bind(target) : member;
    }});
    expect(() => migrate(failing,logger)).toThrow("owned exclusion DDL fault"); expect(injected).toBe(true);
    expect(db.inTransaction).toBe(false); expect(schema()).toEqual(beforeSchema); expect(history(db)).toEqual(before);
    migrate(db,logger); expect(history(db)).toEqual(before);
    const reopened = new Database(path);
    try {
      migrate(reopened,logger); expect(history(reopened)).toEqual(before);
      expect(reopened.query("SELECT excluded_connection_id FROM run_screening_pairs").all()).toEqual([{excluded_connection_id:null},{excluded_connection_id:null}]);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => reopened.exec("UPDATE run_screening_pairs SET judgment_json='{\"score\":0.1}' WHERE candidate_id='a'")).toThrow();
    } finally { reopened.close(); }
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
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
  f.store.saveConnection({id:"after-prompt",fromId:"root",toId:"a",category:"related",proposedBy:"user",explanation:"Owned late edge",sourceIds:[]});
  expect(f.state.prepareInitial(f.claim,() => { throw new Error("Must not regenerate"); }).input).toBe(exact);
  expect(f.db.query("SELECT excluded_connection_id FROM run_screening_pairs WHERE candidate_id='a'").get()).toEqual({excluded_connection_id:null});
}));

test("connected skips retain the candidate universe and do not expose texts or stop remaining judgments", () => owned(f => {
  expect(f.state.beginScreening(f.claim,"root",policy)).toEqual(["a","b"]);
  f.store.saveConnection({id:"edge",fromId:"a",toId:"root",category:"supports",proposedBy:"user",explanation:"Owned relation",sourceIds:[]});
  expect(f.state.screeningPair(f.claim,"root","a")).toEqual({kind:"already-connected",connectionId:"edge"});
  expect(f.db.query("SELECT * FROM run_context").all()).toEqual([]);
  expect(f.state.beginScreening(f.claim,"root",policy)).toEqual(["b"]);
  f.state.screeningPair(f.claim,"root","b"); f.state.recordScreeningJudgment(f.claim,"root","b",0.8);
  f.state.prepareInitial(f.claim,() => "fallback",(_context,nominations) => {
    expect(nominations.map(thought => thought.id)).toEqual(["b"]); return "owned screened input";
  });
  expect(f.db.query("SELECT candidate_id,judgment_json,excluded_connection_id FROM run_screening_pairs ORDER BY position").all()).toEqual([
    {candidate_id:"a",judgment_json:null,excluded_connection_id:"edge"},{candidate_id:"b",judgment_json:'{"score":0.8}',excluded_connection_id:null},
  ]);
  expect(() => f.db.exec("UPDATE run_screening_pairs SET excluded_connection_id=NULL WHERE candidate_id='a'")).toThrow();
  expect(() => f.db.exec("DELETE FROM run_screening_pairs WHERE candidate_id='a'")).toThrow();
}));

test("a skipped pair becoming unconnected leaves preparation pending instead of falling back", () => owned(f => {
  f.state.beginScreening(f.claim,"root",policy);
  f.store.saveConnection({id:"edge",fromId:"root",toId:"a",category:"related",proposedBy:"ai",explanation:"Owned relation",sourceIds:[]});
  expect(f.state.screeningPair(f.claim,"root","a")).toMatchObject({kind:"already-connected"});
  f.state.screeningPair(f.claim,"root","b"); f.state.recordScreeningJudgment(f.claim,"root","b",0.8);
  new RejectionService(new SqliteRejectionRepository(f.db,logger)).rejectConnection("user","edge");
  expect(f.state.prepareInitial(f.claim,() => { throw new Error("Must not fall back"); },() => { throw new Error("Not ready"); }).input).toBeNull();
  expect(f.db.query("SELECT status,failure_code FROM run_screening_passes").get()).toEqual({status:"collecting",failure_code:null});
  expect(f.db.query("SELECT excluded_connection_id FROM run_screening_pairs WHERE candidate_id='a'").get()).toEqual({excluded_connection_id:null});
  const successor = f.runs.claim(f.run.id);
  expect(f.state.beginScreening(successor,"root",policy)).toEqual(["a"]);
  f.state.screeningPair(successor,"root","a"); f.state.recordScreeningJudgment(successor,"root","a",0.9);
  f.state.prepareInitial(successor,() => "fallback",(_context,nominations) => {
    expect(nominations.map(thought => thought.id)).toEqual(["a","b"]); return "owned complete input";
  });
}));

test("exclusions, genuine scores, nomination witnesses and exact input commit atomically", () => owned(f => {
  f.state.beginScreening(f.claim,"root",policy);
  for (const id of ["a","b"]) { f.state.screeningPair(f.claim,"root",id); f.state.recordScreeningJudgment(f.claim,"root",id,0.9); }
  f.store.saveConnection({id:"edge",fromId:"a",toId:"root",category:"contradicts",proposedBy:"user",explanation:"Owned concurrent relation",sourceIds:[]});
  const pairs = () => f.db.query("SELECT candidate_id,judgment_json,excluded_connection_id FROM run_screening_pairs ORDER BY position").all();
  const witnesses = () => f.db.query("SELECT ref_id,full_read FROM run_context ORDER BY ref_id").all();
  const beforePairs = pairs(), beforeWitnesses = witnesses();
  expect(() => f.state.prepareInitial(f.claim,() => "fallback",() => { throw new Error("owned exclusion render fault"); })).toThrow("owned exclusion render fault");
  expect(pairs()).toEqual(beforePairs); expect(witnesses()).toEqual(beforeWitnesses);
  expect(f.db.query("SELECT status FROM run_screening_passes").get()).toEqual({status:"collecting"});
  expect(f.db.query("SELECT input FROM run_steps").get()).toEqual({input:null});
  f.state.prepareInitial(f.claim,() => "fallback",(_context,nominations) => {
    expect(nominations.map(thought => thought.id)).toEqual(["b"]); return "owned exact exclusion input\r\n";
  });
  expect(pairs()).toEqual([{candidate_id:"a",judgment_json:'{"score":0.9}',excluded_connection_id:"edge"},
    {candidate_id:"b",judgment_json:'{"score":0.9}',excluded_connection_id:null}]);
  expect(witnesses()).toEqual([{ref_id:"a",full_read:0},{ref_id:"b",full_read:1},{ref_id:"edge",full_read:1},{ref_id:"root",full_read:1}]);
}));

test("exclusion guards reject a foreign pair or rejected edge without changing a real judgment", () => owned(f => {
  f.state.beginScreening(f.claim,"root",policy); f.state.screeningPair(f.claim,"root","a"); f.state.recordScreeningJudgment(f.claim,"root","a",0.8);
  f.store.saveConnection({id:"foreign",fromId:"a",toId:"b",category:"related",proposedBy:"user",explanation:"Owned unrelated edge",sourceIds:[]});
  f.store.saveConnection({id:"rejected",fromId:"root",toId:"a",category:"related",proposedBy:"user",explanation:"Owned rejected edge",sourceIds:[]});
  new RejectionService(new SqliteRejectionRepository(f.db,logger)).rejectConnection("user","rejected");
  for (const id of ["foreign","rejected","missing"]) expect(() => f.db.run("UPDATE run_screening_pairs SET excluded_connection_id=? WHERE candidate_id='a'",[id])).toThrow();
  expect(f.db.query("SELECT judgment_json,excluded_connection_id FROM run_screening_pairs WHERE candidate_id='a'").get()).toEqual({judgment_json:'{"score":0.8}',excluded_connection_id:null});
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
