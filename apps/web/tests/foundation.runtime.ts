import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { captureDaemon, checkCaptureBrowser, checkCaptureRoute } from "./capture.runtime";

// Explicit opt-in: builds and starts the real application with test-owned configuration.
const web = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(web, "../..");
const token = "foundation-owned-token-9f6e7a";
const delay = (ms: number) => new Promise<void>(resolveDelay => { setTimeout(resolveDelay, ms).unref(); });

async function createFixture(temp: string): Promise<string> {
  // Deliberately enumerate working-tree inputs. Never copy dotenv, data, build output,
  // generated launchers, or arbitrary public files into the Next project.
  // Next build generates next-env.d.ts and .next inside the owned fixture.
  const inputs = [
    "package.json", "bun.lock", "tsconfig.json", "src/logging.ts",
    "apps/web/package.json", "apps/web/tsconfig.json",
    "apps/web/public/fonts/SourceSans3-VariableFont_wght.ttf", "apps/web/public/fonts/OFL.txt",
    "apps/web/src/proxy.ts", "apps/web/src/components/primary-navigation.tsx", "apps/web/src/components/capture-form.tsx",
    "apps/web/src/app/globals.css", "apps/web/src/app/layout.tsx", "apps/web/src/app/page.tsx",
    "apps/web/src/app/explore/page.tsx", "apps/web/src/app/capture/page.tsx",
    "apps/web/src/app/api/capture/route.ts", "apps/web/src/features/capture/submission.ts",
    "apps/web/src/server/capture.ts",
    "apps/web/src/server/client.ts", "apps/web/src/server/config.ts",
    "apps/web/src/server/daemon.ts", "apps/web/src/server/request-guard.ts",
  ];
  const fixture = resolve(temp, "workspace");
  for (const input of inputs) {
    const source = resolve(root, input);
    assert.ok((await lstat(source)).isFile(), `Fixture input must be a regular file: ${input}`);
    const target = resolve(fixture, input);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  for (const dir of [fixture, resolve(fixture, "apps/web")]) {
    const names = await readdir(dir);
    assert.equal(names.filter(name => [".env", ".env.local", ".env.production", ".env.production.local"].includes(name)).length, 0, `Fixture must not contain Next environment files: ${dir}`);
  }
  // Turbopack cannot resolve dependency links outside the workspace root. Install
  // the exact lock into the fixture instead; only package artifacts use the cache.
  await runChecked(fixture, [
    "--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline",
    "--cache-dir", resolve(homedir(), ".bun/install/cache"), "--backend=copyfile",
  ], { NODE_ENV: "test", PATH: process.env.PATH, HOME: temp, TMPDIR: temp }, "Fixture dependency install", 120_000);
  const fixtureWeb = resolve(fixture, "apps/web");
  const nextManifest = createRequire(resolve(fixtureWeb, "package.json")).resolve("next/package.json");
  assert.ok((await realpath(nextManifest)).startsWith(`${await realpath(fixture)}${sep}`), "Next must resolve inside the owned workspace");
  return fixtureWeb;
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

function collect(child: ChildProcess): () => string {
  let output = "";
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16000); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2000).then(() => { throw new Error("Owned child did not stop after SIGKILL"); })]);
  }
}

async function runChecked(cwd: string, args: string[], env: NodeJS.ProcessEnv, label: string, timeoutMs: number): Promise<void> {
  const child = run(cwd, args, env);
  const output = collect(child);
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  try {
    const result = await Promise.race([exited, delay(timeoutMs).then(() => { throw new Error(`${label} timed out`); })]);
    assert.equal(result, 0, `${label} failed:\n${output()}`);
  } finally { await stop(child); }
}

async function assertStaticClean(dir: string, secrets: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await assertStaticClean(path, secrets);
    else if (entry.isFile()) {
      const content = await readFile(path);
      for (const secret of secrets) assert.equal(content.includes(Buffer.from(secret)), false, `Client asset contains sentinel: ${path}`);
    }
  }
}

// Raw HTTP avoids fetch's automatic Host header when testing absent/spoofed authority.
async function raw(port: number, request: string): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("HTTP probe timed out")));
    socket.on("connect", () => socket.write(request));
    socket.on("data", chunk => { response += chunk.toString(); });
    socket.on("error", reject);
    socket.on("end", () => {
      const split = response.indexOf("\r\n\r\n");
      const headers = response.slice(0, split);
      const status = Number(/^HTTP\/\d(?:\.\d)? (\d+)/.exec(headers)?.[1]);
      if (split < 0 || !status) return reject(new Error("Invalid HTTP probe response"));
      resolveResponse({ status, headers, body: response.slice(split + 4) });
    });
  });
}

