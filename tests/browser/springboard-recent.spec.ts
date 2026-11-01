import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { parseInquiryView, parseRecentThoughts, type RecentThought } from "../../packages/contracts/src";
import { dialogueExample as example } from "../fixtures/dialogue-content";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data }); expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext): Promise<BrowserDialogueMetadata> {
  return await (await control(request, "world", { empty: true })).json() as BrowserDialogueMetadata;
}
async function recent(request: APIRequestContext) {
  const response = await request.get(`${daemon}/springboard/recent?limit=2`); expect(response.status()).toBe(200);
  const parsed = parseRecentThoughts(await response.json()); if (!parsed) throw new Error("Invalid recent fixture data"); return parsed.items;
}
function card(page: Page, thought: RecentThought) { return page.getByRole("link").filter({ hasText: thought.excerpt }); }
function editor(page: Page) { return page.getByRole("textbox", { name: "Your thought", exact: true }); }
const target = (page: Page) => page.getByRole("region", { name: "Discussion target", exact: true });
test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("empty recent collection omits the group and capture still saves", async ({ page, request }) => {
  await control(request, "empty-collection");
  expect(await recent(request)).toEqual([]);
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/springboard");
  await page.goto("/"); expect((await loaded).status()).toBe(200);
  await expect(page.getByRole("region", { name: "Thoughts", exact: true })).toHaveCount(0);
  const draft = "Fixture original from an empty collection.";
  await editor(page).fill(draft);
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/captures" && response.request().method() === "POST");
  await page.getByRole("button", { name: /^save(?: original)?$/i }).click();
  const response = await saved; expect(response.status()).toBe(201);
  const source = await response.json() as { id: string; text: string }; expect(source.text).toBe(draft);
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${source.id}`);
  await expect(page.getByRole("article", { name: "Original thought", exact: true })).toHaveText(draft);
});

test("recent read retry preserves a draft and the recovered batch stays stable", async ({ page, request }) => {
  await world(request); const sampled = await recent(request); expect(sampled).toHaveLength(2);
  let count = 0, retryInitiated = false, entered = () => {}, release = () => {}, finished = () => {};
  const waiting = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }), done = new Promise<void>((resolve) => { finished = resolve; });
  let held = false;
  await page.route("**/api/springboard", async (route) => {
    count++;
    if (!retryInitiated) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture read unavailable" }) });
    held = true;
    try { const response = await route.fetch(); expect(response.status()).toBe(200); entered(); await gate; await route.fulfill({ response }); }
    finally { finished(); }
  });
  try {
    await page.goto("/");
    const group = page.getByRole("region", { name: "Thoughts", exact: true });
    const retry = group.getByRole("button", { name: /retry/i });
    await expect(retry).toBeVisible(); await expect(editor(page)).toBeVisible();
    await editor(page).fill("Draft survives retry");
    await expect(page.getByRole("button", { name: /^save(?: original)?$/i })).toBeEnabled();
    await editor(page).fill(""); const initialReads = count; retryInitiated = true; await retry.click(); await waiting;
    await editor(page).fill("Draft survives retry");
    release(); await done;
    await expect(editor(page)).toHaveValue("Draft survives retry");
    await expect(page.getByRole("button", { name: /^save(?: original)?$/i })).toBeEnabled();
    for (const thought of sampled) await expect(card(page, thought)).toBeHidden();
    await editor(page).fill(""); await expect(editor(page)).toBeFocused();
    for (const thought of sampled) await expect(card(page, thought)).toBeVisible();
    const hrefs = await Promise.all(sampled.map((thought) => card(page, thought).getAttribute("href")));
    await control(request, "capture-abandon");
    for (let n = 0; n < sampled.length; n++) expect(await card(page, sampled[n]).getAttribute("href")).toBe(hrefs[n]);
    expect(count).toBe(initialReads + 1);
  } finally { release(); if (held) await done; await page.unroute("**/api/springboard"); }
});

test("recent original cards stay stable through focus, typing, paste, clear and an unconfirmed save", async ({ page, request, context }) => {
  await world(request);
  const sampled = await recent(request); expect(sampled).toHaveLength(2);
  expect(sampled.every((entry) => entry.kind === "source" && entry.author === "user")).toBe(true);
  await page.goto("/");
  for (const thought of sampled) {
    await expect(card(page, thought)).toBeVisible();
    await expect(card(page, thought).locator(".flow-arrow, svg marker, svg [marker-end]")).toHaveCount(0);
  }
  const links = await Promise.all(sampled.map((thought) => card(page, thought).getAttribute("href")));
  await editor(page).focus();
  for (const thought of sampled) await expect(card(page, thought)).toBeVisible();
  await control(request, "capture-abandon"); // A new eligible capture must not replace this visit's batch.
  for (let n = 0; n < sampled.length; n++) expect(await card(page, sampled[n]).getAttribute("href")).toBe(links[n]);
  await editor(page).fill("A temporary input");
  for (const thought of sampled) await expect(card(page, thought)).toBeHidden();
  await editor(page).fill(""); await expect(editor(page)).toBeFocused();
  for (let n = 0; n < sampled.length; n++) { await expect(card(page, sampled[n])).toBeVisible(); expect(await card(page, sampled[n]).getAttribute("href")).toBe(links[n]); }
  await editor(page).focus();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("Pasted fixture draft"));
  await page.keyboard.press("Control+V"); await expect(editor(page)).toHaveValue("Pasted fixture draft");
  for (const thought of sampled) await expect(card(page, thought)).toBeHidden();
  await page.route("**/api/captures", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture acknowledgement unavailable" }) }));
  await page.getByRole("button", { name: /^save(?: original)?$/i }).click();
  await expect(page.locator(".capture-form").getByRole("alert")).toBeVisible(); await expect(editor(page)).toHaveValue("Pasted fixture draft");
  for (const thought of sampled) await expect(card(page, thought)).toBeHidden();
  await page.unroute("**/api/captures");
  let entered = () => {}, release = () => {}, finished = () => {};
  const waiting = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }), done = new Promise<void>((resolve) => { finished = resolve; });
  let held = false;
  await page.route("**/api/captures", async (route) => {
    held = true;
    try { const response = await route.fetch(); expect([200, 201]).toContain(response.status()); entered(); await gate; await route.fulfill({ response }); }
    finally { finished(); }
  });
  try {
    await page.getByRole("button", { name: /^(retry save|save original|save)$/i }).click(); await waiting;
    for (const thought of sampled) await expect(card(page, thought)).toBeHidden();
    release(); await done;
    await expect(page).toHaveURL(/\/sources\/[A-Za-z0-9-]+$/);
  } finally { release(); if (held) await done; await page.unroute("**/api/captures"); }
});

test("recent original card is a real link into the unchanged original discussion", async ({ page, request }) => {
  await world(request); const sampled = await recent(request), source = sampled.find((entry) => entry.kind === "source");
  if (!source) throw new Error("Expected source fixture card");
  await page.goto("/"); const link = card(page, source); await expect(link).toBeVisible();
  await link.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${source.sourceId}/inquiry`);
  await expect(target(page)).toBeVisible(); await expect(target(page)).toContainText(source.excerpt);
  await expect(target(page)).toBeFocused();
});

