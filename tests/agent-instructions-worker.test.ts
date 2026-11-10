import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import type { PublicClient } from "../src/agent/opencode-adapter";
import { SqliteAgentInstructions } from "../src/storage/agent-instructions";
import { SqliteAgenticExports } from "../src/storage/agentic-export";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { RunAdmissionService } from "../src/domain/run";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient, config, logger, now } from "./agentic-search-capability-fixture";

type Entry = Awaited<ReturnType<PublicClient["instructionList"]>>[number];
class InstructionClient extends ScriptedClient {
  readonly entries = new Map<string,Map<string,Entry["value"]>>();
  readonly writes: {sessionID:string;key:string;value:Entry["value"]}[] = [];
  readonly atPrompt: {sessionID:string;values:Entry["value"][]}[] = [];
  failWrites = false;
  override async instructionList(input: Parameters<PublicClient["instructionList"]>[0]): ReturnType<PublicClient["instructionList"]> {
    return [...(this.entries.get(input.sessionID) ?? new Map<string,Entry["value"]>()).entries()].map(([key,value]) => ({key,value}));
  }
  override async instructionPut(input: Parameters<PublicClient["instructionPut"]>[0]): Promise<void> {
    if (this.failWrites) throw new Error("test-owned instruction outage");
    this.writes.push(input);
    const entries = this.entries.get(input.sessionID) ?? new Map<string,Entry["value"]>();
    entries.set(input.key,input.value); this.entries.set(input.sessionID,entries);
  }
  override async instructionRemove(input: Parameters<PublicClient["instructionRemove"]>[0]): Promise<void> {
    if (this.failWrites) throw new Error("test-owned instruction outage");
    this.entries.get(input.sessionID)?.delete(input.key);
  }
  override async prompt(input: Parameters<PublicClient["prompt"]>[0]) {
    this.atPrompt.push({sessionID:input.sessionID,values:[...(this.entries.get(input.sessionID)?.values() ?? [])]});
    return super.prompt(input);
  }
}

async function fixture(action: (f: {
  db:Database; store:SqliteStore; settings:SqliteAgentInstructions; client:InstructionClient;
  worker:ConfiguredRunWorker; sources:{id:() => string;now:typeof now;logger:typeof logger;sessionId:() => string;promptId:() => string};
  restart:() => Promise<ConfiguredRunWorker>;
}) => Promise<void>, output: (index:number,input:string) => object): Promise<void> {
  const dir = mkdtempSync(join("/tmp/opencode","agent-instructions-worker-")), db = new Database(join(dir,"owned.sqlite"));
  let worker: ConfiguredRunWorker | undefined;
  try {
    migrate(db);
    let sequence = 0;
    const id = () => `fixture${String(++sequence).padStart(24,"0")}`;
    const sources = {id,now,logger,sessionId:() => `ses_${id()}`,promptId:() => `msg_${id()}`};
    const store = new SqliteStore(db), settings = new SqliteAgentInstructions(db,logger), client = new InstructionClient(output);
    const create = () => new ConfiguredRunWorker({db,...sources,config,resolve:async () => ({url:"http://127.0.0.1:44991"}),client:() => client});
    worker = create();
    const initial = worker;
    await action({db,store,settings,client,worker:initial,sources,restart:async () => {
      worker?.pause(); await worker?.drain(); worker = create(); return worker;
    }});
  } finally { worker?.pause(); await worker?.drain(); db.close(); rmSync(dir,{recursive:true,force:true}); }
}

