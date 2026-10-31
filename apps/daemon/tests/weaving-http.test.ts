import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createWeavingWorld, type BrowserWeavingWorld } from "../../../tests/fixtures/weaving-world";
import type { WeavingStatusExampleContract } from "../../../tests/fixtures/weaving-content";

const fixtures: { directory: string; world: BrowserWeavingWorld }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.world.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});
async function fixture(scenario: Parameters<typeof createWeavingWorld>[1]) {
  const directory = await mkdtemp("/tmp/opencode/thoughtloom-weaving-http-");
  const world = await createWeavingWorld(join(directory, "example.sqlite"), scenario);
  fixtures.push({ directory, world });
  return world;
}
async function view(world: BrowserWeavingWorld): Promise<WeavingStatusExampleContract> {
  const response = await world.app.request(`/sources/${world.source!.id}/weaving`);
  expect(response.status).toBe(200);
  return await response.json() as WeavingStatusExampleContract;
}
function retry(world: BrowserWeavingWorld, key: string, expectedRunId: string) {
  return world.app.request(`/sources/${world.source!.id}/weaving/retry`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ expectedRunId }) });
}

test("per-source weaving status distinguishes queued source durability from missing configuration", async () => {
  const world = await fixture("unconfigured");
  const result = await view(world); // Intended API RED: currently 404, not a setup/import error.
  expect(result).toMatchObject({ sourceId: world.source!.id, worker: { configured: false }, job: { status: "queued", attempts: 0, recordedChanges: null }, run: null, actions: { retry: false } });
  expect(JSON.stringify(result)).not.toContain("browser-fixture-only-not-a-real-secret");
  expect((await world.app.request(`/sources/${randomUUID()}/weaving`)).status).toBe(404);
});

test("a definitely failed eligible job retries idempotently with a run fence, never a new source or job", async () => {
  const world = await fixture("available"); await world.start(); await world.advance({ kind: "failed" });
  const failed = await view(world), before = world.metrics();
  expect(failed.job.status).toBe("failed"); expect(failed.actions.retry).toBe(true); expect(failed.run).not.toBeNull();
  const key = randomUUID(), runId = failed.run!.id;
  const first = await retry(world, key, runId); expect(first.status).toBe(202);
  const receipt = await first.json();
  const replay = await retry(world, key, runId); expect(replay.status).toBe(202); expect(await replay.json()).toEqual(receipt);
  expect((await retry(world, key, "different-run")).status).toBe(409);
  expect(world.metrics().sources).toBe(before.sources); expect(world.metrics().jobs).toBe(before.jobs);
  await world.advance();
  const running = await view(world); expect(running.job.id).toBe(failed.job.id); expect(running.run!.id).not.toBe(runId);
  const stableReplay = await retry(world, key, runId); expect(stableReplay.status).toBe(202); expect(await stableReplay.json()).toEqual(receipt);
  expect((await retry(world, randomUUID(), runId)).status).toBe(409);
  expect(world.metrics().admissions).toHaveLength(2);
  expect(await (await world.app.request(`/sources/${world.source!.id}`)).json()).toEqual(world.source);
});

test("uncertain or running admission refuses retry and status reads cannot resubmit it", async () => {
  for (const scenario of ["uncertain", "available"] as const) {
    const world = await fixture(scenario); await world.start();
    const pending = await view(world), before = world.metrics();
    expect(pending.actions.retry).toBe(false); expect(pending.run).not.toBeNull();
    expect((await retry(world, randomUUID(), pending.run!.id)).status).toBe(409);
    await view(world); await view(world);
    expect(world.metrics().admissions).toEqual(before.admissions);
    expect(world.metrics().runs).toBe(before.runs); expect(world.metrics().sources).toBe(before.sources);
    await world.advance({ kind: "completed", recordedChanges: 0 });
    const completed = await view(world); expect(completed.run!.id).toBe(pending.run!.id);
    expect(completed.job.status).toBe("completed"); expect(world.metrics().activeGrants).toBe(0);
  }
});
