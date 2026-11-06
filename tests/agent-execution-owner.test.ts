import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, link, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const ownershipDiagnostic = "Daemon startup failed: execution owner already held";
const childScript = fileURLToPath(new URL("./agent-execution-owner-child.ts", import.meta.url));
const deps = { logSink: () => {} };
const config = (dbPath: string, port = 0) => ({ dbPath, port, credentials });

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function owned(action: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join("/tmp/opencode", "execution-owner-test-"));
  try { await action(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function spawn(dir: string, dbPath: string) {
  return Bun.spawn([process.execPath, "--no-env-file", childScript, dbPath], {
    cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }, stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
}
async function marker(child: ReturnType<typeof spawn>): Promise<{ type: string; url?: string; reason?: string }> {
  const reader = child.stdout.getReader();
  try {
    let text = "";
    while (!text.includes("\n")) {
      const chunk = await bounded(reader.read(), "child startup marker");
      if (chunk.done) throw new Error("child exited before startup marker");
      text += new TextDecoder().decode(chunk.value);
      if (text.length > 16384) throw new Error("oversized child marker");
    }
    return JSON.parse(text.slice(0, text.indexOf("\n"))) as { type: string; url?: string; reason?: string };
  } finally { reader.releaseLock(); }
}
async function dispose(child: ReturnType<typeof spawn>): Promise<void> {
  child.stdin.end();
  try { await bounded(child.exited, "child shutdown"); }
  catch { child.kill("SIGKILL"); await bounded(child.exited, "child kill"); }
}

test("same-process runtime ownership excludes a second start without blocking knowledge writes", async () => owned(async dir => {
  const path = join(dir, "db.sqlite");
  let first: RunningDaemon | undefined, second: RunningDaemon | undefined, reopened: RunningDaemon | undefined;
  let failure: unknown = null;
  try {
    first = await bounded(startDaemon(config(path), () => {}, deps), "first start");
    expect((await bounded(fetch(first.url), "first listener")).status).toBeGreaterThanOrEqual(200);
    const knowledge = new Database(path);
    try {
      knowledge.exec("CREATE TABLE owned_write_probe (value TEXT NOT NULL); INSERT INTO owned_write_probe VALUES ('written')");
      expect(knowledge.query("SELECT value FROM owned_write_probe").get()).toEqual({ value: "written" });
    } finally { knowledge.close(); }
    try { second = await bounded(startDaemon(config(path), () => {}, deps), "second start"); }
    catch (error) { if (error instanceof Error && error.message === "second start timed out") throw error; failure = error; }
    await second?.stop(); second = undefined;
    await first.stop(); first = undefined;
    reopened = await bounded(startDaemon(config(path), () => {}, deps), "start after release");
    expect((await bounded(fetch(reopened.url), "reopened listener")).status).toBeGreaterThanOrEqual(200);
    expect(failure instanceof Error ? failure.message : null).toBe(ownershipDiagnostic);
  } finally { await second?.stop(); await first?.stop(); await reopened?.stop(); }
}));

test("separate Bun processes arbitrate relative and symlink database spellings", async () => owned(async dir => {
  const first = spawn(dir, "db.sqlite");
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const ready = await marker(first);
    expect(ready.type).toBe("ready");
    if (!ready.url) throw new Error("first child did not start");
    expect((await bounded(fetch(ready.url), "child listener")).status).toBeGreaterThanOrEqual(200);
    await symlink("db.sqlite", join(dir, "alias.sqlite"));
    second = spawn(dir, "alias.sqlite");
    const contender = await marker(second);
    if (contender.type === "ready" && contender.url) expect((await bounded(fetch(contender.url), "contender listener")).status).toBeGreaterThanOrEqual(200);
    expect(contender.type).toBe("rejected");
    expect(contender.reason).toBe("execution-owner-held");
  } finally { if (second) await dispose(second); await dispose(first); }
}));

test("clean shutdown and SIGKILL each allow a new owned process to start", async () => owned(async dir => {
  const first = spawn(dir, "db.sqlite");
  let second: ReturnType<typeof spawn> | undefined, third: ReturnType<typeof spawn> | undefined;
  try {
    expect((await marker(first)).type).toBe("ready");
    await dispose(first);
    expect(await first.exited).toBe(0);
    second = spawn(dir, "db.sqlite"); expect((await marker(second)).type).toBe("ready");
    second.kill("SIGKILL"); expect(await bounded(second.exited, "killed child exit")).not.toBe(0);
    third = spawn(dir, "db.sqlite"); expect((await marker(third)).type).toBe("ready");
  } finally { if (third) await dispose(third); if (second) await dispose(second); await dispose(first); }
}));

test("a failed listener startup releases its owned database for a later runtime", async () => owned(async dir => {
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owned") });
  let daemon: RunningDaemon | undefined;
  try {
    const port = Number(occupied.url.port), path = join(dir, "db.sqlite");
    await expect(startDaemon(config(path, port), () => {}, deps)).rejects.toThrow();
    daemon = await bounded(startDaemon(config(path), () => {}, deps), "start after failed startup");
    expect((await bounded(fetch(daemon.url), "listener after failed startup")).status).toBeGreaterThanOrEqual(200);
  } finally { await daemon?.stop(); await occupied.stop(true); }
}));

test("shutdown retains runtime ownership until an entered configured resolver settles", async () => owned(async dir => {
  const path = join(dir, "db.sqlite");
  let timer: (() => void) | undefined, release: () => void = () => {}, entered: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let clientCalls = 0, resolverCalls = 0, stopped = false;
  let daemon: RunningDaemon | undefined, after: RunningDaemon | undefined;
  let stopping: Promise<void> | undefined;
  try {
    daemon = await bounded(startDaemon({ ...config(path), agent: { service: { url: "http://127.0.0.1:44991" }, directory: "/tmp/opencode/owned-fixture",
      model: { providerID: "fixture", id: "fixture-model" }, effort: { quick: null, standard: null, thorough: null } } }, () => {}, {
      logSink: () => {}, startTimer(poll) { timer = poll; return () => { timer = undefined; }; },
      resolveAgentService: async () => { resolverCalls++; entered(); await held; return { url: "http://127.0.0.1:44991" }; },
      createPublicClient: () => { clientCalls++; throw new Error("unexpected owned client construction"); },
    }), "configured start");
    const response = await bounded(fetch(new URL("/thoughts", daemon.url), { method: "POST", headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" }, body: JSON.stringify({ text: "resolver fixture" }) }), "capture");
    expect(response.status).toBe(201);
    if (!timer) throw new Error("owned polling timer not installed");
    timer(); await bounded(ready, "resolver entry");
    timer(); timer();
    expect(resolverCalls).toBe(1); expect(clientCalls).toBe(0);
    stopping = daemon.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(false);
    let contender: RunningDaemon | undefined, conflict: unknown;
    try { contender = await bounded(startDaemon(config(path), () => {}, deps), "competing start"); }
    catch (error) { conflict = error; }
    finally { await contender?.stop(); }
    expect(conflict instanceof Error ? conflict.message : null).toBe(ownershipDiagnostic);
    expect(stopped).toBe(false); expect(clientCalls).toBe(0);
    release(); await bounded(stopping, "held resolver shutdown"); daemon = undefined;
    expect(stopped).toBe(true); expect(clientCalls).toBe(0);
    after = await bounded(startDaemon(config(path), () => {}, deps), "restart after drain");
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT status FROM runs WHERE kind='weave'").all()).toEqual([{ status: "queued" }]); }
    finally { db.close(); }
  } finally {
    release();
    if (stopping) await bounded(stopping, "resolver cleanup");
    if (daemon) await bounded(daemon.stop(), "daemon cleanup");
    if (after) await bounded(after.stop(), "restart cleanup");
  }
}));

test("hard-linked databases and unsafe sidecars are refused; the sidecar is private", async () => owned(async dir => {
  const path = join(dir, "db.sqlite"), alias = join(dir, "hardlink.sqlite"), sidecar = `${path}.execution-owner.sqlite`;
  const db = new Database(path); db.close();
  await link(path, alias);
  await expect(startDaemon(config(path), () => {}, deps)).rejects.toThrow("Daemon startup failed");
  await unlink(alias);
  const target = join(dir, "not-a-sidecar");
  await writeFile(target, "owned sentinel", { mode: 0o600 }); await symlink(target, sidecar);
  await expect(startDaemon(config(path), () => {}, deps)).rejects.toThrow("Daemon startup failed");
  expect(await readFile(target, "utf8")).toBe("owned sentinel");
  await unlink(sidecar);
  const daemon = await startDaemon(config(path), () => {}, deps);
  try { expect((await stat(sidecar)).mode & 0o777).toBe(0o600); }
  finally { await daemon.stop(); }
  await chmod(sidecar, 0o644);
  await expect(startDaemon(config(path), () => {}, deps)).rejects.toThrow("Daemon startup failed");
  await chmod(sidecar, 0o600);
  const restart = await startDaemon(config(path), () => {}, deps);
  await restart.stop();
}));

test("replacing a held sidecar poisons its owner even if the original path is restored", async () => owned(async dir => {
  const path = join(dir, "db.sqlite"), sidecar = `${path}.execution-owner.sqlite`, displaced = join(dir, "old-sidecar.sqlite");
  const lease = await ExecutionOwnerLease.acquire(path);
  try {
    lease.assertHeld();
    await rename(sidecar, displaced);
    await writeFile(sidecar, "replacement", { mode: 0o600 });
    expect(() => lease.assertHeld()).toThrow("Execution ownership is no longer held");
    await unlink(sidecar); await rename(displaced, sidecar);
    expect(() => lease.assertHeld()).toThrow("Execution ownership is no longer held");
  } finally { lease.release(); }
}));
