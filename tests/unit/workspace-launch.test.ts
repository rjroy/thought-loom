import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../apps/daemon/src/app";
import { accessHost } from "../fixtures/access-host";

// Exercise the actual CLI without ever giving its hardwired child path a real
// daemon or Next. Mirror scripts unchanged; children either exit immediately or
// serve only fixture-controlled readiness responses, with no app/native imports.
const sourceScripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
const directories: string[] = [];
const servers: Bun.Server<undefined>[] = [];
type Launcher = Bun.Subprocess<"ignore", "pipe", "pipe">;
const launchers: Launcher[] = [];
const childMetadata: { file: string; entry: string }[] = [];
afterEach(async () => {
  for (const child of launchers.splice(0)) {
    const deadline = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000);
    try { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; }
    finally { clearTimeout(deadline); }
  }
  // Failure cleanup only: never signal a PID unless its argv still names this
  // fixture's exact child entry. Assertions below check normal launcher cleanup
  // before this fallback can hide a leaked child.
  for (const { file, entry } of childMetadata.splice(0)) {
    if (!(await Bun.file(file).exists())) continue;
    const { pid } = await readChildMetadata(file);
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (argv.includes(entry)) process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ESRCH"].includes(String(error.code))) throw error;
    }
  }
  for (const server of servers.splice(0)) await server.stop(true);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function server(fetch: (request: Request) => Response | Promise<Response>, hostname = "127.0.0.1") {
  const listener = Bun.serve({ hostname, port: 0, fetch });
  // Never let a fixture accidentally use an operator/application port.
  if (!listener.port || [3000, 3001, 4173, 4174].includes(listener.port)) {
    listener.stop(true);
    throw new Error("Fixture requires a distinct ephemeral loopback port");
  }
  servers.push(listener);
  return listener;
}

async function fixture() {
  const root = await mkdtemp("/tmp/opencode/thoughtloom-launch-fixture-");
  directories.push(root);
  await chmod(root, 0o700);
  const scripts = join(root, "scripts");
  const daemonEntry = join(root, "apps/daemon/src/index.ts");
  const nextEntry = join(root, "apps/web/node_modules/next/dist/bin/next");
  const build = join(root, "apps/web/.next");
  const database = join(root, "private data/fixture.sqlite");
  const marker = join(root, "child-spawned");
  const launchEnv = join(root, "launch-configured.env");
  await Promise.all([scripts, dirname(daemonEntry), dirname(nextEntry), build, dirname(database)].map((path) => mkdir(path, { recursive: true })));
  for (const entry of await readdir(sourceScripts)) {
    if (entry.endsWith(".ts")) await copyFile(join(sourceScripts, entry), join(scripts, entry));
  }
  const contracts = join(root, "packages/contracts/src");
  await mkdir(contracts, { recursive: true });
  await copyFile(fileURLToPath(new URL("../../packages/contracts/src/local-request.ts", import.meta.url)), join(contracts, "local-request.ts"));
  const dummy = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "dummy child only\\n");\n`;
  await writeFile(daemonEntry, dummy);
  await writeFile(nextEntry, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "dummy web only\\n");\n`);
  await writeFile(join(root, "apps/web/node_modules/next/package.json"), JSON.stringify({ name: "next", version: "16.4.3" }));
  await writeFile(join(build, "BUILD_ID"), "test-owned-build\n");
  // Keep otherwise-valid launch files valid so port/build tests reach their
  // intended preflight guard instead of failing on an absent database path.
  await writeFile(database, "opaque test-owned file, not SQLite\n", { mode: 0o600 });
  // Reserve both simultaneously so the OS cannot return the same free port.
  const web = server(() => new Response("fixture reservation", { status: 503 }));
  const daemon = server(() => new Response("fixture reservation", { status: 503 }));
  const webPort = web.port, daemonPort = daemon.port;
  if (webPort === undefined || daemonPort === undefined) throw new Error("Fixture loopback listener has no TCP port");
  await Promise.all([web.stop(true), daemon.stop(true)]);
  const contents = (overrides: Record<string, string> = {}) => Object.entries({
    THOUGHTLOOM_DATABASE_PATH: database,
    THOUGHTLOOM_WEB_PORT: String(webPort),
    THOUGHTLOOM_DAEMON_PORT: String(daemonPort),
    ...overrides,
  }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
  await writeFile(launchEnv, contents(), { mode: 0o600 });
  const cwd = join(root, "unrelated-working-directory");
  await mkdir(cwd);
  const node = Bun.which("node");
  if (!node) throw new Error("Fixture requires the project's pinned Node runtime on PATH");
  const runtimePath = `${dirname(node)}:${dirname(process.execPath)}:/usr/bin:/bin`;
  function spawn(args: string[], environment: Record<string, string> = {}, timeout = 5_000) {
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", "run", join(scripts, "run.ts"), ...args],
      cwd,
      // Do not inherit native settings, credentials, real DB paths or ports.
      env: {
        PATH: runtimePath,
        HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), TMPDIR: root,
        THOUGHTLOOM_DATABASE_PATH: database,
        THOUGHTLOOM_WEB_PORT: String(webPort), THOUGHTLOOM_DAEMON_PORT: String(daemonPort),
        ...environment,
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout,
    });
    launchers.push(child);
    return child;
  }
  async function run(args: string[], environment: Record<string, string> = {}) {
    const child = spawn(args, environment);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, output: stdout + stderr, spawned: await Bun.file(marker).exists() };
  }
  return { root, scripts, database, build, launchEnv, marker, contents, run, spawn, cwd, daemonEntry, nextEntry, node, webPort, daemonPort };
}

