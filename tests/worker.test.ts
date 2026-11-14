import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentUncertainError, createPublicClient, OpenCodeAdapter, type AgentBinding, type NativeSession, type Observation, type PersistedPrompt, type PublicClient } from "../src/agent/opencode-adapter";
import { RunWorker, type ConnectionScreeningPort, type ScreeningPair, type WorkerNative } from "../src/agent/worker";
import { initialWorkerPrompt } from "../src/agent/worker-prompts";
import { RejectionService } from "../src/domain/rejection";
import { SearchService } from "../src/domain/search";
import { TitleService } from "../src/domain/title";
import { RunFenceError, RunService, type Claim, type NativeDispatcher, type RunRecord } from "../src/domain/run";
import { createLogger, type LogRecord } from "../src/logging";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { SqliteSearchRepository } from "../src/storage/search";
import { SqliteTitleRepository } from "../src/storage/title";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const now = () => "2031-01-01T00:00:00Z";
const unusedNative: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
const request = (capability: string, args: Record<string, unknown>) => JSON.stringify({ version: 1, kind: "request", request: { capability, arguments: args } });
const complete = (reply: string) => JSON.stringify({ version: 1, kind: "complete", reply });

async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>) {
  const dir = mkdtempSync(join("/tmp/opencode", "worker-owned-"));
  const db = new Database(join(dir, "owned.sqlite"));
  try { migrate(db); await action(setup(db)); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
function setup(db: Database) {
  let sequence = 0;
  const id = () => `fixture-${++sequence}`;
  const store = new SqliteStore(db);
  store.saveThought({ id: "root", text: "owned subject", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const runs = new SqliteRunRepository(db, { id, now });
  const service = new RunService({ repository: runs, dispatcher: unusedNative, id, now });
  const steps = new SqliteRunProtocolRepository(db);
  const ops = new SqliteRunOperations(db, { id, now });
  const capabilities = new SqliteCapabilityDispatcher(db, { id, now });
  const rejection = new RejectionService(new SqliteRejectionRepository(db));
  return { db, id, store, runs, service, steps, ops, capabilities, rejection };
}
function binding(run: RunRecord): AgentBinding {
  return { sessionId: run.sessionId, serviceUrl: "http://127.0.0.1:7711", location: { directory: "/tmp/opencode/worker-fixture" }, model: { providerID: "fixture", id: "model-a" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 };
}

/** The fake uses the same authoritative native-phase callback as the real adapter. */
class OwnedNative implements WorkerNative {
  readonly submitted: PersistedPrompt[] = [];
  readonly observed: PersistedPrompt[][] = [];
  readonly bindingsSeen: AgentBinding[] = [];
  cancellations = 0;
  loseAck = false;
  constructor(private readonly bindings: SqliteAgentBindings, private readonly output: (index: number) => string) {}
  async ensureSession(claim: Claim, value: AgentBinding) { this.bindings.bind(claim.runId, value, claim); this.bindingsSeen.push(value); }
  async submit(claim: Claim, _value: AgentBinding, prompt: PersistedPrompt) {
    this.bindings.assertActive(claim, prompt, "history");
    this.bindings.assertActive(claim, prompt, "submit");
    this.submitted.push(prompt);
    if (this.loseAck) { this.loseAck = false; this.bindings.assertActive(claim, prompt, "uncertain"); throw new AgentUncertainError("test admission lost"); }
    this.bindings.assertActive(claim, prompt, "acknowledged");
  }
  async observe(claim: Claim, _value: AgentBinding, prompts: readonly PersistedPrompt[]): Promise<Observation> {
    const last = prompts.at(-1);
    if (!last) throw new Error("Expected persisted prompt");
    expect(this.bindings.assertActive(claim, last, "history")).toEqual(prompts);
    this.observed.push([...prompts]);
    this.bindings.assertActive(claim, last, "completed");
    return { state: "completed", output: this.output(prompts.length - 1) };
  }
  async cancel(_runId: string, _value: AgentBinding, _prompt: PersistedPrompt): Promise<"pending" | "settled"> { this.cancellations++; return "settled"; }
}
function worker(f: ReturnType<typeof setup>, output: (index: number) => string, selected: (run: RunRecord) => AgentBinding | null = binding) {
  const native = new OwnedNative(new SqliteAgentBindings(f.db), output);
  const instance = new RunWorker({ db: f.db, id: f.id, now, bindingFor: selected, native: () => native });
  return { instance, native };
}
async function drive(instance: RunWorker, f: ReturnType<typeof setup>, runId: string) {
  // Test harness bound only; the worker must not impose an effort quota.
  for (let i = 0; i < 40 && !["completed", "interrupted", "failed"].includes(f.runs.get(runId)?.status ?? ""); i++) await instance.tick(runId);
}

test("ordinary weave screens every eligible other thought before nominating threshold matches to Weaver", async () => fixture(async f => {
  const candidates = Array.from({length:32}, (_, index) => ({id:`candidate-${index}`, text:`distinct owned candidate text ${index}`}));
  for (const candidate of [...candidates, {id:"rejected-candidate",text:"rejected owned content"}]) {
    f.store.saveThought({...candidate, title:null, author:"user", kind:"captured-original", createdAt:now(), origin:"fixture", parentId:null, sourceIds:[]});
  }
  f.rejection.rejectThought("user","rejected-candidate");
  const run = f.ops.admitWeave("user", {subjectId:"root",triggerId:"screen-all"});
  const native = new OwnedNative(new SqliteAgentBindings(f.db), () => complete("no connection warranted"));
  const pairs: ScreeningPair[] = [];
  const connectionScreening: ConnectionScreeningPort = {identity:"owned-judge-v1",async judge(pair) {
    expect(native.submitted).toHaveLength(0);
    expect(f.db.inTransaction).toBe(false);
    pairs.push(pair);
    return pair.thoughtB.id === "candidate-0" ? 0.60 : pair.thoughtB.id === "candidate-1" ? 0.599 : 0.1;
  }};
  const instance = new RunWorker({db:f.db,id:f.id,now,bindingFor:binding,native:() => native,connectionScreening});
  try {
    for (let i=0;i<12 && native.submitted.length === 0;i++) await instance.tick(run.id);
    expect(pairs.map(pair => pair.thoughtB.id).sort()).toEqual(candidates.map(candidate => candidate.id).sort());
    expect(pairs.every(pair => pair.thoughtA.id === "root" && pair.thoughtA.text === "owned subject")).toBe(true);
    expect(pairs.map(pair => pair.thoughtB.text).sort()).toEqual(candidates.map(candidate => candidate.text).sort());
    expect(native.submitted).toHaveLength(1);
    const input = native.submitted[0]?.input ?? "";
    const prompt = JSON.parse(input) as {nominations: {id:string;text:string}[]};
    expect(prompt.nominations.map(thought => thought.id)).toEqual(["candidate-0"]);
    expect(prompt.nominations[0]?.text).toBe("distinct owned candidate text 0");
    expect(JSON.stringify(prompt.nominations)).not.toMatch(/probability|score|noul/i);
    expect(input).not.toContain('0.599');
    expect(input).toMatch(/search/i);
    expect(input).toMatch(/no (?:useful )?(?:connection|findings)/i);
    await drive(instance,f,run.id);
    expect(f.runs.get(run.id)?.status).toBe("completed");
    expect(f.runs.reply(run.id)?.text).toBe("no connection warranted");
    expect(f.db.query("SELECT COUNT(*) AS count FROM connections").get()).toEqual({count:0});
  } finally { instance.pause(); await instance.drain(); }
}));

test("rejection during a held screening call fences prompt preparation and native submission", async () => fixture(async f => {
  f.store.saveThought({id:"candidate",text:"owned candidate",title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const run = f.ops.admitWeave("user",{subjectId:"root",triggerId:"screen-rejection"});
  const native = new OwnedNative(new SqliteAgentBindings(f.db),() => complete("unused"));
  let enter: () => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const connectionScreening: ConnectionScreeningPort = {identity:"owned-judge-v1",async judge() { enter(); await held; return 1; }};
  const instance = new RunWorker({db:f.db,id:f.id,now,bindingFor:binding,native:() => native,connectionScreening});
  const tick = instance.tick(run.id);
  try {
    await entered;
    f.rejection.rejectThought("user","candidate");
    release(); await tick;
    expect(f.runs.get(run.id)?.status).toBe("interrupted");
    expect(f.steps.steps(run.id)[0]?.input).toBeNull();
    expect(native.submitted).toEqual([]);
  } finally { release(); await tick; instance.pause(); await instance.drain(); }
}));

test("a new eligible thought during screening causes search fallback rather than a partial nomination set", async () => fixture(async f => {
  const save = (id:string) => f.store.saveThought({id,text:`owned ${id}`,title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  save("first");
  const run = f.ops.admitWeave("user",{subjectId:"root",triggerId:"screen-growth"});
  const native = new OwnedNative(new SqliteAgentBindings(f.db),() => complete("unused"));
  let enter: () => void = () => {}, release: () => void = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const records: LogRecord[] = [];
  const connectionScreening: ConnectionScreeningPort = {identity:"owned-judge-v1",async judge() { enter(); await held; return 1; }};
  const instance = new RunWorker({db:f.db,id:f.id,now,logger:createLogger(undefined,record => records.push(record)),bindingFor:binding,native:() => native,connectionScreening});
  const tick = instance.tick(run.id);
  try {
    await entered;
    save("late");
    release(); await tick;
    for (let i=0;i<12 && native.submitted.length === 0;i++) await instance.tick(run.id);
    const prompt = JSON.parse(native.submitted[0]?.input ?? "null") as {nominations?: unknown; instructions: string[]};
    expect(prompt.nominations).toBeUndefined();
    expect(prompt.instructions.join(" ")).toContain("Actively search existing thinking for promising candidates");
    expect(records.some(record => record.level === "error")).toBe(true);
  } finally { release(); await tick; instance.pause(); await instance.drain(); }
}));

test("screening failure logs a sanitized error and retains the legacy search-driven Weaver prompt", async () => fixture(async f => {
  f.store.saveThought({id:"candidate",text:"private candidate content",title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const records: LogRecord[] = [], logger = createLogger(undefined,record => records.push(record));
  const run = f.ops.admitWeave("user",{subjectId:"root",triggerId:"screen-fallback"});
  const native = new OwnedNative(new SqliteAgentBindings(f.db),() => complete("no findings"));
  let calls = 0;
  const connectionScreening: ConnectionScreeningPort = {identity:"owned-judge-v1",async judge() { calls++; throw new Error("private transport secret"); }};
  const instance = new RunWorker({db:f.db,id:f.id,now,logger,bindingFor:binding,native:() => native,connectionScreening});
  try {
    for (let i=0;i<12 && native.submitted.length === 0;i++) await instance.tick(run.id);
    expect(calls).toBeGreaterThan(0);
    expect(native.submitted).toHaveLength(1);
    const input = native.submitted[0]?.input ?? "";
    expect(input).toContain("Actively search existing thinking for promising candidates");
    expect(input).not.toMatch(/exhaustive(?:ly)? screen/i);
    expect(records.some(record => record.level === "error")).toBe(true);
    const logs = JSON.stringify(records);
    for (const secret of ["private transport secret","private candidate content","owned subject"]) expect(logs).not.toContain(secret);
  } finally { instance.pause(); await instance.drain(); }
}));

async function screeningRestartFixture(action: (f: {
  readonly db: Database; readonly id: () => string; readonly store: SqliteStore;
  reopen(): void;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join("/tmp/opencode","screening-restart-"));
  const path = join(dir,"owned.sqlite");
  let db = new Database(path), sequence = 0;
  const id = () => `restart-${++sequence}`;
  try {
    migrate(db);
    new SqliteStore(db).saveThought({id:"root",text:"owned subject",title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
    await action({get db() { return db; },id,get store() { return new SqliteStore(db); },reopen() { db.close(); db = new Database(path); }});
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
}

function screeningRestartWorker(db: Database, id: () => string, connectionScreening: Omit<ConnectionScreeningPort,"identity"> & {readonly identity?:string}, log?: (record: LogRecord) => void) {
  const native = new OwnedNative(new SqliteAgentBindings(db),() => complete("no findings"));
  return {native,instance:new RunWorker({db,id,now,logger:createLogger("verbose",log ?? (() => {})),bindingFor:binding,native:() => native,
    connectionScreening:{identity:"owned-judge-v1",...connectionScreening}})};
}

async function enteredWithin(promise: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise,new Promise<never>((_,reject) => { timeout = setTimeout(() => reject(new Error("Owned screening boundary not reached")),2000); })]); }
  finally { if (timeout !== undefined) clearTimeout(timeout); }
}

test("durable screening progress resumes only unfinished judgments after worker and database restart", async () => screeningRestartFixture(async f => {
  for (let i=0;i<5;i++) f.store.saveThought({id:`candidate-${i}`,text:`owned candidate ${i}`,title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const run = new SqliteRunOperations(f.db,{id:f.id,now}).admitWeave("user",{subjectId:"root",triggerId:"durable-screen"});
  let enter: () => void = () => {}, release: () => void = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  let checkpoint: () => void = () => {};
  const checkpointed = new Promise<void>(resolve => { checkpoint = resolve; });
  let nominatedId = "";
  const first = screeningRestartWorker(f.db,f.id,{async judge(pair) {
    seen.push(pair.thoughtB.id);
    if (seen.length === 1) nominatedId = pair.thoughtB.id;
    if (seen.length === 5) { enter(); await held; }
    return pair.thoughtB.id === nominatedId ? 0.75 : 0.1;
  }},record => {
    if (record.message === "[run storage] record screening judgment succeeded" &&
        (f.db.query<{n:number},[string]>("SELECT count(*) AS n FROM run_screening_pairs WHERE run_id=? AND judgment_json IS NOT NULL").get(run.id)?.n ?? 0) === 4) checkpoint();
  });
  const tick = first.instance.tick(run.id);
  try {
    await enteredWithin(entered);
    await enteredWithin(checkpointed);
    expect(seen).toHaveLength(5);
    expect(f.db.query("SELECT judgment_json FROM run_screening_pairs WHERE run_id=? AND candidate_id=?").get(run.id,nominatedId)).toEqual({judgment_json:'{"score":0.75}'});
    expect(new SqliteRunProtocolRepository(f.db).steps(run.id)[0]?.input).toBeNull();
    first.instance.pause(); release(); await tick; await first.instance.drain();
    f.reopen();
    const resumedCalls: string[] = [];
    const resumed = screeningRestartWorker(f.db,f.id,{async judge(pair) { resumedCalls.push(pair.thoughtB.id); return 0.1; }});
    try {
      for (let i=0;i<12 && resumed.native.submitted.length === 0;i++) await resumed.instance.tick(run.id);
      expect(resumedCalls).toEqual([seen[4]]);
      expect(resumed.native.submitted).toHaveLength(1);
      const prompt = JSON.parse(resumed.native.submitted[0]?.input ?? "null") as {nominations:{id:string}[]};
      expect(prompt.nominations.map(item => item.id)).toEqual([nominatedId]);
    } finally { resumed.instance.pause(); await resumed.instance.drain(); }
  } finally { release(); await tick; first.instance.pause(); await first.instance.drain(); }
}));

test("durable screening failure remains fallback after restart without repeating failed judgments", async () => screeningRestartFixture(async f => {
  for (let i=0;i<2;i++) f.store.saveThought({id:`candidate-${i}`,text:`owned candidate ${i}`,title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const run = new SqliteRunOperations(f.db,{id:f.id,now}).admitWeave("user",{subjectId:"root",triggerId:"durable-fallback"});
  let enter: () => void = () => {}, release: () => void = () => {}, fail: () => void = () => {}, failed: () => void = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const failureGate = new Promise<void>(resolve => { fail = resolve; });
  const failureReturned = new Promise<void>(resolve => { failed = resolve; });
  let checkpoint: () => void = () => {};
  const checkpointed = new Promise<void>(resolve => { checkpoint = resolve; });
  const first = screeningRestartWorker(f.db,f.id,{async judge(pair) {
    if (pair.thoughtB.id === "candidate-0") { await failureGate; failed(); throw new Error("owned outage"); }
    enter(); await held; return 0.9;
  }},record => {
    if (record.message === "[run storage] record screening failure succeeded" &&
        f.db.query<{status:string},[string]>("SELECT status FROM run_screening_passes WHERE run_id=?").get(run.id)?.status === "fallback") checkpoint();
  });
  const tick = first.instance.tick(run.id);
  try {
    await enteredWithin(entered);
    fail(); await enteredWithin(failureReturned);
    await enteredWithin(checkpointed);
    expect(f.db.query("SELECT status,failure_code FROM run_screening_passes WHERE run_id=?").get(run.id)).toEqual({status:"fallback",failure_code:"screening-unavailable"});
    expect(new SqliteRunProtocolRepository(f.db).steps(run.id)[0]?.input).toBeNull();
    first.instance.pause(); release(); await tick; await first.instance.drain();
    f.reopen();
    const resumedCalls: string[] = [];
    const resumed = screeningRestartWorker(f.db,f.id,{async judge(pair) { resumedCalls.push(pair.thoughtB.id); return 1; }});
    try {
      for (let i=0;i<12 && resumed.native.submitted.length === 0;i++) await resumed.instance.tick(run.id);
      expect(resumedCalls).toEqual([]);
      expect(resumed.native.submitted).toHaveLength(1);
      const prompt = JSON.parse(resumed.native.submitted[0]?.input ?? "null") as {nominations?:unknown;instructions:string[]};
      expect(prompt.nominations).toBeUndefined();
      expect(prompt.instructions.join(" ")).toContain("Actively search existing thinking for promising candidates");
    } finally { resumed.instance.pause(); await resumed.instance.drain(); }
  } finally { fail(); release(); await tick; first.instance.pause(); await first.instance.drain(); }
}));

test("prepared screening prompt and identity survive restart with changed screening configuration", async () => screeningRestartFixture(async f => {
  f.store.saveThought({id:"candidate",text:"owned candidate",title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const run = new SqliteRunOperations(f.db,{id:f.id,now}).admitWeave("user",{subjectId:"root",triggerId:"durable-prompt"});
  let initialCalls = 0;
  const first = screeningRestartWorker(f.db,f.id,{async judge() { initialCalls++; return 0.9; }});
  try {
    await first.instance.tick(run.id);
    expect(initialCalls).toBe(1);
    const step = new SqliteRunProtocolRepository(f.db).steps(run.id)[0];
    if (!step || step.input === null) throw new Error("Expected owned prepared screening prompt");
    const saved = {promptId:step.promptId,input:step.input};
    expect(first.native.submitted).toEqual([]);
    first.instance.pause(); await first.instance.drain();
    f.reopen();
    let changedCalls = 0;
    const resumed = screeningRestartWorker(f.db,f.id,{identity:"changed-judge-v2",async judge() { changedCalls++; throw new Error("changed owned configuration must not be used"); }});
    try {
      for (let i=0;i<12 && resumed.native.submitted.length === 0;i++) await resumed.instance.tick(run.id);
      expect(changedCalls).toBe(0);
      expect(resumed.native.submitted).toEqual([saved]);
      const stepAfter = new SqliteRunProtocolRepository(f.db).steps(run.id)[0];
      expect({promptId:stepAfter?.promptId,input:stepAfter?.input}).toEqual(saved);
    } finally { resumed.instance.pause(); await resumed.instance.drain(); }
  } finally { first.instance.pause(); await first.instance.drain(); }
}));

test("late screening judgment from a stale owner cannot overwrite its successor's prompt", async () => screeningRestartFixture(async f => {
  f.store.saveThought({id:"candidate",text:"owned candidate",title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const run = new SqliteRunOperations(f.db,{id:f.id,now}).admitWeave("user",{subjectId:"root",triggerId:"stale-screen-owner"});
  let enter: () => void = () => {}, release: () => void = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = screeningRestartWorker(f.db,f.id,{async judge() { enter(); await held; return 1; }});
  const tick = first.instance.tick(run.id);
  let successor: ReturnType<typeof screeningRestartWorker> | undefined;
  try {
    await enteredWithin(entered);
    successor = screeningRestartWorker(f.db,f.id,{async judge() { return 0; }});
    await successor.instance.tick(run.id);
    const prepared = new SqliteRunProtocolRepository(f.db).steps(run.id)[0];
    if (!prepared || prepared.input === null) throw new Error("Expected successor prepared prompt");
    expect((JSON.parse(prepared.input) as {nominations:unknown[]}).nominations).toEqual([]);
    release(); await tick;
    const after = new SqliteRunProtocolRepository(f.db).steps(run.id)[0];
    expect({promptId:after?.promptId,input:after?.input}).toEqual({promptId:prepared.promptId,input:prepared.input});
    expect(first.native.submitted).toEqual([]);
  } finally {
    release(); await tick; first.instance.pause(); await first.instance.drain();
    successor?.instance.pause(); await successor?.instance.drain();
  }
}));

test("an edge added for a queued pair skips its call and continues every remaining pair", async () => fixture(async f => {
  for (let i=0;i<8;i++) f.store.saveThought({id:`candidate-${i}`,text:`owned candidate ${i}`,title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const run = f.ops.admitWeave("user",{subjectId:"root",triggerId:"queued-exclusion"});
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), calls:string[] = [];
  const native = new OwnedNative(new SqliteAgentBindings(f.db),() => complete("no findings"));
  const instance = new RunWorker({db:f.db,id:f.id,now,bindingFor:binding,native:() => native,
    connectionScreening:{identity:"owned-queued-exclusion",async judge(pair) {
      calls.push(pair.thoughtB.id); if (calls.length === 4) entered.resolve();
      if (Number(pair.thoughtB.id.at(-1)) < 4) await release.promise;
      return 0.9;
    }}});
  const flight = instance.tick(run.id);
  try {
    await enteredWithin(entered.promise);
    f.store.saveConnection({id:"queued-edge",fromId:"candidate-4",toId:"root",category:"extends",proposedBy:"user",explanation:"Owned queued relation",sourceIds:[]});
    release.resolve(); await flight; await drive(instance,f,run.id);
    expect(calls.toSorted()).toEqual([0,1,2,3,5,6,7].map(i => `candidate-${i}`));
    const prompt = JSON.parse(native.submitted[0]?.input ?? "null") as {nominations:{id:string}[]};
    expect(prompt.nominations.map(thought => thought.id).toSorted()).toEqual(calls.toSorted());
    expect(f.db.query("SELECT judgment_json,excluded_connection_id FROM run_screening_pairs WHERE run_id=? AND candidate_id='candidate-4'").get(run.id))
      .toEqual({judgment_json:null,excluded_connection_id:"queued-edge"});
    expect(f.db.query("SELECT status,failure_code FROM run_screening_passes WHERE run_id=?").get(run.id)).toEqual({status:"complete",failure_code:null});
  } finally { release.resolve(); await flight; instance.pause(); await instance.drain(); }
}));

test("a skipped pair becoming unconnected before prompt commit stays pending and resumes after reopen", async () => screeningRestartFixture(async f => {
  for (let i=0;i<5;i++) f.store.saveThought({id:`candidate-${i}`,text:`owned candidate ${i}`,title:null,author:"user",kind:"captured-original",createdAt:now(),origin:"fixture",parentId:null,sourceIds:[]});
  const run = new SqliteRunOperations(f.db,{id:f.id,now}).admitWeave("user",{subjectId:"root",triggerId:"pending-exclusion"});
  const calls:string[] = [];
  const first = screeningRestartWorker(f.db,f.id,{identity:"owned-pending-exclusion",async judge(pair) {
    calls.push(pair.thoughtB.id);
    if (pair.thoughtB.id === "candidate-0") f.store.saveConnection({id:"temporary-edge",fromId:"candidate-4",toId:"root",category:"related",proposedBy:"user",explanation:"Owned temporary relation",sourceIds:[]});
    return 0.9;
  }},record => {
    if (record.message === "[worker] screening complete") new RejectionService(new SqliteRejectionRepository(f.db)).rejectConnection("user","temporary-edge");
  });
  try {
    await first.instance.tick(run.id);
    expect(calls.toSorted()).toEqual([0,1,2,3].map(i => `candidate-${i}`));
    expect(new SqliteRunProtocolRepository(f.db).steps(run.id)[0]?.input).toBeNull();
    expect(f.db.query("SELECT status,failure_code FROM run_screening_passes WHERE run_id=?").get(run.id)).toEqual({status:"collecting",failure_code:null});
    expect(f.db.query("SELECT 1 FROM agent_bindings WHERE run_id=?").get(run.id)).toBeNull();
    expect(first.native.submitted).toEqual([]); expect(first.native.bindingsSeen).toEqual([]);
    first.instance.pause(); await first.instance.drain(); f.reopen();
    const resumedCalls:string[] = [];
    const resumed = screeningRestartWorker(f.db,f.id,{identity:"owned-pending-exclusion",async judge(pair) { resumedCalls.push(pair.thoughtB.id); return 0.9; }});
    try {
      for (let i=0;i<12 && resumed.native.submitted.length === 0;i++) await resumed.instance.tick(run.id);
      expect(resumedCalls).toEqual(["candidate-4"]);
      const prompt = JSON.parse(resumed.native.submitted[0]?.input ?? "null") as {nominations:{id:string}[]};
      expect(prompt.nominations.map(thought => thought.id).toSorted()).toEqual([0,1,2,3,4].map(i => `candidate-${i}`));
      expect(resumed.native.submitted[0]?.input).not.toContain("temporary-edge");
    } finally { resumed.instance.pause(); await resumed.instance.drain(); }
  } finally { first.instance.pause(); await first.instance.drain(); }
}));

test("default-level worker diagnostics classify initial preparation failures without exposing private data", async () => fixture(async f => {
  const records: LogRecord[] = [];
  const logger = createLogger(undefined, record => records.push(record));
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "diagnostic-preparation" });
  const native = new OwnedNative(new SqliteAgentBindings(f.db), () => complete("unused"));
  const instance = new RunWorker({ db:f.db, id:f.id, now, logger, bindingFor:binding, native:() => native });
  f.db.exec(`CREATE TRIGGER test_worker_prepare_fault BEFORE UPDATE OF input ON run_steps
    BEGIN SELECT RAISE(ABORT,'private exception credential-secret'); END;`);
  try {
    await instance.tick(run.id);
    expect(f.runs.get(run.id)?.status).toBe("failed");
    const failure = records.find(record => record.level === "error" && record.message === "[worker] local processing failed");
    expect(failure?.context).toMatchObject({runId:run.id, generation:1, stage:"prepare-initial", category:"unexpected"});
    const output = JSON.stringify(records);
    for (const secret of ["owned subject", "credential-secret", "private exception"]) expect(output).not.toContain(secret);
    expect(native.submitted).toEqual([]);
  } finally {
    f.db.exec("DROP TRIGGER test_worker_prepare_fault");
    instance.pause(); await instance.drain();
  }
}));

test("default-level worker diagnostics distinguish invalid observed protocol output and redact it", async () => fixture(async f => {
  const records: LogRecord[] = [];
  const logger = createLogger(undefined, record => records.push(record));
  const run = f.ops.admitWeave("user", { subjectId:"root", triggerId:"diagnostic-protocol" });
  const native = new OwnedNative(new SqliteAgentBindings(f.db), () => "private model output credential-secret");
  const instance = new RunWorker({ db:f.db, id:f.id, now, logger, bindingFor:binding, native:() => native });
  try {
    await drive(instance,f,run.id);
    expect(f.runs.get(run.id)?.status).toBe("failed");
    expect(native.observed).toHaveLength(1);
    const failure = records.find(record => record.level === "error" && record.message === "[worker] local processing failed");
    expect(failure?.context).toMatchObject({runId:run.id, generation:1, stage:"parse-envelope", category:"protocol-validation"});
    const output = JSON.stringify(records);
    for (const secret of ["owned subject", "credential-secret", "private model output", "Expected one strict"]) expect(output).not.toContain(secret);
  } finally { instance.pause(); await instance.drain(); }
}));

async function provenInterruptedWeave(f: ReturnType<typeof setup>) {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "settlement-proof" });
  const w = worker(f, () => complete("not published"));
  for (let i = 0; i < 8 && w.native.submitted.length === 0; i++) await w.instance.tick(run.id);
  const prompt = w.native.submitted[0];
  if (!prompt) throw new Error("Expected submitted owned prompt");
  w.instance.pause(); await w.instance.drain();
  f.service.stop("user", run.id);
  const bindings = new SqliteAgentBindings(f.db), saved = bindings.get(run.id);
  if (!saved) throw new Error("Expected owned native binding");
  const session = { id:saved.sessionId, location:saved.location, model:saved.model, permissions:saved.permissions,
    metadata:{owner:"thoughtloom",runId:run.id,protocolVersion:"1"} };
  const client: PublicClient = {
    instructionList: async () => { throw new Error("Unexpected instruction list"); },
    instructionPut: async () => { throw new Error("Unexpected instruction put"); },
    instructionRemove: async () => { throw new Error("Unexpected instruction remove"); },
    serverInfo:async () => ({version:"fixture"}), sessionCreate:async () => session, sessionGet:async () => session,
    prompt:async () => { throw new Error("Cleanup must not submit"); }, inbox:async () => [], active:async () => ({}),
    history:async () => ({data:[{id:prompt.promptId,type:"user",time:{created:1},text:prompt.input},
      {id:"owned-interrupted",type:"idle",time:{created:2},outcome:"interrupted"}],cursor:{}}),
    cancelInbox:async () => {}, interrupt:async () => ({interrupted:true}),
  };
  const adapter = new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings));
  const journal = bindings.cancellationJournal(run.id,prompt);
  expect(await adapter.cancel(run.id,saved,prompt)).toBe("settled");
  expect(f.steps.cancellation(run.id)).toBe("pending");
  const state = new SqliteRunWorkerState(f.db,{id:f.id,now});
  const snapshot = () => ({run:f.db.query("SELECT * FROM runs WHERE id=?").get(run.id),
    steps:f.db.query("SELECT * FROM run_steps WHERE run_id=? ORDER BY position").all(run.id),
    binding:f.db.query("SELECT * FROM agent_bindings WHERE run_id=?").get(run.id)});
  return {run,prompt,bindings,saved,adapter,journal,state,snapshot};
}

test("weave and Evolve render discovery guidance alongside the shared evidence fences", () => {
  const context = { thoughts: [], connections: [], responses: [] };
  const render = (job: Parameters<typeof initialWorkerPrompt>[0]["job"]) => JSON.parse(initialWorkerPrompt({ ...context, job })) as { role: string; instructions: string[]; capabilities: { capability: string; argumentsSchema: { properties: Record<string, unknown> } }[] };
  const weave = render({ kind: "weave", subjectId: "subject" });
  const text = weave.instructions.join(" ");
  for (const phrase of ["claims, themes, and implications", "Actively search", "beyond lexical similarity", "snippets as discovery leads, not evidence", "Fully read promising candidate thoughts", "already fully read and needs no redundant reread", "does not read its endpoint thoughts", "supports, contradicts, extends, or related", "intended direction", "explain concretely", "only fully read supporting thoughts", "finding no useful connection is valid", "do not reconstruct it from indirect provenance"]) expect(text).toContain(phrase);
  expect(weave.role).toContain("fill an absent title");
  const evolve = render({ kind: "evolve", contributionId: "input", continuationId: null });
  const discovery = render({ kind:"weave",subjectId:"subject",purpose:"connection-only" });
  const exported = render({ kind: "export", request: "fixture question", effort: "standard" });
  expect(evolve.instructions.join(" ")).toMatch(/search.*candidate/i);
  expect(evolve.instructions.join(" ")).toMatch(/fully read/i);
  expect(evolve.instructions.join(" ")).toMatch(/connection/i);
  expect(evolve.instructions.join(" ")).not.toMatch(/sibling interpretations|source-informed interpretation|bare list of links/i);
  expect(evolve.capabilities.map(item => item.capability)).toEqual(expect.arrayContaining(["title-fill", "search", "readThought", "connection", "development"]));
  expect(evolve.capabilities.map(item => item.capability)).not.toContain("interpretation");
  for (const prompt of [weave,evolve,discovery]) {
    const guidance = prompt.instructions.join(" ");
    for (const phrase of ["created records a new AI relation", "already-present returns an existing eligible relation", "original identity, explanation and attribution", "not-created is an opaque no-op", "retry an equivalent proposal", "same directed endpoints and category", "full reads before any outcome"]) expect(guidance).toContain(phrase);
  }
  expect(Object.keys(evolve.capabilities.find(item => item.capability === "title-fill")?.argumentsSchema.properties ?? {})).toEqual(["title"]);
  expect(exported.instructions.join(" ")).not.toContain("Actively search existing thinking for promising candidates");
});

test("weave prompt gives intent-driven source guidance without broadening restricted roles", () => {
  const context = { thoughts: [], connections: [], responses: [] };
  const render = (job: Parameters<typeof initialWorkerPrompt>[0]["job"]) => initialWorkerPrompt({ ...context, job });
  const weave = render({ kind: "weave", subjectId: "subject" }).toLowerCase();
  // These assert instructions only; the controlled native fixture does not retrieve URLs.
  for (const guidance of [/url|link/, /summari[sz]/, /intent|context/, /sibling|separat/, /attribution|source link/,
    /fresh|afresh|again/, /fail|inaccessible|unavailable/, /fabricat|invent/, /follow.*link|link.*follow/]) expect(weave).toMatch(guidance);
  const { instructions } = JSON.parse(weave) as { instructions: string[] };
  expect(instructions.some(instruction => /(?:every|each|all) source-informed interpretations?.{0,120}(?:readable|markdown).{0,60}source links?.{0,60}(?:inline|directly|in (?:its|the) text)/i.test(instruction))).toBe(true);
  const exported = render({ kind: "export", request: "fixture", effort: "standard" });
  expect(exported).toContain("Use only the capabilities listed");
  expect(exported).not.toMatch(/sibling interpretations/i);
});

test("controlled link-list weave saves searchable sibling summaries and a partial-failure outcome", async () => fixture(async f => {
  f.store.saveThought({ id: "links", text: "https://example.test/one\nhttps://example.test/two\nhttps://example.test/missing", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const run = f.ops.admitWeave("user", { subjectId: "links", triggerId: "link-list" });
  const outputs = [
    request("interpretation", { text: "Albatross findings [source](https://example.test/one)", sourceIds: [] }),
    request("interpretation", { text: "Borealis findings [source](https://example.test/two)", sourceIds: [] }),
    complete("Summarized two sources; https://example.test/missing was inaccessible."),
  ];
  const w = worker(f, index => outputs[index] ?? complete("unexpected extra turn"));
  await drive(w.instance, f, run.id);
  expect(f.runs.get(run.id)?.status).toBe("completed");
  const issued = f.db.query("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(run.id) as { id: string }[];
  expect(issued).toHaveLength(2);
  for (const [index, text] of ["Albatross findings [source](https://example.test/one)", "Borealis findings [source](https://example.test/two)"].entries()) {
    expect(f.store.getThought(issued[index]?.id ?? "")).toMatchObject({ text, parentId: "links", kind: "ai-interpretation", author: "ai", sourceIds: [] });
  }
  const search = new SearchService(new SqliteSearchRepository(f.db));
  for (const [index, query] of ["albatross", "borealis"].entries()) {
    expect(search.search({ actor: "user", mode: "normal" }, query)).toContainEqual(expect.objectContaining({ kind: "thought", id: issued[index]?.id }));
  }
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='links'").get()).toEqual({ n: 2 });
  const reply = f.runs.reply(run.id);
  expect(reply).toMatchObject({ text: "Summarized two sources; https://example.test/missing was inaccessible.", state: "complete" });
  expect(reply?.thoughtIds).toContain("links");
  f.rejection.rejectThought("user", "links");
  if (!reply) throw new Error("Expected retained outcome");
  expect(f.rejection.getResponse({ actor: "ai", mode: "normal" }, reply.id)).toBeNull();
}));

test("owned SDK HTTP history with native activity saves a weave receipt and final reply once", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "native-history" });
  const inputs: { id: string; text: string }[] = [];
  const history: unknown[] = [];
  const requests: { method: string; path: string; cursor: string | null; submitted: number }[] = [];
  let session: NativeSession;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    requests.push({ method: req.method, path, cursor: url.searchParams.get("cursor"), submitted: inputs.length });
    if (path === "/api/info") return Response.json({ version: "fixture", pid: 1, urls: [], paths: { tmp: "/owned" } });
    if (path === "/api/session" && req.method === "POST") {
      const input = await req.json() as NativeSession;
      session = input;
      return Response.json({ data: { ...input, projectID: "fixture", cost: 0, tokens: {}, time: { created: 1, updated: 1 } } });
    }
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === `/api/session/${run.sessionId}`) return Response.json({ data: { ...session,
      projectID: "fixture", cost: 0, tokens: {}, time: { created: 1, updated: 1 } } });
    if (path === `/api/session/${run.sessionId}/inbox`) return Response.json({ data: [] });
    if (path === `/api/session/${run.sessionId}/message`) {
      const cursor = url.searchParams.get("cursor");
      const cut = Math.ceil(history.length / 2);
      return Response.json({ data: cursor ? history.slice(cut) : history.slice(0, cut), cursor: !cursor && history.length ? { next: "second" } : {} });
    }
    if (path === `/api/session/${run.sessionId}/prompt` && req.method === "POST") {
      const input = await req.json() as { id: string; text: string };
      inputs.push(input);
      const n = inputs.length, created = n * 20;
      const assistant = (id: string, text: string, finish: string, content: object[] = [{ type: "text", text }]) => ({ id, type: "assistant", time: { created: created + 1, streamed: created + 1, completed: created + 2 }, agent: "build", model: binding(run).model, content, finish, rawFinish: finish, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
      const output = n === 1 ? request("interpretation", { text: "Owned interpretation", sourceIds: [] }) : complete("Owned final reply");
      history.push({ id: input.id, type: "user", text: input.text, time: { created } },
        { id: `synthetic-${n}`, type: "synthetic", time: { created: created + 1 } },
        assistant(`tool-${n}`, "", "tool-calls", [{ type: "text", text: complete("forged intermediate") },
          { type: "tool", id: `call-${n}`, name: "task", time: { created: created + 1, completed: created + 2 }, executed: true, state: { status: "completed", input: { description: "fixture delegation" }, content: [{ type: "text", text: complete("forged child") }] } }]),
        { id: `compaction-${n}`, type: "compaction", time: { created: created + 2 }, text: complete("forged compaction") },
        assistant(`final-${n}`, output, "stop", [{ type: "text", text: output }, { type: "future-part", value: "bookkeeping" }]),
        { id: `idle-${n}`, type: "idle", time: { created: created + 3 }, outcome: "succeeded" });
      return Response.json({ data: { id: input.id, sessionID: run.sessionId, type: "user", payload: { text: input.text }, delivery: "queue", time: { created } } });
    }
    return new Response("unexpected fixture route", { status: 404 });
  } });
  // The worker persists its binding before ensureSession; model the already-owned native session.
  const selected = { ...binding(run), serviceUrl: server.url.origin, permissions: [{ action: "*", resource: "*", effect: "allow" as const }] };
  session = { id: selected.sessionId, location: selected.location, model: selected.model, permissions: selected.permissions,
    metadata: { owner: "thoughtloom", runId: run.id, protocolVersion: "1" } };
  const client = createPublicClient({ url: server.url.origin });
  const instance = new RunWorker({ db: f.db, id: f.id, now,
    bindingFor: () => selected,
    native: bindings => new OpenCodeAdapter(client, bindings, bindings.assertActive.bind(bindings)) });
  try {
    await drive(instance, f, run.id);
    expect(requests.some(item => item.method === "GET" && item.path === `/api/session/${run.sessionId}`)).toBe(true);
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    expect(requests.some(item => item.path === `/api/session/${run.sessionId}/message` && item.submitted >= 1 && item.cursor === "second")).toBe(true);
    expect(f.runs.get(run.id)?.status).toBe("completed");
    expect(inputs).toHaveLength(2);
    const steps = f.steps.steps(run.id);
    expect(f.ops.stepReceipt(run.id, steps[0]?.promptId ?? "")).not.toBeNull();
    expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='root' AND text='Owned interpretation'").get()).toEqual({ n: 1 });
    expect(f.runs.reply(run.id)).toMatchObject({ text: "Owned final reply", state: "complete" });
    for (let i = 0; i < 3; i++) await instance.tick(run.id);
    expect(inputs).toHaveLength(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='root'").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM responses WHERE text='Owned final reply'").get()).toEqual({ n: 1 });
  } finally { instance.pause(); await instance.drain(); await server.stop(true); }
}));

test("worker without native configuration leaves an unbound queued run untouched", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "unconfigured" });
  const worker = new RunWorker({ db: f.db, id: f.id, now });
  const snapshot = () => ["runs", "run_steps", "agent_bindings", "run_context"].map(table => f.db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  try {
    await worker.tick(run.id); await worker.tick(run.id);
    expect(snapshot()).toEqual(before);
    expect(f.runs.get(run.id)).toEqual(expect.objectContaining({ status: "queued", generation: 0 }));
  } finally { worker.pause(); await worker.drain(); }
}));

test("weave can search and read a candidate then connect it to the preloaded subject without rereading it", async () => fixture(async f => {
  f.store.saveThought({ id: "candidate", text: "zircon candidate", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "discovery" });
  const outputs = [request("search", { query: "zircon" }), request("readThought", { id: "candidate" }), request("connection", { fromId: "root", toId: "candidate", category: "related", explanation: "The subject and candidate share a fixture theme", sourceIds: ["root", "candidate"] }), complete("done")];
  const w = worker(f, index => outputs[index] ?? complete("done"));
  await drive(w.instance, f, run.id);
  expect(f.runs.get(run.id)?.status).toBe("completed");
  expect(f.capabilities.fullReadWitnesses(run.id)).toEqual(expect.arrayContaining([{ kind: "thought", id: "root" }, { kind: "thought", id: "candidate" }]));
  expect(f.db.query("SELECT from_id AS fromId,to_id AS toId,category,explanation FROM connections").get()).toEqual({ fromId: "root", toId: "candidate", category: "related", explanation: "The subject and candidate share a fixture theme" });
  expect(w.native.submitted).toHaveLength(4);
}));

for (const withDevelopment of [false, true]) test(`Evolve enriches its contribution in the same run ${withDevelopment ? "with developments" : "without a development"}`, async () => fixture(async f => {
  f.store.saveThought({ id: "candidate", text: "zircon candidate", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "my contribution" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const contributionId = admission.contribution.id;
  const outputs = [
    request("title-fill", { title: "Contribution label" }),
    request("search", { query: "zircon" }),
    request("readThought", { id: "candidate" }),
    request("connection", { fromId: contributionId, toId: "candidate", category: "supports", explanation: "The candidate supports the contribution", sourceIds: [contributionId, "candidate"] }),
    ...(withDevelopment ? [request("development", { parentId: contributionId, text: "first development", sourceIds: [] }), request("development", { parentId: contributionId, text: "latest development", sourceIds: [] })] : []),
    complete("full conversational reply"),
  ];
  const w = worker(f, index => outputs[index] ?? complete("unexpected extra turn"));
  await drive(w.instance, f, admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).toBe("completed");
  expect(w.native.submitted).toHaveLength(outputs.length);
  expect(f.store.getThought(contributionId)).toMatchObject({ text: "my contribution", title: "Contribution label", titleAuthor: "ai", parentId: "root", author: "user" });
  expect(f.capabilities.fullReadWitnesses(admission.run.id)).toEqual(expect.arrayContaining([{ kind: "thought", id: contributionId }, { kind: "thought", id: "candidate" }]));
  expect(f.db.query("SELECT from_id AS fromId,to_id AS toId,category,explanation FROM connections").all()).toEqual([{ fromId: contributionId, toId: "candidate", category: "supports", explanation: "The candidate supports the contribution" }]);
  const issued = f.db.query("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(admission.run.id) as { id: string }[];
  expect(issued).toHaveLength(withDevelopment ? 2 : 0);
  for (const [index, item] of issued.entries()) expect(f.store.getThought(item.id)).toMatchObject({ text: index === 0 ? "first development" : "latest development", parentId: contributionId, author: "ai", kind: "developing-idea" });
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id=? AND kind='ai-interpretation'").get(contributionId)).toEqual({ n: 0 });
  expect(f.runs.reply(admission.run.id)).toEqual({ id: expect.any(String), text: "full conversational reply", role: withDevelopment ? "addendum" : "fallback", state: "complete", thoughtIds: withDevelopment ? issued.map(item => item.id) : [contributionId] });
  expect(f.db.query("SELECT weave_subject_id AS subjectId,weave_trigger_id AS triggerId FROM runs WHERE kind='weave' AND weave_trigger_id NOT LIKE 'connection-discovery:%'").all()).toEqual(withDevelopment ? [{ subjectId: issued.at(-1)?.id, triggerId: `evolve:${admission.run.id}` }] : []);
  expect(f.db.query("SELECT weave_subject_id AS subjectId,weave_trigger_id AS triggerId FROM runs WHERE kind='weave' AND weave_trigger_id LIKE 'connection-discovery:%' ORDER BY rowid").all())
    .toEqual([contributionId,...issued.map(item => item.id)].map(subjectId => ({subjectId,triggerId:`connection-discovery:${admission.run.id}`})));
}));

test("worker persists scoped initial context and ordered development result before the next prompt", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "my contribution" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const contributionId = admission.contribution.id;
  const w = worker(f, index => index === 0 ? request("development", { parentId: contributionId, text: "saved development", sourceIds: [] }) : complete("actual response"));
  await drive(w.instance, f, admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).toBe("completed");
  expect(w.native.submitted).toHaveLength(2);
  const steps = f.steps.steps(admission.run.id);
  expect(steps.map(s => s.promptId)).toEqual(w.native.submitted.map(s => s.promptId));
  expect(steps.map(s => s.input)).toEqual(w.native.submitted.map(s => s.input));
  expect(w.native.submitted[0]?.input).toContain("my contribution");
  expect(f.capabilities.fullReadWitnesses(admission.run.id)).toContainEqual({ kind: "thought", id: contributionId });
  const issued = f.db.query("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(admission.run.id) as { id: string }[];
  expect(issued).toHaveLength(1);
  expect(w.native.submitted[1]?.input).toContain(issued[0]?.id);
  expect(f.runs.reply(admission.run.id)).toEqual({ id: expect.any(String), text: "actual response", role: "addendum", state: "complete", thoughtIds: [issued[0]?.id] });
  expect(f.ops.stepReceipt(admission.run.id, steps[0]?.promptId ?? "")).not.toBeNull();
  expect(w.native.observed[1]?.map(p => p.promptId)).toEqual(steps.map(s => s.promptId));
}));

test("lost admission acknowledgement and shutdown recover existing prompt without resubmission or rebinding", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "one" });
  const first = worker(f, () => complete("no findings"));
  // Build the adapter before the first dispatch and simulate admission followed by lost acknowledgement.
  first.native.loseAck = true;
  for (let i = 0; i < 8 && first.native.submitted.length === 0; i++) await first.instance.tick(run.id);
  expect(first.native.submitted).toHaveLength(1);
  first.instance.pause();
  expect(f.runs.get(run.id)?.status).not.toBe("interrupted");
  const bound = new SqliteAgentBindings(f.db).get(run.id);
  const second = worker(f, () => complete("no findings"), r => ({ ...binding(r), model: { providerID: "fixture", id: "changed-model" } }));
  await drive(second.instance, f, run.id);
  expect(f.runs.get(run.id)?.status).toBe("completed");
  expect(second.native.submitted).toEqual([]);
  expect(second.native.observed.flat().map(p => p.promptId)).toContain(first.native.submitted[0]?.promptId);
  expect(new SqliteAgentBindings(f.db).get(run.id)).toEqual(bound);
  expect(second.native.bindingsSeen.every(value => value.model.id === "model-a")).toBe(true);
  expect(f.runs.reply(run.id)).toMatchObject({ text: "no findings", state: "complete", thoughtIds: ["root"] });
}));

test("unconfigured queued work performs no native call and remains durable", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "unconfigured" });
  let calls = 0;
  const w = new RunWorker({ db: f.db, id: f.id, now, bindingFor: () => null, native: () => { calls++; throw new Error("must not connect"); } });
  await w.tick(run.id);
  expect(calls).toBe(0);
  expect(f.runs.get(run.id)).toMatchObject({ status: "queued", generation: 0 });
  expect(f.steps.steps(run.id)[0]?.input).toBeNull();
}));

test("Stop fences locally and later worker tick settles cancellation without losing contribution", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "retained question" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const w = worker(f, () => complete("late answer"));
  for (let i = 0; i < 8 && w.native.submitted.length === 0; i++) await w.instance.tick(admission.run.id);
  expect(w.native.submitted).toHaveLength(1);
  f.service.stop("user", admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).toBe("interrupted");
  await w.instance.tick(admission.run.id);
  expect(w.native.cancellations).toBe(1);
  expect(f.steps.cancellation(admission.run.id)).toBe("settled");
  expect(f.store.getThought(admission.contribution.id)?.text).toBe("retained question");
  expect(f.runs.reply(admission.run.id)).toBeNull();
}));

