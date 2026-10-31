import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Source } from "../../packages/contracts/src";

const daemonURL = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;

function isCaptureResponse(response: { url(): string; request(): { method(): string } }, origin: string) {
  const url = new URL(response.url());
  return url.origin === origin && url.pathname === "/api/captures" && response.request().method() === "POST";
}

async function assertPersisted(request: APIRequestContext, source: Source) {
  // Test-runner only. Browser traffic must use the same-origin Next BFF.
  const response = await request.get(`${daemonURL}/sources/${source.id}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual(source);
}

async function assertOriginalView(page: Page, source: Source) {
  await expect(page).toHaveURL(new RegExp(`/sources/${source.id}$`));
  await expect(page.getByText("Original saved", { exact: true })).toBeVisible();
  const original = page.getByRole("article", { name: "Original thought", exact: true });
  await expect(original).toBeVisible();
  // textContent, not normalized text matching: original whitespace is evidence.
  expect(await original.textContent()).toBe(source.text);
  await expect(page.getByText(source.provenance, { exact: true })).toBeVisible();
  const date = page.locator("time");
  await expect(date).toHaveCount(1);
  await expect(date).toHaveAttribute("datetime", source.createdAt);
  await expect(date).toBeVisible();
  expect((await date.innerText()).trim()).not.toBe("");
  await expect(page.getByRole("status").filter({ hasText: /queued/i })).toBeVisible();
  await expect(page.getByText("Weaving is not configured.", { exact: true })).toBeVisible();
  await expect(page.getByText("Original saved · Queued work waits for your agent service.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("saves the exact original with provenance and date at a reopenable URL", async ({ page, context, request, baseURL }) => {
  const original = `  A thought about intent, not just orchestration.\nKeep this line and its spacing. ${randomUUID()}  `;
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Your thought", exact: true });
  // This is the first intended RED: the runnable placeholder has no capture field.
  await expect(editor).toBeVisible();
  await editor.fill(original);
  const pendingResponse = page.waitForResponse((response) => isCaptureResponse(response, baseURL!));
  await page.getByRole("button", { name: "Save original", exact: true }).focus();
  await page.keyboard.press("Enter");
  const response = await pendingResponse;
  expect(response.status()).toBe(201);
  const input = response.request().postDataJSON() as { text: string; provenance: string };
  expect(input.text).toBe(original);
  expect(typeof input.provenance).toBe("string");
  expect(input.provenance.trim().length).toBeGreaterThan(0);
  const source = await response.json() as Source;
  expect(source).toMatchObject(input);
  expect(source.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(Number.isNaN(Date.parse(source.createdAt))).toBe(false);
  const key = response.request().headers()["idempotency-key"];
  expect(key).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  await assertPersisted(request, source);
  await assertOriginalView(page, source);
  const savedURL = page.url();
  await page.reload();
  await assertOriginalView(page, source);
  const reopened = await context.newPage();
  await reopened.goto(savedURL);
  await assertOriginalView(reopened, source);
  await reopened.close();
});

test("a failed acknowledgement preserves the draft and retries the same capture key", async ({ page, request, baseURL }) => {
  const original = `A draft whose save acknowledgement is interrupted. ${randomUUID()}`;
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Your thought", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill(original);

  const attempts: { key: string | undefined; body: unknown }[] = [];
  let savedBeforeAcknowledgement: Source | undefined;
  await page.route("**/api/captures", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    if (attempts.length === 1) {
      // Real BFF + daemon write succeeds; only the browser's response is replaced.
      // This models an uncertain save outcome without any production failure hook.
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(201);
      savedBeforeAcknowledgement = await upstream.json() as Source;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Save acknowledgement interrupted" }) });
    } else {
      await route.continue();
    }
  });

  await page.getByRole("button", { name: "Save original", exact: true }).click();
  const saveError = page.getByRole("alert").filter({ hasText: /retry|try again/i });
  await expect(saveError).toBeVisible();
  await expect(editor).toHaveValue(original);
  expect(savedBeforeAcknowledgement).toBeDefined();
  await assertPersisted(request, savedBeforeAcknowledgement!);
  const draftStatus = page.locator(".capture-actions").getByRole("status");
  await expect(draftStatus).toContainText(/save (?:unconfirmed|could not be confirmed)/i);
  await expect(draftStatus).toContainText(/draft (?:kept|preserved|is still here)/i);
  await expect(draftStatus).not.toContainText(/not saved/i);
  const retryResponse = page.waitForResponse((response) => isCaptureResponse(response, baseURL!) && response.status() === 200);
  await page.getByRole("button", { name: /^(retry save|save original)$/i }).click();
  const replay = await retryResponse;
  const source = await replay.json() as Source;
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(source).toEqual(savedBeforeAcknowledgement);
  await assertPersisted(request, source);
  await assertOriginalView(page, source);
});
