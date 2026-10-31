import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Source } from "../../packages/contracts/src";
import { weavingExample as example, type BrowserWeavingScenario, type WeavingStatusExampleContract } from "../fixtures/weaving-content";

const daemonURL = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
const panel = (page: Page) => page.getByRole("region", { name: "Weaving status", exact: true });
type Metrics = { sources: number; jobs: number; runs: number; activeGrants: number; admissions: { runId: string; promptId: string }[] };

async function world(request: APIRequestContext, scenario: BrowserWeavingScenario, captureInBrowser = false) {
  const response = await request.post(`${daemonURL}/__browser/weaving/world`, { data: { scenario, captureInBrowser } });
  expect(response.status()).toBe(200);
  return await response.json() as { source: Source | null };
}
async function control(request: APIRequestContext, action: "start" | "advance", outcome = "pending") {
  const response = await request.post(`${daemonURL}/__browser/weaving/${action}`, { data: { outcome } });
  expect(response.status()).toBe(200);
  return await response.json() as Metrics;
}
async function metrics(request: APIRequestContext): Promise<Metrics> {
  const response = await request.get(`${daemonURL}/__browser/weaving/metrics`);
  expect(response.status()).toBe(200);
  return await response.json() as Metrics;
}
async function status(request: APIRequestContext, sourceId: string): Promise<WeavingStatusExampleContract> {
  const response = await request.get(`${daemonURL}/sources/${sourceId}/weaving`);
  expect(response.status()).toBe(200);
  return await response.json() as WeavingStatusExampleContract;
}
async function originalUnchanged(request: APIRequestContext, source: Source) {
  const response = await request.get(`${daemonURL}/sources/${source.id}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual(source);
}
async function captureInBrowser(page: Page): Promise<Source> {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Your thought", exact: true }).fill(example.original);
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/captures" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save original", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const source = await response.json() as Source;
  await expect(page).toHaveURL(new RegExp(`/sources/${source.id}$`));
  return source;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.afterEach(async ({ request }) => {
  const response = await request.post(`${daemonURL}/__browser/weaving/reset`);
  expect(response.status()).toBe(200);
});

test("a saved queued original explains missing setup without claiming weaving is complete", async ({ page, request }) => {
  const { source } = await world(request, "unconfigured");
  expect(source).not.toBeNull();
  await page.goto(`/sources/${source!.id}`);
  await expect(page.getByText("Original saved", { exact: true })).toBeVisible();
  expect(await page.getByRole("article", { name: "Original thought", exact: true }).textContent()).toBe(example.original);
  // First intended RED: the real phase-2 source page renders, but has no
  // per-source, setup-aware Weaving status region.
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("heading", { name: "Queued for weaving", exact: true })).toBeVisible();
  await expect(panel(page).getByText("Weaving is not configured.", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Retry weaving", exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole("heading", { name: "Weaving completed", exact: true })).toHaveCount(0);
  await expect(page.getByText(/worker is not available in this phase|weaving is not implemented/i)).toHaveCount(0);
  const view = await status(request, source!.id);
  expect(view).toMatchObject({ sourceId: source!.id, worker: { configured: false }, job: { status: "queued" }, run: null, actions: { retry: false } });
  await panel(page).getByRole("link", { name: "Set up weaving", exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/weaving$/);
  await expect(page.getByRole("heading", { name: "Set up weaving", exact: true })).toBeVisible();
  await expect(page.getByText(/registration/i).first()).toBeVisible();
  await expect(page.getByText(/agent/i).first()).toBeVisible();
  await expect(page.getByText(/model/i).first()).toBeVisible();
  await originalUnchanged(request, source!);
  await noOverflow(page);
});

test("capture progresses from queued to running to valid zero-change completion", async ({ page, request }) => {
  await world(request, "available", true);
  const source = await captureInBrowser(page);
  await expect(panel(page).getByRole("heading", { name: "Queued for weaving", exact: true })).toBeVisible();
  await control(request, "start");
  await expect(panel(page).getByRole("heading", { name: "Weaving in progress", exact: true })).toBeVisible();
  await expect(page.getByText("Original saved", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Retry weaving", exact: true })).toHaveCount(0);
  const admitted = await status(request, source.id);
  expect(admitted.job.status).toBe("running");
  await control(request, "advance", "completed");
  await expect(panel(page).getByRole("heading", { name: "Weaving completed", exact: true })).toBeVisible();
  await expect(panel(page).getByText(/no (new )?(changes|connections)/i)).toBeVisible();
  await expect(page.getByText(/no ai processing yet|worker is not available in this phase/i)).toHaveCount(0);
  expect(await status(request, source.id)).toMatchObject({ job: { status: "completed", recordedChanges: 0 }, actions: { retry: false } });
  expect((await metrics(request)).admissions).toHaveLength(1);
  await originalUnchanged(request, source);
  await noOverflow(page);
});

test("definitely failed eligible work retries through a fenced command without recapturing", async ({ page, request }) => {
  const { source } = await world(request, "available");
  await control(request, "start"); await control(request, "advance", "failed");
  await page.goto(`/sources/${source!.id}`);
  await expect(panel(page).getByRole("heading", { name: "Weaving failed", exact: true })).toBeVisible();
  const failed = await status(request, source!.id), before = await metrics(request);
  expect(failed.actions.retry).toBe(true); expect(failed.run).not.toBeNull();
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
  const retried = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${source!.id}/weaving/retry` && response.request().method() === "POST");
  await panel(page).getByRole("button", { name: "Retry weaving", exact: true }).click();
  const receipt = await retried;
  expect(receipt.status()).toBe(202);
  expect(receipt.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  expect(receipt.request().postDataJSON()).toEqual({ expectedRunId: failed.run!.id });
  await control(request, "advance");
  await expect(panel(page).getByRole("heading", { name: "Weaving in progress", exact: true })).toBeVisible();
  await control(request, "advance", "completed");
  await expect(panel(page).getByRole("heading", { name: "Weaving completed", exact: true })).toBeVisible();
  const after = await metrics(request), completed = await status(request, source!.id);
  expect(after.sources).toBe(before.sources); expect(after.jobs).toBe(before.jobs);
  expect(after.admissions).toHaveLength(2);
  expect(new Set(after.admissions.map((run) => run.runId)).size).toBe(2);
  expect(completed.job.id).toBe(failed.job.id);
  expect(writes).not.toContain("/api/captures");
  await originalUnchanged(request, source!);
  await noOverflow(page);
});

