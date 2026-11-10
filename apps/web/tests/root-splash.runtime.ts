import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expect, type Browser, type Page } from "@playwright/test";

const artwork = [
  { path: "/backgrounds/splash-landscape.webp", bytes: 640898, sha256: "1ce48ed5c1ec9547fc8c6167818a666a3ffe00ca4c4501ef9e0d8b516f8a6192" },
  { path: "/backgrounds/splash-complete.webp", bytes: 114906, sha256: "ec9d6e81e99fc90695aa5e5787a896f5fd3300729122520e08991dc455cf52e8" },
];

type HandoffFrame = {
  path: string;
  overlayOpacity: number;
  controls: { label: string; checked: boolean; count: string }[] | null;
  status: string;
  query: string | null;
  queryVisible: boolean;
  geometry: { left: number; width: number } | null;
  filterGeometry: { left: number; top: number; width: number; height: number } | null;
};

// Sample every painted frame, including the read-only presentation beneath the
// dissolve and the independently mounted active Explore view.
async function beginHandoffSamples(page: Page) {
  await page.evaluate(() => {
    const state = { frames: [] as HandoffFrame[], active: true };
    (window as unknown as { handoffSamples: typeof state }).handoffSamples = state;
    const sample = () => {
      if (!state.active) return;
      const filters = document.querySelector<HTMLElement>("#explore-filters");
      const view = filters?.closest("section");
      const input = view?.querySelector<HTMLInputElement>("#explore-query");
      const main = document.querySelector("main");
      const overlay = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-root-splash] button')).find(button => button.textContent?.trim() === "Skip intro")?.parentElement?.parentElement;
      const opacity = overlay && getComputedStyle(overlay).visibility !== "hidden" ? Number(getComputedStyle(overlay).opacity) : 0;
      const box = input?.getBoundingClientRect(), filterBox = filters && getComputedStyle(filters).display !== "none" ? filters.getBoundingClientRect() : null, parent = main?.getBoundingClientRect();
      let queryVisible = Boolean(input && box && box.width > 0 && box.height > 0);
      for (let node: Element | null = input ?? null; node && queryVisible; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) queryVisible = false;
      }
      state.frames.push({
        path: location.pathname,
        overlayOpacity: opacity,
        controls: filters ? Array.from(filters.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).map(control => {
          const label = control.closest("label");
          return { label: label?.querySelector("span")?.textContent?.trim() ?? "", checked: control.checked, count: label?.querySelectorAll("span")[1]?.textContent?.trim() ?? "" };
        }) : null,
        status: view?.querySelector('[role="status"]')?.textContent?.trim() ?? "",
        query: input?.value ?? null,
        queryVisible,
        geometry: box && parent ? { left: box.left - parent.left, width: box.width } : null,
        filterGeometry: filterBox && parent ? { left: filterBox.left - parent.left, top: filterBox.top - parent.top, width: filterBox.width, height: filterBox.height } : null,
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
}

async function endHandoffSamples(page: Page): Promise<HandoffFrame[]> {
  return page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const state = (window as unknown as { handoffSamples: { frames: HandoffFrame[]; active: boolean } }).handoffSamples;
    state.active = false;
    return state.frames;
  });
}

async function reportHandoffFailure(page: Page, scenario: string, calls: string[]) {
  const browserState = await page.evaluate(() => {
    const samples = (window as unknown as { handoffSamples?: { frames: HandoffFrame[]; active: boolean } }).handoffSamples;
    if (samples) samples.active = false;
    return { url: location.href, scrollY, scrollHeight: document.documentElement.scrollHeight, innerHeight, frames: samples?.frames ?? [] };
  }).catch(error => ({ unavailable: String(error) }));
  console.error(`Root splash handoff diagnostics: ${JSON.stringify({ scenario, viewport: page.viewportSize(), calls, browserState })}`);
}

function expectVisibleHandoff(frames: HandoffFrame[], expected: HandoffFrame, completed: boolean) {
  assert.ok(frames.some(frame => frame.path === "/"), "sample the root presentation");
  assert.ok(frames.some(frame => frame.path === "/explore"), "sample the active Explore route");
  // Fully opaque intro frames need not expose a mounted presentation. Once it
  // starts revealing Explore, controls and their data must remain continuous.
  for (const frame of frames.filter(frame => frame.overlayOpacity < 0.99)) {
    const selection = (controls: HandoffFrame["controls"]) => controls?.map(({ label, checked }) => ({ label, checked }));
    assert.deepEqual(selection(frame.controls), selection(expected.controls), `filter selection changed in ${JSON.stringify(frame)}`);
    if (completed) {
      assert.deepEqual(frame.controls, expected.controls, `completed facet counts changed in ${JSON.stringify(frame)}`);
      assert.equal(frame.status, expected.status, `completed result status changed in ${JSON.stringify(frame)}`);
    }
    assert.equal(frame.query, expected.query, `query changed in ${JSON.stringify(frame)}`);
    assert.ok(frame.queryVisible, `query control not rendered visibly: ${JSON.stringify(frame)}`);
    assert.ok(frame.geometry && expected.geometry, `missing query geometry: ${JSON.stringify(frame)}`);
    assert.ok(Math.abs(frame.geometry.left - expected.geometry.left) <= 2 && Math.abs(frame.geometry.width - expected.geometry.width) <= 2,
      `query geometry shifted across handoff: ${JSON.stringify(frame.geometry)} vs ${JSON.stringify(expected.geometry)}`);
    if (expected.filterGeometry) {
      assert.ok(frame.filterGeometry, `visible filters disappeared: ${JSON.stringify(frame)}`);
      for (const key of ["left", "top", "width", "height"] as const) {
        assert.ok(Math.abs(frame.filterGeometry[key] - expected.filterGeometry[key]) <= 2,
          `filter geometry shifted across handoff: ${JSON.stringify(frame.filterGeometry)} vs ${JSON.stringify(expected.filterGeometry)}`);
      }
    } else {
      assert.equal(frame.filterGeometry, null, `filters unexpectedly opened: ${JSON.stringify(frame)}`);
    }
  }
}

/** Hold only chunks unique to the destination's generated ExploreView manifest. */
export async function checkRootSplashChunkHandoff(browser: Browser, origin: string, chunks: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const held: string[] = [], searches: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failure: unknown;
  let sampling = false;
  try {
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/search") searches.push(request.url()); });
    await page.route("**/_next/static/chunks/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (chunks.includes(pathname)) { held.push(pathname); await gate; }
      await route.continue().catch(() => { /* A superseded prefetch can be cancelled. */ });
    });
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Skip intro" })).toBeVisible();
    await expect(page.locator("#explore-query")).toHaveCount(1);
    await beginHandoffSamples(page);
    sampling = true;
    await expect.poll(() => held.length, { timeout: 10_000, message: `Expected a destination-only chunk request: ${JSON.stringify(chunks)}` }).toBeGreaterThan(0);
    // A pending navigation can retain the root tree after finish() hides the
    // overlay. Observe the visual boundary, not removal of its DOM button.
    await page.waitForFunction(() => {
      const overlay = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-root-splash] button')).find(button => button.textContent?.trim() === "Skip intro")?.parentElement?.parentElement;
      return !overlay || getComputedStyle(overlay).visibility === "hidden";
    }, null, { timeout: 10_000 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(new URL(page.url()).pathname, "/", "root route must remain mounted while destination code is held");
    await expect(page.locator("[data-root-splash]")).toHaveCount(1);
    assert.ok(await page.locator("#explore-query").isVisible(), "Explore controls must remain visible while destination code is pending");
  } catch (error) {
    failure = error;
    await reportHandoffFailure(page, "fresh-destination-chunk-held", searches);
  } finally {
    release?.();
    try {
      await page.waitForURL(`${origin}/explore`, { timeout: 10_000 });
      await expect(page.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i })).toBeVisible();
      await expect(page.locator("[data-root-splash]")).toHaveCount(0);
      if (sampling && !failure) {
        const frames = await endHandoffSamples(page);
        const revealed = frames.filter(frame => frame.overlayOpacity < 0.99);
        assert.ok(revealed.length > 0, "sample the revealed Explore handoff");
        assert.ok(revealed.every(frame => frame.controls && frame.query !== null && frame.queryVisible), "revealed Explore controls must remain visible in every sampled frame");
      }
      assert.deepEqual(searches, [], "a blank handoff must not search");
    } catch (error) {
      if (!failure) {
        failure = error;
        await reportHandoffFailure(page, "fresh-destination-chunk-released", searches);
      }
    } finally { await context.close(); }
  }
  if (failure) throw failure;
}

