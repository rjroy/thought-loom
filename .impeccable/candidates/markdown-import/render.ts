import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Verify the selected design only. Never overwrite an approved image.
const root = process.cwd(), packet = resolve(root, ".impeccable/candidates/markdown-import");
const require = createRequire(resolve(root, "apps/web/package.json"));
const { chromium, expect } = require("@playwright/test");
const manifest = JSON.parse(readFileSync(resolve(packet, "manifest.json"), "utf8"));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const evidence = mkdtempSync("/tmp/opencode/thoughtloom-import-selected-");
const prefix = "/.impeccable/candidates/markdown-import/", origin = "http://thoughtloom-design.invalid";
const allow = new Map<string, string>();
for (const name of ["study.html", "index.html", "README.md", "manifest.json", ...manifest.images.map((image: any) => image.name + ".png")]) allow.set(prefix + name, resolve(packet, name));
allow.set("/.impeccable/brand/fonts/SourceSans3-VariableFont_wght.ttf", resolve(root, ".impeccable/brand/fonts/SourceSans3-VariableFont_wght.ttf"));
for (const item of [...manifest.sourceFiles, ...manifest.references, ...manifest.images, ...manifest.previousApprovedPngs]) assert.equal(hash(resolve(root, item.path)), item.sha256, "identity: " + item.path);
assert.equal(manifest.images.length, 6);
assert.ok(manifest.approval.approved && manifest.images.every((image: any) => image.approved));
const results: any[] = [], errors: string[] = [];
let browser: any, writes = 0, unexpectedRequests = 0;

async function newPage(width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.route("**/*", async (route: any) => {
    const request = route.request(), url = new URL(request.url()), path = url.origin === origin ? allow.get(url.pathname) : undefined;
    if (request.method() !== "GET") { writes++; await route.fulfill({ status: 405, body: "No writes in this design study" }); return; }
    if (url.pathname === "/favicon.ico") { await route.fulfill({ status: 204 }); return; }
    if (!path || !existsSync(path)) { unexpectedRequests++; await route.fulfill({ status: 404, body: "Outside the selected packet" }); return; }
    const contentType = path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".ttf") ? "font/ttf" : path.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
    await route.fulfill({ status: 200, contentType, body: readFileSync(path) });
  });
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => errors.push(error.message));
  return { page, context };
}

