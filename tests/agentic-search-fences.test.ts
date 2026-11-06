import { expect, test } from "bun:test";
import { RejectionService } from "../src/domain/rejection";
import { RunService } from "../src/domain/run";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunRepository } from "../src/storage/run";
import { find, fixture, knowledge, logger, now, setup } from "./agentic-search-capability-fixture";

for (const [boundary, fence] of [["create", "rejection"], ["submission", "rejection"], ["submission", "stop"], ["observe", "stop"]] as const) test(`${fence} fences an already authorized held native ${boundary}`, async () => {
  await fixture(() => find(), async (db, store, worker, client, id) => {
    const { runId, session, sessions } = setup(db, store, id, { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, ["target"]);
    const other = sessions.create("user", "unaffected", {}).session, otherComposer = sessions.openComposer("user", other.id);
    const otherRun = sessions.admitTurn("user", other.id, "unaffected-turn", { text: "Independent work", startingThoughtIds: [],
      requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: otherComposer.composerId, contextToken: otherComposer.contextToken });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const hold = async () => { entered(); await barrier; };
    if (boundary === "create") client.beforeCreate = hold;
    else if (boundary === "submission") client.beforePrompt = hold;
    else client.beforeHistory = async () => { if (client.prompts.length > 0) await hold(); };
    let held: Promise<void> | undefined;
    try {
      for (let i = 0; i < 24; i++) {
        const tick = worker.tick(runId);
        const atPrompt = await Promise.race([reached.then(() => true), tick.then(() => false)]);
        if (atPrompt) { held = tick; break; }
      }
      expect(held).toBeDefined();
      const before = db.query("SELECT generation FROM runs WHERE id=?").get(runId) as { generation: number };
      const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
      const stop = new RunService({ repository: new SqliteRunRepository(db, { id, now, logger }), id, now, logger,
        dispatcher: { submit: async () => { throw new Error("unused by Stop"); }, observe: async () => { throw new Error("unused by Stop"); } } });
      if (fence === "rejection") {
        expect(() => rejection.rejectThought("ai", "target")).toThrow();
        rejection.rejectThought("user", "target"); rejection.restoreThought("user", "target");
      } else {
        // @ts-expect-error Exercise the runtime user-only check with an untrusted actor.
        expect(() => stop.stop("ai", runId)).toThrow();
        stop.stop("user", runId); stop.stop("user", runId);
      }
      expect(db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(runId)).toEqual({ status: "interrupted", generation: before.generation + 1, cancellation_state: "pending" });
      expect(db.query("SELECT status FROM runs WHERE id=?").get(otherRun.run.id)).toEqual({ status: "queued" });
      expect(db.query("SELECT open_slot,outcome_reason FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot: 0, outcome_reason: fence === "stop" ? "stopped" : "context-invalidated" });
      const afterFence = knowledge(db);
      const steps = db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(runId);
      release(); await held;
      for (let i = 0; i < 4; i++) await worker.tick(runId);
      // The RPC was authorized and entered before the fence; its late native admission is not forbidden by this test.
      expect(client.prompts).toHaveLength(boundary === "create" ? 0 : 1);
      expect(db.query("SELECT rowid,* FROM run_steps WHERE run_id=? ORDER BY position").all(runId)).toEqual(steps);
      expect(db.query("SELECT count(*) AS n FROM search_discoveries WHERE session_id=?").get(session.id)).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM search_messages WHERE run_id=? AND role='assistant'").get(runId)).toEqual({ n: 0 });
      expect(knowledge(db)).toEqual(afterFence);
      expect(db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(runId)).toEqual({ status: "interrupted", generation: before.generation + 1, cancellation_state: "pending" });
    } finally { release(); if (held) await held; }
  });
});