test("sampled AI interpretation beyond the normal window opens its exact older version after revision", async ({ page, request }) => {
  const { root } = await world(request);
  const item = await (await control(request, "seed-recent-reading", { outsideWindow: true })).json() as { id: string; current: { id: string; text: string } };
  const sample = (await recent(request)).find((entry) => entry.id === item.id);
  expect(sample).toMatchObject({ kind: "interpretation", author: "ai", sourceId: root.id, versionId: item.current.id, excerpt: item.current.text });
  if (!sample) throw new Error("Expected sampled interpretation");
  const ordinary = parseInquiryView(await (await request.get(`${daemon}/sources/${root.id}/inquiry`)).json());
  expect(ordinary?.items.some((entry) => entry.id === item.id)).toBe(false);
  await page.goto("/"); const link = card(page, sample); await expect(link).toBeVisible();
  await expect(link.getByText(/AI interpretation/i)).toBeVisible();
  await control(request, "revise-recent-reading");
  const targeted = await request.get(`${daemon}/sources/${root.id}/inquiry?itemId=${item.id}&versionId=${item.current.id}`); expect(targeted.status()).toBe(200);
  const view = parseInquiryView(await targeted.json()); expect(view?.selectedTarget).toMatchObject({ id: item.id, versionId: item.current.id, text: item.current.text });
  await expect(link).toBeVisible();
  await link.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${root.id}/inquiry` && url.searchParams.get("item") === item.id && url.searchParams.get("version") === item.current.id);
  await expect(target(page)).toContainText(item.current.text);
  await expect(target(page)).not.toContainText("Fixture later formulation must not replace the sampled version.");
  await expect(target(page)).toBeFocused();
});

test("recent user-corrected interpretation retains its actual author", async ({ page, request }) => {
  await world(request);
  const item = await (await control(request, "seed-recent-reading", { userAuthored: true })).json() as { id: string; current: { id: string; text: string } };
  const sample = (await recent(request)).find((entry) => entry.id === item.id);
  expect(sample).toMatchObject({ kind: "interpretation", author: "user", versionId: item.current.id });
  if (!sample) throw new Error("Expected user-authored sample");
  await page.goto("/"); const link = card(page, sample); await expect(link).toBeVisible();
  await expect(link.getByText(/written by you|your (?:reading|formulation|thought)/i)).toBeVisible();
});

test("long recent reading uses an accessible bounded excerpt and retains full formulation on open", async ({ page, request }) => {
  const { root } = await world(request);
  const item = await (await control(request, "seed-recent-reading", { longText: true })).json() as { id: string; current: { id: string; text: string } };
  const sample = (await recent(request)).find((entry) => entry.id === item.id);
  if (!sample) throw new Error("Expected long fixture reading");
  expect(sample.excerpt.length).toBeLessThan(item.current.text.length);
  expect(item.current.text.startsWith(sample.excerpt)).toBe(true);
  await page.goto("/"); const link = card(page, sample); await expect(link).toBeVisible();
  await expect(link).toHaveAccessibleName(new RegExp(sample.excerpt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await link.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${root.id}/inquiry` && url.searchParams.get("item") === item.id && url.searchParams.get("version") === item.current.id);
  await expect(target(page)).toContainText(item.current.text);
});

