import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon, type RuntimeDependencies } from "../src/daemon/runtime";
import { TitleService } from "../src/domain/title";
import { SqliteTitleRepository } from "../src/storage/title";
import { ExecutionOwnerHeldError, ExecutionOwnerLease } from "../src/storage/execution-owner";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient, config as agent } from "./agentic-search-capability-fixture";

const credentials = {user:"owned-user-01234567890123456789012345",ai:"owned-agent-0123456789012345678901234"};
const reviewComplete = {version:1,kind:"review-complete",titleCheck:"complete",connectionCheck:"complete"};
const initialTime = "2031-01-01T12:00:00.000Z";
type Review = {runId:string;thoughtId:string;completedAt:string|null;status:string};

async function fixture(options: {configured:boolean;unavailable?:boolean;count?:number;script?:(index:number,input:string) => object;client?:ScriptedClient},
  action:(f:{path:string;clock:{now:string};client:ScriptedClient;calls:{resolve:number;clients:number};read:<T>(fn:(db:Database) => T) => T;pulse:() => void;stop:() => Promise<void>}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join("/tmp/opencode","daily-runtime-")), path = join(dir,"owned.sqlite");
  const clock = {now:initialTime};
  let daemon: RunningDaemon | undefined, callback: (() => void) | undefined;
  const client = options.client ?? new ScriptedClient(options.script ?? (() => reviewComplete));
  const calls = {resolve:0,clients:0};
  try {
    const db = new Database(path);
    try {
      migrate(db);
      const store = new SqliteStore(db);
      for (let i=0;i<(options.count ?? 1);i++) store.saveThought({id:`subject-${i}`,text:`Owned text ${i}`,title:null,titleAuthor:null,
        author:"user",kind:"captured-original",createdAt:"2030-01-01T00:00:00.000Z",origin:"fixture",parentId:null,sourceIds:[]});
    } finally { db.close(); }
    const deps: RuntimeDependencies = {now:() => clock.now,logSink:() => {},
      resolveAgentService:async () => { calls.resolve++; if (options.unavailable) throw new Error("owned unavailable"); return {url:"http://127.0.0.1:44991"}; },
      createPublicClient:() => { calls.clients++; return client; },startTimer:poll => { callback = poll; return () => {}; }};
    daemon = await startDaemon({dbPath:path,port:0,credentials,...(options.configured ? {agent} : {})},() => {},deps);
    const read = <T>(fn:(db:Database) => T): T => { const db = new Database(path); try { return fn(db); } finally { db.close(); } };
    await action({path,clock,client,calls,read,pulse:() => { if (!callback) throw new Error("Expected the owned polling callback"); callback(); },
      stop:async () => { if (daemon) { await daemon.stop(); daemon = undefined; } }});
  } finally { try { await daemon?.stop(); } finally { await rm(dir,{recursive:true,force:true}); } }
}
function batches(read:<T>(fn:(db:Database) => T) => T): string[] {
  return read(db => db.query<{date:string},[]>("SELECT review_date AS date FROM daily_review_batches ORDER BY review_date").all().map(row => row.date));
}
function reviews(read:<T>(fn:(db:Database) => T) => T): Review[] {
  return read(db => db.query<Review,[]>(`SELECT i.run_id AS runId,i.thought_id AS thoughtId,i.completed_at AS completedAt,r.status
    FROM daily_review_items i JOIN runs r ON r.id=i.run_id ORDER BY i.review_date,i.position`).all());
}
async function until(predicate:() => boolean, pulse?:() => void): Promise<boolean> {
  for (let i=0;i<200;i++) { if (predicate()) return true; pulse?.(); await Bun.sleep(1); }
  return predicate();
}

test("configured daemon boot admits a daily review without waiting for its first timer pulse", async () => fixture({configured:true,unavailable:true},async f => {
  await until(() => batches(f.read).length > 0);
  expect(batches(f.read)).toEqual(["2031-01-01"]);
  expect(reviews(f.read)).toEqual([expect.objectContaining({thoughtId:"subject-0",status:"queued",completedAt:null})]);
  expect(f.client.prompts).toEqual([]);
}));

test("unconfigured daemon never reserves a daily batch or constructs a native client", async () => fixture({configured:false},async f => {
  for (let i=0;i<10;i++) { f.pulse(); await Bun.sleep(1); }
  expect(batches(f.read)).toEqual([]);
  expect(reviews(f.read)).toEqual([]);
  expect(f.client.prompts).toEqual([]);
  expect(f.calls).toEqual({resolve:0,clients:0});
}));

