import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { RunForbiddenError } from "../src/domain/run";
import { initialWorkerPrompt } from "../src/agent/worker-prompts";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { SqliteScheduledTitles } from "../src/storage/title-scheduling";
import { SqliteReinterpretations } from "../src/storage/reinterpretation";
import { ScriptedClient, config as agent } from "./agentic-search-capability-fixture";
import { dailyReviewFixture } from "./fixtures/daily-review";
import { mediaPathFixture, pathBinding } from "./fixtures/media-path-worker";
import type { CapabilityRequest } from "../src/domain/capability";

const credentials = {user:"owned-title-user-012345678901234567890",ai:"owned-title-agent-01234567890123456789"};
const now = "2031-01-01T12:00:00.000Z";
type ScheduledRun = {id:string;subjectId:string;triggerId:string;sessionId:string;promptId:string;scheduleKind:"title-only" | "connection-review" | null};

function scheduled(db: Database): ScheduledRun[] {
  return db.query<ScheduledRun,[]>(`SELECT id,weave_subject_id AS subjectId,weave_trigger_id AS triggerId,
    session_id AS sessionId,prompt_id AS promptId,weave_schedule_kind AS scheduleKind FROM runs WHERE kind='weave' ORDER BY rowid`).all();
}

async function daemonFixture(path: string, mediaDirectory: string, client: ScriptedClient,
  action: (pulse: () => void) => Promise<void>, unavailable = false, time = now): Promise<void> {
  let callback: (() => void) | undefined, daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({dbPath:path,mediaDir:mediaDirectory,port:0,credentials,agent},() => {},{
      now:() => time,logSink:() => {},resolveAgentService:async () => {
        if (unavailable) throw new Error("Owned service unavailable");
        return {url:"http://127.0.0.1:44991"};
      },
      createPublicClient:() => client,startTimer:poll => { callback = poll; return () => {}; },
    });
    await action(() => callback?.());
  } finally { await daemon?.stop(); }
}

async function waitFor(predicate: () => boolean, pulse: () => void): Promise<boolean> {
  for (let i=0;i<400;i++) { if (predicate()) return true; pulse(); await Bun.sleep(5); }
  return predicate();
}

test("title admissions are independently bounded, skip unavailable subjects, and survive same-day restart", async () => dailyReviewFixture(async f => {
  for (let i=0;i<25;i++) f.seed(`eligible-${String(i).padStart(2,"0")}`);
  f.seed("already-titled"); f.titles.setUser("user","already-titled","User label");
  f.seed("rejected"); f.rejection.rejectThought("user","rejected");
  f.seed("busy"); const busy = f.ops.admitWeave("user",{subjectId:"busy",triggerId:"owned-uncertain"});
  const claim = f.runs.claim(busy.id);
  f.steps.prepare(claim,{promptId:busy.promptId,input:"Owned potentially dispatched prompt"});
  f.steps.setStepState(claim,busy.promptId,"submitting");
  f.runs.stop(busy.id); f.steps.settleCancellation(busy.id); // Settled flag without terminal proof is not safe.
  const unavailable = new ScriptedClient(() => { throw new Error("Unexpected prompt"); });
  // Hold native execution outside the fixture: admission must be durable even when the service is unavailable.
  let before: ScheduledRun[] = [];
  await daemonFixture(f.path,f.media,unavailable,async pulse => {
    expect(await waitFor(() => scheduled(f.db).filter(run => run.scheduleKind === "title-only").length === 20 &&
      scheduled(f.db).some(run => run.scheduleKind === "connection-review"),pulse)).toBe(true);
    before = scheduled(f.db);
    const titles = before.filter(run => run.scheduleKind === "title-only");
    const reviews = before.filter(run => run.scheduleKind === "connection-review");
    expect(titles).toHaveLength(20); expect(reviews).toHaveLength(1);
    expect(titles.some(run => ["already-titled","rejected","busy"].includes(run.subjectId))).toBe(false);
    expect(reviews.some(run => ["rejected","busy"].includes(run.subjectId))).toBe(false);
    expect(new Set(titles.map(run => run.subjectId)).size).toBe(20);
    expect(unavailable.prompts).toEqual([]);
  },true);
  await daemonFixture(f.path,f.media,unavailable,async pulse => {
    for (let i=0;i<20;i++) { pulse(); await Bun.sleep(5); }
    expect(scheduled(f.db)).toEqual(before);
    expect(unavailable.prompts).toEqual([]);
  },true);
}));

