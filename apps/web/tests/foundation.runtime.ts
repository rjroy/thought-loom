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
import { chromium, expect } from "@playwright/test";
import { checkRootSplash } from "./root-splash.runtime";
import { captureDaemon, checkCaptureBrowser, checkCaptureRoute } from "./capture.runtime";
import { searchDaemon, checkSearchRoute, checkExploreBrowser, checkExploreGlyphs } from "./explore.runtime";
import { ideaDaemon, checkIdeaRoute, checkIdeaReinterpretRoute, checkIdeaReinterpretBrowser, checkIdeaBrowser, checkIdeaGlyphs } from "./idea.runtime";
import { evolveDaemon, checkEvolveRoute, checkEvolveBrowser, checkEvolveGlyphs } from "./evolve.runtime";
import { exportDaemon, checkExportRoute, checkExportBrowser } from "./export.runtime";
import { importDaemon, checkImportEntry, checkImportBrowser, checkLargeImportRoute } from "./import.runtime";
import { checkMediaImportEntry, checkMediaUploadRecovery, checkMediaSourceStatus, checkMediaSourceGates, checkMediaSourceRetry, checkMediaSourceRejected, checkMediaSourceRestore, checkMediaSourceTitleRace, checkMediaSourceCommandRace, checkMediaExploreSurface, checkMediaEvolveSurface, checkMediaAskSurface, checkMediaExportSurface, checkMediaReinterpretStatusOwner } from "./media-import.runtime";
import { agenticSearchDaemon, checkAgenticSearchRoutes, checkAgenticSearchEntry, checkAgenticSearchSaved, checkAgenticWorkspaceRoutes, checkAgenticTurnRoutes, checkAgenticRunRoutes, checkAgenticRecoveryKey, checkAgenticLargePreview, checkAgenticWorkspaceBrowser, checkAgenticUnknownAdmission, checkAgenticChangedContext, checkAgenticReturnNavigation, checkAgenticSessionActions, checkAgenticUnavailable, checkAgenticIdleReadRetry, checkAgenticActiveReadingPosition } from "./agentic-search.runtime";

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
    "apps/web/package.json", "apps/web/tsconfig.json", "apps/web/next.config.ts",
    "apps/web/public/fonts/SourceSans3-VariableFont_wght.ttf", "apps/web/public/fonts/OFL.txt",
    "apps/web/public/backgrounds/explore-clearing.png",
    "apps/web/public/backgrounds/capture-canopy.png",
    "apps/web/public/backgrounds/splash-landscape.webp", "apps/web/public/backgrounds/splash-complete.webp",
    "apps/web/public/glyphs/lantern.svg", "apps/web/public/glyphs/sprout.svg",
    "apps/web/public/glyphs/captured-original.svg", "apps/web/public/glyphs/user-contribution.svg", "apps/web/public/glyphs/ai-interpretation.svg",
    "apps/web/public/glyphs/developing-idea.svg", "apps/web/public/glyphs/imported-original.svg", "apps/web/public/glyphs/full-reply.svg",
    "apps/web/public/glyphs/evolution.svg", "apps/web/public/glyphs/connection.png", "apps/web/public/glyphs/used-as-source.png",
    "apps/web/src/components/content-glyph.tsx", "apps/web/src/components/content-glyph.module.css",
    "apps/web/src/proxy.ts", "apps/web/src/components/primary-navigation.tsx", "apps/web/src/components/contextual-back.tsx", "apps/web/src/components/capture-form.tsx",
    "apps/web/src/components/explore-view.tsx", "apps/web/src/components/explore-provider.tsx", "apps/web/src/components/explore.module.css",
    "apps/web/src/components/root-splash.tsx", "apps/web/src/components/root-splash-scene.tsx", "apps/web/src/components/root-splash-shell.tsx", "apps/web/src/components/root-splash.module.css",
    "apps/web/src/components/agentic-search-provider.tsx", "apps/web/src/features/agentic-search/types.ts", "apps/web/src/features/agentic-search/request.ts", "apps/web/src/features/agentic-search/location.ts", "apps/web/src/features/agentic-search/controller.ts",
    "apps/web/src/components/agentic-search-view.tsx", "apps/web/src/components/agentic-search-sessions.tsx", "apps/web/src/components/agentic-search-content.tsx", "apps/web/src/components/agentic-search.module.css",
    "apps/web/src/app/explore/ask/page.tsx", "apps/web/src/app/explore/ask/saved/page.tsx", "apps/web/src/app/explore/ask/[id]/page.tsx", "apps/web/src/app/explore/ask/[id]/history/page.tsx",
    "apps/web/src/app/ideas/[id]/page.tsx", "apps/web/src/components/idea-view.tsx", "apps/web/src/components/idea.module.css", "apps/web/src/components/idea-navigation-provider.tsx",
    "apps/web/src/components/connection-editor.tsx", "apps/web/src/components/connection-thought-picker.tsx", "apps/web/src/components/connection-editor.module.css",
    "apps/web/src/app/evolve/page.tsx", "apps/web/src/components/evolve-view.tsx", "apps/web/src/components/evolve-provider.tsx", "apps/web/src/components/evolve.module.css",
    "apps/web/src/app/export/page.tsx", "apps/web/src/components/export-view.tsx", "apps/web/src/components/export-provider.tsx", "apps/web/src/components/export.module.css",
    "apps/web/src/app/globals.css", "apps/web/src/app/layout.tsx", "apps/web/src/app/page.tsx",
    "apps/web/src/app/explore/page.tsx", "apps/web/src/app/capture/page.tsx",
    "apps/web/src/app/api/capture/route.ts", "apps/web/src/features/capture/submission.ts",
    "apps/web/src/app/api/search/route.ts", "apps/web/src/server/search.ts",
    "apps/web/src/features/explore/query.ts", "apps/web/src/features/explore/results.ts", "apps/web/src/features/explore/request.ts",
    "apps/web/src/app/api/ideas/[id]/route.ts", "apps/web/src/server/idea.ts",
    "apps/web/src/app/api/ideas/[id]/reinterpret/route.ts", "apps/web/src/app/api/ideas/[id]/reinterpret/by-key/[key]/route.ts",
    "apps/web/src/features/idea/reinterpretation.ts", "apps/web/src/server/reinterpretation.ts", "apps/web/src/server/reinterpretation-route.ts",
    "apps/web/src/features/idea/reinterpretation-controller.ts", "apps/web/src/features/idea/reinterpretation-request.ts", "apps/web/src/components/reinterpretation-status.tsx",
    "apps/web/src/features/idea/location.ts", "apps/web/src/features/idea/types.ts", "apps/web/src/features/idea/validation.ts", "apps/web/src/features/idea/request.ts", "apps/web/src/features/idea/media.ts",
    "apps/web/src/app/api/evolve/thoughts/[id]/route.ts", "apps/web/src/app/api/evolve/thoughts/[id]/responses/[responseId]/route.ts",
    "apps/web/src/app/api/evolve/runs/[id]/route.ts", "apps/web/src/server/evolve.ts",
    "apps/web/src/features/evolve/location.ts", "apps/web/src/features/evolve/types.ts", "apps/web/src/features/evolve/validation.ts", "apps/web/src/features/evolve/request.ts",
    "apps/web/src/app/api/export/simple/route.ts", "apps/web/src/app/api/export/agentic/route.ts", "apps/web/src/app/api/export/agentic/[id]/route.ts",
    "apps/web/src/app/api/export/runs/[id]/route.ts", "apps/web/src/app/api/export/thoughts/[id]/route.ts", "apps/web/src/server/export.ts",
    "apps/web/src/features/export/types.ts", "apps/web/src/features/export/request.ts", "apps/web/src/features/export/sources.ts",
    "apps/web/src/components/export-markdown.ts",
    "apps/web/src/app/import/page.tsx", "apps/web/src/components/capture-provider.tsx", "apps/web/src/components/capture.module.css",
    "apps/web/src/app/import/media/page.tsx", "apps/web/src/components/media-import-provider.tsx", "apps/web/src/components/media-import-view.tsx", "apps/web/src/components/media-import.module.css",
    "apps/web/src/components/media-source-details.tsx", "apps/web/src/components/media-source-status.tsx",
    "apps/web/src/features/media/types.ts", "apps/web/src/features/media/request.ts", "apps/web/src/features/media/controller.ts", "apps/web/src/features/media/source-controller.ts",
    "apps/web/src/components/import-view.tsx", "apps/web/src/components/import-provider.tsx", "apps/web/src/components/import-inspection.tsx", "apps/web/src/components/import.module.css",
    "apps/web/src/features/import/types.ts", "apps/web/src/features/import/request.ts",
    "apps/web/src/server/capture.ts",
    "apps/web/src/server/client.ts", "apps/web/src/server/config.ts",
    "apps/web/src/server/daemon.ts", "apps/web/src/server/request-guard.ts",
    "apps/web/src/server/import.ts",
    "apps/web/src/server/media-import-route.ts",
    "apps/web/src/server/search-sessions.ts", "apps/web/src/server/search-session-handler.ts",
    "apps/web/src/server/search-clock.ts", "apps/web/src/server/search-workspace.ts", "apps/web/src/server/search-workspace-handler.ts",
    "apps/web/src/app/api/search-sessions/[id]/messages/route.ts", "apps/web/src/app/api/search-sessions/[id]/discoveries/route.ts", "apps/web/src/app/api/search-sessions/[id]/discoveries/[entryId]/route.ts",
    "apps/web/src/app/api/search-sessions/[id]/composer-contexts/[composerId]/thoughts/[thoughtId]/route.ts", "apps/web/src/app/api/search-sessions/[id]/turns/route.ts", "apps/web/src/app/api/search-sessions/[id]/turns/by-key/[requestKey]/route.ts",
    "apps/web/src/app/api/search-runs/[id]/route.ts", "apps/web/src/app/api/search-runs/[id]/stop/route.ts",
    "apps/web/src/app/api/search-sessions/route.ts", "apps/web/src/app/api/search-sessions/[id]/route.ts",
    "apps/web/src/app/api/search-sessions/[id]/composer-contexts/route.ts", "apps/web/src/app/api/search-sessions/[id]/composer-contexts/[composerId]/route.ts",
    "apps/web/src/app/api/imports/markdown/route.ts", "apps/web/src/app/api/imports/markdown/[id]/route.ts",
    "apps/web/src/app/api/imports/markdown/[id]/files/route.ts", "apps/web/src/app/api/imports/markdown/[id]/files/[fileId]/route.ts", "apps/web/src/app/api/imports/markdown/[id]/seal/route.ts",
    "apps/web/src/app/api/imports/namespaces/route.ts", "apps/web/src/app/api/imports/runs/[id]/route.ts", "apps/web/src/app/api/imports/runs/[id]/stop/route.ts",
    "apps/web/src/app/api/imports/sources/route.ts", "apps/web/src/app/api/imports/sources/[id]/route.ts", "apps/web/src/app/api/imports/sources/[id]/parts/route.ts", "apps/web/src/app/api/imports/sources/[id]/raw/route.ts",
    "apps/web/src/app/api/imports/media/route.ts", "apps/web/src/app/api/imports/media/by-key/[key]/route.ts",
    "apps/web/src/app/api/imports/media-sources/[id]/route.ts", "apps/web/src/app/api/imports/media-sources/[id]/raw/route.ts", "apps/web/src/app/api/imports/media-sources/[id]/retry/route.ts",
    "apps/web/src/app/api/imports/media-runs/[id]/route.ts", "apps/web/src/app/api/imports/media-runs/[id]/stop/route.ts",
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

