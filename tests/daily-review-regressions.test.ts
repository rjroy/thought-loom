import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OpenCodeAdapter } from "../src/agent/opencode-adapter";
import { RunSupervisor } from "../src/agent/supervisor";
import { RunWorker } from "../src/agent/worker";
import { captureBackup } from "../src/backup/capture";
import { recoverRestoreStage, restoreBackup, stageRestoreSnapshot } from "../src/backup/restore-staging";
import { RunAdmissionService } from "../src/domain/run";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { dailyReviewFixture, type DailyReviewFixture } from "./fixtures/daily-review";
import { pathBinding } from "./fixtures/media-path-worker";

function worker(f: DailyReviewFixture,client: ScriptedClient): RunWorker {
  return new RunWorker({db:f.db,...f.sources,bindingFor:run => pathBinding(run,f.dir),
    native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings),f.sources.logger)});
}
async function deniedReview(f: DailyReviewFixture): Promise<string> {
  f.seed("subject");
  const batch = f.admit();
  if (batch.kind !== "admitted" || !batch.runIds[0]) throw new Error("Expected an owned daily review");
  const id = batch.runIds[0];
  const client = new ScriptedClient(() => ({version:1,kind:"request",request:{capability:"interpretation",arguments:{text:"Forbidden owned output",sourceIds:[]}}}));
  const w = worker(f,client);
  try {
    for (let i=0;i<30 && f.run(id).status !== "failed";i++) await w.tick(id);
    expect(f.run(id).status).toBe("failed");
    expect(client.prompts).toHaveLength(1);
    const step = f.steps.steps(id).at(-1);
    expect(step?.envelope).toMatchObject({kind:"request",request:{capability:"interpretation"}});
    expect(step?.state).toBe("completed");
    expect(step?.result).toBeNull();
    expect(f.ops.stepReceipt(id,step?.promptId ?? "missing")).toBeNull();
    expect(f.reviews.lastReviewedAt("subject")).toBeNull();
    expect(f.db.query("SELECT id FROM thoughts WHERE parent_id='subject'").all()).toEqual([]);
    return id;
  } finally { w.pause(); await w.drain(); }
}

