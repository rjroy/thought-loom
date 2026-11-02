import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { parseInquiryView } from "../../packages/contracts/src";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data });
  expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext) {
  return await (await control(request, "world", { empty: true })).json() as BrowserDialogueMetadata;
}
async function ideaWithLongInput(request: APIRequestContext) {
  const { root } = await world(request);
  const text = `  Fixture originating challenge ${"retain exact individual thought ".repeat(35)}\nFinal originating input line.  `;
  const opened = await request.post(`${daemon}/sources/${root.id}/dialogues`, { headers: { "idempotency-key": "excerpt-origin-dialogue" }, data: { selection: { kind: "source", id: root.id } } });
  expect(opened.status()).toBe(201); const dialogue = await opened.json() as { id: string };
  const saved = await request.post(`${daemon}/dialogues/${dialogue.id}/turns`, { headers: { "idempotency-key": "excerpt-origin-turn" }, data: { text } });
  expect(saved.status()).toBe(201); const turn = await saved.json() as { id: string; sourceId: string };
  await control(request, "start"); await control(request, "advance", { outcome: "succeeded", text: "Fixture response.", idea: true });
  const response = await request.get(`${daemon}/sources/${root.id}/inquiry`); expect(response.status()).toBe(200);
  const inquiry = parseInquiryView(await response.json());
  const idea = inquiry?.items.find((item) => item.kind === "developing-idea" && item.derivation?.turnSourceId === turn.sourceId);
  if (!idea) throw new Error("Missing idea derived from fixture turn");
  expect(turn.sourceId).not.toBe(root.id);
  return { root, text, turn, idea };
}
function sourceReads(page: Page, sourceId: string) {
  const paths: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/sources/")) paths.push(new URL(request.url()).pathname); });
  return { paths, count: () => paths.filter((path) => path === `/api/sources/${sourceId}`).length };
}
async function oneVisibleBody(scope: import("@playwright/test").Locator, text: string) {
  await expect(scope.getByText(text, { exact: true })).toBeVisible();
  const prefix = text.trim().slice(0, 65);
  expect((await scope.innerText()).split(prefix)).toHaveLength(2);
}
test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("search source excerpt reveals the exact full original without replacing the result or query", async ({ page, request }) => {
  await world(request);
  const text = `Fixture quasarexcerpt original ${"preserve the source content ".repeat(30)}final search source line.`;
  const saved = await request.post(`${daemon}/captures`, { headers: { "idempotency-key": "excerpt-search-source" }, data: { text, provenance: "fixture" } });
  expect(saved.status()).toBe(201); const source = await saved.json() as { id: string; text: string };
  expect(source.text).toBe(text);
  await page.goto("/search?q=quasarexcerpt");
  const result = page.getByRole("region", { name: "Search results", exact: true }).locator("article").filter({ has: page.locator(`a[href*="/sources/${source.id}/"]`) });
  await expect(result.locator(".result-excerpt")).toBeVisible();
  expect((await result.locator(".result-excerpt").innerText()).length).toBeLessThan(text.length);
  const link = result.getByRole("link", { name: "Open thought", exact: true }), href = await link.getAttribute("href");
  const reads = sourceReads(page, source.id), url = page.url();
  const expand = result.getByRole("button", { name: "Read full text", exact: true });
  await expect(expand).toBeVisible(); await expand.click();
  await oneVisibleBody(result, text); expect(reads.count()).toBe(1); expect(page.url()).toBe(url);
  await expect(link).toHaveAttribute("href", href ?? "");
  await result.getByRole("button", { name: "Show less", exact: true }).click();
  expect(page.url()).toBe(url); expect(reads.count()).toBe(1);
});

