import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";
import { expectGlyph } from "./explore.runtime";

type Status = "queued" | "running" | "uncertain" | "completed" | "interrupted" | "failed";
type Attempt = { method: string; path: string; authorization: string | undefined; body: string };
type Run = { id: string; kind: "evolve"; status: Status; confirmedThoughtIds: string[]; responseId: string | null; contributionId: string; parentId: string };
const start = { id: "evolve-start", text: "Owned starting thought", title: "Starting thought", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: null, sourceIds: [] };
const earlier = { ...start, id: "evolve-earlier", text: "Owned earlier thought", title: "Earlier thought" };
const imported = { ...start, id: "evolve-imported", text: "Owned imported starting thought", title: "Imported starting thought", author: "source", kind: "imported-original", origin: "markdown-import" };

export function evolveDaemon(token: string) {
  const attempts: Attempt[] = [], runs = new Map<string, Run>();
  const thoughts = new Map<string, Record<string, unknown>>();
  const rejected = new Set<string>();
  const fallbackStates = new Map<string, "complete" | "interrupted">();
  let admission: "normal" | "unknown" = "normal", stopFailure = false, resolutionFailure = false, failedResolutionReads = 0, next = 0;
  const reset = () => { runs.clear(); thoughts.clear(); rejected.clear(); fallbackStates.clear(); thoughts.set(start.id, start); thoughts.set(earlier.id, earlier); thoughts.set(imported.id, imported); admission = "normal"; stopFailure = false; resolutionFailure = false; failedResolutionReads = 0; next = 0; };
  reset();
  const publicRun = (run: Run) => ({ id: run.id, kind: run.kind, status: run.status, confirmedThoughtIds: run.confirmedThoughtIds, responseId: run.responseId });
  return {
    attempts, reset, expectedAuthorization: `Bearer ${token}`,
    setAdmission(value: typeof admission) { admission = value; },
    setStopFailure(value: boolean) { stopFailure = value; },
    setResolutionFailure(value: boolean) { resolutionFailure = value; },
    failedResolutionReads() { return failedResolutionReads; },
    setStatus(id: string, status: Status, options: { outputs?: number; fallback?: "complete" | "interrupted" } = {}) {
      const run = runs.get(id); assert.ok(run, "fixture needs a known admitted run");
      run.status = status;
      run.confirmedThoughtIds = Array.from({ length: options.outputs ?? 0 }, (_, index) => `evolve-output-${id}-${index + 1}`);
      for (const [index, outputId] of run.confirmedThoughtIds.entries()) thoughts.set(outputId, { ...start, id: outputId, text: `Owned saved development ${index + 1}`, title: `Development ${index + 1}`, author: "ai", kind: "developing-idea", origin: "development", parentId: run.contributionId });
      run.responseId = options.fallback || (run.confirmedThoughtIds.length && status !== "failed") ? `evolve-reply-${id}` : null;
      if (options.fallback) fallbackStates.set(id, options.fallback); else fallbackStates.delete(id);
    },
    async handler(req: IncomingMessage, res: ServerResponse) {
      let body = ""; for await (const chunk of req) body += String(chunk);
      const path = req.url ?? "", method = req.method ?? "";
      attempts.push({ method, path, authorization: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const url = new URL(path, "http://fixture.invalid");
      const send = (value: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const segments = url.pathname.split("/");
      if (segments[1] === "runs") {
        const run = runs.get(segments[2] ?? "");
        if (!run) { res.writeHead(404).end(); return; }
        if (method === "POST") {
          if (stopFailure) { res.writeHead(500).end("owned stop failure"); return; }
          if (!["completed", "interrupted", "failed"].includes(run.status)) run.status = "interrupted";
        }
        send(publicRun(run)); return;
      }
      const id = segments[2] ?? "";
      if (method === "GET" && resolutionFailure && (id.startsWith("evolve-output-") || (id.startsWith("evolve-contribution-") && segments[3] === "responses"))) {
        failedResolutionReads++; res.writeHead(502).end("owned transient resolution failure"); return;
      }
      if (method === "POST" && segments[3] === "reject") {
        if (!thoughts.has(id)) { res.writeHead(404).end(); return; }
        rejected.add(id); res.writeHead(204).end(); return;
      }
      if (method === "POST" && segments[3] === "evolve") {
        if (!thoughts.has(id) || rejected.has(id)) { res.writeHead(404).end(); return; }
        if (admission === "unknown") { res.writeHead(500).end("owned unknown admission"); return; }
        const payload: unknown = JSON.parse(body);
        if (!payload || typeof payload !== "object" || !("text" in payload) || typeof payload.text !== "string") { res.writeHead(400).end(); return; }
        next++;
        const run: Run = { id: `evolve-run-${next}`, kind: "evolve", status: "queued", confirmedThoughtIds: [], responseId: null, contributionId: `evolve-contribution-${next}`, parentId: id };
        const contribution = { ...start, id: run.contributionId, text: payload.text, title: null, titleAuthor: null, kind: "user-contribution", origin: "contribution", parentId: id };
        thoughts.set(run.contributionId, contribution); runs.set(run.id, run);
        send({ contribution, run: publicRun(run) }, 201); return;
      }
      if (url.searchParams.has("scope") && url.searchParams.get("scope") !== "normal") { res.writeHead(403).end(); return; }
      const selected = thoughts.get(id);
      if (!selected || rejected.has(id)) { res.writeHead(404).end(); return; }
      if (segments[3] === "responses") {
        const values = [...runs.values()].filter(run => run.responseId && (run.confirmedThoughtIds.includes(id) || (fallbackStates.has(run.id) && run.contributionId === id))).map(run => ({
          id: run.responseId, text: fallbackStates.has(run.id) ? "Owned fallback reply" : "Owned canonical reply", role: fallbackStates.has(run.id) ? "fallback" : "addendum", state: fallbackStates.get(run.id) ?? (run.status === "interrupted" ? "interrupted" : "complete"), thoughtIds: fallbackStates.has(run.id) ? [run.contributionId] : run.confirmedThoughtIds,
        }));
        send(values); return;
      }
      if (segments[3] === "connections" || segments[3] === "children") { send([]); return; }
      send(selected);
    },
  };
}
type Fixture = ReturnType<typeof evolveDaemon>;
export async function checkEvolveGlyphs(page: Page, daemon: Fixture, origin: string, narrow: boolean): Promise<void> {
  daemon.reset();
  await page.goto(`${origin}/evolve?thoughtId=evolve-start`, { waitUntil: "networkidle" });
  if (narrow) await page.getByRole("button", { name: /^starting thought/i }).click();
  const context = page.locator("#evolve-starting-context");
  await expect(context.getByText(start.text, { exact: true })).toBeVisible();
  await expect(context).toContainText("You");
  await expectGlyph(context, "captured-original.svg", 20);
  await page.getByRole("textbox", { name: "Your contribution" }).fill("Owned glyph contribution");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("evolve-run-1", { exact: false }).first()).toBeVisible();
  const contribution = page.getByText("Owned glyph contribution", { exact: true }).locator("..");
  await expect(contribution).toContainText("You");
  await expectGlyph(contribution, "user-contribution.svg", 20);
  daemon.setStatus("evolve-run-1", "completed", { outputs: 1 });
  const development = page.locator("article").filter({ hasText: "Owned saved development 1" });
  await expect(development).toBeVisible({ timeout: 15000 });
  await expect(development).toContainText("AI");
  await expect(development).toContainText("Developing idea");
  await expectGlyph(development, "developing-idea.svg", 20);
  const reply = page.getByText("Owned canonical reply", { exact: true }).locator("..");
  await expect(reply).toContainText("AI");
  await expectGlyph(reply, "full-reply.svg", 20);
}
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;
export async function checkEvolveRoute({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const before = daemon.attempts.length;
  assert.equal((await probe("GET", "/api/evolve/thoughts/evolve-start", `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
  const body = JSON.stringify({ text: "owned route contribution" });
  const headers = `Host: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
  assert.equal((await probe("POST", "/api/evolve/thoughts/evolve-start", `${headers}Origin: http://foreign.invalid\r\n`, body)).status, 403);
  assert.equal(daemon.attempts.length, before);
  const selected = await fetch(`${origin}/api/evolve/thoughts/evolve-start`);
  assert.equal(selected.status, 200); assert.match(selected.headers.get("cache-control") ?? "", /no-store/i);
  assert.equal((await selected.json()).text, start.text);
  const admitted = await fetch(`${origin}/api/evolve/thoughts/evolve-start`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  assert.equal(admitted.status, 201);
  const value = await admitted.json(); assert.equal(value.contribution.text, "owned route contribution"); assert.equal(value.run.id, "evolve-run-1");
  const calls = daemon.attempts.slice(before);
  assert.ok(calls.every(call => call.authorization === daemon.expectedAuthorization));
  assert.ok(calls.some(call => call.path === "/thoughts/evolve-start/evolve" && call.body === body));
  daemon.reset();
}

export async function checkEvolveBrowser(page: Page, daemon: Fixture, options: { origin: string; narrow: boolean }): Promise<void> {
  daemon.reset();
  const startingText = async (text: string) => {
    if (options.narrow) {
      const toggle = page.getByRole("button", { name: /^starting thought/i });
      await expect(toggle).toBeVisible();
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    }
    await expect(page.locator("#evolve-starting-context").getByText(text, { exact: true })).toBeVisible();
  };
  const leaveAndReturn = async () => {
    await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*idea/i }).click();
    await expect(page).toHaveURL(url => url.pathname === "/ideas/evolve-start");
    await expect(page.getByRole("heading", { name: "Starting thought", level: 1 })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/evolve\?thoughtId=evolve-start/);
  };
  await page.goto(`${options.origin}/evolve?thoughtId=evolve-imported`, { waitUntil: "networkidle" });
  await startingText(imported.text);
  const importedContext = page.locator("#evolve-starting-context");
  await expect(importedContext.getByText("Imported source", { exact: true }).first()).toBeVisible();
  await expect(importedContext.getByText("AI", { exact: true })).toHaveCount(0);
  await page.goto(`${options.origin}/evolve`, { waitUntil: "networkidle" });
  await expect(page.getByRole("banner").getByRole("link", { name: /(?:back|return).*(?:results|explore)/i })).toHaveAttribute("href", "/explore");
  const before = daemon.attempts.length;
  const navigation = await page.goto(`${options.origin}/evolve?thoughtId=evolve-start`, { waitUntil: "networkidle" });
  assert.equal(navigation?.status(), 200, "fresh Evolve bookmark must resolve to the actual page");
  await startingText(start.text);
  await expect(page.getByRole("banner").getByRole("link", { name: /(?:back|return).*idea/i })).toHaveAttribute("href", /^\/ideas\/evolve-start(?:\?|$)/);
  await expect(page.locator("main").getByRole("link", { name: /(?:back|return).*idea/i })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Your contribution", exact: true });
  const send = page.getByRole("button", { name: /^send$/i });
  await expect(composer).toBeVisible();
  await expect(page.getByText("Add a contribution to enable Send.", { exact: true })).toHaveCount(0);
  await expect(send).toBeDisabled();
  await expect(composer).toHaveJSProperty("tagName", "TEXTAREA");
  const composerBox = await composer.boundingBox(), sendBox = await send.boundingBox();
  assert.ok(composerBox && composerBox.width >= 88 && composerBox.height >= 44, "contribution textarea must remain readable");
  assert.ok(sendBox && sendBox.width >= 44 && sendBox.height >= 44, "Send must remain a comfortable target");
  assert.ok(sendBox.x >= composerBox.x + composerBox.width - 1, "Send must sit beside, not below, the textarea");
  assert.ok(sendBox.y >= composerBox.y - 1 && sendBox.y + sendBox.height <= composerBox.y + composerBox.height + 1, "Send must sit within the textarea's vertical band");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "composer must not cause horizontal overflow");
  await composer.fill("   ");
  await expect(send).toBeDisabled();
  assert.ok(!daemon.attempts.slice(before).some(call => call.method === "POST"), "opening Evolve must not admit or stop a run");
  const admissions = () => daemon.attempts.slice(before).filter(call => call.method === "POST" && call.path.endsWith("/evolve"));
  await composer.fill("  Owned contribution\nwithout rewriting  ");
  await expect(send).toBeEnabled();
  await composer.focus();
  await page.keyboard.press("Tab");
  await expect(send).toBeFocused();
  const first = admissions().length;
  await send.dblclick({ delay: 40 });
  await expect.poll(() => admissions().length).toBe(first + 1);
  assert.equal(admissions().at(-1)?.path, "/thoughts/evolve-start/evolve");
  assert.deepEqual(JSON.parse(admissions().at(-1)?.body ?? "null"), { text: "  Owned contribution\nwithout rewriting  " });
  await expect(page.getByText("evolve-run-1", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/queued/i).first()).toBeVisible();
  daemon.setStatus("evolve-run-1", "running");
  await expect(page.getByText(/running/i).first()).toBeVisible({ timeout: 15000 });
  daemon.setStatus("evolve-run-1", "uncertain", { outputs: 1 });
  await expect(page.getByText(/uncertain/i).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Owned saved development 1").first()).toBeVisible();
  await composer.fill("Owned next draft");
  const beforeLeave = daemon.attempts.length;
  await leaveAndReturn();
  await expect(page.getByText("evolve-run-1", { exact: false }).first()).toBeVisible();
  await expect(composer).toHaveValue("Owned next draft");
  assert.ok(!daemon.attempts.slice(beforeLeave).some(call => call.method === "POST"), "leaving a pending run must not admit or stop work");
  daemon.setStopFailure(true);
  const beforeStop = daemon.attempts.length;
  const stopCalls = () => daemon.attempts.slice(beforeStop).filter(call => call.method === "POST" && call.path === "/runs/evolve-run-1/stop");
  await page.getByRole("button", { name: /^stop$/i }).click();
  await expect(page.getByText(/stop.*unconfirmed|could not confirm.*stop/i).first()).toBeVisible();
  expect(stopCalls().length).toBe(1); expect(stopCalls()[0]?.body).toBe("{}");
  await expect(composer).toHaveValue("Owned next draft");
  await expect(page.getByText("Owned saved development 1").first()).toBeVisible();
  daemon.setStopFailure(false);
  daemon.setStatus("evolve-run-1", "interrupted", { outputs: 1 });
  await page.getByRole("button", { name: /check (?:this )?run/i }).click();
  await expect(page.getByText(/interrupted/i).first()).toBeVisible();
  await expect(page.getByText("Owned canonical reply").first()).toBeVisible();
  await expect(composer).toHaveValue("Owned next draft");

  // Mounted navigation retains the actual run and draft; reload is a fresh view.
  await leaveAndReturn();
  await expect(page.getByText("evolve-run-1", { exact: false }).first()).toBeVisible();
  await expect(composer).toHaveValue("Owned next draft");
  // Installed only in future documents: a late request from the old mounted
  // watcher cannot be mistaken for a fetch initiated by the reloaded page.
  await page.addInitScript(() => {
    const observed: Array<{ method: string; path: string; body: string }> = [];
    (window as typeof window & { __ownedEvolveRequests?: typeof observed }).__ownedEvolveRequests = observed;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith("/api/evolve/")) {
        observed.push({ method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), path: url.pathname + url.search, body: typeof init?.body === "string" ? init.body : "" });
      }
      return original(input, init);
    };
  });
  const beforeReload = daemon.attempts.length;
  await page.reload({ waitUntil: "networkidle" });
  await startingText(start.text);
  await expect(page.getByText("evolve-run-1", { exact: false })).toHaveCount(0);
  const initiated = await page.evaluate(() => (window as typeof window & { __ownedEvolveRequests?: Array<{ method: string; path: string; body: string }> }).__ownedEvolveRequests ?? []);
  assert.ok(initiated.some(call => call.method === "GET" && call.path === "/api/evolve/thoughts/evolve-start"), `fresh document must read its selected thought: ${JSON.stringify(initiated)}`);
  const unexpected = initiated.filter(call => call.method !== "GET" || call.path.startsWith("/api/evolve/runs/"));
  assert.deepEqual(unexpected, [], `fresh document must not resume, admit or stop: ${JSON.stringify(unexpected)}`);
  const lateWrites = daemon.attempts.slice(beforeReload).filter(call => call.method !== "GET");
  assert.deepEqual(lateWrites, [], `reload must not cause a daemon write: ${JSON.stringify(lateWrites.map(({ method, path, body }) => ({ method, path, body })))}`);

  await composer.fill("Owned completed contribution"); await send.click();
  await expect(page.getByText("evolve-run-2", { exact: false }).first()).toBeVisible();
  daemon.setStatus("evolve-run-2", "completed", { outputs: 2 });
  await expect(page.getByText("Owned canonical reply").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Owned saved development 2").first()).toBeVisible();
  await composer.fill("Owned draft during transient observation failure");
  const beforeResolutionFailure = daemon.attempts.length;
  const failures = daemon.failedResolutionReads();
  const check = page.getByRole("button", { name: /check (?:this )?run/i });
  await expect(check).toBeEnabled();
  daemon.setResolutionFailure(true);
  try {
    await check.click();
    await expect.poll(() => daemon.failedResolutionReads()).toBeGreaterThan(failures);
    await expect(check).toBeEnabled();
    await expect(page.getByText("Owned saved development 2").first()).toBeVisible();
    await expect(page.getByText("Owned canonical reply").first()).toBeVisible();
    await expect(page.getByText("evolve-run-2", { exact: false }).first()).toBeVisible();
    await expect(composer).toHaveValue("Owned draft during transient observation failure");
    await expect(page.getByRole("status").filter({ hasText: /could not|unable|unavailable|temporar|observation/i }).first()).toBeVisible();
    assert.ok(!daemon.attempts.slice(beforeResolutionFailure).some(call => call.method !== "GET"), "failed observation must not issue writes");
  } finally { daemon.setResolutionFailure(false); }
  await check.click();
  await expect(page.getByText("Owned saved development 2").first()).toBeVisible();
  await expect(page.getByText("Owned canonical reply").first()).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /could not|unable|unavailable|temporar|observation/i })).toHaveCount(0);
  await expect(composer).toHaveValue("Owned draft during transient observation failure");
  const continuation = page.getByText(/continu(?:e|ing).*development 2/i).first();
  await expect(continuation).toBeVisible();
  await page.getByRole("button", { name: /^change$/i }).click();
  await page.getByRole("button", { name: /development 1/i }).click();
  await expect(page.getByText(/continu(?:e|ing).*development 1/i).first()).toBeVisible();
  await page.locator("article").filter({ hasText: "Owned saved development 1" }).getByRole("link", { name: /open idea/i }).click();
  await expect(page).toHaveURL(/\/ideas\/evolve-output-evolve-run-2-1/);
  await expect(page.getByRole("heading", { name: "Development 1" })).toBeVisible();
  await page.goBack();
  await expect(page.getByText(/continu(?:e|ing).*development 1/i).first()).toBeVisible();
  await composer.fill("Owned branch contribution"); await send.click();
  await expect.poll(() => admissions().length).toBe(first + 3);
  assert.equal(admissions().at(-1)?.path, "/thoughts/evolve-output-evolve-run-2-1/evolve");

  // Navigate through an actual earlier issued Idea without resetting the mounted provider.
  await page.locator("article").filter({ hasText: "Owned saved development 1" }).getByRole("link", { name: /open idea/i }).click();
  await expect(page).toHaveURL(/\/ideas\/evolve-output-evolve-run-2-1/);
  await expect(page.getByRole("heading", { name: "Development 1" })).toBeVisible();
  await page.getByRole("link", { name: /evolve this idea/i }).click();
  await startingText("Owned saved development 1");
  await composer.fill("Owned earlier branch"); await send.click();
  await expect.poll(() => admissions().length).toBe(first + 4);
  assert.equal(admissions().at(-1)?.path, "/thoughts/evolve-output-evolve-run-2-1/evolve");
  await expect(page.getByText("evolve-run-4", { exact: false }).first()).toBeVisible();
  const beforeConfirmedStop = daemon.attempts.length;
  await page.getByRole("button", { name: /^stop$/i }).click();
  await expect(page.getByText(/interrupted/i).first()).toBeVisible();
  const confirmedStops = daemon.attempts.slice(beforeConfirmedStop).filter(call => call.method === "POST" && call.path === "/runs/evolve-run-4/stop");
  assert.equal(confirmedStops.length, 1); assert.equal(confirmedStops[0]?.body, "{}");

  for (const [state, status, id] of [["complete", "completed", 5], ["interrupted", "interrupted", 7]] as const) {
    await page.goto(`${options.origin}/evolve?thoughtId=evolve-start`, { waitUntil: "networkidle" });
    await composer.fill(`Owned ${state} fallback`); await send.click();
    await expect(page.getByText(`evolve-run-${id}`, { exact: false }).first()).toBeVisible();
    daemon.setStatus(`evolve-run-${id}`, status, { fallback: state });
    await expect(page.getByText("Owned fallback reply").first()).toBeVisible({ timeout: 15000 });
    await composer.fill(`Continue after ${state}`); await send.click();
    await expect.poll(() => admissions().length).toBe(first + id + 1);
    assert.equal(admissions().at(-1)?.path, state === "complete" ? `/thoughts/evolve-contribution-${id}/evolve` : "/thoughts/evolve-start/evolve");
  }

  await page.goto(`${options.origin}/evolve?thoughtId=evolve-start`, { waitUntil: "networkidle" });
  await composer.fill("Owned failed outcome"); await send.click();
  await expect(page.getByText("evolve-run-9", { exact: false }).first()).toBeVisible();
  daemon.setStatus("evolve-run-9", "failed", { outputs: 1 });
  await expect(page.getByText(/failed/i).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Owned saved development 1").first()).toBeVisible();

  // Reject the sole selected output through the real Idea UI, then return to
  // the mounted workspace. Recovery must be a deliberate normal-scope choice.
  await composer.fill("Owned retained draft after rejection");
  await page.locator("article").filter({ hasText: "Owned saved development 1" }).getByRole("link", { name: /open idea/i }).click();
  await expect(page).toHaveURL(/\/ideas\/evolve-output-evolve-run-9-1/);
  await expect(page.getByRole("heading", { name: "Development 1" })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /reject idea/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reject this idea" }).click();
  await expect(page.getByRole("heading", { name: "Idea rejected" })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Saved idea unavailable")).toBeVisible();
  await expect(page.getByText("evolve-run-9", { exact: false }).first()).toBeVisible();
  await expect(composer).toHaveValue("Owned retained draft after rejection");
  await expect(send).toBeDisabled();
  await page.getByRole("button", { name: /^change$/i }).click();
  await page.locator("#evolve-continuation-choices").getByRole("button", { name: /starting thought/i }).click();
  await expect(page.getByText(/continu(?:e|ing).*starting thought/i).first()).toBeVisible();
  const beforeRecovery = admissions().length;
  await send.click();
  await expect.poll(() => admissions().length).toBe(beforeRecovery + 1);
  assert.equal(admissions().at(-1)?.path, "/thoughts/evolve-start/evolve");
  assert.deepEqual(JSON.parse(admissions().at(-1)?.body ?? "null"), { text: "Owned retained draft after rejection" });
  await expect(page.getByText("evolve-run-10", { exact: false }).first()).toBeVisible();
  daemon.setStatus("evolve-run-10", "completed");
  await page.getByRole("button", { name: /check (?:this )?run/i }).click();
  await expect(page.getByText(/completed/i).last()).toBeVisible();

  daemon.setAdmission("unknown");
  await page.goto(`${options.origin}/evolve?thoughtId=evolve-start`, { waitUntil: "networkidle" });
  const beforeUnknown = admissions().length;
  const beforeUnknownCalls = daemon.attempts.length;
  await composer.fill("Owned unknown admission"); await send.click();
  await expect(page.getByText(/admission unconfirmed|could not confirm|may have started/i).first()).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(composer).toHaveValue("Owned unknown admission");
  await page.waitForTimeout(300);
  assert.equal(admissions().length, beforeUnknown + 1);
  assert.ok(!daemon.attempts.slice(beforeUnknownCalls).some(call => call.path.startsWith("/runs/")), "unknown admission must not invent a run lookup");
  assert.ok(!daemon.attempts.slice(before).some(call => call.path.includes("scope=history") || call.path.includes("scope=show-rejected") || call.path.startsWith("/responses/")));
  assert.ok(daemon.attempts.slice(before).every(call => call.authorization === daemon.expectedAuthorization));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Evolve horizontal overflow");
}