test("new scheduled connection review has no title authority", async () => dailyReviewFixture(f => {
  f.seed("subject");
  const batch = f.admit();
  if (batch.kind !== "admitted") throw new Error("Expected an owned connection review");
  const runId = batch.runIds[0]; if (!runId) throw new Error("Expected one review");
  const claim = f.runs.claim(runId);
  const step = f.state.prepareInitial(claim,initialWorkerPrompt);
  if (step.input === null) throw new Error("Expected prepared review input");
  const prompt = JSON.parse(step.input) as {capabilities:{capability:string}[];instructions:string[]};
  expect(prompt.capabilities.map(item => item.capability)).not.toContain("title-fill");
  expect(prompt.instructions.join(" ")).not.toContain("titleCheck");
  const title = {capability:"title-fill",arguments:{title:"Forbidden scheduled title"}} as const;
  f.steps.completeStep(claim,step.promptId,{version:1,kind:"request",request:title});
  expect(() => f.capabilities.dispatch(claim,step.promptId,title)).toThrow(RunForbiddenError);
  expect(f.store.getThought("subject")?.title).toBeNull();
}));

test("a scheduled late fill preserves a concurrent user title and completes internally", async () => dailyReviewFixture(f => {
  f.seed("subject");
  const batch = new SqliteScheduledTitles(f.db,f.sources).admitDueBatch(now,true);
  if (batch.kind !== "admitted" || !batch.runIds[0]) throw new Error("Expected scheduled title work");
  const runId = batch.runIds[0], claim = f.runs.claim(runId), step = f.state.prepareInitial(claim,initialWorkerPrompt);
  const request = {capability:"title-fill",arguments:{title:"Late generated title"}} as const;
  f.steps.completeStep(claim,step.promptId,{version:1,kind:"request",request});
  f.titles.setUser("user","subject","User title");
  const result = f.capabilities.dispatch(claim,step.promptId,request);
  expect(result).toEqual({type:"title-fill",status:"unchanged"});
  const next = f.steps.advance(claim,step.promptId,result,{promptId:f.sources.id(),input:"Owned confirmed result"});
  f.steps.completeStep(claim,next.promptId,{version:1,kind:"complete",reply:"Title exists"});
  f.state.finish(claim,next.promptId);
  expect(f.runs.get(runId)?.status).toBe("completed");
  expect(f.store.getThought("subject")).toMatchObject({title:"User title",titleAuthor:"user"});
  expect(f.runs.reply(runId)).toBeNull();
}));

test.each([
  {capability:"search",arguments:{query:"other"}},
  {capability:"readThought",arguments:{id:"other"}},
  {capability:"interpretation",arguments:{text:"Forbidden output",sourceIds:[]}},
  {capability:"connection",arguments:{fromId:"subject",toId:"other",category:"related",explanation:"Forbidden relation",sourceIds:[]}},
] satisfies readonly CapabilityRequest[])("scheduled title worker refuses $capability even with normal native permissions", async request => dailyReviewFixture(f => {
  f.seed("subject","2029-01-01T00:00:00.000Z"); f.seed("other");
  const batch = new SqliteScheduledTitles(f.db,f.sources).admitDueBatch(now,true);
  if (batch.kind !== "admitted" || !batch.runIds[0]) throw new Error("Expected scheduled title work");
  const run = f.run(batch.runIds[0]), claim = f.runs.claim(run.id);
  const step = f.state.prepareInitial(claim,context => initialWorkerPrompt(context,pathBinding(run,f.dir)));
  if (!step.input) throw new Error("Expected scheduled title input");
  const prompt = JSON.parse(step.input) as {capabilities:{capability:string}[]};
  expect(prompt.capabilities.map(item => item.capability)).toEqual(["title-fill"]);
  expect(step.input).toContain("operator-configured native tools");
  f.steps.completeStep(claim,step.promptId,{version:1,kind:"request",request});
  expect(() => f.capabilities.dispatch(claim,step.promptId,request)).toThrow(RunForbiddenError);
  expect(f.steps.steps(run.id)[0]?.result).toBeNull();
  expect(f.ops.stepReceipt(run.id,step.promptId)).toBeNull();
  expect(f.db.query("SELECT id FROM connections").all()).toEqual([]);
  expect(f.store.getThought("subject")?.title).toBeNull();
}));

