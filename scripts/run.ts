import { resolve } from "node:path";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") throw new Error("Expected dev or start");
const root = resolve(import.meta.dir, "..");
const webDirectory = resolve(root, "apps/web");
const databasePath = resolve(process.env.THOUGHTLOOM_DATABASE_PATH ?? resolve(root, ".data/thoughtloom.sqlite"));

function configuredPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be between 1024 and 65535`);
  return value;
}
const webPort = configuredPort("THOUGHTLOOM_WEB_PORT", 3000);
const daemonPort = configuredPort("THOUGHTLOOM_DAEMON_PORT", 3001);
if (webPort === daemonPort) throw new Error("Web and daemon ports must differ");
const daemonURL = `http://127.0.0.1:${daemonPort}`;
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;

async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  console.info("workspace stopping");
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  const deadline = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  }, 7_000);
  await Promise.all(children.map((child) => child.exited));
  clearTimeout(deadline);
  console.info("workspace stopped");
  process.exit(code);
}
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));

try {
  console.info("workspace.daemon starting", { databasePath, port: daemonPort });
  const daemon = Bun.spawn([process.execPath, "run", resolve(root, "apps/daemon/src/index.ts")], {
    cwd: root,
    env: { ...process.env, THOUGHTLOOM_DATABASE_PATH: databasePath, THOUGHTLOOM_DAEMON_PORT: String(daemonPort) },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(daemon);
  let ready = false;
  const deadline = Date.now() + 15_000;
  while (!ready && Date.now() < deadline && daemon.exitCode === null && !stopping) {
    try {
      const response = await fetch(`${daemonURL}/sources/startup-readiness-check`, { signal: AbortSignal.timeout(500) });
      const body: unknown = await response.json();
      ready = response.status === 404 && typeof body === "object" && body !== null && "error" in body && body.error === "Source not found";
    } catch { /* The owned child may not be listening yet. */ }
    if (!ready) await Bun.sleep(100);
  }
  if (!ready) throw new Error("Owned daemon did not become ready");
  if (stopping) process.exit(0);
  console.info("workspace.daemon ready");
  console.info("workspace.web starting", { mode, url: `http://127.0.0.1:${webPort}` });
  const web = Bun.spawn(["node", Bun.resolveSync("next/dist/bin/next", webDirectory), mode, "--hostname", "127.0.0.1", "--port", String(webPort)], {
    cwd: webDirectory,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", THOUGHTLOOM_DAEMON_URL: daemonURL },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(web);
  await Promise.race(children.map(async (child) => {
    const code = await child.exited;
    if (!stopping) {
      console.error("workspace child exited", { pid: child.pid, code });
      await stop(code === 0 ? 1 : code);
    }
  }));
} catch {
  console.error("workspace startup failed", { category: "service_startup_error" });
  await stop(1);
}
