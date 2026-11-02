import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { accessHost } from "../fixtures/access-host";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const webPort = process.env.THOUGHTLOOM_E2E_WEB_PORT ?? "4317";
const daemonPort = process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318";
const origin = `http://${accessHost}:${webPort}`;
const daemon = `http://127.0.0.1:${daemonPort}`;

// Resolve only the fixture name to our loopback listener. Chromium still sees
// the actual non-loopback HTTP origin, with normal secure-context rules.
test.use({ launchOptions: {
  executablePath: process.env.THOUGHTLOOM_CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: [`--host-resolver-rules=MAP ${accessHost} 127.0.0.1`, "--no-proxy-server"],
} });

async function recordBrowserCapabilities(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("http-test-crypto", JSON.stringify({
      secure: window.isSecureContext,
      randomUUID: typeof crypto.randomUUID,
      subtle: typeof crypto.subtle,
      getRandomValues: typeof crypto.getRandomValues,
    }));
  });
}

async function expectOrdinaryHttp(page: Page) {
  expect(new URL(page.url()).origin).toBe(origin);
  const value = await page.evaluate(() => sessionStorage.getItem("http-test-crypto"));
  expect(value && JSON.parse(value)).toEqual({ secure: false, randomUUID: "undefined", subtle: "undefined", getRandomValues: "function" });
}

test("HTTP capture retries an unconfirmed save with the same idempotency key", async ({ page, request }) => {
  await recordBrowserCapabilities(page);
  await page.goto(`${origin}/`);
  await expectOrdinaryHttp(page);
  const text = "HTTP fixture: keep this exact original and retry its receipt.";
  const attempts: { key: string | undefined; body: unknown }[] = [];
  await page.route("**/api/captures", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (attempts.length !== 1) return route.continue();
    const key = attempts[0].key;
    if (!key) throw new Error("Capture request omitted its idempotency key");
    // The runner's API client does not use Chromium's DNS rule. Forward to the
    // same loopback BFF while preserving the browser's authority and payload.
    const response = await request.post("/api/captures", { headers: { host: `${accessHost}:${webPort}`, origin, "content-type": "application/json", "idempotency-key": key }, data: route.request().postData() ?? "" });
    expect(response.status()).toBe(201);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture acknowledgement lost" }) });
  });
  const editor = page.getByRole("textbox", { name: "Your thought", exact: true });
  await editor.fill(text);
  await page.getByRole("button", { name: "Save original", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /retry|try again/i })).toBeVisible();
  await expect(editor).toHaveValue(text);
  const replay = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/captures" && response.request().method() === "POST" && response.status() === 200);
  await page.getByRole("button", { name: /^(retry save|save original)$/i }).click();
  await replay;
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(page.getByRole("article", { name: "Original thought", exact: true })).toHaveText(text);
});

test("HTTP discussion opens with its stable context key and sends a thought", async ({ page, request }) => {
  const fixture = await request.post(`${daemon}/__browser/dialogue/world`, { data: { empty: true } });
  expect(fixture.status()).toBe(200);
  const { root } = await fixture.json() as BrowserDialogueMetadata;
  try {
    await recordBrowserCapabilities(page);
    const creation = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${root.id}/dialogues` && response.request().method() === "POST");
    await page.goto(`${origin}/sources/${root.id}/inquiry#development`);
    await expectOrdinaryHttp(page);
    const response = await creation;
    expect([200, 201]).toContain(response.status());
    const selection = { kind: "source", id: root.id };
    const identity = JSON.stringify(["source", root.id]);
    const key = `discussion_${createHash("sha256").update(JSON.stringify(["thoughtloom-context-v1", root.id, identity])).digest("hex")}`;
    expect(response.request().headers()["idempotency-key"]).toBe(key);
    expect(response.request().postDataJSON()).toEqual({ selection });
    const send = page.waitForResponse((item) => /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(item.url()).pathname) && item.request().method() === "POST");
    await page.getByRole("textbox", { name: "Develop this thought", exact: true }).fill("A thought sent from ordinary HTTP.");
    await page.getByRole("button", { name: "Send thought", exact: true }).click();
    const sent = await send;
    expect([200, 201]).toContain(sent.status());
    expect(sent.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
  } finally {
    const reset = await request.post(`${daemon}/__browser/dialogue/reset`, { data: {} });
    expect(reset.status()).toBe(200);
  }
});
