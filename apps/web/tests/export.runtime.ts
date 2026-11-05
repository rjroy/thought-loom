import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Download, type Page, type Request as BrowserRequest, type Response as BrowserResponse } from "@playwright/test";

type Status = "queued" | "running" | "uncertain" | "completed" | "interrupted" | "failed";
type Attempt = { method: string; path: string; authorization: string | undefined; body: string };
const root = { id: "export-root", text: "Owned export root", title: "Export root", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: null, sourceIds: [] };
const visible = { ...root, id: "export-visible", text: "Owned visible source", title: "Visible source" };
const simple = Buffer.from("# Simple Café 雪\r\n\r\nOwned exact simple content.\r\n", "utf8");
const report = Buffer.from('# Report Café 雪\r\n\r\nOwned report content.\r\n\r\n[Body forgery](/ideas/export-forgery)\r\n\r\n![External image](https://evil.invalid/export.png)\r\n\r\n<script>window.ownedExportScriptRan=true</script>\n\n## Sources\n\nRecorded thought identities and attribution (not endorsement):\n\n- Visible source: ID: `"export-visible"`; thought author: user; kind: captured-original.\n- Hidden source: ID: `"export-hidden"`; thought author: user; kind: captured-original.\n', "utf8");

export function exportDaemon(token: string) {
  const attempts: Attempt[] = [];
  let status: Status = "queued", artifact: "pending" | "error" | "ready" = "pending", admission: "normal" | "unknown" = "normal", next = 0;
  let hold: "simple" | "admission" | null = null, release: (() => void) | undefined;
  const reset = () => { status = "queued"; artifact = "pending"; admission = "normal"; next = 0; hold = null; release = undefined; };
  return {
    attempts, reset, expectedAuthorization: `Bearer ${token}`,
    setStatus(value: Status) { status = value; }, setArtifact(value: typeof artifact) { artifact = value; }, setAdmission(value: typeof admission) { admission = value; },
    hold(value: "simple" | "admission") { hold = value; },
    waiting() { return release !== undefined; },
    release() { release?.(); release = undefined; hold = null; },
    async handler(req: IncomingMessage, res: ServerResponse) {
      let body = ""; for await (const chunk of req) body += String(chunk);
      const path = req.url ?? "", method = req.method ?? "";
      attempts.push({ method, path, authorization: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const url = new URL(path, "http://fixture.invalid");
      const send = (value: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname === "/exports/simple" && method === "POST") {
        if (hold === "simple") await new Promise<void>(resolve => { release = resolve; });
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(simple); return;
      }
      if (url.pathname === "/exports/agentic" && method === "POST") {
        if (hold === "admission") await new Promise<void>(resolve => { release = resolve; });
        if (admission === "unknown") { res.writeHead(500).end("owned admission failure"); return; }
        next++; status = "queued"; artifact = "pending";
        send({ run: { id: `export-run-${next}`, kind: "export", status, confirmedThoughtIds: [], responseId: null } }, 201); return;
      }
      if (url.pathname.startsWith("/exports/agentic/")) {
        if (artifact === "pending") { res.writeHead(409).end("owned partial report"); return; }
        if (artifact === "error") { res.writeHead(500).end("owned report failure"); return; }
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(report); return;
      }
      if (url.pathname.startsWith("/runs/export-")) {
        const id = url.pathname.split("/")[2];
        if (method === "POST" && !["completed", "failed", "interrupted"].includes(status)) status = "interrupted";
        send({ id, kind: "export", status, confirmedThoughtIds: [], responseId: null }); return;
      }
      if (url.searchParams.has("scope") && url.searchParams.get("scope") !== "normal") { res.writeHead(403).end(); return; }
      if (/^\/thoughts\/export-root\/(?:children|connections|responses)$/.test(url.pathname)) { send([]); return; }
      if (url.pathname === "/thoughts/export-root") { send(root); return; }
      if (url.pathname === "/thoughts/export-visible") { send(visible); return; }
      res.writeHead(404).end();
    },
  };
}
type Fixture = ReturnType<typeof exportDaemon>;
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;

export async function checkExportRoute({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const before = daemon.attempts.length;
  const body = JSON.stringify({ rootId: "export-root", count: 3, traversal: "breadth" });
  const headers = `Host: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
  assert.equal((await probe("POST", "/api/export/simple", `${headers}Origin: http://foreign.invalid\r\n`, body)).status, 403);
  assert.equal((await probe("GET", "/api/export/thoughts/export-root", `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
  assert.equal(daemon.attempts.length, before);
  const response = await fetch(`${origin}/api/export/simple`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), simple);
  const accepted = await fetch(`${origin}/api/export/agentic`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ request: "Owned route request", effort: "quick" }) });
  assert.equal(accepted.status, 201); assert.equal((await accepted.json()).run.kind, "export");
  const calls = daemon.attempts.slice(before);
  assert.ok(calls.every(call => call.authorization === daemon.expectedAuthorization));
  assert.ok(calls.some(call => call.path === "/exports/simple" && call.body === body));
  assert.ok(calls.some(call => call.path === "/exports/agentic" && call.body === '{"request":"Owned route request","effort":"quick"}'));
  assert.ok(calls.every(call => call.path.startsWith("/exports/")), "export controls must not mutate knowledge");
  daemon.reset();
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  assert.ok(stream, "download stream unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function checkExportBrowser(page: Page, daemon: Fixture, options: { origin: string; daemonOrigin: string; token: string; narrow: boolean }): Promise<void> {
  daemon.reset();
  type Trace = { method: string; url: string; resource: string; category: string; phase: "pending" | "finished" | "failed"; body: string | null; status?: number; failure?: string };
  const inFlight = new Map<BrowserRequest, Trace>();
  const events: Trace[] = [];
  const onRequest = (request: BrowserRequest) => {
    const url = new URL(request.url());
    const resource = request.resourceType();
    const category = resource === "document" ? "document" : url.searchParams.has("_rsc") || request.headers().rsc === "1" ? "next-rsc" : url.pathname.startsWith("/api/export/thoughts/") ? "export-thought-api" : url.pathname.startsWith("/api/export/") ? "export-api" : "other";
    const trace: Trace = { method: request.method(), url: `${url.origin}${url.pathname}${url.search}`, resource, category, phase: "pending", body: request.postData() };
    inFlight.set(request, trace); events.push(trace);
  };
  const onFinished = (request: BrowserRequest) => { const trace = inFlight.get(request); if (trace) { trace.phase = "finished"; inFlight.delete(request); } };
  const onFailed = (request: BrowserRequest) => { const trace = inFlight.get(request); if (trace) { trace.phase = "failed"; trace.failure = request.failure()?.errorText; inFlight.delete(request); } };
  const onResponse = (response: BrowserResponse) => { const trace = inFlight.get(response.request()); if (trace) trace.status = response.status(); };
  page.on("request", onRequest); page.on("response", onResponse); page.on("requestfinished", onFinished); page.on("requestfailed", onFailed);
  await page.goto(`${options.origin}/export`, { waitUntil: "networkidle" });
  await expect(page.getByRole("banner").getByRole("link", { name: /^(?:back|return|previous)\b/i })).toHaveCount(0);
  const before = daemon.attempts.length;
  const navigation = await page.goto(`${options.origin}/export?thoughtId=export-root`, { waitUntil: "networkidle" });
  assert.equal(navigation?.status(), 200, "fresh Export bookmark must resolve to the actual page");
  await expect(page.getByText(root.text, { exact: true })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("link", { name: /(?:back|return).*idea/i })).toHaveAttribute("href", /^\/ideas\/export-root(?:\?|$)/);
  await expect(page.locator("main").getByRole("link", { name: /(?:back|return).*idea/i })).toHaveCount(0);
  const count = page.getByRole("spinbutton", { name: /count|number/i });
  const request = page.getByRole("textbox", { name: /request|question/i });
  const effort = page.getByRole("combobox", { name: /effort/i });
  const createReport = page.getByRole("button", { name: /create report/i });
  const simpleButton = page.getByRole("button", { name: /create (?:simple )?export|preview (?:simple )?export/i });
  const simplePosts = () => daemon.attempts.slice(before).filter(call => call.method === "POST" && call.path === "/exports/simple");
  const reportPosts = () => daemon.attempts.slice(before).filter(call => call.method === "POST" && call.path === "/exports/agentic");
  await count.fill("0"); await request.fill("Owned independent report request");
  if (await simpleButton.isEnabled()) await simpleButton.click();
  await expect(page.getByText("Enter a whole number of 1 or more.")).toBeVisible();
  assert.equal(simplePosts().length, 0);
  await expect(createReport).toBeEnabled();
  await count.fill("3");
  daemon.hold("simple");
  try {
    await simpleButton.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect.poll(() => daemon.waiting()).toBe(true);
    assert.equal(simplePosts().length, 1);
    assert.deepEqual(JSON.parse(simplePosts()[0]?.body ?? "null"), { rootId: "export-root", count: 3, traversal: "breadth" });
  } finally { daemon.release(); }
  await expect(page.getByText("Simple Café 雪")).toBeVisible();
  const preview = page.getByRole("region", { name: /simple markdown preview/i });
  const previewHeading = preview.getByRole("heading", { name: /simple markdown preview/i });
  await expect.poll(() => preview.evaluate(element => {
    const active = document.activeElement;
    return active instanceof HTMLElement && (active === element || active === element.querySelector("h2")) && active.tabIndex === -1;
  }), { message: "confirmed Simple preview heading or region should receive programmatic focus" }).toBe(true);
  await expect.poll(() => previewHeading.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  }), { message: "confirmed Simple preview heading should be within the viewport" }).toBe(true);
  const success = page.locator('[role="status"], [aria-live="polite"], [aria-live="assertive"]').filter({ hasText: /(?:ready|created|complete|prepared|available|success)/i }).filter({ hasText: /(?:export|markdown|preview)/i });
  await expect(success.first()).toBeVisible();
  const simpleDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /download/i }).first().click();
  const simpleFile = await simpleDownload;
  assert.equal(simpleFile.suggestedFilename(), "thoughtloom-simple.md"); assert.deepEqual(await downloadBytes(simpleFile), simple);
  assert.equal(simplePosts().length, 1, "download must reuse the received bytes");

  await effort.selectOption("quick");
  daemon.hold("admission");
  try {
    await createReport.dblclick({ delay: 40 });
    await expect.poll(() => daemon.waiting()).toBe(true);
    assert.equal(reportPosts().length, 1);
    assert.deepEqual(JSON.parse(reportPosts()[0]?.body ?? "null"), { request: "Owned independent report request", effort: "quick" });
  } finally { daemon.release(); }
  await expect(page.getByText("export-run-1", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/queued/i).first()).toBeVisible();
  await expect(request).toHaveValue("Owned independent report request");
  await expect(request).not.toBeEditable();
  await expect(effort).toBeDisabled();
  daemon.setStatus("running");
  await expect(page.getByText(/running/i).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/^request$/i).first()).toBeVisible();
  daemon.setStatus("uncertain");
  await expect(page.getByText(/uncertain/i).first()).toBeVisible({ timeout: 15000 });
  const beforeCheck = daemon.attempts.length;
  await page.getByRole("button", { name: /check (?:this )?run/i }).click();
  await expect.poll(() => daemon.attempts.slice(beforeCheck).some(call => call.path === "/runs/export-run-1")).toBe(true);
  await page.getByRole("button", { name: /^stop$/i }).click();
  await expect(page.getByText(/interrupted/i).first()).toBeVisible();
  const stops = daemon.attempts.slice(before).filter(call => call.path === "/runs/export-run-1/stop");
  assert.equal(stops.length, 1); assert.equal(stops[0]?.body, "{}");
  await expect(page.getByText(/no completed report is available/i)).toBeVisible();
  await page.getByRole("button", { name: /back to setup/i }).click();
  await expect(request).toHaveValue("Owned independent report request");
  await expect(page.getByText("export-run-1", { exact: false }).first()).toBeVisible();
  const beforeLeave = daemon.attempts.length;
  await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*idea/i }).click();
  await expect(page).toHaveURL(url => url.pathname === "/ideas/export-root");
  await expect(page.getByRole("heading", { name: "Export root", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("export-run-1", { exact: false }).first()).toBeVisible();
  assert.ok(!daemon.attempts.slice(beforeLeave).some(call => call.method === "POST"), "leaving must not stop or resubmit");

  // A reload starts setup without replay. Observe fetch initiation in the new document.
  await page.addInitScript(() => {
    const requests: string[] = [];
    (window as typeof window & { __ownedExportRequests?: string[] }).__ownedExportRequests = requests;
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith("/api/export/")) requests.push(`${(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()} ${url.pathname}`);
      return fetch(input, init);
    };
  });
  const beforeReload = daemon.attempts.length;
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("export-run-1", { exact: false })).toHaveCount(0);
  const fresh = await page.evaluate(() => (window as typeof window & { __ownedExportRequests?: string[] }).__ownedExportRequests ?? []);
  assert.ok(!fresh.some(call => /^(?:POST |GET \/api\/export\/runs\/)/.test(call)), `reload must not replay or resume: ${JSON.stringify(fresh)}`);
  assert.ok(!daemon.attempts.slice(beforeReload).some(call => call.method === "POST"), "reload must not write");

  await request.fill("Owned completed report"); await effort.selectOption("standard"); await createReport.click();
  await expect(page.getByText("export-run-2", { exact: false }).first()).toBeVisible();
  daemon.setStatus("completed");
  await expect(page.getByRole("heading", { name: "Completed", exact: true })).toBeVisible({ timeout: 15000 });
  const reportCalls = () => daemon.attempts.slice(before).filter(call => call.path === "/exports/agentic/export-run-2").length;
  await expect.poll(reportCalls, { timeout: 15000 }).toBeGreaterThan(0);
  await expect(page.getByText(/report ready/i)).toHaveCount(0);
  await expect(page.getByText("owned partial report")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /download/i })).toHaveCount(0);
  daemon.setArtifact("error");
  const beforeError = reportCalls();
  await page.getByRole("button", { name: /check (?:this )?run/i }).click();
  await expect.poll(reportCalls).toBeGreaterThan(beforeError);
  await expect(page.getByText(/could not read the report/i)).toBeVisible();
  await expect(page.getByText(/report ready/i)).toHaveCount(0);
  daemon.setArtifact("ready");
  let external = 0;
  await page.route("https://evil.invalid/**", route => { external++; return route.abort(); });
  await page.getByRole("button", { name: /check (?:this )?run/i }).click();
  await expect(page.getByText(/report ready/i).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Owned report content.")).toBeVisible();
  await expect(page.getByText("Body forgery")).toBeVisible();
  await expect(page.locator('a[href="/ideas/export-forgery"]')).toHaveCount(0);
  await expect(page.locator('a[href="/ideas/export-hidden"]')).toHaveCount(0);
  await expect(page.locator('a[href="/ideas/export-visible"]').first()).toBeVisible();
  await expect(page.locator('a[href^="https://evil.invalid"], img[src^="https://evil.invalid"]')).toHaveCount(0);
  assert.ok(daemon.attempts.slice(before).some(call => call.path === "/thoughts/export-visible?scope=normal"));
  assert.ok(daemon.attempts.slice(before).some(call => call.path === "/thoughts/export-hidden?scope=normal"));
  assert.equal(external, 0); assert.equal(await page.evaluate(() => (window as typeof window & { ownedExportScriptRan?: boolean }).ownedExportScriptRan), undefined);
  const reportReads = reportCalls();
  const reportDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /download/i }).last().click();
  const reportFile = await reportDownload;
  assert.equal(reportFile.suggestedFilename(), "thoughtloom-report.md"); assert.deepEqual(await downloadBytes(reportFile), report);
  assert.equal(reportCalls(), reportReads);

  await page.getByRole("button", { name: /back to setup/i }).click();
  await page.reload({ waitUntil: "networkidle" });
  await request.fill("Owned failure report"); await createReport.click();
  await expect(page.getByText("export-run-3", { exact: false }).first()).toBeVisible();
  daemon.setStatus("failed");
  await expect(page.getByText(/no completed report is available/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: /^stop$/i })).toHaveCount(0);

  daemon.setAdmission("unknown");
  await page.reload({ waitUntil: "networkidle" });
  const beforeUnknown = reportPosts().length, unknownCalls = daemon.attempts.length;
  await request.fill("Owned unknown report"); await createReport.click();
  await expect(page.getByText(/admission unconfirmed|may have started|could not confirm/i).first()).toBeVisible();
  await page.waitForTimeout(300);
  assert.equal(reportPosts().length, beforeUnknown + 1);
  assert.ok(!daemon.attempts.slice(unknownCalls).some(call => call.path.startsWith("/runs/")), "unknown admission must not invent a run lookup");

  const eventStart = events.length, daemonStart = daemon.attempts.length;
  const pendingBefore = [...inFlight.values()].map(trace => ({ ...trace }));
  let hiddenNavigation: BrowserResponse | null = null;
  try {
    hiddenNavigation = await page.goto(`${options.origin}/export?thoughtId=export-hidden`, { waitUntil: "networkidle", timeout: 30000 });
  } catch (error) {
    const diagnostic = {
      pendingBefore,
      navigationRequests: events.slice(eventStart),
      outstanding: [...inFlight.values()],
      daemonCalls: daemon.attempts.slice(daemonStart).map(({ method, path, body }) => ({ method, path, body })),
    };
    throw new Error(`Owned hidden-root navigation failed: ${JSON.stringify(diagnostic)}`, { cause: error });
  } finally {
    page.off("request", onRequest); page.off("response", onResponse); page.off("requestfinished", onFinished); page.off("requestfailed", onFailed);
  }
  assert.equal(hiddenNavigation?.status(), 200);
  await expect.poll(() => daemon.attempts.slice(daemonStart).some(call => call.method === "GET" && call.path === "/thoughts/export-hidden?scope=normal")).toBe(true);
  await expect(page.getByText(/root.*unavailable|idea.*unavailable|thought.*unavailable/i).first()).toBeVisible();
  await count.fill("3");
  await expect(simpleButton).toBeDisabled();
  await request.fill("Owned independent missing-root request");
  await expect(createReport).toBeEnabled();
  assert.ok(daemon.attempts.slice(before).every(call => call.authorization === daemon.expectedAuthorization));
  assert.ok(!daemon.attempts.slice(before).some(call => call.path.includes("scope=history") || call.path.includes("scope=show-rejected")));
  assert.ok(!daemon.attempts.slice(before).some(call => call.method !== "GET" && !["/exports/simple", "/exports/agentic", "/runs/export-run-1/stop"].includes(call.path)), "export must not write knowledge");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Export horizontal overflow");
  void options.daemonOrigin; void options.token; void options.narrow;
}
