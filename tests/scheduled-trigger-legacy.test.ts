import { expect, test } from "bun:test";
import type { RunRecord } from "../src/domain/run";
import { insertRun } from "../src/storage/run-record";
import { migrate } from "../src/storage/sqlite";
import { SqliteScheduledTitles } from "../src/storage/title-scheduling";
import { initialWorkerPrompt } from "../src/agent/worker-prompts";
import { dailyReviewFixture } from "./fixtures/daily-review";

test.each(["scheduled-title:2031-01-01","connection-review:2031-01-01","scheduled-title:not-a-date","connection-review:not-a-date"] as const)(
  "predecessor ordinary weave with previously unrestricted trigger %s retains its purpose", async trigger => dailyReviewFixture(f => {
    f.seed("subject");
    // The predecessor did not reserve either trigger. Construct the old run before applying the new authority trigger.
    f.db.exec("DROP TRIGGER daily_review_run_membership");
    const run: RunRecord = {id:f.sources.id(),kind:"weave",status:"queued",sessionId:f.sources.id(),promptId:f.sources.id(),
      createdAt:f.clock.now,generation:0,inputThoughtId:null,nativeState:"unknown"};
    insertRun(f.db,run,{subjectId:"subject",triggerId:trigger});
    const identity = f.db.query("SELECT * FROM runs WHERE id=?").get(run.id);
    const steps = f.db.query("SELECT * FROM run_steps WHERE run_id=?").all(run.id);
    migrate(f.db,f.sources.logger);
    expect(f.db.query("SELECT * FROM runs WHERE id=?").get(run.id)).toEqual(identity);
    expect(f.db.query("SELECT * FROM run_steps WHERE run_id=?").all(run.id)).toEqual(steps);
    const claim = f.prepare(run.id);
    const input = f.steps.steps(claim.runId)[0]?.input;
    if (!input) throw new Error("Expected predecessor ordinary prompt");
    const prompt = JSON.parse(input) as {capabilities:{capability:string}[]};
    expect(prompt.capabilities.map(item => item.capability)).toContain("interpretation");
  }),
);

test("legacy collision neither seals the title day nor aliases the new scheduled identity", async () => dailyReviewFixture(f => {
  f.seed("subject");
  const triggerId = "scheduled-title:2031-01-01";
  const legacy = f.ops.admitWeave("user",{subjectId:"subject",triggerId});
  const claim = f.runs.claim(legacy.id); f.state.prepareInitial(claim,initialWorkerPrompt);
  f.ops.fail(claim); expect(f.state.settleUnsubmitted(legacy.id)).toBe(true);
  const scheduled = new SqliteScheduledTitles(f.db,f.sources).admitDueBatch(f.clock.now,true);
  if (scheduled.kind !== "admitted" || !scheduled.runIds[0]) throw new Error("Expected separate scheduled title");
  expect(scheduled.runIds[0]).not.toBe(legacy.id);
  expect(f.ops.admitWeave("user",{subjectId:"subject",triggerId}).id).toBe(legacy.id);
  expect(f.db.query("SELECT weave_schedule_kind FROM runs WHERE weave_subject_id='subject' AND weave_trigger_id=? ORDER BY rowid").all(triggerId))
    .toEqual([{weave_schedule_kind:null},{weave_schedule_kind:"title-only"}]);
  expect(() => f.db.run("UPDATE runs SET weave_schedule_kind='title-only' WHERE id=?",[legacy.id])).toThrow();
  expect(() => f.db.run("UPDATE runs SET weave_schedule_kind=NULL WHERE id=?",[scheduled.runIds[0]])).toThrow();
}));

test("scheduled marker cannot claim the wrong trigger or unowned connection review", async () => dailyReviewFixture(f => {
  f.seed("subject");
  const fresh = (): RunRecord => ({id:f.sources.id(),kind:"weave",status:"queued",sessionId:f.sources.id(),promptId:f.sources.id(),
    createdAt:f.clock.now,generation:0,inputThoughtId:null,nativeState:"unknown"});
  expect(() => insertRun(f.db,fresh(),{subjectId:"subject",triggerId:"connection-review:2031-01-01"},"title-only")).toThrow();
  expect(() => insertRun(f.db,fresh(),{subjectId:"subject",triggerId:"scheduled-title:2031-01-01"},"connection-review")).toThrow();
  expect(() => insertRun(f.db,fresh(),{subjectId:"subject",triggerId:"connection-review:2031-01-01"},"connection-review")).toThrow();
  expect(() => insertRun(f.db,fresh(),{subjectId:"subject",triggerId:"scheduled-title:2031-02-29"},"title-only")).toThrow();
  expect(f.db.query("SELECT id FROM runs").all()).toEqual([]);
}));

test("a legacy connection-review-shaped trigger coexists with a real review and replays only its own namespace", async () => dailyReviewFixture(f => {
  f.seed("subject");
  const triggerId = "connection-review:2031-01-01";
  const legacy = f.ops.admitWeave("user",{subjectId:"subject",triggerId}), claim = f.runs.claim(legacy.id);
  f.state.prepareInitial(claim,initialWorkerPrompt); f.ops.fail(claim);
  expect(f.state.settleUnsubmitted(legacy.id)).toBe(true);
  const review = f.admit();
  if (review.kind !== "admitted" || !review.runIds[0]) throw new Error("Expected a scheduled review");
  expect(review.runIds[0]).not.toBe(legacy.id);
  expect(f.ops.admitWeave("user",{subjectId:"subject",triggerId}).id).toBe(legacy.id);
  expect(f.db.query("SELECT weave_schedule_kind FROM runs WHERE weave_subject_id='subject' AND weave_trigger_id=? ORDER BY rowid").all(triggerId))
    .toEqual([{weave_schedule_kind:null},{weave_schedule_kind:"connection-review"}]);
}));

test.each(["scheduled-title:2031-01-01","connection-review:not-a-date"] as const)(
  "predecessor receipt and prepared successor retain their exact ordinary identity for %s", async triggerId => dailyReviewFixture(f => {
    f.seed("subject");
    const run = f.ops.admitWeave("user",{subjectId:"subject",triggerId}), claim = f.runs.claim(run.id);
    const step = f.state.prepareInitial(claim,initialWorkerPrompt);
    const request = {capability:"title-fill",arguments:{title:"Historical title"}} as const;
    f.steps.completeStep(claim,step.promptId,{version:1,kind:"request",request});
    const result = f.capabilities.dispatch(claim,step.promptId,request);
    const next = f.steps.advance(claim,step.promptId,result,{promptId:f.sources.id(),input:"Exact predecessor successor bytes"});
    const history = f.steps.steps(run.id), receipt = f.ops.stepReceipt(run.id,step.promptId);
    migrate(f.db,f.sources.logger);
    expect(f.steps.steps(run.id)).toEqual(history);
    expect(f.ops.stepReceipt(run.id,step.promptId)).toEqual(receipt);
    expect(f.db.query("SELECT weave_schedule_kind FROM runs WHERE id=?").get(run.id)).toEqual({weave_schedule_kind:null});
    f.steps.completeStep(claim,next.promptId,{version:1,kind:"complete",reply:"Historical outcome"});
    f.state.finish(claim,next.promptId);
    expect(f.runs.get(run.id)?.status).toBe("completed");
    expect(f.runs.reply(run.id)).toMatchObject({text:"Historical outcome",state:"complete"});
  }),
);
