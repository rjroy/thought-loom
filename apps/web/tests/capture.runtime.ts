import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";

type Mode = "saved" | "hold" | "denied" | "failure" | "malformed";
type Attempt = { method: string | undefined; path: string | undefined; authorization: string | undefined; body: string };
const receipt = { id: "fixture/idea & 1", text: "Canonical daemon thought", title: "Canonical daemon title" };

export function captureDaemon(token: string) {
  let mode: Mode = "saved";
  let release: (() => void) | undefined;
  const attempts: Attempt[] = [];
  return {
    attempts,
    expectedAuthorization: `Bearer ${token}`,
    setMode(next: Mode) { mode = next; },
    release() { release?.(); release = undefined; },
    async handler(request: IncomingMessage, response: ServerResponse) {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      attempts.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
      const current = mode;
      if (current === "hold") await new Promise<void>(resolve => { release = resolve; });
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      if (current === "denied") { response.writeHead(401).end("private fake rejection"); return; }
      if (current === "failure") { response.writeHead(500).end("private fake failure"); return; }
      if (current === "malformed") { response.writeHead(201, { "content-type": "application/json" }).end("{"); return; }
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(receipt));
    },
  };
}

type Fixture = ReturnType<typeof captureDaemon>;
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;
const canopySelector = 'img[src="/backgrounds/capture-canopy.png"]';

// The image may be clipped by its frame; measure only the portion actually painted.
async function paintedCanopy(page: Page) {
  return page.locator(canopySelector).evaluate(image => {
    const original = image.getBoundingClientRect();
    let left = original.left, right = original.right, top = original.top, bottom = original.bottom;
    for (let parent = image.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    const form = document.querySelector("form")?.getBoundingClientRect();
    const main = document.querySelector("main");
    const mainStyle = main && getComputedStyle(main);
    return {
      left, right, top, bottom, width: original.width, height: original.height, x: original.x, y: original.y + window.scrollY,
      form: form ? { right: form.right, width: form.width } : null,
      rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
      innerWidth: main && mainStyle ? main.clientWidth - parseFloat(mainStyle.paddingLeft) - parseFloat(mainStyle.paddingRight) : null,
    };
  });
}

async function checkCanopyLayout(page: Page): Promise<void> {
  const browser = page.context().browser();
  assert.ok(browser, "canopy layout requires an owned browser");
  for (const [width, enlarged] of [[768, false], [769, false], [900, false], [1024, false], [1440, false], [900, true]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const probe = await context.newPage();
      await probe.goto(new URL("/capture", page.url()).href, { waitUntil: "networkidle" });
      if (enlarged) await probe.addStyleTag({ content: "html { font-size: 125% !important; }" });
      const canopy = probe.locator(canopySelector);
      if (width <= 768) { await expect(canopy).not.toBeVisible(); continue; }
      await expect(canopy).toBeVisible();
      await probe.evaluate(() => document.fonts.ready);
      await canopy.evaluate(image => (image as HTMLImageElement).decode());
      let painted: Awaited<ReturnType<typeof paintedCanopy>> | undefined;
      await expect.poll(async () => {
        painted = await paintedCanopy(probe);
        return painted.form !== null && painted.left - painted.form.right >= painted.rootSize;
      }, { timeout: 5000, message: `canopy must clear the form by 1rem at ${width}` }).toBe(true);
      assert.ok(painted?.form && painted.innerWidth);
      assert.ok(painted.right > painted.left && painted.bottom > painted.top, `canopy must have a painted area at ${width}`);
      assert.ok(Math.abs(painted.form.width / painted.innerWidth - 0.87) < 0.01, `form width changed at ${width}`);
      const collisions = await probe.locator('input:visible, textarea:visible, button:visible, a:visible').evaluateAll((controls, rect) => controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return rect.left < bounds.right && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top;
      }).map(control => control.textContent?.trim() || control.getAttribute("aria-label") || control.tagName), painted);
      assert.deepEqual(collisions, [], `canopy overlaps controls at ${width}`);
      if (enlarged) {
        const overlaps = await probe.locator('input:visible, textarea:visible, button:visible, a:visible').evaluateAll(controls => {
          const pairs: string[] = [];
          controls.forEach((first, index) => controls.slice(index + 1).forEach(second => {
            const a = first.getBoundingClientRect(), b = second.getBoundingClientRect();
            if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) pairs.push(`${first.tagName}/${second.tagName}`);
          }));
          return pairs;
        });
        assert.deepEqual(overlaps, [], "enlarged-text controls must not overlap");
      }
      assert.ok(await probe.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}`);
      if (width === 1440 && !enlarged) {
        await probe.goto(new URL("/explore", page.url()).href, { waitUntil: "networkidle" });
        await expect(probe.locator(canopySelector)).toHaveCount(0);
      }
    } finally { await context.close(); }
  }
}
async function waitAttempts(daemon: Fixture, count: number): Promise<void> {
  await expect.poll(() => daemon.attempts.length, { timeout: 5000 }).toBe(count);
}

export async function checkCaptureRoute({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  const body = JSON.stringify({ text: "route fixture words", title: null });
  const content = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
  const start = daemon.attempts.length;
  assert.ok((await probe("POST", "/api/capture", content, body)).status >= 400);
  assert.equal((await probe("POST", "/api/capture", `Host: ${host}\r\n${content}`, body)).status, 403);
  assert.equal((await probe("POST", "/api/capture", `Host: ${host}\r\nOrigin: http://foreign.invalid\r\n${content}`, body)).status, 403);
  assert.equal((await probe("POST", "/api/capture", `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\nOrigin: ${origin}\r\n${content}`, body)).status, 403);
  assert.equal(daemon.attempts.length, start, "rejected browser requests must not reach daemon");
  const response = await fetch(`${origin}/api/capture`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await response.json(), receipt);
  assert.equal(daemon.attempts.length, start + 1);
  const attempt = daemon.attempts[start];
  assert.equal(attempt?.method, "POST");
  assert.equal(attempt?.path, "/thoughts");
  assert.equal(attempt?.authorization, daemon.expectedAuthorization);
  assert.deepEqual(JSON.parse(attempt?.body ?? "null"), { text: "route fixture words", title: null });
}