test("Stop after binding and preparation but before native session creation settles locally", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "retain before native creation" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const w = worker(f, () => complete("must not run"));
  let cancellationCalls = 0;
  w.native.cancel = async () => { cancellationCalls++; return "pending"; };
  await w.instance.tick(admission.run.id);
  const prepared = f.steps.steps(admission.run.id);
  expect(prepared).toHaveLength(1);
  expect(prepared[0]?.state).toBe("prepared");
  expect(typeof prepared[0]?.input).toBe("string");
  expect(new SqliteAgentBindings(f.db).get(admission.run.id)?.sessionId).toBe(admission.run.sessionId);
  expect(w.native.bindingsSeen).toEqual([]); // No ensureSession call, and therefore no native session lookup/create.
  expect(w.native.submitted).toEqual([]);
  const beforeStop = f.runs.get(admission.run.id);
  if (!beforeStop) throw new Error("Expected active run");
  f.service.stop("user", admission.run.id);
  const stopped = f.runs.get(admission.run.id);
  if (!stopped) throw new Error("Expected stopped run");
  expect(stopped.status).toBe("interrupted");
  expect(stopped.generation).toBeGreaterThan(beforeStop.generation);
  expect(f.steps.cancellation(admission.run.id)).toBe("pending");
  for (let i = 0; i < 3; i++) await w.instance.tick(admission.run.id);
  expect(f.steps.cancellation(admission.run.id)).toBe("settled");
  expect(cancellationCalls).toBe(0);
  expect(w.native.bindingsSeen).toEqual([]);
  expect(w.native.submitted).toEqual([]);
  expect(f.steps.steps(admission.run.id)).toEqual(prepared);
  expect(f.runs.get(admission.run.id)).toEqual(stopped);
  expect(f.store.getThought(admission.contribution.id)?.text).toBe("retain before native creation");
  expect(f.runs.reply(admission.run.id)).toBeNull();
}));

