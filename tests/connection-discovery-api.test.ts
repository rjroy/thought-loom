import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { resolveWeavePurpose } from "../src/domain/weave-scheduling";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunRepository } from "../src/storage/run";
import { RunAdmissionService, RunConflictError, RunFenceError } from "../src/domain/run";
import { RunWorker, type ScreeningPair } from "../src/agent/worker";
import { OpenCodeAdapter } from "../src/agent/opencode-adapter";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { pathBinding } from "./fixtures/media-path-worker";

const user = "owned-user-01234567890123456789012345";
const ai = "owned-agent-0123456789012345678901234";
type Case = {route:"contributions" | "developments"; token:string; kind:"user-contribution" | "developing-idea"; author:"user" | "ai"};
const cases: readonly Case[] = [
  {route:"contributions",token:user,kind:"user-contribution",author:"user"},
  {route:"developments",token:ai,kind:"developing-idea",author:"ai"},
];

async function fixture(action: (f:{db:Database;daemon:RunningDaemon}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join("/tmp/opencode","discovery-api-"));
  let daemon: RunningDaemon | undefined, db: Database | undefined;
  try {
    const path = join(dir,"owned.sqlite"), seed = new Database(path);
    try {
      migrate(seed);
      new SqliteStore(seed).saveThought({id:"parent",text:"Owned parent thought",title:null,author:"user",kind:"captured-original",
        createdAt:"2031-01-01T00:00:00Z",origin:"fixture",parentId:null,sourceIds:[]});
    } finally { seed.close(); }
    daemon = await startDaemon({port:0,dbPath:path,credentials:{user,ai}},() => {},{logSink:() => {}});
    db = new Database(path);
    await action({db,daemon});
  } finally {
    try { db?.close(); }
    finally { try { await daemon?.stop(); } finally { await rm(dir,{recursive:true,force:true}); } }
  }
}
async function create(daemon: RunningDaemon, item: Case, text: string): Promise<Response> {
  return fetch(new URL(`/thoughts/parent/${item.route}`,daemon.url),{method:"POST",headers:{authorization:`Bearer ${item.token}`,"content-type":"application/json"},
    body:JSON.stringify({text}),signal:AbortSignal.timeout(2000)});
}
type Row = {id:string;triggerId:string;status:string};
function owners(db:Database, subjectId:string): Row[] {
  return db.query<Row,[string]>("SELECT id,weave_trigger_id AS triggerId,status FROM runs WHERE kind='weave' AND weave_subject_id=? ORDER BY rowid").all(subjectId);
}

test.each(cases)("direct $route HTTP creation atomically queues one connection-only discovery owner", async item => fixture(async ({db,daemon}) => {
  const response = await create(daemon,item,`Owned ${item.route} text`);
  expect(response.status).toBe(201);
  const thought = await response.json() as {id:string;kind:string;parentId:string;author:string};
  expect(thought).toMatchObject({kind:item.kind,parentId:"parent",author:item.author});
  const runs = owners(db,thought.id);
  expect(runs).toHaveLength(1);
  const owner = runs[0];
  if (!owner) throw new Error("Expected discovery owner");
  expect(owner.status).toBe("queued");
  expect(owner.triggerId).toBe(`connection-discovery-direct:${thought.id}`);
  expect(resolveWeavePurpose(item.kind,owner.triggerId)).toBe("connection-only");
  expect(db.query("SELECT kind FROM runs WHERE kind!='weave'").all()).toEqual([]);
  expect(db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id=?").get(thought.id)?.n).toBe(0);
  expect(owners(db,thought.id)).toEqual(runs);
  const sources = {id:() => { throw new Error("Replay must not allocate identities"); },now:() => { throw new Error("Replay must not allocate a timestamp"); }};
  new SqliteRunRepository(db,sources).stop(owner.id);
  const reopened = new Database(db.filename);
  try {
    const replay = new SqliteRunOperations(reopened,sources).admitWeave("user",{subjectId:thought.id,triggerId:owner.triggerId});
    expect(replay.id).toBe(owner.id); expect(replay.status).toBe("interrupted");
    expect(owners(reopened,thought.id)).toHaveLength(1);
  } finally { reopened.close(); }
}));

test.each(cases)("direct $route discovery screens its text and finishes without recursive thoughts or public replies", async item => fixture(async ({db,daemon}) => {
  const response = await create(daemon,item,`Owned screened ${item.route}`);
  expect(response.status).toBe(201);
  const thought = await response.json() as {id:string}, owner = owners(db,thought.id)[0];
  if (!owner) throw new Error("Expected discovery owner");
  const pairs: ScreeningPair[] = [], client = new ScriptedClient(() => ({version:1,kind:"complete",reply:"No useful connection"}));
  let sequence=0;
  const worker = new RunWorker({db,id:() => `owned-direct-${++sequence}`,now:() => "2031",bindingFor:run => pathBinding(run,"/tmp/opencode/owned-direct"),
    connectionScreening:{identity:"owned-direct-judge",async judge(pair) { pairs.push(pair); return 0.6; }},
    native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings))});
  const runs = new SqliteRunRepository(db,{id:() => "unused",now:() => "2031"});
  try {
    for (let i=0;i<12 && runs.get(owner.id)?.status !== "completed";i++) await worker.tick(owner.id);
    expect(runs.get(owner.id)?.status).toBe("completed");
    expect(pairs.map(pair => [pair.thoughtA.id,pair.thoughtB.id])).toEqual([[thought.id,"parent"]]);
    const prompt = JSON.parse(client.prompts[0]?.text ?? "null") as {context:{job:{purpose:string}};nominations:{id:string}[]};
    expect(prompt.context.job.purpose).toBe("connection-only"); expect(prompt.nominations.map(item => item.id)).toEqual(["parent"]);
    expect(runs.reply(owner.id)).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({n:2});
    expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual({n:1});
    expect(db.query("SELECT count(*) AS n FROM responses").get()).toEqual({n:0});
  } finally { worker.pause(); await worker.drain(); }
}));

