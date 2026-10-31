// Browser-test composition only: no production hooks, model, or worker.
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createApp } from "../../apps/daemon/src/app";
import { seedInquiryExample } from "../fixtures/seed-inquiry";

function portFromEnvironment(name: string, fallback: number): number {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535`);
  }
  return port;
}

const webPort = portFromEnvironment("THOUGHTLOOM_E2E_WEB_PORT", 4317);
const daemonPort = portFromEnvironment("THOUGHTLOOM_E2E_DAEMON_PORT", 4318);
if (webPort === daemonPort) throw new Error("Browser-test service ports must differ");

const directory = await mkdtemp("/tmp/opencode/thoughtloom-browser-");
const databasePath = join(directory, "capture.sqlite");
let daemon: ReturnType<typeof Bun.serve> | undefined;
let web: ReturnType<typeof Bun.spawn> | undefined;
let stopping = false;

async function stop(exitCode: number) {
  if (stopping) return;
  stopping = true;
  console.info("browser.harness stopping");
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    const deadline = setTimeout(() => web?.kill("SIGKILL"), 5_000);
    await web.exited;
    clearTimeout(deadline);
  }
  await daemon?.stop(true);
  await rm(directory, { recursive: true, force: true });
  console.info("browser.harness stopped", { removedTemporaryDatabase: true });
  process.exit(exitCode);
}

process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));

try {
  seedInquiryExample(databasePath);
  console.info("browser.harness daemon starting", { databasePath, port: daemonPort });
  daemon = Bun.serve({
    hostname: "127.0.0.1",
    port: daemonPort,
    fetch: createApp({ databasePath }).fetch,
  });
  console.info("browser.harness daemon listening", { port: daemon.port });

  const webDirectory = resolve(import.meta.dir, "../../apps/web");
  const nextCli = Bun.resolveSync("next/dist/bin/next", webDirectory);
  console.info("browser.harness web starting", { port: webPort });
  web = Bun.spawn(["node", nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(webPort)], {
    cwd: webDirectory,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      // Server-side BFF configuration; never passed as NEXT_PUBLIC_*.
      THOUGHTLOOM_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await web.exited;
  if (!stopping) {
    console.error("browser.harness web exited unexpectedly", { code });
    await stop(code === 0 ? 1 : code);
  }
} catch (error) {
  console.error("browser.harness startup failed", { error });
  await stop(1);
}