test("prepared successor does not hide earlier submitted work from cancellation", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "prior-submitted-step" });
  const w = worker(f, () => request("readThought", { id: "root" }));
  for (let i = 0; i < 20 && f.steps.steps(run.id).length < 2; i++) await w.instance.tick(run.id);
  const steps = f.steps.steps(run.id);
  expect(steps).toHaveLength(2);
  expect(steps[0]?.state).toBe("processed");
  expect(steps[1]?.state).toBe("prepared");
  expect(w.native.submitted).toHaveLength(1);
  f.service.stop("user", run.id);
  await w.instance.tick(run.id);
  expect(w.native.cancellations).toBe(1);
  expect(f.steps.cancellation(run.id)).toBe("settled");
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  expect(w.native.submitted).toHaveLength(1);
}));

test("positive cancellation cannot commit against a stale journal or a different binding", async () => fixture(async f => {
  const owned = await provenInterruptedWeave(f);
  // A new terminal generation invalidates the previously observed native proof's journal identity.
  f.db.query("UPDATE runs SET generation=generation+1 WHERE id=?").run(owned.run.id);
  const before = owned.snapshot();
  expect(() => owned.state.settleOrdinaryCancellation(owned.journal,owned.saved)).toThrow(RunFenceError);
  expect(owned.snapshot()).toEqual(before);
  const current = owned.bindings.cancellationJournal(owned.run.id,owned.prompt);
  const foreign = {...owned.saved,model:{...owned.saved.model,id:"foreign-model"}};
  expect(() => owned.state.settleOrdinaryCancellation(current,foreign)).toThrow(RunFenceError);
  expect(owned.snapshot()).toEqual(before);
  expect(await owned.adapter.cancel(owned.run.id,owned.saved,owned.prompt)).toBe("settled");
  owned.state.settleOrdinaryCancellation(current,owned.saved);
  expect(f.steps.cancellation(owned.run.id)).toBe("settled");
  expect(f.steps.steps(owned.run.id)).toEqual([expect.objectContaining({state:"completed",envelope:null,result:null})]);
}));

