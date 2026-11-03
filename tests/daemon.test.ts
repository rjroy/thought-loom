import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfig, type DaemonConfig } from "../src/daemon/config";
import { startDaemon, type DaemonEvent, type RunningDaemon } from "../src/daemon/runtime";

const userToken = "user-0123456789-0123456789-abcdef";
const aiToken = "agent-0123456789-0123456789-abcdef";
const env = { THOUGHTLOOM_USER_TOKEN: userToken, THOUGHTLOOM_AI_TOKEN: aiToken, THOUGHTLOOM_DB_PATH: "/test/owned.sqlite" };
const config = (dbPath: string, port = 0): DaemonConfig => ({ dbPath, port, credentials: { user: userToken, ai: aiToken } });
const thought = (id: string, parentId: string | null, sourceIds: string[] = []) => ({ id, parentId, sourceIds, text: `private content ${id}`, title: null, kind: "developing-idea", createdAt: "2026-01-01T00:00:00Z", origin: "integration-test" });
const link = { id: "link", fromId: "root", toId: "child", category: "supports", explanation: "private link rationale", sourceIds: ["root"] };
const invalidConfigs = [
  { THOUGHTLOOM_USER_TOKEN: undefined }, { THOUGHTLOOM_AI_TOKEN: "" },
  { THOUGHTLOOM_USER_TOKEN: "short" }, { THOUGHTLOOM_AI_TOKEN: "   " },
  { THOUGHTLOOM_AI_TOKEN: userToken }, { THOUGHTLOOM_DB_PATH: undefined }, { THOUGHTLOOM_DB_PATH: " " },
  ...["", "-1", "65536", "1.5", "3abc", "1e3", "NaN"].map(port => ({ THOUGHTLOOM_PORT: port })),
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
    expect(parseConfig(env)).toEqual(config(env.THOUGHTLOOM_DB_PATH, 3001));
    expect(parseConfig({ ...env, THOUGHTLOOM_PORT: "0" }).port).toBe(0);
    expect(parseConfig({ ...env, THOUGHTLOOM_PORT: "65535" }).port).toBe(65535);
  });

  test.each(invalidConfigs)("rejects invalid config with ConfigError: %j", changes => {
    expect(() => parseConfig({ ...env, ...changes })).toThrow(ConfigError);
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
      let ownedServer: ReturnType<typeof Bun.serve> | undefined;
      let restoreStop: (() => void) | undefined;
      try {
        const daemon = await startDaemon(config(join(dir, "db.sqlite")), event => events.push(event));
        ownedDb = execSpy.mock.contexts.find(value => value instanceof Database);
        const result = serveSpy.mock.results[0];
        if (!ownedDb || !result || result.type !== "return") throw new Error("Could not capture daemon-owned resources");
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
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(String(first)).not.toContain(secret);
        expect(String(second)).not.toContain(secret);
        expect(JSON.stringify(events)).not.toContain(secret);
        expect(events.some(event => "operation" in event && event.operation === "stop" && event.phase === "outcome" && event.success === false)).toBe(true);
      } finally {
        restoreStop?.();
        const result = serveSpy.mock.results[0];
        if (!ownedServer && result?.type === "return") ownedServer = result.value;
        ownedDb ??= execSpy.mock.contexts.find(value => value instanceof Database);
        try {
          if (ownedServer) await bounded(ownedServer.stop(true), 3000, "captured listener cleanup");
        } finally {
          try { if (ownedDb && !closeSpy.mock.contexts.some(value => value === ownedDb)) ownedDb.close(); }
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
        const root = thought("root", null);
        const child = thought("child", "root", ["root"]);
        expect((await request("/thoughts", "user", "POST", root)).status).toBe(201);
        const createdChild = await request("/thoughts", "ai", "POST", child);
        expect(createdChild.status).toBe(201);
        expect(await createdChild.json()).toEqual({ ...child, author: "ai" });
        const createdLink = await request("/connections", "ai", "POST", link);
        expect(createdLink.status).toBe(201);
        expect(await createdLink.json()).toEqual({ ...link, proposedBy: "ai" });
        expect((await request("/connections/link/reject", "user", "POST")).status).toBe(204);
        expect((await request("/thoughts/root/reject", "user", "POST")).status).toBe(204);
        expect((await request("/thoughts/root", "ai")).status).toBe(404);
        const visibleChild = await request("/thoughts/child", "ai");
        expect(visibleChild.status).toBe(200);
        expect(await visibleChild.json()).toEqual({ ...child, parentId: null, sourceIds: [], author: "ai" });
        const history = await request("/thoughts?scope=history");
        expect(history.status).toBe(200);
        expect(await history.json()).toEqual(expect.arrayContaining([{ ...root, author: "user" }, { ...child, author: "ai" }]));
        const previewResponse = await request("/thoughts/root/branch/preview");
        expect(previewResponse.status).toBe(200);
        const preview = await previewResponse.json();
        expect(preview).toEqual({ rootId: "root", branchIds: ["child", "root"], affectedIds: ["child"], count: 1 });
        expect((await request("/thoughts/root/branch/reject", "user", "POST", preview)).status).toBe(204);
        expect((await request("/thoughts/child", "ai")).status).toBe(404);
        await stop(daemon);
        await stop(daemon);
        daemon = await startDaemon(config(dbPath), event => events.push(event));
        request = client(daemon);
        expect((await request("/thoughts/root", "ai")).status).toBe(404);
        expect((await request("/thoughts/child", "ai")).status).toBe(404);
        expect((await request("/thoughts/root/branch/restore", "user", "POST")).status).toBe(204);
        expect(await (await request("/thoughts/child", "ai")).json()).toEqual({ ...child, author: "ai" });
        expect((await request("/connections/link", "ai")).status).toBe(404);
        expect(await (await request("/connections/link?scope=history")).json()).toEqual({ ...link, proposedBy: "ai" });
        await stop(daemon);
        daemon = await startDaemon(config(dbPath), event => events.push(event));
        request = client(daemon);
        expect(await (await request("/thoughts/root", "ai")).json()).toEqual({ ...root, author: "user" });
        expect((await request("/connections/link", "ai")).status).toBe(404);
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

  test("duplicate and concurrent writes never replace immutable records; hidden collisions are sanitized", async () => {
    await withDirectory(async dir => {
      const events: DaemonEvent[] = [];
      const daemon = await startDaemon(config(join(dir, "db.sqlite")), event => events.push(event));
      try {
        const request = client(daemon);
        const original = thought("same", null);
        expect((await request("/thoughts", "user", "POST", original)).status).toBe(201);
        expect((await request("/thoughts", "user", "POST", { ...original, text: "replacement" })).status).toBe(409);
        const raced = await Promise.all(["first", "second"].map(text => request("/thoughts", "user", "POST", { ...thought("race", null), text })));
        expect(raced.map(response => response.status).sort()).toEqual([201, 409]);
        const winner = await (await request("/thoughts/race")).json();
        expect(["first", "second"]).toContain(winner.text);
        expect((await request("/thoughts/same/reject", "user", "POST")).status).toBe(204);
        const collision = await request("/thoughts", "ai", "POST", { ...original, text: "attacker replacement" });
        expect(collision.status).toBe(500);
        const error = await collision.text();
        for (const secret of [original.text, "attacker replacement", "SQLITE", userToken, aiToken]) {
          expect(error).not.toContain(secret);
          expect(JSON.stringify(events)).not.toContain(secret);
        }
        expect(await (await request("/thoughts/same?scope=history")).json()).toEqual({ ...original, author: "user" });
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
