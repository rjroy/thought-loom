import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../src/daemon/app";
import type { CapabilityRequest, CapabilityResult } from "../src/domain/capability";
import { CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import { RunConflictError, RunFenceError, RunForbiddenError, RunService, type NativeDispatcher } from "../src/domain/run";
import { protocolJson } from "../src/domain/run-protocol";
import { TitleService } from "../src/domain/title";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteTitleRepository } from "../src/storage/title";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { readSqlSnapshot, validateBytes } from "../src/backup/records";
import { captureBackup } from "../src/backup/capture";
import { recoverRestoreStage, restoreBackup, stageRestoreSnapshot } from "../src/backup/restore-staging";
import { encodeTable, type RawRow } from "../src/backup/format";
import { decodeTable } from "../src/backup/decode";
import { shapesForSchema, type BackupAppSchema } from "../src/backup/schema";
import { createLogger } from "../src/logging";

const now = () => "2031-01-01T00:00:00Z";
const native: NativeDispatcher = {submit:async () => {},observe:async () => "running"};
const credentials = {user:"owned-user-token",ai:"owned-ai-token"};
type Proposal = Extract<CapabilityRequest,{capability:"connection"}>;
const proposal = (fromId = "a",toId = "b",category: Proposal["arguments"]["category"] = "supports"): Proposal =>
  ({capability:"connection",arguments:{fromId,toId,category,explanation:"Owned proposed explanation",sourceIds:[]}});
const read = (id:string): CapabilityRequest => ({capability:"readThought",arguments:{id}});

async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join("/tmp/opencode","connection-dedup-"));
  const db = new Database(join(dir,"owned.sqlite")), other = new Database(join(dir,"owned.sqlite"));
  try { migrate(db); migrate(other); await action(setup(db,other)); }
  finally { other.close(); db.close(); rmSync(dir,{recursive:true,force:true}); }
}
function setup(db: Database, other: Database) {
  let seq = 0;
  const id = () => `owned-${++seq}`, sources = {id,now}, store = new SqliteStore(db);
  for (const name of ["a","b","source"]) store.saveThought({id:name,text:`Owned thought ${name}`,title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const rejection = new RejectionService(new SqliteRejectionRepository(db));
  const creation = new CreationService({rejection,id,now,writes:{createThought:thought => store.saveThought(thought),createConnection:connection => store.saveConnection(connection)}});
  const app = createApp({rejection,creation,titles:new TitleService(new SqliteTitleRepository(db)),credentials,logger:() => {}});
  const manual = async (input:Proposal["arguments"]) => {
    const response = await app.request("/connections",{method:"POST",headers:{authorization:`Bearer ${credentials.user}`,"content-type":"application/json"},body:JSON.stringify(input)});
    expect(response.status).toBe(201);
    return await response.json() as {id:string;proposedBy:string};
  };
  function start(connection:Database, subject:"a" | "b" | "evolve") {
    const runs = new SqliteRunRepository(connection,sources), ops = new SqliteRunOperations(connection,sources), steps = new SqliteRunProtocolRepository(connection);
    const service = new RunService({...sources,repository:runs,dispatcher:native});
    const admission = subject === "evolve" ? service.admit("user","evolve",{parentId:"a",text:"Owned contribution"}) : null;
    const run = admission?.run ?? ops.admitWeave("user",{subjectId:subject,triggerId:`owned-${id()}`});
    const claim = runs.claim(run.id), dispatcher = new SqliteCapabilityDispatcher(connection,sources);
    steps.prepare(claim,{promptId:run.promptId,input:"Owned initial context"});
    let promptId = run.promptId;
    const complete = (request:CapabilityRequest) => steps.completeStep(claim,promptId,{version:1,kind:"request",request});
    const dispatch = (request:CapabilityRequest) => dispatcher.dispatch(claim,promptId,request);
    const invoke = (request:CapabilityRequest): CapabilityResult => {
      complete(request); const result = dispatch(request);
      const next = {promptId:`step-${id()}`,input:JSON.stringify(result)};
      steps.advance(claim,promptId,result,next); promptId = next.promptId; return result;
    };
    return {claim,run,contribution:admission?.contribution,complete,dispatch,invoke,current:() => promptId,dispatcher,ops,steps};
  }
  const rows = () => db.query<{id:string;from_id:string;to_id:string;category:string;proposed_by:string},[]>("SELECT id,from_id,to_id,category,proposed_by FROM connections ORDER BY rowid").all();
  return {db,other,store,rejection,manual,start,rows};
}
function record(value:unknown): Record<string,unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a structured capability result");
  return Object.fromEntries(Object.entries(value));
}
function outcome(result:unknown): string {
  const data = record(result);
  return [data.status,data.outcome,data.disposition].filter((value): value is string => typeof value === "string").join(" ");
}
function expectNotCreated(result:unknown): void {
  const data = record(result);
  expect(data.created === false || /already|present|exist|unchanged|duplicate|not.?created|unavailable|suppressed|blocked|no.?op/i.test(outcome(result))).toBe(true);
}

test("AI duplicate of a manual relation reuses its identity and attribution with an explicit already-present outcome", async () => fixture(async f => {
  const existing = await f.manual({...proposal().arguments,explanation:"Owned original user explanation"});
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b"));
  run.complete(proposal());
  const result = run.dispatch(proposal());
  expect(f.rows()).toHaveLength(1);
  expect(JSON.stringify(result)).toContain(existing.id);
  expect(JSON.stringify(result)).not.toContain('"proposedBy":"ai"');
  expectNotCreated(result);
  expect(result).toMatchObject({type:"connection",status:"already-present",connection:{id:existing.id,proposedBy:"user",explanation:"Owned original user explanation"}});
  expect(f.rows()[0]).toMatchObject({id:existing.id,proposed_by:"user"});
}));

test("duplicate capability receipt replay remains unchanged after another deliberate manual connection", async () => fixture(async f => {
  const existing = await f.manual(proposal().arguments);
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal());
  const first = run.dispatch(proposal()), prompt = run.current();
  const secondManual = await f.manual(proposal().arguments);
  expect(secondManual.id).not.toBe(existing.id);
  expect(run.dispatch(proposal())).toEqual(first);
  expect(JSON.stringify(run.ops.stepReceipt(run.run.id,prompt)?.result)).toBe(JSON.stringify(first));
  expect(f.rows().map(row => row.id)).toEqual([existing.id,secondManual.id]);
  expect(JSON.stringify(first)).toContain(existing.id);
}));