test("settlement transaction rolls back native-terminal bookkeeping on a later SQL failure", async () => fixture(async f => {
  const owned = await provenInterruptedWeave(f);
  const before = owned.snapshot();
  f.db.exec(`CREATE TRIGGER test_cancel_settlement_fault BEFORE UPDATE OF cancellation_state ON runs
    WHEN NEW.cancellation_state='settled' BEGIN SELECT RAISE(ABORT,'owned settlement fault'); END;`);
  try {
    expect(() => owned.state.settleOrdinaryCancellation(owned.journal,owned.saved)).toThrow(/owned settlement fault/);
    expect(owned.snapshot()).toEqual(before);
    expect(f.steps.cancellation(owned.run.id)).toBe("pending");
  } finally { f.db.exec("DROP TRIGGER test_cancel_settlement_fault"); }
  owned.state.settleOrdinaryCancellation(owned.journal,owned.saved);
  expect(f.steps.cancellation(owned.run.id)).toBe("settled");
  expect(f.steps.steps(owned.run.id)).toEqual([expect.objectContaining({state:"completed",envelope:null,result:null})]);
}));

test("positive native proof records unresolved steps even when the historical cancellation flag is already settled", async () => fixture(async f => {
  const owned = await provenInterruptedWeave(f);
  f.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=?", [owned.run.id]);
  const journal = owned.bindings.cancellationJournal(owned.run.id, owned.prompt);
  const runBefore = f.db.query("SELECT * FROM runs WHERE id=?").get(owned.run.id);
  const stepBefore = f.steps.steps(owned.run.id)[0];
  if (!stepBefore) throw new Error("Expected a historical step");
  expect(stepBefore.state).not.toBe("completed");
  owned.state.settleOrdinaryCancellation(journal, owned.saved);
  expect(f.steps.steps(owned.run.id)).toEqual([{ ...stepBefore, state: "completed" }]);
  expect(f.db.query("SELECT native_state FROM run_steps WHERE run_id=?").get(owned.run.id)).toEqual({ native_state: "completed" });
  expect(f.db.query("SELECT * FROM runs WHERE id=?").get(owned.run.id)).toEqual(runBefore);
  expect(f.runs.reply(owned.run.id)).toBeNull();
}));

