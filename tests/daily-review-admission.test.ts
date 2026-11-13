import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dailyReviewCeiling, dailyReviewDate, selectDailyReviewSubjects, type DailyReviewCandidate } from "../src/domain/daily-review";
import { RunAdmissionService, RunFenceError } from "../src/domain/run";
import { SqliteDailyReviews } from "../src/storage/daily-review";
import { migrate } from "../src/storage/sqlite";
import { dailyReviewFixture, reviewPolicy } from "./fixtures/daily-review";

test.each([[0,0],[1,1],[4,1],[5,2],[12,3],[13,3],[1000,3]])("review ceiling for %i owned thoughts is %i", (count,expected) => {
  expect(dailyReviewCeiling(count,reviewPolicy)).toBe(expected);
});
test("review arithmetic refuses invalid counts and policies", () => {
  for (const count of [-1,1.5,NaN,Infinity]) expect(() => dailyReviewCeiling(count,reviewPolicy)).toThrow();
  for (const policy of [{rotationDays:0,maxPerDay:3},{rotationDays:4,maxPerDay:-1},{rotationDays:4.5,maxPerDay:3}]) {
    expect(() => dailyReviewCeiling(1,policy)).toThrow();
  }
});
test("review ordering is never-successful first, then oldest success, with fair attempts and binary ties", () => {
  const candidate = (id: string, lastReviewedAt: string | null, lastAttemptedAt: string | null = null, createdAt = "2030"): DailyReviewCandidate =>
    ({id,createdAt,lastReviewedAt,lastAttemptedAt});
  const input = [candidate("newer","2031-02"),candidate("failed-never",null,"2031-01"),candidate("old","2031-01"),
    candidate("z",null),candidate("a",null),candidate("early",null,null,"2029"),candidate("\u{10000}",null),candidate("\uE000",null)];
  expect(selectDailyReviewSubjects(input,100)).toEqual(["early","a","z","\uE000","\u{10000}","failed-never","old","newer"]);
  expect(input[0]?.id).toBe("newer");
  expect(selectDailyReviewSubjects(input,0)).toEqual([]);
});
test.each(["daily-review:","daily-review:2031-02-29","daily-review:2031-1-01","daily-review:2031-01-01:other","daily-review"]) (
  "malformed review trigger %s is not ordinary authority", trigger => expect(() => dailyReviewDate(trigger)).toThrow());