test("unavailable agent preserves today's queued identities across polls and admits only a later current UTC date", async () => fixture({configured:true,unavailable:true,count:3},async f => {
  await until(() => batches(f.read).length > 0,f.pulse);
  expect(batches(f.read)).toEqual(["2031-01-01"]);
  const first = reviews(f.read);
  expect(first).toHaveLength(1);
  for (let i=0;i<12;i++) { f.pulse(); await Bun.sleep(1); }
  expect(reviews(f.read)).toEqual(first);
  f.clock.now = "2031-01-04T12:00:00.000Z";
  await until(() => batches(f.read).length === 2,f.pulse);
  expect(batches(f.read)).toEqual(["2031-01-01","2031-01-04"]);
  const later = reviews(f.read);
  expect(later).toHaveLength(2);
  expect(later[0]).toEqual(first[0]);
  expect(later[1]?.runId).not.toBe(first[0]?.runId);
  f.clock.now = "2031-01-03T12:00:00.000Z";
  for (let i=0;i<12;i++) { f.pulse(); await Bun.sleep(1); }
  expect(batches(f.read)).toEqual(["2031-01-01","2031-01-04"]);
  expect(reviews(f.read)).toEqual(later);
}));

test("real runtime review completes with the shared clock while a concurrent user title wins", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const client = new ScriptedClient((index,input) => {
  if (index === 0) {
    const prompt = JSON.parse(input) as {context:{job:{purpose:string}}};
    expect(prompt.context.job.purpose).toBe("daily-review");
    return {version:1,kind:"request",request:{capability:"title-fill",arguments:{title:"Late AI label"}}};
  }
  return reviewComplete;
  });
  let held = true;
  client.beforePrompt = async () => { if (held) { held = false; entered.resolve(); await release.promise; } };
  await fixture({configured:true,client},async f => {
    try {
      let active = false; void entered.promise.then(() => { active = true; });
      await until(() => active,f.pulse);
      expect(active).toBe(true);
      f.read(db => new TitleService(new SqliteTitleRepository(db)).setUser("user","subject-0","User title"));
      f.clock.now = "2031-01-01T13:00:00.000Z";
      release.resolve();
      await until(() => reviews(f.read)[0]?.status === "completed",f.pulse);
      expect(reviews(f.read)).toEqual([expect.objectContaining({thoughtId:"subject-0",status:"completed",completedAt:f.clock.now})]);
      expect(f.read(db => new SqliteStore(db).getThought("subject-0"))).toMatchObject({text:"Owned text 0",title:"User title",titleAuthor:"user",parentId:null});
      expect(f.read(db => db.query("SELECT * FROM responses").all())).toEqual([]);
      expect(f.read(db => db.query("SELECT * FROM run_issued_thoughts").all())).toEqual([]);
      expect(f.client.scriptErrors).toEqual([]);
    } finally { release.resolve(); }
  });
});

test("daemon shutdown joins a held daily prompt and seals stale timer callbacks", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const client = new ScriptedClient(() => reviewComplete);
  client.beforePrompt = async () => { entered.resolve(); await release.promise; };
  await fixture({configured:true,client},async f => {
  let stopping: Promise<void> | undefined;
  try {
    let active = false; void entered.promise.then(() => { active = true; });
    await until(() => active,f.pulse);
    expect(active).toBe(true);
    let stopped = false;
    stopping = f.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(false);
    let competing: ExecutionOwnerLease | undefined, contention: unknown;
    try { competing = await ExecutionOwnerLease.acquire(f.path); } catch (error) { contention = error; }
    finally { competing?.release(); }
    expect(contention).toBeInstanceOf(ExecutionOwnerHeldError);
    f.pulse(); release.resolve(); await stopping;
    const available = await ExecutionOwnerLease.acquire(f.path);
    available.release();
    const saved = reviews(f.read);
    f.clock.now = "2031-01-02T12:00:00.000Z";
    f.pulse(); await Promise.resolve();
    expect(reviews(f.read)).toEqual(saved);
    expect(batches(f.read)).toEqual(["2031-01-01"]);
    expect(f.client.prompts.length).toBeLessThanOrEqual(1);
  } finally { release.resolve(); if (stopping) await stopping; }
  });
});
