import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OpenCodeAdapter } from "../src/agent/opencode-adapter";
import { RunWorker, type ConnectionScreeningPort } from "../src/agent/worker";
import { SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { bounded } from "./fixtures/media-files";
import { pathBinding, pathComplete } from "./fixtures/media-path-worker";
import { dailyReviewFixture, reviewComplete, type DailyReviewFixture } from "./fixtures/daily-review";

function makeWorker(f: DailyReviewFixture, client: ScriptedClient, screening: ConnectionScreeningPort, db = f.db) {
  return new RunWorker({db,...f.sources,connectionScreening:screening,bindingFor:run => pathBinding(run,f.dir),
    native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings),f.sources.logger)});
}

async function finish(w: RunWorker, f: DailyReviewFixture, id: string) {
  for (let i=0;i<64 && f.run(id).status !== "completed";i++) await w.tick(id);
  expect(f.run(id).status).toBe("completed");
}

function subjectWithOwner(f: DailyReviewFixture) {
  f.seed("root");
  new SqliteStore(f.db,f.sources).saveThought({id:"a",text:"Owned contribution",title:null,titleAuthor:null,author:"user",kind:"user-contribution",origin:"contribution",createdAt:"2029-01-01T00:00:00Z",parentId:"root",sourceIds:[]});
  const owner = f.db.query<{id:string},[]>("SELECT id FROM runs WHERE weave_subject_id='a'").get();
  if (!owner) throw new Error("Expected creation owner");
  return owner.id;
}

test.each(["creation", "daily"] as const)("%s screening excludes visible connections in either direction and screens remaining pairs", async purpose => dailyReviewFixture(async f => {
  const owner = subjectWithOwner(f);
  for (const id of ["linked-1","linked-2","linked-3","linked-4","unlinked","negative","hidden-edge","rejected-thought"]) f.seed(id);
  const edges = [
    {id:"edge-1",fromId:"a",toId:"linked-1",category:"related",proposedBy:"user"},
    {id:"edge-2",fromId:"linked-2",toId:"a",category:"supports",proposedBy:"user"},
    {id:"edge-3",fromId:"a",toId:"linked-3",category:"contradicts",proposedBy:"ai"},
    {id:"edge-4",fromId:"linked-4",toId:"a",category:"extends",proposedBy:"ai"},
  ] as const;
  for (const edge of edges) f.store.saveConnection({...edge,explanation:"Owned existing relation",sourceIds:[]});
  f.store.saveConnection({id:"secret-edge-id",fromId:"a",toId:"hidden-edge",category:"related",proposedBy:"user",explanation:"SECRET REJECTED RELATION",sourceIds:[]});
  f.rejection.rejectConnection("user","secret-edge-id");
  f.rejection.rejectThought("user","rejected-thought");
  let id = owner;
  if (purpose === "daily") {
    f.runs.stop(owner); f.state.settleUnsubmitted(owner);
    const batch = f.admit();
    if (batch.kind !== "admitted" || !batch.runIds[0]) throw new Error("Expected daily review");
    id = batch.runIds[0];
    expect(f.ops.weaveIntent(id)?.subjectId).toBe("a");
  }
  const calls:string[] = [], client = new ScriptedClient(() => purpose === "daily" ? reviewComplete : pathComplete("No findings"));
  const w = makeWorker(f,client,{identity:"owned-exclusion",async judge(pair) { calls.push(pair.thoughtB.id); return pair.thoughtB.id === "negative" ? 0.1 : 0.9; }});
  try {
    await finish(w,f,id);
    const input = client.prompts[0]?.text ?? "";
    const prompt = JSON.parse(input) as {nominations:{id:string}[]};
    expect(calls.toSorted()).toEqual(["hidden-edge","negative","root","unlinked"]);
    expect(prompt.nominations.map(item => item.id).toSorted()).toEqual(["hidden-edge","root","unlinked"]);
    expect(input).not.toContain("SECRET REJECTED RELATION");
    expect(input).not.toContain("secret-edge-id");
    expect(input).not.toContain("rejected-thought");
    expect(JSON.stringify(prompt.nominations)).not.toMatch(/probability|score|noul/i);
  } finally { w.pause(); await w.drain(); }
}));

test("a connection created during screening suppresses the in-flight nomination without fallback", async () => dailyReviewFixture(async f => {
  const id = subjectWithOwner(f); f.seed("candidate");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const client = new ScriptedClient(() => pathComplete("No findings"));
  const w = makeWorker(f,client,{identity:"owned-live-race",async judge(pair) {
    if (pair.thoughtB.id === "candidate") { entered.resolve(); await release.promise; }
    return 0.9;
  }});
  const flight = w.tick(id);
  try {
    await bounded(entered.promise,"held candidate judgment");
    f.store.saveConnection({id:"concurrent-edge",fromId:"candidate",toId:"a",category:"supports",proposedBy:"user",explanation:"Concurrent owned link",sourceIds:[]});
    release.resolve(); await flight; await finish(w,f,id);
    const prompt = JSON.parse(client.prompts[0]?.text ?? "null") as {nominations?:{id:string}[];instructions:string[]};
    expect(prompt.nominations?.map(item => item.id)).toEqual(["root"]);
    expect(prompt.instructions.join(" ")).toContain("Continue searching beyond");
  } finally { release.resolve(); await flight; w.pause(); await w.drain(); }
}));

test("a connection created during a held judgment is not nominated or rejudged after reopening", async () => dailyReviewFixture(async f => {
  const id = subjectWithOwner(f); f.seed("candidate");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const calls:string[] = [], firstClient = new ScriptedClient(() => pathComplete("No findings"));
  const first = makeWorker(f,firstClient,{identity:"owned-race",async judge(pair) {
    calls.push(pair.thoughtB.id);
    if (pair.thoughtB.id === "candidate") { entered.resolve(); await release.promise; }
    return 0.9;
  }});
  const flight = first.tick(id);
  try {
    await bounded(entered.promise,"held candidate judgment");
    f.store.saveConnection({id:"concurrent-edge",fromId:"candidate",toId:"a",category:"supports",proposedBy:"user",explanation:"Concurrent owned link",sourceIds:[]});
    first.pause(); release.resolve(); await flight; await first.drain();
    const reopened = new Database(f.path), client = new ScriptedClient(() => pathComplete("No findings")), resumedCalls:string[] = [];
    const resumed = makeWorker(f,client,{identity:"owned-race",async judge(pair) { resumedCalls.push(pair.thoughtB.id); return 0.9; }},reopened);
    try {
      await finish(resumed,f,id);
      expect(calls.filter(value => value === "candidate")).toHaveLength(1);
      expect(resumedCalls).not.toContain("candidate");
      const prompt = JSON.parse(client.prompts[0]?.text ?? "null") as {nominations?:{id:string}[];instructions:string[]};
      expect(prompt.nominations?.map(item => item.id)).toEqual(["root"]);
      expect(prompt.instructions.join(" ")).toContain("Continue searching beyond");
    } finally { resumed.pause(); await resumed.drain(); reopened.close(); }
  } finally { release.resolve(); await flight; first.pause(); await first.drain(); }
}));
