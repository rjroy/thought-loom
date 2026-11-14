import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OpenCodeAdapter } from "../src/agent/opencode-adapter";
import { RunWorker, type ConnectionScreeningPort } from "../src/agent/worker";
import { RunAdmissionService, RunFenceError, RunForbiddenError } from "../src/domain/run";
import { protocolJson } from "../src/domain/run-protocol";
import { screeningPolicy } from "../src/domain/connection-screening";
import { SqliteDailyReviews } from "../src/storage/daily-review";
import { SqliteStore } from "../src/storage/sqlite";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { SqliteReinterpretations } from "../src/storage/reinterpretation";
import { createLogger, type LogRecord } from "../src/logging";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { pathBinding } from "./fixtures/media-path-worker";
import { dailyReviewFixture, reviewComplete, reviewPolicy, type DailyReviewFixture } from "./fixtures/daily-review";

function admit(f: DailyReviewFixture): string {
  const batch = f.admit(); if (batch.kind !== "admitted" || !batch.runIds[0]) throw new Error("Expected owned review");
  return batch.runIds[0];
}
function worker(f: DailyReviewFixture, client: ScriptedClient, connectionScreening?: ConnectionScreeningPort, db = f.db) {
  return new RunWorker({db,...f.sources,connectionScreening,bindingFor:run => pathBinding(run,f.dir),
    native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings),f.sources.logger)});
}
async function until(w: RunWorker, id: string, predicate: () => boolean) {
  for (let i=0;i<64 && !predicate();i++) await w.tick(id);
  expect(predicate()).toBe(true);
}