test("historical settled proof still fences a stale journal and rolls back failed step bookkeeping", async () => fixture(async f => {
  const owned = await provenInterruptedWeave(f);
  f.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=?", [owned.run.id]);
  const stale = owned.bindings.cancellationJournal(owned.run.id, owned.prompt);
  f.db.run("UPDATE runs SET generation=generation+1 WHERE id=?", [owned.run.id]);
  const before = owned.snapshot();
  expect(() => owned.state.settleOrdinaryCancellation(stale, owned.saved)).toThrow(RunFenceError);
  expect(owned.snapshot()).toEqual(before);
  const current = owned.bindings.cancellationJournal(owned.run.id, owned.prompt);
  f.db.exec(`CREATE TRIGGER test_historical_settlement_fault BEFORE UPDATE OF native_state ON run_steps
    BEGIN SELECT RAISE(ABORT,'owned historical settlement fault'); END;`);
  try {
    expect(() => owned.state.settleOrdinaryCancellation(current, owned.saved)).toThrow(/owned historical settlement fault/);
    expect(owned.snapshot()).toEqual(before);
  } finally { f.db.exec("DROP TRIGGER test_historical_settlement_fault"); }
  owned.state.settleOrdinaryCancellation(current, owned.saved);
  expect(f.steps.steps(owned.run.id)).toEqual([expect.objectContaining({ state: "completed", envelope: null, result: null })]);
}));