async function readChildMetadata(file: string) {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid child fixture metadata");
  const data: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
  if (typeof data.pid !== "number" || !Number.isSafeInteger(data.pid) || data.pid <= 0) throw new Error("Invalid child fixture PID");
  return { pid: data.pid, env: data.env, argv: data.argv, cwd: data.cwd, execPath: data.execPath };
}

function observe(child: Launcher) {
  let stdout = "", stderr = "", ended = false;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  async function consume(stream: ReadableStream<Uint8Array>, append: (value: string) => void) {
    const reader = stream.getReader(), decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      append(decoder.decode(chunk.value, { stream: true })); notify();
    }
    append(decoder.decode());
  }
  const streams = [consume(child.stdout, (value) => { stdout += value; }), consume(child.stderr, (value) => { stderr += value; })];
  const exited = child.exited.then(async (code) => { await Promise.all(streams); ended = true; notify(); return code; });
  return {
    get stdout() { return stdout; }, get stderr() { return stderr; }, exited,
    until(fragment: string) {
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { clearTimeout(deadline); listeners.delete(check); error ? reject(error) : resolve(); };
        const check = () => {
          if (stdout.includes(fragment)) finish();
          else if (ended) finish(new Error(`Fixture launcher exited before ${fragment}: ${stdout}${stderr}`));
        };
        const deadline = setTimeout(() => finish(new Error(`Fixture launcher did not report ${fragment}: ${stdout}${stderr}`)), 4_000);
        listeners.add(check); check();
      });
    },
  };
}