async function retained(page: Page, value: string): Promise<void> {
  await expect.poll(() => page.evaluate(expected => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
    return inputs.some(input => input.value === expected) || (document.body.innerText.includes(expected));
  }, value), { timeout: 5000 }).toBe(true);
}

export async function checkCaptureBrowser(page: Page, daemon: Fixture): Promise<void> {
  const thought = page.getByRole("textbox", { name: /^thought$/i });
  const title = page.getByRole("textbox", { name: /^title(?:\s*\(optional\))?$/i });
  const save = page.getByRole("button", { name: /^save$/i });
  const heading = page.getByRole("heading", { name: "Capture", exact: true });
  const glyph = heading.locator("img");
  const canopy = page.locator(canopySelector);
  const desktop = (page.viewportSize()?.width ?? 0) > 768;
  await expect(thought).toBeVisible({ timeout: 5000 });
  let placement: Awaited<ReturnType<typeof paintedCanopy>> | undefined;
  if (desktop) {
    await expect(canopy).toHaveCount(1);
    await expect(canopy).toBeVisible();
    await expect(canopy).toHaveAttribute("alt", "");
    assert.equal(await canopy.evaluate(image => !!image.closest('[aria-hidden="true"]')), true);
    assert.equal(await canopy.evaluate(image => image.tabIndex), -1);
    assert.equal(await canopy.evaluate(image => (image as HTMLImageElement).draggable), false);
    await expect(canopy).toHaveCSS("pointer-events", "none");
    await expect.poll(() => canopy.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 392 && image.naturalHeight === 588)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    await canopy.evaluate(image => (image as HTMLImageElement).decode());
    const asset = await page.request.get(new URL("/backgrounds/capture-canopy.png", page.url()).href);
    assert.equal(asset.status(), 200);
    assert.deepEqual(await asset.body(), await readFile(new URL("../../../.impeccable/candidates/capture-canopy/production/capture-canopy.png", import.meta.url)));
    placement = await paintedCanopy(page);
    assert.ok(Math.abs(placement.width - 196) < 1 && Math.abs(placement.height - 294) < 1, "approved display size");
    await checkCanopyLayout(page);
  } else await expect(canopy).not.toBeVisible();
  const unchangedCanopy = async () => {
    if (!placement) { await expect(canopy).not.toBeVisible(); return; }
    await expect(canopy).toBeVisible();
    const current = await paintedCanopy(page);
    for (const key of ["left", "right", "width", "height", "x", "y"] as const) {
      assert.ok(Math.abs(current[key] - placement[key]) < 1, `canopy ${key} changed across Capture states`);
    }
  };
  await expect(glyph).toHaveAttribute("src", "/glyphs/sprout.svg");
  await expect(glyph).toHaveAttribute("alt", "");
  await expect(glyph).toHaveAttribute("aria-hidden", "true");
  await expect(glyph).toHaveCSS("width", "24px");
  await expect(glyph).toHaveCSS("height", "24px");
  await expect(heading).toHaveCSS("column-gap", "8px");
  await expect(heading.getByRole("img")).toHaveCount(0);
  assert.equal(await glyph.evaluate(image => image.tabIndex), -1);
  await expect.poll(() => glyph.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(title).toBeVisible();
  await expect(page.getByText(/optional/i)).toBeVisible();
  await thought.fill("   ");
  const beforeBlank = daemon.attempts.length;
  await save.click();
  const validation = page.locator('#capture-thought-error[role="alert"]');
  await expect(validation).toHaveText("Write a thought before saving.");
  await expect(validation).toBeVisible();
  await unchangedCanopy();
  await page.waitForTimeout(250);
  assert.equal(daemon.attempts.length, beforeBlank, "whitespace must not reach daemon");

  await thought.fill("  exact input\nsecond line  ");
  await unchangedCanopy();
  await title.fill("");
  daemon.setMode("hold");
  const beforeSave = daemon.attempts.length;
  try {
    await save.dblclick({ delay: 40 });
    await waitAttempts(daemon, beforeSave + 1);
    await expect(save).toBeDisabled();
    await expect(glyph).toBeVisible();
    await unchangedCanopy();
    await retained(page, "  exact input\nsecond line  ");
    await page.waitForTimeout(250);
    assert.equal(daemon.attempts.length, beforeSave + 1, "pending double click must not duplicate capture");
    const submitted = JSON.parse(daemon.attempts[beforeSave]?.body ?? "null");
    assert.equal(submitted.text, "  exact input\nsecond line  ");
    assert.ok(submitted.title === undefined || submitted.title === "" || submitted.title === null);
  } finally { daemon.release(); }
  await expect(page.getByText(receipt.text, { exact: true })).toBeVisible();
  await expect(glyph).toBeVisible();
  await unchangedCanopy();
  await expect(page.getByText(receipt.title, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /open idea/i })).toHaveAttribute("href", `/ideas/${encodeURIComponent(receipt.id)}`);
  await page.getByRole("button", { name: /capture another/i }).click();
  await expect(thought).toHaveValue("");
  await expect(title).toHaveValue("");

  await thought.fill("retained denial draft");
  await title.fill("retained denial title");
  daemon.setMode("denied");
  const beforeDenial = daemon.attempts.length;
  await save.click();
  await expect(page.getByText(/not saved/i).first()).toBeVisible();
  await unchangedCanopy();
  await retained(page, "retained denial draft");
  await retained(page, "retained denial title");
  await waitAttempts(daemon, beforeDenial + 1);
  daemon.setMode("saved");
  await page.getByRole("button", { name: /retry save/i }).click();
  await expect(page.getByText(receipt.text, { exact: true })).toBeVisible();
  await waitAttempts(daemon, beforeDenial + 2);
  assert.deepEqual(JSON.parse(daemon.attempts[beforeDenial]?.body ?? "null"), JSON.parse(daemon.attempts[beforeDenial + 1]?.body ?? "null"));
  await page.getByRole("button", { name: /capture another/i }).click();

  for (const mode of ["failure", "malformed"] as const) {
    const draft = `uncertain ${mode} draft`;
    const draftTitle = `uncertain ${mode} title`;
    await thought.fill(draft);
    await title.fill(draftTitle);
    daemon.setMode(mode);
    const before = daemon.attempts.length;
    await save.click();
    await expect(page.getByText(/could not confirm|couldn.t confirm|not sure|uncertain/i).first()).toBeVisible();
    await unchangedCanopy();
    await retained(page, draft);
    await retained(page, draftTitle);
    await expect(page.getByText(/duplicate|another copy|may already/i).first()).toBeVisible();
    const explore = page.locator('a[target="_blank"]').filter({ hasText: /explore/i });
    await expect(explore.first()).toHaveAttribute("href", /\/explore/);
    await waitAttempts(daemon, before + 1);
    await page.waitForTimeout(300);
    assert.equal(daemon.attempts.length, before + 1, "uncertain outcome must not auto-retry");
    daemon.setMode("saved");
    await page.getByRole("button", { name: /save another copy/i }).click();
    await expect(page.getByText(receipt.text, { exact: true })).toBeVisible();
    await waitAttempts(daemon, before + 2);
    assert.deepEqual(JSON.parse(daemon.attempts[before]?.body ?? "null"), JSON.parse(daemon.attempts[before + 1]?.body ?? "null"));
    await page.getByRole("button", { name: /capture another/i }).click();
  }
  daemon.setMode("saved");
}
