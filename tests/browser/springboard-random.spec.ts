import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { parseDialogueTurnReceipt, parseDialogueView, parseInquiryView, parseSpringboardView, type SpringboardThought } from "../../packages/contracts/src";
import { dialogueExample as example } from "../fixtures/dialogue-content";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";
import { inquiryHref } from "../../apps/web/lib/links";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data }); expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext): Promise<BrowserDialogueMetadata> { return await (await control(request, "world", { empty: true })).json() as BrowserDialogueMetadata; }
async function daemonBatch(request: APIRequestContext) {
  const response = await request.get(`${daemon}/springboard?recent=2&random=2`); expect(response.status()).toBe(200);
  const view = parseSpringboardView(await response.json()); if (!view) throw new Error("Invalid combined daemon batch"); return view.items;
}
async function openWithActualBatch(page: Page, request: APIRequestContext) {
  // The separate probe proves the missing BFF as an HTTP failure rather than a
  // wait timeout. Only the subsequent actual browser response selects cards.
  expect((await request.get("/api/springboard")).status()).toBe(200);
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/springboard" && response.status() === 200);
  await page.goto("/");
  const view = parseSpringboardView(await (await loaded).json()); if (!view) throw new Error("Invalid browser batch"); return view.items;
}
function card(page: Page, thought: SpringboardThought) {
  const href = thought.kind === "source" ? `${inquiryHref(thought.sourceId)}#discussion-target` : inquiryHref(thought.sourceId, "", thought.id, thought.versionId);
  return page.locator(`a.thought-card[href=${JSON.stringify(href)}]`);
}
const editor = (page: Page) => page.getByRole("textbox", { name: "Your thought", exact: true });
const target = (page: Page) => page.getByRole("region", { name: "Discussion target", exact: true });
test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("combined recent and legacy random cards remain one stable batch and open the sampled old formulation", async ({ page, request, context }) => {
  const { root } = await world(request);
  await control(request, "seed-legacy-random");
  const backend = await daemonBatch(request); expect(backend).toHaveLength(4);
  expect(backend.filter((entry) => entry.selection === "recent")).toHaveLength(2);
  expect(backend.filter((entry) => entry.selection === "random").map((entry) => entry.id).sort()).toEqual(["legacy-random-ai", "legacy-random-user"]);
  const items = await openWithActualBatch(page, request); expect(items).toHaveLength(4);
  expect(items.map((entry) => entry.selection)).toEqual(["recent", "recent", "random", "random"]);
  expect(new Set(items.map((entry) => `${entry.kind === "source" ? "source" : "item"}:${entry.id}`)).size).toBe(4);
  const ai = items.find((entry) => entry.id === "legacy-random-ai"), user = items.find((entry) => entry.id === "legacy-random-user");
  expect(ai).toMatchObject({ selection: "random", kind: "interpretation", author: "ai", createdAt: null, versionId: "legacy-random-ai-v1" });
  expect(user).toMatchObject({ selection: "random", kind: "interpretation", author: "user", createdAt: null });
  if (!ai || !user || !ai.versionId) throw new Error("Missing legacy fixture samples");
  const group = page.getByRole("region", { name: /thoughts/i }); await expect(group).toHaveCount(1);
  await expect(group.getByRole("link")).toHaveCount(4);
  for (const thought of items) { await expect(card(page, thought)).toBeVisible(); await expect(card(page, thought).getByText(thought.selection === "recent" ? "Recent" : "Random", { exact: true })).toBeVisible(); }
  await expect(card(page, ai).getByText(/AI interpretation/i)).toBeVisible();
  await expect(card(page, user).getByText(/your (?:reading|formulation|thought)|written by you/i)).toBeVisible();
  const hrefs = await Promise.all(items.map((thought) => card(page, thought).getAttribute("href")));
  let reads = 0;
  const onRequest = (value: import("@playwright/test").Request) => { if (new URL(value.url()).pathname === "/api/springboard") reads++; };
  page.on("request", onRequest);
  try {
    await editor(page).focus(); for (const thought of items) await expect(card(page, thought)).toBeVisible();
    await editor(page).fill("Temporary fixture draft"); for (const thought of items) await expect(card(page, thought)).toBeHidden();
    await editor(page).fill(""); await expect(editor(page)).toBeFocused();
    for (let n = 0; n < items.length; n++) { await expect(card(page, items[n])).toBeVisible(); expect(await card(page, items[n]).getAttribute("href")).toBe(hrefs[n]); }
    await context.grantPermissions(["clipboard-read", "clipboard-write"]); await page.evaluate(() => navigator.clipboard.writeText("Pasted random fixture"));
    await page.keyboard.press("Control+V"); await expect(editor(page)).toHaveValue("Pasted random fixture");
    for (const thought of items) await expect(card(page, thought)).toBeHidden();
    await editor(page).fill(""); await expect(editor(page)).toBeFocused();
    await control(request, "revise-legacy-random");
    const targeted = await request.get(`${daemon}/sources/${root.id}/inquiry?itemId=${ai.id}&versionId=${ai.versionId}`); expect(targeted.status()).toBe(200);
    expect(parseInquiryView(await targeted.json())?.selectedTarget).toMatchObject({ id: ai.id, versionId: ai.versionId, text: ai.excerpt });
    await page.waitForTimeout(1_250); expect(reads).toBe(0);
    for (let n = 0; n < items.length; n++) expect(await card(page, items[n]).getAttribute("href")).toBe(hrefs[n]);
    await card(page, ai).focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL((url) => url.pathname === `/sources/${root.id}/inquiry` && url.searchParams.get("item") === ai.id && url.searchParams.get("version") === ai.versionId);
    await expect(target(page)).toContainText(ai.excerpt);
    await expect(target(page)).not.toContainText("Later legacy revision must not replace sampled formulation.");
    await expect(target(page)).toBeFocused();
  } finally { page.off("request", onRequest); }
});

