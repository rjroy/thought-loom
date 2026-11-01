import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { parseInquiryView, parseSpringboardView, type SpringboardThought } from "../../packages/contracts/src";
import { inquiryHref } from "../../apps/web/lib/links";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data });
  expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext) {
  return await (await control(request, "world", { empty: true })).json() as BrowserDialogueMetadata;
}
async function batch(page: Page) {
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/springboard" && value.status() === 200);
  await page.goto("/");
  const view = parseSpringboardView(await (await response).json());
  if (!view) throw new Error("Invalid springboard fixture");
  return view.items;
}
function card(page: Page, thought: SpringboardThought) {
  const href = thought.kind === "source" ? `${inquiryHref(thought.sourceId)}#discussion-target` : inquiryHref(thought.sourceId, "", thought.id, thought.versionId);
  return page.locator(`a.thought-card[href=${JSON.stringify(href)}]`);
}
test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("compact reading expands its already-loaded exact body with keyboard without navigation or reloading", async ({ page, request }) => {
  const { root } = await world(request);
  const item = await (await control(request, "seed-recent-reading", { longText: true })).json() as { id: string; current: { id: string; text: string } };
  expect(item.current.text.length).toBeGreaterThan(240);
  let reads = 0;
  page.on("request", (req) => { if (new URL(req.url()).pathname === `/api/sources/${root.id}/inquiry`) reads++; });
  const dialogueReady = page.waitForResponse((response) => /^\/api\/dialogues\/[^/]+$/.test(new URL(response.url()).pathname) && response.status() === 200);
  const followUpReady = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${root.id}/follow-ups` && response.status() === 200);
  const weavingReady = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${root.id}/weaving` && response.status() === 200);
  await page.goto(`/sources/${root.id}/inquiry?item=${item.id}&version=${item.current.id}`);
  await Promise.all([dialogueReady, followUpReady, weavingReady]);
  // Bootstrap reconciles the initial inquiry, follow-up references, dialogue,
  // and first weaving snapshot. Wait for their resulting reads to settle before
  // attributing any later inquiry request to the disclosure interaction.
  await page.waitForLoadState("networkidle");
  const reading = page.locator(`#item-${item.id}`), body = reading.locator(".thought-body");
  await expect(body).toHaveText(item.current.text);
  await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const originalURL = page.url(), label = await reading.locator(".thought-title-text").textContent();
  const expand = reading.getByRole("button", { name: "Read full text", exact: true });
  await expect(expand).toBeVisible();
  await expand.focus(); const baseline = reads; await page.keyboard.press("Enter");
  const collapse = reading.getByRole("button", { name: "Show less", exact: true });
  await expect(collapse).toBeFocused();
  await expect(body).toHaveText(item.current.text);
  await expect.poll(() => body.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  expect(page.url()).toBe(originalURL); expect(reads).toBe(baseline);
  expect(await reading.locator(".thought-title-text").textContent()).toBe(label);
  await page.keyboard.press("Space"); await expect(expand).toBeFocused();
  await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(page.url()).toBe(originalURL); expect(reads).toBe(baseline);
});