async function main(): Promise<void> {
  const temp = await mkdtemp("/tmp/opencode/thoughtloom-runtime-");
  let daemon: ReturnType<typeof createServer> | undefined;
  let server: ChildProcess | undefined;
  try {
  const fixtureWeb = await createFixture(temp);
  const fixtureDaemon = captureDaemon(token);
  daemon = createServer(fixtureDaemon.handler);
  const ownedDaemon = daemon;
  await new Promise<void>(resolveListen => ownedDaemon.listen(0, "127.0.0.1", resolveListen));
  // Release an owned ephemeral port for Next. A competing bind fails the test, never selects a shared service.
  const reservation = createServer();
  await new Promise<void>(resolveListen => reservation.listen(0, "127.0.0.1", resolveListen));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => reservation.close(error => error ? reject(error) : resolveClose()));
  const origin = `http://127.0.0.1:${port}`;
  const daemonOrigin = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
  const secrets = [token, daemonOrigin];
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, HOME: temp, TMPDIR: temp, NEXT_TELEMETRY_DISABLED: "1", THOUGHTLOOM_WEB_ORIGIN: origin, THOUGHTLOOM_DAEMON_URL: daemonOrigin, THOUGHTLOOM_USER_TOKEN: token };
    await runChecked(fixtureWeb, ["--no-env-file", "run", "--bun", "next", "build"], env, "Next build", 120_000);
    await assertStaticClean(resolve(fixtureWeb, ".next/static"), secrets);
    server = run(fixtureWeb, ["--no-env-file", "run", "--bun", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], env);
    const output = collect(server);
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && server.exitCode === null) {
      try { const response = await fetch(`${origin}/explore`, { signal: AbortSignal.timeout(1000) }); if (response.status === 200) { ready = true; break; } } catch { /* startup */ }
      await delay(100);
    }
    assert.ok(ready, `Owned Next server did not become ready:\n${output()}`);
    const host = `127.0.0.1:${port}`;
    const probe = (method: string, path: string, headers: string, body = "") => raw(port, `${method} ${path} HTTP/1.0\r\n${headers}Connection: close\r\n\r\n${body}`);
    const trusted = await probe("GET", "/explore", `Host: ${host}\r\n`);
    assert.equal(trusted.status, 200);
    assert.match(trusted.headers, /cache-control:.*(?:private|no-store)/i);
    for (const secret of secrets) assert.ok(!trusted.body.includes(secret), "HTML contains sentinel");
    assert.ok((await probe("GET", "/explore", "")).status >= 400, "missing Host must be denied");
    assert.equal((await probe("GET", "/explore", `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
    assert.equal((await probe("GET", "/explore?_rsc=owned", `Host: foreign.invalid\r\nRSC: 1\r\nNext-Router-Prefetch: 1\r\n`)).status, 403);
    assert.equal((await probe("POST", "/explore", `Host: ${host}\r\nContent-Length: 0\r\n`)).status, 403);
    assert.equal((await probe("POST", "/explore", `Host: ${host}\r\nOrigin: http://foreign.invalid\r\nContent-Length: 0\r\n`)).status, 403);
    const allowed = await probe("POST", "/explore", `Host: ${host}\r\nOrigin: ${origin}\r\nContent-Length: 0\r\n`);
    assert.notEqual(allowed.status, 403, "same-origin mutation should reach Next's router");
    await checkCaptureRoute({ origin, host, probe, daemon: fixtureDaemon });

    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    try {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
        const page = await browser.newPage({ viewport });
        const leaks: string[] = [];
        page.on("request", request => {
          const url = request.url();
          if (url.startsWith(daemonOrigin) || secrets.some(secret => url.includes(secret)) || request.headers().authorization?.includes(token)) leaks.push("browser request exposed daemon configuration");
        });
        page.on("console", message => { if (secrets.some(secret => message.text().includes(secret))) leaks.push("console exposed daemon configuration"); });
        page.on("pageerror", error => { if (secrets.some(secret => error.message.includes(secret))) leaks.push("page error exposed daemon configuration"); });
        try {
          await page.goto(`${origin}/explore`, { waitUntil: "networkidle" });
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Skip to content");
          await page.keyboard.press("Enter");
          assert.equal(await page.evaluate(() => document.activeElement?.id), "main-content");
          assert.equal(await page.getByRole("heading", { name: "Explore" }).count(), 1);
          assert.equal(await page.locator('[aria-disabled="true"]').filter({ hasText: "Settings" }).count(), 1);
          assert.equal(await page.getByRole("link", { name: "Settings" }).count(), 0);
          await page.getByRole("link", { name: "Capture", exact: true }).click();
          await page.waitForURL("**/capture");
          assert.equal(await page.getByRole("heading", { name: "Capture" }).count(), 1);
          await checkCaptureBrowser(page, fixtureDaemon);
          await page.getByRole("link", { name: "Explore", exact: true }).click();
          await page.waitForURL("**/explore");
          await page.evaluate(() => document.fonts.ready);
          assert.ok(await page.evaluate(() => Array.from(document.fonts).some(font => font.status === "loaded" && font.family.toLowerCase().includes("source"))), "local Source Sans font should load");
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal overflow");
          const html = await page.content();
          for (const secret of secrets) assert.ok(!html.includes(secret), "browser HTML contains sentinel");
          assert.deepEqual(leaks, []);
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
    console.log("Foundation and capture runtime checks passed");
  } finally {
    if (server) await stop(server);
    if (daemon?.listening) {
      daemon.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => daemon?.close(error => error ? reject(error) : resolveClose()));
    }
    await rm(temp, { recursive: true, force: true });
  }
}

await main();