test("different categories and reverse directions remain distinct while users can deliberately add duplicates", async () => fixture(async f => {
  const first = await f.manual(proposal().arguments), second = await f.manual(proposal().arguments);
  expect(first.id).not.toBe(second.id);
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b"));
  const reversed = run.invoke(proposal("b","a","supports"));
  const different = run.invoke(proposal("a","b","contradicts"));
  expect(reversed).toMatchObject({type:"connection",connection:{fromId:"b",toId:"a",category:"supports",proposedBy:"ai"}});
  expect(different).toMatchObject({type:"connection",connection:{fromId:"a",toId:"b",category:"contradicts",proposedBy:"ai"}});
  expect(f.rows()).toHaveLength(4);
}));

test("rejected matching relation is neither exposed nor cloned and its opaque result replays", async () => fixture(async f => {
  const hidden = await f.manual({...proposal().arguments,explanation:"PRIVATE REJECTED EXPLANATION"});
  f.rejection.rejectConnection("user",hidden.id);
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal());
  const result = run.dispatch(proposal());
  expect(f.rows()).toHaveLength(1);
  const output = JSON.stringify(result);
  expect(output).not.toContain(hidden.id);
  expect(output).not.toContain("PRIVATE REJECTED EXPLANATION");
  expectNotCreated(result);
  f.rejection.restoreConnection("user",hidden.id);
  expect(run.dispatch(proposal())).toEqual(result);
  expect(JSON.stringify(run.ops.stepReceipt(run.run.id,run.current())?.result)).toBe(JSON.stringify(result));
}));