test("worker reconciles a settled-but-unverified historical weave with the actual adapter without resubmission", async () => fixture(async f => {
  const owned = await provenInterruptedWeave(f);
  f.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=?", [owned.run.id]);
  const before = f.db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(owned.run.id);
  const restarted = worker(f, () => complete("must not publish"));
  restarted.native.cancel = (runId, value, prompt) => owned.adapter.cancel(runId, value, prompt);
  try {
    await restarted.instance.tick(owned.run.id);
    expect(f.steps.steps(owned.run.id)).toEqual([expect.objectContaining({ state: "completed", envelope: null, result: null })]);
    expect(f.db.query("SELECT native_state FROM run_steps WHERE run_id=?").get(owned.run.id)).toEqual({ native_state: "completed" });
    expect(f.db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(owned.run.id)).toEqual(before);
    expect(restarted.native.submitted).toEqual([]);
    expect(f.runs.reply(owned.run.id)).toBeNull();
  } finally { restarted.instance.pause(); await restarted.instance.drain(); }
}));

test("title-clear waits behind a started weave across successor preparation and worker restart", async () => fixture(async f => {
  const titles = new TitleService(new SqliteTitleRepository(f.db, { id: f.id, now }));
  titles.setUser("user", "root", "Existing title");
  const first = f.ops.admitWeave("user", { subjectId: "root", triggerId: "started-interpretation" });
  const w = worker(f, () => request("readThought", { id: "root" }));
  for (let i = 0; i < 20 && f.steps.steps(first.id).length < 2; i++) await w.instance.tick(first.id);
  const successor = f.steps.steps(first.id)[1];
  if (!successor || successor.input === null) throw new Error("Expected a prepared successor");
  expect(successor.state).toBe("prepared");
  expect(w.native.submitted).toHaveLength(1);
  expect(titles.setUser("user", "root", null)).toEqual({ title: null, titleAuthor: null });
  const waiting = f.db.query<{id:string}, []>("SELECT id FROM runs WHERE weave_subject_id='root' AND weave_trigger_id LIKE 'title-clear:%'").get();
  if (!waiting) throw new Error("Expected a durable title-clear invitation");
  const before = f.runs.get(waiting.id);
  if (!before) throw new Error("Expected the queued title-clear run");
  expect(before).toMatchObject({ status: "queued", generation: 0 });
  w.instance.pause(); await w.instance.drain();
  const restarted = worker(f, () => complete("done"));
  try {
    for (let i = 0; i < 3; i++) await restarted.instance.tick(waiting.id);
    expect(restarted.native.submitted).toEqual([]);
    expect(f.runs.get(waiting.id)).toEqual(before);
    for (let i = 0; i < 8 && restarted.native.submitted.length === 0; i++) await restarted.instance.tick(first.id);
    expect(restarted.native.submitted).toEqual([{ promptId: successor.promptId, input: successor.input }]);
    expect(f.runs.get(waiting.id)).toEqual(before);
    await drive(restarted.instance, f, first.id);
    expect(f.runs.get(first.id)?.status).toBe("completed");
    for (let i = 0; i < 8 && restarted.native.submitted.length < 2; i++) await restarted.instance.tick(waiting.id);
    expect(restarted.native.submitted.map(item => item.promptId)).toEqual([successor.promptId, before.promptId]);
  } finally { restarted.instance.pause(); await restarted.instance.drain(); }
}));