async function checkDevQueryPrivacy(fixtureWeb: string, env: NodeJS.ProcessEnv, attempts: { path: string }[]): Promise<void> {
  const reservation = createServer();
  await new Promise<void>(resolveListen => reservation.listen(0, "127.0.0.1", resolveListen));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => reservation.close(error => error ? reject(error) : resolveClose()));
    const origin = `http://127.0.0.1:${port}`;
  const child = run(fixtureWeb, ["--no-env-file", "run", "--bun", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    ...env, NODE_ENV: "development", THOUGHTLOOM_WEB_ORIGIN: origin,
  });
  let stdout = "", stderr = "", overflow = false;
  const append = (which: "stdout" | "stderr", chunk: Buffer) => {
    const text = chunk.toString();
    if (stdout.length + stderr.length + text.length > 2_000_000) { overflow = true; return; }
    if (which === "stdout") stdout += text; else stderr += text;
  };
  child.stdout?.on("data", chunk => append("stdout", chunk));
  child.stderr?.on("data", chunk => append("stderr", chunk));
  const closed = new Promise<void>((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", () => resolveClose());
  });
  const apiSentinel = "owned-privacy-api-query-sentinel";
  const pageSentinel = "owned-privacy-bookmark-query-sentinel";
  try {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`${origin}/api/search?q=owned-dev-ready`, { signal: AbortSignal.timeout(10_000) });
        if (response.status === 200) { await response.text(); ready = true; break; }
      } catch { /* Next may still be compiling. */ }
      await delay(100);
    }
    assert.ok(ready, "Owned Next development server did not become ready");
    const before = attempts.length;
    const api = await fetch(`${origin}/api/search?q=${apiSentinel}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(api.status, 200);
    const data = await api.json();
    assert.ok(Array.isArray(data.results), "Search response must reach the actual handler");
    assert.ok(attempts.slice(before).some(attempt => new URL(attempt.path, origin).searchParams.get("q") === apiSentinel), "Owned daemon must receive the search request");
    const bookmark = await fetch(`${origin}/explore?q=${pageSentinel}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(bookmark.status, 200);
    assert.match(bookmark.headers.get("content-type") ?? "", /text\/html/i);
    assert.ok((await bookmark.text()).includes("Thoughtloom"), "Bookmark must reach the rendered application");
  } finally {
    await stop(child);
    await Promise.race([closed, delay(5000).then(() => { throw new Error("Development server output did not drain"); })]);
  }
  assert.equal(overflow, false, "Development output exceeded capture limit");
  for (const [stream, output] of [["stdout", stdout], ["stderr", stderr]] as const) {
    assert.ok(!output.includes(apiSentinel), `Development ${stream} leaked the search API query`);
    assert.ok(!output.includes(pageSentinel), `Development ${stream} leaked the bookmark query`);
  }
}