test("uncertain admission offers observation, never blind resend, and reconciles the same run", async ({ page, request }) => {
  const { source } = await world(request, "uncertain"); await control(request, "start");
  await page.goto(`/sources/${source!.id}`);
  await expect(panel(page).getByRole("heading", { name: "Outcome uncertain", exact: true })).toBeVisible();
  await expect(panel(page).getByText(/may (already )?have (been )?(accepted|started)|cannot confirm/i)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Retry weaving", exact: true })).toHaveCount(0);
  const before = await status(request, source!.id), beforeMetrics = await metrics(request);
  expect(before.actions.retry).toBe(false);
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") mutations.push(request.url()); });
  await panel(page).getByRole("button", { name: "Check status", exact: true }).click();
  await control(request, "advance", "pending");
  await expect(panel(page).getByRole("heading", { name: "Outcome uncertain", exact: true })).toBeVisible();
  const anchor = page.getByRole("link", { name: "Capture another", exact: true }); await anchor.focus();
  await control(request, "advance", "completed");
  await expect(panel(page).getByRole("heading", { name: "Weaving completed", exact: true })).toBeVisible();
  await expect(anchor).toBeFocused();
  const after = await status(request, source!.id), afterMetrics = await metrics(request);
  expect(after.run?.id).toBe(before.run?.id);
  expect(afterMetrics.admissions).toEqual(beforeMetrics.admissions);
  expect(afterMetrics.sources).toBe(beforeMetrics.sources); expect(afterMetrics.runs).toBe(beforeMetrics.runs);
  expect(mutations).toEqual([]);
  await originalUnchanged(request, source!);
});

test("interrupted and configured-service-unavailable states retain the original and stay distinct", async ({ page, request }) => {
  const interrupted = await world(request, "updates"); await control(request, "start"); await control(request, "advance", "interrupted");
  await page.goto(`/sources/${interrupted.source!.id}`);
  await expect(panel(page).getByRole("heading", { name: "Run interrupted", exact: true })).toBeVisible();
  await expect(page.getByText("Original saved", { exact: true })).toBeVisible();
  await originalUnchanged(request, interrupted.source!); await noOverflow(page);
  await page.getByRole("link", { name: "Explore recorded context", exact: true }).click();
  await expect(panel(page).getByRole("heading", { name: "Run interrupted", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Interpretations", exact: true }).getByText(example.interpretation, { exact: true }).filter({ visible: true })).toBeVisible();

  const unavailable = await world(request, "unavailable"); await control(request, "start");
  await page.goto(`/sources/${unavailable.source!.id}`);
  await expect(panel(page).getByText("Weaving service unavailable", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Weaving is not configured.", { exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole("heading", { name: "Weaving completed", exact: true })).toHaveCount(0);
  await expect(page.getByText("Original saved", { exact: true })).toBeVisible();
  expect(await status(request, unavailable.source!.id)).toMatchObject({ worker: { configured: true, state: "unavailable" }, job: { status: "queued" } });
  await originalUnchanged(request, unavailable.source!); await noOverflow(page);
});

test("supervised domain writes update an open inquiry without replacing focus, source disclosure or another capture draft", async ({ page, context, request }) => {
  await world(request, "updates", true);
  const source = await captureInBrowser(page);
  await page.getByRole("link", { name: "Explore recorded context", exact: true }).click();
  const original = page.getByRole("region", { name: "Original source", exact: true });
  await original.getByRole("button", { name: "Read full original", exact: true }).click();
  await expect(original.getByRole("article", { name: "Original thought", exact: true })).toBeVisible();
  await control(request, "start");
  await expect(panel(page).getByRole("heading", { name: "Weaving in progress", exact: true })).toBeVisible();
  const draftPage = await context.newPage(); await draftPage.goto("/");
  await draftPage.getByRole("textbox", { name: "Your thought", exact: true }).fill(example.draft);
  const anchor = original.getByRole("link", { name: "Open source", exact: true }); await anchor.focus();
  const before = await metrics(request);
  await control(request, "advance", "completed");
  await expect(panel(page).getByRole("heading", { name: "Weaving completed", exact: true })).toBeVisible();
  const interpretations = page.getByRole("region", { name: "Interpretations", exact: true });
  await expect(page.getByText(/automated weaving is not connected yet/i)).toHaveCount(0);
  await expect(interpretations.getByText(example.interpretation, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(interpretations.getByText("AI interpretation", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(interpretations.getByText("Tentative", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Connections", exact: true }).getByText(example.rationale, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(original.getByRole("article", { name: "Original thought", exact: true })).toBeVisible();
  expect(await original.getByRole("article", { name: "Original thought", exact: true }).textContent()).toBe(example.original);
  await expect(anchor).toBeFocused();
  await expect(draftPage.getByRole("textbox", { name: "Your thought", exact: true })).toHaveValue(example.draft);
  const after = await metrics(request);
  expect(after.sources).toBe(before.sources); expect(after.jobs).toBe(before.jobs); expect(after.activeGrants).toBe(0);
  expect(await status(request, source.id)).toMatchObject({ job: { status: "completed", recordedChanges: 2 }, actions: { retry: false } });
  await originalUnchanged(request, source); await noOverflow(page);
  await draftPage.close();
});
