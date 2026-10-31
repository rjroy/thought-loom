import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { parseDialogueView, parseDialogueTurnReceipt, type DialogueView, type DialogueTurnReceipt, type InquiryView } from "../../packages/contracts/src";
import { dialogueExample as example, type BrowserDialogueScenario } from "../fixtures/dialogue-content";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemonURL = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
const composer = (page: Page) => page.getByRole("textbox", { name: "Develop this thought", exact: true });
const target = (page: Page) => page.getByRole("region", { name: "Discussion target", exact: true });
const progress = (page: Page) => page.getByRole("region", { name: "Dialogue status", exact: true });
const latest = (page: Page) => page.getByRole("region", { name: "Latest exchange", exact: true });
const developed = (page: Page) => page.getByRole("region", { name: "Developed here", exact: true });
const reading = (page: Page, id: string) => page.locator(`#item-${id}`);

async function control(request: APIRequestContext, action: string, data: object = {}) {
  const response = await request.post(`${daemonURL}/__browser/dialogue/${action}`, { data });
  expect(response.status()).toBe(200);
  return response;
}
async function world(request: APIRequestContext, empty = false, scenario: BrowserDialogueScenario = "available"): Promise<BrowserDialogueMetadata> {
  return await (await control(request, "world", { empty, scenario })).json() as BrowserDialogueMetadata;
}
async function dialogue(request: APIRequestContext, id: string): Promise<DialogueView> {
  const response = await request.get(`${daemonURL}/dialogues/${id}`);
  expect(response.status()).toBe(200);
  const parsed = parseDialogueView(await response.json());
  expect(parsed).not.toBeNull(); return parsed!;
}
async function inquiry(request: APIRequestContext, sourceId: string): Promise<InquiryView> {
  const response = await request.get(`${daemonURL}/sources/${sourceId}/inquiry`);
  expect(response.status()).toBe(200); return await response.json() as InquiryView;
}
async function metrics(request: APIRequestContext) {
  const response = await request.get(`${daemonURL}/__browser/dialogue/metrics`);
  expect(response.status()).toBe(200);
  return await response.json() as { sources: number; jobs: number; dialogues: number; turns: number; admissions: Array<{ runId: string; sessionId: string; jobId: string }>; stopCalls: string[]; activeGrants: number };
}
async function send(page: Page, text: string): Promise<DialogueTurnReceipt> {
  await composer(page).fill(text);
  const saved = page.waitForResponse((response) => /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await page.getByRole("button", { name: /^(Send thought|Retry send)$/ }).click();
  const response = await saved;
  expect([200, 201]).toContain(response.status());
  const receipt = parseDialogueTurnReceipt(await response.json());
  expect(receipt).not.toBeNull(); return receipt!;
}
async function complete(request: APIRequestContext, text: string = example.reply, idea = false) {
  await control(request, "advance", { outcome: "succeeded", text, idea });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function stop(page: Page, request: APIRequestContext, receipt: DialogueTurnReceipt) {
  const before = await dialogue(request, receipt.dialogueId), turn = before.turns.find((entry) => entry.id === receipt.id)!;
  expect(turn.actions?.stop.eligible).toBe(true);
  const stopped = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/dialogues/${receipt.dialogueId}/turns/${receipt.id}/stop` && response.request().method() === "POST");
  await progress(page).getByRole("button", { name: "Stop response", exact: true }).click();
  const response = await stopped;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON()).toEqual({ expectedRunId: turn.actions!.stop.expectedRunId });
  expect(response.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
}

test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("an unannotated original can develop through a saved challenge into a persistent attributed idea", async ({ page, request }) => {
  const { root } = await world(request, true);
  await page.goto(`/sources/${root.id}/inquiry?q=coordination#development`);
  await expect(page.getByRole("heading", { name: "Explore this thought", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Interpretations", exact: true }).getByText("No interpretations recorded yet.", { exact: true })).toBeVisible();
  // Intended first RED: the real phase-3 inquiry renders, but has no composer.
  await expect(composer(page)).toBeVisible();
  await expect(target(page).getByText(root.text, { exact: true })).toBeVisible();
  const before = await metrics(request), turn = await send(page, example.thought);
  await expect(page).toHaveURL(new RegExp(`/sources/${root.id}/inquiry\\?[^#]*dialogue=${turn.dialogueId}[^#]*#development$`));
  expect(new URL(page.url()).searchParams.get("q")).toBe("coordination");
  await expect(latest(page).getByText("Your thought saved", { exact: true })).toBeVisible();
  await expect(progress(page).getByRole("heading", { name: "Waiting for agent", exact: true })).toBeVisible();
  const retained = await request.get(`${daemonURL}/sources/${turn.sourceId}`);
  expect(await retained.json()).toMatchObject({ text: example.thought, origin: { kind: "discussion-turn", dialogueId: turn.dialogueId, turnId: turn.id, rootSourceId: root.id } });
  expect((await metrics(request)).admissions).toHaveLength(0);
  await control(request, "start");
  await expect(progress(page).getByRole("heading", { name: "Agent responding", exact: true })).toBeVisible();
  await complete(request, example.reply, true);
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await expect(latest(page).getByRole("article", { name: "Agent response", exact: true })).toHaveText(example.reply);
  await expect(developed(page).getByText(example.idea, { exact: true })).toBeVisible();
  await expect(developed(page).getByText("AI developing idea", { exact: true })).toBeVisible();
  await expect(developed(page).getByText("Tentative", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Keep( this)?( idea)?$/i })).toHaveCount(0);
  const view = await dialogue(request, turn.dialogueId), item = (await inquiry(request, root.id)).items.find((entry) => entry.current.text === example.idea)!;
  expect(view.turns[0]?.changes).toContainEqual({ kind: "developing-idea", id: item.id, versionId: item.current.id });
  expect(item.derivation).toMatchObject({ dialogueId: turn.dialogueId, turnId: turn.id, turnSourceId: turn.sourceId });
  const ideaLink = developed(page).getByRole("link", { name: "Open developing idea", exact: true });
  const ideaURL = new URL((await ideaLink.getAttribute("href"))!, page.url());
  expect(ideaURL.searchParams.get("item")).toBe(item.id);
  await ideaLink.click();
  const currentIdea = reading(page, item.id).locator(":scope > .current-formulation");
  await expect(currentIdea).toHaveText(example.idea);
  await expect(currentIdea).toBeVisible();
  const derivationLink = reading(page, item.id).getByRole("link", { name: "From this discussion", exact: true });
  expect(new URL((await derivationLink.getAttribute("href"))!, page.url()).searchParams.get("dialogue")).toBe(turn.dialogueId);
  await derivationLink.click();
  await expect(latest(page).getByText(example.thought, { exact: true })).toBeVisible();
  const after = await metrics(request);
  expect(after.sources).toBe(before.sources + 1); expect(after.turns).toBe(1); expect(after.admissions).toHaveLength(1);
  expect(after.activeGrants).toBe(0);
  await noOverflow(page);
});

test("source, reading and directed connection targets keep drafts and pin their selected revisions", async ({ page, request }) => {
  const meta = await world(request);
  await page.goto(`/sources/${meta.root.id}/inquiry?q=coordination#development`);
  await composer(page).fill(example.draftOriginal);
  await reading(page, meta.item!.id).getByRole("button", { name: "Discuss this reading", exact: true }).click();
  await expect(target(page).getByText(example.reading, { exact: true })).toBeVisible();
  await composer(page).fill(example.draftReading);
  const connection = page.getByRole("region", { name: "Connections", exact: true }).getByRole("article").filter({ hasText: example.rationale });
  await connection.getByRole("button", { name: "Discuss this connection", exact: true }).click();
  await expect(target(page).getByText(example.rationale, { exact: true })).toBeVisible();
  await expect(target(page).getByText(example.reading, { exact: true })).toBeVisible();
  await expect(target(page).getByText(example.neighbor, { exact: true })).toBeVisible();
  await composer(page).fill(example.draftConnection);
  await reading(page, meta.item!.id).getByRole("button", { name: "Discuss this reading", exact: true }).click();
  await expect(composer(page)).toHaveValue(example.draftReading);
  await page.getByRole("region", { name: "Original source", exact: true }).getByRole("button", { name: "Discuss original", exact: true }).click();
  await expect(composer(page)).toHaveValue(example.draftOriginal);
  await reading(page, meta.item!.id).getByRole("button", { name: "Discuss this reading", exact: true }).click();
  await expect(composer(page)).toHaveValue(example.draftReading);
  const itemTurn = await send(page, example.thought);
  expect((await dialogue(request, itemTurn.dialogueId)).selection).toEqual({ kind: "item", id: meta.item!.id, versionId: meta.item!.current.id });
  await control(request, "start"); await complete(request);
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await connection.getByRole("button", { name: "Discuss this connection", exact: true }).click();
  await expect(composer(page)).toHaveValue(example.draftConnection);
  const connectionTurn = await send(page, example.secondThought);
  expect((await dialogue(request, connectionTurn.dialogueId)).selection).toEqual({ kind: "relationship", id: meta.relationship!.id,
    versionId: meta.relationship!.current.id, fromVersionId: meta.item!.current.id, toVersionId: meta.neighbor!.current.id });
  await control(request, "revise", { target: "both" });
  await page.reload();
  await expect(target(page).getByText(example.rationale, { exact: true })).toBeVisible();
  await expect(target(page).getByText(example.reading, { exact: true })).toBeVisible();
  await expect(target(page).getByText(example.changedRationale, { exact: true })).toHaveCount(0);
  await control(request, "start"); await complete(request);
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Original source", exact: true }).getByRole("button", { name: "Discuss original", exact: true }).click();
  // Reload ends unsaved draft guarantees; the original draft was preserved until
  // that explicit reload, not promised as browser-persistent draft storage.
  await expect(target(page).getByText(meta.root.text, { exact: true })).toBeVisible();
  await noOverflow(page);
});

test("lost creation and turn acknowledgements reuse keys, reopen from search, and retain earlier exchanges and discussion-source evidence", async ({ page, request }) => {
  const { root } = await world(request, true);
  const creationCalls: Array<{ key: string; body: unknown }> = [], turnCalls: Array<{ key: string; body: unknown }> = [];
  await page.route(`**/api/sources/${root.id}/dialogues`, async (route) => {
    creationCalls.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
    const response = await route.fetch();
    if (creationCalls.length === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Example lost creation acknowledgement" }) });
    else await route.fulfill({ response });
  });
  await page.route("**/api/dialogues/*/turns", async (route) => {
    turnCalls.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
    const response = await route.fetch();
    if (turnCalls.length === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Example lost turn acknowledgement" }) });
    else await route.fulfill({ response });
  });
  await page.goto(`/sources/${root.id}/inquiry?q=coordination#development`);
  await composer(page).fill(example.thought);
  await page.getByRole("button", { name: /^(Send thought|Retry send)$/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: /confirm|acknowledg|retry|try again/i })).toBeVisible();
  await expect(composer(page)).toHaveValue(example.thought);
  if (turnCalls.length === 0) {
    await page.getByRole("button", { name: "Retry send", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /confirm|acknowledg|retry|try again/i })).toBeVisible();
  }
  await expect(composer(page)).toHaveValue(example.thought);
  await page.getByRole("button", { name: "Retry send", exact: true }).click();
  await expect(latest(page).getByText("Your thought saved", { exact: true })).toBeVisible();
  expect(creationCalls.length).toBeGreaterThanOrEqual(2);
  expect(creationCalls[0]!.key).toBeTruthy();
  expect(creationCalls[1]).toEqual(creationCalls[0]);
  expect(turnCalls).toHaveLength(2); expect(turnCalls[1]).toEqual(turnCalls[0]);
  const id = new URL(page.url()).searchParams.get("dialogue")!;
  expect(id).toBeTruthy();
  expect((await metrics(request))).toMatchObject({ dialogues: 1, turns: 1, sources: 3 });
  await page.unroute("**/api/dialogues/*/turns");
  await control(request, "start"); await complete(request);
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  const second = await send(page, example.secondThought);
  expect(second.dialogueId).toBe(id);
  await control(request, "start"); await complete(request, "Example second response: Compare the intended constraints before the next handoff.");
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await control(request, "recreate"); await page.reload();
  await expect(latest(page).getByText(example.secondThought, { exact: true })).toBeVisible();
  const earlier = page.getByRole("button", { name: "Earlier exchanges", exact: true });
  await earlier.click();
  await expect(page.getByRole("region", { name: "Earlier exchanges", exact: true }).getByText(example.thought, { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search thoughts", exact: true }).fill("coordination");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("article").filter({ hasText: example.provenance }).filter({ hasText: "When agents disagree" }).getByRole("link", { name: "Open thought", exact: true }).click();
  await expect(latest(page).getByText(example.secondThought, { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("dialogue")).toBe(id);
  expect(new URL(page.url()).searchParams.get("q")).toBe("coordination");
  await page.getByRole("searchbox", { name: "Search thoughts", exact: true }).fill("zirconium");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const result = page.getByRole("article").filter({ hasText: "zirconium" });
  await expect(result.getByText("Your discussion input", { exact: true })).toBeVisible();
  await result.getByRole("link", { name: "Open thought", exact: true }).click();
  const first = (await dialogue(request, id)).turns[0]!;
  await expect(page).toHaveURL((url) =>
    url.pathname === `/sources/${first.source.id}` || url.pathname === `/sources/${first.source.id}/inquiry`);
  expect(new URL(page.url()).searchParams.get("q")).toBe("zirconium");
  // Either search can open the immutable discussion input directly, or its
  // inquiry can expose the source link; both must retain the retrieval query.
  if (new URL(page.url()).pathname === `/sources/${first.source.id}/inquiry`) await page.getByRole("link", { name: /^Open saved (original|input)$/ }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${first.source.id}` && url.searchParams.get("q") === "zirconium");
  await expect(page.getByRole("heading", { name: "Discussion input", exact: true })).toBeVisible();
  expect(await page.getByRole("article", { name: "Discussion input", exact: true }).textContent()).toBe(example.thought);
  await expect(page.locator(`time[datetime="${first.source.createdAt}"]`)).toBeVisible();
  await expect(page.getByRole("region", { name: "Weaving status", exact: true })).toHaveCount(0);
  await expect(page.getByText("Status unavailable", { exact: true })).toHaveCount(0);
  const back = page.getByRole("link", { name: "Return to discussion", exact: true });
  const backURL = new URL((await back.getAttribute("href"))!, page.url());
  expect(backURL.searchParams.get("dialogue")).toBe(id); expect(backURL.hash).toBe(`#turn-${first.id}`);
  expect(backURL.searchParams.get("q")).toBe("zirconium");
  await back.click();
  await expect(page.locator(`#turn-${first.id}`).getByText(example.thought, { exact: true })).toBeVisible();
  expect((await metrics(request))).toMatchObject({ dialogues: 1, turns: 2, sources: 4 });
  expect((await metrics(request)).admissions).toHaveLength(2);
  await noOverflow(page);
});

test("another root-scoped turn preserves the blocked draft and uncertain admission offers observation without resending", async ({ page, request }) => {
  const meta = await world(request, false, "uncertain");
  await control(request, "block-root");
  await page.goto(`/sources/${meta.root.id}/inquiry#development`);
  await reading(page, meta.item!.id).getByRole("button", { name: "Discuss this reading", exact: true }).click();
  await composer(page).fill(example.thought);
  const conflict = page.waitForResponse((response) => /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.status() === 409);
  await page.getByRole("button", { name: "Send thought", exact: true }).click(); await conflict;
  await expect(page.getByRole("alert").filter({ hasText: /another|in progress|waiting|busy/i })).toBeVisible();
  await expect(composer(page)).toHaveValue(example.thought);
  // The current DTO does not identify the other dialogue. Do not require or
  // permit a fabricated active-discussion link just to satisfy this test.
  await control(request, "start"); await complete(request);
  await progress(page).getByRole("button", { name: "Check status", exact: true }).click();
  const turn = await send(page, example.thought);
  await control(request, "start");
  await expect(progress(page).getByRole("heading", { name: "Outcome uncertain", exact: true })).toBeVisible();
  await expect(progress(page).getByRole("button", { name: /retry/i })).toHaveCount(0);
  await composer(page).fill(example.draftReading);
  await expect(page.getByRole("button", { name: "Send thought", exact: true })).toBeDisabled();
  const writes: string[] = [];
  page.on("request", (entry) => { if (entry.method() === "POST") writes.push(new URL(entry.url()).pathname); });
  const before = await metrics(request);
  await progress(page).getByRole("button", { name: "Check status", exact: true }).click();
  await control(request, "advance", { outcome: "pending" });
  expect((await dialogue(request, turn.dialogueId)).turns.at(-1)?.status).toBe("uncertain");
  expect(writes).toEqual([]);
  await complete(request);
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await expect(composer(page)).toHaveValue(example.draftReading);
  expect((await metrics(request)).admissions).toEqual(before.admissions);
  await noOverflow(page);
});

test("Stop requests settlement, not rollback, and an interrupted response keeps partial canonical text and its recorded idea", async ({ page, request }) => {
  const meta = await world(request);
  await page.goto(`/sources/${meta.root.id}/inquiry#development`);
  await reading(page, meta.item!.id).getByRole("button", { name: "Discuss this reading", exact: true }).click();
  const turn = await send(page, example.thought);
  await control(request, "start");
  await expect(progress(page).getByRole("heading", { name: "Agent responding", exact: true })).toBeVisible();
  await control(request, "write-idea");
  await expect(developed(page).getByText(example.idea, { exact: true })).toBeVisible();
  await stop(page, request, turn);
  await expect(progress(page).getByText("Stop requested", { exact: true })).toBeVisible();
  await expect(progress(page).getByRole("heading", { name: "Response interrupted", exact: true })).toHaveCount(0);
  const stoppedControl = progress(page).getByRole("button", { name: "Stop response", exact: true });
  if (await stoppedControl.count()) await expect(stoppedControl).toBeDisabled();
  await control(request, "advance", { outcome: "interrupted", text: example.partialReply });
  await expect(progress(page).getByRole("heading", { name: "Response interrupted", exact: true })).toBeVisible();
  await expect(latest(page).getByRole("article", { name: "Agent response", exact: true })).toHaveText(example.partialReply);
  await expect(developed(page).getByText(example.idea, { exact: true })).toBeVisible();
  await expect(latest(page).getByText(example.thought, { exact: true })).toBeVisible();
  const after = await metrics(request);
  expect(after.stopCalls).toHaveLength(2); expect(after.stopCalls[0]).toMatch(/^cancel:/); expect(after.stopCalls[1]).toMatch(/^interrupt:.*:false$/);
  expect(after.admissions).toHaveLength(1); expect(after.activeGrants).toBe(0);
  await page.reload();
  await expect(developed(page).getByText(example.idea, { exact: true })).toBeVisible();
  await expect(progress(page).getByRole("button", { name: /retry/i })).toHaveCount(0);
  await noOverflow(page);
});

test("queued Stop prevents admission while completion can win a later Stop with a valid empty reply", async ({ page, request }) => {
  const { root } = await world(request, true);
  await page.goto(`/sources/${root.id}/inquiry#development`);
  const queued = await send(page, example.thought);
  expect((await dialogue(request, queued.dialogueId)).turns[0]?.actions?.stop.expectedRunId).toBeNull();
  await stop(page, request, queued);
  await expect(progress(page).getByRole("heading", { name: "Response interrupted", exact: true })).toBeVisible();
  await control(request, "start");
  expect((await metrics(request)).admissions).toHaveLength(0);
  const raced = await send(page, example.secondThought);
  await control(request, "start");
  await expect(progress(page).getByRole("heading", { name: "Agent responding", exact: true })).toBeVisible();
  await stop(page, request, raced);
  await expect(progress(page).getByText("Stop requested", { exact: true })).toBeVisible();
  await complete(request, "");
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await expect(progress(page).getByRole("heading", { name: "Response interrupted", exact: true })).toHaveCount(0);
  await expect(latest(page).getByText(/finished without a written reply|no written reply/i)).toBeVisible();
  await expect(developed(page).getByText(/no confirmed changes/i)).toBeVisible();
  expect((await dialogue(request, raced.dialogueId)).turns.at(-1)).toMatchObject({ status: "completed", assistant: { text: "" }, changes: [] });
  expect((await metrics(request)).admissions).toHaveLength(1);
  await noOverflow(page);
});

test("a definitively rejected queued Stop refreshes its fence and a later explicit Stop uses a fresh command", async ({ page, request }) => {
  const { root } = await world(request, true);
  await page.goto(`/sources/${root.id}/inquiry#development`);
  const turn = await send(page, example.thought);
  await expect(progress(page).getByRole("heading", { name: "Waiting for agent", exact: true })).toBeVisible();
  const before = await metrics(request);
  const path = `/api/dialogues/${turn.dialogueId}/turns/${turn.id}/stop`;
  const calls: Array<{ key: string; body: { expectedRunId: string | null }; status?: number }> = [];
  const resubmittedTurns: string[] = [];
  page.on("request", (entry) => {
    if (entry.method() === "POST" && /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(entry.url()).pathname)) resubmittedTurns.push(entry.url());
  });
  await page.route(`**${path}`, async (route) => {
    const call = { key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() as { expectedRunId: string | null }, status: 0 };
    calls.push(call);
    // The browser has already captured the queued null fence. Claim and admit
    // its actual job before forwarding that command to the real Hono endpoint.
    if (calls.length === 1) await control(request, "start");
    const response = await route.fetch(); call.status = response.status();
    await route.fulfill({ response });
  });
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST");
  await progress(page).getByRole("button", { name: "Stop response", exact: true }).click();
  expect((await rejected).status()).toBe(409);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({ expectedRunId: null });
  expect(calls[0]!.key).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  await expect(page.getByRole("status").filter({ hasText: /response changed before Stop could be applied/i })).toBeVisible();
  await progress(page).getByRole("button", { name: "Check status", exact: true }).click();
  await expect(progress(page).getByRole("heading", { name: "Agent responding", exact: true })).toBeVisible();
  const claimed = await metrics(request);
  expect(claimed.admissions).toHaveLength(1);
  expect(claimed.stopCalls).toEqual([]);
  const runId = claimed.admissions[0]!.runId;
  expect((await dialogue(request, turn.dialogueId)).turns[0]?.actions?.stop).toEqual({ eligible: true, expectedRunId: runId });
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST");
  await progress(page).getByRole("button", { name: "Stop response", exact: true }).click();
  const response = await accepted;
  expect(calls).toHaveLength(2);
  const retried = await metrics(request);
  expect(retried).toMatchObject({ sources: before.sources, jobs: before.jobs, turns: before.turns });
  expect(retried.admissions).toEqual(claimed.admissions);
  expect(resubmittedTurns).toEqual([]);
  expect(calls[1]!.body).toEqual({ expectedRunId: runId });
  expect(calls[1]!.key).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  expect(calls[1]!.key).not.toBe(calls[0]!.key);
  expect(response.status()).toBe(202);
  expect(calls.map((call) => call.status)).toEqual([409, 202]);
  await expect(progress(page).getByText("Stop requested", { exact: true })).toBeVisible();
  await expect(progress(page).getByRole("heading", { name: "Response interrupted", exact: true })).toHaveCount(0);
  await control(request, "advance", { outcome: "interrupted", text: example.partialReply });
  await expect(progress(page).getByRole("heading", { name: "Response interrupted", exact: true })).toBeVisible();
  await expect(latest(page).getByRole("article", { name: "Agent response", exact: true })).toHaveText(example.partialReply);
  const after = await metrics(request);
  expect(after).toMatchObject({ sources: before.sources, jobs: before.jobs, turns: before.turns });
  expect(after.admissions).toEqual(claimed.admissions);
  expect(after.stopCalls).toHaveLength(2);
  expect(after.stopCalls[0]).toMatch(/^cancel:/); expect(after.stopCalls[1]).toMatch(/^interrupt:.*:false$/);
  expect(after.activeGrants).toBe(0);
  expect(resubmittedTurns).toEqual([]);
});

test("an unconfirmed Stop request before server receipt preserves its exact command for the next explicit click", async ({ page, request }) => {
  const { root } = await world(request, true);
  await page.goto(`/sources/${root.id}/inquiry#development`);
  const turn = await send(page, example.thought);
  await expect(progress(page).getByRole("heading", { name: "Waiting for agent", exact: true })).toBeVisible();
  const before = await metrics(request);
  const path = `/api/dialogues/${turn.dialogueId}/turns/${turn.id}/stop`;
  const calls: Array<{ key: string; body: { expectedRunId: string | null } }> = [];
  const resubmittedTurns: string[] = [];
  page.on("request", (entry) => {
    if (entry.method() === "POST" && /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(entry.url()).pathname)) resubmittedTurns.push(entry.url());
  });
  await page.route(`**${path}`, async (route) => {
    calls.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() as { expectedRunId: string | null } });
    if (calls.length === 1) await route.abort("failed");
    else await route.fulfill({ response: await route.fetch() });
  });
  await progress(page).getByRole("button", { name: "Stop response", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /Stop could not be confirmed/i })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({ expectedRunId: null });
  expect(calls[0]!.key).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  expect((await dialogue(request, turn.dialogueId)).turns[0]).toMatchObject({ status: "queued", actions: { stop: { eligible: true, expectedRunId: null } } });
  await progress(page).getByRole("button", { name: "Check status", exact: true }).click();
  await expect(progress(page).getByRole("heading", { name: "Waiting for agent", exact: true })).toBeVisible();
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST");
  await progress(page).getByRole("button", { name: "Stop response", exact: true }).click();
  expect((await accepted).status()).toBe(202);
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  await expect(progress(page).getByRole("heading", { name: "Response interrupted", exact: true })).toBeVisible();
  const after = await metrics(request);
  expect(after).toMatchObject({ sources: before.sources, jobs: before.jobs, turns: before.turns, admissions: [], stopCalls: [], activeGrants: 0 });
  expect(resubmittedTurns).toEqual([]);
});

test("canonical prose is not a saved offshoot, long replies stay readable, and a definite failure allows a new retained thought", async ({ page, request, context }) => {
  const { root } = await world(request, true);
  await page.goto(`/sources/${root.id}/inquiry#development`);
  const turn = await send(page, example.thought);
  await control(request, "start");
  await expect(progress(page).getByRole("heading", { name: "Agent responding", exact: true })).toBeVisible();
  const original = page.getByRole("region", { name: "Original source", exact: true });
  await original.getByRole("button", { name: "Read full original", exact: true }).click();
  const draftPage = await context.newPage(); await draftPage.goto("/");
  await draftPage.getByRole("textbox", { name: "Your thought", exact: true }).fill(example.draftOriginal);
  const anchor = original.getByRole("link", { name: "Open saved original", exact: true }); await anchor.focus();
  const canonical = `${example.proseOnly}\n${"Example extended analysis of the handoff. ".repeat(2200)}\nEND_EXAMPLE_CANONICAL_REPLY`;
  await complete(request, canonical);
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await expect(anchor).toBeFocused();
  await expect(original.getByRole("article", { name: "Original thought", exact: true })).toBeVisible();
  await expect(draftPage.getByRole("textbox", { name: "Your thought", exact: true })).toHaveValue(example.draftOriginal);
  const expand = latest(page).getByRole("button", { name: "Read full reply", exact: true });
  if (await expand.count()) await expand.click();
  const responseText = latest(page).getByRole("article", { name: "Agent response", exact: true });
  await expect(responseText).toBeVisible();
  expect(await responseText.textContent()).toBe(canonical);
  await expect(developed(page).getByText(/no confirmed changes/i)).toBeVisible();
  await expect(developed(page).getByRole("link", { name: "Open developing idea", exact: true })).toHaveCount(0);
  expect((await dialogue(request, turn.dialogueId)).turns[0]?.changes).toEqual([]);
  await noOverflow(page); await draftPage.close();
  const failed = await send(page, example.secondThought);
  await control(request, "start"); await control(request, "advance", { outcome: "failed", text: "Example partial answer before a confirmed failure." });
  await expect(progress(page).getByRole("heading", { name: "Response failed", exact: true })).toBeVisible();
  await expect(progress(page).getByRole("button", { name: /retry/i })).toHaveCount(0);
  const next = await send(page, example.draftReading);
  expect(next.dialogueId).toBe(failed.dialogueId); expect(next.id).not.toBe(failed.id);
  await expect(latest(page).getByText("Your thought saved", { exact: true })).toBeVisible();
});

test("user correction, rejection and restoration retain attributed history and a stale restore cannot overwrite a newer revision", async ({ page, request }) => {
  const meta = await world(request);
  await page.goto(`/sources/${meta.root.id}/inquiry#development`);
  const item = reading(page, meta.item!.id);
  await item.getByRole("button", { name: "Discuss this reading", exact: true }).click();
  const turn = await send(page, example.correction);
  await control(request, "start"); await complete(request, "");
  await expect(progress(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  const corrected = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/items/${meta.item!.id}/correct` && response.request().method() === "POST");
  await item.getByRole("button", { name: "Use my saved thought as formulation", exact: true }).click();
  const correctedResponse = await corrected;
  expect(correctedResponse.status()).toBe(200);
  expect(correctedResponse.request().postDataJSON()).toEqual({ expectedVersionId: meta.item!.current.id, sourceId: turn.sourceId, text: example.correction });
  await expect(item.getByText("Your recorded formulation", { exact: true })).toBeVisible();
  await expect(item.getByText(example.correction, { exact: true }).filter({ visible: true })).toBeVisible();
  await item.getByRole("button", { name: "View history", exact: true }).click();
  const previous = item.getByRole("listitem").filter({ has: page.getByText(example.reading, { exact: true }) });
  const restored = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/items/${meta.item!.id}/restore` && response.request().method() === "POST");
  await previous.getByRole("button", { name: "Restore this version", exact: true }).click();
  expect((await restored).status()).toBe(200);
  expect((await inquiry(request, meta.root.id)).items.find((entry) => entry.id === meta.item!.id)?.history).toHaveLength(4);
  const relation = page.getByRole("region", { name: "Connections", exact: true }).getByRole("article").filter({ hasText: example.rationale });
  await relation.getByRole("button", { name: "Reject connection", exact: true }).click();
  await relation.getByRole("textbox", { name: "Reason for rejecting this connection", exact: true }).fill("Example user reason: Similar handoff wording is not enough evidence.");
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/relationships/${meta.relationship!.id}/reject` && response.request().method() === "POST");
  await relation.getByRole("button", { name: "Confirm rejection", exact: true }).click();
  const rejectedResponse = await rejected; expect(rejectedResponse.status()).toBe(200);
  expect(rejectedResponse.request().postDataJSON()).toMatchObject({ expectedVersionId: meta.relationship!.current.id, evidenceSourceIds: expect.arrayContaining([meta.root.id]) });
  expect(rejectedResponse.request().postDataJSON()).not.toHaveProperty("actor");
  await expect(relation.getByText("Rejected", { exact: true })).toBeVisible();
  const restoredRelation = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/relationships/${meta.relationship!.id}/restore` && response.request().method() === "POST");
  await relation.getByRole("button", { name: "Restore connection", exact: true }).click();
  expect((await restoredRelation).status()).toBe(200);
  await expect(relation.getByText("Active hypothesis", { exact: true })).toBeVisible();
  expect((await inquiry(request, meta.root.id)).relationships.find((entry) => entry.id === meta.relationship!.id)?.history).toHaveLength(3);
  // A real domain revision races a user restore. The UI must surface the 409,
  // refresh current context, and never silently repeat it against the new head.
  let restoreCalls = 0;
  await page.route(`**/api/items/${meta.item!.id}/restore`, async (route) => {
    restoreCalls++; await control(request, "revise", { target: "item" }); await route.continue();
  });
  const earliest = item.getByRole("listitem").filter({ has: page.getByText(example.initialReading, { exact: true }) });
  const stale = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/items/${meta.item!.id}/restore` && response.status() === 409);
  await earliest.getByRole("button", { name: "Restore this version", exact: true }).click(); await stale;
  await expect(page.getByRole("alert").filter({ hasText: /changed|newer|stale|review/i })).toBeVisible();
  const currentReading = item.locator(":scope > .current-formulation");
  await expect(currentReading).toHaveText(example.changedReading);
  await expect(currentReading).toBeVisible();
  expect(restoreCalls).toBe(1);
  const original = await request.get(`${daemonURL}/sources/${meta.root.id}`);
  expect(await original.json()).toMatchObject({ text: example.original });
  const source = await request.get(`${daemonURL}/sources/${turn.sourceId}`);
  expect(await source.json()).toMatchObject({ text: example.correction });
  await noOverflow(page);
});