test("real backup and staging preserve an inert denied final daily request", async () => dailyReviewFixture(async f => {
  const id = await deniedReview(f), output = join(f.dir,"backup"), staging = join(f.dir,"staging");
  await mkdir(output,{mode:0o700}); await mkdir(staging,{mode:0o700});
  const backup = await captureBackup({databasePath:f.path,mediaDirectory:f.media,outputDirectory:output,logger:f.sources.logger});
  const stage = await stageRestoreSnapshot({snapshotDirectory:backup.snapshotDirectory,stagingParentDirectory:staging,logger:f.sources.logger});
  try {
    const db = new Database(stage.databasePath);
    try {
      expect(db.query("SELECT status FROM runs WHERE id=?").get(id)).toEqual({status:"failed"});
      expect(db.query("SELECT completed_at FROM daily_review_items WHERE run_id=?").get(id)).toEqual({completed_at:null});
      expect(db.query("SELECT result_json FROM run_steps WHERE run_id=? ORDER BY position DESC LIMIT 1").get(id)).toEqual({result_json:null});
      expect(db.query("SELECT * FROM run_operation_receipts WHERE run_id=?").all(id)).toEqual([]);
    } finally { db.close(); }
    await recoverRestoreStage(stage,{restoredAt:"2032-01-01T00:00:00.000Z",logger:f.sources.logger});
  } finally { await stage.dispose(); }
  const installed = await restoreBackup({snapshotDirectory:backup.snapshotDirectory,targetDirectory:join(f.dir,"restored"),
    restoredAt:"2032-01-01T00:00:00.000Z",logger:f.sources.logger});
  const restored = new Database(installed.databasePath);
  try {
    expect(restored.query("SELECT status FROM runs WHERE id=?").get(id)).toEqual({status:"failed"});
    expect(restored.query("SELECT completed_at FROM daily_review_items WHERE run_id=?").get(id)).toEqual({completed_at:null});
    expect(restored.query("SELECT entity_id FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(id)).toEqual({entity_id:id});
    expect(restored.query("SELECT envelope_json FROM run_steps WHERE run_id=? ORDER BY position DESC LIMIT 1").get(id))
      .toEqual(f.db.query("SELECT envelope_json FROM run_steps WHERE run_id=? ORDER BY position DESC LIMIT 1").get(id));
  } finally { restored.close(); }
}),45000);

test("real backup still refuses a denied daily request with a fabricated retained result", async () => dailyReviewFixture(async f => {
  const id = await deniedReview(f), output = join(f.dir,"backup");
  f.db.run("UPDATE run_steps SET result_json=? WHERE run_id=?",[JSON.stringify({type:"interpretation",thought:"fabricated"}),id]);
  await mkdir(output,{mode:0o700});
  await expect(captureBackup({databasePath:f.path,mediaDirectory:f.media,outputDirectory:output,logger:f.sources.logger})).rejects.toMatchObject({code:"inconsistent-source"});
}),45000);

test("real backup still refuses a forbidden processed daily predecessor", async () => dailyReviewFixture(async f => {
  const id = await deniedReview(f), output = join(f.dir,"backup");
  f.db.run("UPDATE run_steps SET state='processed',result_json='{}' WHERE run_id=?",[id]);
  f.db.run("INSERT INTO run_steps(run_id,position,prompt_id,input,state,native_state) VALUES (?,1,'forged-successor','Owned forged successor','prepared','unknown')",[id]);
  await mkdir(output,{mode:0o700});
  await expect(captureBackup({databasePath:f.path,mediaDirectory:f.media,outputDirectory:output,logger:f.sources.logger})).rejects.toMatchObject({code:"inconsistent-source"});
}),45000);

async function legacySettledEvolve(f: DailyReviewFixture) {
  f.seed("root");
  const admission = new RunAdmissionService({...f.sources,repository:f.runs}).admit("user","evolve",{parentId:"root",text:"Owned contribution"});
  if (!admission.contribution) throw new Error("Expected owned contribution");
  const client = new ScriptedClient(() => ({version:1,kind:"complete",reply:"Owned native completion"}));
  client.holdOutput = true;
  const initial = worker(f,client);
  try {
    for (let i=0;i<20 && client.prompts.length === 0;i++) await initial.tick(admission.run.id);
    expect(client.prompts).toHaveLength(1);
  } finally { initial.pause(); await initial.drain(); }
  f.runs.stop(admission.run.id);
  const discovery = f.db.query<{id:string},[string]>("SELECT id FROM runs WHERE weave_subject_id=? AND kind='weave'").get(admission.contribution.id);
  if (!discovery) throw new Error("Expected creation discovery owner");
  expect(f.state.settleUnsubmitted(discovery.id)).toBe(true);
  // Old settlement recorded the bit without persisting per-step terminal proof.
  f.db.run("UPDATE runs SET cancellation_state='settled' WHERE id=?",[admission.run.id]);
  expect(f.steps.cancellation(admission.run.id)).toBe("settled");
  expect(f.steps.steps(admission.run.id)[0]?.state).toBe("submitting");
  f.rejection.rejectThought("user","root");
  expect(f.admit().kind).toBe("deferred");
  client.holdOutput = false;
  return {runId:admission.run.id,subjectId:admission.contribution.id,client};
}

test.each(["direct","supervisor"] as const)("%s reconciliation proves a historically settled Evolve before daily admission", async mode => dailyReviewFixture(async f => {
  const historical = await legacySettledEvolve(f), w = worker(f,historical.client);
  const supervisor = new RunSupervisor({db:f.db,worker:w,logger:f.sources.logger,startTimer:() => () => {}});
  try {
    const previousReads = historical.client.historyRequests.length;
    const generation = f.run(historical.runId).generation;
    if (mode === "direct") await w.tick(historical.runId); else await supervisor.poll();
    expect(historical.client.historyRequests.length).toBeGreaterThan(previousReads);
    expect(historical.client.prompts).toHaveLength(1);
    expect(f.run(historical.runId).status).toBe("interrupted");
    expect(f.run(historical.runId).generation).toBe(generation);
    expect(f.runs.reply(historical.runId)).toBeNull();
    expect(f.steps.steps(historical.runId)[0]).toMatchObject({state:"completed",envelope:null,result:null});
    const admitted = f.admit();
    expect(admitted.kind).toBe("admitted");
    expect(f.db.query("SELECT thought_id FROM daily_review_items").all()).toEqual([{thought_id:historical.subjectId}]);
    expect(f.reviews.lastReviewedAt(historical.subjectId)).toBeNull();
  } finally { await supervisor.stop(); await w.drain(); }
}));

test("historically settled Evolve with missing native history stays blocking and is never resubmitted", async () => dailyReviewFixture(async f => {
  const historical = await legacySettledEvolve(f), w = worker(f,historical.client);
  historical.client.historyMode = "empty";
  try {
    const previousReads = historical.client.historyRequests.length;
    await w.tick(historical.runId);
    expect(historical.client.historyRequests.length).toBeGreaterThan(previousReads);
    expect(historical.client.prompts).toHaveLength(1);
    expect(f.steps.steps(historical.runId)[0]?.state).toBe("submitting");
    expect(f.admit().kind).toBe("deferred");
  } finally { w.pause(); await w.drain(); }
}));

test("historically settled Evolve with conflicting native input stays blocking without interrupting or adopting it", async () => dailyReviewFixture(async f => {
  const historical = await legacySettledEvolve(f), w = worker(f,historical.client), sessionId = f.run(historical.runId).sessionId;
  const history = historical.client.messages.get(sessionId);
  if (!history) throw new Error("Expected owned native history");
  history.push({id:"foreign-input",type:"user",time:{created:20},text:"Different native input"});
  try {
    const previousReads = historical.client.historyRequests.length;
    await w.tick(historical.runId);
    expect(historical.client.historyRequests.length).toBeGreaterThan(previousReads);
    expect(historical.client.prompts).toHaveLength(1); expect(historical.client.interrupts).toEqual([]);
    expect(f.steps.steps(historical.runId)[0]?.state).toBe("submitting");
    expect(f.admit().kind).toBe("deferred");
  } finally { w.pause(); await w.drain(); }
}));