test("successful no-change review persists across reopen without public output or immutable mutations", async () => dailyReviewFixture(f => {
  f.seed("subject"); const before = f.store.getThought("subject"), id = admit(f), claim = f.prepare(id);
  expect(() => f.steps.completeStep(claim,f.run(id).promptId,{version:1,kind:"complete",reply:"not both checks"})).toThrow(RunForbiddenError);
  expect(f.reviews.lastReviewedAt("subject")).toBeNull();
  f.clock.now = "2031-01-02T00:00:01.000Z"; f.complete(claim);
  expect(f.run(id).status).toBe("completed"); expect(f.store.getThought("subject")).toEqual(before);
  expect(f.runs.reply(id)).toBeNull(); expect(f.db.query("SELECT * FROM responses").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM run_issued_thoughts").all()).toEqual([]);
  expect(f.db.query("SELECT review_date,completed_at FROM daily_review_items").get()).toEqual({review_date:"2031-01-01",completed_at:f.clock.now});
  const reader = new Database(f.path);
  try { expect(new SqliteDailyReviews(reader,f.sources,reviewPolicy).lastReviewedAt("subject")).toBe(f.clock.now); }
  finally { reader.close(); }
}));
test("completion stamp and run completion roll back together", async () => dailyReviewFixture(f => {
  f.seed("subject"); const id = admit(f), claim = f.prepare(id), promptId = f.run(id).promptId;
  f.steps.completeStep(claim,promptId,reviewComplete);
  f.db.exec(`CREATE TRIGGER owned_completion_fault BEFORE UPDATE ON daily_review_items BEGIN SELECT RAISE(ABORT,'owned stamp fault'); END;`);
  expect(() => f.state.finish(claim,promptId)).toThrow();
  expect(f.run(id).status).toBe("uncertain"); expect(f.reviews.lastReviewedAt("subject")).toBeNull();
  f.db.exec("DROP TRIGGER owned_completion_fault"); f.state.finish(claim,promptId);
  expect(f.run(id).status).toBe("completed"); expect(f.reviews.lastReviewedAt("subject")).toBe(f.clock.now);
}));
test("a concurrent user title wins, and successor prompts keep the two-check protocol", async () => dailyReviewFixture(f => {
  f.seed("subject"); const id = admit(f), claim = f.prepare(id), original = f.store.getThought("subject");
  if (!original) throw new Error("Expected owned subject");
  f.titles.setUser("user","subject","My current title");
  expect(f.invoke(claim,{capability:"title-fill",arguments:{title:"Late AI label"}})).toEqual({type:"title-fill",status:"unchanged"});
  const input = f.steps.steps(id).at(-1)?.input ?? "";
  expect(input).toContain("review-complete"); expect(input).toContain("titleCheck"); expect(input).toContain("connectionCheck");
  f.complete(claim);
  expect(f.store.getThought("subject")).toEqual({...original,title:"My current title",titleAuthor:"user"});
}));
test("saved title/connection effects survive later failure without recording review success", async () => dailyReviewFixture(f => {
  f.seed("a"); f.seed("b"); const id = admit(f), claim = f.prepare(id);
  expect(f.invoke(claim,{capability:"title-fill",arguments:{title:"Owned generated label"}})).toEqual({type:"title-fill",status:"filled"});
  f.invoke(claim,{capability:"readThought",arguments:{id:"b"}});
  const connection = {capability:"connection",arguments:{fromId:"a",toId:"b",category:"supports",explanation:"Owned warranted relation",sourceIds:[]}} as const;
  expect(f.invoke(claim,connection)).toMatchObject({type:"connection",status:"created"});
  expect(f.invoke(claim,connection)).toMatchObject({type:"connection",status:"already-present"});
  f.ops.fail(claim);
  expect(f.store.getThought("a")?.title).toBe("Owned generated label");
  expect(f.db.query("SELECT id FROM connections").all()).toHaveLength(1);
  expect(f.reviews.lastReviewedAt("a")).toBeNull(); expect(f.run(id).status).toBe("failed");
  expect(f.runs.reply(id)).toBeNull();
}));
test("daily writes cannot escape their fixed subject, publish thoughts or bypass through legacy operations", async () => dailyReviewFixture(f => {
  for (const name of ["a","b","c"]) f.seed(name);
  const id = admit(f), claim = f.prepare(id);
  f.invoke(claim,{capability:"readThought",arguments:{id:"b"}}); f.invoke(claim,{capability:"readThought",arguments:{id:"c"}});
  const promptId = f.run(id).promptId;
  const operation = {type:"connection",fromId:"b",toId:"c",category:"related",explanation:"Owned but wrong subject",sourceIds:[]} as const;
  f.steps.completeStep(claim,promptId,{version:1,kind:"request",request:{capability:"connection",arguments:{fromId:"b",toId:"c",category:"related",explanation:operation.explanation,sourceIds:[]}}});
  expect(() => f.ops.executeStep(claim,promptId,operation)).toThrow(RunForbiddenError);
  expect(() => f.runs.commit(claim,{id:"legacy",type:"development",parentId:"a",text:"Forbidden",sourceIds:[]})).toThrow(RunForbiddenError);
  expect(() => f.runs.recordPartial(claim,{id:"draft",text:"Forbidden reply",role:"fallback",thoughtIds:["a"]})).toThrow(RunForbiddenError);
  expect(f.db.query("SELECT * FROM connections").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM run_operation_receipts").all()).toEqual([]);
}));
test("a retained forbidden receipt/result cannot be replayed, advanced or completed", async () => dailyReviewFixture(f => {
  f.seed("a"); const id = admit(f), claim = f.prepare(id), promptId = f.run(id).promptId;
  const operation = {type:"interpretation",text:"Forbidden interpretation",sourceIds:[]} as const;
  const req = {capability:"interpretation",arguments:{text:operation.text,sourceIds:[]}} as const;
  f.steps.completeStep(claim,promptId,{version:1,kind:"request",request:req});
  const thought = {...f.store.getThought("a"),id:"retained",text:operation.text,title:null,titleAuthor:null,author:"ai" as const,kind:"ai-interpretation" as const,origin:"weave",parentId:"a",sourceIds:[],createdAt:f.clock.now};
  f.store.saveThought(thought);
  const result = {type:"interpretation",thought};
  f.db.run("INSERT INTO run_operation_receipts(run_id,operation_id,operation_json,thought_id,result_json,format) VALUES (?,?,?,?,?,'step')",
    [id,promptId,protocolJson(operation),thought.id,protocolJson(result)]);
  f.db.run("UPDATE run_steps SET result_json=? WHERE run_id=? AND prompt_id=?",[protocolJson(result),id,promptId]);
  expect(() => f.ops.executeStep(claim,promptId,operation)).toThrow(RunForbiddenError);
  expect(() => f.capabilities.dispatch(claim,promptId,req)).toThrow(RunForbiddenError);
  expect(() => f.steps.advance(claim,promptId,result,{promptId:"forged-successor",input:"forged result"})).toThrow(RunForbiddenError);
  expect(() => f.state.finish(claim,promptId)).toThrow(RunForbiddenError);
  expect(f.reviews.lastReviewedAt("a")).toBeNull();
}));
test("daily screening is not suppressed by a historical creation owner", async () => dailyReviewFixture(f => {
  f.seed("root"); f.seed("z");
  new SqliteStore(f.db,f.sources).saveThought({id:"a",text:"Owned contribution",title:null,titleAuthor:null,author:"user",kind:"user-contribution",origin:"contribution",createdAt:"2029-01-01T00:00:00Z",parentId:"root",sourceIds:[]});
  const owner = f.db.query<{id:string},[]>("SELECT id FROM runs WHERE weave_subject_id='a'").get();
  if (!owner) throw new Error("Expected direct discovery owner");
  f.runs.stop(owner.id); f.state.settleUnsubmitted(owner.id);
  const id = admit(f), claim = f.runs.claim(id);
  expect(f.ops.weaveIntent(id)?.subjectId).toBe("a"); expect(f.state.ownsScreening(id)).toBe(true);
  expect(f.state.beginScreening(claim,"a",screeningPolicy("owned-daily-judge"))).toEqual(["root","z"]);
}));
test.each(["stop","reject-restore","restore"] as const)("held daily screening is fenced by %s", async reason => dailyReviewFixture(async f => {
  f.seed("a"); f.seed("z"); const id = admit(f), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const client = new ScriptedClient(() => reviewComplete);
  const w = worker(f,client,{identity:"held-owned-judge",async judge() { entered.resolve(); await release.promise; return 0.9; }});
  const flight = w.tick(id);
  try {
    await entered.promise;
    if (reason === "stop") f.runs.stop(id);
    if (reason === "reject-restore") { f.rejection.rejectThought("user","z"); f.rejection.restoreThought("user","z"); }
    if (reason === "restore") f.db.run("INSERT INTO restore_fences VALUES ('run',?,?,?,'{}')",[id,"a".repeat(64),f.clock.now]);
    release.resolve(); await flight;
    expect(client.prompts).toEqual([]); expect(f.reviews.lastReviewedAt("a")).toBeNull();
    expect(f.steps.steps(id)[0]?.input).toBeNull();
  } finally { release.resolve(); await flight; w.pause(); await w.drain(); }
}));
test("prepared daily prompt and uncertain native identity survive restart without automatic resubmission", async () => dailyReviewFixture(async f => {
  f.seed("a"); const id = admit(f), client = new ScriptedClient(() => reviewComplete); client.dropNextAck = true;
  const first = worker(f,client);
  await until(first,id,() => client.prompts.length === 1); client.historyMode = "empty";
  const exact = f.steps.steps(id)[0]; expect(exact?.input).toContain("review-complete");
  expect(f.run(id).status).toBe("uncertain"); first.pause(); await first.drain();
  const reopened = new Database(f.path), second = worker(f,client,undefined,reopened);
  try {
    for (let i=0;i<8;i++) await second.tick(id);
    expect(client.prompts).toHaveLength(1); expect(f.steps.steps(id)[0]?.input).toBe(exact?.input);
    expect(f.reviews.lastReviewedAt("a")).toBeNull();
    client.historyMode = "normal";
    await until(second,id,() => f.run(id).status === "completed");
    expect(client.prompts).toHaveLength(1); expect(f.steps.steps(id)[0]?.promptId).toBe(exact?.promptId);
    expect(f.reviews.lastReviewedAt("a")).toBe(f.clock.now);
  } finally { second.pause(); await second.drain(); reopened.close(); }
}));
test("daily review is outside interpretation retirement authority", async () => dailyReviewFixture(f => {
  f.seed("a"); const id = admit(f); f.runs.stop(id);
  const reinterpret = new SqliteReinterpretations(f.db,f.sources);
  expect(() => reinterpret.prepareRetirement("a",id)).toThrow();
  expect(new SqliteRunWorkerState(f.db,f.sources).settleUnsubmitted(id)).toBe(true);
}));
test("daily screening exhausts eligible pairs and hands only nominations to authoritative Weaver", async () => dailyReviewFixture(async f => {
  f.seed("a"); for (let i=0;i<7;i++) f.seed(`z-${i}`); f.seed("rejected"); f.rejection.rejectThought("user","rejected");
  const id = admit(f), judged: string[] = [], client = new ScriptedClient(() => reviewComplete);
  const w = worker(f,client,{identity:"owned-exhaustive-daily",async judge(pair) {
    expect(f.db.inTransaction).toBe(false); judged.push(pair.thoughtB.id); return pair.thoughtB.id === "z-0" ? 0.60 : 0.1;
  }});
  try {
    await until(w,id,() => f.run(id).status === "completed");
    expect(judged.toSorted()).toEqual(Array.from({length:7},(_,i) => `z-${i}`));
    const prompt = JSON.parse(client.prompts[0]?.text ?? "null") as {nominations:{id:string}[];instructions:string[]};
    expect(prompt.nominations.map(thought => thought.id)).toEqual(["z-0"]);
    expect(JSON.stringify(prompt.nominations)).not.toMatch(/score|probability|noul/i);
    expect(prompt.instructions.join(" ")).toContain("Continue searching beyond");
    expect(f.reviews.lastReviewedAt("a")).toBe(f.clock.now);
  } finally { w.pause(); await w.drain(); }
}));
test("active edges with rejected provenance skip screening, but a later day's rejected edge is not a negative cache", async () => dailyReviewFixture(async f => {
  f.seed("a"); f.seed("z"); f.seed("PRIVATE-SOURCE-ID");
  f.store.saveConnection({id:"owned-visible-edge",fromId:"z",toId:"a",category:"supports",proposedBy:"user",explanation:"Owned active relation",sourceIds:["PRIVATE-SOURCE-ID"]});
  f.rejection.rejectThought("user","PRIVATE-SOURCE-ID");
  const firstBatch = f.admit(); if (firstBatch.kind !== "admitted") throw new Error("Expected owned first batch");
  const firstId = firstBatch.runIds.find(id => f.ops.weaveIntent(id)?.subjectId === "a");
  if (!firstId) throw new Error("Expected owned a review");
  const firstCalls:string[] = [], firstClient = new ScriptedClient(() => reviewComplete);
  const first = worker(f,firstClient,{identity:"owned-provenance-exclusion",async judge(pair) { firstCalls.push(pair.thoughtB.id); return 0.9; }});
  try {
    await until(first,firstId,() => f.run(firstId).status === "completed");
    expect(firstCalls).toEqual([]);
    const input = firstClient.prompts[0]?.text ?? "";
    expect(input).toContain("owned-visible-edge"); expect(input).not.toContain("PRIVATE-SOURCE-ID");
    expect((JSON.parse(input) as {nominations:unknown[]}).nominations).toEqual([]);
    expect(f.db.query("SELECT excluded_connection_id FROM run_screening_pairs WHERE run_id=?").get(firstId)).toEqual({excluded_connection_id:"owned-visible-edge"});
  } finally { first.pause(); await first.drain(); }
  for (const id of firstBatch.runIds.filter(id => id !== firstId)) { f.runs.stop(id); f.state.settleUnsubmitted(id); }
  f.rejection.rejectConnection("user","owned-visible-edge");
  const nextBatch = f.admit("2031-01-02T12:00:00.000Z"); if (nextBatch.kind !== "admitted") throw new Error("Expected owned next batch");
  const nextId = nextBatch.runIds.find(id => f.ops.weaveIntent(id)?.subjectId === "a");
  if (!nextId) throw new Error("Expected a fresh a review");
  const nextCalls:string[] = [], nextClient = new ScriptedClient(() => reviewComplete);
  const next = worker(f,nextClient,{identity:"owned-provenance-exclusion",async judge(pair) { nextCalls.push(pair.thoughtB.id); return 0.9; }});
  try {
    await until(next,nextId,() => f.run(nextId).status === "completed");
    expect(nextCalls).toEqual(["z"]);
    const input = nextClient.prompts[0]?.text ?? "";
    expect((JSON.parse(input) as {nominations:{id:string}[]}).nominations.map(thought => thought.id)).toEqual(["z"]);
    expect(input).not.toContain("owned-visible-edge"); expect(input).not.toContain("PRIVATE-SOURCE-ID");
    expect(f.db.query("SELECT excluded_connection_id FROM run_screening_pairs WHERE run_id=?").get(firstId)).toEqual({excluded_connection_id:"owned-visible-edge"});
    expect(f.db.query("SELECT excluded_connection_id FROM run_screening_pairs WHERE run_id=?").get(nextId)).toEqual({excluded_connection_id:null});
  } finally { next.pause(); await next.drain(); }
},{rotationDays:1,maxPerDay:10}));
test("failed local daily screening logs sanitized Error and can complete through search-driven fallback", async () => dailyReviewFixture(async f => {
  f.seed("a"); f.seed("z"); const id = admit(f), client = new ScriptedClient(() => reviewComplete), records: LogRecord[] = [];
  const w = new RunWorker({db:f.db,...f.sources,logger:createLogger("verbose",record => records.push(record)),bindingFor:run => pathBinding(run,f.dir),
    connectionScreening:{identity:"owned-failing-judge",async judge() { throw new Error("private-judge-exception"); }},
    native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings),f.sources.logger)});
  try {
    await until(w,id,() => f.run(id).status === "completed");
    expect(records.some(record => record.level === "error")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private-judge-exception");
    const prompt = JSON.parse(client.prompts[0]?.text ?? "null") as {nominations?:unknown;instructions:string[]};
    expect(prompt.nominations).toBeUndefined(); expect(prompt.instructions.join(" ")).toContain("Actively search existing thinking");
    expect(f.reviews.lastReviewedAt("a")).toBe(f.clock.now);
  } finally { w.pause(); await w.drain(); }
}));
test("daily connection no-op suppresses a rejected equivalent without exposing or cloning it", async () => dailyReviewFixture(f => {
  f.seed("a"); f.seed("b");
  f.store.saveConnection({id:"hidden",fromId:"a",toId:"b",category:"related",proposedBy:"user",explanation:"REJECTED RELATION SENTINEL",sourceIds:[]});
  f.rejection.rejectConnection("user","hidden");
  const id = admit(f), claim = f.prepare(id);
  expect(f.steps.steps(id)[0]?.input).not.toContain("REJECTED RELATION SENTINEL");
  f.invoke(claim,{capability:"readThought",arguments:{id:"b"}});
  expect(f.invoke(claim,{capability:"connection",arguments:{fromId:"a",toId:"b",category:"related",explanation:"Owned proposal",sourceIds:[]}}))
    .toEqual({type:"connection",status:"not-created"});
  expect(f.db.query("SELECT id FROM connections").all()).toEqual([{id:"hidden"}]);
  f.complete(claim); expect(f.reviews.lastReviewedAt("a")).toBe(f.clock.now);
}));
test("a forged prepared successor cannot carry forbidden historical authority into native submission", async () => dailyReviewFixture(async f => {
  f.seed("a"); const id = admit(f), claim = f.prepare(id), current = f.run(id);
  f.steps.completeStep(claim,current.promptId,{version:1,kind:"request",request:{capability:"interpretation",arguments:{text:"Forbidden",sourceIds:[]}}});
  f.db.run("UPDATE run_steps SET state='processed',result_json='{}' WHERE run_id=? AND prompt_id=?",[id,current.promptId]);
  f.db.run("INSERT INTO run_steps(run_id,position,prompt_id,input,state,native_state) VALUES (?,1,'forged-next','forged cached result','prepared','unknown')",[id]);
  f.db.run("UPDATE runs SET status='queued' WHERE id=?",[id]);
  const client = new ScriptedClient(() => reviewComplete), w = worker(f,client);
  try { await expect(w.tick(id)).rejects.toBeInstanceOf(RunForbiddenError); expect(client.prompts).toEqual([]); expect(f.reviews.lastReviewedAt("a")).toBeNull(); }
  finally { w.pause(); await w.drain(); }
}));
test("positive creator Evolve cancellation evidence releases daily admission without reviving or cascading into the independent review", async () => dailyReviewFixture(async f => {
  f.seed("root");
  const origin = new RunAdmissionService({...f.sources,repository:f.runs}).admit("user","evolve",{parentId:"root",text:"Owned contribution"});
  if (!origin.contribution) throw new Error("Expected contribution");
  const subjectId = origin.contribution.id;
  const client = new ScriptedClient(() => ({version:1,kind:"complete",reply:"Owned Evolve reply"})), w = worker(f,client);
  try {
    await until(w,origin.run.id,() => client.prompts.length === 1);
    f.runs.stop(origin.run.id);
    const owner = f.db.query<{id:string},[string]>("SELECT id FROM runs WHERE weave_subject_id=? AND weave_trigger_id LIKE 'connection-discovery:%'").get(subjectId);
    if (!owner) throw new Error("Expected creation owner");
    expect(f.state.settleUnsubmitted(owner.id)).toBe(true);
    f.rejection.rejectThought("user","root");
    expect(f.admit().kind).toBe("deferred");
    await until(w,origin.run.id,() => f.db.query<{state:string},[string]>("SELECT cancellation_state AS state FROM runs WHERE id=?").get(origin.run.id)?.state === "settled");
    expect(f.steps.steps(origin.run.id)[0]).toMatchObject({state:"completed",envelope:null});
    const id = admit(f); expect(f.ops.weaveIntent(id)?.subjectId).toBe(subjectId);
    f.runs.stop(origin.run.id); expect(f.run(id).status).toBe("queued");
    expect(f.run(origin.run.id).status).toBe("interrupted");
  } finally { w.pause(); await w.drain(); }
}));