function seed(store: SqliteStore): void {
  store.saveThought({id:"subject",text:"owned subject",title:null,titleAuthor:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
}
function state(db:Database, id:string): string {
  const run = db.query<{status:string},[string]>("SELECT status FROM runs WHERE id=?").get(id);
  if (!run) throw new Error("Missing test-owned run");
  return run.status;
}
async function until(worker:ConfiguredRunWorker, id:string, predicate:() => boolean): Promise<void> {
  for (let i=0;i<50 && !predicate();i++) await worker.tick(id);
  expect(predicate()).toBe(true);
}
const done = () => ({version:1,kind:"complete",reply:"owned reply"});

test("each run kind receives only its own saved guidance before its first native prompt", async () => fixture(async f => {
  seed(f.store);
  f.settings.save({weaver:"WEAVER-ONLY",evolve:"EVOLVE-ONLY",search:"SEARCH-ONLY",export:"EXPORT-ONLY",revision:0});
  const weave = new SqliteRunOperations(f.db,f.sources).admitWeave("user",{subjectId:"subject",triggerId:"owned-weave"});
  const evolve = new RunAdmissionService({repository:new SqliteRunRepository(f.db,f.sources),...f.sources}).admit("user","evolve",{parentId:"subject",text:"owned question"}).run;
  const exported = new SqliteAgenticExports(f.db,f.sources).admit("user",{request:"owned export"});
  const sessions = f.store.searchSessions(f.sources), session = sessions.create("user","owned-session",{}).session;
  const draft = sessions.openComposer("user",session.id);
  const search = sessions.admitTurn("user",session.id,"owned-turn",{text:"owned search",startingThoughtIds:[],requestClock:{at:now(),timeZone:"UTC"},composerId:draft.composerId,contextToken:draft.contextToken}).run;
  for (const [run,guidance,permission] of [[weave,"WEAVER-ONLY","allow"],[evolve,"EVOLVE-ONLY","allow"],[exported,"EXPORT-ONLY","deny"],[search,"SEARCH-ONLY","deny"]] as const) {
    await until(f.worker,run.id,() => f.client.prompts.some(prompt => f.client.sessions.get(prompt.sessionID)?.metadata.runId === run.id));
    const observed = f.client.atPrompt.find(item => f.client.sessions.get(item.sessionID)?.metadata.runId === run.id);
    expect(observed?.values).toEqual([guidance]);
    const sessionId = observed?.sessionID;
    expect(sessionId && f.client.sessions.get(sessionId)?.permissions).toEqual([{action:"*",resource:"*",effect:permission}]);
  }
}, (_index,input) => {
  const value = JSON.parse(input) as {context?:{job?:{kind?:string}}};
  return value.context?.job?.kind === "export" ? {version:1,kind:"report",markdown:"No findings",sourceThoughtIds:[]} :
    value.context?.job?.kind === "search" ? {version:1,kind:"search-reply",reply:"No findings",disposition:"done",sourceThoughtIds:[]} : done();
}));

test("queued work captures the latest settings at preparation and retains them across restart and capability subturns", async () => fixture(async f => {
  seed(f.store);
  const run = new SqliteRunOperations(f.db,f.sources).admitWeave("user",{subjectId:"subject",triggerId:"snapshot-test"});
  f.settings.save({weaver:"OLD",evolve:"",search:"",export:"",revision:0});
  const step = () => f.db.query<{input:string|null},[string]>("SELECT input FROM run_steps WHERE run_id=? AND position=0").get(run.id);
  await until(f.worker,run.id,() => step()?.input != null);
  const prepared = step()?.input;
  if (typeof prepared !== "string") throw new Error("Expected the durably prepared initial input");
  expect(f.client.prompts).toHaveLength(0);
  f.settings.save({weaver:"NEW",evolve:"",search:"",export:"",revision:1});
  const resumed = await f.restart();
  await until(resumed,run.id,() => f.client.prompts.length === 2);
  expect(step()?.input).toBe(prepared);
  expect(f.client.prompts[0]?.text).toBe(prepared);
  expect(f.client.atPrompt.map(item => item.values)).toEqual([["OLD"],["OLD"]]);
  const sessionId = f.client.prompts[0]?.sessionID;
  if (!sessionId) throw new Error("Expected the owned initial prompt session");
  expect(f.client.writes.filter(item => item.sessionID === sessionId)).toHaveLength(1);
  await until(resumed,run.id,() => state(f.db,run.id) === "completed");
  await resumed.tick(run.id);
  expect(f.client.prompts).toHaveLength(2);
}, index => index === 0 ? {version:1,kind:"request",request:{capability:"readThought",arguments:{id:"subject"}}} : done()));

test("failed instruction synchronization does not submit and retry uses the captured guidance", async () => fixture(async f => {
  seed(f.store);
  f.settings.save({weaver:"CAPTURED",evolve:"",search:"",export:"",revision:0});
  const run = new SqliteRunOperations(f.db,f.sources).admitWeave("user",{subjectId:"subject",triggerId:"instruction-failure"});
  f.client.failWrites = true;
  for (let i=0;i<12;i++) await f.worker.tick(run.id);
  expect(f.client.prompts).toHaveLength(0);
  f.settings.save({weaver:"LATER",evolve:"",search:"",export:"",revision:1});
  f.client.failWrites = false;
  await until(f.worker,run.id,() => f.client.prompts.length === 1);
  expect(f.client.atPrompt[0]?.values).toEqual(["CAPTURED"]);
  expect(f.client.writes).toHaveLength(1);
}, () => done()));

test("lost native admission acknowledgement is observed without rewriting guidance or submitting again", async () => fixture(async f => {
  seed(f.store);
  f.settings.save({weaver:"ONCE",evolve:"",search:"",export:"",revision:0});
  const run = new SqliteRunOperations(f.db,f.sources).admitWeave("user",{subjectId:"subject",triggerId:"lost-ack"});
  f.client.dropNextAck = true;
  await until(f.worker,run.id,() => f.client.prompts.length === 1);
  expect(f.client.atPrompt[0]?.values).toEqual(["ONCE"]);
  f.settings.save({weaver:"AFTER",evolve:"",search:"",export:"",revision:1});
  const resumed = await f.restart();
  await until(resumed,run.id,() => state(f.db,run.id) === "completed");
  expect(f.client.prompts).toHaveLength(1);
  expect(f.client.writes).toHaveLength(1);
  expect(f.client.atPrompt[0]?.values).toEqual(["ONCE"]);
}, () => done()));

test("a later turn in an existing saved Search conversation gets the current guidance in a fresh session", async () => fixture(async f => {
  f.settings.save({weaver:"",evolve:"",search:"FIRST",export:"",revision:0});
  const sessions = f.store.searchSessions(f.sources), session = sessions.create("user","saved-search",{}).session;
  function admit(key:string,text:string) {
    const draft = sessions.openComposer("user",session.id);
    return sessions.admitTurn("user",session.id,key,{text,startingThoughtIds:[],requestClock:{at:now(),timeZone:"UTC"},composerId:draft.composerId,contextToken:draft.contextToken}).run;
  }
  const first = admit("first","original question");
  await until(f.worker,first.id,() => state(f.db,first.id) === "completed");
  f.settings.save({weaver:"",evolve:"",search:"SECOND",export:"",revision:1});
  const second = admit("second","follow-up answer");
  await until(f.worker,second.id,() => state(f.db,second.id) === "completed");
  expect(f.client.atPrompt.map(item => item.values)).toEqual([["FIRST"],["SECOND"]]);
  expect(f.client.atPrompt[0]?.sessionID).not.toBe(f.client.atPrompt[1]?.sessionID);
  expect(f.client.prompts[1]?.text).toContain("original question");
  expect(f.client.prompts[1]?.text).toContain("owned clarification");
  for (const item of f.client.atPrompt) expect(f.client.sessions.get(item.sessionID)?.permissions).toEqual([{action:"*",resource:"*",effect:"deny"}]);
}, () => ({version:1,kind:"search-reply",reply:"owned clarification",disposition:"awaiting-user",sourceThoughtIds:[]})));