test("newer queued interpretation cannot dispatch before the oldest queued invitation", async () => fixture(async f => {
  const first = f.ops.admitWeave("user", { subjectId: "root", triggerId: "oldest" });
  const second = f.ops.admitWeave("user", { subjectId: "root", triggerId: "newer" });
  const w = worker(f, () => complete("done"));
  try {
    const before = f.runs.get(second.id);
    for (let i = 0; i < 4; i++) await w.instance.tick(second.id);
    expect(w.native.submitted).toEqual([]);
    expect(f.runs.get(second.id)).toEqual(before);
    for (let i = 0; i < 8 && w.native.submitted.length === 0; i++) await w.instance.tick(first.id);
    expect(w.native.submitted.map(item => item.promptId)).toEqual([first.promptId]);
    expect(f.runs.get(second.id)).toEqual(before);
  } finally { w.instance.pause(); await w.instance.drain(); }
}));

test("an unverified historical cancellation blocks a later queued weave from native dispatch", async () => fixture(async f => {
  const old = f.ops.admitWeave("user", { subjectId: "root", triggerId: "unverified-old" });
  f.db.query("UPDATE run_steps SET input=?,state='uncertain' WHERE run_id=?").run("old exact input", old.id);
  f.db.query("UPDATE runs SET status='interrupted',cancellation_state='settled' WHERE id=?").run(old.id);
  const waiting = f.ops.admitWeave("user", { subjectId: "root", triggerId: "waiting" });
  const w = worker(f, () => complete("must not run"));
  try {
    const before = f.runs.get(waiting.id);
    for (let i = 0; i < 4; i++) await w.instance.tick(waiting.id);
    expect(w.native.submitted).toEqual([]);
    expect(f.runs.get(waiting.id)).toEqual(before);
  } finally { w.instance.pause(); await w.instance.drain(); }
}));

