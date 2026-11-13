import { expect, test } from "bun:test";
import { initialWorkerPrompt } from "../src/agent/worker-prompts";
import { RunForbiddenError } from "../src/domain/run";
import { parseEnvelope, ProtocolValidationError, type ProtocolEnvelope } from "../src/domain/run-protocol";
import { resolveWeavePurpose } from "../src/domain/weave-scheduling";
import type { InitialRunContext } from "../src/domain/run-context";
import { mediaPathFixture } from "./fixtures/media-path-worker";
import { SqliteDailyReviews } from "../src/storage/daily-review";

const trigger = "daily-review:2031-01-01";
const completion = {version:1,kind:"review-complete",titleCheck:"complete",connectionCheck:"complete"} as const;

test("daily review trigger resolves to its restricted purpose for text thoughts", () => {
  expect(resolveWeavePurpose("captured-original",trigger)).toBe("daily-review");
  expect(resolveWeavePurpose("ai-interpretation",trigger)).toBe("daily-review");
  expect(resolveWeavePurpose("captured-original","capture:owned")).toBe("ordinary");
});

test("review completion accepts exactly the two affirmative check markers", () => {
  expect(parseEnvelope(JSON.stringify(completion))).toEqual(completion);
});

const invalidCompletions: readonly Record<string,unknown>[] = [
  {version:1,kind:"review-complete",titleCheck:"complete"},
  {version:1,kind:"review-complete",connectionCheck:"complete"},
  {...completion,titleCheck:"partial"},
  {...completion,connectionCheck:"failed"},
  {...completion,titleCheck:true},
  {...completion,reply:"not a public reply"},
  {...completion,version:2},
];
test.each(invalidCompletions)("invalid or incomplete review completion is rejected", input => {
  expect(() => parseEnvelope(JSON.stringify(input))).toThrow(ProtocolValidationError);
});

test("duplicate completion markers are rejected even when both values are complete", () => {
  expect(() => parseEnvelope('{"version":1,"kind":"review-complete","titleCheck":"complete","titleCheck":"complete","connectionCheck":"complete"}')).toThrow(ProtocolValidationError);
});

test("daily prompt advertises only title fill and scoped connection discovery with review completion", async () => mediaPathFixture(async f => {
  const subject = f.store.getThought(f.subjectId);
  if (!subject) throw new Error("Expected owned text subject");
  // Exercise the existing JSON prompt boundary with the proposed new purpose before its TS union exists.
  const context = JSON.parse(JSON.stringify({job:{kind:"weave",subjectId:subject.id,purpose:"daily-review"},thoughts:[subject],connections:[],responses:[]})) as InitialRunContext;
  const prompt = JSON.parse(initialWorkerPrompt(context)) as {capabilities:{capability:string}[];instructions:string[]};
  expect(prompt.capabilities.map(item => item.capability).sort()).toEqual(["title-fill","search","readThought","readConnection","readResponse","connection"].sort());
  const guidance = prompt.instructions.join(" ");
  expect(guidance).toContain("review-complete");
  expect(guidance).toContain("titleCheck");
  expect(guidance).toContain("connectionCheck");
  expect(guidance).toMatch(/fixed subject/i);
  expect(guidance).toMatch(/not.*(?:public|full reply|searchable)/i);
  expect(prompt.capabilities.map(item => item.capability)).not.toContain("interpretation");
  expect(prompt.capabilities.map(item => item.capability)).not.toContain("development");
},null));

test("a fabricated daily trigger without durable batch membership cannot admit review work", async () => mediaPathFixture(async f => {
  const before = f.db.query("SELECT id FROM runs ORDER BY rowid").all();
  expect(() => f.ops.admitWeave("user",{subjectId:f.subjectId,triggerId:trigger})).toThrow();
  expect(f.db.query("SELECT id FROM runs ORDER BY rowid").all()).toEqual(before);
},null));

test("raw media descriptors do not enter review membership or its library count", async () => mediaPathFixture(async f => {
  const reviews = new SqliteDailyReviews(f.db,f.sources,{rotationDays:2,maxPerDay:2});
  expect(reviews.admitDueBatch(f.sources.now(),true).kind).toBe("admitted");
  expect(f.db.query("SELECT eligible_count FROM daily_review_batches").get()).toEqual({eligible_count:1});
  expect(f.db.query("SELECT thought_id FROM daily_review_items").all()).toEqual([{thought_id:f.subjectId}]);
},null));

test.each(["ordinary","evolve","connection-only","export"] as const)("review-complete cannot finalize %s work", async kind => mediaPathFixture(async f => {
  let run;
  if (kind === "ordinary") run = f.ops.admitWeave("user",{subjectId:f.subjectId,triggerId:"owned-ordinary"});
  else if (kind === "export") run = f.exports.admit("user",{request:"Owned export"});
  else {
    const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned contribution"});
    if (kind === "evolve") run = admission.run;
    else {
      if (!admission.contribution) throw new Error("Expected owned contribution");
      const owner = f.db.query<{id:string},[string]>("SELECT id FROM runs WHERE weave_subject_id=? AND kind='weave'").get(admission.contribution.id);
      if (!owner) throw new Error("Expected existing connection-only owner");
      run = f.run(owner.id);
    }
  }
  // Parse from JSON to exercise the same envelope boundary without importing an unimplemented type.
  const envelope = JSON.parse(JSON.stringify(completion)) as ProtocolEnvelope;
  const claim = f.runs.claim(run.id);
  f.steps.prepare(claim,{promptId:run.promptId,input:"Owned test prompt"});
  expect(() => f.steps.completeStep(claim,run.promptId,envelope)).toThrow(RunForbiddenError);
  expect(f.steps.steps(run.id)[0]?.envelope).toBeNull();
  expect(f.runs.reply(run.id)).toBeNull();
},null));
