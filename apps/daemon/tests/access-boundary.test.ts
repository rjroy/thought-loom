import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app";
import { accessHost } from "../../../tests/fixtures/access-host";

const directories: string[] = [];
const originalAllowedHost = process.env.THOUGHTLOOM_ALLOWED_HOST;
beforeEach(() => { delete process.env.THOUGHTLOOM_ALLOWED_HOST; });
afterEach(async () => {
  if (originalAllowedHost === undefined) delete process.env.THOUGHTLOOM_ALLOWED_HOST;
  else process.env.THOUGHTLOOM_ALLOWED_HOST = originalAllowedHost;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/thoughtloom-access-test-"); directories.push(directory);
  const app = createApp({ databasePath: join(directory, "fixture.sqlite"), tools: { location: "/fixture/location", transportCredential: "fixture-only-credential" } });
  const request = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:4318${path}`, init);
  const captured = await request("/captures", { method: "POST", headers: { host: "127.0.0.1:4318", "content-type": "application/json", "idempotency-key": "fixture" }, body: JSON.stringify({ text: "access-guard-fixture-secret", provenance: "test fixture" }) });
  expect(captured.status).toBe(201);
  const source = await captured.json() as { id: string };
  const created = await request(`/sources/${source.id}/dialogues`, { method: "POST", headers: { host: "127.0.0.1:4318", "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: source.id } }) });
  expect(created.status).toBe(201);
  const dialogue = await created.json() as { id: string };
  return { request, source, dialogue };
}

test("local daemon reads and no-Origin authenticated native callback reach their existing handlers", async () => {
  const f = await fixture();
  expect((await f.request(`/sources/${f.source.id}`, { headers: { host: "127.0.0.1:4318" } })).status).toBe(200);
  expect((await f.request("/search?q=access", { headers: { host: "localhost:4318" } })).status).toBe(200);
  // Invalid native identity is rejected by the existing tool handler, not by a new host gate.
  const callback = await f.request("/internal/tools/read-source", { method: "POST", headers: { host: "127.0.0.1:4318", authorization: "Bearer fixture-only-credential", "content-type": "application/json" }, body: JSON.stringify({}) });
  expect(callback.status).toBe(400);
});

test("rebinding and malformed Host cannot read private daemon projections despite loopback forwarded hints", async () => {
  const f = await fixture();
  for (const host of ["attacker.example:4318", "127.0.0.1@attacker.example:4318", "127.0.0.1:4318,attacker.example", "localhost:4318:443"]) {
    for (const path of ["/search?q=access", `/sources/${f.source.id}`, `/dialogues/${f.dialogue.id}`, `/sources/${f.source.id}/weaving`]) {
      const response = await f.request(path, { headers: { host, "x-forwarded-host": "127.0.0.1:4318", "x-forwarded-proto": "http" } });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("access-guard-fixture-secret");
    }
  }
});

test("daemon mutations reject hostile Host or Origin and preserve fixture data", async () => {
  const f = await fixture();
  const cases: Record<string, string>[] = [{ host: "attacker.example:4318", "x-forwarded-host": "localhost:4318" }, { host: "127.0.0.1:4318", origin: "http://attacker.example" }];
  for (const headers of cases) {
    const response = await f.request("/captures", { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "hostile" }, body: JSON.stringify({ text: "hostile-insert-marker", provenance: "test fixture" }) });
    expect(response.status).toBe(403);
  }
  const search = await f.request("/search?q=hostile-insert-marker", { headers: { host: "127.0.0.1:4318" } });
  expect(search.status).toBe(200);
  expect(await search.json()).toEqual({ engineVersion: 2, results: [], hasMore: false, searchTruncated: false, aliasExpansionTruncated: false });
});

test("hostile Origin cannot read private daemon data even with a local Host", async () => {
  const f = await fixture();
  const response = await f.request(`/sources/${f.source.id}`, { headers: { host: "127.0.0.1:4318", origin: "http://attacker.example" } });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("access-guard-fixture-secret");
});

test("approved HTTP hostname passes daemon host and origin guard without weakening native callback protection", async () => {
  process.env.THOUGHTLOOM_ALLOWED_HOST = accessHost;
  const f = await fixture();
  const host = `${accessHost}:4318`, origin = `http://${host}`;
  const read = await f.request(`/sources/${f.source.id}`, { headers: { host, origin } });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ id: f.source.id, text: "access-guard-fixture-secret" });
  const capture = await f.request("/captures", { method: "POST", headers: { host, origin, "content-type": "application/json", "idempotency-key": "private-host-fixture" }, body: JSON.stringify({ text: "private hostname fixture", provenance: "test fixture" }) });
  expect(capture.status).toBe(201);
  const callback = await f.request("/internal/tools/read-source", { method: "POST", headers: { host, origin, authorization: "Bearer fixture-only-credential", "content-type": "application/json" }, body: "{}" });
  expect(callback.status).toBe(403);
});

test("approved daemon hostname rejects lookalikes and mismatched origins", async () => {
  process.env.THOUGHTLOOM_ALLOWED_HOST = accessHost;
  const f = await fixture();
  const cases: Record<string, string>[] = [
    { host: `${accessHost}.attacker.example:4318` },
    { host: `${accessHost}:4318`, origin: "http://attacker.example" },
    { host: `${accessHost}:4318`, origin: "http://localhost:4318" },
    { host: `${accessHost}:4318`, origin: `http://${accessHost}:4318`, "x-forwarded-host": "attacker.example" },
    { host: `${accessHost}:4318`, origin: `http://${accessHost}:4318`, "x-forwarded-proto": "https" },
    { host: `${accessHost}:4318`, origin: `http://${accessHost}:4318`, forwarded: "host=localhost" },
  ];
  for (const headers of cases) {
    const response = await f.request(`/sources/${f.source.id}`, { headers });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("access-guard-fixture-secret");
  }
});

test("without an allowed hostname the daemon remains loopback-only", async () => {
  const f = await fixture();
  const response = await f.request(`/sources/${f.source.id}`, { headers: { host: `${accessHost}:4318`, origin: `http://${accessHost}:4318` } });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("access-guard-fixture-secret");
});
