import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfig, validateConfig } from "../src/daemon/config";
import type { AgentConfig } from "../src/daemon/agent-config";
import { startDaemon, type DaemonEvent, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger, type LogLevel, type LogRecord } from "../src/logging";
import { AgentSessionMissingError } from "../src/agent/errors";
import { ConfiguredRunWorker } from "../src/agent/configured-worker";
import type { InboxItem, NativeMessage, NativeSession, PublicClient } from "../src/agent/opencode-adapter";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const user = "logging-user-012345678901234567890123";
const ai = "logging-agent-01234567890123456789012";
const env = { THOUGHTLOOM_USER_TOKEN: user, THOUGHTLOOM_AI_TOKEN: ai, THOUGHTLOOM_DB_PATH: "/test/owned.sqlite" };
const agent: AgentConfig = { service: { url: "http://127.0.0.1:44999" }, directory: "/tmp/opencode/logging-fixture", model: { providerID: "fixture", id: "fixture" }, effort: { quick: null, standard: null, thorough: null } };
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, Bun.sleep(3000).then(() => { throw new Error(`${label} timed out`); })]);
}
async function call(daemon: RunningDaemon, path: string, method = "GET", body?: unknown) {
  const response = await fetch(new URL(path, daemon.url), { method, headers: { authorization: `Bearer ${user}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(1500) });
  return { status: response.status, data: await bounded(response.json() as Promise<unknown>, "response body") };
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
function deferred() {
  let release: () => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release() };
}

test("levels filter a controlled sink with Info as default", () => {
  const expected: Record<LogLevel, LogLevel[]> = {
    error: ["error"], warning: ["error", "warning"], info: ["error", "warning", "info"], verbose: ["error", "warning", "info", "verbose"],
  };
  for (const level of ["error", "warning", "info", "verbose"] as const) {
    const records: LogRecord[] = [];
    const logger = createLogger(level, record => records.push(record));
    logger.error("error event", { runId: "owned-id" }); logger.warning("warning event"); logger.info("info event"); logger.verbose("verbose event");
    expect(records.map(record => record.level)).toEqual(expected[level]);
    expect(records[0]).toEqual({ level: "error", message: "error event", context: { runId: "owned-id" } });
  }
  const records: LogRecord[] = [];
  const defaultLogger = createLogger(undefined, record => records.push(record));
  defaultLogger.info("visible by default"); defaultLogger.verbose("suppressed by default");
  expect(records.map(record => record.message)).toEqual(["visible by default"]);
});

test("log level config is normalized, defaults to info and rejects unsafe values without echo", () => {
  expect(parseConfig(env).logLevel).toBe("info");
  expect(validateConfig({ port: 0, dbPath: "/owned", credentials: { user, ai } }).logLevel).toBe("info");
  for (const [value, expected] of [[" ERROR ", "error"], ["wArNiNg", "warning"], ["Info", "info"], [" VeRbOsE ", "verbose"]] as const) {
    expect(parseConfig({ ...env, THOUGHTLOOM_LOG_LEVEL: value }).logLevel).toBe(expected);
  }
  for (const bad of ["", "debug", "private-level-secret /owned/path"]) {
    let failure: unknown;
    try { parseConfig({ ...env, THOUGHTLOOM_LOG_LEVEL: bad }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ConfigError);
    if (!(failure instanceof ConfigError)) throw new Error("Expected ConfigError");
    expect(failure.message).toMatch(/THOUGHTLOOM_LOG_LEVEL/);
    if (bad) expect(failure.message).not.toContain(bad);
    expect(failure.message).not.toContain(user); expect(failure.message).not.toContain(ai);
  }
});

test("observation transport outage warns once and reports recovery without treating healthy uncertainty as failure", async () => {
  const db = new Database(":memory:");
  const records: LogRecord[] = [];
  const logger = createLogger("info", record => records.push(record));
  const thoughtText = "observation private thought sentinel";
  const token = "observation-private-native-token";
  const exception = "observation-private-transport-detail";
  class Client implements PublicClient {
    session: NativeSession | null = null;
    readonly prompts: { sessionID: string; id: string; text: string }[] = [];
    historyMode: "uncertain" | "failure" | "running" = "running";
    historyFailures = 0;
    async serverInfo() { return { version: "99.0.0-owned" }; }
    async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
      this.session = { id: input.id, location: input.location, model: input.model, permissions: input.permissions, metadata: input.metadata };
      return this.session;
    }
    async sessionGet(input: { readonly sessionID: string }): Promise<NativeSession> {
      if (!this.session || this.session.id !== input.sessionID) throw new AgentSessionMissingError("Native session is absent");
      return this.session;
    }
    async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
      this.prompts.push(input);
      return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: 1 } };
    }
    async history(input: Parameters<PublicClient["history"]>[0]): Promise<{ data: readonly NativeMessage[]; cursor: { next?: string } }> {
      if (this.historyMode === "failure") { this.historyFailures++; throw new Error(`${exception} ${token} ${thoughtText}`); }
      const item = this.prompts.find(prompt => prompt.sessionID === input.sessionID);
      return { data: item && this.historyMode === "running" ? [{ id: item.id, type: "user", text: item.text, time: { created: 1 } }] : [], cursor: {} };
    }
    async inbox(): Promise<readonly InboxItem[]> { return []; }
    async active(): Promise<Readonly<Record<string, unknown>>> {
      return this.session && this.prompts.length > 0 && this.historyMode === "running" ? { [this.session.id]: {} } : {};
    }
    async cancelInbox() {}
    async interrupt() { return { interrupted: false }; }
  }
  try {
    migrate(db, logger);
    new SqliteStore(db, undefined, logger).saveThought({ id: "owned-subject", text: thoughtText, title: null, author: "user", kind: "captured-original", createdAt: "2031", origin: "fixture", parentId: null, sourceIds: [] });
    let sequence = 0;
    const sources = { id: () => `observation-${++sequence}`, now: () => "2031", logger };
    const runs = new SqliteRunRepository(db, sources);
    const steps = new SqliteRunProtocolRepository(db, logger);
    const run = new SqliteRunOperations(db, sources).admitWeave("user", { subjectId: "owned-subject", triggerId: "logging-observation" });
    const client = new Client();
    const worker = new ConfiguredRunWorker({ db, config: agent, ...sources, resolve: async () => ({ url: "http://127.0.0.1:44999", token }), client: () => client });
    try {
      for (let i = 0; i < 10 && client.prompts.length === 0; i++) await worker.tick(run.id);
      expect(client.prompts).toHaveLength(1);
      expect(runs.get(run.id)?.status).toBe("running");
      const submitted = client.prompts[0];
      if (!submitted) throw new Error("Expected one admitted prompt");
      const before = runs.get(run.id);
      if (!before) throw new Error("Expected persisted run");
      const initial = steps.steps(run.id);
      expect(initial[0]?.promptId).toBe(submitted.id);
      expect(initial[0]?.input).toBe(submitted.text);

      records.length = 0;
      client.historyMode = "uncertain";
      await worker.tick(run.id);
      expect(runs.get(run.id)?.status).toBe("uncertain");
      expect(records.filter(record => record.level === "warning")).toEqual([]);
      client.historyMode = "running";
      await worker.tick(run.id);
      expect(runs.get(run.id)?.status).toBe("running");
      records.length = 0;

      client.historyMode = "failure";
      await worker.tick(run.id); await worker.tick(run.id);
      expect(client.historyFailures).toBe(2);
      expect(runs.get(run.id)?.status).toBe("uncertain");
      const warnings = records.filter(record => record.level === "warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toMatch(/observ|native|service|unavailable/i);
      expect(JSON.stringify(warnings[0])).toContain(run.id);
      client.historyMode = "running";
      await worker.tick(run.id);
      expect(runs.get(run.id)?.status).toBe("running");
      expect(records.filter(record => record.level === "info" && /recover|available/i.test(record.message))).toHaveLength(1);
      expect(client.prompts).toEqual([submitted]);
      expect(steps.steps(run.id)[0]?.promptId).toBe(submitted.id);
      expect(steps.steps(run.id)[0]?.input).toBe(submitted.text);
      expect(runs.get(run.id)?.sessionId).toBe(before.sessionId);
      expect(runs.get(run.id)?.generation).toBe(before.generation);
      const diagnostic = JSON.stringify(records);
      for (const privateValue of [token, exception, thoughtText, user, ai]) expect(diagnostic).not.toContain(privateValue);
    } finally { worker.pause(); }
  } finally { db.close(); }
});

test("independent runtimes filter polls and propagate capture, storage and agent diagnostics without private content", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "logging-owned-"));
  const info: LogRecord[] = []; const verbose: LogRecord[] = [];
  const observer: DaemonEvent[] = [];
  const verbosePoll = deferred(); const warning = deferred();
  let infoPoll: (() => void) | undefined; let verboseTick: (() => void) | undefined;
  let first: RunningDaemon | undefined; let second: RunningDaemon | undefined;
  try {
    first = await bounded(startDaemon({ port: 0, dbPath: join(dir, "info.sqlite"), credentials: { user, ai }, agent, logLevel: "info" }, event => observer.push(event), {
      logSink: record => { info.push(record); if (record.level === "warning" && /agent|service/i.test(record.message)) warning.release(); },
      startTimer: poll => { infoPoll = poll; return () => {}; },
      resolveAgentService: async () => { throw new Error(`test-owned transport secret ${user}`); },
    }), "info start");
    second = await bounded(startDaemon({ port: 0, dbPath: join(dir, "verbose.sqlite"), credentials: { user, ai }, agent, logLevel: "verbose" }, () => {}, {
      logSink: record => { verbose.push(record); if (/supervisor.*poll.*succeed/i.test(record.message)) verbosePoll.release(); },
      startTimer: poll => { verboseTick = poll; return () => {}; },
      resolveAgentService: async () => { throw new Error("test-owned transport failure"); },
    }), "verbose start");
    if (!infoPoll || !verboseTick) throw new Error("Expected owned supervisor timers");
    infoPoll(); verboseTick();
    await bounded(verbosePoll.promise, "verbose empty poll");
    expect(verbose.some(record => record.level === "verbose" && /supervisor.*poll.*attempt/i.test(record.message))).toBe(true);
    expect(verbose.some(record => record.level === "verbose" && /supervisor.*poll.*succeed/i.test(record.message))).toBe(true);
    expect(info.some(record => /supervisor.*poll.*(attempt|succeed)/i.test(record.message))).toBe(false);
    const privateThought = "private thought content sentinel";
    const firstCapture = await call(first, "/thoughts", "POST", { text: privateThought });
    const secondCapture = await call(second, "/thoughts", "POST", { text: "other private content sentinel" });
    expect(firstCapture.status).toBe(201); expect(secondCapture.status).toBe(201);
    const firstId = object(firstCapture.data).id; const secondId = object(secondCapture.data).id;
    if (typeof firstId !== "string" || typeof secondId !== "string") throw new Error("Expected capture IDs");
    expect(info.some(record => record.level === "info" && /captur/i.test(record.message) && JSON.stringify(record).includes(firstId))).toBe(true);
    expect(verbose.some(record => record.level === "info" && /captur/i.test(record.message) && JSON.stringify(record).includes(secondId))).toBe(true);
    expect(verbose.some(record => record.level === "verbose" && /storage/i.test(JSON.stringify(record)))).toBe(true);
    infoPoll();
    await bounded(warning.promise, "agent unavailability warning");
    expect(info.some(record => record.level === "warning" && /agent|service/i.test(record.message))).toBe(true);
    expect(observer.some(event => "method" in event && event.method === "POST" && event.status === 201)).toBe(true);
    const diagnostics = JSON.stringify([info, verbose, observer]);
    for (const sensitive of [privateThought, "other private content sentinel", user, ai, "test-owned transport secret"]) expect(diagnostics).not.toContain(sensitive);
  } finally {
    try { if (first) await bounded(first.stop(), "info stop"); }
    finally { try { if (second) await bounded(second.stop(), "verbose stop"); } finally { await rm(dir, { recursive: true, force: true }); } }
  }
}, 15000);

test("error-only entrypoint still emits structured successful readiness with an owned ephemeral URL", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "logging-entrypoint-"));
  const entry = fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", entry], { cwd: dir, env: { ...env, THOUGHTLOOM_DB_PATH: join(dir, "owned.sqlite"), THOUGHTLOOM_PORT: "0", THOUGHTLOOM_LOG_LEVEL: "error" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = child.stdout.getReader(); const stderr = child.stderr.getReader();
  try {
    const decoder = new TextDecoder(); let pending = ""; let url: string | undefined;
    for (let i = 0; i < 100 && !url; i++) {
      const chunk = await bounded(stdout.read(), "startup output");
      if (chunk.done) throw new Error("Entrypoint exited before readiness");
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 65536) throw new Error("Startup output exceeded limit");
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        let parsed: unknown; try { parsed = JSON.parse(line); } catch { continue; }
        const event = object(parsed);
        if (event.operation === "start" && event.phase === "outcome" && event.success === true && typeof event.url === "string") url = event.url;
      }
    }
    if (!url) throw new Error("Missing successful readiness event");
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const response = await fetch(new URL("/thoughts", url), { headers: { authorization: `Bearer ${user}` }, signal: AbortSignal.timeout(1500) });
    expect(response.status).toBe(200); expect(await bounded(response.json() as Promise<unknown>, "readiness response")).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { await bounded(child.exited, "entrypoint reap"); }
    finally { try { await Promise.all([bounded(stdout.cancel(), "stdout cleanup"), bounded(stderr.cancel(), "stderr cleanup")]); } finally { await rm(dir, { recursive: true, force: true }); } }
  }
}, 10000);

test("invalid log configuration is an always-visible sanitized startup error", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "logging-invalid-"));
  const entry = fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url));
  const bad = "private-log-level-sentinel";
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", entry], { cwd: dir, env: { ...env, THOUGHTLOOM_DB_PATH: join(dir, "owned.sqlite"), THOUGHTLOOM_PORT: "0", THOUGHTLOOM_LOG_LEVEL: bad }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const [code, stdout, stderr] = await bounded(Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]), "invalid entrypoint");
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/THOUGHTLOOM_LOG_LEVEL/);
    for (const value of [bad, user, ai, dir]) expect(stdout + stderr).not.toContain(value);
    expect(stdout + stderr).toMatch(/"operation"\s*:\s*"start"/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { await bounded(child.exited, "entrypoint reap"); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}, 10000);