test("failed settled title work gets a new identity on a later day only", async () => dailyReviewFixture(f => {
  f.seed("subject");
  const scheduler = new SqliteScheduledTitles(f.db,f.sources), first = scheduler.admitDueBatch(now,true);
  if (first.kind !== "admitted" || !first.runIds[0]) throw new Error("Expected title attempt");
  const firstId = first.runIds[0], claim = f.runs.claim(firstId);
  f.state.prepareInitial(claim,initialWorkerPrompt);
  f.ops.fail(claim);
  expect(f.state.settleUnsubmitted(firstId)).toBe(true);
  expect(scheduler.admitDueBatch(now,true).kind).toBe("already-admitted");
  const next = scheduler.admitDueBatch("2031-01-02T12:00:00.000Z",true);
  if (next.kind !== "admitted" || !next.runIds[0]) throw new Error("Expected a later title attempt");
  expect(next.runIds[0]).not.toBe(firstId);
  expect(f.run(firstId).status).toBe("failed");
  expect(f.store.getThought("subject")?.title).toBeNull();
}));

test("title selection orders unattempted subjects by creation and binary ID before retrying older attempts", async () => dailyReviewFixture(f => {
  for (let i=20;i>=0;i--) f.seed(`item-${String(i).padStart(2,"0")}`,"2030-01-02T00:00:00.000Z");
  f.seed("early","2030-01-01T00:00:00.000Z");
  const scheduler = new SqliteScheduledTitles(f.db,f.sources), first = scheduler.admitDueBatch(now,true);
  if (first.kind !== "admitted") throw new Error("Expected initial title batch");
  const subjects = (ids: readonly string[]) => ids.map(id => f.ops.weaveIntent(id)?.subjectId);
  expect(subjects(first.runIds)).toEqual(["early",...Array.from({length:19},(_,i) => `item-${String(i).padStart(2,"0")}`)]);
  for (const id of first.runIds) { f.runs.stop(id); expect(f.state.settleUnsubmitted(id)).toBe(true); }
  const next = scheduler.admitDueBatch("2031-01-02T12:00:00.000Z",true);
  if (next.kind !== "admitted") throw new Error("Expected next title batch");
  expect(subjects(next.runIds)).toEqual(["item-19","item-20","early",...Array.from({length:17},(_,i) => `item-${String(i).padStart(2,"0")}`)]);
}));

test("a retired interpretation and unrelated title admission do not block its replacement", async () => dailyReviewFixture(f => {
  f.seed("subject"); f.seed("other");
  const old = f.ops.admitWeave("user",{subjectId:"subject",triggerId:"reinterpret:legacy"}), claim = f.runs.claim(old.id);
  f.state.prepareInitial(claim,initialWorkerPrompt); f.ops.fail(claim);
  new SqliteReinterpretations(f.db,f.sources).prepareRetirement("subject",old.id)();
  const replacement = f.ops.admitWeave("user",{subjectId:"subject",triggerId:"reinterpret:fresh"});
  const titles = new SqliteScheduledTitles(f.db,f.sources).admitDueBatch(now,true);
  if (titles.kind !== "admitted" || !titles.runIds[0]) throw new Error("Expected unrelated title work");
  expect(titles.runIds.map(id => f.ops.weaveIntent(id)?.subjectId)).toEqual(["other"]);
  expect(f.state.canDispatch(replacement.id)).toBe(true);
  expect(f.runs.claim(replacement.id).runId).toBe(replacement.id);
  expect(f.run(old.id).status).toBe("failed");
}));

