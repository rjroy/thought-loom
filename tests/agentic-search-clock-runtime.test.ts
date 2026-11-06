import { expect, test } from "bun:test";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import type { SearchClockContext, SearchClockOwner } from "../src/domain/search-time";
import { config, drive, find, fixture, logger, setup, status } from "./agentic-search-capability-fixture";

function clockIn(input: string): SearchClockContext | undefined {
  const parsed: unknown = JSON.parse(input);
  function visit(value: unknown): SearchClockContext | undefined {
    if (!value || typeof value !== "object") return undefined;
    if ("clockContext" in value && value.clockContext && typeof value.clockContext === "object") return value.clockContext as SearchClockContext;
    for (const field of Object.values(value)) { const found = visit(field); if (found) return found; }
    return undefined;
  }
  return visit(parsed);
}

test("a normal successor after one hour carries an honest refreshed clock, never a clock-only prompt", async () => {
  let wall = "2030-01-01T12:00:03.000Z";
  let elapsedMs = 0;
  await fixture(index => {
    if (index === 0) { wall = "2030-01-01T13:00:04.000Z"; elapsedMs = 3_601_000; return find(); }
    if (index === 1) return { version: 1, kind: "search-reply", reply: "Search finished.", disposition: "done", sourceThoughtIds: [] };
    throw new Error("unexpected clock-only prompt");
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id);
    await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    expect(client.scriptErrors).toEqual([]);
    expect(client.prompts).toHaveLength(2);
    expect(new Set(client.prompts.map(prompt => prompt.sessionID)).size).toBe(1);
    const initial = client.prompts[0], successor = client.prompts[1];
    if (!initial || !successor) throw new Error("missing normal prompts");
    const first = clockIn(initial.text), updated = clockIn(successor.text);
    expect(first?.requestAnchor).toEqual({ clock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, daemonObservedAt: "2030-01-01T12:00:03.000Z" });
    expect(updated).toBeDefined();
    if (!updated || !first) throw new Error("missing paired clock context");
    expect(updated.requestAnchor).toEqual(first.requestAnchor);
    expect(updated.observedNow).toEqual(expect.objectContaining({ clock: first.requestAnchor.clock, daemonObservedAt: first.requestAnchor.daemonObservedAt,
      daemonNow: wall, ageMs: 3_601_000, source: "last-reported", clientMinusDaemonMs: -3_000, offsetBasis: "apparent-including-transit-delay" }));
    const steps = db.query("SELECT input FROM run_steps WHERE run_id=? ORDER BY position").all(runId) as { input: string }[];
    expect(steps.map(step => step.input)).toEqual(client.prompts.map(prompt => prompt.text));
    await worker.tick(runId); expect(client.prompts).toHaveLength(2);
  }, () => wall, { monotonicNow: () => elapsedMs });
});

test("exactly one hour does not attach a new clock at the next normal input", async () => {
  let wall = "2030-01-01T12:00:03.000Z", elapsed = 0, reads = 0;
  await fixture(index => {
    if (index === 0) { wall = "2030-01-01T13:00:03.000Z"; elapsed = 3_600_000; return find(); }
    return { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] };
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id); await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed"); expect(client.prompts).toHaveLength(2);
    expect(reads).toBeGreaterThanOrEqual(2);
    const initial = client.prompts[0], next = client.prompts[1];
    if (!initial || !next) throw new Error("missing prompts");
    expect(clockIn(initial.text)).toBeDefined(); expect(clockIn(next.text)).toBeUndefined();
  }, () => wall, { monotonicNow: () => { reads++; return elapsed; } });
});

