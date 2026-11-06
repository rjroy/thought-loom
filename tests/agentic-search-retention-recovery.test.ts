import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import { RunSupervisor } from "../src/agent/supervisor";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ScriptedClient, config, knowledge, logger, now, setup } from "./agentic-search-capability-fixture";

async function bounded<T>(promise: Promise<T>, label:string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise,new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)),4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type CleanupRow = { state:string; drain_state:string; prompt_manifest_json:string; evidence_json:string|null };
function row(db:Database,runId:string): CleanupRow | null {
  return db.query("SELECT state,drain_state,prompt_manifest_json,evidence_json FROM search_native_cleanup WHERE run_id=?").get(runId) as CleanupRow | null;
}
async function pollWorker(worker:ConfiguredRunWorker,runId:string,done:() => boolean): Promise<void> {
  for (let i=0;i<80 && !done();i++) { await bounded(worker.tick(runId),"owned tick"); await Bun.sleep(1); }
}

test("purged pending cleanup resumes after orderly qualified owner replacement through supervisor scanning", async () => {
  const dir = mkdtempSync(join("/tmp/opencode","retention-restart-")), path = join(dir,"owned.sqlite"), copyPath = join(dir,"copied.sqlite");
  let lease: ExecutionOwnerLease | undefined, db: Database | undefined, worker: ConfiguredRunWorker | undefined, supervisor: RunSupervisor | undefined;
  try {
    lease = await ExecutionOwnerLease.acquire(path,logger); db = new Database(path); migrate(db,logger); lease.register(db);
    let sequence = 0; const id = () => `fixture${String(++sequence).padStart(24,"0")}`;
    const client = new ScriptedClient(() => ({ version:1,kind:"search-reply",reply:"PRIVATE-PREDECESSOR-OUTPUT",disposition:"done",sourceThoughtIds:[] }));
    const store = new SqliteStore(db), { runId,session } = setup(db,store,id), library = knowledge(db);
    worker = new ConfiguredRunWorker({ db,config,id,now,logger,executionOwner:lease,resolve:async () => ({url:"http://127.0.0.1:44991"}),client:() => client });
    client.dropNextAck = true;
    await pollWorker(worker,runId,() => client.prompts.length === 1);
    expect(client.prompts).toHaveLength(1);
    const retention = worker.searchRetention(); if (!retention) throw new Error("missing retention capability");
    client.historyMode = "empty"; store.searchSessions({id,now,logger},retention).delete("user",session.id);
    expect(db.query("SELECT id FROM runs WHERE id=?").get(runId)).toBeNull();
    const original = row(db,runId); expect(original?.state).toBe("pending");
    if (!original) throw new Error("missing purged cleanup");
    worker.pause(); await bounded(worker.drain(),"predecessor drain"); worker = undefined;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); db = undefined; lease.release(); lease = undefined;
    copyFileSync(path,copyPath);

    // A physically copied database contains the old registry row, not qualified
    // lineage for its different file identity; it must not perform native calls.
    const copyLease = await ExecutionOwnerLease.acquire(copyPath,logger), copied = new Database(copyPath);
    let copyWorker: ConfiguredRunWorker | undefined;
    try {
      migrate(copied,logger); copyLease.register(copied); let resolutions = 0, clients = 0;
      copyWorker = new ConfiguredRunWorker({ db:copied,config,id,now,logger,executionOwner:copyLease,
        resolve:async () => { resolutions++; return {url:"http://127.0.0.1:44991"}; },client:() => { clients++; return client; } });
      for (let i=0;i<4;i++) await bounded(copyWorker.tick(runId),"copied cleanup tick");
      expect(row(copied,runId)?.state).toBe("pending"); expect(resolutions).toBe(0); expect(clients).toBe(0);
      expect(client.prompts).toHaveLength(1);
    } finally { copyWorker?.pause(); if (copyWorker) await bounded(copyWorker.drain(),"copy drain"); copied.close(); copyLease.release(); }

    lease = await ExecutionOwnerLease.acquire(path,logger); db = new Database(path); migrate(db,logger); lease.register(db);
    let resolutions = 0, clients = 0;
    worker = new ConfiguredRunWorker({ db,config,id,now,logger,executionOwner:lease,
      resolve:async () => { resolutions++; throw new Error("owned credentials unavailable"); },client:() => { clients++; return client; } });
    supervisor = new RunSupervisor({ db,worker,logger,startTimer:() => () => {} }); supervisor.start();
    for (let i=0;i<5;i++) await bounded(supervisor.poll(),"unavailable cleanup scan");
    expect(row(db,runId)?.state).toBe("pending"); expect(resolutions).toBeGreaterThan(0); expect(clients).toBe(0);
    expect(db.query("SELECT id FROM runs WHERE id=?").get(runId)).toBeNull(); expect(client.prompts).toHaveLength(1);
    await bounded(supervisor.stop(),"unavailable supervisor stop"); supervisor = undefined;
    await bounded(worker.drain(),"unavailable worker drain"); worker = undefined;

    worker = new ConfiguredRunWorker({ db,config,id,now,logger,executionOwner:lease,
      resolve:async () => ({url:"http://127.0.0.1:44991"}),client:() => client });
    supervisor = new RunSupervisor({ db,worker,logger,startTimer:() => () => {} }); supervisor.start();
    for (let i=0;i<8;i++) await bounded(supervisor.poll(),"empty cleanup scan");
    const pending = row(db,runId);
    expect(pending?.state).toBe("pending"); expect(pending?.drain_state).toBe("drained");
    expect(pending?.prompt_manifest_json).toBe(original.prompt_manifest_json);
    expect(client.prompts).toHaveLength(1); expect(db.query("SELECT id FROM runs WHERE id=?").get(runId)).toBeNull();
    client.historyMode = "normal";
    for (let i=0;i<24;i++) {
      const current = row(db,runId); if (current === null || current.state === "settled") break;
      await bounded(supervisor.poll(),"terminal cleanup scan");
    }
    const final = row(db,runId); expect(final === null || final.state === "settled").toBe(true);
    expect(JSON.stringify(final)).not.toContain("PRIVATE-PREDECESSOR-OUTPUT");
    expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(library);
    expect(db.query("SELECT count(*) AS n FROM search_messages WHERE session_id=?").get(session.id)).toEqual({n:0});
    expect(db.query("SELECT id FROM runs WHERE id=?").get(runId)).toBeNull();
  } finally {
    if (supervisor) await bounded(supervisor.stop(),"supervisor cleanup");
    if (worker) { worker.pause(); await bounded(worker.drain(),"worker cleanup"); }
    db?.close(); lease?.release(); rmSync(dir,{recursive:true,force:true});
  }
});
