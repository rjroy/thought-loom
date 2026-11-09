import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page, type Route } from "@playwright/test";

export function browseDaemon(token: string) {
  const attempts: string[] = [];
  let empty = false;
  const items = Array.from({ length: 51 }, (_, index) => ({
    id: `browse-${String(index).padStart(2, "0")}`, text: `Owned browse text ${index}`, title: `Owned browse title ${index}`,
    titleAuthor: "user", author: index % 2 ? "ai" : "user", kind: index % 2 ? "developing-idea" : "captured-original",
    createdAt: `2030-01-${String(Math.floor(index / 2) + 1).padStart(2, "0")}T00:00:00.000Z`, origin: "fixture", parentId: null, sourceIds: [],
  }));
  return {
    attempts,
    setEmpty(value: boolean) { empty = value; },
    async handler(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "", "http://fixture.invalid");
      attempts.push(url.pathname + url.search);
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const authors = url.searchParams.getAll("author"), scope = url.searchParams.get("scope");
      const filtered = empty ? [] : items.filter(item => authors.includes(item.author));
      if (url.searchParams.get("sort") !== "oldest") filtered.reverse();
      const limit = Number(url.searchParams.get("limit") ?? "50"), start = Number(url.searchParams.get("cursor") ?? "0");
      const selected = filtered.slice(start, start + limit).map(item => scope === "show-rejected" ? { ...item, rejected: false } : item);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: selected, nextCursor: start + limit < filtered.length ? String(start + limit) : null }));
    },
  };
}

