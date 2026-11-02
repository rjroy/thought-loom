import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { accessHost } from "../fixtures/access-host";

// This test never builds. The caller supplies a separately built, isolated copy;
// Next may write caches, so require both checkout and build under /tmp/opencode.

async function reservePort(bind: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, bind, resolvePromise);
  });
  const address = server.address();
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  if (!address || typeof address === "string" || [3000, 3001, 4173, 4174].includes(address.port)) throw new Error("Expected an isolated ephemeral port");
  return address.port;
}

for (const { bind, connect } of [
  { bind: "0.0.0.0", connect: "127.0.0.1" },
  // A second loopback address needs no machine-specific interface, yet is not
  // an authority accepted by the shared guard, just like a Tailscale IPv4.
  { bind: "127.0.0.2", connect: "127.0.0.2" },
]) test(`production Next ${bind} bind separates internal URL from external authority`, async () => {
  const selectedRoot = process.env.THOUGHTLOOM_TEST_NEXT_BUILD_ROOT;
  if (!selectedRoot) throw new Error("Set THOUGHTLOOM_TEST_NEXT_BUILD_ROOT to an isolated, prebuilt checkout");
  const root = await realpath(resolve(selectedRoot));
  const temporaryRoot = await realpath("/tmp/opencode");
  if (!root.startsWith(`${temporaryRoot}/`)) throw new Error("Production Next test requires an isolated checkout under /tmp/opencode");
  const webDirectory = join(root, "apps/web");
  const buildDirectory = await realpath(join(webDirectory, ".next"));
  if (!buildDirectory.startsWith(`${temporaryRoot}/`)) throw new Error("Production build must be under /tmp/opencode");
  const next = Bun.resolveSync("next/dist/bin/next", webDirectory);
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required for the production Next fixture");
  const directory = await mkdtemp("/tmp/opencode/thoughtloom-next-wildcard-");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const port = await reservePort(bind);
    child = Bun.spawn([node, next, "start", "--hostname", bind, "--port", String(port)], {
      cwd: webDirectory,
      env: {
        PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: directory, TMPDIR: directory,
        NEXT_TELEMETRY_DISABLED: "1", THOUGHTLOOM_ALLOWED_HOST: accessHost,
        THOUGHTLOOM_WEB_HOST: bind, THOUGHTLOOM_DAEMON_URL: "http://127.0.0.1:1",
      },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const url = `http://${connect}:${port}/`;
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(url, { headers: { host: `127.0.0.1:${port}` }, signal: AbortSignal.timeout(500) });
        await response.body?.cancel();
        ready = true; // Even a 403 proves Next is listening; assertions diagnose it.
        break;
      } catch { await Bun.sleep(100); }
    }
    if (!ready) throw new Error(`Production Next fixture failed to listen (exit ${child.exitCode})`);
    const approved = `${accessHost}:${port}`;
    const cases: { headers: Record<string, string>; status: number }[] = [
      { headers: { host: approved }, status: 200 },
      { headers: { host: approved, origin: `http://${approved}` }, status: 200 },
      { headers: { host: `127.0.0.1:${port}` }, status: 200 },
      { headers: { host: `${bind}:${port}` }, status: 403 },
      { headers: { host: `${accessHost.replace(/\.test$/, "")}:${port}` }, status: 403 },
      { headers: { host: `attacker.example:${port}`, "x-forwarded-host": `127.0.0.1:${port}` }, status: 403 },
      { headers: { host: approved, origin: "http://attacker.example" }, status: 403 },
      { headers: { host: approved, "x-forwarded-host": "attacker.example" }, status: 403 },
      { headers: { host: approved, "x-forwarded-proto": "https" }, status: 403 },
      { headers: { host: approved, forwarded: "host=localhost" }, status: 403 },
    ];
    for (const { headers, status } of cases) {
      const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      expect(response.status, JSON.stringify(headers)).toBe(status);
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const deadline = setTimeout(() => { if (child?.exitCode === null) child.kill("SIGKILL"); }, 5_000);
      try { await child.exited; } finally { clearTimeout(deadline); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
