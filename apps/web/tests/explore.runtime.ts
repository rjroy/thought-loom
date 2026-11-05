import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";

type Attempt = { path: string; authorization: string | undefined };
const context = { id: "context-1", text: "Context owned original", title: "Context title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2030-01-01T00:00:00.000Z", origin: "capture", parentId: null, sourceIds: [] };
const text = `Owned matching thought begins. ${"Actual saved thinking, not a summary. ".repeat(120)}End of owned matching thought.`;
const base = { thoughtId: "thought-1", title: "Owned development", materialKind: "developing-idea", createdAt: "2032-02-10T12:00:00.000Z", context: { kind: "predecessor", thought: context } };
const thought = { ...base, kind: "thought", id: "thought-1", text, snippet: text.slice(0, 160), author: "ai" };
const replyText = "Owned response original full wording";
const responseHit = { ...base, kind: "response", id: "response-1", text: replyText, snippet: replyText, author: "ai" };
const rejected = { ...thought, id: "thought-2", thoughtId: "thought-2", title: "Owned rejected thought", text: "Rejected fixture thought", snippet: "Rejected fixture thought" };
const unknown = { ...thought, id: "thought-3", thoughtId: "thought-3", title: "Inspection unknown thought", text: "Unknown inspection thought", snippet: "Unknown inspection thought" };
const imported = { ...thought, id: "source-1", thoughtId: "source-1", title: "Owned imported search result", text: "Owned imported search text", snippet: "Owned imported search text", author: "source", materialKind: "imported-original", context: null };

export function searchDaemon(token: string) {
  const attempts: Attempt[] = [];
  let mode: "normal" | "failure" | "hold" = "normal";
  let release: (() => void) | undefined;
  return {
    attempts,
    expectedAuthorization: `Bearer ${token}`,
    setMode(value: typeof mode) { mode = value; },
    release() { release?.(); release = undefined; },
    async handler(req: IncomingMessage, res: ServerResponse) {
      const path = req.url ?? "";
      attempts.push({ path, authorization: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const url = new URL(path, "http://fixture.invalid");
      if (url.pathname.startsWith("/thoughts/")) {
        if (url.pathname === "/thoughts/thought-3") { res.writeHead(500).end("owned inspection failure"); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rejected: url.pathname === "/thoughts/thought-2" }));
        return;
      }
      const selectedMode = mode;
      if (selectedMode === "hold") await new Promise<void>(resolve => { release = resolve; });
      if (selectedMode === "failure") { res.writeHead(500).end("owned private query failure"); return; }
      const q = url.searchParams.get("q") ?? "";
      const authors = url.searchParams.getAll("author"), kinds = url.searchParams.getAll("kind");
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      const all = q === "empty-owned" ? [] : q === "source-owned" ? [imported] : q === "newer-owned" ? [{ ...thought, title: "Newest response wins" }] : [thought, responseHit, ...(url.searchParams.get("scope") === "show-rejected" ? [rejected, unknown] : [])];
      const dated = all.filter(item => (!from || item.createdAt.slice(0, 10) >= from.slice(0, 10)) && (!to || item.createdAt.slice(0, 10) <= to.slice(0, 10)));
      const authorFiltered = dated.filter(item => !authors.length || authors.includes(item.author));
      const kindFiltered = dated.filter(item => !kinds.length || kinds.includes(item.materialKind));
      const results = authorFiltered.filter(item => !kinds.length || kinds.includes(item.materialKind));
      const counts = { authors: { user: kindFiltered.filter(item => item.author === "user").length, ai: kindFiltered.filter(item => item.author === "ai").length, source: kindFiltered.filter(item => item.author === "source").length }, kinds: { "captured-original": 0, "user-contribution": 0, "ai-interpretation": 0, "developing-idea": authorFiltered.filter(item => item.materialKind === "developing-idea").length, "imported-original": authorFiltered.filter(item => item.materialKind === "imported-original").length } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results, counts }));
    },
  };
}