for (const historicalSettled of [false, true]) test(`a prepared successor cannot hide an earlier dispatched weave without evidence, ${historicalSettled ? "historically settled" : "pending"}, including after worker restart`, async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "unverified-prior-step" });
  const w = worker(f, () => request("readThought", { id: "root" }));
  for (let i = 0; i < 20 && f.steps.steps(run.id).length < 2; i++) await w.instance.tick(run.id);
  expect(f.steps.steps(run.id).map(step => step.state)).toEqual(["processed", "prepared"]);
  expect(w.native.submitted).toHaveLength(1);
  const owned = binding(run);
  const session = { id: owned.sessionId, location: owned.location, model: owned.model, permissions: owned.permissions,
    metadata: { owner: "thoughtloom", runId: run.id, protocolVersion: "1" } };
  const client: PublicClient = {
    instructionList: async () => { throw new Error("Unexpected instruction list"); },
    instructionPut: async () => { throw new Error("Unexpected instruction put"); },
    instructionRemove: async () => { throw new Error("Unexpected instruction remove"); },
    serverInfo: async () => ({ version: "fixture" }), sessionCreate: async () => session, sessionGet: async () => session,
    prompt: async () => { throw new Error("Cancellation must not submit"); }, inbox: async () => [],
    history: async () => ({ data: [], cursor: {} }), active: async () => ({}),
    cancelInbox: async () => {}, interrupt: async () => ({ interrupted: false }),
  };
  const adapter = new OpenCodeAdapter(client, new SqliteAgentBindings(f.db), () => {});
  w.native.cancel = (runId, value, prompt) => adapter.cancel(runId, value, prompt);
  f.service.stop("user", run.id);
  if (historicalSettled) f.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=?", [run.id]);
  await w.instance.tick(run.id);
  expect(f.steps.cancellation(run.id)).toBe(historicalSettled ? "settled" : "pending");
  w.instance.pause();
  await w.instance.drain();
  const restarted = worker(f, () => complete("must not publish"));
  restarted.native.cancel = (runId, value, prompt) => adapter.cancel(runId, value, prompt);
  try {
    await restarted.instance.tick(run.id);
    expect(f.steps.cancellation(run.id)).toBe(historicalSettled ? "settled" : "pending");
    expect(f.runs.get(run.id)?.status).toBe("interrupted");
    expect(f.runs.reply(run.id)).toBeNull();
    expect(restarted.native.submitted).toEqual([]);
  } finally { restarted.instance.pause(); await restarted.instance.drain(); }
}));

test("terminal pending cancellation retries until settled without reviving or resubmitting", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "cancel-retry" });
  const w = worker(f, () => complete("late output"));
  let attempts = 0;
  w.native.cancel = async () => { attempts++; return attempts === 1 ? "pending" : "settled"; };
  for (let i = 0; i < 8 && w.native.submitted.length === 0; i++) await w.instance.tick(run.id);
  expect(w.native.submitted).toHaveLength(1);
  f.service.stop("user", run.id);
  await w.instance.tick(run.id);
  expect(attempts).toBe(1);
  expect(f.steps.cancellation(run.id)).toBe("pending");
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  await w.instance.tick(run.id);
  expect(attempts).toBe(2);
  expect(f.steps.cancellation(run.id)).toBe("settled");
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  expect(w.native.submitted).toHaveLength(1);
  expect(f.runs.reply(run.id)).toBeNull();
}));

test("retired interrupted weave cannot publish a previously observed late result or submit again", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "retired-late-result" });
  const w = worker(f, () => complete("late result must not be published"));
  w.native.cancel = async () => "pending";
  try {
    for (let i = 0; i < 20; i++) {
      const last = f.steps.steps(run.id).at(-1);
      if (last?.state === "completed" && last.envelope?.kind === "complete") break;
      await w.instance.tick(run.id);
    }
    expect(f.steps.steps(run.id).at(-1)?.envelope).toMatchObject({kind:"complete",reply:"late result must not be published"});
    f.service.stop("user", run.id);
    f.db.run("UPDATE runs SET weave_retired_at=? WHERE id=?", [now(),run.id]);
    const before = f.db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(run.id);
    const submitted = w.native.submitted.length;
    await w.instance.tick(run.id);
    expect(f.db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(run.id)).toEqual(before);
    expect(f.runs.reply(run.id)).toBeNull();
    expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='root'").get()).toEqual({n:0});
    expect(w.native.submitted).toHaveLength(submitted);
  } finally { w.instance.pause(); await w.instance.drain(); }
}));

test("malformed completed model output cannot become a fallback reply", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "question" });
  const w = worker(f, () => '{"version":1,"kind":"complete","reply":');
  await drive(w.instance, f, admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).not.toBe("completed");
  expect(f.runs.reply(admission.run.id)).toBeNull();
}));

test("valid reply without developments attaches once to the original contribution", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "clarify" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const w = worker(f, () => complete("clarifying question"));
  await drive(w.instance, f, admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).toBe("completed");
  expect(f.runs.reply(admission.run.id)).toEqual({ id: expect.any(String), text: "clarifying question", role: "fallback", state: "complete", thoughtIds: [admission.contribution.id] });
  expect(f.db.query("SELECT COUNT(*) AS n FROM run_issued_thoughts WHERE run_id=?").get(admission.run.id)).toEqual({ n: 0 });
  expect(w.native.submitted).toHaveLength(1);
}));

test("rejecting exposed input fences the session and settles cancellation instead of continuing", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "rejection" });
  const w = worker(f, () => request("interpretation", { text: "must not save", sourceIds: [] }));
  for (let i = 0; i < 8 && w.native.submitted.length === 0; i++) await w.instance.tick(run.id);
  expect(w.native.submitted).toHaveLength(1);
  expect(f.capabilities.fullReadWitnesses(run.id)).toContainEqual({ kind: "thought", id: "root" });
  f.rejection.rejectThought("user", "root");
  await w.instance.tick(run.id);
  await w.instance.tick(run.id);
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  expect(f.steps.cancellation(run.id)).toBe("settled");
  expect(w.native.cancellations).toBe(1);
  expect(w.native.submitted).toHaveLength(1);
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE text='must not save'").get()).toEqual({ n: 0 });
}));

for (const fence of ["stop", "reject"] as const) test(`${fence} fences a completed but unpublished Weaver outcome while retaining confirmed summary`, async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: `outcome-${fence}` });
  const outputs = [request("interpretation", { text: "Confirmed [source](https://example.test/one)", sourceIds: [] }), complete("A second source was inaccessible")];
  const w = worker(f, index => outputs[index] ?? complete("unexpected"));
  for (let i = 0; i < 20; i++) {
    const last = f.steps.steps(run.id).at(-1);
    if (last?.state === "completed" && last.envelope?.kind === "complete") break;
    await w.instance.tick(run.id);
  }
  expect(f.steps.steps(run.id).at(-1)).toMatchObject({ state: "completed", envelope: { kind: "complete", reply: "A second source was inaccessible" } });
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='root'").get()).toEqual({ n: 1 });
  if (fence === "stop") f.service.stop("user", run.id);
  else f.rejection.rejectThought("user", "root");
  await w.instance.tick(run.id);
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  expect(f.runs.reply(run.id)).toBeNull();
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='root'").get()).toEqual({ n: 1 });
}));
