import { chromium } from "../../../../apps/web/node_modules/@playwright/test/index.mjs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const target = resolve(root, ".impeccable/candidates/capture-canopy");
const production = process.argv.includes("--production");
const expectedSize = production ? [392, 588] : [1024, 1536];
const base = pathToFileURL(resolve(target, "review/comp.html"));
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const results = [];
try {
  for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }, { name: "intermediate", width: 800, height: 800 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
    await context.route("**/*", route => route.request().url().startsWith("file:") ? route.continue() : route.abort());
    for (const state of ["editing", "saving", "saved", "not-saved"]) {
      const geometry = {};
      let details;
      for (const art of ["off", "on"]) {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const url = new URL(base); url.searchParams.set("state", state); url.searchParams.set("art", art);
        if (production) url.searchParams.set("asset", "production");
        await page.goto(url.href);
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        const metrics = await page.evaluate(expected => {
          const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          const frame = document.querySelector(".canopy");
          const visible = getComputedStyle(frame).display !== "none";
          const box = rect(frame);
          const ui = [...document.querySelectorAll(".site-header, .capture-workspace, .capture-heading, .capture-status, form, label, textarea, input, button, a")].filter(element => element.getBoundingClientRect().height > 0).map(element => ({ role: element.tagName, ...rect(element) }));
          const art = frame.querySelector("img");
          return { ui, frame: box, visible, sourceDecoded: art.complete && art.naturalWidth === expected[0] && art.naturalHeight === expected[1], fontReady: document.fonts.check('18px "Source Sans Comp"'), horizontalOverflow: document.documentElement.scrollWidth > innerWidth, overlaps: visible ? ui.filter(r => r.x < box.x + box.width && r.x + r.width > box.x && r.y < box.y + box.height && r.y + r.height > box.y).map(r => r.role) : [] };
        }, expectedSize);
        geometry[art] = metrics.ui;
        if (art === "on") {
          if (state === "editing" && (production ? viewport.name === "desktop" : ["desktop", "phone"].includes(viewport.name))) await page.screenshot({ path: resolve(target, `review/${production ? "production-" : ""}${viewport.name}.png`), fullPage: true });
          details = { viewport, state, errors, ...metrics };
        }
        await page.close();
      }
      results.push({ ...details, uiGeometryUnchanged: JSON.stringify(geometry.on) === JSON.stringify(geometry.off) });
    }
    await context.close();
  }
} finally { await browser.close(); }
const desktopFrames = results.filter(row => row.viewport.name === "desktop").map(row => JSON.stringify(row.frame));
const stateInvariantDesktopFrame = new Set(desktopFrames).size === 1;
const failures = results.filter(row => row.errors.length || !row.sourceDecoded || !row.fontReady || row.horizontalOverflow || row.overlaps.length || !row.uiGeometryUnchanged || row.visible !== (row.viewport.width > 768));
const report = { boundary: "Test-owned static fixtures using current repository CSS/font/glyphs; not live-client integration or recovery tests", source: production ? ".impeccable/candidates/capture-canopy/production/capture-canopy.png" : ".impeccable/candidates/capture-canopy/source.png", stateInvariantDesktopFrame, probes: results.length, failures: failures.length, results };
await writeFile(resolve(target, `review/${production ? "production-" : ""}checks.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ probes: results.length, failures: failures.length, stateInvariantDesktopFrame }, null, 2));
if (failures.length || !stateInvariantDesktopFrame) process.exitCode = 1;