test("direct discovery rejects fabricated source identity and cannot backfill historical or run-owned sources", async () => fixture(async ({db}) => {
  let sequence=0; const sources = {id:() => `owned-origin-${++sequence}`,now:() => "2031"};
  const ops = new SqliteRunOperations(db,sources), runs = new SqliteRunRepository(db,sources);
  expect(() => ops.admitWeave("user",{subjectId:"parent",triggerId:"connection-discovery-direct:parent"})).toThrow(RunConflictError);
  const admission = new RunAdmissionService({...sources,repository:runs}).admit("user","evolve",{parentId:"parent",text:"Owned run-created source"});
  if (!admission.contribution) throw new Error("Expected contribution");
  const sourceId = admission.contribution.id;
  expect(() => ops.admitWeave("user",{subjectId:sourceId,triggerId:`connection-discovery-direct:${sourceId}`})).toThrow(RunConflictError);
  new SqliteStore(db).saveThought({id:"historical",text:"Owned historical direct source",title:null,author:"user",kind:"user-contribution",createdAt:"2031",origin:"contribution",parentId:"parent",sourceIds:[]});
  expect(() => ops.admitWeave("user",{subjectId:"historical",triggerId:"connection-discovery-direct:historical"})).toThrow(RunFenceError);
  expect(owners(db,"historical")).toEqual([]);
}));

test("Evolve Stop preserves independently admitted direct discovery", async () => fixture(async ({db,daemon}) => {
  const response = await create(daemon,cases[0],"Owned independent direct source");
  expect(response.status).toBe(201); const direct = await response.json() as {id:string};
  const directOwner = owners(db,direct.id)[0]; if (!directOwner) throw new Error("Expected direct owner");
  let sequence=0; const sources = {id:() => `owned-stop-${++sequence}`,now:() => "2031"};
  const runs = new SqliteRunRepository(db,sources), admission = new RunAdmissionService({...sources,repository:runs}).admit("user","evolve",{parentId:direct.id,text:"Owned subsequent Evolve contribution"});
  if (!admission.contribution) throw new Error("Expected contribution");
  const relatedOwner = owners(db,admission.contribution.id)[0]; if (!relatedOwner) throw new Error("Expected related owner");
  runs.stop(admission.run.id);
  expect(runs.get(relatedOwner.id)?.status).toBe("interrupted");
  expect(runs.get(directOwner.id)?.status).toBe("queued");
}));

test.each(cases)("direct $route rolls back the thought when discovery admission fails", async item => fixture(async ({db,daemon}) => {
  db.exec(`CREATE TRIGGER owned_discovery_fault BEFORE INSERT ON runs WHEN NEW.kind='weave' AND NEW.weave_subject_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'owned admission fault'); END`);
  const text = `Owned rollback ${item.route}`;
  try {
    const response = await create(daemon,item,text);
    expect(response.status).toBe(500);
    await response.text();
    expect(db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM thoughts WHERE text=?").get(text)?.n).toBe(0);
    expect(db.query<{n:number},[]>("SELECT COUNT(*) AS n FROM runs").get()?.n).toBe(0);
  } finally { db.exec("DROP TRIGGER owned_discovery_fault"); }
  // A retry is deliberate only after this owned fixture proves the failed transaction rolled back.
  const retry = await create(daemon,item,text);
  expect(retry.status).toBe(201);
  const thought = await retry.json() as {id:string};
  expect(owners(db,thought.id)).toHaveLength(1);
  expect(db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM thoughts WHERE text=?").get(text)?.n).toBe(1);
}));
