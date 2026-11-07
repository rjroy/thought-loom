import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RunForbiddenError } from "../src/domain/run";
import { SqliteMediaAdmissions } from "../src/storage/media-admission";
import type { MediaSourceWrite } from "../src/storage/media-source";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { mediaAdmissionFixture, mediaAdmissionInput, mediaAdmissionSnapshot } from "./fixtures/media-admission";

test("media admission commits the source and its normal queued weave together", async () => mediaAdmissionFixture(f => {
  const input = mediaAdmissionInput(), admission = f.admissions.admit("user",input);
  expect(admission).toMatchObject({thought:input.thought,replayed:false,run:{kind:"weave",status:"queued",generation:0,inputThoughtId:null}});
  expect(f.store.getThought(input.thought.id)).toEqual(input.thought);
  expect(new SqliteRunOperations(f.db,f.sources).weaveIntent(admission.run.id)).toEqual({
    subjectId:input.thought.id,triggerId:`media-import:${input.thought.mediaSource.id}`,
  });
  expect(new SqliteRunProtocolRepository(f.db).steps(admission.run.id)).toEqual([{
    runId:admission.run.id,position:0,promptId:admission.run.promptId,input:null,state:"prepared",envelope:null,result:null,
  }]);
  expect(f.db.query("SELECT request_key,sha256 FROM media_sources").all()).toEqual([{request_key:input.requestKey,sha256:input.sha256}]);
  expect(f.db.query("SELECT thought_id,title,title_author FROM thought_titles").all()).toEqual([{thought_id:input.thought.id,title:null,title_author:null}]);
  expect(f.db.query("SELECT thought_id FROM thought_source_seals").all()).toEqual([{thought_id:input.thought.id}]);
  for (const table of ["thought_sources","agent_bindings","run_context","run_operation_receipts","run_issued_thoughts"]) {
    expect(f.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
  }
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}));

test("a real initial-step SQL fault rolls back the complete new source and weave on both connections", async () => mediaAdmissionFixture(f => {
  f.store.saveMediaSource(mediaAdmissionInput(9));
  const before = mediaAdmissionSnapshot(f.db), input = mediaAdmissionInput();
  f.db.exec(`CREATE TRIGGER fixture_media_step_failure AFTER INSERT ON run_steps
    WHEN EXISTS(SELECT 1 FROM runs run JOIN media_sources source ON source.source_thought_id=run.weave_subject_id
      WHERE run.id=NEW.run_id AND source.request_key='media-upload-0')
    BEGIN SELECT RAISE(ABORT,'injected after source weave step'); END`);
  expect(() => f.admissions.admit("user",input)).toThrow("injected after source weave step");
  expect(f.db.inTransaction).toBe(false);
  expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
  expect(mediaAdmissionSnapshot(f.other)).toEqual(before);
  expect(f.store.getThought(input.thought.id)).toBeNull();
  f.db.exec("DROP TRIGGER fixture_media_step_failure");
  expect(f.admissions.admit("user",input).replayed).toBe(false);
}));

test("source admission replay preserves identities across connections and migration/reopen", async () => mediaAdmissionFixture(f => {
  const input = mediaAdmissionInput(), first = f.admissions.admit("user",input), before = mediaAdmissionSnapshot(f.db);
  const fresh = mediaAdmissionInput(1);
  expect(f.second.admit("user",{...fresh,requestKey:input.requestKey})).toEqual({...first,replayed:true});
  expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
  const reopened = new Database(f.path);
  try {
    migrate(reopened,f.sources.logger); migrate(reopened,f.sources.logger);
    expect(mediaAdmissionSnapshot(reopened)).toEqual(before);
    expect(new SqliteMediaAdmissions(reopened,f.sources).admit("user",input)).toEqual({...first,replayed:true});
    expect(new SqliteStore(reopened).getThought(first.thought.id)).toEqual(first.thought);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { reopened.close(); }
}));

const conflicts: readonly {name:string;change:(input:MediaSourceWrite) => MediaSourceWrite}[] = [
  {name:"digest",change:input => ({...input,sha256:input.sha256.map((byte,index) => index === 0 ? byte ^ 255 : byte)})},
  {name:"filename",change:input => ({...input,thought:{...input.thought,mediaSource:{...input.thought.mediaSource,name:"different.png"}}})},
  {name:"MIME",change:input => ({...input,thought:{...input.thought,mediaSource:{...input.thought.mediaSource,mimeType:"image/jpeg"}}})},
  {name:"length",change:input => ({...input,thought:{...input.thought,mediaSource:{...input.thought.mediaSource,byteLength:input.thought.mediaSource.byteLength + 1}}})},
  {name:"clarification",change:input => ({...input,thought:{...input.thought,mediaSource:{...input.thought.mediaSource,clarification:"Different instructions",clarificationAuthor:"user"}}})},
];
for (const {name,change} of conflicts) test(`source admission rejects conflicting ${name} without changing either connection`, async () => mediaAdmissionFixture(f => {
  const input = mediaAdmissionInput(); f.admissions.admit("user",input);
  const before = mediaAdmissionSnapshot(f.db);
  expect(() => f.second.admit("user",change({...mediaAdmissionInput(1),requestKey:input.requestKey}))).toThrow();
  expect(mediaAdmissionSnapshot(f.db)).toEqual(before); expect(mediaAdmissionSnapshot(f.other)).toEqual(before);
}));

test("source admissions are user-only and do not adopt separately persisted metadata", async () => mediaAdmissionFixture(f => {
  const input = mediaAdmissionInput(); f.store.saveMediaSource(input);
  const before = mediaAdmissionSnapshot(f.db);
  expect(() => f.admissions.admit("ai",mediaAdmissionInput(1))).toThrow(RunForbiddenError);
  expect(() => f.admissions.admit("user",input)).toThrow();
  expect(() => f.admissions.admit("user",{...input,requestKey:"different-key"})).toThrow();
  expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
}));

test("independent upload keys retain equal bytes as separate sources and normal jobs", async () => mediaAdmissionFixture(f => {
  const first = f.admissions.admit("user",mediaAdmissionInput()), second = f.second.admit("user",mediaAdmissionInput(1));
  expect(first.thought.mediaSource.id).not.toBe(second.thought.mediaSource.id);
  expect(first.run.id).not.toBe(second.run.id);
  expect(f.db.query("SELECT id FROM media_sources").all()).toHaveLength(2);
  expect(f.db.query("SELECT id FROM runs WHERE kind='weave' AND status='queued'").all()).toHaveLength(2);
}));

test("deliberate source retry requires settled prior work and never duplicates a saved interpretation", async () => mediaAdmissionFixture(f => {
  const input = mediaAdmissionInput(), first = f.admissions.admit("user",input);
  const runs = new SqliteRunRepository(f.db,f.sources), ops = new SqliteRunOperations(f.db,f.sources);
  expect(() => f.admissions.retry("user",input.thought.mediaSource.id,"retry-one")).toThrow();
  const steps = new SqliteRunProtocolRepository(f.db), claim = runs.claim(first.run.id);
  steps.prepare(claim,{promptId:first.run.promptId,input:"Controlled source processing request"});
  steps.completeStep(claim,first.run.promptId,{version:1,kind:"complete",reply:"The original could not be understood."});
  ops.completeWeave(claim,first.run.promptId);
  expect(runs.get(first.run.id)?.status).toBe("failed");
  expect(runs.reply(first.run.id)).toMatchObject({text:"The original could not be understood.",state:"complete"});
  expect(f.store.getThought(input.thought.id)).toEqual(first.thought);
  expect(() => f.admissions.retry("user",input.thought.mediaSource.id,"retry-one")).toThrow();
  steps.settleCancellation(first.run.id);
  const retry = f.admissions.retry("user",input.thought.mediaSource.id,"retry-one");
  expect(retry.id).not.toBe(first.run.id);
  expect(f.admissions.retry("user",input.thought.mediaSource.id,"retry-one")).toEqual(retry);
  expect(ops.weaveIntent(retry.id)?.subjectId).toBe(input.thought.id);
  f.store.saveThought({id:"saved-interpretation",text:"A confirmed source summary",title:null,titleAuthor:null,author:"ai",
    kind:"ai-interpretation",createdAt:f.sources.now(),origin:"weave",parentId:input.thought.id,sourceIds:[]});
  runs.stop(retry.id); new SqliteRunProtocolRepository(f.db).settleCancellation(retry.id);
  const before = mediaAdmissionSnapshot(f.db);
  expect(() => f.admissions.retry("user",input.thought.mediaSource.id,"retry-two")).toThrow();
  expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
}));
