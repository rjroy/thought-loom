import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import type { NativeMessage } from "../src/agent/opencode-adapter";
import { candidateFromSuccessor, config, drive, find, fixture, knowledge, logger, now, request, setup, status, type ScriptedClient } from "./agentic-search-capability-fixture";

test("a confirmed result survives worker replacement before successor preparation", async () => {
  await fixture(index => index === 0 ? find() : { version: 1, kind: "search-reply", reply: "Continued.", disposition: "done", sourceThoughtIds: [] }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id), before = knowledge(db);
    type StoredResult = { result_json: string | null; state: string };
    let result: StoredResult | null = null;
    for (let i = 0; i < 40; i++) {
      await worker.tick(runId);
      result = db.query("SELECT result_json,state FROM run_steps WHERE run_id=? AND position=0").get(runId) as StoredResult | null;
      if (result?.result_json !== null && result !== null) break;
    }
    expect(result?.result_json).not.toBeNull(); expect(result?.state).toBe("completed");
    if (!result?.result_json) throw new Error("missing confirmed result");
    const confirmed = result.result_json;
    expect(db.query("SELECT count(*) AS n FROM run_steps WHERE run_id=?").get(runId)).toEqual({ n: 1 });
    expect(client.prompts).toHaveLength(1);
    worker.pause();
    const replacement = new ConfiguredRunWorker({ db, config, id, now, logger, resolve: async () => ({ url: "http://127.0.0.1:44991" }), client: () => client });
    try {
      await drive(replacement, db, runId);
      expect(status(db, runId)).toBe("completed"); expect(client.prompts).toHaveLength(2);
      const after = db.query("SELECT result_json,state FROM run_steps WHERE run_id=? AND position=0").get(runId) as { result_json: string; state: string };
      expect(after.result_json).toBe(confirmed); expect(after.state).toBe("processed");
      expect((JSON.parse(client.prompts[1]?.text ?? "{}") as { result: unknown }).result).toEqual(JSON.parse(after.result_json));
      expect(knowledge(db)).toEqual(before);
    } finally { replacement.pause(); }
  });
});

test("lost ACK and missing or unavailable history reconcile on a reopened owned database without resubmission", async () => {
  let facade: ScriptedClient | undefined;
  await fixture((index, input) => {
    if (index === 0) return find();
    if (index === 1) { if (!facade) throw new Error("missing fixture client"); facade.holdOutput = true; facade.dropNextAck = true; return request("readThought", { id: candidateFromSuccessor(input) }); }
    if (index === 2) return { version: 1, kind: "search-reply", reply: "Recovered.", disposition: "done", sourceThoughtIds: ["target"] };
    throw new Error("unexpected prompt");
  }, async (db, store, worker, client, id) => {
    facade = client;
    const { runId } = setup(db, store, id), before = knowledge(db);
    for (let i = 0; i < 60 && client.prompts.length < 2; i++) await worker.tick(runId);
    expect(client.prompts).toHaveLength(2);
    for (let i = 0; i < 3; i++) await worker.tick(runId); // Native history contains users but withholds their outputs.
    expect(client.prompts).toHaveLength(2);
    const first = client.prompts[0], current = client.prompts[1]; if (!first || !current) throw new Error("missing native input");
    const steps = db.query("SELECT position,prompt_id,input,state,result_json FROM run_steps WHERE run_id=? ORDER BY position").all(runId) as { position: number; prompt_id: string; input: string; state: string; result_json: string | null }[];
    expect(steps[0]?.state).toBe("processed"); expect(steps[0]?.result_json).not.toBeNull();
    expect(steps[1]?.input).toBe(current.text);
    const binding = db.query("SELECT * FROM agent_bindings WHERE run_id=?").get(runId);
    const generation = (db.query("SELECT generation FROM runs WHERE id=?").get(runId) as { generation: number }).generation;
    const dbPath = (db.query("PRAGMA database_list").all() as { name: string; file: string }[]).find(row => row.name === "main")?.file;
    if (!dbPath) throw new Error("missing owned database path");
    worker.pause(); // All manual tick promises above settled before replacing this worker.
    const reopened = new Database(dbPath);
    const replacement = new ConfiguredRunWorker({ db: reopened, config, id, now, logger, resolve: async () => ({ url: "http://127.0.0.1:44991" }), client: () => client });
    try {
      client.holdOutput = false; client.historyMode = "empty";
      for (let i = 0; i < 8; i++) await replacement.tick(runId);
      expect(client.prompts).toHaveLength(2); expect(["running", "uncertain", "submitting"]).toContain(status(reopened, runId));
      client.historyMode = "outage";
      for (let i = 0; i < 4; i++) await replacement.tick(runId);
      expect(client.prompts).toHaveLength(2);
      expect(reopened.query("SELECT * FROM agent_bindings WHERE run_id=?").get(runId)).toEqual(binding);
      expect((reopened.query("SELECT generation FROM runs WHERE id=?").get(runId) as { generation: number }).generation).toBeGreaterThan(generation);
      client.historyMode = "normal"; await drive(replacement, reopened, runId);
      expect(status(reopened, runId)).toBe("completed"); expect(client.prompts).toHaveLength(3);
      expect(new Set(client.prompts.map(prompt => prompt.sessionID))).toEqual(new Set([first.sessionID]));
      expect(client.sessions.get(first.sessionID)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
      const after = reopened.query("SELECT position,prompt_id,input,state,result_json FROM run_steps WHERE run_id=? ORDER BY position").all(runId) as typeof steps;
      expect(after[0]).toEqual(steps[0]); expect(after[1]?.prompt_id).toBe(current.id); expect(after[1]?.input).toBe(current.text);
      expect(reopened.query("SELECT count(*) AS n FROM search_discoveries").get()).toEqual({ n: 0 });
      expect(knowledge(reopened)).toEqual(before);
    } finally { replacement.pause(); reopened.close(); }
  });
});

for (const corruption of ["foreign", "altered", "compacted", "native-tool"] as const) test(`untrusted ${corruption} native history is quarantined without a reply`, async () => {
  await fixture(() => find(), async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id), before = knowledge(db); client.holdOutput = true;
    for (let i = 0; i < 20 && !client.prompts.length; i++) await worker.tick(runId);
    const prompt = client.prompts[0]; if (!prompt) throw new Error("missing admitted prompt");
    const original = client.messages.get(prompt.sessionID); if (!original) throw new Error("missing owned native history");
    if (corruption === "foreign") original.push({ id: "foreign-message", type: "user", time: { created: 20 }, text: "FOREIGN-NATIVE-SECRET" });
    else if (corruption === "altered") original[0] = { id: prompt.id, type: "user", time: { created: 10 }, text: "ALTERED-NATIVE-SECRET" };
    else original.push({ id: `other-${corruption}`, type: "other", nativeType: corruption === "compacted" ? "compaction" : "tool", time: { created: 20 } } satisfies NativeMessage);
    client.holdOutput = false; await drive(worker, db, runId);
    expect(status(db, runId)).toBe("failed");
    expect(db.query("SELECT outcome_reason FROM search_turns WHERE run_id=?").get(runId)).toEqual({ outcome_reason: "failed" });
    expect(db.query("SELECT count(*) AS n FROM search_messages WHERE run_id=? AND role='assistant'").get(runId)).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM search_discoveries").get()).toEqual({ n: 0 });
    expect(client.prompts).toHaveLength(1); expect(knowledge(db)).toEqual(before);
  });
});
