import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OpenCodeAdapter } from "../src/agent/opencode-adapter";
import { RunWorker } from "../src/agent/worker";
import { captureBackup } from "../src/backup/capture";
import { recoverRestoreStage, stageRestoreSnapshot } from "../src/backup/restore-staging";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { dailyReviewFixture, type DailyReviewFixture } from "./fixtures/daily-review";
import { pathBinding } from "./fixtures/media-path-worker";

async function pendingDeniedRequest(f: DailyReviewFixture): Promise<string> {
  f.seed("subject");
  const batch = f.admit();
  if (batch.kind !== "admitted" || !batch.runIds[0]) throw new Error("Expected daily review admission");
  const id = batch.runIds[0];
  const client = new ScriptedClient(() => ({version:1,kind:"request",request:{capability:"interpretation",arguments:{text:"Forbidden owned output",sourceIds:[]}}}));
  const worker = new RunWorker({db:f.db,...f.sources,bindingFor:run => pathBinding(run,f.dir),
    native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings),f.sources.logger)});
  try {
    for (let i=0;i<30 && f.steps.steps(id).at(-1)?.envelope?.kind !== "request";i++) await worker.tick(id);
    const step = f.steps.steps(id).at(-1);
    expect(f.run(id).status).toBe("uncertain");
    expect(step).toMatchObject({state:"completed",envelope:{kind:"request",request:{capability:"interpretation"}},result:null});
    expect(f.ops.stepReceipt(id,step?.promptId ?? "missing")).toBeNull();
    expect(f.reviews.lastReviewedAt("subject")).toBeNull();
    expect(f.db.query("SELECT id FROM thoughts WHERE parent_id='subject'").all()).toEqual([]);
    expect(client.prompts).toHaveLength(1);
    return id;
  } finally { worker.pause(); await worker.drain(); }
}

test("backup preserves an active pre-dispatch daily request and recovery fences its execution", async () => dailyReviewFixture(async f => {
  const id = await pendingDeniedRequest(f);
  const originalStep = f.db.query("SELECT prompt_id,input,envelope_json,result_json FROM run_steps WHERE run_id=? ORDER BY position DESC LIMIT 1").get(id);
  const originalSession = f.run(id).sessionId;
  const output = join(f.dir,"backup"), staging = join(f.dir,"staging");
  await mkdir(output,{mode:0o700}); await mkdir(staging,{mode:0o700});
  const backup = await captureBackup({databasePath:f.path,mediaDirectory:f.media,outputDirectory:output,logger:f.sources.logger});
  const stage = await stageRestoreSnapshot({snapshotDirectory:backup.snapshotDirectory,stagingParentDirectory:staging,logger:f.sources.logger});
  try {
    await recoverRestoreStage(stage,{restoredAt:"2032-01-01T00:00:00.000Z",logger:f.sources.logger});
    const db = new Database(stage.databasePath);
    try {
      expect(db.query("SELECT prompt_id,input,envelope_json,result_json FROM run_steps WHERE run_id=? ORDER BY position DESC LIMIT 1").get(id)).toEqual(originalStep);
      expect(db.query("SELECT status,session_id FROM runs WHERE id=?").get(id)).toEqual({status:"interrupted",session_id:originalSession});
      expect(db.query("SELECT entity_id FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(id)).toEqual({entity_id:id});
      expect(db.query("SELECT completed_at FROM daily_review_items WHERE run_id=?").get(id)).toEqual({completed_at:null});
      expect(db.query("SELECT * FROM run_operation_receipts WHERE run_id=?").all(id)).toEqual([]);
      let calls = 0;
      const restoredWorker = new RunWorker({db,...f.sources,bindingFor:() => { calls++; return null; },
        native:() => { calls++; throw new Error("Fenced run must not call native"); }});
      try { await restoredWorker.tick(id); expect(calls).toBe(0); }
      finally { restoredWorker.pause(); await restoredWorker.drain(); }
      expect(db.query("SELECT status FROM runs WHERE id=?").get(id)).toEqual({status:"interrupted"});
    } finally { db.close(); }
  } finally { await stage.dispose(); }
}),45000);

test("backup rejects a fabricated result on an active denied daily request", async () => dailyReviewFixture(async f => {
  const id = await pendingDeniedRequest(f), output = join(f.dir,"backup");
  f.db.run("UPDATE run_steps SET result_json=? WHERE run_id=?",[JSON.stringify({type:"interpretation",thought:"fabricated"}),id]);
  await mkdir(output,{mode:0o700});
  await expect(captureBackup({databasePath:f.path,mediaDirectory:f.media,outputDirectory:output,logger:f.sources.logger})).rejects.toMatchObject({code:"inconsistent-source"});
}),45000);

test("backup rejects a mismatched allowed-operation receipt on an active denied daily request", async () => dailyReviewFixture(async f => {
  const id = await pendingDeniedRequest(f), output = join(f.dir,"backup"), step = f.steps.steps(id).at(-1);
  if (!step) throw new Error("Expected retained final request");
  f.db.run(`INSERT INTO run_operation_receipts(run_id,operation_id,operation_json,thought_id,result_json,format)
    VALUES (?,?,?,NULL,?,'step')`,[id,step.promptId,JSON.stringify({type:"title-fill",title:"Fabricated title"}),
    JSON.stringify({type:"title-fill",status:"unchanged"})]);
  expect(f.store.getThought("subject")?.title).toBeNull();
  expect(f.steps.steps(id).at(-1)?.result).toBeNull();
  await mkdir(output,{mode:0o700});
  await expect(captureBackup({databasePath:f.path,mediaDirectory:f.media,outputDirectory:output,logger:f.sources.logger})).rejects.toMatchObject({code:"inconsistent-source"});
}),45000);
