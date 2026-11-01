import { createServer } from "node:net";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { readLaunchConfig } from "./launch-config";

const root = resolve(import.meta.dir, "..");
const webDirectory = resolve(root, "apps/web");
const [mode, ...args] = process.argv.slice(2);
if (mode !== "dev" && mode !== "start" && mode !== "status") throw new Error("Expected dev, start, or status");
if (args.length && (args.length !== 2 || args[0] !== "--launch-env" || !args[1] || args[1].startsWith("--"))) throw new Error("Expected --launch-env ABSOLUTE_FILE");
if ((mode === "status" && args.length !== 2) || (mode === "dev" && args.length)) throw new Error("Launch file is supported by start and required by status");

function configuredPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be between 1024 and 65535`);
  return value;
}

async function endpointReady(url: string, daemon: boolean): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(700) });
    if (!daemon) { await response.body?.cancel(); return response.status >= 200 && response.status < 300; }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); return false; }
    const reader = response.body.getReader();
    let text = "";
    const decoder = new TextDecoder();
    while (text.length <= 4096) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    if (text.length > 4096) return false;
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && "state" in body &&
      typeof body.state === "string" && ["starting", "working", "waiting", "unavailable", "failed", "stopped"].includes(body.state);
  } catch { return false; }
}

async function checkPort(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Loopback port ${port} is unavailable`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolvePromise()));
  });
}

let config: Awaited<ReturnType<typeof readLaunchConfig>> | undefined;
try { if (args.length) config = await readLaunchConfig(args[1]); }
catch (error) {
  // Never print filesystem errors or launch values, which can contain private paths.
  console.error("Invalid or inaccessible launch file/configuration; check its ownership, mode, paths and settings.");
  process.exit(1);
}
const databasePath = config?.databasePath ?? resolve(process.env.THOUGHTLOOM_DATABASE_PATH ?? resolve(root, ".data/thoughtloom.sqlite"));
const webPort = config?.webPort ?? configuredPort("THOUGHTLOOM_WEB_PORT", 3000);
const daemonPort = config?.daemonPort ?? configuredPort("THOUGHTLOOM_DAEMON_PORT", 3001);
if (webPort === daemonPort) throw new Error("Web and daemon ports must differ");
const daemonURL = `http://127.0.0.1:${daemonPort}`;
const webURL = `http://127.0.0.1:${webPort}`;
const daemonReadiness = `${daemonURL}/weaving/status`;

if (mode === "status") {
  const [daemonReady, webReady] = await Promise.all([endpointReady(daemonReadiness, true), endpointReady(`${webURL}/`, false)]);
  console.info(`HTTP readiness (not process ownership): daemon ${daemonURL} ${daemonReady ? "ready" : "unavailable"}; web ${webURL} ${webReady ? "ready" : "unavailable"}`);
  process.exit(daemonReady && webReady ? 0 : 1);
}

let node = "node";
let next: string;
try {
  node = Bun.which("node") ?? "";
  if (!node) throw new Error("Node executable not found on PATH; select the project's Node runtime");
  next = Bun.resolveSync("next/dist/bin/next", webDirectory);
  if (config) {
    if (!(await stat(resolve(webDirectory, ".next/BUILD_ID"))).isFile()) throw new Error("Production build is missing");
    await checkPort(webPort);
    await checkPort(daemonPort);
  }
} catch (error) {
  console.error("Workspace preflight failed:", error instanceof Error && (error.message.startsWith("Loopback port") || error.message.startsWith("Node executable")) ? error.message : "check Node, Next and the existing production build");
  process.exit(1);
}

const childEnv = { ...process.env };
if (config) {
  for (const key of Object.keys(childEnv)) if (key.startsWith("THOUGHTLOOM_")) delete childEnv[key];
  Object.assign(childEnv, config.values);
}
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
let shutdown: Promise<void> | undefined;
function stop(code: number): Promise<void> {
  if (shutdown) return shutdown;
  stopping = true;
  shutdown = (async () => {
    console.info("workspace stopping");
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    const deadline = setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }, 7_000);
    await Promise.all(children.map((child) => child.exited));
    clearTimeout(deadline);
    console.info("workspace stopped");
    process.exit(code);
  })();
  return shutdown;
}
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));

try {
  console.info("workspace.daemon starting", { port: daemonPort });
  const daemon = Bun.spawn([process.execPath, ...(config ? ["--no-env-file"] : []), "run", resolve(root, "apps/daemon/src/index.ts")], {
    cwd: root, env: { ...childEnv, THOUGHTLOOM_DATABASE_PATH: databasePath, THOUGHTLOOM_DAEMON_PORT: String(daemonPort) }, stdout: "inherit", stderr: "inherit",
  });
  children.push(daemon);
  let ready = false;
  const deadline = Date.now() + 15_000;
  while (!ready && Date.now() < deadline && daemon.exitCode === null && !stopping) {
    ready = await endpointReady(daemonReadiness, true);
    if (!ready) await Bun.sleep(100);
  }
  if (stopping) await stop(0);
  if (!ready) throw new Error("Owned daemon did not become ready");
  console.info("workspace.daemon ready");
  console.info("workspace.web starting", { mode });
  const web = Bun.spawn([node, next, mode, "--hostname", "127.0.0.1", "--port", String(webPort)], {
    cwd: webDirectory, env: { ...childEnv, NEXT_TELEMETRY_DISABLED: "1", THOUGHTLOOM_DAEMON_URL: daemonURL }, stdout: "inherit", stderr: "inherit",
  });
  children.push(web);
  const webDeadline = Date.now() + 15_000;
  ready = false;
  while (!ready && Date.now() < webDeadline && web.exitCode === null && daemon.exitCode === null && !stopping) {
    ready = await endpointReady(`${webURL}/`, false);
    if (!ready) await Bun.sleep(100);
  }
  if (stopping) await stop(0);
  if (!ready || web.exitCode !== null || daemon.exitCode !== null) throw new Error("Workspace did not become ready");
  console.info("workspace ready", { url: webURL });
  await Promise.race(children.map(async (child) => {
    const code = await child.exited;
    if (!stopping) {
      console.error("workspace child exited", { pid: child.pid, code });
      await stop(code === 0 ? 1 : code);
    }
  }));
  if (stopping) await stop(0);
} catch {
  if (stopping) await stop(0);
  console.error("workspace startup failed", { category: "service_startup_error" });
  await stop(1);
}