test.each([false,true])("no-op receipt failure rolls back atomically and a retry keeps the existing relation (rejected %s)", async rejected => fixture(async f => {
  const existing = await f.manual(proposal().arguments);
  if (rejected) f.rejection.rejectConnection("user",existing.id);
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal());
  f.db.exec("CREATE TRIGGER owned_receipt_fault BEFORE INSERT ON run_operation_receipts BEGIN SELECT RAISE(ABORT,'owned receipt failure'); END");
  try {
    expect(() => run.dispatch(proposal())).toThrow(/owned receipt failure/);
    expect(f.rows().map(row => row.id)).toEqual([existing.id]);
    expect(run.ops.stepReceipt(run.run.id,run.current())).toBeNull();
    expect(f.db.query("SELECT result_json FROM run_steps WHERE run_id=? AND prompt_id=?").get(run.run.id,run.current())).toEqual({result_json:null});
    expect(f.db.query("SELECT 1 FROM run_context WHERE run_id=? AND kind='connection'").get(run.run.id)).toBeNull();
  } finally { f.db.exec("DROP TRIGGER owned_receipt_fault"); }
  const result = run.dispatch(proposal());
  expect(f.rows().map(row => row.id)).toEqual([existing.id]);
  if (rejected) expect(result).toEqual({type:"connection",status:"not-created"});
  else expect(result).toMatchObject({type:"connection",status:"already-present",connection:{id:existing.id}});
  expect(run.dispatch(proposal())).toEqual(result);
}));

test("matching connection cannot bypass full endpoint and source witnesses", async () => fixture(async f => {
  await f.manual(proposal().arguments);
  const run = f.start(f.db,"a"); run.invoke(read("a"));
  const request = {...proposal(),arguments:{...proposal().arguments,sourceIds:["source"]}};
  run.complete(request);
  expect(() => run.dispatch(request)).toThrow(RunForbiddenError);
  expect(() => run.ops.executeStep(run.claim,run.current(),{type:"connection",...request.arguments})).toThrow(RunForbiddenError);
  expect(run.ops.stepReceipt(run.run.id,run.current())).toBeNull();
  expect(f.rows()).toHaveLength(1);
}));

test.each([false,true])("duplicate lookup cannot bypass a missing supporting-source full read (rejected match %s)", async rejected => fixture(async f => {
  const existing = await f.manual(proposal().arguments);
  if (rejected) f.rejection.rejectConnection("user",existing.id);
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b"));
  const request = {...proposal(),arguments:{...proposal().arguments,sourceIds:["source"]}};
  run.complete(request);
  expect(() => run.dispatch(request)).toThrow(RunForbiddenError);
  expect(() => run.ops.executeStep(run.claim,run.current(),{type:"connection",...request.arguments})).toThrow(RunForbiddenError);
  expect(run.ops.stepReceipt(run.run.id,run.current())).toBeNull();
  expect(f.rows().map(row => row.id)).toEqual([existing.id]);
}));

test("a rejected match suppresses lookup identity even when another matching relation is visible", async () => fixture(async f => {
  const hidden = await f.manual({...proposal().arguments,explanation:"OWNED HIDDEN EXPLANATION",sourceIds:["source"]});
  const visible = await f.manual(proposal().arguments);
  f.rejection.rejectConnection("user",hidden.id);
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal());
  const result = run.dispatch(proposal());
  expect(result).toEqual({type:"connection",status:"not-created"});
  for (const secret of [hidden.id,visible.id,"OWNED HIDDEN EXPLANATION","source"]) expect(JSON.stringify(result)).not.toContain(secret);
  expect(f.rows().map(row => row.id)).toEqual([hidden.id,visible.id]);
}));