test("random original link opens its unchanged source discussion", async ({ page, request }) => {
  const { root } = await world(request);
  await control(request, "seed-recent-reading");
  const opened = await request.post(`${daemon}/sources/${root.id}/dialogues`, { headers: { "idempotency-key": "random-source-context" }, data: { selection: { kind: "source", id: root.id } } });
  expect(opened.status()).toBe(201); const dialogue = parseDialogueView(await opened.json()); if (!dialogue) throw new Error("Invalid fixture dialogue");
  const saved = await request.post(`${daemon}/dialogues/${dialogue.id}/turns`, { headers: { "idempotency-key": "random-source-turn" }, data: { text: example.thought } });
  expect(saved.status()).toBe(201); if (!parseDialogueTurnReceipt(await saved.json())) throw new Error("Invalid fixture turn");
  await control(request, "start"); await control(request, "write-idea");
  const backend = await daemonBatch(request); expect(backend).toHaveLength(4);
  const random = backend.filter((entry) => entry.selection === "random");
  expect(random).toHaveLength(2); expect(random.every((entry) => entry.kind === "source")).toBe(true);
  const items = await openWithActualBatch(page, request), source = items.find((entry) => entry.selection === "random" && entry.kind === "source");
  if (!source) throw new Error("Expected random original");
  await expect(card(page, source)).toBeVisible(); await expect(card(page, source).getByText("Random", { exact: true })).toBeVisible();
  await card(page, source).focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${source.sourceId}/inquiry`);
  await expect(target(page)).toContainText(source.excerpt); await expect(target(page)).toBeFocused();
});

test("scarce combined batch shows the available recent cards without random duplicates", async ({ page, request }) => {
  await world(request); const backend = await daemonBatch(request);
  expect(backend).toHaveLength(2); expect(backend.every((entry) => entry.selection === "recent")).toBe(true);
  const items = await openWithActualBatch(page, request); expect(items).toHaveLength(2);
  expect(items.every((entry) => entry.selection === "recent")).toBe(true);
  const group = page.getByRole("region", { name: /thoughts/i }); await expect(group).toHaveCount(1); await expect(group.getByRole("link")).toHaveCount(2);
  for (const thought of items) await expect(card(page, thought)).toBeVisible();
});
