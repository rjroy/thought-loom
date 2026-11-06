import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfig, validateConfig, type DaemonConfig } from "../src/daemon/config";
import { startDaemon, type DaemonEvent, type RunningDaemon } from "../src/daemon/runtime";

const userToken = "user-0123456789-0123456789-abcdef";
const aiToken = "agent-0123456789-0123456789-abcdef";
const env = { THOUGHTLOOM_USER_TOKEN: userToken, THOUGHTLOOM_AI_TOKEN: aiToken, THOUGHTLOOM_DB_PATH: "/test/owned.sqlite" };
const config = (dbPath: string, port = 0): DaemonConfig => ({ dbPath, port, credentials: { user: userToken, ai: aiToken } });
const thought = (id: string, parentId: string | null, sourceIds: string[] = []) => ({ id, parentId, sourceIds, text: `private content ${id}`, title: null, kind: "developing-idea", createdAt: "2026-01-01T00:00:00Z", origin: "integration-test" });
const link = { id: "link", fromId: "root", toId: "child", category: "supports", explanation: "private link rationale", sourceIds: ["root"] };
const invalidConfigs = [
  { changes: { THOUGHTLOOM_USER_TOKEN: undefined }, fields: [/THOUGHTLOOM_USER_TOKEN/] },
  { changes: { THOUGHTLOOM_AI_TOKEN: "" }, fields: [/THOUGHTLOOM_AI_TOKEN/] },
  { changes: { THOUGHTLOOM_USER_TOKEN: "z9!" }, fields: [/THOUGHTLOOM_USER_TOKEN/, /32/] },
  { changes: { THOUGHTLOOM_AI_TOKEN: "   " }, fields: [/THOUGHTLOOM_AI_TOKEN/] },
  { changes: { THOUGHTLOOM_AI_TOKEN: userToken }, fields: [/THOUGHTLOOM_USER_TOKEN/, /THOUGHTLOOM_AI_TOKEN/, /distinct|different/i] },
  { changes: { THOUGHTLOOM_DB_PATH: undefined }, fields: [/THOUGHTLOOM_DB_PATH/] },
  { changes: { THOUGHTLOOM_DB_PATH: " " }, fields: [/THOUGHTLOOM_DB_PATH/] },
  ...["", "-1", "65536", "1.5", "3abc", "1e3", "NaN", "/test/private-token-database.sqlite"].map(port => ({ changes: { THOUGHTLOOM_PORT: port }, fields: [/THOUGHTLOOM_PORT/, /integer/i, /\b0\b/, /65535/] })),
];

async function withDirectory(action: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join("/tmp/opencode", "thoughtloom-daemon-"));
  try { await action(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return Promise.race([promise, Bun.sleep(milliseconds).then(() => { throw new Error(`${label} timed out`); })]);
}

// The process emits a JSON line for its successful start outcome with its actual URL.
async function startupUrl(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let pending = "";
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const chunk = await bounded(reader.read(), Math.max(1, deadline - Date.now()), "startup log");
    if (chunk.done) throw new Error("Daemon exited before reporting its listening URL");
    pending += decoder.decode(chunk.value, { stream: true });
    if (pending.length > 65536) throw new Error("Startup log exceeds limit");
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (typeof event !== "object" || event === null) continue;
      if (!("phase" in event && event.phase === "outcome" && "operation" in event && event.operation === "start" &&
        "success" in event && event.success === true && "url" in event && typeof event.url === "string")) continue;
      return event.url;
    }
  }
  throw new Error("Daemon startup timed out");
}

async function collectOutput(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const chunk = await bounded(reader.read(), 3000, "child output");
    if (chunk.done) return output + decoder.decode();
    output += decoder.decode(chunk.value, { stream: true });
    if (output.length > 65536) throw new Error("Child output exceeds limit");
  }
}

async function failedEntrypoint(dir: string, variables: Record<string, string>) {
  const entrypoint = fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "run", entrypoint], { cwd: dir, env: variables, stdout: "pipe", stderr: "pipe" });
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const output = Promise.all([collectOutput(stdoutReader), collectOutput(stderrReader)]);
  try {
    const [exitCode, [stdout, stderr]] = await bounded(Promise.all([child.exited, output]), 4000, "failed entrypoint");
    return { exitCode, stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { await bounded(child.exited, 3000, "child reap"); }
    finally {
      await Promise.all([
        bounded(stdoutReader.cancel(), 1000, "stdout cleanup"),
        bounded(stderrReader.cancel(), 1000, "stderr cleanup"),
      ]);
    }
  }
}

