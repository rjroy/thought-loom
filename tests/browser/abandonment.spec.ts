import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { parseDialogueTurnReceipt, parseDialogueView, parseFollowUpStatusView, parseWeavingStatusView } from "../../packages/contracts/src";
import { dialogueExample as example } from "../fixtures/dialogue-content";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
const composer = (page: Page) => page.getByRole("textbox", { name: "Develop this thought", exact: true });
const progress = (page: Page) => page.getByRole("region", { name: "Dialogue status", exact: true });
async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data }); expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext, options: object): Promise<BrowserDialogueMetadata> {
  return await (await control(request, "world", options)).json() as BrowserDialogueMetadata;
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  const saved = page.waitForResponse((response) => /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send thought", exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201);
  const turn = parseDialogueTurnReceipt(await response.json()); if (!turn) throw new Error("Invalid fixture turn receipt"); return turn;
}
async function current(request: APIRequestContext, id: string) {
  const response = await request.get(`${daemon}/dialogues/${id}`); expect(response.status()).toBe(200);
  const view = parseDialogueView(await response.json()); if (!view) throw new Error("Invalid dialogue view"); return view;
}
test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("abandoned capture shows local status without claiming native settlement", async ({ page, request }) => {
  await world(request, { scenario: "uncertain" });
  const source = await (await control(request, "capture-abandon")).json() as { id: string; text: string };
  await control(request, "start");
  const result = await (await request.get(`${daemon}/sources/${source.id}/weaving`)).json();
  expect(parseWeavingStatusView(result)?.job.status).toBe("uncertain");
  await control(request, "abandon");
  const after = await (await request.get(`${daemon}/sources/${source.id}/weaving`)).json();
  expect(parseWeavingStatusView(after)).toMatchObject({ job: { status: "abandoned" }, actions: { retry: false } });
  await page.goto(`/sources/${source.id}/inquiry`);
  const panel = page.getByRole("region", { name: "Weaving status", exact: true });
  await expect(panel.getByText(/abandoned locally/i)).toBeVisible();
  await expect(panel.getByText(/native.*(unconfirmed|unknown|may.*continu)/i)).toBeVisible();
  await expect(panel.getByRole("button", { name: /retry/i })).toHaveCount(0);
  const original = page.getByRole("region", { name: "Original source", exact: true });
  await original.getByRole("button", { name: "Read full original", exact: true }).click();
  const fullOriginal = original.getByRole("article", { name: "Original thought", exact: true });
  await expect(fullOriginal).toBeVisible(); await expect(fullOriginal).toHaveText(source.text);
});

test("abandoned discussion preserves its input and idea while an older preview read cannot revive it", async ({ page, request }) => {
  const { root } = await world(request, { scenario: "uncertain", empty: true });
  await page.goto(`/sources/${root.id}/inquiry#development`);
  const turn = await send(page, example.thought);
  await control(request, "start"); await control(request, "write-idea");
  await control(request, "preview", { start: true, text: "Fixture transient preview" });
  await expect(page.getByRole("article", { name: "Agent response", exact: true })).toContainText("Fixture transient preview");
  const observed = (await current(request, turn.dialogueId)).turns[0];
  expect(observed).toMatchObject({ status: "uncertain", changes: [expect.objectContaining({ kind: "developing-idea" })] });
  const idea = observed?.changes.find((change) => change.kind === "developing-idea");
  if (!idea) throw new Error("Expected recorded fixture idea");
  let captured = () => {}, release = () => {}, finished = () => {};
  const ready = new Promise<void>((resolve) => { captured = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }), done = new Promise<void>((resolve) => { finished = resolve; });
  let held = false;
  const path = `**/api/dialogues/${turn.dialogueId}`;
  await page.route(path, async (route) => {
    if (held || route.request().method() !== "GET") return route.continue();
    held = true;
    try { const response = await route.fetch(); expect(response.status()).toBe(200); captured(); await gate; await route.fulfill({ response }); }
    finally { finished(); }
  });
  try {
    await progress(page).getByRole("button", { name: "Check status", exact: true }).click(); await ready;
    await control(request, "abandon");
    expect((await current(request, turn.dialogueId)).turns[0]).toMatchObject({ status: "abandoned", actions: { stop: { eligible: false }, retry: false } });
    await progress(page).getByRole("button", { name: "Check status", exact: true }).click();
    await expect(progress(page).getByText(/abandoned locally/i)).toBeVisible();
    await expect(progress(page).getByText(/native.*(unconfirmed|unknown|may.*continu)/i)).toBeVisible();
    release(); await done;
    await expect(progress(page).getByText(/abandoned locally/i)).toBeVisible();
    await expect(progress(page).getByRole("button", { name: /stop response|retry/i })).toHaveCount(0);
    await expect(page.getByRole("article", { name: "Agent response", exact: true })).not.toContainText("Fixture transient preview");
    await expect(page.getByRole("region", { name: "Latest exchange", exact: true }).getByText(example.thought, { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Developed here", exact: true }).getByText(example.idea, { exact: true })).toBeVisible();
    // Once another context is selected, the abandoned historical dialogue is
    // not an active sibling to poll. Current-context polling is unaffected.
    await page.locator(`#item-${idea.id}`).getByRole("button", { name: "Discuss this reading", exact: true }).click();
    let olderReads = 0;
    const count = (request: import("@playwright/test").Request) => { if (new URL(request.url()).pathname === `/api/dialogues/${turn.dialogueId}` && request.method() === "GET") olderReads++; };
    page.on("request", count);
    try { await page.waitForTimeout(2_500); expect(olderReads).toBe(0); }
    finally { page.off("request", count); }
  } finally { release(); if (held) await done; await page.unroute(path); }
});

test("a later exchange retains the abandoned discussion in history with honest status", async ({ page, request }) => {
  const { root } = await world(request, { scenario: "uncertain", empty: true });
  await page.goto(`/sources/${root.id}/inquiry#development`);
  const first = await send(page, example.thought); await control(request, "start"); await control(request, "write-idea"); await control(request, "abandon");
  const saved = await request.post(`${daemon}/dialogues/${first.dialogueId}/turns`, { headers: { "idempotency-key": "fixture-after-abandon" }, data: { text: example.secondThought } });
  expect(saved.status()).toBe(201);
  await control(request, "start"); await control(request, "advance", { outcome: "succeeded", text: example.reply });
  const view = await current(request, first.dialogueId);
  expect(view.turns.map((turn) => turn.status)).toEqual(["abandoned", "completed"]);
  await page.reload();
  await page.getByRole("button", { name: /earlier exchanges/i }).click();
  const old = page.locator(`#turn-${first.id}`);
  await expect(old.getByText(/abandoned locally/i)).toBeVisible();
  await expect(old.getByText(/native.*(unconfirmed|unknown|may.*continu)/i)).toBeVisible();
  await expect(old.getByText(example.thought, { exact: true })).toBeVisible();
  await expect(old.getByRole("button", { name: /stop response|retry/i })).toHaveCount(0);
});

test("abandoned follow-up remains inspectable without retry or a native cancellation claim", async ({ page, request }) => {
  const { root } = await world(request, { followUp: true });
  await page.goto(`/sources/${root.id}/inquiry#development`);
  await send(page, example.thought); await control(request, "start"); await control(request, "write-idea"); await control(request, "advance", { outcome: "succeeded", text: example.reply });
  await control(request, "configure-follow-up", { uncertain: true }); await control(request, "start"); await control(request, "write-follow-up");
  await control(request, "abandon");
  const raw = await (await request.get(`${daemon}/sources/${root.id}/follow-ups`)).json();
  const view = parseFollowUpStatusView(raw); expect(view?.jobs[0]).toMatchObject({ status: "abandoned", actions: { retry: false }, changes: [expect.objectContaining({ kind: "interpretation" })] });
  const panel = page.getByRole("region", { name: "Background follow-up", exact: true });
  await expect(panel.getByText(/abandoned locally/i)).toBeVisible();
  await expect(panel.getByText(/native.*(unconfirmed|unknown|may.*continu)/i)).toBeVisible();
  await expect(panel.getByRole("button", { name: /retry/i })).toHaveCount(0);
  await expect(page.getByText(example.thought, { exact: true })).toBeVisible();
});