// Exercise the built app and actual browser history, not the standalone motion study.
export async function checkRootSplash(browser: Browser, origin: string, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript(() => {
    type Sample = { connected: boolean; visible: boolean; opacity: string; visibility: string; display: string };
    const samples: Sample[] = [];
    const save = (target: Element) => {
      const style = getComputedStyle(target);
      let visible = target.isConnected;
      for (let node: Element | null = target; node; node = node.parentElement) {
        const current = getComputedStyle(node);
        if (current.display === "none" || current.visibility !== "visible" || Number(current.opacity) === 0) visible = false;
      }
      samples.push({ connected: target.isConnected, visible, opacity: style.opacity, visibility: style.visibility, display: style.display });
      document.documentElement.dataset.splashCompletionSamples = JSON.stringify(samples);
    };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.querySelector('button')?.textContent === "Skip intro") {
        const target = this;
        animation.finished.then(() => {
          // Also observe implementations that keep the finished fill rather than cancel it.
          queueMicrotask(() => save(target));
        }).catch(() => {});
      }
      return animation;
    };
    const cancel = Animation.prototype.cancel;
    Animation.prototype.cancel = function () {
      const target = this.effect instanceof KeyframeEffect ? this.effect.target : null;
      const completedOverlay = this.playState === "finished" && target instanceof Element && target.querySelector('button')?.textContent === "Skip intro";
      cancel.call(this);
      // Read synchronously: React may remove the overlay before the next frame.
      if (completedOverlay && target instanceof Element) save(target);
    };
  });
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
    // Seed history without mounting the app or prefetching the destination.
    await page.goto(`${origin}/fonts/OFL.txt`);
    const start = Date.now();
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(skip()).toBeVisible({ timeout: 1500 });
    await beginHandoffSamples(page);
    try {
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
      await expect(page.getByRole("heading", { name: "Find your recorded thinking" })).toBeVisible();
      const frames = await endHandoffSamples(page);
      const initial = frames.find(frame => frame.path === "/" && frame.controls && frame.geometry);
      assert.ok(initial, `fresh root presentation not sampled: ${JSON.stringify({ frames, calls: searches })}`);
      expectVisibleHandoff(frames, initial, false);
      const completionSamples = await page.locator("html").getAttribute("data-splash-completion-samples");
      assert.ok(completionSamples, "ordinary playback must complete the overlay dissolve");
      const samples: { connected: boolean; visible: boolean; opacity: string; visibility: string; display: string }[] = JSON.parse(completionSamples);
      assert.ok(samples.every(sample => !sample.connected || !sample.visible), `completed splash must not become visible before removal: ${completionSamples}`);
      assert.ok(Date.now() - start >= 1500, "ordinary motion must not bypass the approved sequence");
      const search = page.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i });
      await search.focus();
      await expect(search).toBeFocused();
      assert.deepEqual(searches, [], "the intro and blank Explore must not issue searches");
    } catch (error) {
      await reportHandoffFailure(page, "fresh-timed-dissolve", searches);
      throw error;
    }
    await page.goBack();
    await page.waitForURL(`${origin}/fonts/OFL.txt`);
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

  // Delay both destination prefetch and navigation Flight responses. Next can
  // request a fresh Flight when a prefetch is still pending, so hold both.
  const delayed = await browser.newContext({ viewport });
  const delayedPage = await delayed.newPage();
  const delayedCalls: string[] = [];
  let releaseFlight: (() => void) | undefined;
  const flightGate = new Promise<void>(resolve => { releaseFlight = resolve; });
  let navigationFlight = false;
  try {
    delayedPage.on("request", request => { if (new URL(request.url()).pathname === "/api/search") delayedCalls.push(request.url()); });
    await delayedPage.route("**/explore?_rsc=*", async route => {
      const headers = route.request().headers();
      if (headers["next-router-segment-prefetch"] !== "/_tree") {
        if (!headers["next-router-prefetch"]) navigationFlight = true;
        await flightGate;
      }
      await route.continue().catch(() => { /* A superseded prefetch can be cancelled. */ });
    });
    await delayedPage.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(delayedPage.getByRole("button", { name: "Skip intro" })).toBeVisible();
    await beginHandoffSamples(delayedPage);
    await delayedPage.getByRole("button", { name: "Skip intro" }).click();
    await expect.poll(() => navigationFlight).toBe(true);
    await expect(delayedPage.getByRole("heading", { name: "Find your recorded thinking", includeHidden: true })).toHaveCount(1);
    releaseFlight?.();
    await delayedPage.waitForURL(`${origin}/explore`, { timeout: 7000 });
    await expect(delayedPage.getByRole("heading", { name: "Find your recorded thinking" })).toBeVisible();
    const frames = await endHandoffSamples(delayedPage);
    const initial = frames.find(frame => frame.path === "/" && frame.controls && frame.geometry);
    assert.ok(initial, "delayed Flight must start with the root Explore presentation");
    expectVisibleHandoff(frames, initial, false);
  } catch (error) {
    await reportHandoffFailure(delayedPage, "fresh-delayed-flight", delayedCalls);
    throw error;
  } finally {
    releaseFlight?.();
    await delayed.close();
  }

  // Keep the real root entry in client-side history by leaving the first intro
  // through the actual Capture link, then return to it with browser history.
  // HTMLElement.click intentionally bypasses the intro's inert shell: there is
  // no user-facing link to root, and normal Skip would replace that entry.
  const warm = await browser.newContext({ viewport });
  const warmPage = await warm.newPage();
  const warmCalls: string[] = [];
  try {
    warmPage.on("request", request => {
      if (new URL(request.url()).pathname === "/api/search") warmCalls.push(request.url());
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
    const narrowFilters = warmPage.getByRole("button", { name: /^filters(?:\s*\(\d+\))?$/i });
    if (await narrowFilters.isVisible()) await narrowFilters.click();
    const ai = warmPage.getByRole("group", { name: "Authorship" }).getByRole("checkbox", { name: /^ai(?:\s|$)/i });
    const developing = warmPage.getByRole("checkbox", { name: /developing ideas/i });
    await ai.check();
    await expect(ai).toHaveAccessibleName(/2\s*$/);
    await developing.check();
    await expect(developing).toHaveAccessibleName(/2\s*$/);
    await expect(warmPage.getByRole("heading", { name: /2 results for/i })).toBeVisible();
    const savedUrl = warmPage.url();
    assert.equal(new URL(savedUrl).searchParams.get("q"), "owned");
    assert.deepEqual(new URL(savedUrl).searchParams.getAll("author"), ["ai"]);
    assert.deepEqual(new URL(savedUrl).searchParams.getAll("kind"), ["developing-idea"]);
    // The narrow filter disclosure is transient and starts closed on the new
    // mount. Close it before measuring a restorable reading position.
    if (await narrowFilters.isVisible()) await warmPage.getByRole("button", { name: "Close filters" }).click();
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
    const beforeReturn = warmCalls.length;
    // root -> Capture -> Explore -> search -> author -> kind -> Capture
    await warmPage.evaluate(() => history.go(-6));
    await warmPage.waitForURL(`${origin}/`, { timeout: 5000 });
    await expect(warmPage.getByRole("button", { name: "Skip intro" })).toBeVisible({ timeout: 1500 });
    assert.equal(await warmPage.locator("html").getAttribute("data-warm-root-document"), "owned", "history return must retain the provider's document");
    assert.equal(new URL(warmPage.url()).pathname, "/", "remembered Explore must not replace root during the intro");
    await expect(warmPage.getByText("Owned development").first()).toHaveCount(1);
    assert.equal(warmCalls.length, beforeReturn, "root presentation must not repeat a completed search");
    await beginHandoffSamples(warmPage);
    await warmPage.getByRole("button", { name: "Skip intro" }).click();
    await expect.poll(() => warmPage.url(), { timeout: 7000 }).toBe(savedUrl);
    await expect(warmPage.getByRole("button", { name: "Skip intro" })).toHaveCount(0);
    await expect(field).toHaveValue("owned");
    await expect(warmPage.getByText(/End of owned matching thought\./)).toBeVisible();
    await expect.poll(async () => Math.abs(await warmPage.evaluate(() => window.scrollY) - savedScroll), { timeout: 5000 }).toBeLessThanOrEqual(2);
    const frames = await endHandoffSamples(warmPage);
    const initial = frames.find(frame => frame.path === "/" && frame.controls && frame.geometry);
    assert.ok(initial, `warm root presentation not sampled: ${JSON.stringify({ frames, calls: warmCalls })}`);
    assert.deepEqual(initial.controls?.filter(control => control.checked).map(control => control.label), ["AI", "Developing ideas"]);
    expectVisibleHandoff(frames, initial, true);
    assert.equal(warmCalls.length, beforeReturn, "restoring completed results must not repeat the search");
    await warmPage.goBack();
    await warmPage.waitForURL(`${origin}/capture`);
    await expect(warmPage.getByRole("button", { name: "Skip intro" })).toHaveCount(0);
  } catch (error) {
    await reportHandoffFailure(warmPage, "warm-completed-filtered", warmCalls);
    throw error;
  } finally { await warm.close(); }

  // A pending filtered search is aborted on leaving Explore and may need a
  // new request on return. It must not lose the selected filters while loading.
  const pending = await browser.newContext({ viewport });
  const pendingPage = await pending.newPage();
  const pendingCalls: string[] = [];
  let releaseHeld: (() => void) | undefined;
  try {
    pendingPage.on("request", request => { if (new URL(request.url()).pathname === "/api/search") pendingCalls.push(request.url()); });
    await pendingPage.goto(`${origin}/`);
    await expect(pendingPage.getByRole("button", { name: "Skip intro" })).toBeVisible();
    await pendingPage.locator('header a[href="/capture"]').evaluate(link => (link as HTMLAnchorElement).click());
    await pendingPage.waitForURL(`${origin}/capture`);
    await pendingPage.getByRole("link", { name: "Explore", exact: true }).click();
    const field = pendingPage.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i });
    await field.fill("owned");
    await pendingPage.getByRole("button", { name: /^search$/i }).click();
    await expect(pendingPage.getByText("Owned development").first()).toBeVisible();
    const narrowFilters = pendingPage.getByRole("button", { name: /^filters(?:\s*\(\d+\))?$/i });
    if (await narrowFilters.isVisible()) await narrowFilters.click();
    let held = false;
    await pendingPage.route("**/api/search?*", async route => {
      if (!held && new URL(route.request().url()).searchParams.getAll("author").includes("ai")) {
        held = true;
        await new Promise<void>(resolve => { releaseHeld = resolve; });
      }
      await route.continue().catch(() => { /* The abandoned request can already be aborted. */ });
    });
    await pendingPage.getByRole("group", { name: "Authorship" }).getByRole("checkbox", { name: /^ai(?:\s|$)/i }).check();
    await expect.poll(() => held).toBe(true);
    await expect(pendingPage.getByRole("heading", { name: "Searching…" })).toBeVisible();
    await pendingPage.locator('header a[href="/capture"]').click();
    await pendingPage.waitForURL(`${origin}/capture`);
    // root -> Capture -> Explore -> search -> author -> Capture
    await pendingPage.evaluate(() => history.go(-5));
    await pendingPage.waitForURL(`${origin}/`);
    await expect(pendingPage.getByRole("button", { name: "Skip intro" })).toBeVisible();
    const beforeReturn = pendingCalls.length;
    await beginHandoffSamples(pendingPage);
    await pendingPage.getByRole("button", { name: "Skip intro" }).click();
    await expect(pendingPage.getByText("Owned development").first()).toBeVisible();
    const frames = await endHandoffSamples(pendingPage);
    assert.ok(frames.some(frame => frame.path === "/") && frames.some(frame => frame.path === "/explore"));
    for (const frame of frames.filter(frame => frame.overlayOpacity < 0.99)) {
      assert.equal(frame.query, "owned", `pending query changed: ${JSON.stringify(frame)}`);
      assert.deepEqual(frame.controls?.filter(control => control.checked).map(control => control.label), ["AI"], `pending filter changed: ${JSON.stringify(frame)}`);
      assert.match(frame.status, /Searching…|2 results for/, `pending status disappeared: ${JSON.stringify(frame)}`);
    }
    assert.ok(pendingCalls.slice(beforeReturn).some(call => new URL(call).searchParams.getAll("author").includes("ai")), "pending search must be resumed");
  } catch (error) {
    await reportHandoffFailure(pendingPage, "warm-in-flight-filtered", pendingCalls);
    throw error;
  } finally {
    releaseHeld?.();
    await pending.close();
  }

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