function hasStartFailure(output: string): boolean {
  return output.split("\n").some(line => {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return false; }
    return typeof event === "object" && event !== null && "operation" in event && event.operation === "start" &&
      "phase" in event && event.phase === "outcome" && "success" in event && event.success === false;
  });
}

function client(daemon: RunningDaemon) {
  return (path: string, actor: "user" | "ai" | "none" = "user", method = "GET", body?: unknown) => {
    const headers: Record<string, string> = {};
    if (actor !== "none") headers.authorization = `Bearer ${actor === "user" ? userToken : aiToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return safeFetch(new URL(path, daemon.url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
}

async function safeFetch(url: URL | string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(1500) });
  return {
    status: response.status,
    json: () => bounded(response.json(), 1500, "response JSON"),
    text: () => bounded(response.text(), 1500, "response text"),
  };
}

function stop(daemon: RunningDaemon) {
  return bounded(daemon.stop(), 3000, "daemon stop");
}

describe("daemon configuration", () => {
  test("accepts configured credentials and database path with default and explicit ports", () => {
    expect(parseConfig(env)).toEqual({ ...config(env.THOUGHTLOOM_DB_PATH, 3001), logLevel: "info" });
    expect(parseConfig({ ...env, THOUGHTLOOM_PORT: "0" }).port).toBe(0);
    expect(parseConfig({ ...env, THOUGHTLOOM_PORT: "65535" }).port).toBe(65535);
  });

  test("import byte limit omits an unset override and preserves an explicit override", () => {
    expect(parseConfig(env).importMaxBytes).toBeUndefined();
    expect(validateConfig(config(env.THOUGHTLOOM_DB_PATH)).importMaxBytes).toBeUndefined();
    expect(parseConfig({ ...env, THOUGHTLOOM_IMPORT_MAX_BYTES: "37" }).importMaxBytes).toBe(37);
    expect(validateConfig({ ...config(env.THOUGHTLOOM_DB_PATH), importMaxBytes: 37 }).importMaxBytes).toBe(37);
  });

  test("import byte limit rejects invalid environment and typed values with a safe diagnostic", () => {
    const diagnostic = "THOUGHTLOOM_IMPORT_MAX_BYTES must be a positive safe integer";
    const invalid = ["-1", "0", "1.5", "NaN", "9007199254740992", "private-value-marker"];
    for (const value of invalid) {
      expect(() => parseConfig({ ...env, THOUGHTLOOM_IMPORT_MAX_BYTES: value })).toThrow(diagnostic);
      try { parseConfig({ ...env, THOUGHTLOOM_IMPORT_MAX_BYTES: value }); }
      catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toBe(diagnostic);
      }
    }
    for (const value of [-1, 0, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateConfig({ ...config(env.THOUGHTLOOM_DB_PATH), importMaxBytes: value })).toThrow(diagnostic);
    }
  });

  test.each(invalidConfigs)("rejects invalid config with safe field diagnostic", ({ changes, fields }) => {
    let failure: unknown;
    try { parseConfig({ ...env, ...changes }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ConfigError);
    if (!(failure instanceof ConfigError)) throw new Error("Expected ConfigError");
    for (const field of fields) expect(failure.message).toMatch(field);
    for (const secret of [userToken, aiToken, env.THOUGHTLOOM_DB_PATH, "z9!", "/test/private-token-database.sqlite"]) expect(failure.message).not.toContain(secret);
  });

  test("invalid runtime config fails before creating database directories", async () => {
    await withDirectory(async dir => {
      const path = join(dir, "not-created", "db.sqlite");
      const events: DaemonEvent[] = [];
      await expect(startDaemon({ ...config(path), credentials: { user: "weak", ai: aiToken } }, event => events.push(event))).rejects.toThrow(ConfigError);
      await expect(stat(join(dir, "not-created"))).rejects.toThrow();
      expect(JSON.stringify(events)).not.toContain(aiToken);
    });
  });

  test("entrypoint reports invalid port field and range without printing its value or credentials", async () => {
    await withDirectory(async dir => {
      const path = join(dir, "sensitive-db-token-sentinel.sqlite");
      const result = await failedEntrypoint(dir, { ...env, THOUGHTLOOM_DB_PATH: path, THOUGHTLOOM_PORT: path });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/THOUGHTLOOM_PORT/);
      expect(result.stderr).toMatch(/integer/i);
      expect(result.stderr).toMatch(/\b0\b/);
      expect(result.stderr).toMatch(/65535/);
      const combined = result.stdout + result.stderr;
      expect(hasStartFailure(combined)).toBe(true);
      for (const secret of [path, "sensitive-db-token-sentinel", userToken, aiToken]) expect(combined).not.toContain(secret);
      await expect(stat(path)).rejects.toThrow();
    });
  }, 10000);

  test("entrypoint sanitizes unexpected SQLite startup failures", async () => {
    await withDirectory(async dir => {
      // A directory cannot be opened as a SQLite database; its path is a test-owned sentinel.
      const result = await failedEntrypoint(dir, { ...env, THOUGHTLOOM_DB_PATH: dir, THOUGHTLOOM_PORT: "0" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/failed|error/i);
      const combined = result.stdout + result.stderr;
      expect(hasStartFailure(combined)).toBe(true);
      for (const secret of [dir, userToken, aiToken, "SQLITE_CANTOPEN", "unable to open database file"]) expect(combined).not.toContain(secret);
    });
  }, 10000);
});

describe("real HTTP and SQLite daemon", () => {
  test("bounded HTTP helper aborts a stalled body and cleans up its owned fixture", async () => {
    let ownedDirectory = "";
    await withDirectory(async dir => {
      ownedDirectory = dir;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      })) });
      try {
        const response = await safeFetch(server.url);
        expect(response.status).toBe(200);
        await expect(response.text()).rejects.toThrow();
      } finally { await bounded(server.stop(true), 3000, "stalled fixture stop"); }
    });
    await expect(stat(ownedDirectory)).rejects.toThrow();
  });

  test("stop closes its database when listener shutdown reports failure", async () => {
    await withDirectory(async dir => {
      const serveSpy = spyOn(Bun, "serve");
      const execSpy = spyOn(Database.prototype, "exec");
      const closeSpy = spyOn(Database.prototype, "close");
      const events: DaemonEvent[] = [];
      const secret = "sensitive listener failure detail";
      let ownedDb: Database | undefined;
      let ownedLease: Database | undefined;
      let ownedServer: ReturnType<typeof Bun.serve> | undefined;
      let restoreStop: (() => void) | undefined;
      try {
        const dbPath = join(dir, "db.sqlite");
        const daemon = await startDaemon(config(dbPath), event => events.push(event));
        ownedDb = execSpy.mock.contexts.find((value): value is Database => value instanceof Database && value.filename === dbPath);
        ownedLease = execSpy.mock.contexts.find((value): value is Database => value instanceof Database && value.filename === `${dbPath}.execution-owner.sqlite`);
        const result = serveSpy.mock.results[0];
        if (!ownedDb || !ownedLease || !result || result.type !== "return") throw new Error("Could not capture daemon-owned resources");
        ownedServer = result.value;
        const realStop = ownedServer.stop.bind(ownedServer);
        const stopSpy = spyOn(ownedServer, "stop");
        restoreStop = () => stopSpy.mockRestore();
        stopSpy.mockImplementation(async force => { await realStop(force); throw new Error(secret); });
        let first: unknown;
        let second: unknown;
        try { await stop(daemon); } catch (error) { first = error; }
        try { await stop(daemon); } catch (error) { second = error; }
        expect(first).toBeInstanceOf(Error);
        expect(second).toBeInstanceOf(Error);
        expect(closeSpy.mock.contexts.filter(value => value === ownedDb)).toHaveLength(1);
        expect(closeSpy.mock.contexts.filter(value => value === ownedLease)).toHaveLength(1);
        expect(closeSpy.mock.contexts.indexOf(ownedDb)).toBeLessThan(closeSpy.mock.contexts.indexOf(ownedLease));
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(String(first)).not.toContain(secret);
        expect(String(second)).not.toContain(secret);
        expect(JSON.stringify(events)).not.toContain(secret);
        expect(events.some(event => "operation" in event && event.operation === "stop" && event.phase === "outcome" && event.success === false)).toBe(true);
      } finally {
        restoreStop?.();
        const result = serveSpy.mock.results[0];
        if (!ownedServer && result?.type === "return") ownedServer = result.value;
        const dbPath = join(dir, "db.sqlite");
        ownedDb ??= execSpy.mock.contexts.find((value): value is Database => value instanceof Database && value.filename === dbPath);
        ownedLease ??= execSpy.mock.contexts.find((value): value is Database => value instanceof Database && value.filename === `${dbPath}.execution-owner.sqlite`);
        try {
          if (ownedServer) await bounded(ownedServer.stop(true), 3000, "captured listener cleanup");
        } finally {
          try {
            if (ownedDb && !closeSpy.mock.contexts.some(value => value === ownedDb)) ownedDb.close();
            if (ownedLease && !closeSpy.mock.contexts.some(value => value === ownedLease)) ownedLease.close();
          }
          finally { closeSpy.mockRestore(); execSpy.mockRestore(); serveSpy.mockRestore(); }
        }
      }
    });
  });

  test("persists scoped tree, sources and independent connection rejection across restart", async () => {
    await withDirectory(async dir => {
      const dbPath = join(dir, "nested", "daemon.sqlite");
      const events: DaemonEvent[] = [];
      let daemon: RunningDaemon | undefined;
      try {
        daemon = await startDaemon(config(dbPath), event => events.push(event));
        expect(new URL(daemon.url).hostname).toBe("127.0.0.1");
        expect(Number(new URL(daemon.url).port)).toBeGreaterThan(0);
        let request = client(daemon);
        expect((await request("/thoughts", "none")).status).toBe(401);
        const createdRoot = await request("/thoughts", "user", "POST", { text: "private content root" });
        expect(createdRoot.status).toBe(201);
        const root = await createdRoot.json();
        expect(root).toMatchObject({ text: "private content root", title: null, titleAuthor: null, author: "user", kind: "captured-original", parentId: null, sourceIds: [] });
        const createdChild = await request(`/thoughts/${root.id}/developments`, "ai", "POST", { text: "private content child", sourceIds: [root.id] });
        expect(createdChild.status).toBe(201);
        const child = await createdChild.json();
        expect(child).toMatchObject({ text: "private content child", title: null, titleAuthor: null, author: "ai", kind: "developing-idea", parentId: root.id, sourceIds: [root.id] });
        const linkInput = { fromId: root.id, toId: child.id, category: "supports", explanation: link.explanation, sourceIds: [root.id] };
        const createdLink = await request("/connections", "ai", "POST", linkInput);
        expect(createdLink.status).toBe(201);
        const savedLink = await createdLink.json();
        expect(savedLink).toEqual({ ...linkInput, id: savedLink.id, proposedBy: "ai" });
        expect((await request(`/connections/${savedLink.id}/reject`, "user", "POST")).status).toBe(204);
        expect((await request(`/thoughts/${root.id}/reject`, "user", "POST")).status).toBe(204);
        expect((await request(`/thoughts/${root.id}`, "ai")).status).toBe(404);
        const visibleChild = await request(`/thoughts/${child.id}`, "ai");
        expect(visibleChild.status).toBe(200);
        expect(await visibleChild.json()).toEqual({ ...child, parentId: null, sourceIds: [] });
        const history = await request("/thoughts?scope=history");
        expect(history.status).toBe(200);
        expect(await history.json()).toEqual(expect.arrayContaining([{ ...root, rejected: true }, { ...child, rejected: false }]));
        const previewResponse = await request(`/thoughts/${root.id}/branch/preview`);
        expect(previewResponse.status).toBe(200);
        const preview = await previewResponse.json();
        expect(preview).toEqual({ rootId: root.id, branchIds: [root.id, child.id].sort(), affectedIds: [child.id], count: 1 });
        expect((await request(`/thoughts/${root.id}/branch/reject`, "user", "POST", preview)).status).toBe(204);
        expect((await request(`/thoughts/${child.id}`, "ai")).status).toBe(404);
        await stop(daemon);
        await stop(daemon);
        daemon = await startDaemon(config(dbPath), event => events.push(event));
        request = client(daemon);
        expect((await request(`/thoughts/${root.id}`, "ai")).status).toBe(404);
        expect((await request(`/thoughts/${child.id}`, "ai")).status).toBe(404);
        expect((await request(`/thoughts/${root.id}/branch/restore`, "user", "POST")).status).toBe(204);
        expect(await (await request(`/thoughts/${child.id}`, "ai")).json()).toEqual(child);
        expect((await request(`/connections/${savedLink.id}`, "ai")).status).toBe(404);
        expect(await (await request(`/connections/${savedLink.id}?scope=history`)).json()).toEqual({ ...savedLink, rejected: true });
        await stop(daemon);
        daemon = await startDaemon(config(dbPath), event => events.push(event));
        request = client(daemon);
        expect(await (await request(`/thoughts/${root.id}`, "ai")).json()).toEqual(root);
        expect((await request(`/connections/${savedLink.id}`, "ai")).status).toBe(404);
      } finally {
        if (daemon) await stop(daemon);
      }
      for (const operation of ["start", "stop"] as const) {
        expect(events.some(e => "operation" in e && e.operation === operation && e.phase === "attempt")).toBe(true);
        expect(events.some(e => "operation" in e && e.operation === operation && e.phase === "outcome" && e.success === true)).toBe(true);
      }
      expect(events.some(e => "method" in e && e.method === "POST" && e.phase === "attempt")).toBe(true);
      expect(events.some(e => "method" in e && e.method === "POST" && e.phase === "outcome" && e.status === 201)).toBe(true);
      const logged = JSON.stringify(events);
      for (const secret of [userToken, aiToken, "private content", link.explanation]) expect(logged).not.toContain(secret);
    });
  });

  test("concurrent identical captures get distinct identities and do not overwrite records", async () => {
    await withDirectory(async dir => {
      const events: DaemonEvent[] = [];
      const daemon = await startDaemon(config(join(dir, "db.sqlite")), event => events.push(event));
      try {
        const request = client(daemon);
        const input = { text: "private duplicate content" };
        const raced = await Promise.all([request("/thoughts", "user", "POST", input), request("/thoughts", "user", "POST", input)]);
        expect(raced.map(response => response.status)).toEqual([201, 201]);
        const first = await raced[0]?.json();
        const second = await raced[1]?.json();
        expect(typeof first.id).toBe("string");
        expect(typeof second.id).toBe("string");
        expect(first.id).not.toBe(second.id);
        expect(await (await request(`/thoughts/${first.id}`)).json()).toEqual(first);
        expect(await (await request(`/thoughts/${second.id}`)).json()).toEqual(second);
        expect(JSON.stringify(events)).not.toContain(input.text);
      } finally { await stop(daemon); }
    });
  });

  test("port conflict fails safely, releases SQLite, and stop releases listener", async () => {
    await withDirectory(async dir => {
      const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owned") });
      const events: DaemonEvent[] = [];
      const path = join(dir, "db.sqlite");
      try {
        const port = occupied.port;
        if (port === undefined) throw new Error("Expected TCP listener");
        await expect(startDaemon(config(path, port), event => events.push(event))).rejects.toThrow();
        expect(await (await safeFetch(occupied.url)).text()).toBe("owned");
        expect(events.some(e => "operation" in e && e.operation === "start" && e.phase === "outcome" && e.success === false)).toBe(true);
        const db = new Database(path);
        try { db.exec("BEGIN EXCLUSIVE; COMMIT;"); } finally { db.close(); }
      } finally { await bounded(occupied.stop(true), 3000, "occupied listener stop"); }
      const daemon = await startDaemon(config(path), () => {});
      try {
        const url = daemon.url;
        await stop(daemon);
        await stop(daemon);
        await expect(safeFetch(url)).rejects.toThrow();
      } finally { await stop(daemon); }
    });
  });

  test.each(["SIGINT", "SIGTERM"] as const)("entrypoint serves HTTP and stops on %s", async signal => {
    await withDirectory(async dir => {
      const entrypoint = fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url));
      const child = Bun.spawn([process.execPath, "run", entrypoint], {
        cwd: dir,
        env: { ...env, THOUGHTLOOM_DB_PATH: join(dir, "child.sqlite"), THOUGHTLOOM_PORT: "0" },
        stdout: "pipe", stderr: "ignore",
      });
      const reader = child.stdout.getReader();
      try {
        const base = new URL(await startupUrl(reader));
        expect(base.hostname).toBe("127.0.0.1");
        expect(Number(base.port)).toBeGreaterThan(0);
        const url = new URL("/thoughts", base);
        const response = await fetch(url, { headers: { authorization: `Bearer ${userToken}` }, signal: AbortSignal.timeout(1000) });
        expect(response.status).toBe(200);
        expect(await bounded(response.json(), 1000, "response body")).toEqual([]);
        child.kill(signal);
        await bounded(child.exited, 3000, "signal shutdown");
        await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
        const db = new Database(join(dir, "child.sqlite"));
        try { db.exec("BEGIN EXCLUSIVE; COMMIT;"); } finally { db.close(); }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        try { await bounded(child.exited, 3000, "child reap"); }
        finally { await bounded(reader.cancel(), 1000, "stdout cleanup"); }
      }
    });
  }, 15000);
});