async function servingFixture(includeNative: boolean, host?: { file?: string; shell?: string }, bind?: { file?: string; shell?: string }) {
  const f = await fixture();
  const native = join(f.root, "fixture-native.json"), tools = join(f.root, "fixture-tools.json");
  const privateValues = ["fixture-native-body-never-log", "fixture-tool-body-never-log"];
  await writeFile(native, privateValues[0], { mode: 0o600 });
  await writeFile(tools, privateValues[1], { mode: 0o600 });
  const selected: Record<string, string> = {
    THOUGHTLOOM_DATABASE_PATH: f.database,
    THOUGHTLOOM_WEB_PORT: String(f.webPort), THOUGHTLOOM_DAEMON_PORT: String(f.daemonPort),
    ...(includeNative ? { THOUGHTLOOM_NATIVE_CONFIG_FILE: native, THOUGHTLOOM_TOOL_CONNECTION_FILE: tools } : {}),
    ...(host?.file ? { THOUGHTLOOM_ALLOWED_HOST: host.file } : {}),
    ...(bind?.file ? { THOUGHTLOOM_WEB_HOST: bind.file } : {}),
  };
  await writeFile(f.launchEnv, f.contents(selected));
  await writeFile(join(f.root, ".env"), "THOUGHTLOOM_DAEMON_PORT=invalid-dotenv-shadow\nFIXTURE_DOTENV_LEAK=must-not-forward\n");
  const environment = {
    THOUGHTLOOM_DATABASE_PATH: join(f.root, "ambient-must-not-exist.sqlite"),
    THOUGHTLOOM_WEB_PORT: "invalid-ambient-shadow", THOUGHTLOOM_DAEMON_PORT: "invalid-ambient-shadow",
    THOUGHTLOOM_NATIVE_CONFIG_FILE: join(f.root, "ambient-native.json"),
    THOUGHTLOOM_TOOL_CONNECTION_FILE: join(f.root, "ambient-tools.json"),
    THOUGHTLOOM_UNSELECTED: "ambient-setting-must-not-forward",
    ...(host?.shell ? { THOUGHTLOOM_ALLOWED_HOST: host.shell } : {}),
    ...(bind?.shell ? { THOUGHTLOOM_WEB_HOST: bind.shell } : {}),
  };
  const captured = [...Object.keys(selected), "THOUGHTLOOM_ALLOWED_HOST", "THOUGHTLOOM_WEB_HOST", "THOUGHTLOOM_NATIVE_CONFIG_FILE", "THOUGHTLOOM_TOOL_CONNECTION_FILE", "THOUGHTLOOM_UNSELECTED", "THOUGHTLOOM_DAEMON_URL", "NEXT_TELEMETRY_DISABLED", "FIXTURE_DOTENV_LEAK"];
  const metadata = { daemon: join(f.root, "daemon-metadata.json"), web: join(f.root, "web-metadata.json") };
  const gates = { daemon: join(f.root, "daemon-ready"), web: join(f.root, "web-ready") };
  for (const service of ["daemon", "web"] as const) {
    const entry = service === "daemon" ? f.daemonEntry : f.nextEntry;
    childMetadata.push({ file: metadata[service], entry });
    // CommonJS runs in both pinned runtimes. This is a small readiness fixture,
    // not an app/SDK emulator: it never opens DB/native/tool config contents.
    await writeFile(entry, `
const { createServer } = require("node:http");
const { existsSync, writeFileSync } = require("node:fs");
const service = ${JSON.stringify(service)};
const captured = ${JSON.stringify(captured)};
const env = Object.fromEntries(captured.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
writeFileSync(${JSON.stringify(metadata[service])}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), execPath: process.execPath, argv: process.argv.slice(2), env }), { mode: 0o600 });
const port = service === "daemon" ? Number(process.env.THOUGHTLOOM_DAEMON_PORT) : Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = createServer((request, response) => {
  if (service === "web" && request.method === "POST" && request.url === "/__fixture/exit") {
    response.end("fixture exit"); server.close(() => process.exit(0)); return;
  }
  const health = service === "daemon" && request.url === "/weaving/status";
  const expected = service === "daemon" ? "/sources/startup-readiness-check" : "/";
  if (request.method !== "GET" || (!health && request.url !== expected)) { response.writeHead(404); response.end(); return; }
  const ready = existsSync(${JSON.stringify(gates[service])});
  console.log("fixture " + service + " probe " + (ready ? "ready" : "not-ready"));
  response.writeHead(ready ? (service === "daemon" && !health ? 404 : 200) : 503, { "content-type": "application/json" });
  response.end(ready && service === "daemon" ? JSON.stringify(health ? { state: "unavailable" } : { error: "Source not found" }) : "{}");
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  writeFileSync(${JSON.stringify(join(f.root, `${service}-stopped`))}, signal, { mode: 0o600 });
  console.log("fixture " + service + " stopped " + signal);
  server.close(() => process.exit(0));
});
server.listen(port, service === "daemon" ? "127.0.0.1" : process.argv[process.argv.indexOf("--hostname") + 1], () => console.log("fixture " + service + " listening"));
`);
  }
  function start() { const child = f.spawn(["start", "--launch-env", f.launchEnv], environment, 10_000); return { child, log: observe(child) }; }
  async function ready() {
    await Promise.all(Object.values(gates).map((gate) => writeFile(gate, "ready")));
    const running = start(); await running.log.until("workspace ready"); return running;
  }
  return { ...f, selected, metadata, gates, privateValues, native, tools, start, ready };
}

