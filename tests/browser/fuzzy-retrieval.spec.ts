import { expect, test, type APIRequestContext } from "@playwright/test";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;

async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data });
  expect(response.status()).toBe(200);
  return response;
}

async function capture(request: APIRequestContext, key: string, text: string) {
  const response = await request.post(`${daemon}/captures`, { headers: { "idempotency-key": key }, data: { text, provenance: "synthetic passage fixture" } });
  expect(response.status()).toBe(201);
  return await response.json() as { id: string; text: string };
}

test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("late original passage highlights original Unicode graphemes and escapes literal markup", async ({ page, request }) => {
  await control(request, "world", { empty: true });
  const match = "e\u0301👩‍💻<needle>";
  const text = `${"Prelude content without the token. ".repeat(20)}${match} end of source.`;
  const source = await capture(request, "fuzzy-unicode-source", text);
  const query = "É👩‍💻<needle>";
  await page.goto(`/search?${new URLSearchParams({ q: query })}`);
  const result = page.locator("article.search-result").filter({ has: page.locator(`a[href*="/sources/${source.id}/"]`) });
  const excerpt = result.locator(".result-excerpt");
  await expect(excerpt).toContainText(match);
  await expect(excerpt.locator("mark")).toHaveText(["e\u0301👩‍💻<needle>"]);
  await expect(excerpt.locator("needle")).toHaveCount(0);
  expect((await excerpt.innerText()).length).toBeLessThan(text.length);
  await result.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect(result.getByText(text, { exact: true })).toBeVisible();
});

test("widely separated match fragments are labeled as noncontiguous", async ({ page, request }) => {
  await control(request, "world", { empty: true });
  const text = `🟢${" distant ordinary filler ".repeat(80)}🟣`;
  const source = await capture(request, "fuzzy-separated-source", text);
  await page.goto(`/search?${new URLSearchParams({ q: "🟢🟣" })}`);
  const result = page.locator("article.search-result").filter({ has: page.locator(`a[href*="/sources/${source.id}/"]`) });
  await expect(result.locator("mark")).toHaveText(["🟢", "🟣"]);
  await expect(result.getByText("Match spans separated passages.", { exact: true })).toBeVisible();
  await expect(result.locator(".result-excerpt")).toContainText("…");
  expect((await result.locator(".result-excerpt").innerText()).length).toBeLessThan(text.length);
});

test("an oversized matched whitespace run is honestly marked as omitted", async ({ page, request }) => {
  await control(request, "world", { empty: true });
  const text = `🟠${" ".repeat(5000)}🟤`;
  const source = await capture(request, "fuzzy-omitted-source", text);
  await page.goto(`/search?${new URLSearchParams({ q: "🟠 🟤" })}`);
  const result = page.locator("article.search-result").filter({ has: page.locator(`a[href*="/sources/${source.id}/"]`) });
  await expect(result.getByText("Some matched text is outside this preview.", { exact: true })).toBeVisible();
  await result.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect(result.getByText(text, { exact: true })).toBeVisible();
});

test("title match keeps item body and original context distinct", async ({ page, request }) => {
  const world = await (await control(request, "world", { empty: true })).json() as BrowserDialogueMetadata;
  const item = await (await control(request, "seed-recent-reading", { longText: true })).json() as { id: string; current: { id: string; text: string } };
  await control(request, "seed-generated-title", { itemId: item.id, versionId: item.current.id, text: "Quasar title fixture" });
  await page.goto("/search?q=Quasar%20title%20fixture");
  const result = page.locator("article.search-result").filter({ has: page.locator(`a[href*="item=${item.id}"]`) });
  await expect(result.getByText("Matched title", { exact: true })).toBeVisible();
  await expect(result.getByText("Quasar title fixture", { exact: true })).toBeVisible();
  await expect(result.getByText("Original context", { exact: true })).toBeVisible();
  const body = result.locator(".source-excerpt-disclosure").first();
  await body.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect(body.getByText(item.current.text, { exact: true })).toBeVisible();
  expect(world.root.text).not.toBe(item.current.text);
  await expect(result.locator(".source-excerpt-disclosure").last()).toContainText(world.root.text.slice(0, 30));
});

test("item result retains its exact formulation after revision, full disclosure and query navigation", async ({ page, request }) => {
  const world = await (await control(request, "world", { empty: true })).json() as BrowserDialogueMetadata;
  const item = await (await control(request, "seed-recent-reading", { longText: true })).json() as { id: string; current: { id: string; text: string } };
  const query = "  long interpretation  ";
  await page.goto(`/search?${new URLSearchParams({ q: query })}`);
  const result = page.locator("article.search-result").filter({ has: page.locator(`a[href*="item=${item.id}"]`) });
  await expect(result.getByText("AI interpretation · Tentative", { exact: true })).toBeVisible();
  await expect(result.getByText("Original context", { exact: true })).toBeVisible();
  const link = result.getByRole("link", { name: "Open thought", exact: true });
  const href = await link.getAttribute("href");
  if (!href) throw new Error("Missing pinned result link");
  const target = new URL(href, page.url());
  expect(target.searchParams.get("item")).toBe(item.id);
  expect(target.searchParams.get("version")).toBe(item.current.id);
  expect(target.searchParams.get("q")).toBe(query);
  await control(request, "revise-recent-reading");
  const disclosure = result.locator(".source-excerpt-disclosure").first();
  await disclosure.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect(disclosure.getByText(item.current.text, { exact: true })).toBeVisible();
  await expect(link).toHaveAttribute("href", href);
  await link.click();
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${world.root.id}/inquiry` && url.searchParams.get("version") === item.current.id && url.searchParams.get("q") === query);
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search thoughts", exact: true })).toHaveValue(query);
});

test("a bounded result set reports more matches and preserves the raw query", async ({ page, request }) => {
  await control(request, "world", { empty: true });
  await capture(request, "fuzzy-limit-a", "prefix limitfixture alpha");
  await capture(request, "fuzzy-limit-b", "prefix limitfixture beta");
  const query = " limitfixture ";
  await page.goto(`/search?${new URLSearchParams({ q: query, limit: "1" })}`);
  await expect(page.getByRole("status").filter({ hasText: "More matches available" })).toBeVisible();
  await expect(page.locator("article.search-result")).toHaveCount(1);
  await expect(page.getByRole("searchbox", { name: "Search thoughts", exact: true })).toHaveValue(query);
  await expect(page.getByText("No thoughts found", { exact: true })).toHaveCount(0);
});

test("alias-only result names the expansion and its author instead of claiming a direct match", async ({ page }) => {
  const query = "software development kit";
  await page.goto(`/search?${new URLSearchParams({ q: query })}`);
  const result = page.locator("article.search-result").filter({ hasText: "The SDK makes integrations easier" });
  await expect(result.getByText("Matched recorded alias", { exact: true })).toBeVisible();
  await expect(result.getByText("Matched “SDK” via a recorded alias · Written by you", { exact: true })).toBeVisible();
  await expect(result.locator("mark")).toContainText("SDK");
});
