import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { createApp } from "../src/app";
import { createMaintainedClient, NativeWeavingAdapter } from "../src/native-adapter";
import { WeavingWorker } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(promptStatus = 200) {
  const dir = await mkdtemp(join(tmpdir(), "thoughtloom-admission-http-")); directories.push(dir);
  const databasePath = join(dir, "test.sqlite"), registrationFile = join(dir, "registration.json");
  const requests: Array<{ path: string; method: string }> = [];
  let session: Record<string, unknown> = {};
  let sessionReads = 0, onSessionRead: (count: number) => void = () => {};
  let entered = () => {}, release = () => {};
  const promptEntered = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname; requests.push({ path, method: req.method });
    if (path === "/api/info") return Response.json({ version: "2.2.2", pid: 42 });
    if (path === "/api/plugin") return Response.json({ data: [{ id: "thoughtloom", state: { status: "active" } }] });
    if (path === "/api/session" && req.method === "POST") { session = { ...await req.json() as Record<string, unknown>, projectID: "project_fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }; return Response.json({ data: session }); }
    if (/^\/api\/session\/[^/]+$/.test(path)) { onSessionRead(++sessionReads); return Response.json({ data: session }); }
    if (path.endsWith("/prompt")) {
      const body = await req.json() as { id: string; text: string };
      entered(); await gate;
      if (promptStatus !== 200) return new Response("fixture-secret-do-not-log", { status: promptStatus });
      return Response.json({ data: { id: body.id, sessionID: session.id, payload: { text: body.text } } });
    }
    if (path === "/api/session/active") return Response.json({});
    if (path.endsWith("/inbox")) return Response.json([]);
    if (path.endsWith("/message")) return Response.json({ data: [] });
    return new Response("fixture route missing", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  await writeFile(registrationFile, JSON.stringify({ url, version: "2.2.2", pid: 42, password: "fixture-only" }), { mode: 0o600 });
  const app = createApp({ databasePath });
  expect((await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "deadline-source" }, body: JSON.stringify({ text: "Test-owned source", provenance: "manual" }) })).status).toBe(201);
  const options = { databasePath, registrationFile, location: dir, agent: "weaver", model: { providerID: "fixture", id: "fixture" }, admissionTimeoutMs: 15_000 };
  const client = createMaintainedClient(options, { async discover() { return { url, auth: { type: "basic", username: "fixture", password: "fixture-only" } }; }, headers: Service.headers, make: OpenCode.make });
  const adapter = new NativeWeavingAdapter({ ...options, client });
  return { server, adapter, databasePath, requests, promptEntered, release, onSessionRead: (handler: (count: number) => void) => { onSessionRead = handler; } };
}

test("real SDK prompt uses a separate 15-second admission deadline while ordinary requests retain five seconds", async () => {
  const timers: Array<{ ms: number; controller: AbortController }> = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; });
  const f = await fixture();
  const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
    expect(f.requests.filter((r) => r.path.endsWith("/prompt") && r.method === "POST")).toHaveLength(1);
    expect(timers.slice(0, -1).some((timer) => timer.ms === 5_000)).toBe(true);
    expect(timers.at(-1)?.ms).toBe(15_000);
    // Advance the old deadline only; the held prompt remains live until its own deadline.
    for (const timer of timers.filter((item) => item.ms === 5_000)) timer.controller.abort();
    f.release();
    expect((await pending).kind).toBe("started");
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query("SELECT state FROM weaving_runs").get()).toEqual({ state: "admitted" }); }
    finally { db.close(); }
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); timeout.mockRestore(); }
});

test("admission deadline expiry remains uncertain and recovery does not resend the native prompt", async () => {
  const timers: Array<{ ms: number; controller: AbortController }> = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; });
  const f = await fixture();
  const worker = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter });
  const pending = worker.startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
    const admission = timers.at(-1);
    expect(admission?.ms).toBe(15_000);
    admission?.controller.abort();
    await pending;
    f.release();
    await new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).recover();
    expect(f.requests.filter((r) => r.path.endsWith("/prompt") && r.method === "POST")).toHaveLength(1);
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query("SELECT state FROM weaving_runs").get()).toEqual({ state: "uncertain" }); }
    finally { db.close(); }
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); timeout.mockRestore(); }
});

test("SDK HTTP admission failure logs only safe stage and status metadata and recovery never resubmits", async () => {
  const f = await fixture(500);
  const logs: unknown[][] = [];
  const info = spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
  const error = spyOn(console, "error").mockImplementation((...args) => { logs.push(args); });
  f.release();
  try {
    const worker = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter });
    expect((await worker.startNext()).kind).toBe("started");
    await new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).recover();
    expect(f.requests.filter((r) => r.path.endsWith("/prompt") && r.method === "POST")).toHaveLength(1);
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query("SELECT state FROM weaving_runs").get()).toEqual({ state: "uncertain" }); }
    finally { db.close(); }
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("fixture-secret-do-not-log");
    expect(serialized).not.toContain("Test-owned source");
    expect(serialized).not.toContain("fixture-only");
    expect(serialized).toContain("promptrequest");
    expect(serialized).toContain("500");
  } finally { info.mockRestore(); error.mockRestore(); await f.adapter.close(); f.server.stop(true); }
});

test("admission reserves the configured deadline plus settlement time against the current claim", async () => {
  const f = await fixture();
  const now = Date.now();
  const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter, leaseMs: 1_000, now: () => now }).startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
    const db = new Database(f.databasePath, { readonly: true });
    try {
      const claim = db.query<{ leaseUntil: number; leaseOwner: string | null }, []>("SELECT lease_until AS leaseUntil, lease_owner AS leaseOwner FROM weaving_runs").get();
      expect(claim?.leaseOwner).toBeTruthy();
      expect(claim?.leaseUntil).toBeGreaterThanOrEqual(now + 25_000);
    } finally { db.close(); }
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
});

test("an expired or replaced claim during ownership validation never sends the native prompt", async () => {
  for (const change of ["expired", "replaced"] as const) {
    const f = await fixture();
    f.onSessionRead((count) => {
      if (count !== 2) return;
      const db = new Database(f.databasePath);
      try { if (change === "expired") db.run("UPDATE weaving_runs SET lease_until=?", [Date.now() - 1]); else db.run("UPDATE weaving_runs SET lease_owner='fixture-replacement'"); }
      finally { db.close(); }
    });
    f.release();
    try {
      await new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
      expect(f.requests.filter((r) => r.path.endsWith("/prompt") && r.method === "POST"), change).toHaveLength(0);
      const db = new Database(f.databasePath, { readonly: true });
      try { expect(db.query("SELECT attempted FROM native_commands").get()).toEqual({ attempted: 0 }); }
      finally { db.close(); }
    } finally { await f.adapter.close(); f.server.stop(true); }
  }
});