test("already-present receipt exposure fences replay after relation or returned provenance rejection", async () => {
  for (const target of ["connection","source"] as const) await fixture(async f => {
    const existing = await f.manual({...proposal().arguments,sourceIds:["source"]});
    const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal());
    const result = run.dispatch(proposal());
    expect(result).toMatchObject({type:"connection",status:"already-present",connection:{id:existing.id,proposedBy:"user",sourceIds:["source"]}});
    if (target === "connection") f.rejection.rejectConnection("user",existing.id);
    else f.rejection.rejectThought("user","source");
    expect(() => run.dispatch(proposal())).toThrow(RunFenceError);
    expect(f.rows().map(row => row.id)).toEqual([existing.id]);
  });
});

test("already-present returns only scoped provenance and replay never enriches it after restoration", async () => fixture(async f => {
  const existing = await f.manual({...proposal().arguments,sourceIds:["source","source"]});
  f.rejection.rejectThought("user","source");
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal());
  const result = run.dispatch(proposal());
  expect(result).toMatchObject({type:"connection",status:"already-present",connection:{id:existing.id,sourceIds:[]}});
  expect(JSON.stringify(result)).not.toContain('"source"');
  f.rejection.restoreThought("user","source");
  expect(run.dispatch(proposal())).toEqual(result);
  expect(f.store.getConnection(existing.id)?.sourceIds).toEqual(["source","source"]);
  const exact = new Database(f.db.filename,{readonly:true,create:false,safeIntegers:true});
  try { expect(() => validateBytes(readSqlSnapshot(exact,() => {}))).not.toThrow(); }
  finally { exact.close(); }
}));

test.each(["unknown-status","opaque-with-identity","wrong-key","false-created","missing-record"] as const)("typed connection receipt refuses %s", async fault => fixture(async f => {
  const existing = await f.manual(proposal().arguments), connection = f.store.getConnection(existing.id);
  if (!connection) throw new Error("Missing owned connection");
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal());
  const result = fault === "opaque-with-identity" ? {type:"connection",status:"not-created",connection} :
    {type:"connection",status:fault === "unknown-status" ? "invented-status" : fault === "false-created" ? "created" : "already-present",
      connection:{...connection,...(fault === "wrong-key" ? {category:"contradicts"} : fault === "missing-record" ? {id:"missing-connection"} : {})}};
  f.db.run("INSERT INTO run_operation_receipts(run_id,operation_id,operation_json,thought_id,result_json,format) VALUES (?,?,?,NULL,?,'step')",
    [run.run.id,run.current(),protocolJson({type:"connection",...proposal().arguments}),protocolJson(result)]);
  expect(() => run.ops.stepReceipt(run.run.id,run.current())).toThrow(RunConflictError);
  expect(() => run.dispatch(proposal())).toThrow(RunConflictError);
  expect(() => run.steps.advance(run.claim,run.current(),result,{promptId:"invalid-successor",input:"Owned successor"})).toThrow(RunConflictError);
  const exact = new Database(f.db.filename,{readonly:true,create:false,safeIntegers:true});
  try { expect(() => validateBytes(readSqlSnapshot(exact,() => {}))).toThrow(); }
  finally { exact.close(); }
  expect(f.rows().map(row => row.id)).toEqual([existing.id]);
}));

test("legacy created connection receipt remains byte-shape compatible without inventing a status", async () => fixture(async f => {
  const connection = {id:"owned-legacy-link",...proposal().arguments,proposedBy:"ai" as const};
  f.store.saveConnection(connection);
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal());
  const legacy = {type:"connection" as const,connection};
  const json = protocolJson(legacy);
  f.db.run("INSERT INTO run_operation_receipts(run_id,operation_id,operation_json,thought_id,result_json,format) VALUES (?,?,?,NULL,?,'step')",
    [run.run.id,run.current(),protocolJson({type:"connection",...proposal().arguments}),json]);
  expect(run.ops.stepReceipt(run.run.id,run.current())?.result).toEqual(legacy);
  expect(run.dispatch(proposal())).toEqual(legacy);
  expect(f.db.query("SELECT result_json FROM run_operation_receipts WHERE run_id=? AND operation_id=?").get(run.run.id,run.current())).toEqual({result_json:json});
  expect(f.rows().map(row => row.id)).toEqual([connection.id]);
}));

