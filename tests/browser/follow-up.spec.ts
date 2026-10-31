import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { parseDialogueTurnReceipt, parseDialogueView, parseFollowUpStatusView, parseInquiryView, parseItemView, parseRelationshipView,
  type DialogueTurnReceipt, type FollowUpStatusView } from "../../packages/contracts/src";
import { dialogueExample as example } from "../fixtures/dialogue-content";
import { followUpExample as background } from "../fixtures/follow-up-content";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemonURL = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
const panel = (page: Page) => page.getByRole("region", { name: "Background follow-up", exact: true });
const composer = (page: Page) => page.getByRole("textbox", { name: "Develop this thought", exact: true });
const primary = (page: Page) => page.getByRole("region", { name: "Dialogue status", exact: true });
const jobPanel = (page: Page, id: string) => panel(page).locator(`#follow-up-${id}`);

async function control(request: APIRequestContext, action: string, data: object = {}) {
  const response = await request.post(`${daemonURL}/__browser/dialogue/${action}`, { data });
  expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext, limited = false): Promise<BrowserDialogueMetadata> {
  return await (await control(request, "world", { followUp: true, limitedFollowUp: limited })).json() as BrowserDialogueMetadata;
}
async function status(request: APIRequestContext, id: string): Promise<FollowUpStatusView> {
  const response = await request.get(`${daemonURL}/sources/${id}/follow-ups`);
  expect(response.status()).toBe(200);
  const value = parseFollowUpStatusView(await response.json()); expect(value).not.toBeNull(); return value!;
}
async function metrics(request: APIRequestContext) {
  return await (await controlGet(request, "metrics")).json() as { sources: number; jobs: number; turns: number; admissions: Array<{ runId: string; kind: string; jobId: string }>; activeGrants: number };
}
async function controlGet(request: APIRequestContext, action: string) {
  const response = await request.get(`${daemonURL}/__browser/dialogue/${action}`); expect(response.status()).toBe(200); return response;
}
async function inquiry(request: APIRequestContext, id: string) {
  const response = await request.get(`${daemonURL}/sources/${id}/inquiry`); expect(response.status()).toBe(200);
  const value = parseInquiryView(await response.json()); expect(value).not.toBeNull(); return value!;
}
async function start(request: APIRequestContext, kind: "dialogue" | "follow_up") {
  const result = await (await control(request, "start")).json();
  expect(result.result).toMatchObject({ kind: "started", run: { kind } });
}
async function advance(request: APIRequestContext, outcome: "pending" | "succeeded" | "failed", text = "") {
  await control(request, "advance", { outcome, text });
}
async function send(page: Page, text: string): Promise<DialogueTurnReceipt> {
  await composer(page).fill(text);
  const saved = page.waitForResponse((response) => /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send thought", exact: true }).click();
  const response = await saved; expect([200, 201]).toContain(response.status());
  const value = parseDialogueTurnReceipt(await response.json()); expect(value).not.toBeNull(); return value!;
}
async function origin(request: APIRequestContext, root: BrowserDialogueMetadata["root"]) {
  const opened = await request.post(`${daemonURL}/sources/${root.id}/dialogues`, { headers: { "idempotency-key": `example-follow-up-context-${crypto.randomUUID()}` }, data: { selection: { kind: "source", id: root.id } } });
  expect(opened.status()).toBe(201);
  const discussion = parseDialogueView(await opened.json()); expect(discussion).not.toBeNull();
  const saved = await request.post(`${daemonURL}/dialogues/${discussion!.id}/turns`, { headers: { "idempotency-key": `example-follow-up-turn-${crypto.randomUUID()}` }, data: { text: example.thought } });
  expect(saved.status()).toBe(201);
  const turn = parseDialogueTurnReceipt(await saved.json()); expect(turn).not.toBeNull();
  await start(request, "dialogue"); await control(request, "write-idea"); await advance(request, "succeeded", example.reply);
  const view = await status(request, root.id); expect(view.jobs).toHaveLength(1);
  expect(view.jobs[0]).toMatchObject({ status: "queued", run: null, origins: [expect.objectContaining({ kind: "dialogue", dialogueId: discussion!.id, turnId: turn!.id })] });
  return { turn: turn!, job: view.jobs[0]! };
}
async function failedOrigin(request: APIRequestContext, root: BrowserDialogueMetadata["root"]) {
  const value = await origin(request, root); await start(request, "follow_up"); await advance(request, "failed");
  const failed = (await status(request, root.id)).jobs[0]!;
  expect(failed).toMatchObject({ id: value.job.id, status: "failed", actions: { retry: true } }); expect(failed.run).not.toBeNull();
  return { ...value, failed };
}
async function unchanged(request: APIRequestContext, root: BrowserDialogueMetadata["root"], turn?: DialogueTurnReceipt) {
  const response = await request.get(`${daemonURL}/sources/${root.id}`); expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ text: root.text, createdAt: root.createdAt, provenance: root.provenance });
  if (turn) {
    const retained = await request.get(`${daemonURL}/sources/${turn.sourceId}`); expect(retained.status()).toBe(200);
    expect(await retained.json()).toMatchObject({ text: example.thought, origin: { kind: "discussion-turn", dialogueId: turn.dialogueId, turnId: turn.id, rootSourceId: root.id } });
  }
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }

test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("a neighboring root's follow-up cannot silently replace either endpoint or shared connection in an open inquiry", async ({ page, request }) => {
  const meta = await world(request, true);
  expect(meta.item).not.toBeNull(); expect(meta.neighbor).not.toBeNull(); expect(meta.relationship).not.toBeNull();
  const connection = page.getByRole("region", { name: "Connections", exact: true }).locator(".connection-reading");
  const direction = connection.locator(".connection-direction"), rationale = connection.locator(".connection-rationale");
  await page.goto(`/sources/${meta.root.id}/inquiry#development`);
  await expect(direction.getByText(example.neighbor, { exact: false })).toBeVisible();
  await expect(rationale).toHaveText(example.rationale);
  // The other root owns this real dialogue, run, and its narrowly scoped writes.
  const other = await origin(request, meta.counterpart);
  await start(request, "follow_up");
  await control(request, "write-neighbor-follow-up");
  await advance(request, "succeeded");
  const neighborStatus = await status(request, meta.counterpart.id);
  expect(neighborStatus.jobs[0]).toMatchObject({ id: other.job.id, status: "completed", changesTruncated: true });
  expect((await status(request, meta.root.id)).jobs).toEqual([]);
  const current = await inquiry(request, meta.root.id);
  expect(current.items.find((item) => item.id === meta.neighbor?.id)?.current.text).toBe("Example neighbor follow-up: Explicit handoff contracts preserve context.");
  expect(current.relationships.find((relation) => relation.id === meta.relationship?.id)?.current.rationale).toBe("Example neighbor follow-up: A shared handoff contract needs a concrete fidelity check.");
  // Ordinary primary-dialogue settlement refreshes the inquiry without opting in
  // to the other root's background findings. Keep the user's unsent next draft.
  await send(page, example.secondThought); await start(request, "dialogue"); await advance(request, "succeeded", example.reply);
  await expect(primary(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await composer(page).fill(example.draftReading);
  await expect(direction.getByText(example.neighbor, { exact: false })).toBeVisible();
  await expect(rationale).toHaveText(example.rationale);
  await expect(connection.getByText("Example neighbor follow-up: Explicit handoff contracts preserve context.", { exact: false })).toHaveCount(0);
  await expect(connection.getByText("Example neighbor follow-up: A shared handoff contract needs a concrete fidelity check.", { exact: true })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "View follow-up findings", exact: true }).click();
  await expect(direction.getByText("Example neighbor follow-up: Explicit handoff contracts preserve context.", { exact: false })).toBeVisible();
  await expect(rationale).toHaveText("Example neighbor follow-up: A shared handoff contract needs a concrete fidelity check.");
  await expect(composer(page)).toHaveValue(example.draftReading);
});

test("a completed meaningful dialogue queues subordinate follow-up and confirmed findings wait for an explicit view without disturbing the question", async ({ page, request }) => {
  const { root } = await world(request);
  await page.goto(`/sources/${root.id}/inquiry?q=coordination#development`);
  // Prose and an alias are not a meaningful entity/version trigger.
  await send(page, example.secondThought); await start(request, "dialogue");
  await control(request, "write-alias"); await advance(request, "succeeded", example.proseOnly);
  await expect(primary(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  expect((await status(request, root.id)).jobs).toEqual([]);
  const turn = await send(page, example.thought); await start(request, "dialogue");
  await control(request, "write-idea"); await advance(request, "succeeded", example.reply);
  await expect(primary(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  const queued = (await status(request, root.id)).jobs[0]!;
  expect(queued).toMatchObject({ status: "queued", run: null, origins: [expect.objectContaining({ kind: "dialogue", dialogueId: turn.dialogueId, turnId: turn.id })] });
  expect(queued.targets).toHaveLength(1); expect(queued.targets[0]!.kind).toBe("item");
  // First valid RED: this is a rendered inquiry with an actual queued job;
  // the current phase-4 UI has no named background-follow-up region.
  await expect(panel(page)).toBeVisible();
  const pass = jobPanel(page, queued.id);
  await expect(pass.getByRole("heading", { name: "Follow-up queued", exact: true })).toBeVisible();
  const cause = pass.getByRole("link", { name: "Triggering discussion", exact: true });
  const causeURL = new URL((await cause.getAttribute("href"))!, page.url());
  expect(causeURL.pathname).toBe(`/sources/${root.id}/inquiry`); expect(causeURL.searchParams.get("dialogue")).toBe(turn.dialogueId);
  expect(causeURL.searchParams.get("q")).toBe("coordination"); expect(causeURL.hash).toBe(`#turn-${turn.id}`);
  await expect(pass.locator(`a[href$="#version-${queued.targets[0]!.versionId}"]`)).toBeVisible();
  expect(await panel(page).evaluate((element) => !!(document.querySelector(".development-area")!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const original = page.getByRole("region", { name: "Original source", exact: true });
  await original.getByRole("button", { name: "Read full original", exact: true }).click();
  await page.locator(`#item-${queued.targets[0]!.id}`).getByRole("button", { name: "View history", exact: true }).click();
  await composer(page).fill(example.draftReading);
  const anchor = original.getByRole("link", { name: "Open saved original", exact: true }); await anchor.focus();
  await start(request, "follow_up");
  await expect(pass.getByRole("heading", { name: "Follow-up running", exact: true })).toBeVisible();
  await control(request, "write-follow-up"); await advance(request, "succeeded");
  await expect(pass.getByRole("heading", { name: "Follow-up complete", exact: true })).toBeVisible();
  await expect(primary(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await expect(anchor).toBeFocused(); await expect(composer(page)).toHaveValue(example.draftReading);
  expect(await original.getByRole("article", { name: "Original thought", exact: true }).textContent()).toBe(root.text);
  await expect(page.locator(`#item-${queued.targets[0]!.id}`).getByRole("region", { name: "Formulation history", exact: true })).toBeVisible();
  const readings = page.getByRole("region", { name: "Interpretations", exact: true });
  await expect(readings.getByText(background.interpretation, { exact: true })).toHaveCount(0);
  const completed = (await status(request, root.id)).jobs[0]!;
  expect(completed.changes).toHaveLength(1); expect(completed.changes[0]!.kind).toBe("interpretation");
  await pass.getByRole("button", { name: "View follow-up findings", exact: true }).click();
  const finding = page.locator(`#item-${completed.changes[0]!.id}`);
  await expect(finding.locator(":scope > .current-formulation")).toHaveText(background.interpretation);
  await expect(finding.getByText("AI interpretation", { exact: true })).toBeVisible();
  await expect(finding.getByText("Tentative", { exact: true })).toBeVisible();
  await expect(finding.getByRole("link", { name: /^Evidence:/ })).toHaveAttribute("href", `/sources/${root.id}`);
  await expect(composer(page)).toHaveValue(example.draftReading);
  await unchanged(request, root, turn); await noOverflow(page);
});

test("trusted reading and connection revisions coalesce with honest bounded origin, version, job and finding disclosures", async ({ page, request }) => {
  const meta = await world(request, true);
  // A user correction must cite an actual retained discussion input belonging
  // to this root; the original capture itself is not a correction source.
  const opened = await request.post(`${daemonURL}/sources/${meta.root.id}/dialogues`, { headers: { "idempotency-key": crypto.randomUUID() }, data: { selection: { kind: "item", id: meta.item!.id, versionId: meta.item!.current.id } } });
  expect(opened.status()).toBe(201);
  const discussion = parseDialogueView(await opened.json()); expect(discussion).not.toBeNull();
  const saved = await request.post(`${daemonURL}/dialogues/${discussion!.id}/turns`, { headers: { "idempotency-key": crypto.randomUUID() }, data: { text: background.revision } });
  expect(saved.status()).toBe(201);
  const correction = parseDialogueTurnReceipt(await saved.json()); expect(correction).not.toBeNull();
  await start(request, "dialogue"); await advance(request, "succeeded", example.reply);
  expect((await status(request, meta.root.id)).jobs).toEqual([]);
  const correctedResponse = await request.post(`${daemonURL}/items/${meta.item!.id}/correct`, { headers: { "idempotency-key": crypto.randomUUID() }, data: { expectedVersionId: meta.item!.current.id, sourceId: correction!.sourceId, text: background.revision } });
  expect(correctedResponse.status()).toBe(200);
  const corrected = parseItemView(await correctedResponse.json()); expect(corrected).not.toBeNull();
  const rejectedResponse = await request.post(`${daemonURL}/relationships/${meta.relationship!.id}/reject`, { headers: { "idempotency-key": crypto.randomUUID() }, data: { expectedVersionId: meta.relationship!.current.id, rationale: background.reason, evidenceSourceIds: [meta.root.id] } });
  expect(rejectedResponse.status()).toBe(200);
  const rejected = parseRelationshipView(await rejectedResponse.json()); expect(rejected).not.toBeNull();
  const initial = await status(request, meta.root.id), queued = initial.jobs[0]!;
  expect(initial.jobs).toHaveLength(1); expect(queued).toMatchObject({ status: "queued", originsTruncated: true, targetsTruncated: true });
  await page.goto(`/sources/${meta.root.id}/inquiry?q=coordination`);
  await expect(panel(page)).toBeVisible();
  const pass = jobPanel(page, queued.id);
  await expect(pass.getByText("Your saved revision", { exact: true })).toBeVisible();
  await expect(pass.getByText("Some triggering changes are not shown.", { exact: true })).toBeVisible();
  await expect(pass.getByText("Some affected versions are not shown.", { exact: true })).toBeVisible();
  const affected = queued.targets[0]!;
  const version = pass.locator(`a[href$="#version-${affected.versionId}"]`);
  await expect(version).toBeVisible(); await version.click();
  await expect(page.locator(`#version-${affected.versionId}`)).toBeVisible();
  const expectedText = affected.kind === "item" ? background.revision : background.reason;
  await expect(page.locator(`#version-${affected.versionId}`).getByText(expectedText, { exact: true })).toBeVisible();
  await start(request, "follow_up");
  await control(request, "revise", { target: "item" });
  await control(request, "write-follow-up", { multiple: true });
  const bounded = await status(request, meta.root.id);
  expect(bounded.truncated).toBe(true); expect(bounded.jobs).toHaveLength(1);
  expect(bounded.jobs[0]).toMatchObject({ id: queued.id, status: "running", changesTruncated: true, recordedChanges: 2 });
  await panel(page).getByRole("button", { name: "Check status", exact: true }).click();
  await expect(panel(page).getByText("Some follow-up passes are not shown.", { exact: true })).toBeVisible();
  await expect(pass.getByText("Some confirmed changes are not shown.", { exact: true })).toBeVisible();
  const current = (await inquiry(request, meta.root.id)).items.find((entry) => entry.id === meta.item!.id)!;
  expect(current.current).toMatchObject({ author: "user", text: example.changedReading });
  expect(current.history).toContainEqual(expect.objectContaining({ id: corrected!.current.id, author: "user", text: background.revision }));
  expect((await inquiry(request, meta.root.id)).relationships.find((entry) => entry.id === meta.relationship!.id)?.current).toMatchObject({ id: rejected!.current.id, author: "user", status: "rejected" });
  await unchanged(request, meta.root); await noOverflow(page);
});

test("saved-source follow-up distinguishes empty, unconfigured and configured-unavailable work from capture completion", async ({ page, request }) => {
  const { root, relationship } = await world(request);
  await control(request, "configure-follow-up", { availability: "unconfigured" });
  await page.goto(`/sources/${root.id}`);
  await expect(page.getByText("Original saved", { exact: true })).toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByText("No background follow-up queued.", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Background follow-up is not configured.", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("link", { name: "Set up weaving", exact: true })).toHaveAttribute("href", "/setup/weaving");
  await control(request, "configure-follow-up", { availability: "available" });
  const { job, turn } = await origin(request, root);
  const revisionResponse = await request.post(`${daemonURL}/relationships/${relationship!.id}/reject`, { headers: { "idempotency-key": crypto.randomUUID() }, data: { expectedVersionId: relationship!.current.id, rationale: background.reason, evidenceSourceIds: [root.id] } });
  expect(revisionResponse.status()).toBe(200);
  const revision = parseRelationshipView(await revisionResponse.json()); expect(revision).not.toBeNull();
  await control(request, "configure-follow-up", { availability: "unavailable" });
  await panel(page).getByRole("button", { name: "Check status", exact: true }).click();
  await expect(jobPanel(page, job.id).getByRole("heading", { name: "Follow-up queued", exact: true })).toBeVisible();
  await expect(panel(page).getByText("Background follow-up service unavailable", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Background follow-up is not configured.", { exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Retry follow-up", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Weaving status", exact: true }).getByRole("heading", { name: "Weaving completed", exact: true })).toBeVisible();
  expect((await status(request, root.id)).worker).toEqual({ configured: true, state: "unavailable" });
  const target = jobPanel(page, job.id).locator(`a[href$="#version-${revision!.current.id}"]`);
  await expect(target).toBeVisible(); await target.click();
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${root.id}/inquiry` && url.hash === `#version-${revision!.current.id}`);
  await expect(page.locator(`#version-${revision!.current.id}`).getByText(background.reason, { exact: true })).toBeVisible();
  await unchanged(request, root, turn); await noOverflow(page);
});

test("uncertain follow-up offers observation without resending and zero-change completion remains distinct from the primary response", async ({ page, request }) => {
  const { root } = await world(request), { job, turn } = await origin(request, root);
  await control(request, "configure-follow-up", { uncertain: true }); await start(request, "follow_up");
  const before = await status(request, root.id), beforeMetrics = await metrics(request);
  expect(before.jobs[0]).toMatchObject({ status: "uncertain", actions: { retry: false } });
  await page.goto(`/sources/${root.id}/inquiry?dialogue=${turn.dialogueId}#development`);
  await expect(panel(page)).toBeVisible();
  const pass = jobPanel(page, job.id);
  await expect(pass.getByRole("heading", { name: "Follow-up uncertain", exact: true })).toBeVisible();
  await expect(pass.getByRole("button", { name: "Retry follow-up", exact: true })).toHaveCount(0);
  await expect(primary(page).getByRole("heading", { name: "Response complete", exact: true })).toBeVisible();
  await composer(page).fill(example.draftOriginal);
  const writes: string[] = []; page.on("request", (entry) => { if (entry.method() === "POST") writes.push(entry.url()); });
  await panel(page).getByRole("button", { name: "Check status", exact: true }).click();
  await advance(request, "pending");
  await expect(pass.getByRole("heading", { name: "Follow-up uncertain", exact: true })).toBeVisible();
  await advance(request, "succeeded");
  await expect(pass.getByRole("heading", { name: "Follow-up complete", exact: true })).toBeVisible();
  await expect(pass.getByText("No confirmed changes were recorded.", { exact: true })).toBeVisible();
  await expect(composer(page)).toHaveValue(example.draftOriginal);
  const after = await status(request, root.id), afterMetrics = await metrics(request);
  expect(after.jobs[0]!.run).toEqual(before.jobs[0]!.run); expect(after.jobs[0]!.changes).toEqual([]);
  expect(afterMetrics.admissions).toEqual(beforeMetrics.admissions); expect(writes).toEqual([]);
  await unchanged(request, root, turn); await noOverflow(page);
});

test("a lost follow-up retry acknowledgement reuses the exact job, run fence and key without recapturing or resubmitting a turn", async ({ page, request }) => {
  const { root } = await world(request), { job, failed, turn } = await failedOrigin(request, root);
  const before = await metrics(request), path = `/api/sources/${root.id}/follow-ups/${job.id}/retry`;
  await page.goto(`/sources/${root.id}`);
  await expect(panel(page)).toBeVisible();
  const pass = jobPanel(page, job.id);
  await expect(pass.getByRole("heading", { name: "Follow-up failed", exact: true })).toBeVisible();
  const calls: Array<{ key: string; body: unknown; status: number }> = [], writes: string[] = [];
  page.on("request", (entry) => { if (entry.method() === "POST") writes.push(new URL(entry.url()).pathname); });
  await page.route(`**${path}`, async (route) => {
    const response = await route.fetch();
    calls.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON(), status: response.status() });
    if (calls.length === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Example lost retry acknowledgement" }) });
    else await route.fulfill({ response });
  });
  await pass.getByRole("button", { name: "Retry follow-up", exact: true }).click();
  await expect(panel(page).getByRole("alert").filter({ hasText: /confirm|acknowledg/i })).toBeVisible();
  expect(calls).toHaveLength(1); expect(calls[0]!.status).toBe(202);
  expect(calls[0]!.body).toEqual({ expectedRunId: failed.run!.id });
  expect(calls[0]!.key).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  expect((await status(request, root.id)).jobs[0]).toMatchObject({ id: job.id, status: "queued", run: null });
  const acknowledged = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.status() === 202);
  await pass.getByRole("button", { name: "Retry follow-up", exact: true }).click(); await acknowledged;
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  expect((await metrics(request)).admissions).toEqual(before.admissions);
  await start(request, "follow_up"); await advance(request, "succeeded");
  await expect(pass.getByRole("heading", { name: "Follow-up complete", exact: true })).toBeVisible();
  await expect(pass.getByText("No confirmed changes were recorded.", { exact: true })).toBeVisible();
  const after = await metrics(request);
  expect(after).toMatchObject({ sources: before.sources, jobs: before.jobs, turns: before.turns, activeGrants: 0 });
  expect(after.admissions).toHaveLength(before.admissions.length + 1);
  expect(after.admissions.at(-1)).toMatchObject({ kind: "follow_up", jobId: job.id });
  expect(writes).toEqual([path, path]);
  await unchanged(request, root, turn); await noOverflow(page);
});

test("a definite follow-up retry conflict refreshes the job and only the next explicit click uses a fresh key and current run", async ({ page, request }) => {
  const { root } = await world(request), { job, failed, turn } = await failedOrigin(request, root);
  await page.goto(`/sources/${root.id}/inquiry?dialogue=${turn.dialogueId}#development`);
  await expect(panel(page)).toBeVisible();
  const pass = jobPanel(page, job.id), path = `/api/sources/${root.id}/follow-ups/${job.id}/retry`;
  const calls: Array<{ key: string; body: unknown; status: number }> = [], writes: string[] = [];
  page.on("request", (entry) => { if (entry.method() === "POST") writes.push(new URL(entry.url()).pathname); });
  await page.route(`**${path}`, async (route) => {
    const call = { key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() as unknown, status: 0 }; calls.push(call);
    if (calls.length === 1) {
      const external = await request.post(`${daemonURL}/sources/${root.id}/follow-ups/${job.id}/retry`, { headers: { "idempotency-key": `example-other-retry-${crypto.randomUUID()}` }, data: { expectedRunId: failed.run!.id } });
      expect(external.status()).toBe(202); await start(request, "follow_up"); await advance(request, "failed");
    }
    const response = await route.fetch(); call.status = response.status(); await route.fulfill({ response });
  });
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.status() === 409);
  await pass.getByRole("button", { name: "Retry follow-up", exact: true }).click(); await rejected;
  await expect(panel(page).getByRole("alert").filter({ hasText: /changed|newer|conflict|current/i })).toBeVisible();
  expect(calls).toHaveLength(1); expect(calls[0]!.body).toEqual({ expectedRunId: failed.run!.id });
  await panel(page).getByRole("button", { name: "Check status", exact: true }).click();
  const current = (await status(request, root.id)).jobs[0]!;
  expect(current.actions.retry).toBe(true); expect(current.run!.id).not.toBe(failed.run!.id);
  const before = await metrics(request);
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST");
  await pass.getByRole("button", { name: "Retry follow-up", exact: true }).click();
  const receipt = await accepted;
  expect(calls).toHaveLength(2); expect(calls[1]!.body).toEqual({ expectedRunId: current.run!.id });
  expect(calls[1]!.key).toMatch(/^[A-Za-z0-9._~-]{1,128}$/); expect(calls[1]!.key).not.toBe(calls[0]!.key);
  expect(receipt.status()).toBe(202); expect(calls.map((call) => call.status)).toEqual([409, 202]);
  expect((await metrics(request)).admissions).toEqual(before.admissions);
  await start(request, "follow_up"); await advance(request, "succeeded");
  await expect(pass.getByRole("heading", { name: "Follow-up complete", exact: true })).toBeVisible();
  const after = await metrics(request);
  expect(after).toMatchObject({ sources: before.sources, jobs: before.jobs, turns: before.turns, activeGrants: 0 });
  expect(after.admissions).toHaveLength(before.admissions.length + 1); expect(writes).toEqual([path, path]);
  await unchanged(request, root, turn); await noOverflow(page);
});