test("trusted latest observation is scoped to the owned run and does not move its anchor", async () => {
  let wall = "2030-01-01T12:00:03.000Z", elapsed = 0;
  const owners: SearchClockOwner[] = [];
  await fixture(index => {
    if (index === 0) { wall = "2030-01-01T13:00:04.000Z"; elapsed = 3_601_000; return find(); }
    return { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] };
  }, async (db, store, worker, client, id) => {
    const { runId, session } = setup(db, store, id, { at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" }); await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    const initial = client.prompts[0], next = client.prompts[1]; if (!initial || !next) throw new Error("missing prompts");
    expect(owners.length).toBeGreaterThanOrEqual(2);
    for (const owner of owners) expect(owner).toEqual(expect.objectContaining({ runId, searchSessionId: session.id, nativeSessionId: initial.sessionID, generation: expect.any(Number) }));
    const start = clockIn(initial.text), updated = clockIn(next.text);
    expect(start?.requestAnchor.clock).toEqual({ at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" });
    expect(updated?.requestAnchor).toEqual(start?.requestAnchor);
    expect(updated?.observedNow).toEqual(expect.objectContaining({ clock: { at: "2030-01-01T04:59:00-08:00", timeZone: "America/Los_Angeles" },
      daemonObservedAt: "2030-01-01T13:00:00.000Z", daemonNow: wall, ageMs: 4000, clientMinusDaemonMs: -60000,
      offsetBasis: "apparent-including-transit-delay", source: "latest" }));
  }, () => wall, { monotonicNow: () => elapsed, latestObservation: owner => { owners.push(owner); return elapsed ? {
    searchSessionId: owner.searchSessionId, clock: { at: "2030-01-01T04:59:00-08:00", timeZone: "America/Los_Angeles" }, daemonObservedAt: "2030-01-01T13:00:00.000Z" } : null; } });
});

test("observation-only ticks neither sample nor prepare inputs, including after a lost acknowledgement", async () => {
  let wall = "2030-01-01T12:00:03.000Z", elapsed = 0, samples = 0;
  await fixture(index => index === 0 ? find() : { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id); client.holdOutput = true; client.dropNextAck = true;
    for (let i = 0; i < 20 && client.prompts.length === 0; i++) await worker.tick(runId);
    expect(client.prompts).toHaveLength(1);
    const before = db.query("SELECT position,prompt_id,input FROM run_steps WHERE run_id=? ORDER BY position").all(runId);
    const runs = db.query("SELECT id FROM runs ORDER BY id").all();
    const sampled = samples;
    wall = "2030-01-01T13:00:04.000Z"; elapsed = 3_601_000;
    for (let i = 0; i < 5; i++) await worker.tick(runId);
    expect(samples).toBe(sampled); expect(client.prompts).toHaveLength(1);
    expect(db.query("SELECT position,prompt_id,input FROM run_steps WHERE run_id=? ORDER BY position").all(runId)).toEqual(before);
    expect(db.query("SELECT id FROM runs ORDER BY id").all()).toEqual(runs);
    client.holdOutput = false; await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed"); expect(client.prompts).toHaveLength(2);
    expect(clockIn(client.prompts[1]?.text ?? "{}")?.observedNow).toEqual(expect.objectContaining({ source: "latest",
      clock: { at: "2030-01-01T13:00:00Z", timeZone: "UTC" }, daemonObservedAt: "2030-01-01T13:00:01.000Z" }));
    const steps = db.query("SELECT input FROM run_steps WHERE run_id=? ORDER BY position").all(runId) as { input: string }[];
    expect(steps.map(step => step.input)).toEqual(client.prompts.map(prompt => prompt.text));
  }, () => wall, { monotonicNow: () => elapsed, latestObservation: owner => { samples++; return elapsed ? {
    searchSessionId: owner.searchSessionId, clock: { at: "2030-01-01T13:00:00Z", timeZone: "UTC" }, daemonObservedAt: "2030-01-01T13:00:01.000Z" } : null; } });
});

test("cold timing cache reconstructs retained anchor and labels an absent browser observation honestly", async () => {
  let wall = "2030-01-01T12:00:03.000Z", elapsed = 0;
  await fixture(index => index === 0 ? find() : { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id); client.holdOutput = true;
    for (let i = 0; i < 20 && client.prompts.length === 0; i++) await worker.tick(runId);
    const first = client.prompts[0]; if (!first) throw new Error("missing initial prompt");
    wall = "2030-01-01T13:00:04.000Z"; elapsed = 3_601_000;
    worker.forgetSearchClock(runId); client.holdOutput = false;
    await drive(worker, db, runId); expect(status(db, runId)).toBe("completed");
    const second = client.prompts[1]; if (!second) throw new Error("missing successor");
    const old = clockIn(first.text), next = clockIn(second.text);
    expect(next?.requestAnchor).toEqual(old?.requestAnchor);
    expect(next?.observedNow).toEqual(expect.objectContaining({ source: "last-reported", daemonNow: wall, ageMs: 3_601_000,
      clock: old?.requestAnchor.clock, daemonObservedAt: old?.requestAnchor.daemonObservedAt }));
  }, () => wall, { monotonicNow: () => elapsed });
});

test("a paused worker replacement recovers the persisted clock without inventing a browser sample", async () => {
  let wall = "2030-01-01T12:00:03.000Z", elapsed = 0;
  await fixture(index => index === 0 ? find() : { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id); client.holdOutput = true;
    for (let i = 0; i < 20 && client.prompts.length === 0; i++) await worker.tick(runId);
    const first = client.prompts[0]; if (!first) throw new Error("missing initial prompt");
    const saved = db.query("SELECT prompt_id,input FROM run_steps WHERE run_id=? ORDER BY position").all(runId);
    worker.pause(); // All preceding tick promises have settled; no old worker flight remains.
    wall = "2030-01-01T13:00:04.000Z"; elapsed = 3_601_000;
    const replacement = new ConfiguredRunWorker({ db, config, id, now: () => wall, logger, searchClock: { monotonicNow: () => elapsed },
      resolve: async () => ({ url: "http://127.0.0.1:44991" }), client: () => client });
    try {
      client.holdOutput = false; await drive(replacement, db, runId);
      expect(status(db, runId)).toBe("completed"); expect(client.prompts).toHaveLength(2);
      const second = client.prompts[1]; if (!second) throw new Error("missing successor");
      expect(second.sessionID).toBe(first.sessionID);
      const start = clockIn(first.text), next = clockIn(second.text);
      expect(next?.requestAnchor).toEqual(start?.requestAnchor);
      expect(next?.observedNow).toEqual(expect.objectContaining({ source: "last-reported", ageMs: 3_601_000, daemonNow: wall,
        clock: start?.requestAnchor.clock, daemonObservedAt: start?.requestAnchor.daemonObservedAt }));
      expect(db.query("SELECT prompt_id,input FROM run_steps WHERE run_id=? AND position=0").all(runId)).toEqual(saved);
    } finally { replacement.pause(); }
  }, () => wall, { monotonicNow: () => elapsed });
});