test("connection creation retains exact explanation bytes for its durable receipt", async () => fixture(async f => {
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b"));
  const request = {...proposal(),arguments:{...proposal().arguments,explanation:"\uFEFF Owned exact explanation\r\n"}};
  run.complete(request); const result = run.dispatch(request);
  const connection = f.store.getConnection(f.rows()[0]?.id ?? "missing");
  expect(connection?.explanation).toBe(request.arguments.explanation);
  expect(run.dispatch(request)).toEqual(result);
}));

test("backup connection receipts require their exact dispatched result and full-read/exposure witnesses", async () => fixture(async f => {
  const existing = await f.manual({...proposal().arguments,sourceIds:["source"]});
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b")); run.invoke(read("source"));
  const request = {...proposal(),arguments:{...proposal().arguments,sourceIds:["source"]}};
  run.complete(request); run.dispatch(request);
  const exact = new Database(f.db.filename,{readonly:true,create:false,safeIntegers:true});
  try {
    const snapshot = readSqlSnapshot(exact,() => {}); expect(() => validateBytes(snapshot)).not.toThrow();
    const alter = (name: string, change: (rows: readonly RawRow[]) => readonly RawRow[]) => ({...snapshot,
      tables:snapshot.tables.map(table => table.shape.name === name ? {...table,rows:change(table.rows)} : table)});
    const value = (row: RawRow,column: string,text: string): RawRow => ({...row,values:{...row.values,[column]:{storage:"text",bytes:new TextEncoder().encode(text)}}});
    expect(() => validateBytes(alter("run_steps",rows => rows.map(row => {
      const prompt = row.values.prompt_id;
      return prompt?.storage === "text" && new TextDecoder().decode(prompt.bytes) === run.current()
        ? value(row,"result_json",protocolJson({type:"connection",status:"not-created"})) : row;
    })))).toThrow();
    expect(() => validateBytes(alter("run_context",rows => rows.map(row => {
      const ref = row.values.ref_id;
      return ref?.storage === "text" && new TextDecoder().decode(ref.bytes) === "source"
        ? {...row,values:{...row.values,full_read:{storage:"integer",value:0n}}} : row;
    })))).toThrow();
    expect(() => validateBytes(alter("run_context",rows => rows.filter(row => {
      const ref = row.values.ref_id;
      return !(ref?.storage === "text" && new TextDecoder().decode(ref.bytes) === existing.id);
    })))).toThrow();
  } finally { exact.close(); }
}));