test("empty, unconfigured and entirely busy libraries reserve no day", async () => dailyReviewFixture(f => {
  expect(f.admit()).toMatchObject({kind:"empty"});
  f.seed("only"); expect(f.admit(f.clock.now,false)).toMatchObject({kind:"unconfigured"});
  const ordinary = f.ops.admitWeave("user",{subjectId:"only",triggerId:"owned-busy"});
  expect(f.admit()).toMatchObject({kind:"deferred"});
  expect(f.db.query("SELECT * FROM daily_review_batches").all()).toEqual([]);
  f.runs.stop(ordinary.id); expect(f.state.settleUnsubmitted(ordinary.id)).toBe(true);
  expect(f.admit()).toMatchObject({kind:"admitted"});
}));
test("busy subjects are skipped before limit while the ceiling counts the whole active text library", async () => dailyReviewFixture(f => {
  for (const id of ["a","b","c","d","e","rejected"]) f.seed(id);
  f.rejection.rejectThought("user","rejected");
  f.ops.admitWeave("user",{subjectId:"a",triggerId:"owned-busy"});
  const batch = f.admit(); expect(batch.kind).toBe("admitted");
  expect(f.db.query("SELECT eligible_count,ceiling,admitted_count FROM daily_review_batches").get()).toEqual({eligible_count:5,ceiling:2,admitted_count:2});
  expect(f.db.query("SELECT thought_id FROM daily_review_items ORDER BY position").all()).toEqual([{thought_id:"b"},{thought_id:"c"}]);
}));
test("sealed date is durable across connections/reopen and never refills failed slots or catches up missed dates", async () => dailyReviewFixture(f => {
  for (const id of ["a","b","c","d","e"]) f.seed(id);
  const batch = f.admit(); if (batch.kind !== "admitted") throw new Error("Expected batch");
  for (const id of batch.runIds) { f.runs.stop(id); f.state.settleUnsubmitted(id); }
  const other = new Database(f.path);
  try {
    migrate(other);
    const reviews = new SqliteDailyReviews(other,f.sources,reviewPolicy);
    expect(reviews.admitDueBatch(f.clock.now,true).kind).toBe("already-admitted");
    expect(reviews.admitDueBatch("2030-12-31T12:00:00Z",true).kind).toBe("already-admitted");
    expect(reviews.lastReviewedAt("a")).toBeNull();
  } finally { other.close(); }
  const reopened = new Database(f.path);
  try { expect(new SqliteDailyReviews(reopened,f.sources,reviewPolicy).admitDueBatch(f.clock.now,true).kind).toBe("already-admitted"); }
  finally { reopened.close(); }
  expect(f.admit("2031-01-04T12:00:00Z").kind).toBe("admitted");
  expect(f.db.query("SELECT review_date FROM daily_review_batches ORDER BY review_date").all()).toEqual([{review_date:"2031-01-01"},{review_date:"2031-01-04"}]);
  expect(f.db.query("SELECT thought_id FROM daily_review_items WHERE review_date='2031-01-04' ORDER BY position").all()).toEqual([{thought_id:"c"},{thought_id:"d"}]);
}));
test("admission failure rolls back the batch, every member and every run", async () => dailyReviewFixture(f => {
  for (const id of ["a","b","c","d","e"]) f.seed(id);
  f.db.exec(`CREATE TRIGGER owned_daily_fault BEFORE INSERT ON runs WHEN NEW.weave_subject_id='b' BEGIN SELECT RAISE(ABORT,'owned fault'); END;`);
  expect(() => f.admit()).toThrow();
  for (const table of ["daily_review_batches","daily_review_items","runs"]) expect(f.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
  f.db.exec("DROP TRIGGER owned_daily_fault"); expect(f.admit().kind).toBe("admitted");
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}));
test("unfinished creator Evolve work defers its contribution even after its discovery owner settles", async () => dailyReviewFixture(f => {
  f.seed("root");
  const admission = new RunAdmissionService({...f.sources,repository:f.runs}).admit("user","evolve",{parentId:"root",text:"Owned contribution"});
  if (!admission.contribution) throw new Error("Expected input");
  const owner = f.db.query<{id:string},[string]>("SELECT id FROM runs WHERE weave_subject_id=?").get(admission.contribution.id);
  if (!owner) throw new Error("Expected creation owner");
  f.runs.stop(owner.id); f.state.settleUnsubmitted(owner.id);
  f.rejection.rejectThought("user","root"); // Does not reject the contribution or fabricate creator settlement.
  expect(f.admit().kind).toBe("deferred");
  f.runs.stop(admission.run.id); expect(f.state.settleUnsubmitted(admission.run.id)).toBe(true);
  expect(f.admit().kind).toBe("admitted");
}));
test("daily reservations serialize later ordinary work without becoming interpretation history", async () => dailyReviewFixture(f => {
  f.seed("subject"); const batch = f.admit(); if (batch.kind !== "admitted") throw new Error("Expected batch");
  const review = batch.runIds[0]; if (!review) throw new Error("Expected review");
  const ordinary = f.ops.admitWeave("user",{subjectId:"subject",triggerId:"owned-later"});
  expect(() => f.runs.claim(ordinary.id)).toThrow(RunFenceError);
  const claim = f.prepare(review); f.complete(claim);
  expect(f.runs.claim(ordinary.id).runId).toBe(ordinary.id);
}));
test("successful rotation covers never-reviewed subjects before returning to the oldest completed reviews", async () => dailyReviewFixture(f => {
  for (const id of ["a","b","c","d","e"]) f.seed(id);
  for (const date of ["2031-01-01","2031-01-02"]) {
    const batch = f.admit(`${date}T12:00:00Z`); if (batch.kind !== "admitted") throw new Error("Expected batch");
    for (const id of batch.runIds) f.complete(f.prepare(id));
  }
  expect(f.admit("2031-01-03T12:00:00Z").kind).toBe("admitted");
  expect(f.db.query("SELECT thought_id FROM daily_review_items WHERE review_date='2031-01-03' ORDER BY position").all()).toEqual([{thought_id:"e"},{thought_id:"a"}]);
}));
test("an unsettled previous-day review is not admitted again or allowed to consume the next day's selection", async () => dailyReviewFixture(f => {
  f.seed("a"); f.seed("b"); const first = f.admit(); if (first.kind !== "admitted") throw new Error("Expected batch");
  expect(f.admit("2031-01-02T12:00:00Z").kind).toBe("admitted");
  expect(f.db.query("SELECT review_date,thought_id FROM daily_review_items ORDER BY review_date").all()).toEqual([
    {review_date:"2031-01-01",thought_id:"a"},{review_date:"2031-01-02",thought_id:"b"},
  ]);
}));
test("a historical settled flag without submitted-turn terminal evidence still blocks review admission", async () => dailyReviewFixture(f => {
  f.seed("a"); const ordinary = f.ops.admitWeave("user",{subjectId:"a",triggerId:"owned-uncertain"}), claim = f.runs.claim(ordinary.id);
  f.steps.prepare(claim,{promptId:ordinary.promptId,input:"Owned potentially dispatched input"});
  f.steps.setStepState(claim,ordinary.promptId,"submitting");
  f.runs.stop(ordinary.id); f.steps.settleCancellation(ordinary.id);
  expect(f.admit().kind).toBe("deferred");
  expect(f.db.query("SELECT * FROM daily_review_batches").all()).toEqual([]);
  f.db.run("INSERT INTO restore_fences VALUES ('run',?,?,?,'{}')",[ordinary.id,"a".repeat(64),f.clock.now]);
  expect(f.admit().kind).toBe("admitted");
}));