test("saved discussion input expands in place without changing the target", async ({ page, request }) => {
  const { root } = await world(request);
  await page.goto(`/sources/${root.id}/inquiry`);
  const input = `  Fixture saved input ${"preserve the exact handoff ".repeat(35)}\nFinal input line.  `;
  await page.getByRole("textbox", { name: "Develop this thought", exact: true }).fill(input);
  const saved = page.waitForResponse((response) => /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send thought", exact: true }).click();
  expect([200, 201]).toContain((await saved).status());
  const exchange = page.getByRole("region", { name: "Latest exchange", exact: true });
  const card = exchange.locator(".exchange-input"), body = card.locator(".thought-body");
  await expect(body).toHaveText(input);
  await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const url = page.url();
  const expand = card.getByRole("button", { name: "Read full text", exact: true });
  await expect(expand).toBeVisible();
  await expand.focus(); await page.keyboard.press("Space");
  await expect(card.getByRole("button", { name: "Show less", exact: true })).toBeFocused();
  await expect(body).toHaveText(input);
  await expect.poll(() => body.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  expect(page.url()).toBe(url);
  await page.keyboard.press("Enter"); await expect(expand).toBeFocused();
});

test("a long relationship endpoint expands independently without changing its connection", async ({ page, request }) => {
  const meta = await (await control(request, "world")).json() as BrowserDialogueMetadata;
  if (!meta.item || !meta.relationship) throw new Error("Missing fixture connection");
  const created = await request.post(`${daemon}/sources/${meta.root.id}/dialogues`, { headers: { "idempotency-key": "disclosure-endpoint-dialogue" }, data: { selection: { kind: "source", id: meta.root.id } } });
  expect(created.status()).toBe(201); const dialogue = await created.json() as { id: string };
  const text = `Fixture corrected endpoint ${"the original handoff preserves intent ".repeat(30)}final connection words.`;
  const saved = await request.post(`${daemon}/dialogues/${dialogue.id}/turns`, { headers: { "idempotency-key": "disclosure-endpoint-input" }, data: { text } });
  expect(saved.status()).toBe(201); const turn = await saved.json() as { sourceId: string };
  const corrected = await request.post(`${daemon}/items/${meta.item.id}/correct`, { headers: { "idempotency-key": "disclosure-endpoint-correct" }, data: { expectedVersionId: meta.item.current.id, sourceId: turn.sourceId, text } });
  expect(corrected.status()).toBe(200);
  await page.goto(`/sources/${meta.root.id}/inquiry`);
  const connection = page.getByRole("region", { name: "Connections", exact: true }).locator(".connection-reading");
  const endpoint = connection.locator(".relationship-endpoint").filter({ hasText: text });
  const body = endpoint.locator(".thought-body"), other = connection.locator(".relationship-endpoint").filter({ hasNotText: text });
  await expect(body).toHaveText(text); await expect(other).toHaveCount(1);
  await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const url = page.url(), otherText = await other.textContent();
  await endpoint.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect.poll(() => body.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  await expect(body).toHaveText(text); expect(await other.textContent()).toBe(otherText); expect(page.url()).toBe(url);
  await endpoint.getByRole("button", { name: "Show less", exact: true }).click();
  await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
});

test("springboard original fetches full source on demand, retries failure and keeps its link independent", async ({ page, request }) => {
  await world(request);
  const text = `Fixture long original ${"careful original content ".repeat(30)}final original words.`;
  const saved = await request.post(`${daemon}/captures`, { headers: { "idempotency-key": "disclosure-long-source" }, data: { text, provenance: "fixture" } });
  expect(saved.status()).toBe(201); const source = await saved.json() as { id: string; text: string };
  expect(source.text).toBe(text);
  const thoughts = await batch(page), sample = thoughts.find((thought) => thought.kind === "source" && thought.id === source.id);
  if (!sample) throw new Error("Missing sampled original");
  expect(sample.excerpt.length).toBeLessThan(text.length);
  const link = card(page, sample), wrap = link.locator(".."); await expect(link).toBeVisible();
  const label = text.trim().split(/\s+/u).slice(0, 5).join(" ");
  await expect(link.locator(".thought-card-excerpt")).toHaveText(label);
  let requests = 0;
  let release = () => {}, entered = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  await page.route(`**/api/sources/${source.id}`, async (route) => {
    requests++;
    if (requests === 1) await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture unavailable"}' });
    else { entered(); await gate; await route.continue(); }
  });
  expect(requests).toBe(0);
  const expand = wrap.getByRole("button", { name: "Read full text", exact: true });
  await expect(expand).toBeVisible();
  expect(await expand.evaluate((element) => !!element.closest("a"))).toBe(false);
  await expand.click();
  await expect(wrap.getByText(/could not|unavailable|failed/i)).toBeVisible();
  await expect(wrap.getByText(text, { exact: true })).toHaveCount(0);
  try {
    await wrap.getByRole("button", { name: /retry/i }).click();
    await waiting;
    await expect(wrap.getByText(/loading/i)).toBeVisible();
  } finally { release(); }
  await expect(wrap.getByText(text, { exact: true })).toBeVisible();
  await expect(link.locator(".thought-card-excerpt")).toHaveText(label);
  expect(requests).toBe(2); expect(new URL(page.url()).pathname).toBe("/");
  await wrap.getByRole("button", { name: "Show less", exact: true }).click();
  await wrap.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect(wrap.getByText(text, { exact: true })).toBeVisible(); expect(requests).toBe(2);
  await link.click(); await expect(page).toHaveURL((url) => url.pathname === `/sources/${source.id}/inquiry`);
});

test("closing an unavailable springboard disclosure returns keyboard focus to its persistent trigger", async ({ page, request }) => {
  await world(request);
  const text = `Fixture unavailable original ${"read the entire original ".repeat(30)}final words.`;
  const saved = await request.post(`${daemon}/captures`, { headers: { "idempotency-key": "disclosure-error-focus" }, data: { text, provenance: "fixture" } });
  expect(saved.status()).toBe(201);
  const source = await saved.json() as { id: string };
  const thoughts = await batch(page), sample = thoughts.find((thought) => thought.kind === "source" && thought.id === source.id);
  if (!sample) throw new Error("Missing sampled original");
  const wrap = card(page, sample).locator("..");
  let reads = 0, inquiryReads = 0;
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path === `/api/sources/${source.id}`) reads++;
    if (path === `/api/sources/${source.id}/inquiry`) inquiryReads++;
  });
  await page.route(`**/api/sources/${source.id}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture unavailable"}' }));
  const url = page.url(), trigger = wrap.getByRole("button", { name: "Read full text", exact: true });
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(wrap.getByRole("alert")).toContainText(/unavailable/i);
  expect(reads).toBe(1);
  const collapse = wrap.getByRole("button", { name: "Show less", exact: true });
  const panelId = await collapse.getAttribute("aria-controls");
  if (!panelId) throw new Error("Disclosure has no controlled panel");
  const panel = page.locator(`[id=${JSON.stringify(panelId)}]`);
  await expect(panel).toBeVisible();
  await collapse.focus(); await page.keyboard.press("Space");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(panel).toBeHidden();
  expect(page.url()).toBe(url); expect(reads).toBe(1); expect(inquiryReads).toBe(0);
});

test("springboard fetches the represented historical item version, not its newer current version", async ({ page, request }) => {
  const { root } = await world(request);
  const item = await (await control(request, "seed-recent-reading", { longText: true })).json() as { id: string; current: { id: string; text: string } };
  const title = "A deliberately selected fixture title";
  const savedTitle = await request.post(`${daemon}/sources/${root.id}/title`, { headers: { "idempotency-key": "disclosure-item-title" }, data: { target: { kind: "item", itemId: item.id, versionId: item.current.id }, text: title, expectedTitleRevisionId: null } });
  expect(savedTitle.status()).toBe(200);
  const thoughts = await batch(page), sample = thoughts.find((thought) => thought.id === item.id);
  if (!sample || !sample.versionId) throw new Error("Missing sampled item version");
  expect(sample.versionId).toBe(item.current.id); expect(sample.excerpt.length).toBeLessThan(item.current.text.length);
  const link = card(page, sample), wrap = link.locator(".."); await expect(link).toBeVisible();
  await expect(link.locator(".thought-card-excerpt")).toHaveText(title);
  const revised = await (await control(request, "revise-recent-reading")).json() as { current: { id: string } };
  const url = `${daemon}/sources/${root.id}/inquiry?${new URLSearchParams({ itemId: item.id, versionId: item.current.id })}`;
  const exact = parseInquiryView(await (await request.get(url)).json());
  expect(exact?.selectedTarget).toMatchObject({ id: item.id, versionId: item.current.id, text: item.current.text });
  let intercepted = 0;
  const routePath = `**/api/sources/${root.id}/inquiry?*`;
  await page.route(routePath, async (route) => {
    intercepted++;
    if (intercepted !== 1) return route.continue();
    const response = await route.fetch();
    const view = await response.json();
    view.selectedTarget.versionId = revised.current.id;
    await route.fulfill({ response, json: view });
  });
  let reads = 0;
  const inspect = (req: import("@playwright/test").Request) => {
    const address = new URL(req.url());
    if (address.pathname === `/api/sources/${root.id}/inquiry`) {
      reads++; expect(address.searchParams.get("itemId")).toBe(item.id); expect(address.searchParams.get("versionId")).toBe(item.current.id);
    }
  };
  page.on("request", inspect);
  const expand = wrap.getByRole("button", { name: "Read full text", exact: true });
  await expect(expand).toBeVisible();
  await expand.focus(); await page.keyboard.press("Enter");
  await expect(wrap.getByRole("alert")).toContainText(/unavailable/i);
  await expect(wrap.getByText(item.current.text, { exact: true })).toHaveCount(0);
  await wrap.getByRole("button", { name: /retry/i }).click();
  await expect(wrap.getByText(item.current.text, { exact: true })).toBeVisible();
  await expect(wrap).toContainText(title);
  await expect(wrap).not.toContainText("Fixture later formulation must not replace the sampled version.");
  expect(reads).toBe(2); expect(new URL(page.url()).pathname).toBe("/");
  await page.keyboard.press("Space"); await page.keyboard.press("Enter");
  await expect(wrap.getByText(item.current.text, { exact: true })).toBeVisible(); expect(reads).toBe(2);
  page.off("request", inspect);
  await page.unroute(routePath);
  await link.click(); await expect(page).toHaveURL((address) => address.pathname === `/sources/${root.id}/inquiry` && address.searchParams.get("item") === item.id && address.searchParams.get("version") === item.current.id);
});
