import { chromium } from "../../../../apps/web/node_modules/@playwright/test/index.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = resolve(".impeccable/candidates/root-splash");
const output = resolve(root, "review");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const report = { kind: "Standalone static motion study, not app integration", browser: browser.version(), externalRequests: [], errors: [], samples: [], completion: [], controls: [] };
async function context(options = {}) {
  const instance = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...options });
  await instance.route("**/*", route => {
    const url = route.request().url();
    if (url.startsWith("file:") || url.startsWith("data:")) return route.continue();
    report.externalRequests.push(url); return route.abort();
  });
  return instance;
}
async function open(instance, params = "") {
  const page = await instance.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.goto(pathToFileURL(resolve(root, "study.html")).href + params);
  await page.evaluate(() => window.splashStudy.ready);
  return page;
}
async function metrics(page) {
  return page.evaluate(() => {
    const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const overlay = document.querySelector("#splash");
    const art = document.querySelector(".art");
    const skip = document.querySelector("#skip");
    const end = window.splashStudy.report.reason !== null;
    const srgb = value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; };
    const lum = rgb => .2126 * srgb(rgb[0]) + .7152 * srgb(rgb[1]) + .0722 * srgb(rgb[2]);
    return {
      hidden: overlay.hidden, opacity: Number(getComputedStyle(overlay).opacity),
      art: box(art), skip: box(skip),
      centerOpacity: Number(getComputedStyle(document.querySelector("#center-plant")).opacity),
      visiblePeripheralNodes: [...document.querySelectorAll("#nodes circle")].filter(el => Number(getComputedStyle(el).opacity) > .95).length,
      originalMask: document.querySelector("#original-art").getAttribute("mask"),
      referenceInert: document.querySelector(".reference").inert,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      skipContrast: (lum([254,246,225]) + .05) / (lum([4,37,45]) + .05),
      animationCount: document.getAnimations().length,
      finished: end
    };
  });
}
try {
  for (const specimen of [{ name: "desktop", width: 1440, height: 900, times: [0, 900, 1650, 2175, 2400] }, { name: "phone", width: 390, height: 844, times: [1650, 2175, 2400] }]) {
    const instance = await context({ viewport: { width: specimen.width, height: specimen.height } });
    for (const timeMs of specimen.times) {
      const page = await open(instance, `?at=${timeMs}`);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await metrics(page);
      assert.equal(result.horizontalOverflow, false);
      assert.ok(result.skipContrast >= 4.5);
      if (timeMs < 2400) {
        assert.equal(result.hidden, false);
        assert.equal(result.referenceInert, true);
        assert.ok(result.art.x >= 0 && result.art.x + result.art.width <= specimen.width + 1);
        assert.ok(result.art.y + result.art.height <= result.skip.y + 1, "Skip stays outside art");
        assert.ok(result.skip.height >= 44);
        if (timeMs < 1150) assert.equal(result.centerOpacity, 0);
        if (timeMs === 0) assert.equal(result.visiblePeripheralNodes, 0);
        if (timeMs >= 1650) assert.equal(result.originalMask, null);
        if (timeMs === 2175) assert.ok(Math.abs(result.opacity - .5) < .02);
      } else {
        assert.equal(result.hidden, true); assert.equal(result.referenceInert, false);
      }
      const filename = `${specimen.name}-${timeMs}ms.png`;
      await page.screenshot({ path: resolve(output, filename) });
      report.samples.push({ specimen: specimen.name, viewport: [specimen.width, specimen.height], timeMs, filename, ...result });
      await page.close();
    }
    const page = await open(instance);
    const result = await page.evaluate(() => window.splashStudy.finished);
    assert.equal(result.reason, "complete");
    assert.ok(result.elapsedMs >= 2300 && result.elapsedMs < 2800, `Actual playback completed in ${result.elapsedMs}ms`);
    report.completion.push({ specimen: specimen.name, ...result });
    await instance.close();
  }
  for (const method of ["skip", "escape"]) {
    const instance = await context();
    const page = await open(instance);
    if (method === "skip") await page.locator("#skip").click();
    else await page.keyboard.press("Escape");
    const result = await page.evaluate(() => window.splashStudy.finished);
    assert.equal(result.reason, method); assert.ok(result.elapsedMs < 1000);
    assert.equal(await page.locator(".reference").evaluate(el => el.inert), false);
    report.controls.push(result); await instance.close();
  }
  for (const mode of ["reduced-motion", "no-script"]) {
    const instance = await context(mode === "no-script" ? { javaScriptEnabled: false } : { reducedMotion: "reduce" });
    const page = mode === "no-script" ? await instance.newPage() : await open(instance);
    if (mode === "no-script") await page.goto(pathToFileURL(resolve(root, "study.html")).href);
    assert.equal(await page.locator("#splash").isVisible(), false);
    assert.equal(await page.locator(".reference").isVisible(), true);
    const result = mode === "no-script" ? { reason: mode } : await page.evaluate(() => window.splashStudy.finished);
    if (mode !== "no-script") { assert.equal(result.elapsedMs, 0); assert.equal(await page.evaluate(() => document.getAnimations().length), 0); }
    report.controls.push(result); await instance.close();
  }
  const provenance = JSON.parse(await readFile(resolve(root, "provenance.json"), "utf8"));
  for (const [path, expected] of Object.entries(provenance.inputFiles)) {
    assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), expected.sha256, `Original unchanged: ${path}`);
  }
  assert.equal(report.errors.length, 0); assert.equal(report.externalRequests.length, 0);
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = error.stack; process.exitCode = 1;
} finally {
  await browser.close();
  report.studySha256 = createHash("sha256").update(await readFile(resolve(root, "study.html"))).digest("hex");
  await writeFile(resolve(output, "checks.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, samples: report.samples.length, completion: report.completion, controls: report.controls, failure: report.failure, externalRequests: report.externalRequests, errors: report.errors }, null, 2));
}
