import { expect, test } from "bun:test";
import { candidateFromSuccessor, discovery, drive, find, fixture, knowledge, reply, request, setup, status } from "./agentic-search-capability-fixture";

test("configured search worker executes find, full read and discovery within one native conversation", async () => {
  let candidate = "";
  await fixture((index, input) => {
    if (index === 0) return find();
    if (index === 1) { candidate = candidateFromSuccessor(input); return request("readThought", { id: candidate }); }
    if (index === 2) return discovery(candidate);
    if (index === 3) return reply();
    throw new Error("unexpected extra native prompt");
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id), before = knowledge(db);
    const reads = await drive(worker, db, runId);
    expect(client.scriptErrors).toEqual([]);
    expect(status(db, runId)).toBe("completed");
    expect(client.prompts).toHaveLength(4);
    const first = client.prompts[0]; if (!first) throw new Error("missing initial prompt");
    const initial = JSON.parse(first.text) as { capabilities: { capability: string }[] };
    const names = initial.capabilities.map(item => item.capability);
    const approved = ["addDiscovery", "findThoughts", "readThought", "relatedThoughts", "readConnection", "readResponse", "readSearchConversation", "listDiscoveries", "normalizeTimeRange"];
    expect(new Set(names).size).toBe(names.length);
    for (const name of ["addDiscovery", "findThoughts", "readThought"]) expect(names).toContain(name);
    for (const name of names) expect(approved).toContain(name);
    expect(first.text).not.toContain("REJECTED-SENTINEL");
    expect(new Set(client.prompts.map(prompt => prompt.sessionID)).size).toBe(1);
    expect(new Set(client.prompts.map(prompt => prompt.id)).size).toBe(4);
    expect(client.sessions.get(first.sessionID)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    expect(reads).toContain(0); expect(reads).toContain(1);
    expect(reads.indexOf(0)).toBeLessThan(reads.indexOf(1));
    const steps = db.query("SELECT prompt_id,result_json FROM run_steps WHERE run_id=? ORDER BY position").all(runId) as { prompt_id: string; result_json: string | null }[];
    expect(steps.map(step => step.prompt_id)).toEqual(client.prompts.map(prompt => prompt.id));
    for (let i = 0; i < 3; i++) {
      const step = steps[i], successor = client.prompts[i + 1];
      if (!step?.result_json || !successor) throw new Error("missing durable capability result or successor");
      const prompt = JSON.parse(successor.text) as { result: unknown };
      expect(prompt.result).toEqual(JSON.parse(step.result_json));
      expect(successor.text).not.toContain("REJECTED-SENTINEL");
    }
    expect(db.query("SELECT thought_id,why,removed_at FROM search_discoveries").all()).toEqual([{ thought_id: "target", why: "A useful recorded thought", removed_at: null }]);
    expect(db.query("SELECT text,disposition FROM search_messages WHERE run_id=? AND role='assistant'").get(runId)).toEqual({ text: "Found the recorded thought.", disposition: "done" });
    expect(db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(runId)).toEqual({ open_slot: 0 });
    expect(knowledge(db)).toEqual(before);
    const occurrences = db.query("SELECT rowid,* FROM search_discoveries").all();
    await worker.tick(runId); await worker.tick(runId);
    expect(client.prompts).toHaveLength(4);
    expect(db.query("SELECT rowid,* FROM search_discoveries").all()).toEqual(occurrences);
  });
});

for (const attempt of ["discovery", "citation"] as const) test(`a later turn cannot reuse a prior run's full read for ${attempt}`, async () => {
  let candidate = "";
  await fixture((index, input) => {
    if (index === 0) return find();
    if (index === 1) { candidate = candidateFromSuccessor(input); return request("readThought", { id: candidate }); }
    if (index === 2) return discovery(candidate);
    if (index === 3) return reply();
    if (index === 4) return attempt === "discovery" ? discovery(candidate) : reply();
    if (index === 5 && attempt === "discovery") return { version: 1, kind: "search-reply", reply: "No further publication.", disposition: "done", sourceThoughtIds: [] };
    throw new Error("unexpected extra native prompt");
  }, async (db, store, worker, client, id) => {
    const { sessions, session, runId } = setup(db, store, id);
    await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    expect(db.query("SELECT full_read FROM run_context WHERE run_id=? AND kind='thought' AND ref_id='target'").get(runId)).toEqual({ full_read: 1 });
    const previous = db.query("SELECT rowid,* FROM search_discoveries").all();
    const composer = sessions.openComposer("user", session.id);
    const next = sessions.admitTurn("user", session.id, "followup", { text: "Continue the search", startingThoughtIds: [],
      requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
    await drive(worker, db, next.run.id);
    expect(client.scriptErrors).toEqual([]);
    expect(client.prompts[4]?.sessionID).not.toBe(client.prompts[0]?.sessionID);
    expect(db.query("SELECT full_read FROM run_context WHERE run_id=? AND kind='thought' AND ref_id='target'").get(next.run.id)).not.toEqual({ full_read: 1 });
    expect(db.query("SELECT rowid,* FROM search_discoveries").all()).toEqual(previous);
    expect(db.query("SELECT count(*) AS n FROM search_messages WHERE run_id=? AND role='assistant' AND text='Found the recorded thought.'").get(next.run.id)).toEqual({ n: 0 });
  });
});

test("a candidate alone is not a full-read witness for publication", async () => {
  await fixture((index, input) => {
    if (index === 0) return find();
    if (index === 1) return discovery(candidateFromSuccessor(input));
    if (index === 2) return { version: 1, kind: "search-reply", reply: "Cannot publish without a read.", disposition: "done", sourceThoughtIds: [] };
    throw new Error("unexpected extra native prompt");
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id), before = knowledge(db);
    const reads = await drive(worker, db, runId);
    expect(client.scriptErrors).toEqual([]);
    expect(client.prompts.length).toBeGreaterThanOrEqual(2);
    expect(reads).toContain(0); expect(reads).not.toContain(1);
    expect(db.query("SELECT count(*) AS n FROM search_discoveries").get()).toEqual({ n: 0 });
    expect(knowledge(db)).toEqual(before);
  });
});

test("search denies an ordinary knowledge-write request before any library effect", async () => {
  await fixture(() => request("development", { parentId: "target", text: "FORBIDDEN-WRITE", sourceIds: [] }), async (db, store, worker, client, id) => {
    const { sessions, runId } = setup(db, store, id), before = knowledge(db);
    await drive(worker, db, runId);
    expect(client.prompts.length).toBeGreaterThanOrEqual(1);
    expect(client.scriptErrors).toEqual([]);
    expect(["failed", "completed"]).toContain(status(db, runId));
    expect(db.query("SELECT count(*) AS n FROM search_discoveries").get()).toEqual({ n: 0 });
    expect(knowledge(db)).toEqual(before);
    expect("addDiscovery" in sessions).toBe(false);
    expect("finalizeReply" in sessions).toBe(false);
  });
});