test("a no-change scheduled connection review completes without a title check or public reply", async () => dailyReviewFixture(f => {
  f.seed("subject");
  const batch = f.admit();
  if (batch.kind !== "admitted" || !batch.runIds[0]) throw new Error("Expected an owned review");
  const runId = batch.runIds[0], claim = f.runs.claim(runId);
  const step = f.state.prepareInitial(claim,initialWorkerPrompt);
  f.steps.completeStep(claim,step.promptId,{version:1,kind:"complete",reply:"No useful connection"});
  f.state.finish(claim,step.promptId);
  expect(f.runs.get(runId)?.status).toBe("completed");
  expect(f.reviews.lastReviewedAt("subject")).toBe("2031-01-01T12:00:00.000Z");
  expect(f.store.getThought("subject")?.title).toBeNull();
  expect(f.runs.reply(runId)).toBeNull();
}));

test("title scheduling handles retained media without opening its original", async () => mediaPathFixture(async f => {
  f.rejection.rejectThought("user",f.subjectId);
  const held = `${f.path}.title-test-held`;
  await rename(f.path,held);
  const client = new ScriptedClient((_index,input) => {
    const prompt = JSON.parse(input) as {kind:string;request?:{capability:string}};
    if (prompt.kind === "job") return {version:1,kind:"request",request:{capability:"title-fill",arguments:{title:"Owned media label"}}};
    return {version:1,kind:"complete",reply:"Title saved"};
  });
  try {
    await daemonFixture(f.db.filename,f.directory,client,async pulse => {
      const filled = await waitFor(() => f.store.getThought(f.source.id)?.title === "Owned media label",pulse);
      expect(filled).toBe(true);
      const titleRun = scheduled(f.db).find(run => run.scheduleKind === "title-only");
      if (!titleRun) throw new Error("Expected the scheduled media title run");
      expect(await waitFor(() => f.run(titleRun.id).status === "completed",pulse)).toBe(true);
      expect(f.runs.reply(titleRun.id)).toBeNull();
      const initial = client.prompts.find(prompt => JSON.parse(prompt.text).kind === "job");
      if (!initial) throw new Error("Expected a scheduled media title prompt");
      const prompt = JSON.parse(initial.text) as {capabilities:{capability:string}[];originals?:unknown;context:{thoughts:{id:string}[]}};
      expect(prompt.capabilities.map(item => item.capability)).toEqual(["title-fill"]);
      expect(prompt.originals).toBeUndefined();
      expect(prompt.context.thoughts.map(thought => thought.id)).toEqual([f.source.id]);
      expect(initial.text).not.toContain(f.path);
      expect(client.scriptErrors).toEqual([]);
    });
  } finally { await rename(held,f.path); }
},null));

test("a settled untitled media attempt retries on a later day, not on the same day", async () => mediaPathFixture(async f => {
  f.rejection.rejectThought("user",f.subjectId);
  const client = new ScriptedClient(() => { throw new Error("Unavailable native service must not submit"); });
  let first: ScheduledRun | undefined;
  await daemonFixture(f.db.filename,f.directory,client,async pulse => {
    expect(await waitFor(() => scheduled(f.db).length > 0,pulse)).toBe(true);
    const jobs = scheduled(f.db);
    expect(jobs).toHaveLength(1);
    first = jobs[0];
    if (!first) throw new Error("Expected scheduled media title attempt");
    expect(first.subjectId).toBe(f.source.id);
    f.runs.stop(first.id);
    expect(new SqliteRunWorkerState(f.db,f.sources).settleUnsubmitted(first.id)).toBe(true);
  },true);
  if (!first) throw new Error("Expected the first scheduled media title attempt");
  const original = first;
  await daemonFixture(f.db.filename,f.directory,client,async pulse => {
    for (let i=0;i<20;i++) { pulse(); await Bun.sleep(5); }
    expect(scheduled(f.db)).toEqual([original]);
  },true);
  await daemonFixture(f.db.filename,f.directory,client,async pulse => {
    expect(await waitFor(() => scheduled(f.db).length === 2,pulse)).toBe(true);
    const jobs = scheduled(f.db);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual(original);
    expect(jobs[1]?.subjectId).toBe(f.source.id);
    expect(jobs[1]?.id).not.toBe(first?.id);
    expect(jobs[1]?.promptId).not.toBe(first?.promptId);
    expect(client.prompts).toEqual([]);
    expect(f.store.getThought(f.source.id)?.title).toBeNull();
  },true,"2031-01-02T12:00:00.000Z");
},null));