async function shutdownRaceFixture(phase: "daemon" | "web") {
  const f = await fixture();
  const services = phase === "daemon" ? ["daemon"] as const : ["daemon", "web"] as const;
  const metadata: Record<string, string> = {};
  for (const service of services) {
    const entry = service === "daemon" ? f.daemonEntry : f.nextEntry;
    const file = join(f.root, `${service}-race-metadata.json`);
    metadata[service] = file;
    childMetadata.push({ file, entry });
    await writeFile(entry, `
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const service = ${JSON.stringify(service)}, holdReadiness = ${JSON.stringify(service === phase)};
writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
const port = service === "daemon" ? Number(process.env.THOUGHTLOOM_DAEMON_PORT) : Number(process.argv[process.argv.indexOf("--port") + 1]);
let pending;
function answer(response, health) {
  response.writeHead(service === "daemon" && !health ? 404 : 200, { "content-type": "application/json" });
  response.end(JSON.stringify(service === "web" ? {} : health ? { state: "unavailable" } : { error: "Source not found" }));
}
const server = createServer((request, response) => {
  const health = service === "daemon" && request.url === "/weaving/status";
  const expected = service === "daemon" ? "/sources/startup-readiness-check" : "/";
  if (request.method !== "GET" || (!health && request.url !== expected)) { response.writeHead(404); response.end(); return; }
  if (holdReadiness) {
    pending = { response, health };
    console.log("fixture " + service + " readiness pending");
  } else answer(response, health);
});
process.on("SIGTERM", () => {
  // Release readiness from inside the signal callback, not after a test sleep:
  // the launcher is stopping while its pending fetch becomes ready. Deliberately
  // hold the child alive so the real launcher's 7s escalation must reap it.
  if (pending) { answer(pending.response, pending.health); pending = undefined; }
  console.log("fixture " + service + " stop-held");
});
server.listen(port, "127.0.0.1");
`);
  }
  return { ...f, metadata, phase };
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function expectChildrenGone(f: { metadata: Record<string, string>; webPort: number; daemonPort: number }) {
  for (const file of Object.values(f.metadata)) expect(isAlive((await readChildMetadata(file)).pid)).toBe(false);
  for (const port of [f.webPort, f.daemonPort]) {
    await new Promise<void>((resolve, reject) => {
      const listener = createServer(); listener.once("error", reject);
      listener.listen(port, "127.0.0.1", () => listener.close((error) => error ? reject(error) : resolve()));
    });
  }
}

test("launcher fixture runs byte-identical CLI and only its disposable dummy child", async () => {
  const f = await fixture();
  expect(await readFile(join(f.scripts, "run.ts"), "utf8")).toBe(await readFile(join(sourceScripts, "run.ts"), "utf8"));
  const result = await f.run(["start"]);
  expect(result.spawned).toBe(true);
  expect(await readFile(f.marker, "utf8")).toBe("dummy child only\n");
  expect(result.exitCode).not.toBe(0); // Dummy exits rather than becoming a service.
});

test("start rejects a missing explicit launch file before spawning, not ambient fallback", async () => {
  const f = await fixture();
  const result = await f.run(["start", "--launch-env", join(f.root, "missing.env")]);
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test("start rejects malformed launch data before spawning", async () => {
  const f = await fixture();
  await writeFile(f.launchEnv, f.contents().replace(/^THOUGHTLOOM_DATABASE_PATH=/, "THOUGHTLOOM_DATABASE_PATH "));
  const result = await f.run(["start", "--launch-env", f.launchEnv]);
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test.each([
  ["relative database", { THOUGHTLOOM_DATABASE_PATH: "relative.sqlite" }],
  ["invalid port", { THOUGHTLOOM_DAEMON_PORT: "not-a-port" }],
  ["same ports", { THOUGHTLOOM_WEB_PORT: "19401", THOUGHTLOOM_DAEMON_PORT: "19401" }],
  ["unknown setting", { THOUGHTLOOM_NOT_A_SETTING: "fixture-private-value-never-print" }],
] satisfies [string, Record<string, string>][])("start rejects explicit %s before spawning with sanitized output", async (_name, overrides) => {
  const f = await fixture();
  await writeFile(f.launchEnv, f.contents(overrides));
  const result = await f.run(["start", "--launch-env", f.launchEnv]);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).not.toContain("fixture-private-value-never-print");
  expect(result.spawned).toBe(false);
});

test.each(["symlink", "world-readable", "relative filename"])("start rejects %s launch file before spawning", async (unsafe) => {
  const f = await fixture();
  let file = f.launchEnv;
  if (unsafe === "symlink") { file = join(f.root, "linked.env"); await symlink(f.launchEnv, file); }
  if (unsafe === "world-readable") await chmod(file, 0o644);
  if (unsafe === "relative filename") file = "../launch-configured.env";
  const result = await f.run(["start", "--launch-env", file]);
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test("start rejects unknown options before spawning", async () => {
  const f = await fixture();
  const result = await f.run(["start", "--launch-env", f.launchEnv, "--not-a-launch-option"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test("start rejects missing production build before spawning the daemon", async () => {
  const f = await fixture();
  await rm(f.build, { recursive: true, force: true });
  const result = await f.run(["start", "--launch-env", f.launchEnv]);
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test("start checks the selected web port before spawning the daemon", async () => {
  const f = await fixture();
  const occupied = server(() => new Response("test-owned listener"));
  await writeFile(f.launchEnv, f.contents({ THOUGHTLOOM_WEB_PORT: String(occupied.port) }));
  const result = await f.run(["start", "--launch-env", f.launchEnv]);
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test("status uses explicit data-only settings from another cwd without children or requiring SQLite", async () => {
  const f = await fixture();
  const requests: string[] = [];
  const web = server((request) => { requests.push(`web ${request.method} ${new URL(request.url).pathname}`); return new Response("test-owned web"); });
  const daemon = server((request) => {
    requests.push(`daemon ${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ state: "unavailable" });
  });
  const databaseName = "literal-$(touch evaluated-by-shell).sqlite";
  const database = join(dirname(f.database), databaseName);
  await writeFile(f.launchEnv, f.contents({ THOUGHTLOOM_DATABASE_PATH: database, THOUGHTLOOM_WEB_PORT: String(web.port), THOUGHTLOOM_DAEMON_PORT: String(daemon.port) }));
  // Status must not need SQLite to parse/open/migrate: this is deliberately not a
  // database. Bytes/mode/sidecars catch mutation, not every possible read-only open.
  await writeFile(database, "opaque fixture: never database content\n", { mode: 0o600 });
  const before = await readFile(database);
  await writeFile(join(f.root, ".env"), "THOUGHTLOOM_DAEMON_PORT=invalid-dotenv-shadow\n");
  const result = await f.run(["status", "--launch-env", f.launchEnv], {
    THOUGHTLOOM_WEB_PORT: "invalid-ambient-shadow", THOUGHTLOOM_DAEMON_PORT: "invalid-ambient-shadow",
    THOUGHTLOOM_DATABASE_PATH: join(f.root, "ambient-must-not-be-created.sqlite"),
    THOUGHTLOOM_NATIVE_CONFIG_FILE: join(f.root, "must-not-read-native.json"),
    THOUGHTLOOM_TOOL_CONNECTION_FILE: join(f.root, "must-not-read-tools.json"),
  });
  expect(result.spawned).toBe(false);
  expect(await readFile(database)).toEqual(before);
  expect((await stat(database)).mode & 0o777).toBe(0o600);
  expect((await readdir(dirname(database))).sort()).toEqual(["fixture.sqlite", databaseName]);
  expect(await Bun.file(join(f.root, "unrelated-working-directory/evaluated-by-shell")).exists()).toBe(false);
  expect(await Bun.file(join(f.root, "ambient-must-not-be-created.sqlite")).exists()).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(String(web.port));
  expect(result.output).toContain(String(daemon.port));
  expect(requests.sort()).toEqual(["daemon GET /weaving/status", "web GET /"]);
});

test("configured foreground start waits for both endpoints, forwards explicit settings and cleans both children on Ctrl+C signal", async () => {
  const f = await servingFixture(true), before = await readFile(f.database);
  const { child, log } = f.start();
  await log.until("fixture daemon probe not-ready");
  expect(log.stdout).not.toContain("workspace.daemon ready");
  expect(log.stdout).not.toContain("workspace ready");
  expect(await Bun.file(f.metadata.web).exists()).toBe(false);
  await writeFile(f.gates.daemon, "ready");
  await log.until("fixture web probe not-ready");
  expect(log.stdout).toContain("workspace.daemon ready");
  expect(log.stdout).not.toContain("workspace ready");
  await writeFile(f.gates.web, "ready");
  await log.until("workspace ready");
  expect(log.stdout).toContain(`http://127.0.0.1:${f.webPort}`);

  const daemon = await readChildMetadata(f.metadata.daemon), web = await readChildMetadata(f.metadata.web);
  expect(daemon.env).toEqual(f.selected);
  expect(web.env).toEqual({ ...f.selected, THOUGHTLOOM_DAEMON_URL: `http://127.0.0.1:${f.daemonPort}`, NEXT_TELEMETRY_DISABLED: "1" });
  expect(daemon.cwd).toBe(f.root);
  expect(web.cwd).toBe(join(f.root, "apps/web"));
  expect(daemon.execPath).toBe(await realpath(process.execPath));
  expect(web.execPath).toBe(await realpath(f.node));
  expect(web.argv).toEqual(["start", "--hostname", "127.0.0.1", "--port", String(f.webPort)]);
  expect(daemon.pid).not.toBe(web.pid);
  expect(isAlive(daemon.pid)).toBe(true); expect(isAlive(web.pid)).toBe(true);

  // Signal the owned foreground launcher, not a port-discovered process or the
  // test runner's process group. This exercises its Ctrl+C handler, not a PTY.
  child.kill("SIGINT");
  expect(await log.exited).toBe(0);
  for (const service of ["daemon", "web"]) expect(await readFile(join(f.root, `${service}-stopped`), "utf8")).toBe("SIGTERM");
  expect(log.stdout.match(/workspace stopping/g)).toHaveLength(1);
  expect(log.stdout.match(/workspace stopped/g)).toHaveLength(1);
  expect(log.stdout.match(/workspace ready/g)).toHaveLength(1);
  expect(await readFile(f.database)).toEqual(before);
  expect(await readFile(f.native, "utf8")).toBe(f.privateValues[0]);
  expect(await readFile(f.tools, "utf8")).toBe(f.privateValues[1]);
  for (const value of f.privateValues) expect(log.stdout + log.stderr).not.toContain(value);
  expect(await Bun.file(join(f.root, "ambient-must-not-exist.sqlite")).exists()).toBe(false);
  await expectChildrenGone(f);
}, 15_000);

test("configured foreground SIGTERM cleans both children and omitted native settings never inherit", async () => {
  const f = await servingFixture(false), { child, log } = await f.ready();
  expect((await readChildMetadata(f.metadata.daemon)).env).toEqual(f.selected);
  expect((await readChildMetadata(f.metadata.web)).env).toEqual({ ...f.selected, THOUGHTLOOM_DAEMON_URL: `http://127.0.0.1:${f.daemonPort}`, NEXT_TELEMETRY_DISABLED: "1" });
  child.kill("SIGTERM");
  expect(await log.exited).toBe(0);
  expect(await readFile(join(f.root, "daemon-stopped"), "utf8")).toBe("SIGTERM");
  expect(await readFile(join(f.root, "web-stopped"), "utf8")).toBe("SIGTERM");
  await expectChildrenGone(f);
}, 15_000);

test.each([
  ["shell only", { shell: accessHost }, accessHost],
  ["launch file only", { file: accessHost }, accessHost],
  ["shell overrides launch file", { file: "file-host.example.test", shell: accessHost }, accessHost],
] satisfies [string, { file?: string; shell?: string }, string][])("configured launch passes allowed host to both children: %s", async (_name, setting, expected) => {
  const f = await servingFixture(false, setting), { child, log } = await f.ready();
  const selected = { ...f.selected, THOUGHTLOOM_ALLOWED_HOST: expected };
  expect((await readChildMetadata(f.metadata.daemon)).env).toEqual(selected);
  expect((await readChildMetadata(f.metadata.web)).env).toEqual({ ...selected, THOUGHTLOOM_DAEMON_URL: `http://127.0.0.1:${f.daemonPort}`, NEXT_TELEMETRY_DISABLED: "1" });
  child.kill("SIGTERM");
  expect(await log.exited).toBe(0);
  await expectChildrenGone(f);
}, 15_000);

test.each(["http://host.example.test", "host.example.test:8080", "host.example.test/path", "*.example.test"])("configured launch rejects invalid allowed host %s before spawning", async (host) => {
  const f = await fixture();
  const result = await f.run(["start", "--launch-env", f.launchEnv], { THOUGHTLOOM_ALLOWED_HOST: host });
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test("invalid launch-file allowed host is rejected even with a valid shell override", async () => {
  const f = await fixture();
  await writeFile(f.launchEnv, f.contents({ THOUGHTLOOM_ALLOWED_HOST: "host.example.test:8080" }));
  const result = await f.run(["start", "--launch-env", f.launchEnv], { THOUGHTLOOM_ALLOWED_HOST: accessHost });
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Invalid or inaccessible launch file/configuration");
  expect(result.spawned).toBe(false);
});

// 127.0.0.2 is a distinct local-only interface address: it exercises a
// non-default bind without relying on a Tailscale interface or live service.
test.each([
  ["shell only", { shell: "127.0.0.2" }],
  ["launch file only", { file: "127.0.0.2" }],
  ["shell overrides launch file", { file: "127.0.0.1", shell: "127.0.0.2" }],
] satisfies [string, { file?: string; shell?: string }][])("configured web bind and readiness use selected IPv4: %s", async (_name, setting) => {
  const f = await servingFixture(false, undefined, setting), { child, log } = await f.ready();
  const selected = { ...f.selected, THOUGHTLOOM_WEB_HOST: "127.0.0.2" };
  const daemon = await readChildMetadata(f.metadata.daemon), web = await readChildMetadata(f.metadata.web);
  expect(daemon.env).toEqual(selected);
  expect(web.env).toEqual({ ...selected, THOUGHTLOOM_DAEMON_URL: `http://127.0.0.1:${f.daemonPort}`, NEXT_TELEMETRY_DISABLED: "1" });
  expect(web.argv).toEqual(["start", "--hostname", "127.0.0.2", "--port", String(f.webPort)]);
  expect(log.stdout).toContain(`http://127.0.0.2:${f.webPort}`);
  const status = await f.run(["status", "--launch-env", f.launchEnv], setting.shell ? { THOUGHTLOOM_WEB_HOST: setting.shell } : {});
  expect(status.exitCode).toBe(0);
  expect(status.output).toContain(`daemon http://127.0.0.1:${f.daemonPort} ready`);
  expect(status.output).toContain(`web http://127.0.0.2:${f.webPort} ready`);
  child.kill("SIGTERM");
  expect(await log.exited).toBe(0);
  await expectChildrenGone(f);
}, 15_000);

test("web port preflight checks the selected bind address before spawning", async () => {
  const f = await fixture();
  const occupied = server(() => new Response("test-owned listener"), "127.0.0.2");
  await writeFile(f.launchEnv, f.contents({ THOUGHTLOOM_WEB_HOST: "127.0.0.2", THOUGHTLOOM_WEB_PORT: String(occupied.port) }));
  const result = await f.run(["start", "--launch-env", f.launchEnv]);
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test.each(["", "--hostname", "http://127.0.0.1", "127.0.0.1:3000", "127.0.0.1/path", "localhost", "256.1.1.1", "::1"])("rejects invalid web bind %j from shell before spawning", async (host) => {
  const f = await fixture();
  const result = await f.run(["start", "--launch-env", f.launchEnv], { THOUGHTLOOM_WEB_HOST: host });
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test.each(["--hostname", "http://127.0.0.1", "127.0.0.1:3000", "localhost", "256.1.1.1"])("rejects invalid web bind %j from launch file before spawning even with valid shell override", async (host) => {
  const f = await fixture();
  await writeFile(f.launchEnv, f.contents({ THOUGHTLOOM_WEB_HOST: host }));
  const result = await f.run(["start", "--launch-env", f.launchEnv], { THOUGHTLOOM_WEB_HOST: "127.0.0.2" });
  expect(result.exitCode).not.toBe(0);
  expect(result.spawned).toBe(false);
});

test("a tracked web child exiting zero stops its sibling and makes the workspace exit nonzero", async () => {
  const f = await servingFixture(false), { log } = await f.ready();
  const response = await fetch(`http://127.0.0.1:${f.webPort}/__fixture/exit`, { method: "POST", signal: AbortSignal.timeout(1_000) });
  expect(response.status).toBe(200); await response.body?.cancel();
  expect(await log.exited).toBe(1);
  expect(log.stderr).toContain("workspace child exited");
  expect(await readFile(join(f.root, "daemon-stopped"), "utf8")).toBe("SIGTERM");
  expect(await Bun.file(join(f.root, "web-stopped")).exists()).toBe(false);
  await expectChildrenGone(f);
}, 15_000);

test.each(["malformed", "timeout"])("status reports %s daemon readiness without spawning or changing the database", async (behavior) => {
  const f = await fixture(), before = await readFile(f.database);
  const requests: string[] = [];
  const web = server((request) => { requests.push(`web ${request.method} ${new URL(request.url).pathname}`); return new Response("fixture web"); });
  const daemon = server((request) => {
    requests.push(`daemon ${request.method} ${new URL(request.url).pathname}`);
    return behavior === "malformed" ? Response.json({ state: "Not a worker state" }) : new Promise<Response>(() => {});
  });
  await writeFile(f.launchEnv, f.contents({ THOUGHTLOOM_WEB_PORT: String(web.port), THOUGHTLOOM_DAEMON_PORT: String(daemon.port) }));
  const started = performance.now();
  const result = await f.run(["status", "--launch-env", f.launchEnv]);
  expect(performance.now() - started).toBeLessThan(4_000);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`daemon http://127.0.0.1:${daemon.port} unavailable`);
  expect(result.output).toContain(`web http://127.0.0.1:${web.port} ready`);
  expect(requests.sort()).toEqual(["daemon GET /weaving/status", "web GET /"]);
  expect(result.spawned).toBe(false);
  expect(await readFile(f.database)).toEqual(before);
  expect(await readdir(dirname(f.database))).toEqual(["fixture.sqlite"]);
});

test.each(["daemon", "web"] as const)("FGL-01 SIGINT during %s readiness waits for delayed children and reaps them before launcher exit", async (phase) => {
  const f = await shutdownRaceFixture(phase);
  const child = f.spawn(["start", "--launch-env", f.launchEnv], {}, 12_000), log = observe(child);
  await log.until(`fixture ${phase} readiness pending`);
  const pids = await Promise.all(Object.values(f.metadata).map(async (file) => (await readChildMetadata(file)).pid));
  child.kill("SIGINT");
  await log.until(`fixture ${phase} stop-held`);
  // Use the launcher exit itself, not log.exited: an orphan can keep inherited
  // stdout open after its launcher has already exited. Check before teardown's
  // guarded orphan cleanup, which must not turn the regression into a pass.
  expect(await child.exited).toBe(0);
  expect(pids.map(isAlive)).toEqual(pids.map(() => false));
  expect(await log.exited).toBe(0);
  expect(log.stdout.match(/workspace stopping/g)).toHaveLength(1);
  expect(log.stdout.match(/workspace stopped/g)).toHaveLength(1);
  expect(log.stdout).not.toContain("workspace ready");
  expect(await Bun.file(f.marker).exists()).toBe(false);
  await expectChildrenGone(f);
}, 16_000);

test("FGL-02 existing weaving status handler is storage-free even when its database does not exist", async () => {
  const f = await fixture(), missing = join(f.root, "must-not-create.sqlite");
  const before = (await readdir(f.root)).sort();
  const app = createApp({ databasePath: missing });
  const response = await app.request("http://127.0.0.1/weaving/status");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "unavailable" });
  expect(await Bun.file(missing).exists()).toBe(false);
  expect((await readdir(f.root)).sort()).toEqual(before);
});

test("FGL-02 CLI status uses the real storage-free handler, never source reads or migrations", async () => {
  const f = await fixture();
  await rm(f.database);
  const database = new Database(f.database, { create: true });
  try { database.run("CREATE TABLE fixture_sentinel(id INTEGER PRIMARY KEY)"); database.run("INSERT INTO fixture_sentinel VALUES(1)"); }
  finally { database.close(); }
  await chmod(f.database, 0o600);
  const snapshot = async () => ({
    files: (await readdir(dirname(f.database))).sort(),
    sha256: createHash("sha256").update(await readFile(f.database)).digest("hex"),
    mode: (await stat(f.database)).mode & 0o777,
  });
  const before = await snapshot(), requests: string[] = [];
  // Real Hono handlers, but no index.ts, supervisor, adapter or worker startup.
  // A source probe would initialize/migrate this test-owned version-zero DB.
  const app = createApp({ databasePath: f.database });
  const daemon = server((request) => { requests.push(`${request.method} ${new URL(request.url).pathname}`); return app.fetch(request); });
  const web = server(() => new Response("fixture web"));
  await writeFile(f.launchEnv, f.contents({ THOUGHTLOOM_WEB_PORT: String(web.port), THOUGHTLOOM_DAEMON_PORT: String(daemon.port) }));
  const result = await f.run(["status", "--launch-env", f.launchEnv]);
  expect(result.exitCode).toBe(0);
  expect(result.spawned).toBe(false);
  expect(await snapshot()).toEqual(before);
  expect(requests.some((request) => request.includes(" /sources/"))).toBe(false);
  expect(requests).toEqual(["GET /weaving/status"]);
});