type Fixture = ReturnType<typeof searchDaemon>;
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;
export async function checkSearchRoute({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  const before = daemon.attempts.length;
  assert.ok((await probe("GET", "/api/search?q=owned", "")).status >= 400);
  assert.equal((await probe("GET", "/api/search?q=owned", `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
  assert.equal(daemon.attempts.length, before);
  const response = await fetch(`${origin}/api/search?q=owned&author=ai&kind=developing-idea&scope=show-rejected`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  const data = await response.json();
  assert.equal(data.results.length, 4);
  assert.deepEqual(data.rejectionStatus, { "thought-1": false, "thought-2": true, "thought-3": null });
  const calls = daemon.attempts.slice(before);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.authorization === daemon.expectedAuthorization));
  const search = new URL(calls[0]?.path ?? "", origin);
  assert.equal(search.pathname, "/search");
  assert.equal(search.searchParams.get("q"), "owned");
  assert.deepEqual(search.searchParams.getAll("author"), ["ai"]);
  assert.deepEqual(search.searchParams.getAll("kind"), ["developing-idea"]);
  assert.deepEqual(calls.slice(1).map(call => call.path).sort(), ["/thoughts/thought-1?scope=show-rejected", "/thoughts/thought-2?scope=show-rejected", "/thoughts/thought-3?scope=show-rejected"]);
  daemon.setMode("failure");
  try {
    const failure = await fetch(`${origin}/api/search?q=owned-private-query`);
    assert.equal(failure.status, 502);
    assert.match(failure.headers.get("cache-control") ?? "", /no-store/i);
    assert.ok(!(await failure.text()).includes("owned private query failure"));
  } finally { daemon.setMode("normal"); }
}

export async function checkExploreBrowser(page: Page, daemon: Fixture, options: { origin: string; daemonOrigin: string; token: string; narrow: boolean }): Promise<void> {
  const field = page.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i });
  const search = page.getByRole("button", { name: /^search$/i });
  const openFilters = async () => {
    if (options.narrow) {
      const button = page.getByRole("button", { name: /^filters(?:\s*\(\d+\))?$/i });
      await button.click();
      await expect(page.getByRole("heading", { name: /filters/i })).toBeVisible();
    }
  };
  const closeFilters = async () => { if (options.narrow) await page.getByRole("button", { name: /close filters|^close$/i }).click(); };
  const ai = page.getByRole("group", { name: "Authorship" }).getByRole("checkbox", { name: /^ai(?:\s|$)/i });
  const user = page.getByRole("checkbox", { name: /\byou\b|\buser\b/i });
  const developing = page.getByRole("checkbox", { name: /developing/i });
  const original = page.getByRole("checkbox", { name: /original/i });
  const showRejected = page.getByRole("checkbox", { name: /show rejected/i });
  const sort = page.getByRole("combobox", { name: /sort/i });
  const searchCalls = () => daemon.attempts.filter(call => call.path.startsWith("/search?"));
  const before = searchCalls().length;
  await expect(field).toBeVisible({ timeout: 5000 });
  await expect(field).toHaveValue("");
  assert.equal(searchCalls().length, before, "initial Explore must not query daemon");
  await field.fill("source-owned"); await search.click();
  const importedCard = page.locator("article").filter({ hasText: "Owned imported search result" });
  await expect(importedCard).toBeVisible();
  await expect(importedCard.getByText("Imported source", { exact: true }).first()).toBeVisible();
  await expect(importedCard.getByText("AI", { exact: true })).toHaveCount(0);
  const afterImported = searchCalls().length;
  await field.fill("owned");
  daemon.setMode("hold");
  try {
    await search.click();
    await expect.poll(() => searchCalls().length).toBe(afterImported + 1);
    await expect(page.getByText(/searching|loading/i).first()).toBeVisible();
  } finally { daemon.release(); daemon.setMode("normal"); }
  await expect(page.getByText("Owned development").first()).toBeVisible();
  await expect(page.getByText("Context title").first()).toBeVisible();
  await expect(page.getByText(/response|reply/i).first()).toBeVisible();
  await expect(page.getByText(/End of owned matching thought\./)).toHaveCount(0);
  await page.getByRole("button", { name: /expand|show more|read more/i }).first().click();
  await expect(page.getByText(/End of owned matching thought\./)).toBeVisible();
  const links = await page.locator('a[href^="/ideas/"]').evaluateAll(items => items.map(item => item.getAttribute("href") ?? ""));
  assert.ok(links.length >= 2);
  const parsed = links.map(link => new URL(link, options.origin));
  assert.ok(parsed.some(url => url.pathname === "/ideas/thought-1" && url.searchParams.get("responseId") === "response-1" && url.searchParams.get("returnTo")?.startsWith("/explore?")));
  assert.ok(parsed.some(url => url.pathname === "/ideas/thought-1" && !url.searchParams.has("responseId")));

  await openFilters();
  await expect(ai).toBeVisible();
  await expect(user).toBeVisible();
  await expect(ai).toHaveAccessibleName(/2/);
  await expect(developing).toHaveAccessibleName(/2/);
  await ai.check(); await user.check(); await developing.check(); await original.check();
  const date = page.getByRole("combobox", { name: "Created (UTC)" });
  const customValue = await date.locator("option").evaluateAll(options => options.find(option => /custom/i.test(option.textContent ?? ""))?.getAttribute("value"));
  assert.ok(customValue, "custom date option is required");
  await date.selectOption(customValue);
  await page.getByLabel(/^from$/i).fill("2032-02-01");
  await page.getByLabel(/^to$/i).fill("2032-02-29");
  await showRejected.check();
  await closeFilters();
  await sort.selectOption("newest");
  await expect.poll(() => searchCalls().some(call => {
    const p = new URL(call.path, options.origin).searchParams;
    return p.get("q") === "owned" && p.getAll("author").includes("ai") && p.getAll("author").includes("user") && p.getAll("kind").includes("developing-idea") && p.getAll("kind").includes("captured-original") && p.get("from") === "2032-02-01" && p.get("to") === "2032-02-29" && p.get("scope") === "show-rejected" && p.get("sort") === "newest";
  }), { timeout: 5000 }).toBe(true);
  await expect(page.getByText("Owned rejected thought")).toBeVisible();
  await expect(page.getByText("Inspection unknown thought")).toBeVisible();
  const rejectedCard = page.locator("article").filter({ hasText: "Owned rejected thought" });
  const unknownCard = page.locator("article").filter({ hasText: "Inspection unknown thought" });
  await expect(rejectedCard.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(unknownCard.getByText(/^(?:active|rejected)$/i)).toHaveCount(0);

  const bookmark = page.url();
  assert.ok(new URL(bookmark).searchParams.get("q") === "owned");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const scroll = await page.evaluate(() => window.scrollY);
  const captureLink = page.getByRole("link", { name: "Capture", exact: true });
  await expect(captureLink).toBeInViewport({ ratio: 1 });
  await captureLink.evaluate(link => link.addEventListener("click", () => {
    document.documentElement.dataset.testNavigationScroll = String(window.scrollY);
  }, { capture: true, once: true }));
  await captureLink.click();
  const navigationScroll = Number(await page.locator("html").getAttribute("data-test-navigation-scroll"));
  assert.ok(navigationScroll > 0, "navigation must start at a positive reading position");
  assert.ok(Math.abs(navigationScroll - scroll) <= 2, "clicking visible Capture must not move the reading position");
  await page.getByRole("link", { name: "Explore", exact: true }).click();
  await expect(field).toHaveValue("owned");
  await expect(page.getByText(/End of owned matching thought\./)).toBeVisible();
  try {
    await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - navigationScroll), { timeout: 5000 }).toBeLessThanOrEqual(2);
  } finally {
    console.log(`Explore ${options.narrow ? "narrow" : "desktop"} return scroll: expected=${navigationScroll} restored=${await page.evaluate(() => window.scrollY)}`);
  }
  const browser = page.context().browser();
  const viewport = page.viewportSize();
  assert.ok(browser && viewport, "bookmark check requires an owned browser and viewport");
  const freshContext = await browser.newContext({ viewport, baseURL: options.origin });
  try {
    const fresh = await freshContext.newPage();
    const freshLeaks: string[] = [];
    fresh.on("request", request => { if (request.url().startsWith(options.daemonOrigin) || request.url().includes(options.token) || request.headers().authorization?.includes(options.token)) freshLeaks.push("credential boundary"); });
    await fresh.goto(bookmark, { waitUntil: "networkidle" });
    await expect(fresh.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i })).toHaveValue("owned");
    await expect(fresh.getByRole("combobox", { name: /sort/i })).toHaveValue("newest");
    if (options.narrow) await fresh.getByRole("button", { name: /^filters/i }).click();
    await expect(fresh.getByRole("group", { name: "Authorship" }).getByRole("checkbox", { name: /^ai(?:\s|$)/i })).toBeChecked();
    await expect(fresh.getByRole("checkbox", { name: /developing/i })).toBeChecked();
    await expect(fresh.getByRole("checkbox", { name: /show rejected/i })).toBeChecked();
    await expect(fresh.getByLabel(/^from$/i)).toHaveValue("2032-02-01");
    await expect(fresh.getByLabel(/^to$/i)).toHaveValue("2032-02-29");
    await fresh.reload({ waitUntil: "networkidle" });
    await expect(fresh.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i })).toHaveValue("owned");
    assert.deepEqual(freshLeaks, []);
  } finally { await freshContext.close(); }
  await openFilters();
  await page.getByRole("button", { name: /clear filters/i }).click();
  await expect(ai).not.toBeChecked(); await expect(showRejected).not.toBeChecked();
  if (options.narrow) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^filters/i })).toBeFocused();
  }
  await expect(field).toHaveValue("owned");
  await expect(sort).toHaveValue("newest");

  await field.fill("empty-owned"); await search.click();
  await expect(page.getByText(/no results/i).first()).toBeVisible();
  daemon.setMode("failure");
  await field.fill("failed-owned"); await search.click();
  await expect(page.getByText(/search unavailable|could not search|unable to search|search failed/i).first()).toBeVisible();
  await expect(field).toHaveValue("failed-owned");
  daemon.setMode("normal");
  await page.getByRole("button", { name: /retry search/i }).click();
  await expect(page.getByText("Owned development").first()).toBeVisible();
  daemon.setMode("hold");
  try {
    const start = searchCalls().length;
    await field.fill("older-owned"); await search.click();
    await expect.poll(() => searchCalls().length).toBe(start + 1);
    daemon.setMode("normal");
    await field.fill("newer-owned"); await search.click();
    await expect(page.getByText("Newest response wins")).toBeVisible();
    daemon.release();
    await page.waitForTimeout(300);
    await expect(page.getByText("Newest response wins")).toBeVisible();
  } finally { daemon.release(); daemon.setMode("normal"); }
}
