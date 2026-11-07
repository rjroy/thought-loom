import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expect, type Browser } from "@playwright/test";

const artwork = [
  { path: "/backgrounds/splash-landscape.webp", bytes: 640898, sha256: "1ce48ed5c1ec9547fc8c6167818a666a3ffe00ca4c4501ef9e0d8b516f8a6192" },
  { path: "/backgrounds/splash-complete.webp", bytes: 114906, sha256: "ec9d6e81e99fc90695aa5e5787a896f5fd3300729122520e08991dc455cf52e8" },
];

// Exercise the built app and actual browser history, not the standalone motion study.
export async function checkRootSplash(browser: Browser, origin: string, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const searches: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/search") searches.push(request.url());
  });
  const skip = () => page.getByRole("button", { name: "Skip intro" });
  const explore = () => page.getByRole("heading", { name: "Explore", exact: true });
  const landed = async () => {
    await page.waitForURL(`${origin}/explore`, { timeout: 7000 });
    await expect(skip()).toHaveCount(0);
    await expect(explore()).toHaveCount(1);
    await expect(explore()).toBeVisible();
  };
  try {
    // Establish a same-origin history predecessor; completion must replace root.
    await page.goto(`${origin}/capture`);
    const start = Date.now();
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(skip()).toBeVisible({ timeout: 1500 });
    assert.equal(new URL(page.url()).pathname, "/", "root must remain the URL during the intro");
    for (const image of artwork) {
      const response = await context.request.get(`${origin}${image.path}`);
      assert.equal(response.status(), 200, `approved splash artwork must be served: ${image.path}`);
      const bytes = await response.body();
      assert.equal(bytes.length, image.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), image.sha256, "splash artwork must match supplied bytes");
    }
    // Only the intro can receive keyboard focus while it is active.
    await page.keyboard.press("Tab");
    await expect(skip()).toBeFocused();
    await expect(page.getByRole("link", { name: "Skip to content" })).toHaveCount(0);
    await landed();
    assert.ok(Date.now() - start >= 1500, "ordinary motion must not bypass the approved sequence");
    const search = page.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i });
    await search.focus();
    await expect(search).toBeFocused();
    assert.deepEqual(searches, [], "the intro and blank Explore must not issue searches");
    await page.goBack();
    await page.waitForURL(`${origin}/capture`);
    await expect(skip()).toHaveCount(0);

    // Explicit root arrivals replay, while skip replaces root and clears timers.
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(skip()).toBeVisible({ timeout: 1500 });
    await skip().click();
    await landed();
    await page.getByRole("link", { name: "Capture", exact: true }).click();
    await page.waitForURL(`${origin}/capture`);
    await page.waitForTimeout(2700);
    assert.equal(new URL(page.url()).pathname, "/capture", "a stale completion must not navigate after skip");
    await page.goBack();
    await page.waitForURL(`${origin}/explore`);
    await expect(skip()).toHaveCount(0);

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(skip()).toBeVisible({ timeout: 1500 });
    await page.keyboard.press("Escape");
    await landed();
    // Escape is not retained as a global shortcut after leaving the intro.
    await page.getByRole("link", { name: "Capture", exact: true }).click();
    await page.waitForURL(`${origin}/capture`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2700);
    assert.equal(new URL(page.url()).pathname, "/capture");

    await page.goto(`${origin}/explore`);
    await expect(explore()).toHaveCount(1);
    await expect(skip()).toHaveCount(0);
    await page.goto(`${origin}/explore/ask`);
    await expect(skip()).toHaveCount(0);

    // Leaving before completion must cancel both its timer and Escape handler.
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(skip()).toBeVisible({ timeout: 1500 });
    await page.goto(`${origin}/capture`);
    await page.waitForTimeout(2700);
    assert.equal(new URL(page.url()).pathname, "/capture", "unmounted intro must not navigate later");
  } finally { await context.close(); }

  // Keep the real root entry in client-side history by leaving the first intro
  // through the actual Capture link, then return to it with browser history.
  // HTMLElement.click intentionally bypasses the intro's inert shell: there is
  // no user-facing link to root, and normal Skip would replace that entry.
  const warm = await browser.newContext({ viewport });
  try {
    const warmPage = await warm.newPage();
    const calls: string[] = [];
    warmPage.on("request", request => {
      if (new URL(request.url()).pathname === "/api/search") calls.push(request.url());
    });
    await warmPage.goto(`${origin}/capture`);
    await warmPage.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(warmPage.getByRole("button", { name: "Skip intro" })).toBeVisible({ timeout: 1500 });
    await warmPage.evaluate(() => { document.documentElement.dataset.warmRootDocument = "owned"; });
    const captureLink = warmPage.locator('header a[href="/capture"]');
    await expect(captureLink).toHaveCount(1);
    await captureLink.evaluate(link => (link as HTMLAnchorElement).click());
    await warmPage.waitForURL(`${origin}/capture`);
    assert.equal(await warmPage.locator("html").getAttribute("data-warm-root-document"), "owned", "Capture must be a client navigation");
    await warmPage.getByRole("link", { name: "Explore", exact: true }).click();
    await warmPage.waitForURL(`${origin}/explore`);
    const field = warmPage.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i });
    await field.fill("owned");
    await warmPage.getByRole("button", { name: /^search$/i }).click();
    await expect(warmPage.getByText("Owned development").first()).toBeVisible();
    const savedUrl = warmPage.url();
    assert.equal(new URL(savedUrl).searchParams.get("q"), "owned");
    await warmPage.getByRole("button", { name: /expand|show more|read more/i }).first().click();
    await expect(warmPage.getByText(/End of owned matching thought\./)).toBeVisible();
    await warmPage.evaluate(async () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      // Let the browser deliver the scroll event to the workspace listener.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect.poll(() => warmPage.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const savedScroll = await warmPage.evaluate(() => window.scrollY);
    await expect(captureLink).toBeInViewport({ ratio: 1 });
    await captureLink.evaluate(link => link.addEventListener("click", () => {
      document.documentElement.dataset.warmCaptureClickScroll = String(window.scrollY);
    }, { capture: true, once: true }));
    await captureLink.click();
    const clickScrollAttribute = await warmPage.locator("html").getAttribute("data-warm-capture-click-scroll");
    assert.notEqual(clickScrollAttribute, null, "Capture click must reach the real navigation link");
    const clickScroll = Number(clickScrollAttribute);
    assert.ok(Math.abs(clickScroll - savedScroll) <= 2, "Capture navigation must start at the saved reading position");
    await warmPage.waitForURL(`${origin}/capture`);
    const beforeReturn = calls.length;
    // root -> Capture -> Explore -> search URL -> Capture
    await warmPage.evaluate(() => history.go(-4));
    await warmPage.waitForURL(`${origin}/`, { timeout: 5000 });
    await expect(warmPage.getByRole("button", { name: "Skip intro" })).toBeVisible({ timeout: 1500 });
    assert.equal(await warmPage.locator("html").getAttribute("data-warm-root-document"), "owned", "history return must retain the provider's document");
    assert.equal(new URL(warmPage.url()).pathname, "/", "remembered Explore must not replace root during the intro");
    await expect(warmPage.getByText("Owned development").first()).toHaveCount(1);
    assert.equal(calls.length, beforeReturn, "root presentation must not repeat a completed search");
    await warmPage.getByRole("button", { name: "Skip intro" }).click();
    await expect.poll(() => warmPage.url(), { timeout: 7000 }).toBe(savedUrl);
    await expect(warmPage.getByRole("button", { name: "Skip intro" })).toHaveCount(0);
    await expect(field).toHaveValue("owned");
    await expect(warmPage.getByText(/End of owned matching thought\./)).toBeVisible();
    await expect.poll(async () => Math.abs(await warmPage.evaluate(() => window.scrollY) - savedScroll), { timeout: 5000 }).toBeLessThanOrEqual(2);
    assert.equal(calls.length, beforeReturn, "restoring completed results must not repeat the search");
    await warmPage.goBack();
    await warmPage.waitForURL(`${origin}/capture`);
    await expect(warmPage.getByRole("button", { name: "Skip intro" })).toHaveCount(0);
  } finally { await warm.close(); }

  const reduced = await browser.newContext({ viewport, reducedMotion: "reduce" });
  try {
    const reducedPage = await reduced.newPage();
    await reducedPage.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await reducedPage.waitForURL(`${origin}/explore`, { timeout: 1500 });
    await expect(reducedPage.getByRole("button", { name: "Skip intro" })).toHaveCount(0);
    await expect(reducedPage.getByRole("heading", { name: "Explore", exact: true })).toHaveCount(1);
  } finally { await reduced.close(); }

  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const noScript = await browser.newContext({ viewport, javaScriptEnabled: false, reducedMotion });
    try {
      const fallback = await noScript.newPage();
      await fallback.goto(`${origin}/`);
      // A genuine link remains keyboard-usable even if hydration never happens.
      const link = fallback.getByRole("link", { name: /explore/i }).first();
      await expect(link).toBeVisible();
      for (let i = 0; i < 10 && !(await link.evaluate(node => node === document.activeElement)); i++) {
        await fallback.keyboard.press("Tab");
      }
      await expect(link).toBeFocused();
      await fallback.keyboard.press("Enter");
      await fallback.waitForURL(`${origin}/explore`);
      await expect(fallback.getByRole("heading", { name: "Explore", exact: true })).toBeVisible();
    } finally { await noScript.close(); }
  }

  for (const image of artwork) {
    const failed = await browser.newContext({ viewport });
    try {
      const fallback = await failed.newPage();
      await fallback.route(`**${image.path}`, route => route.abort("failed"));
      await fallback.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await fallback.waitForURL(`${origin}/explore`, { timeout: 7000 });
      await expect(fallback.getByRole("heading", { name: "Explore", exact: true })).toBeVisible();
      await expect(fallback.getByRole("button", { name: "Skip intro" })).toHaveCount(0);
    } finally { await failed.close(); }
  }
}