async function main(): Promise<void> {
  const temp = await mkdtemp("/tmp/opencode/thoughtloom-runtime-");
  let daemon: ReturnType<typeof createServer> | undefined;
  let server: ChildProcess | undefined;
  try {
  const fixtureWeb = await createFixture(temp);
  const fixtureDaemon = captureDaemon(token);
  const fixtureSearch = searchDaemon(token);
  const fixtureIdea = ideaDaemon(token);
  const fixtureEvolve = evolveDaemon(token);
  const fixtureExport = exportDaemon(token);
  const fixtureImport = importDaemon(token);
  const fixtureAgenticSearch = agenticSearchDaemon(token);
  daemon = createServer((request, response) => {
    if (request.url?.startsWith("/search-sessions") || request.url?.startsWith("/runs/owned-search-") || request.url?.startsWith("/thoughts/owned-thought-1")) void fixtureAgenticSearch.handler(request, response);
    else if (request.url?.startsWith("/imports/") || request.url?.startsWith("/import-") || request.url?.startsWith("/runs/import-")) void fixtureImport.handler(request, response);
    else if (request.url?.startsWith("/exports/") || request.url?.startsWith("/runs/export-") || request.url?.startsWith("/thoughts/export-")) void fixtureExport.handler(request, response);
    else if (request.url?.startsWith("/thoughts/evolve-") || request.url?.startsWith("/runs/evolve-")) void fixtureEvolve.handler(request, response);
    else if (request.url === "/connections" || request.url?.startsWith("/thoughts/idea-") || request.url?.startsWith("/connections/idea-") || request.url?.startsWith("/runs/owned-weave-") || /^\/thoughts\/thought-1(?:\/|\?scope=normal(?:&|$))/.test(request.url ?? "")) void fixtureIdea.handler(request, response);
    else if (request.url?.startsWith("/search?") || request.url?.startsWith("/thoughts/")) void fixtureSearch.handler(request, response);
    else void fixtureDaemon.handler(request, response);
  });
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
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, HOME: temp, TMPDIR: temp, NEXT_TELEMETRY_DISABLED: "1", THOUGHTLOOM_WEB_ORIGIN: origin, THOUGHTLOOM_DAEMON_URL: daemonOrigin, THOUGHTLOOM_USER_TOKEN: token, THOUGHTLOOM_IMPORT_MAX_BYTES: String(12 * 1024 * 1024) };
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
    const mediaCase = process.env.THOUGHTLOOM_TEST_MEDIA_CASE;
    if (mediaCase) {
      const checks = new Map([
        ["entry", [checkMediaImportEntry]], ["upload-recovery", [checkMediaUploadRecovery]],
        ["source-status", [checkMediaSourceStatus]], ["source-gates", [checkMediaSourceGates]],
        ["source-retry", [checkMediaSourceRetry]], ["source-rejected", [checkMediaSourceRejected]],
        ["source-restore", [checkMediaSourceRestore]], ["source-title-race", [checkMediaSourceTitleRace]],
        ["source-command-race", [checkMediaSourceCommandRace]],
        ["surface-explore", [checkMediaExploreSurface]], ["surface-evolve", [checkMediaEvolveSurface]],
        ["surface-ask", [checkMediaAskSurface]], ["surface-export", [checkMediaExportSurface]],
        ["media-surfaces", [checkMediaExploreSurface, checkMediaEvolveSurface, checkMediaAskSurface, checkMediaExportSurface]],
      ]).get(mediaCase);
      assert.ok(checks, "Unknown focused media case");
      const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
      try {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
          for (const check of checks) {
            const page = await browser.newPage({ viewport });
            try { await check(page, origin); }
            finally { await page.close(); }
          }
        }
      } finally { await browser.close(); }
      console.log(`Media ${mediaCase} browser checks passed`);
      return;
    }
    if (process.env.THOUGHTLOOM_TEST_ROOT_SPLASH === "1") {
      const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
      try {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
          await checkRootSplash(browser, origin, viewport);
        }
      } finally { await browser.close(); }
      console.log("Root splash runtime checks passed");
      return;
    }
    const glyphCase = process.env.THOUGHTLOOM_TEST_GLYPH_CASE;
    if (glyphCase) {
      assert.ok(["explore", "idea", "evolve"].includes(glyphCase), "Unknown focused glyph case");
      const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
      try {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
          const page = await browser.newPage({ viewport, baseURL: origin });
          try {
            if (glyphCase === "explore") await checkExploreGlyphs(page, origin);
            else if (glyphCase === "idea") await checkIdeaGlyphs(page, fixtureIdea, origin);
            else await checkEvolveGlyphs(page, fixtureEvolve, origin, viewport.width < 500);
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
      return;
    }
    for (const glyph of ["lantern", "sprout"]) {
      const response = await fetch(`${origin}/glyphs/${glyph}.svg`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(resolve(fixtureWeb, `public/glyphs/${glyph}.svg`)), "Public glyph must retain its approved source bytes");
    }
    const host = `127.0.0.1:${port}`;
    const probe = (method: string, path: string, headers: string, body = "") => raw(port, `${method} ${path} HTTP/1.0\r\n${headers}Connection: close\r\n\r\n${body}`);
    if (process.env.THOUGHTLOOM_TEST_EXPLORE === "1") {
      const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
      try {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
          const page = await browser.newPage({ viewport });
          try {
            await page.goto(`${origin}/explore`, { waitUntil: "networkidle" });
            await checkExploreBrowser(page, fixtureSearch, { origin, daemonOrigin, token, narrow: viewport.width < 500 });
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
      return;
    }
    const reinterpretCase = process.env.THOUGHTLOOM_TEST_REINTERPRET_CASE;
    if (reinterpretCase) {
      assert.ok(["core", "recovery", "storage", "guards", "stop", "media", "all"].includes(reinterpretCase), "Unknown focused reinterpretation case");
      const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
      try {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
          const page = await browser.newPage({ viewport });
          try {
            if (reinterpretCase === "media") await checkMediaReinterpretStatusOwner(page, origin);
            else {
              await checkIdeaReinterpretBrowser(page, fixtureIdea, origin, reinterpretCase);
              if (reinterpretCase === "all") await checkMediaReinterpretStatusOwner(page, origin);
            }
          }
          finally { await page.close(); }
        }
      } finally { await browser.close(); }
      return;
    }
    const agenticCase = process.env.THOUGHTLOOM_TEST_AGENTIC_CASE;
    if (agenticCase === "routes") {
      await checkAgenticSearchRoutes({ origin, host, probe, daemon: fixtureAgenticSearch });
      return;
    }
    if (agenticCase === "recovery-key" || agenticCase === "large-preview") {
      if (agenticCase === "recovery-key") await checkAgenticRecoveryKey({ origin, daemon: fixtureAgenticSearch });
      else await checkAgenticLargePreview({ origin, daemon: fixtureAgenticSearch });
      return;
    }
    if (agenticCase === "workspace" || agenticCase === "turns" || agenticCase === "controls") {
      if (agenticCase === "workspace") await checkAgenticWorkspaceRoutes({ origin, host, probe, daemon: fixtureAgenticSearch });
      else if (agenticCase === "turns") await checkAgenticTurnRoutes({ origin, host, probe, daemon: fixtureAgenticSearch });
      else await checkAgenticRunRoutes({ origin, host, probe, daemon: fixtureAgenticSearch });
      return;
    }
    if (agenticCase === "entry" || agenticCase === "saved" || agenticCase === "ui-core" || agenticCase === "ui-unknown" || agenticCase === "ui-context" || agenticCase === "ui-return" || agenticCase === "ui-actions" || agenticCase === "ui-unavailable" || agenticCase === "ui-idle-retry" || agenticCase === "ui-active-reading") {
      const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
      try {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
          const page = await browser.newPage({ viewport });
          try {
            if (agenticCase === "entry") await checkAgenticSearchEntry(page, fixtureAgenticSearch, { origin, daemonOrigin, token });
            else if (agenticCase === "saved") await checkAgenticSearchSaved(page, fixtureAgenticSearch, { origin, daemonOrigin, token });
            else if (agenticCase === "ui-core") await checkAgenticWorkspaceBrowser(page, fixtureAgenticSearch, { origin, daemonOrigin, token, narrow: viewport.width < 500 });
            else if (agenticCase === "ui-unknown") await checkAgenticUnknownAdmission(page, fixtureAgenticSearch, { origin });
            else if (agenticCase === "ui-context") await checkAgenticChangedContext(page, fixtureAgenticSearch, { origin });
            else if (agenticCase === "ui-return") await checkAgenticReturnNavigation(page, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 });
            else if (agenticCase === "ui-actions") await checkAgenticSessionActions(page, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 });
            else if (agenticCase === "ui-idle-retry") await checkAgenticIdleReadRetry(page, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 });
            else if (agenticCase === "ui-active-reading") await checkAgenticActiveReadingPosition(page, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 });
            else await checkAgenticUnavailable(page, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 });
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
      return;
    }
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
    await checkSearchRoute({ origin, host, probe, daemon: fixtureSearch });
    await checkIdeaRoute({ origin, host, probe, daemon: fixtureIdea });
    await checkIdeaReinterpretRoute({ origin, host, probe, daemon: fixtureIdea });
    await checkEvolveRoute({ origin, host, probe, daemon: fixtureEvolve });
    await checkExportRoute({ origin, host, probe, daemon: fixtureExport });
    await checkAgenticSearchRoutes({ origin, host, probe, daemon: fixtureAgenticSearch });
    await checkAgenticWorkspaceRoutes({ origin, host, probe, daemon: fixtureAgenticSearch });
    await checkAgenticTurnRoutes({ origin, host, probe, daemon: fixtureAgenticSearch });
    await checkAgenticRunRoutes({ origin, host, probe, daemon: fixtureAgenticSearch });
    await checkAgenticRecoveryKey({ origin, daemon: fixtureAgenticSearch });
    await checkAgenticLargePreview({ origin, daemon: fixtureAgenticSearch });
    // The focused mode permits independently observing the browser regression
    // while the large-upload regression remains RED; normal runs check both.
    if (process.env.THOUGHTLOOM_TEST_IMPORT_CASE !== "uncertain-stop") await checkLargeImportRoute(origin, fixtureImport);

    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    try {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
        await checkRootSplash(browser, origin, viewport);
      }
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
          const noContextBack = async () => {
            const header = page.getByRole("banner");
            await expect(header.getByRole("link", { name: /^(?:back|return|previous)\b/i })).toHaveCount(0);
            await expect(header.getByRole("button", { name: /^(?:back|return|previous)\b/i })).toHaveCount(0);
          };
          await page.goto(`${origin}/`, { waitUntil: "networkidle" });
          await noContextBack();
          await page.goto(`${origin}/explore`, { waitUntil: "networkidle" });
          await noContextBack();
          await checkAgenticSearchEntry(page, fixtureAgenticSearch, { origin, daemonOrigin, token });
          await checkIdeaReinterpretBrowser(page, fixtureIdea, origin);
          await checkMediaReinterpretStatusOwner(page, origin);
          await checkAgenticSearchSaved(page, fixtureAgenticSearch, { origin, daemonOrigin, token });
          await checkAgenticWorkspaceBrowser(page, fixtureAgenticSearch, { origin, daemonOrigin, token, narrow: viewport.width < 500 });
          await checkAgenticUnknownAdmission(page, fixtureAgenticSearch, { origin });
          await checkAgenticChangedContext(page, fixtureAgenticSearch, { origin });
          await checkAgenticReturnNavigation(page, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 });
          await checkAgenticSessionActions(page, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 });
          await checkAgenticUnavailable(page, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 });
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
          await noContextBack();
          assert.equal(await page.getByRole("heading", { name: "Capture" }).count(), 1);
          await checkImportEntry(page, { origin });
          await checkImportBrowser(page, fixtureImport, { origin });
          await checkMediaImportEntry(page, origin);
          await page.goto(`${origin}/capture`, { waitUntil: "networkidle" });
          await checkCaptureBrowser(page, fixtureDaemon);
          await page.getByRole("link", { name: "Explore", exact: true }).click();
          await page.waitForURL("**/explore");
          await noContextBack();
          await checkExploreBrowser(page, fixtureSearch, { origin, daemonOrigin, token, narrow: viewport.width < 500 });
          const search = page.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i });
          await search.fill("owned");
          await page.getByRole("button", { name: /^search$/i }).click();
          await expect(page.getByText("Owned development").first()).toBeVisible();
          await page.getByRole("button", { name: /expand|show more|read more/i }).first().click();
          const resultLink = page.locator('a[href^="/ideas/thought-1"]').last();
          await resultLink.scrollIntoViewIfNeeded();
          await resultLink.evaluate(link => link.addEventListener("click", () => {
            document.documentElement.dataset.ownedIdeaNavigationScroll = String(window.scrollY);
          }, { capture: true, once: true }));
          await resultLink.click();
          const ideaScroll = Number(await page.locator("html").getAttribute("data-owned-idea-navigation-scroll"));
          assert.ok(ideaScroll > 0, "Explore-to-Idea navigation must begin at a positive reading position");
          await expect(page.getByRole("heading", { name: "Owned development", level: 1 })).toBeVisible();
          await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*(?:results|explore)/i }).click();
          await expect(search).toHaveValue("owned");
          await expect(page.getByRole("combobox", { name: /sort/i })).toHaveValue("newest");
          await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - ideaScroll), { timeout: 5000 }).toBeLessThanOrEqual(2);
          await checkIdeaBrowser(page, fixtureIdea, fixtureSearch, { origin, narrow: viewport.width < 500 });
          await checkEvolveBrowser(page, fixtureEvolve, { origin, narrow: viewport.width < 500 });
          await checkExportBrowser(page, fixtureExport, { origin, daemonOrigin, token, narrow: viewport.width < 500 });
          await page.evaluate(() => document.fonts.ready);
          assert.ok(await page.evaluate(() => Array.from(document.fonts).some(font => font.status === "loaded" && font.family.toLowerCase().includes("source"))), "local Source Sans font should load");
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal overflow");
          const html = await page.content();
          for (const secret of secrets) assert.ok(!html.includes(secret), "browser HTML contains sentinel");
          assert.deepEqual(leaks, []);
        } finally { await page.close(); }
        // Each companion owns a fresh browser context; in particular the
        // active-reading case installs a clock that must not affect other checks.
        for (const check of [checkAgenticIdleReadRetry, checkAgenticActiveReadingPosition]) {
          const companion = await browser.newPage({ viewport });
          try { await check(companion, fixtureAgenticSearch, { origin, narrow: viewport.width < 500 }); }
          finally { await companion.close(); }
        }
        for (const check of [checkMediaUploadRecovery, checkMediaSourceStatus, checkMediaSourceGates, checkMediaSourceRetry, checkMediaSourceRejected, checkMediaSourceRestore, checkMediaSourceTitleRace, checkMediaSourceCommandRace, checkMediaExploreSurface, checkMediaEvolveSurface, checkMediaAskSurface, checkMediaExportSurface]) {
          const mediaPage = await browser.newPage({ viewport });
          try { await check(mediaPage, origin); }
          finally { await mediaPage.close(); }
        }
      }
    } finally { await browser.close(); }
    console.log("Foundation, capture and Explore runtime checks passed");
    // Never share Next build output between running production and development servers.
    await stop(server);
    server = undefined;
    await checkDevQueryPrivacy(fixtureWeb, env, fixtureSearch.attempts);
    console.log("Development request-log privacy checks passed");
  } finally {
    // The fixture also releases any held response when its browser check exits.
    if (server) await stop(server);
    if (daemon?.listening) {
      daemon.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => daemon?.close(error => error ? reject(error) : resolveClose()));
    }
    await rm(temp, { recursive: true, force: true });
  }
}

await main();