try {
  browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--disable-gpu"] });
  for (const image of manifest.images) {
    const { width, height } = image.viewport, { page, context } = await newPage(width, height);
    await page.goto(`${origin}${prefix}study.html?state=${image.state}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width: width + 1, height }); await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.evaluate(() => document.fonts.check('18px "Source Sans 3"')));
    let entryGeometry: any = null;
    if (image.state === "entry") {
      const button = page.getByRole("button", { name: "Import", exact: true });
      entryGeometry = await button.evaluate((el: HTMLElement) => {
        const heading = document.getElementById("capture-heading")!, b = el.getBoundingClientRect(), h = heading.getBoundingClientRect();
        return { inForm: !!el.closest("form"), inNav: !!el.closest("nav"), inHeading: !!el.closest(".capture-heading"), width: b.width, height: b.height, rightOfHeading: b.left >= h.right, centers: Math.abs(b.top + b.height / 2 - h.top - h.height / 2) };
      });
      assert.ok(!entryGeometry.inForm && !entryGeometry.inNav && entryGeometry.inHeading && entryGeometry.rightOfHeading);
      assert.ok(entryGeometry.width >= 44 && entryGeometry.height >= 44 && entryGeometry.centers < 1);
      await button.focus(); await page.keyboard.press("Tab"); await expect(page.getByRole("textbox", { name: "Thought", exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab"); await expect(button).toBeFocused();
      assert.equal(await button.evaluate((el: HTMLElement) => getComputedStyle(el).outlineWidth), "3px");
    } else {
      assert.equal(await page.locator(".file-list > li").count(), 7);
      if (image.state === "ready") {
        const choose = page.getByRole("button", { name: "Choose files", exact: true });
        await choose.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        await expect(choose).toBeFocused();
      } else {
        await expect(page.getByRole("heading", { name: "7 files admitted · 2 still working", exact: true })).toBeVisible();
        await expect(page.getByText("2 imported · 2 skipped · 1 failed", { exact: true })).toBeVisible();
      }
    }
    await page.evaluate(() => scrollTo(0, 0));
    const capture = resolve(evidence, image.name + ".png");
    await page.screenshot({ path: capture, fullPage: true });
    allow.set("/verification/" + image.name + ".png", capture);
    const comparison = await page.evaluate(async ([approved, current]: string[]) => {
      const load = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; });
      const [a, b] = await Promise.all([load(approved!), load(current!)]);
      if (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) return { dimensionsMatch: false, approved: [a.naturalWidth, a.naturalHeight], current: [b.naturalWidth, b.naturalHeight], changedPixels: -1 };
      const canvas = document.createElement("canvas"); canvas.width = a.naturalWidth; canvas.height = a.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(a, 0, 0); const aa = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(b, 0, 0); const bb = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let changedPixels = 0, maxChannelDifference = 0, significantChangedPixels = 0; const samples: any[] = [];
      for (let i = 0; i < aa.length; i += 4) if (aa[i] !== bb[i] || aa[i + 1] !== bb[i + 1] || aa[i + 2] !== bb[i + 2] || aa[i + 3] !== bb[i + 3]) {
        changedPixels++;
        const difference = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(aa[i + channel]! - bb[i + channel]!)));
        maxChannelDifference = Math.max(maxChannelDifference, difference); if (difference > 1) significantChangedPixels++;
        if (samples.length < 24) samples.push({ x: (i / 4) % canvas.width, y: Math.floor(i / 4 / canvas.width), approved: [...aa.slice(i, i + 4)], current: [...bb.slice(i, i + 4)] });
      }
      return { dimensionsMatch: true, dimensions: { width: canvas.width, height: canvas.height }, changedPixels, maxChannelDifference, significantChangedPixels, samples };
    }, [origin + prefix + image.name + ".png", origin + "/verification/" + image.name + ".png"]);
    assert.ok(comparison.dimensionsMatch, image.name + " dimensions");
    if (comparison.changedPixels) console.log(JSON.stringify({ name: image.name, evidence, comparison }, null, 2));
    assert.equal(comparison.significantChangedPixels, 0, image.name + " no difference beyond one-level native edge antialiasing");
    if (image.state === "mixed") {
      const trigger = page.getByRole("button", { name: "Inspect original", exact: true }); await trigger.click();
      await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden(); await expect(trigger).toBeFocused();
    }
    results.push({ name: image.name, viewport: image.viewport, comparison, entryGeometry, noOverflow: true, fontLoaded: true, verificationCapture: capture, approvedBytesUnchanged: hash(resolve(root, image.path)) === image.sha256 });
    await context.close();
  }
  const preview = await newPage(1440, 900);
  await preview.page.goto(origin + prefix + "index.html", { waitUntil: "networkidle" });
  assert.equal(await preview.page.locator("img").count(), 6);
  assert.ok(await preview.page.locator("img").evaluateAll((images: HTMLImageElement[]) => images.every(image => image.complete && image.naturalWidth > 0)));
  const links = await preview.page.locator("a[href]").evaluateAll((links: HTMLAnchorElement[]) => links.map(link => new URL(link.href).pathname));
  for (const link of links) assert.ok(allow.has(link), "preview local link: " + link);
  await preview.context.close();
  for (const image of [...manifest.images, ...manifest.previousApprovedPngs]) assert.equal(hash(resolve(root, image.path)), image.sha256);
  assert.deepEqual(errors, []); assert.equal(writes, 0); assert.equal(unexpectedRequests, 0);
  const report = { passed: true, browser: browser.version(), results, previewImages: 6, localLinksValid: true, previousApprovedPngsPreserved: manifest.previousApprovedPngs.length, writes, unexpectedRequests, actualNetworkConnections: 0, approvedFilesOverwritten: false, pageErrors: errors };
  writeFileSync(resolve(evidence, "verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, evidence }, null, 2));
} finally { await browser?.close(); console.log("Owned browser released; no server or dependency fixture created."); }