test("a recent developing idea links to its own exact discussion target", async ({ page, request }) => {
  const { root } = await world(request);
  const opened = await request.post(`${daemon}/sources/${root.id}/dialogues`, { headers: { "idempotency-key": "springboard-idea-context" }, data: { selection: { kind: "source", id: root.id } } });
  const dialogue = await opened.json() as { id: string }; expect(opened.status()).toBe(201);
  const saved = await request.post(`${daemon}/dialogues/${dialogue.id}/turns`, { headers: { "idempotency-key": "springboard-idea-turn" }, data: { text: example.thought } }); expect(saved.status()).toBe(201);
  await control(request, "start"); await control(request, "write-idea");
  const sample = (await recent(request)).find((entry) => entry.kind === "developing-idea");
  expect(sample).toMatchObject({ author: "ai", sourceId: root.id, excerpt: example.idea });
  if (!sample || !sample.versionId) throw new Error("Expected recent developing idea");
  await page.goto("/"); const link = card(page, sample); await expect(link).toBeVisible();
  await expect(link.getByText(/AI developing idea/i)).toBeVisible();
  await link.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${root.id}/inquiry` && url.searchParams.get("item") === sample.id && url.searchParams.get("version") === sample.versionId);
  await expect(target(page)).toContainText(sample.excerpt); await expect(target(page)).toBeFocused();
});

test("invalid sampled target shows an explicit unavailable state, not the original discussion", async ({ page, request }) => {
  const { root } = await world(request);
  const response = await request.get(`${daemon}/sources/${root.id}/inquiry?itemId=missing-item&versionId=missing-version`); expect(response.status()).toBe(404);
  await page.goto(`/sources/${root.id}/inquiry?item=missing-item&version=missing-version`);
  await expect(page.getByText(/(selected|sampled|reading|thought).*(unavailable|no longer available|not found)/i)).toBeVisible();
  await expect(target(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /back|return|capture/i }).first()).toBeVisible();
});