async function checkRapidBrowseIntent(page: Page): Promise<void> {
  const pattern = "**/api/browse/thoughts?*";
  const release = Promise.withResolvers<void>();
  const pending = new Set<Promise<void>>();
  const requests: URL[] = [];
  const handler = (route: Route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const authors = url.searchParams.getAll("author");
    const final = url.searchParams.get("sort") === "oldest" && authors.length === 1 && authors[0] === "user"
      && url.searchParams.get("scope") === "show-rejected";
    const work = (async () => {
      try {
        if (final) { await route.continue(); return; }
        const response = await route.fetch();
        await release.promise;
        await route.fulfill({ response });
      } catch { /* Superseded browser requests may already have been aborted. */ }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };
  await page.route(pattern, handler);
  const sort = page.getByRole("combobox", { name: "Sort" });
  const authors = page.getByRole("group", { name: "Authorship" });
  const ai = authors.getByRole("checkbox", { name: "AI" });
  const user = authors.getByRole("checkbox", { name: "You" });
  const rejected = page.getByRole("checkbox", { name: "Show rejected" });
  const location = (value: string) => {
    const url = new URL(value);
    return { path: url.pathname, sort: url.searchParams.get("sort") ?? "newest",
      authors: url.searchParams.getAll("author"), scope: url.searchParams.get("scope") ?? "normal" };
  };
  let predecessor = "";
  const assertFinal = async () => {
    await expect(sort).toHaveValue("oldest");
    await expect(user).toBeChecked();
    await expect(ai).not.toBeChecked();
    await expect(rejected).toBeChecked();
    await expect.poll(() => {
      const query = new URL(page.url()).searchParams;
      return { sort: query.get("sort"), authors: query.getAll("author"), scope: query.get("scope") };
    }).toEqual({ sort: "oldest", authors: ["user"], scope: "show-rejected" });
  };
  try {
    await sort.selectOption({ label: "Oldest first" });
    await ai.click();
    predecessor = page.url();
    await rejected.click();
    await assertFinal();
    await expect.poll(() => {
      const query = requests.at(-1)?.searchParams;
      return { sort: query?.get("sort"), authors: query?.getAll("author"), scope: query?.get("scope") };
    }).toEqual({ sort: "oldest", authors: ["user"], scope: "show-rejected" });
    assert.ok(requests.length >= 2, "rapid intents must exercise superseded catalog requests");
    release.resolve();
    await Promise.allSettled([...pending]);
    await assertFinal();
  } finally {
    release.resolve();
    await page.unroute(pattern, handler);
    await Promise.allSettled([...pending]);
  }
  // Actual browser history must still restore the previous and final intent.
  await page.goBack();
  const previous = { path: "/browse", sort: "oldest", authors: ["user"], scope: "normal" };
  expect(location(predecessor)).toEqual(previous);
  await expect.poll(() => location(page.url())).toEqual(previous);
  await expect(sort).toHaveValue("oldest");
  await expect(user).toBeChecked();
  await expect(ai).not.toBeChecked();
  await expect(rejected).not.toBeChecked();
  await page.goForward();
  await expect.poll(() => location(page.url())).toEqual({ ...previous, scope: "show-rejected" });
  await assertFinal();
}

export async function checkBrowseBrowser(page: Page, fixture: ReturnType<typeof browseDaemon>, options: { origin: string; daemonOrigin: string; token: string }): Promise<void> {
  const leaks: string[] = [];
  page.on("request", request => {
    if (request.url().startsWith(options.daemonOrigin) || request.url().includes(options.token) || request.headers().authorization?.includes(options.token)) leaks.push("browser request leaked daemon configuration");
  });
  page.on("console", message => { if (message.text().includes(options.token) || message.text().includes(options.daemonOrigin)) leaks.push("console leaked daemon configuration"); });
  await page.goto(`${options.origin}/explore`, { waitUntil: "networkidle" });
  const nav = page.getByRole("navigation");
  await expect(page.getByText("Reserved", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  const link = nav.getByRole("link", { name: "Browse", exact: true });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/browse(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Browse", exact: true })).toBeVisible();
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Owned browse title 50", { exact: true })).toBeVisible();
  await expect(page.getByText("Owned browse title 0", { exact: true })).toHaveCount(0);
  const rows = page.getByRole("list", { name: "Ideas" }).getByRole("listitem");
  await expect(rows).toHaveCount(50);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(rows).toHaveCount(51);
  await expect(page.getByText("Owned browse title 0", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  for (let i = 0; i < 51; i++) await expect(page.getByText(`Owned browse title ${i}`, { exact: true })).toHaveCount(1);
  await expect(page.locator('a[href^="/browse/"]')).toHaveCount(0);
  await checkRapidBrowseIntent(page);
  const sort = page.getByRole("combobox", { name: "Sort" });
  const ai = page.getByRole("group", { name: "Authorship" }).getByRole("checkbox", { name: "AI" });
  const user = page.getByRole("group", { name: "Authorship" }).getByRole("checkbox", { name: "You" });
  await page.reload({ waitUntil: "networkidle" });
  await expect(sort).toHaveValue("oldest");
  await expect(ai).not.toBeChecked();
  await expect(user).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Show rejected" })).toBeChecked();
  await user.uncheck();
  await expect(page.getByText("Select You or AI to show ideas.")).toBeVisible();
  const before = fixture.attempts.length;
  await page.getByRole("button", { name: "Refresh list" }).click();
  assert.equal(fixture.attempts.length, before, "empty authors must not query daemon");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(user).toBeChecked(); await expect(ai).toBeChecked();
  await expect(sort).toHaveValue("oldest");
  await expect(page.getByRole("checkbox", { name: "Show rejected" })).not.toBeChecked();
  fixture.setEmpty(true);
  try {
    await page.getByRole("button", { name: "Refresh list" }).click();
    await expect(page.getByRole("heading", { name: "No ideas yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Capture a thought" })).toHaveAttribute("href", "/capture");
    await ai.uncheck();
    await expect(page.getByRole("heading", { name: "No ideas match these filters" })).toBeVisible();
  } finally { fixture.setEmpty(false); }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal overflow");
  const html = await page.content();
  assert.ok(!html.includes(options.token) && !html.includes(options.daemonOrigin));
  assert.deepEqual(leaks, []);
}
