import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Design-gallery verification only. No application, daemon or actual network.
const root = process.cwd();
const packet = resolve(root, ".impeccable/mocks/user-connections");
const require = createRequire(resolve(root, "apps/web/package.json"));
const { chromium } = require("@playwright/test");
const manifest = JSON.parse(readFileSync(resolve(packet, "manifest.json"), "utf8"));
const evidence = mkdtempSync("/tmp/opencode/thoughtloom-connections-review-");
const origin = "http://thoughtloom-design.invalid";
const prefix = "/.impeccable/mocks/user-connections/";
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const allow = new Map<string, string>();
for (const name of ["index.html", "README.md", "manifest.json", ...manifest.images.map((image: any) => image.name + ".png")]) {
  allow.set(prefix + name, resolve(packet, name));
}
allow.set("/.impeccable/brand/fonts/SourceSans3-VariableFont_wght.ttf", resolve(root, ".impeccable/brand/fonts/SourceSans3-VariableFont_wght.ttf"));
for (const image of manifest.images) assert.equal(hash(resolve(root, image.path)), image.packagedSha256);
assert.equal(manifest.selection.option, "B");
assert.equal(manifest.compositionApproved, true);
assert.equal(manifest.stateBoardsApproved, false);
assert.equal(manifest.designHandoffFinalized, true);
assert.deepEqual(manifest.selection.remainingUserDecisions, []);
assert.equal(manifest.behaviorApprovals.draftLifecycle.approved, true);
assert.equal(manifest.behaviorApprovals.uncertainSave.approved, true);
assert.equal(manifest.implementationFollowUp.issue, "thought-loom-rry");
assert.equal(manifest.implementationAuthorized, false);
assert.deepEqual(manifest.images.filter((image: any) => image.approved).map((image: any) => image.name).sort(), ["guided-desktop", "guided-phone"]);
assert.deepEqual(manifest.selection.references.map((image: any) => image.path).sort(), manifest.images.filter((image: any) => image.approved).map((image: any) => image.path).sort());

let browser: any;
let unexpectedRequests = 0;
let writes = 0;
const errors: string[] = [];
const results: any[] = [];
try {
  browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--disable-gpu"] });
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route("**/*", async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET") { writes++; await route.fulfill({ status: 405, body: "No writes in this gallery" }); return; }
      if (url.pathname === "/favicon.ico") { await route.fulfill({ status: 204 }); return; }
      const path = url.origin === origin ? allow.get(url.pathname) : undefined;
      if (!path) { unexpectedRequests++; await route.fulfill({ status: 404, body: "Outside the design packet" }); return; }
      const contentType = path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".ttf") ? "font/ttf" : path.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
      await route.fulfill({ status: 200, contentType, body: readFileSync(path) });
    });
    const page = await context.newPage();
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(origin + prefix + "index.html", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator("img").count(), 8);
    assert.ok(await page.locator("img").evaluateAll((images: HTMLImageElement[]) => images.every(image => image.complete && image.naturalWidth > 0)));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.evaluate(() => document.fonts.check('18px "Source Sans 3"')));
    assert.equal(await page.locator("form, script").count(), 0, "Image gallery must not implement creation");
    const links = await page.locator("a[href]").evaluateAll((items: HTMLAnchorElement[]) => items.map(item => new URL(item.href).pathname));
    for (const link of links) assert.ok(allow.has(link), "Local link: " + link);
    await page.locator("a").first().focus();
    assert.equal(await page.locator("a").first().evaluate((element: HTMLElement) => getComputedStyle(element).outlineWidth), "3px");
    await page.evaluate(() => scrollTo(0, 0));
    const capture = resolve(evidence, `gallery-${width}.png`);
    await page.screenshot({ path: capture, fullPage: true });
    results.push({ viewport: { width, height }, imagesLoaded: 8, localLinksValid: true, noOverflow: true, fontLoaded: true, focusOutline: "3px", capture });
    await context.close();
  }
  for (const image of manifest.images) assert.equal(hash(resolve(root, image.path)), image.packagedSha256);
  assert.deepEqual(errors, []);
  assert.equal(writes, 0);
  assert.equal(unexpectedRequests, 0);
  const report = { passed: true, scope: "static image gallery only, not application runtime or accessibility certification", browser: browser.version(), results, actualNetworkConnections: 0, writes, unexpectedRequests, allCandidateHashesUnchanged: true, evidence };
  writeFileSync(resolve(evidence, "verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  console.log("Owned gallery browser released; no app server, daemon, provider or dependency installation.");
}