test("an older latest report remains timestamped and is not extrapolated to now", async () => {
  let wall = "2030-01-01T12:00:03.000Z", elapsed = 0;
  await fixture(index => {
    if (index === 0) { wall = "2030-01-01T13:00:04.000Z"; elapsed = 3_601_000; return find(); }
    return { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] };
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id); await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    const first = client.prompts[0], second = client.prompts[1]; if (!first || !second) throw new Error("missing prompts");
    const start = clockIn(first.text), next = clockIn(second.text);
    expect(next?.requestAnchor).toEqual(start?.requestAnchor);
    expect(next?.observedNow).toEqual(expect.objectContaining({ source: "latest", daemonObservedAt: "2030-01-01T11:00:00.000Z", daemonNow: wall,
      clock: { at: "2030-01-01T10:59:50Z", timeZone: "UTC" }, ageMs: 7_204_000, clientMinusDaemonMs: -10_000 }));
  }, () => wall, { monotonicNow: () => elapsed, latestObservation: owner => elapsed ? { searchSessionId: owner.searchSessionId,
    clock: { at: "2030-01-01T10:59:50Z", timeZone: "UTC" }, daemonObservedAt: "2030-01-01T11:00:00.000Z" } : null });
});

test("a backwards daemon wall clock forces a labeled boundary without changing the request anchor", async () => {
  let wall = "2030-01-01T12:00:03.000Z", elapsed = 100;
  await fixture(index => {
    if (index === 0) { wall = "2030-01-01T11:59:00.000Z"; elapsed = 200; return find(); }
    return { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] };
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id); await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    const first = client.prompts[0], second = client.prompts[1]; if (!first || !second) throw new Error("missing prompts");
    const start = clockIn(first.text), next = clockIn(second.text);
    expect(next?.requestAnchor).toEqual(start?.requestAnchor);
    expect(next?.observedNow).toEqual(expect.objectContaining({ daemonNow: wall, ageMs: null, backwardClockDiscontinuity: true, source: "last-reported" }));
  }, () => wall, { monotonicNow: () => elapsed });
});

test("a backwards monotonic source also forces a labeled boundary", async () => {
  let elapsed = 100;
  await fixture(index => {
    if (index === 0) { elapsed = 50; return find(); }
    return { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] };
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id); await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    const first = client.prompts[0], second = client.prompts[1]; if (!first || !second) throw new Error("missing prompts");
    expect(clockIn(second.text)?.requestAnchor).toEqual(clockIn(first.text)?.requestAnchor);
    expect(clockIn(second.text)?.observedNow).toEqual(expect.objectContaining({ backwardClockDiscontinuity: true, source: "last-reported" }));
  }, undefined, { monotonicNow: () => elapsed });
});