test("search item passage expands its exact formulation and keeps its version link", async ({ page, request }) => {
  const { root } = await world(request);
  const item = await (await control(request, "seed-recent-reading", { longText: true })).json() as { id: string; current: { id: string; text: string } };
  expect(item.current.text.length).toBeGreaterThan(240);
  const reads = sourceReads(page, root.id);
  await page.goto("/search?q=interpretation");
  const result = page.getByRole("region", { name: "Search results", exact: true }).locator("article").filter({ has: page.locator(`a[href*="item=${item.id}"]`) });
  const formulation = result.locator(".result-formulation a");
  await expect(formulation).toContainText("Fixture long interpretation");
  expect((await formulation.innerText()).length).toBeLessThan(item.current.text.length);
  const href = await formulation.getAttribute("href"); if (!href) throw new Error("Missing item link");
  const url = new URL(href, page.url());
  expect(url.searchParams.get("item")).toBe(item.id); expect(url.searchParams.get("version")).toBe(item.current.id);
  expect(reads.count()).toBe(0);
  const requests: URL[] = [];
  page.on("request", (req) => { const address = new URL(req.url()); if (address.pathname === `/api/sources/${root.id}/inquiry`) requests.push(address); });
  const disclosure = result.locator(".source-excerpt-disclosure").first();
  await disclosure.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect(disclosure.getByText(item.current.text, { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get("itemId")).toBe(item.id); expect(requests[0].searchParams.get("versionId")).toBe(item.current.id);
  expect(reads.count()).toBe(0);
  await expect(result.getByRole("link", { name: "Open thought", exact: true })).toHaveAttribute("href", href);
});

test("evidence for an idea expands the exact originating turn, not the root source", async ({ page, request }) => {
  const { root, text, turn, idea } = await ideaWithLongInput(request);
  await page.goto(`/sources/${root.id}/inquiry?item=${idea.id}&version=${idea.current.id}&q=fixture`);
  const reading = page.locator(`#item-${idea.id}`);
  await reading.getByRole("button", { name: "Evidence", exact: true }).click();
  // History contains another legitimate reference to the same immutable
  // source. Assert within the current reading's evidence disclosure only.
  const entry = reading.locator(".evidence-disclosure").first().locator(".evidence-links li").filter({ has: page.locator(`a[href*="/sources/${turn.sourceId}"]`) });
  const link = entry.getByRole("link"), href = await link.getAttribute("href");
  await expect(link).toBeVisible(); expect((await link.innerText()).length).toBeLessThan(text.length);
  const composer = page.getByRole("textbox", { name: "Develop this thought", exact: true });
  await composer.fill("Fixture draft survives evidence expansion");
  const reads = sourceReads(page, turn.sourceId), url = page.url();
  const expand = entry.getByRole("button", { name: "Read full text", exact: true });
  await expect(expand).toBeVisible(); await expand.focus(); await page.keyboard.press("Enter");
  await oneVisibleBody(entry, text); expect(reads.count()).toBe(1);
  expect(reads.paths).not.toContain(`/api/sources/${root.id}`);
  await expect(link).toHaveAttribute("href", href ?? "");
  await expect(composer).toHaveValue("Fixture draft survives evidence expansion"); expect(page.url()).toBe(url);
  await page.keyboard.press("Space"); await expect(expand).toBeFocused();
  expect(page.url()).toBe(url); expect(reads.count()).toBe(1);
});

test("idea derivation expands its distinct immutable originating input without changing the selected target", async ({ page, request }) => {
  const { root, text, turn, idea } = await ideaWithLongInput(request);
  await page.goto(`/sources/${root.id}/inquiry?item=${idea.id}&version=${idea.current.id}&q=fixture`);
  const derivation = page.getByRole("region", { name: "Idea derivation", exact: true });
  const card = derivation.locator(".originating-input"), link = card.getByRole("link", { name: "Your discussion input", exact: true });
  await expect(link).toHaveAttribute("href", new RegExp(`/sources/${turn.sourceId}`));
  await expect(card.locator(".thought-body")).toContainText(text.trim().slice(0, 60));
  const composer = page.getByRole("textbox", { name: "Develop this thought", exact: true });
  await composer.fill("Fixture draft survives derivation expansion");
  const url = page.url(), reads = sourceReads(page, turn.sourceId);
  const expand = card.getByRole("button", { name: "Read full text", exact: true });
  await expect(expand).toBeVisible(); await expand.click();
  await oneVisibleBody(card, text); expect(reads.count()).toBe(1);
  expect(reads.paths).not.toContain(`/api/sources/${root.id}`);
  expect(page.url()).toBe(url); await expect(composer).toHaveValue("Fixture draft survives derivation expansion");
  await expect(link).toHaveAttribute("href", new RegExp(`/sources/${turn.sourceId}`));
});