test("connection no-op and historical receipts survive canonical codecs, capture, recovery and installation byte-exactly", async () => fixture(async f => {
  await f.manual({...proposal().arguments,sourceIds:["source"]});
  const hiddenRequest = proposal("b","a","contradicts"), hidden = await f.manual(hiddenRequest.arguments);
  f.rejection.rejectConnection("user",hidden.id);
  const run = f.start(f.db,"a"); run.invoke(read("a")); run.invoke(read("b"));
  expect(run.invoke(proposal())).toMatchObject({type:"connection",status:"already-present"});
  expect(run.invoke(hiddenRequest)).toEqual({type:"connection",status:"not-created"});
  f.rejection.restoreConnection("user",hidden.id); // Opaque history must not be reinterpreted during backup.
  expect(run.invoke(proposal("a","b","related"))).toMatchObject({type:"connection",status:"created"});
  const legacyRequest = {...proposal("a","b","extends"),arguments:{...proposal("a","b","extends").arguments,explanation:"\uFEFFOwned historical explanation"}};
  const historicalConnection = {id:"old-bom-link",...legacyRequest.arguments,explanation:"Owned historical explanation",proposedBy:"ai" as const};
  f.store.saveConnection(historicalConnection);
  const legacy = f.start(f.db,"b"); legacy.invoke(read("a")); legacy.invoke(read("b")); legacy.complete(legacyRequest);
  const oldResult = {type:"connection" as const,connection:{...historicalConnection,explanation:legacyRequest.arguments.explanation}};
  f.db.run("INSERT INTO run_operation_receipts(run_id,operation_id,operation_json,thought_id,result_json,format) VALUES (?,?,?,NULL,?,'step')",
    [legacy.run.id,legacy.current(),protocolJson({type:"connection",...legacyRequest.arguments}),protocolJson(oldResult)]);
  expect(legacy.dispatch(legacyRequest)).toEqual(oldResult);
  const original = () => f.db.query("SELECT run_id,operation_id,result_json FROM run_operation_receipts ORDER BY run_id,operation_id").all();
  const saved = original(), exact = new Database(f.db.filename,{readonly:true,create:false,safeIntegers:true});
  try {
    const snapshot = readSqlSnapshot(exact,() => {}); validateBytes(snapshot);
    const receipts = snapshot.tables.find(table => table.shape.name === "run_operation_receipts");
    if (!receipts) throw new Error("Missing receipts");
    for (const schema of ["thoughtloom-logical-1","thoughtloom-logical-2","thoughtloom-logical-3","thoughtloom-logical-4","thoughtloom-logical-5"] satisfies BackupAppSchema[]) {
      const shape = shapesForSchema(schema).find(shape => shape.name === receipts.shape.name);
      if (!shape) throw new Error("Missing frozen receipt inventory");
      expect(decodeTable(shape.name,encodeTable(shape,receipts.rows),schema)).toEqual(receipts.rows);
    }
  } finally { exact.close(); }
  const parent = dirname(f.db.filename), output = join(parent,"capture"), stageParent = join(parent,"stage");
  chmodSync(f.db.filename,0o600); f.db.exec("PRAGMA journal_mode=WAL;"); mkdirSync(output,{mode:0o700}); mkdirSync(stageParent,{mode:0o700});
  const logger = createLogger("verbose",() => {}), snapshot = await captureBackup({databasePath:f.db.filename,mediaDirectory:`${f.db.filename}.media`,outputDirectory:output,logger});
  const stage = await stageRestoreSnapshot({snapshotDirectory:snapshot.snapshotDirectory,stagingParentDirectory:stageParent,logger});
  const verify = (path: string): void => {
    const db = new Database(path,{readonly:true,create:false});
    try { expect(db.query("SELECT run_id,operation_id,result_json FROM run_operation_receipts ORDER BY run_id,operation_id").all()).toEqual(saved); }
    finally { db.close(); }
  };
  try { verify(stage.databasePath); await recoverRestoreStage(stage,{restoredAt:"2032-01-01T00:00:00.000Z",logger}); verify(stage.databasePath); }
  finally { await stage.dispose(); }
  const installed = await restoreBackup({snapshotDirectory:snapshot.snapshotDirectory,targetDirectory:join(parent,"target"),restoredAt:"2032-01-01T00:00:00.000Z",logger});
  verify(installed.databasePath);
  expect(original()).toEqual(saved);
}));

test("independent database connections serialize two staged AI proposals into one relation", async () => fixture(async f => {
  const first = f.start(f.db,"a"), second = f.start(f.other,"b");
  for (const run of [first,second]) { run.invoke(read("a")); run.invoke(read("b")); run.complete(proposal()); }
  const created = first.dispatch(proposal()), duplicate = second.dispatch(proposal());
  expect(f.rows()).toHaveLength(1);
  const id = f.rows()[0]?.id;
  expect(id).toBeDefined();
  expect(JSON.stringify(created)).toContain(id ?? "missing");
  expect(JSON.stringify(duplicate)).toContain(id ?? "missing");
  expectNotCreated(duplicate);
}));

test("Evolve connection proposal observes the same duplicate rule", async () => fixture(async f => {
  const run = f.start(f.db,"evolve");
  const contribution = run.contribution;
  if (!contribution) throw new Error("Expected owned contribution");
  const request = proposal(contribution.id,"b"), existing = await f.manual(request.arguments);
  run.invoke(read(contribution.id)); run.invoke(read("b")); run.complete(request);
  const result = run.dispatch(request);
  expect(f.rows()).toHaveLength(1);
  expect(JSON.stringify(result)).toContain(existing.id);
  expectNotCreated(result);
}));
