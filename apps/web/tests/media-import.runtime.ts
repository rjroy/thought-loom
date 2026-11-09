import assert from "node:assert/strict";
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import type { MediaIdeaThought } from "../src/features/idea/media";
import type { IdeaConnection, IdeaThought, IdeaView, SharedResponse } from "../src/features/idea/types";
import type { MediaRun } from "../src/features/media/types";
import type { WebSearchPage } from "../src/features/explore/results";
import type { Discovery, Session } from "../src/features/agentic-search/types";

type SurfaceAttempt = { method: string; path: string; body: string | null };
/** Fixed same-origin mocks, with no fallback to a shared service or raw-file route. */
async function surfaceRoutes(page: Page, respond: (route: Route, url: URL, call: SurfaceAttempt) => Promise<boolean>) {
  const attempts: SurfaceAttempt[] = [], unexpected: string[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const call = { method: request.method(), path: url.pathname, body: request.postData() };
    attempts.push(call);
    if (!await respond(route, url, call)) {
      unexpected.push(`${call.method} ${url.pathname}${url.search}`);
      await route.fulfill({ status: 404, json: { error: "Owned fixture has no such endpoint" } });
    }
  });
  return { attempts, assertReadsOnly() { assert.ok(attempts.every(call => call.method === "GET"), "reading media must not admit work"); },
    assertNoBinary() {
      assert.deepEqual(unexpected, [], "all view requests must use the controlled public contract");
      assert.ok(!attempts.some(call => call.path.includes("/raw") || call.path.startsWith("/api/imports/")), "these surfaces read descriptors/recorded text, never retained binaries or uploads");
    } };
}

async function exactMediaDetails(container: Locator): Promise<void> {
  await expect(container.getByText(/PNG image/).first()).toBeVisible();
  await expect(container.getByText(new RegExp(`\\b${bytes.length} B\\b`)).first()).toBeVisible();
  await expect(container.getByText(/Original authorship unverified/i).first()).toBeVisible();
  await expect(container.getByText("Your clarification", { exact: true }).or(container.getByText("Your clarification:", { exact: true })).first()).toBeVisible();
  const wording = container.locator("p").filter({ hasText: "Compare the open questions." });
  await expect(wording).toHaveCount(1);
  assert.equal(await wording.textContent(), clarification, "show exact user clarification separately from file content");
}

async function noSurfaceOverflow(page: Page): Promise<void> {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "media details/actions must wrap without horizontal overflow");
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
}

/** Actual results load first; the first RED is the missing media material facet. */
export async function checkMediaExploreSurface(page: Page, origin: string): Promise<void> {
  const sourceResult = { kind: "thought", id: source.id, thoughtId: source.id, text: null, mediaSource: source.mediaSource,
    title: filename, author: "source", materialKind: "media-original", snippet: clarification, createdAt: source.createdAt, context: null } as const;
  const readingResult = { kind: "thought", id: interpretation.id, thoughtId: interpretation.id, text: interpretationText,
    title: interpretationTitle, author: "ai", materialKind: "ai-interpretation", snippet: interpretationText, createdAt: source.createdAt,
    context: { kind: "predecessor", thought: source } } as const;
  const resultPage = { results: [sourceResult, readingResult], rejectionStatus: { [source.id]: false, [interpretation.id]: false },
    counts: { authors: { user: 0, ai: 1, source: 1 }, kinds: { "captured-original": 0, "user-contribution": 0,
      "ai-interpretation": 1, "developing-idea": 0, "imported-original": 0, "media-original": 1 } } } satisfies WebSearchPage;
  const queries: URL[] = [];
  const audit = await surfaceRoutes(page, async (route, url, call) => {
    if (call.method !== "GET" || url.pathname !== "/api/search") return false;
    queries.push(url);
    const filtered = url.searchParams.getAll("kind").includes("media-original");
    await route.fulfill({ json: { ...resultPage, results: filtered ? [sourceResult] : resultPage.results } }); return true;
  });
  await page.goto(`${origin}/explore?q=questions`, { waitUntil: "networkidle" });
  const sourceCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: filename, exact: true }) });
  const childCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: interpretationTitle, exact: true }) });
  await expect(sourceCard).toBeVisible(); await expect(childCard.getByText(interpretationText, { exact: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 500) await page.getByRole("button", { name: /^Filters/ }).click();
  const mediaFacet = page.getByRole("checkbox", { name: /Images and PDFs/ });
  await expect(mediaFacet).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Imported Markdown/ })).toBeVisible();
  await expect(sourceCard.getByText("Image or PDF", { exact: true })).toBeVisible();
  await exactMediaDetails(sourceCard);
  await expect(sourceCard.getByRole("link", { name: filename, exact: true })).toHaveAttribute("href", new RegExp(`^/ideas/${source.id}(?:\\?|$)`));
  await expect(sourceCard.getByRole("button", { name: /Expand original text/ })).toHaveCount(0);
  await expect(childCard.getByRole("link", { name: filename, exact: true })).toBeVisible();
  await expect(childCard).toContainText(clarification.trim());
  await mediaFacet.check();
  await expect.poll(() => queries.some(url => url.searchParams.getAll("kind").includes("media-original"))).toBe(true);
  await expect(childCard).toHaveCount(0);
  await expect(sourceCard).toBeVisible();
  assert.ok(queries.every(url => url.searchParams.get("q") === "questions"), "facet changes keep the actual query");
  audit.assertReadsOnly(); audit.assertNoBinary(); await noSurfaceOverflow(page);
}

/** Existing Evolve rail and contribution command; no replacement-file affordance. */
export async function checkMediaEvolveSurface(page: Page, origin: string): Promise<void> {
  const contributionText = "  Owned new media question\nwithout replacing the clarification.  ";
  const contribution = { id: "media-surface-contribution", text: contributionText, title: null, titleAuthor: null,
    author: "user", kind: "user-contribution", origin: "contribution", parentId: source.id, sourceIds: [], createdAt: source.createdAt } as const satisfies IdeaThought;
  const run = { id: "media-surface-evolve-run", kind: "evolve", status: "completed", confirmedThoughtIds: [], responseId: null } as const;
  const rootPath = `/api/evolve/thoughts/${source.id}`;
  const audit = await surfaceRoutes(page, async (route, url, call) => {
    if (url.pathname === rootPath && call.method === "GET") { await route.fulfill({ json: source }); return true; }
    if (url.pathname === rootPath && call.method === "POST") { await route.fulfill({ status: 201, json: { contribution, run } }); return true; }
    if (url.pathname === `/api/evolve/runs/${run.id}` && call.method === "GET") { await route.fulfill({ json: run }); return true; }
    return false;
  });
  await page.goto(`${origin}/evolve?thoughtId=${source.id}`, { waitUntil: "networkidle" });
  if ((page.viewportSize()?.width ?? 1440) < 500) await page.getByRole("button", { name: /^Starting thought/ }).click();
  const rail = page.locator("#evolve-starting-context");
  await expect(rail.getByRole("heading", { name: filename, exact: true })).toBeVisible();
  await exactMediaDetails(rail);
  await expect(rail.getByText("Image or PDF", { exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Open idea" })).toHaveAttribute("href", new RegExp(`^/ideas/${source.id}(?:\\?|$)`));
  audit.assertReadsOnly();
  const field = page.getByRole("textbox", { name: "Your contribution", exact: true }), send = page.getByRole("button", { name: "Send", exact: true });
  await field.fill(contributionText);
  await expect(field).toHaveValue(contributionText);
  await expect(page.getByText(/original file and clarification are not edited/i)).toBeVisible();
  const fieldBox = await field.boundingBox(), sendBox = await send.boundingBox();
  assert.ok(fieldBox && sendBox && sendBox.width >= 44 && sendBox.height >= 44);
  assert.ok(sendBox.x >= fieldBox.x + fieldBox.width - 1 && sendBox.y + sendBox.height <= fieldBox.y + fieldBox.height + 1, "Send remains beside the media contribution");
  const admission = page.waitForResponse(response => new URL(response.url()).pathname === rootPath && response.request().method() === "POST");
  await send.click();
  assert.equal((await admission).status(), 201);
  const savedContribution = page.locator("main").getByText("You · Contribution", { exact: true }).locator("..").getByText(contributionText, { exact: true });
  await expect(savedContribution).toBeVisible();
  await expect(savedContribution).toHaveJSProperty("textContent", contributionText);
  await expect(field).toHaveValue("");
  const commands = audit.attempts.filter(call => call.method !== "GET");
  assert.equal(commands.length, 1); assert.equal(commands[0]?.path, rootPath);
  assert.deepEqual(JSON.parse(commands[0]?.body ?? "null"), { text: contributionText });
  await exactMediaDetails(rail);
  audit.assertNoBinary(); await noSurfaceOverflow(page);
}

/** Discovery is a summary; only explicit Preview reads its descriptor/clarification. */
export async function checkMediaAskSurface(page: Page, origin: string): Promise<void> {
  const session = { id: "media-surface-search", title: "Owned media search", revision: 0, createdAt: source.createdAt, lastActivityAt: source.createdAt } satisfies Session;
  const composer = { composerId: "media-surface-composer", contextToken: "media-surface-context", eligibilityRevision: 0 };
  const base = `/api/search-sessions/${session.id}`, contexts = `${base}/composer-contexts`;
  // The daemon's discovery projection supplies filename fallback (the canonical title remains null).
  const discovery = { id: "media-surface-discovery", position: 0, addedAt: source.createdAt, removedAt: null,
    thought: { id: source.id, title: filename, titleAuthor: null, author: source.author, kind: source.kind, createdAt: source.createdAt },
    why: "Owned match in the user's clarification, not the original image.", evidenceThoughtIds: [], availability: "available", reasonStatus: "available" } satisfies Discovery;
  const previewPath = `${contexts}/${composer.composerId}/thoughts/${source.id}`;
  const audit = await surfaceRoutes(page, async (route, url, call) => {
    if (call.method === "GET" && url.pathname === base) { await route.fulfill({ json: { session, activeRun: null, eligibilityRevision: 0 } }); return true; }
    if (call.method === "POST" && url.pathname === contexts) { await route.fulfill({ status: 201, json: composer }); return true; }
    if (call.method === "GET" && url.pathname === `${contexts}/${composer.composerId}`) { await route.fulfill({ json: composer }); return true; }
    if (call.method === "GET" && ["messages", "discoveries"].some(part => url.pathname === `${base}/${part}`)) {
      assert.equal(url.searchParams.get("composerId"), composer.composerId);
      assert.equal(url.searchParams.has("scope"), false, "normal Ask must not broaden to history");
      await route.fulfill({ json: { items: url.pathname.endsWith("/discoveries") ? [discovery] : [], nextCursor: null,
        sessionRevision: 0, ...composer } }); return true;
    }
    if (call.method === "GET" && url.pathname === previewPath) { await route.fulfill({ json: { thought: source, sessionRevision: 0, ...composer } }); return true; }
    if (call.method === "DELETE" && url.pathname === `${contexts}/${composer.composerId}`) { await route.fulfill({ status: 204 }); return true; }
    return false;
  });
  await page.goto(`${origin}/explore/ask/${session.id}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(session.title);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Your message", exact: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 500) await page.getByRole("button", { name: /Discovered ideas/ }).click();
  const item = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: filename, exact: true }) });
  await expect(item).toBeVisible();
  assert.equal(audit.attempts.filter(call => call.path === previewPath).length, 0, "discovery display alone must not open the original or preview");
  await item.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.getByRole("region", { name: "Idea preview", exact: true });
  await expect(preview.getByRole("heading", { name: filename, exact: true })).toBeVisible();
  await exactMediaDetails(preview);
  await expect(item.getByText("Image or PDF", { exact: true })).toBeVisible();
  await expect(preview.getByText(/(?:cannot|can’t|can't).*open.*original|(?:not|never).*original.*(?:file|bytes)/i)).toBeVisible();
  await expect(item.getByRole("link", { name: "Open idea", exact: true })).toHaveAttribute("href", new RegExp(`^/ideas/${source.id}\\?`));
  await expect(item.getByRole("button", { name: "Remove from search", exact: true })).toBeEnabled();
  const writes = audit.attempts.filter(call => call.method !== "GET");
  assert.equal(writes.length, 1); assert.equal(writes[0]?.path, contexts); assert.equal(writes[0]?.body, "{}");
  audit.assertNoBinary(); await noSurfaceOverflow(page);
}

/** Read-only export descriptors and qualified source resolution preserve the returned bytes. */
export async function checkMediaExportSurface(page: Page, origin: string): Promise<void> {
  const simple = Buffer.from(`# Owned media export\r\n\r\n${filename}\r\n${clarification}\r\n`, "utf8");
  const report = Buffer.from(`# Owned media report\r\n\r\nRecorded clarification, not original image contents.\r\n\r\n[Untrusted body link](/ideas/media-forgery)\n\n## Sources\n\nRecorded thought identities and attribution (not endorsement):\n\n- ${filename}: ID: \`"${source.id}"\`; thought author: source; kind: media-original. Access to the descriptor or clarification does not imply binary file access.\n`, "utf8");
  const run = { id: "media-surface-export-run", kind: "export", status: "completed", confirmedThoughtIds: [], responseId: null } as const;
  const audit = await surfaceRoutes(page, async (route, url, call) => {
    if (call.method === "GET" && url.pathname === `/api/export/thoughts/${source.id}`) { await route.fulfill({ json: source }); return true; }
    if (call.method === "POST" && url.pathname === "/api/export/simple") { await route.fulfill({ contentType: "text/markdown; charset=utf-8", body: simple }); return true; }
    if (call.method === "POST" && url.pathname === "/api/export/agentic") { await route.fulfill({ status: 201, json: { run } }); return true; }
    if (call.method === "GET" && url.pathname === `/api/export/runs/${run.id}`) { await route.fulfill({ json: run }); return true; }
    if (call.method === "GET" && url.pathname === `/api/export/agentic/${run.id}`) { await route.fulfill({ contentType: "text/markdown; charset=utf-8", body: report }); return true; }
    return false;
  });
  await page.goto(`${origin}/export?thoughtId=${source.id}`, { waitUntil: "networkidle" });
  const createSimple = page.getByRole("button", { name: "Create simple export", exact: true });
  await expect(createSimple).toBeEnabled(); // positive control: the actual normal root loaded
  const simpleSection = page.getByRole("region", { name: "Simple", exact: true });
  await expect(simpleSection.getByText(filename, { exact: true })).toBeVisible();
  await exactMediaDetails(simpleSection);
  await expect(simpleSection.getByText("Image or PDF", { exact: true })).toBeVisible();
  await expect(simpleSection.getByText(/descriptor and clarification.*not.*(?:binary|file contents)/i)).toBeVisible();
  await expect(page.getByText(/(?:report|Agentic export).*cannot open the original file/i)).toBeVisible();
  audit.assertReadsOnly();
  await page.getByRole("spinbutton", { name: /count/i }).fill("3");
  await createSimple.click();
  const simplePreview = page.getByRole("region", { name: "Simple Markdown preview", exact: true });
  await expect(simplePreview.getByRole("heading", { name: "Owned media export", exact: true })).toBeVisible();
  const readDownload = async (button: Locator) => {
    const event = page.waitForEvent("download"); await button.click();
    const stream = await (await event).createReadStream(); assert.ok(stream);
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  assert.deepEqual(await readDownload(simplePreview.getByRole("button", { name: "Download Markdown", exact: true })), simple);
  const request = "Owned report using recorded media context";
  await page.getByRole("textbox", { name: "Request", exact: true }).fill(request);
  await page.getByRole("combobox", { name: "Effort", exact: true }).selectOption("quick");
  await page.getByRole("button", { name: "Create report", exact: true }).click();
  const progress = page.getByRole("region", { name: "Report progress", exact: true });
  await expect(progress.getByRole("heading", { name: "Report ready", exact: true })).toBeVisible();
  await expect(progress.getByRole("heading", { name: "Owned media report", exact: true })).toBeVisible();
  await expect(progress.getByRole("link", { name: filename, exact: true })).toHaveAttribute("href", `/ideas/${source.id}`);
  await expect(page.locator('a[href="/ideas/media-forgery"]')).toHaveCount(0);
  assert.deepEqual(await readDownload(progress.getByRole("button", { name: "Download Markdown", exact: true })), report);
  const writes = audit.attempts.filter(call => call.method !== "GET");
  assert.deepEqual(writes.map(call => [call.method, call.path]), [["POST", "/api/export/simple"], ["POST", "/api/export/agentic"]]);
  assert.deepEqual(JSON.parse(writes[0]?.body ?? "null"), { rootId: source.id, count: 3, traversal: "breadth" });
  assert.deepEqual(JSON.parse(writes[1]?.body ?? "null"), { request, effort: "quick" });
  audit.assertNoBinary(); await noSurfaceOverflow(page);
}

// Browser-owned inputs. These tests mock the fixed same-origin media endpoints;
// boundary/auth/format-validation tests exercise the server separately.
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const filename = "owned-workshop.png";
const clarification = "  Compare the open questions.\nKeep this exact wording.  ";
const draft = "Owned Capture words kept while choosing an import";
const title = "Owned Capture title";
const source = {
  id: "media-ui-thought", text: null, title: null, titleAuthor: null,
  author: "source", kind: "media-original", origin: "media-import", parentId: null,
  sourceIds: [], createdAt: "2032-01-01T00:00:00Z",
  mediaSource: { id: "media-ui-source", name: filename, mimeType: "image/png", byteLength: bytes.length,
    fileAuthorship: "unverified", clarification, clarificationAuthor: "user" },
} as const satisfies MediaIdeaThought;
const originalRun = { id: "media-ui-original-run", kind: "weave", status: "queued", confirmedThoughtIds: [], responseId: null } as const;
const choice = (page: Page, name: RegExp) => page.getByRole("link", { name }).or(page.getByRole("button", { name }));

async function chooseMedia(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/capture`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await choice(page, /^Image or PDF\b/i).click();
  await expect(page).toHaveURL(`${origin}/import/media`);
  await expect(page.getByRole("heading", { level: 1, name: "Import image or PDF" })).toBeVisible();
}

/** First RED is visible behavior in the real Capture component, not a missing module. */
export async function checkMediaImportEntry(page: Page, origin: string): Promise<void> {
  const writes: string[] = [];
  const observe = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") writes.push(request.url());
  };
  page.on("request", observe);
  try {
    await page.goto(`${origin}/capture`, { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Thought", exact: true }).fill(draft);
    await page.getByRole("textbox", { name: /^Title/i }).fill(title);
    const entry = page.getByRole("button", { name: "Import", exact: true });
    await expect(entry).toHaveCount(1);
    await expect(page.locator("form").getByRole("button", { name: "Import", exact: true })).toHaveCount(0);
    await entry.click();
    // Opening choices is not navigation and must not discard the writing draft.
    await expect(page).toHaveURL(`${origin}/capture`);
    await expect(entry).toHaveAttribute("aria-expanded", "true");
    await expect(choice(page, /^Image or PDF\b/i)).toBeVisible();
    await expect(choice(page, /^Markdown\b/i)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(entry).toHaveAttribute("aria-expanded", "false");
    await expect(entry).toBeFocused();
    await expect(choice(page, /^Image or PDF\b/i)).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Thought", exact: true })).toHaveValue(draft);

    await entry.click();
    await choice(page, /^Markdown\b/i).click();
    await expect(page).toHaveURL(`${origin}/import`);
    await expect(page.getByRole("heading", { level: 1, name: "Import Markdown" })).toBeVisible();
    await page.getByRole("banner").getByRole("link", { name: "Back to Capture", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Thought", exact: true })).toHaveValue(draft);
    await expect(page.getByRole("textbox", { name: /^Title/i })).toHaveValue(title);

    await entry.click();
    await choice(page, /^Image or PDF\b/i).click();
    await expect(page).toHaveURL(`${origin}/import/media`);
    await expect(page.getByRole("heading", { level: 1, name: "Import image or PDF" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Capture", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator('img[src="/backgrounds/capture-canopy.png"]')).toHaveCount(0);
    const input = page.locator('input[type="file"]');
    await expect(input).toHaveCount(1);
    await expect(input).toHaveJSProperty("multiple", false);
    await expect(page.getByRole("textbox", { name: /^Clarification/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import file", exact: true })).toBeDisabled();
    assert.deepEqual(writes, [], "opening choices/workspaces must not submit Capture or admit an import");
    await page.getByRole("banner").getByRole("link", { name: "Back to Capture", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Thought", exact: true })).toHaveValue(draft);
    await expect(page.getByRole("textbox", { name: /^Title/i })).toHaveValue(title);
  } finally { page.off("request", observe); }
}

interface Upload { key: string | null; metadata: unknown; name: string; mime: string; bytes: Buffer }
/** Read callback-owned observations at assertion time, not the earlier empty-array narrowing. */
function recordedUpload(uploads: readonly Upload[], index: number): Upload {
  const upload = uploads[index];
  assert.ok(upload, `Expected recorded upload ${index + 1}`);
  return upload;
}
async function submitted(route: Route): Promise<Upload> {
  const request = route.request();
  assert.equal(request.method(), "POST");
  const body = request.postDataBuffer();
  assert.ok(body, "upload must have its multipart body");
  const form = await new Request(request.url(), { method: "POST", headers: { "content-type": request.headers()["content-type"] ?? "" }, body: new Uint8Array(body) }).formData();
  assert.deepEqual([...form.keys()].sort(), ["file", "metadata"]);
  const file = form.get("file");
  assert.ok(file instanceof File);
  return { key: request.headers()["idempotency-key"] ?? null, metadata: JSON.parse(String(form.get("metadata"))), name: file.name, mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
}

/** One coherent upload recovery slice; source retry/status follows after its controller seam exists. */
export async function checkMediaUploadRecovery(page: Page, origin: string): Promise<void> {
  const uploads: Upload[] = [], reads: string[] = [], unexpected: string[] = [];
  const sourcePattern = /\/api\/imports\/media-sources\/media-ui-source(?:\?.*)?$/;
  const observe = (request: import("@playwright/test").Request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/imports/") && request.method() !== "GET" && path !== "/api/imports/media") unexpected.push(`${request.method()} ${path}`);
  };
  page.on("request", observe);
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const uploadHandler = async (route: Route) => {
    uploads.push(await submitted(route));
    if (uploads.length === 1) {
      await held;
      await route.fulfill({ status: 502, json: { message: "Unable to confirm the outcome." } });
    } else {
      await route.fulfill({ status: 200, json: { thought: source, run: originalRun } });
    }
  };
  const receiptHandler = async (route: Route) => {
    const request = route.request();
    reads.push(request.url());
    if (request.method() !== "GET") unexpected.push(`${request.method()} ${request.url()}`);
    await route.fulfill({ status: 404, json: { message: "Unavailable.", code: "not-found" } });
  };
  const sourceHandler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== "GET") unexpected.push(`${request.method()} ${request.url()}`);
    await route.fulfill({ status: 200, json: { thought: source, run: originalRun, retry: { eligible: false, reason: "work-active" } } });
  };
  const runHandler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== "GET") unexpected.push(`${request.method()} ${request.url()}`);
    await route.fulfill({ status: 200, json: originalRun });
  };
  await page.route("**/api/imports/media", uploadHandler);
  await page.route("**/api/imports/media/by-key/*", receiptHandler);
  await page.route(sourcePattern, sourceHandler);
  await page.route("**/api/imports/media-runs/media-ui-original-run", runHandler);
  try {
    await chooseMedia(page, origin);
    await page.clock.install();
    const input = page.locator('input[type="file"]');
    await input.setInputFiles({ name: filename, mimeType: "image/png", buffer: bytes });
    await expect(page.getByText(filename, { exact: true })).toBeVisible();
    const field = page.getByRole("textbox", { name: /^(Submitted )?Clarification/i });
    await field.fill(clarification);
    await expect(field).toHaveValue(clarification);
    assert.deepEqual(uploads, [], "selection and clarification must send nothing");
    assert.deepEqual(reads, [], "an unsent selection has no receipt to reconcile");

    const submit = page.getByRole("button", { name: "Import file", exact: true });
    await expect(submit).toBeEnabled();
    // Dispatch both submits before React can render disabled state.
    await submit.evaluate(button => {
      const form = button.closest("form");
      if (!(form instanceof HTMLFormElement)) throw new Error("Import file requires its real form");
      form.requestSubmit(); form.requestSubmit();
    });
    await expect.poll(() => uploads.length).toBe(1);
    await expect(field).toHaveJSProperty("readOnly", true);
    await expect(field).toHaveValue(clarification);
    await expect(submit).toBeDisabled();
    const first = recordedUpload(uploads, 0);
    const key = first.key;
    assert.ok(key, "The original upload must have a request key");
    assert.match(key, /^[A-Za-z0-9._:-]{1,128}$/);
    assert.deepEqual(first.metadata, { clarification });
    assert.equal(first.name, filename); assert.equal(first.mime, "image/png");
    assert.deepEqual(first.bytes, bytes);
    release();

    const check = page.getByRole("button", { name: /^Check upload$/i });
    await expect(check).toBeVisible();
    await expect(field).toHaveJSProperty("readOnly", true);
    await expect(field).toHaveValue(clarification);
    await page.clock.fastForward(10_000);
    assert.equal(uploads.length, 1, "unknown admission must not automatically send another upload");
    await check.click();
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    for (const url of reads) assert.equal(new URL(url).pathname, `/api/imports/media/by-key/${encodeURIComponent(key)}`);
    assert.equal(uploads.length, 1, "Check upload must be a readonly original-key GET");
    const resend = page.getByRole("button", { name: "Send same upload request", exact: true });
    await expect(resend).toBeVisible();
    await expect(field).toHaveJSProperty("readOnly", true);
    await expect(field).toHaveValue(clarification);
    await page.clock.fastForward(10_000);
    assert.equal(uploads.length, 1, "a missing receipt must not automatically resend");
    await resend.click();
    await expect.poll(() => uploads.length).toBe(2);
    assert.deepEqual(uploads[1], first, "deliberate resend must retain the original key, bytes, filename, MIME and exact clarification");
    await expect(page.getByRole("heading", { name: "Original saved", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open source idea", exact: true })).toHaveAttribute("href", /^\/ideas\/media-ui-thought(?:\?|$)/);
    await expect(page.getByText(/Queued/).first()).toBeVisible();
    await expect(page.getByText(/Original authorship unverified/).first()).toBeVisible();
    await page.clock.fastForward(10_000);
    assert.equal(uploads.length, 2, "a confirmed replay must not start a fresh upload");
    assert.deepEqual(unexpected, [], "receipt observation must not admit processing or Stop");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "media recovery must not overflow the narrow workspace");
  } finally {
    release();
    page.off("request", observe);
    await page.unroute("**/api/imports/media", uploadHandler);
    await page.unroute("**/api/imports/media/by-key/*", receiptHandler);
    await page.unroute(sourcePattern, sourceHandler);
    await page.unroute("**/api/imports/media-runs/media-ui-original-run", runHandler);
  }
}

const interpretationText = "Owned separate AI interpretation: the open questions need a recorded next step.";
const interpretationTitle = "Owned separate AI reading";
const interpretation: IdeaThought = {
  id: "media-ui-interpretation", text: interpretationText,
  title: interpretationTitle, titleAuthor: "ai", author: "ai", kind: "ai-interpretation",
  createdAt: source.createdAt, origin: "interpretation", parentId: source.id, sourceIds: [source.id],
};
const fullReply: SharedResponse = { id: "media-ui-full-reply", text: "Owned retained Full reply, distinct from the saved interpretation.",
  role: "addendum", state: "complete", thoughtIds: [source.id, interpretation.id] };
type RetryAdvisory = { eligible: true; reason: null } | { eligible: false; reason: "source-rejected" | "interpretation-exists" | "work-active" | "work-unsettled" | "work-completed" };
interface SourceFixtureState { run: MediaRun | null; retry: RetryAdvisory; outputs: boolean; sourceRejected?: boolean; childRejected?: boolean; title?: string; connectionRejected?: boolean }
interface SourceAttempt { method: string; path: string; scope: string | null; query: string; key: string | null; body: string | null; contentType: string | null }
interface SourceCommands {
  retry?: (route: Route) => Promise<void>;
  stop?: (route: Route) => Promise<void>;
  idea?: (route: Route, apply: (change: Partial<SourceFixtureState>) => void) => Promise<void>;
}
const currentRun = (status: MediaRun["status"], outputs = false): MediaRun => ({
  id: "media-ui-latest-retry-run", kind: "weave", status,
  confirmedThoughtIds: outputs ? [interpretation.id] : [], responseId: outputs ? fullReply.id : null,
});
const privatePath = "/tmp/opencode/media-ui-private/source.png";
const sourceNeighbor: IdeaThought = { id: "media-ui-neighbor", title: "Owned neighboring capture", titleAuthor: "user",
  text: "Owned neighboring words for a separately recorded connection.", author: "user", kind: "captured-original",
  createdAt: source.createdAt, origin: "capture", parentId: null, sourceIds: [] };
const sourceConnection: IdeaConnection = { id: "media-ui-connection", fromId: source.id, toId: sourceNeighbor.id,
  category: "related", proposedBy: "ai", explanation: "Owned connection rationale, separate from evolution.", sourceIds: [] };

/** Only already-implemented public DTOs are imported; this fixture does not require a new controller. */
async function installSourceFixture(page: Page, initial: SourceFixtureState, commands: SourceCommands = {}) {
  let state = initial, failRead = false;
  type Gate = { promise: Promise<void>; release: () => void };
  let nextGate: Gate | null = null, ideaGate: Gate | null = null, heldReads = 0, heldIdeaReads = 0;
  const gates = new Set<Gate>(), attempts: SourceAttempt[] = [];
  const ideaDeliveries = new Set<Promise<void>>();
  const pattern = /\/api\/(?:ideas\/media-ui-(?:thought|interpretation)|imports\/media(?:-sources|-runs)?(?:\/[^?]*)?)(?:\?.*)?$/;
  const handler = async (route: Route) => {
    const request = route.request(), url = new URL(request.url());
    attempts.push({ method: request.method(), path: url.pathname, scope: url.searchParams.get("scope"), query: url.search,
      key: request.headers()["idempotency-key"] ?? null, body: request.postData(), contentType: request.headers()["content-type"] ?? null });
    if (request.method() === "POST" && url.pathname === `/api/imports/media-sources/${source.mediaSource.id}/retry` && commands.retry) { await commands.retry(route); return; }
    if (request.method() === "POST" && state.run && url.pathname === `/api/imports/media-runs/${state.run.id}/stop` && commands.stop) { await commands.stop(route); return; }
    if (request.method() === "POST" && url.pathname === `/api/ideas/${source.id}` && commands.idea) {
      await commands.idea(route, change => { state = { ...state, ...change }; failRead = false; }); return;
    }
    if (request.method() !== "GET") { await route.fulfill({ status: 409, json: { message: "Unexpected write in readonly source fixture." } }); return; }
    const scope = url.searchParams.get("scope"), inspection = scope === "history" || scope === "show-rejected";
    const canonicalSource: MediaIdeaThought = state.title === undefined ? source : { ...source, title: state.title, titleAuthor: "user" };
    const root: MediaIdeaThought = inspection ? { ...canonicalSource, rejected: !!state.sourceRejected } : canonicalSource;
    const child: IdeaThought = inspection ? { ...interpretation, rejected: !!state.childRejected } : interpretation;
    const response: SharedResponse = inspection ? fullReply : { ...fullReply, thoughtIds: [
      ...(!state.sourceRejected ? [source.id] : []), ...(!state.childRejected ? [interpretation.id] : []),
    ] };
    if (url.pathname === `/api/ideas/${source.id}`) {
      if (state.sourceRejected && !inspection) { await route.fulfill({ status: 404, json: { message: "Idea unavailable." } }); return; }
      const connections: IdeaView["connections"] = state.connectionRejected !== undefined && (inspection || !state.connectionRejected)
        ? [{ connection: inspection ? { ...sourceConnection, rejected: state.connectionRejected } : sourceConnection,
          thought: inspection ? { ...sourceNeighbor, rejected: false } : sourceNeighbor }] : [];
      const value: IdeaView = { thought: root, parent: null, children: state.outputs && (inspection || !state.childRejected) ? [child] : [], sources: [], connections,
        responses: state.outputs ? [response] : [], focusedResponse: null };
      const gate = ideaGate;
      if (gate) {
        // Capture the complete canonical response before the concurrent command changes metadata.
        heldIdeaReads++;
        const delivery = (async () => { await gate.promise; await route.fulfill({ status: 200, json: value }); })();
        ideaDeliveries.add(delivery);
        try { await delivery; } finally { ideaDeliveries.delete(delivery); heldIdeaReads--; }
      } else await route.fulfill({ status: 200, json: value });
      return;
    }
    if (url.pathname === `/api/ideas/${interpretation.id}`) {
      if (state.childRejected && !inspection) { await route.fulfill({ status: 404, json: { message: "Idea unavailable." } }); return; }
      const reference = state.sourceRejected && !inspection ? null : root;
      const value: IdeaView = { thought: child, parent: { id: source.id, thought: reference }, children: [],
        sources: [{ id: source.id, thought: reference }], connections: [], responses: [response], focusedResponse: null };
      await route.fulfill({ status: 200, json: value }); return;
    }
    if (url.pathname === `/api/imports/media-sources/${source.mediaSource.id}`) {
      if (scope !== null && scope !== "normal" && scope !== "history") { await route.fulfill({ status: 400, json: { code: "invalid-media-request" } }); return; }
      if (state.sourceRejected && scope !== "history") { await route.fulfill({ status: 404, json: { code: "not-found" } }); return; }
      const selected = state, failure = failRead, gate = nextGate;
      nextGate = null;
      if (gate) { heldReads++; try { await gate.promise; } finally { heldReads--; gates.delete(gate); } }
      await route.fulfill(failure
        ? { status: 502, json: { message: `Owned private error ${privatePath}` } }
        : { status: 200, json: { thought: root, run: selected.run, retry: selected.retry } });
      return;
    }
    if (url.pathname === `/api/imports/media-sources/${source.mediaSource.id}/raw`) {
      if (scope !== null && scope !== "normal" && scope !== "history") { await route.fulfill({ status: 400, json: { code: "invalid-media-request" } }); return; }
      if (state.sourceRejected && scope !== "history") { await route.fulfill({ status: 404, json: { code: "not-found" } }); return; }
      await route.fulfill({ status: 200, body: bytes, headers: { "content-type": "image/png", "content-disposition": 'attachment; filename="source.png"', "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
      return;
    }
    if (url.pathname.startsWith("/api/imports/media/by-key/")) {
      // A tempting but wrong status source: upload receipts always select this ORIGINAL run.
      await route.fulfill({ status: 200, json: { thought: source, run: originalRun } }); return;
    }
    if (url.pathname.startsWith("/api/imports/media-runs/") && state.run && url.pathname.endsWith(`/${state.run.id}`)) {
      await route.fulfill({ status: 200, json: state.run }); return;
    }
    await route.fulfill({ status: 404, json: { message: "Owned fixture route unavailable." } });
  };
  await page.route(pattern, handler);
  return {
    attempts,
    sourceReads: () => attempts.filter(item => item.path === `/api/imports/media-sources/${source.mediaSource.id}`).length,
    ideaReads: () => attempts.filter(item => item.method === "GET" && item.path === `/api/ideas/${source.id}`).length,
    rawReads: () => attempts.filter(item => item.path.endsWith("/raw")),
    heldReads: () => heldReads,
    heldIdeaReads: () => heldIdeaReads,
    set(next: SourceFixtureState) { state = next; failRead = false; },
    failSourceRead() { failRead = true; },
    holdNextSourceRead() {
      let release: () => void = () => {};
      const promise = new Promise<void>(resolve => { release = resolve; });
      const gate = { promise, release }; gates.add(gate); nextGate = gate;
      return release;
    },
    holdIdeaReads() {
      const gate = heldCommand(); gates.add(gate); ideaGate = gate;
      return async () => {
        if (ideaGate === gate) ideaGate = null;
        const deliveries = [...ideaDeliveries];
        gate.release(); gates.delete(gate);
        await Promise.all(deliveries);
      };
    },
    async close() { ideaGate = null; for (const gate of gates) gate.release(); await Promise.allSettled([...ideaDeliveries]); await page.unroute(pattern, handler); },
  };
}

export async function checkMediaReinterpretStatusOwner(page: Page, origin: string): Promise<void> {
  const run = currentRun("queued"), attempts: {method:string;key:string | null}[] = [];
  let admittedKey: string | null = null;
  const fixture = await installSourceFixture(page, {run:currentRun("completed",true),retry:{eligible:false,reason:"interpretation-exists"},outputs:true},
    {stop:async route => { await route.fulfill({json:{...run,status:"interrupted"}}); }});
  const pattern = `**/api/ideas/${source.id}/reinterpret**`;
  const handler = async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), key = request.headers()["idempotency-key"] ?? null;
    attempts.push({method:request.method(),key});
    if (request.method() === "POST") {
      if (!key) throw new Error("Expected a test-owned reinterpretation key");
      admittedKey = key;
      fixture.set({run,retry:{eligible:false,reason:"work-active"},outputs:true});
      await route.fulfill({status:202,json:{receipt:{subjectId:source.id,requestKey:key,runId:run.id},run,
        eligibility:{eligible:false,reason:"work-active",blockingRun:run}}}); return;
    }
    const requested = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    await route.fulfill({json:admittedKey === requested ? {receipt:{subjectId:source.id,requestKey:requested,runId:run.id},run,
      eligibility:{eligible:false,reason:"work-active",blockingRun:run}} : {receipt:null,run:null,eligibility:{eligible:true,reason:null,blockingRun:null}}});
  };
  await page.route(pattern,handler);
  try {
    await page.goto(origin,{waitUntil:"networkidle"}); await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${origin}/ideas/${source.id}`,{waitUntil:"networkidle"});
    await expect(page.getByText(interpretationText,{exact:true})).toBeVisible();
    await page.getByRole("button",{name:"More actions"}).click();
    await page.getByRole("button",{name:/^reinterpret$/i}).click();
    await expect.poll(() => attempts.filter(call => call.method === "POST").length).toBe(1);
    await expect(page.getByRole("button",{name:/^stop(?: work| interpretation| processing)?$/i})).toHaveCount(1);
    assert.equal(fixture.attempts.filter(call => call.method === "POST" && call.path.endsWith("/retry")).length,0);
    await page.getByRole("button",{name:/^stop(?: work| interpretation| processing)?$/i}).click();
    await expect.poll(() => fixture.attempts.filter(call => call.method === "POST" && call.path.endsWith("/stop")).length).toBe(1);
    await expect(page.getByText(interpretationText,{exact:true})).toBeVisible();
  } finally { await page.unroute(pattern,handler); await fixture.close(); }
}

/** Direct actual Idea rendering reaches the media title before asserting the missing source presentation. */
export async function checkMediaSourceStatus(page: Page, origin: string): Promise<void> {
  const fixture = await installSourceFixture(page, { run: currentRun("completed", true), retry: { eligible: false, reason: "interpretation-exists" }, outputs: true });
  try {
    await page.goto(`${origin}/ideas/${source.id}`, { waitUntil: "networkidle" });
    // Positive setup control: parser/Idea routing already render this canonical media record.
    await expect(page.getByRole("heading", { level: 1, name: filename, exact: true })).toBeVisible();
    await expect(page.getByText(/PNG image/)).toBeVisible();
    await expect(page.getByText(/Original authorship unverified/)).toBeVisible();
    const clarificationHeading = page.getByRole("heading", { name: "Your clarification", exact: true });
    await expect(clarificationHeading).toBeVisible();
    assert.equal(await clarificationHeading.locator("..").locator("p").textContent(), clarification, "source clarification must preserve its exact separate wording");
    const context = page.getByRole("heading", { name: "Surrounding context", exact: true }).locator("..");
    await expect(context.getByText(interpretationText, { exact: true })).toBeVisible();
    await expect(context.getByRole("link", { name: "Open idea", exact: true })).toHaveAttribute("href", new RegExp(`^/ideas/${interpretation.id}(?:\\?|$)`));
    await expect(page.getByRole("heading", { name: "Interpretation ready", exact: true })).toBeVisible();
    await expect(page.getByText(`Run ${currentRun("completed").id}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try interpretation again", exact: true }).and(page.locator(":enabled"))).toHaveCount(0);
    await page.getByRole("button", { name: "Full reply", exact: true }).click();
    await expect(page.getByText(fullReply.text, { exact: true })).toBeVisible();
    assert.equal(fixture.rawReads().length, 0, "viewing a descriptor must not open the original bytes");
    const downloading = page.waitForEvent("download");
    await choice(page, /^Download original$/i).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "source.png");
    const stream = await download.createReadStream(); assert.ok(stream);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes, "download must preserve the original bytes, not a preview or extracted text");
    assert.equal(fixture.rawReads().length, 1);
    assert.ok(fixture.rawReads().every(item => item.scope === null || item.scope === "normal"));

    await page.clock.install();
    fixture.set({ run: currentRun("failed", true), retry: { eligible: false, reason: "interpretation-exists" }, outputs: true });
    await page.getByRole("button", { name: "Check current processing", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Interpretation saved.*Processing failed/i })).toBeVisible();
    await expect(context.getByText(interpretationText, { exact: true })).toBeVisible();
    await expect(page.getByText(fullReply.text, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try interpretation again", exact: true }).and(page.locator(":enabled"))).toHaveCount(0);
    await page.clock.fastForward(10_000);
    assert.ok(!fixture.attempts.some(item => item.method !== "GET"), "reading, downloading and observing saved output must not submit work");
    assert.ok(!fixture.attempts.some(item => item.path.includes("/by-key/")), "source status must use the latest source run, not the original upload receipt");
    assert.ok(fixture.attempts.every(item => item.scope === null || item.scope === "normal"), "normal source reading must not broaden to history");
    assert.ok(!(await page.content()).includes(privatePath));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } finally { await fixture.close(); }
}

/** Eligibility is advisory, read failures are not run failures, and pending reads cannot leave stale retry enabled. */
export async function checkMediaSourceGates(page: Page, origin: string): Promise<void> {
  const fixture = await installSourceFixture(page, { run: currentRun("failed"), retry: { eligible: true, reason: null }, outputs: false });
  try {
    await page.goto(`${origin}/ideas/${source.id}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: filename, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interpretation · Failed", exact: true })).toBeVisible();
    const retry = page.getByRole("button", { name: "Try interpretation again", exact: true });
    await expect(retry).toBeEnabled();
    await expect(page.getByRole("button", { name: "Full reply", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Interpretation ready", exact: true })).toHaveCount(0);
    await page.clock.install();
    fixture.set({ run: currentRun("uncertain"), retry: { eligible: false, reason: "work-active" }, outputs: false });
    const release = fixture.holdNextSourceRead();
    await page.getByRole("button", { name: "Check current processing", exact: true }).click();
    await expect.poll(fixture.heldReads).toBe(1);
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);
    release();
    await expect(page.getByRole("heading", { name: "Interpretation · Status uncertain", exact: true })).toBeVisible();
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);

    fixture.failSourceRead();
    const before = fixture.sourceReads();
    await page.getByRole("button", { name: "Check current processing", exact: true }).click();
    await expect.poll(fixture.sourceReads).toBeGreaterThan(before);
    await expect(page.getByRole("heading", { name: "Current processing could not be checked", exact: true })).toBeVisible();
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Interpretation · Failed", exact: true })).toHaveCount(0);
    await expect(page.getByText(`Run ${currentRun("uncertain").id}`, { exact: true })).toBeVisible();
    assert.ok(!(await page.content()).includes(privatePath), "raw observation errors/private paths must not become UI copy");

    fixture.set({ run: currentRun("interrupted"), retry: { eligible: false, reason: "work-unsettled" }, outputs: false });
    await page.getByRole("button", { name: "Check current processing", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Interpretation · Interrupted", exact: true })).toBeVisible();
    await expect(page.getByText(/earlier work is still being settled/i)).toBeVisible();
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);
    await page.clock.fastForward(10_000);
    assert.ok(!fixture.attempts.some(item => item.method !== "GET"), "eligibility and missing output must never automatically admit work or reupload");
  } finally { await fixture.close(); }
}

function heldCommand() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function recordedSourceAttempt(attempts: readonly SourceAttempt[], index: number): SourceAttempt {
  const attempt = attempts[index]; assert.ok(attempt, `Expected source command ${index + 1}`); return attempt;
}

/** Real Idea controls drive keyed retries and known-run Stop; there is never another file upload. */
export async function checkMediaSourceRetry(page: Page, origin: string): Promise<void> {
  const retryGate = heldCommand(), stopGate = heldCommand();
  let reply: "unknown" | "replay" | "conflict" = "unknown";
  const admitted: MediaRun = { ...currentRun("queued"), id: "media-ui-admitted-retry-run" };
  const retryPath = `/api/imports/media-sources/${source.mediaSource.id}/retry`;
  const stopPath = `/api/imports/media-runs/${admitted.id}/stop`;
  const fixture = await installSourceFixture(page, { run: currentRun("failed"), retry: { eligible: true, reason: null }, outputs: false }, {
    async retry(route) {
      if (reply === "unknown") {
        await retryGate.promise;
        await route.fulfill({ status: 502, json: { message: `Owned unknown admission ${privatePath}` } });
      } else if (reply === "replay") await route.fulfill({ status: 200, json: { run: admitted } });
      else await route.fulfill({ status: 409, json: { code: "media-processing-conflict", message: "Processing changed." } });
    },
    async stop(route) {
      await stopGate.promise;
      await route.fulfill({ status: 502, json: { message: `Owned unknown Stop ${privatePath}` } });
    },
  });
  const retries = () => fixture.attempts.filter(item => item.method === "POST" && item.path === retryPath);
  const stops = () => fixture.attempts.filter(item => item.method === "POST" && item.path === stopPath);
  try {
    await page.goto(`${origin}/ideas/${source.id}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: filename, exact: true })).toBeVisible();
    const retry = page.getByRole("button", { name: "Try interpretation again", exact: true });
    // First RED is the actual missing source action, after the canonical source has rendered.
    await expect(retry).toBeEnabled();
    assert.equal(retries().length, 0, "eligibility is not an automatic processing request");
    await page.clock.install();
    await retry.evaluate(button => { if (!(button instanceof HTMLButtonElement)) throw new Error("Retry must be a button"); button.click(); button.click(); });
    await expect.poll(() => retries().length).toBe(1);
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);
    const first = recordedSourceAttempt(retries(), 0), key = first.key;
    assert.ok(key); assert.match(key, /^[A-Za-z0-9._:-]{1,128}$/);
    assert.equal(first.query, ""); assert.deepEqual(JSON.parse(first.body ?? "null"), {});
    assert.match(first.contentType ?? "", /^application\/json(?:;|$)/i);
    retryGate.release();
    await expect(page.getByRole("heading", { name: "Retry not confirmed", exact: true })).toBeVisible();
    await page.clock.fastForward(10_000);
    assert.equal(retries().length, 1, "an unknown retry must not automatically replay");

    const check = page.getByRole("button", { name: "Check current processing", exact: true });
    let reads = fixture.sourceReads();
    await check.click();
    await expect.poll(fixture.sourceReads).toBeGreaterThan(reads);
    await expect(page.getByRole("heading", { name: "Retry not confirmed", exact: true })).toBeVisible();
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);
    assert.equal(retries().length, 1, "Check is a source GET, not a same-key retry POST");
    // Even an advisory-eligible source cannot replace an unresolved local request key.
    await expect(page.getByRole("button", { name: "Send same retry request", exact: true })).toBeEnabled();

    fixture.set({ run: admitted, retry: { eligible: false, reason: "work-active" }, outputs: false });
    reads = fixture.sourceReads();
    await check.click();
    await expect.poll(fixture.sourceReads).toBeGreaterThan(reads);
    await expect(page.getByRole("heading", { name: "Retry not confirmed", exact: true })).toBeVisible();
    assert.equal(retries().length, 1, "a newly observed source run cannot prove which request admitted it");
    reply = "replay";
    await page.getByRole("button", { name: "Send same retry request", exact: true }).click();
    await expect.poll(() => retries().length).toBe(2);
    const replay = recordedSourceAttempt(retries(), 1);
    assert.equal(replay.key, key); assert.equal(replay.path, first.path); assert.equal(replay.query, "");
    assert.equal(replay.body, first.body);
    await expect(page.getByRole("heading", { name: "Retry not confirmed", exact: true })).toHaveCount(0);
    await expect(page.getByText(`Run ${admitted.id}`, { exact: true })).toBeVisible();
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);

    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect.poll(() => stops().length).toBe(1);
    await expect(stop).toBeDisabled();
    const stopping = recordedSourceAttempt(stops(), 0);
    assert.equal(stopping.query, ""); assert.deepEqual(JSON.parse(stopping.body ?? "null"), {});
    stopGate.release();
    await expect(page.getByRole("heading", { name: "Stop not confirmed", exact: true })).toBeVisible();
    await page.clock.fastForward(10_000);
    assert.equal(stops().length, 1, "unknown Stop must not be repeated automatically");
    fixture.failSourceRead();
    await check.click();
    await expect(page.getByRole("heading", { name: "Current processing could not be checked", exact: true })).toBeVisible();
    await expect(page.getByText(`Run ${admitted.id}`, { exact: true })).toBeVisible();
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);
    assert.ok(!(await page.content()).includes(privatePath));
    await page.clock.fastForward(10_000);
    assert.equal(stops().length, 1); assert.equal(retries().length, 2);

    // A successful current read settles observation, then a separate fresh command can race eligibility.
    fixture.set({ run: { ...admitted, status: "interrupted" }, retry: { eligible: true, reason: null }, outputs: false });
    await check.click();
    await expect(retry).toBeEnabled();
    reply = "conflict";
    await retry.click();
    await expect.poll(() => retries().length).toBe(3);
    const fresh = recordedSourceAttempt(retries(), 2);
    assert.ok(fresh.key); assert.notEqual(fresh.key, key, "only a resolved prior command permits a fresh retry key");
    await expect(page.getByRole("heading", { name: "Retry could not start", exact: true })).toBeVisible();
    fixture.set({ run: { ...currentRun("queued"), id: "media-ui-concurrent-run" }, retry: { eligible: false, reason: "work-active" }, outputs: false });
    await check.click();
    await expect(page.getByText("Run media-ui-concurrent-run", { exact: true })).toBeVisible();
    await expect(retry.and(page.locator(":enabled"))).toHaveCount(0);
    await page.clock.fastForward(10_000);
    assert.equal(retries().length, 3, "a conflict requires a read and a new explicit decision, not automatic replay");
    assert.ok(fixture.attempts.filter(item => item.method === "POST").every(item => item.path === retryPath || item.path === stopPath), "retry and Stop must never upload another file or mutate a thought");
    assert.ok(fixture.attempts.every(item => item.scope === null || item.scope === "normal"));
  } finally { retryGate.release(); stopGate.release(); await fixture.close(); }
}

/** Inspection is explicit and user-only; rejection does not delete original bytes or permit a second initial interpretation. */
export async function checkMediaSourceRejected(page: Page, origin: string): Promise<void> {
  const hiddenChild: SourceFixtureState = { run: currentRun("completed", true), retry: { eligible: false, reason: "interpretation-exists" }, outputs: true, childRejected: true };
  const fixture = await installSourceFixture(page, hiddenChild);
  const freshRetry = page.getByRole("button", { name: /^(?:Try interpretation again|Request interpretation)$/i }).and(page.locator(":enabled"));
  try {
    await page.goto(`${origin}/ideas/${source.id}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: filename, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Initial interpretation already recorded", exact: true })).toBeVisible();
    await expect(page.getByText(interpretationText, { exact: true })).toHaveCount(0);
    await expect(freshRetry).toHaveCount(0);
    assert.ok(fixture.attempts.every(item => item.scope === null || item.scope === "normal"), "a hidden initial interpretation must not trigger silent history reads");
    await choice(page, /^Inspect recorded context$/i).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toMatch(/^(?:history|show-rejected)$/);
    await expect(page.getByText(/^User inspection/).first()).toBeVisible();
    await expect(page.getByText("Rejected content is unavailable to AI.", { exact: false })).toBeVisible();
    const context = page.getByRole("heading", { name: "Inspected context", exact: true }).locator("..");
    await expect(context.getByText(interpretationText, { exact: true })).toBeVisible();
    await expect(freshRetry).toHaveCount(0);
    const openChild = context.getByRole("link", { name: "Open idea", exact: true });
    const childHref = await openChild.getAttribute("href"); assert.ok(childHref);
    assert.match(new URL(childHref, origin).searchParams.get("scope") ?? "", /^(?:history|show-rejected)$/);
    await openChild.click();
    await expect(page.getByRole("heading", { level: 1, name: interpretationTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Evolve this idea", exact: true })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Evolve this idea", exact: true })).toHaveCount(0);
    await expect(page.getByText("Rejected content is unavailable to AI.", { exact: false })).toBeVisible();

    fixture.set({ ...hiddenChild, sourceRejected: true, retry: { eligible: false, reason: "source-rejected" } });
    const mark = fixture.attempts.length;
    await page.goto(`${origin}/ideas/${source.id}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: /^(?:Idea|Source) unavailable$/ })).toBeVisible();
    assert.ok(fixture.attempts.slice(mark).every(item => item.scope === null || item.scope === "normal"), "normally unavailable source must not automatically enter inspection");
    await choice(page, /^Inspect (?:source|(?:rejected )?idea)$/i).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toMatch(/^(?:history|show-rejected)$/);
    await expect(page.getByRole("heading", { level: 1, name: filename, exact: true })).toBeVisible();
    await expect(page.getByText(/^User inspection/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Evolve this idea", exact: true })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Evolve this idea", exact: true })).toHaveCount(0);
    await expect(freshRetry).toHaveCount(0);
    assert.equal(fixture.rawReads().length, 0, "explicit metadata inspection still must not read file bytes automatically");
    const downloading = page.waitForEvent("download");
    await choice(page, /^Download original$/i).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "source.png");
    const stream = await download.createReadStream(); assert.ok(stream);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(fixture.rawReads().length, 1);
    assert.ok(fixture.rawReads().every(item => item.scope === "history"), "rejected-source download uses explicit media history, never a normal or show-rejected raw request");
    const sourceInspections = fixture.attempts.filter(item => item.path === `/api/imports/media-sources/${source.mediaSource.id}` && item.scope !== null && item.scope !== "normal");
    assert.ok(sourceInspections.length > 0);
    assert.ok(sourceInspections.every(item => item.scope === "history"));
    assert.ok(!fixture.attempts.some(item => item.method !== "GET"), "inspection/download must not restore, retry, Stop or start Evolve");
    assert.ok(!(await page.content()).includes(privatePath));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } finally { await fixture.close(); }
}

/** BTR-S1: a successful ordinary restore must resume the same scoped source observer. */
export async function checkMediaSourceRestore(page: Page, origin: string): Promise<void> {
  const fixture = await installSourceFixture(page, { run: currentRun("failed"), retry: { eligible: false, reason: "source-rejected" }, outputs: false, sourceRejected: true }, {
    async idea(route, apply) {
      assert.deepEqual(route.request().postDataJSON(), { action: "restore-thought", thoughtId: source.id });
      apply({ sourceRejected: false, retry: { eligible: true, reason: null } });
      await route.fulfill({ status: 204 });
    },
  });
  try {
    await page.clock.install();
    await page.goto(`${origin}/ideas/${source.id}?scope=history`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: filename, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interpretation unavailable for rejected source", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Evolve this idea", exact: true })).toBeDisabled();
    const readsBefore = fixture.sourceReads(), ideasBefore = fixture.ideaReads();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("button", { name: "Restore this idea", exact: true }).click();
    await expect.poll(fixture.ideaReads).toBeGreaterThan(ideasBefore);
    await expect(page.getByText(/^Restored\. Independently rejected connections stay rejected\.$/)).toBeVisible();
    // The canonical Idea was restored; stale observer rejection must not keep its action blocked.
    await expect(page.getByRole("link", { name: "Evolve this idea", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interpretation · Failed", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interpretation unavailable for rejected source", exact: true })).toHaveCount(0);
    assert.ok(fixture.sourceReads() > readsBefore, "successful restore must automatically refresh source eligibility, without manual Check");
    assert.equal(new URL(page.url()).searchParams.get("scope"), "history");
    assert.ok(fixture.attempts.filter(item => item.method === "GET").every(item => item.scope === "history"), "restoration must preserve explicit user-inspection scopes");
    const writes = fixture.attempts.filter(item => item.method !== "GET");
    assert.equal(writes.length, 1);
    const restored = recordedSourceAttempt(writes, 0);
    assert.equal(restored.path, `/api/ideas/${source.id}`);
    assert.deepEqual(JSON.parse(restored.body ?? "null"), { action: "restore-thought", thoughtId: source.id });
    await expect(page.getByRole("button", { name: /^(?:Try interpretation again|Request interpretation)$/i }).and(page.locator(":enabled"))).toHaveCount(0);
  } finally { await fixture.close(); }
}

/** BTR-S2: title writes fence stale canonical reads, but must not consume unpublished output-refresh intent. */
export async function checkMediaSourceTitleRace(page: Page, origin: string): Promise<void> {
  const savedTitle = "Owned title saved during interpretation completion";
  const titleReceipt = heldCommand();
  const fixture = await installSourceFixture(page, { run: currentRun("running"), retry: { eligible: false, reason: "work-active" }, outputs: false }, {
    async idea(route, apply) {
      assert.deepEqual(route.request().postDataJSON(), { action: "title", thoughtId: source.id, title: savedTitle });
      apply({ title: savedTitle });
      await titleReceipt.promise;
      await route.fulfill({ status: 200, json: { ...source, title: savedTitle, titleAuthor: "user" } });
    },
  });
  try {
    await page.clock.install();
    await page.goto(`${origin}/ideas/${source.id}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: filename, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interpretation · Running", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit title", exact: true }).click();
    const field = page.getByRole("textbox", { name: "Title", exact: true });
    await field.fill(savedTitle);
    const releaseCanonical = fixture.holdIdeaReads();
    fixture.set({ run: currentRun("completed", true), retry: { eligible: false, reason: "interpretation-exists" }, outputs: true });
    // Advance the owned browser clock to deliver the existing observer's next poll.
    // The held route, not an arbitrary sleep, establishes the overlapping canonical read.
    await page.clock.fastForward(10_000);
    await expect.poll(fixture.heldIdeaReads).toBeGreaterThan(0);
    await expect(field).toHaveValue(savedTitle);
    await expect(page.getByText(interpretationText, { exact: true })).toHaveCount(0);
    const readsBeforeSave = fixture.ideaReads();
    await page.getByRole("button", { name: "Save title", exact: true }).click();
    await expect.poll(() => fixture.attempts.filter(item => item.method === "POST").length).toBe(1);
    await expect(field).toHaveJSProperty("readOnly", true);
    // Deliver the old-title canonical response only after Save has fenced its generation.
    await releaseCanonical();
    titleReceipt.release();
    await expect(page.getByRole("heading", { level: 1, name: savedTitle, exact: true })).toBeVisible();
    await expect(field).toHaveCount(0);
    const context = page.getByRole("heading", { name: "Surrounding context", exact: true }).locator("..");
    await expect(context.getByText(interpretationText, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interpretation ready", exact: true })).toBeVisible();
    assert.ok(fixture.ideaReads() > readsBeforeSave, "fenced output intent requires a replacement canonical read, not stale response publication or manual Check");
    assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), savedTitle);
    await page.getByRole("button", { name: "Full reply", exact: true }).click();
    await expect(page.getByText(fullReply.text, { exact: true })).toBeVisible();
    const clarificationHeading = page.getByRole("heading", { name: "Your clarification", exact: true });
    assert.equal(await clarificationHeading.locator("..").locator("p").textContent(), clarification);
    const writes = fixture.attempts.filter(item => item.method !== "GET");
    assert.equal(writes.length, 1);
    const saved = recordedSourceAttempt(writes, 0);
    assert.equal(saved.path, `/api/ideas/${source.id}`);
    assert.deepEqual(JSON.parse(saved.body ?? "null"), { action: "title", thoughtId: source.id, title: savedTitle });
    assert.ok(fixture.attempts.every(item => item.scope === null || item.scope === "normal"));
  } finally { titleReceipt.release(); await fixture.close(); }
}

/** BTR-S3: an ordinary command's canonical reload must not be stranded by retained output intent. */
export async function checkMediaSourceCommandRace(page: Page, origin: string): Promise<void> {
  const preservedTitle = "Owned source title retained across connection restore";
  const fixture = await installSourceFixture(page, { run: currentRun("running"), retry: { eligible: false, reason: "work-active" },
    outputs: false, title: preservedTitle, connectionRejected: true }, {
    async idea(route, apply) {
      assert.deepEqual(route.request().postDataJSON(), { action: "restore-connection", thoughtId: source.id, connectionId: sourceConnection.id });
      apply({ connectionRejected: false });
      await route.fulfill({ status: 204 });
    },
  });
  try {
    await page.clock.install();
    await page.goto(`${origin}/ideas/${source.id}?scope=history`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: preservedTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interpretation · Running", exact: true })).toBeVisible();
    const restore = page.getByRole("button", { name: "Restore connection", exact: true });
    await expect(restore).toBeEnabled();
    await expect(page.getByText(sourceConnection.explanation, { exact: true })).toBeVisible();

    const releaseCanonical = fixture.holdIdeaReads();
    fixture.set({ run: currentRun("completed", true), retry: { eligible: false, reason: "interpretation-exists" },
      outputs: true, title: preservedTitle, connectionRejected: true });
    await page.clock.fastForward(10_000);
    await expect.poll(fixture.heldIdeaReads).toBeGreaterThan(0);
    await expect(page.getByText(interpretationText, { exact: true })).toHaveCount(0);
    const readsBeforeCommand = fixture.ideaReads(), observationsBeforeCommand = fixture.sourceReads();
    await restore.click();
    await expect.poll(() => fixture.attempts.filter(item => item.method === "POST").length).toBe(1);
    await expect(page.getByText("Connection change confirmed.", { exact: true })).toBeVisible();
    await expect.poll(fixture.ideaReads).toBeGreaterThan(readsBeforeCommand);
    // Leave all canonical responses held while already-committed passive effects
    // get their browser task turns. This exposes an accidental competing refresh,
    // without requiring that a correct implementation issue that extra request.
    await page.evaluate(async () => {
      for (let turn = 0; turn < 2; turn++) await new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
        channel.port2.postMessage(null);
      });
    });
    await releaseCanonical();
    // First regression assertion: the real page must leave Loading after its reads settle.
    await expect(page.getByRole("heading", { level: 1, name: preservedTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Loading idea…", exact: true })).toHaveCount(0);
    const context = page.getByRole("heading", { name: "Inspected context", exact: true }).locator("..");
    await expect(context.getByText(interpretationText, { exact: true })).toBeVisible();
    await expect(restore).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Interpretation ready", exact: true })).toBeVisible();
    await expect.poll(fixture.sourceReads).toBeGreaterThan(observationsBeforeCommand);
    await expect(page.getByRole("button", { name: "Check current processing", exact: true })).toBeEnabled();
    assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), preservedTitle);
    const clarificationHeading = page.getByRole("heading", { name: "Your clarification", exact: true });
    assert.equal(await clarificationHeading.locator("..").locator("p").textContent(), clarification);
    await page.getByRole("button", { name: "Full reply", exact: true }).click();
    await expect(page.getByText(fullReply.text, { exact: true })).toBeVisible();
    const writes = fixture.attempts.filter(item => item.method !== "GET");
    assert.equal(writes.length, 1, "settling ordinary reload/output observation must not repeat any command");
    const command = recordedSourceAttempt(writes, 0);
    assert.equal(command.path, `/api/ideas/${source.id}`);
    assert.deepEqual(JSON.parse(command.body ?? "null"), { action: "restore-connection", thoughtId: source.id, connectionId: sourceConnection.id });
    assert.equal(new URL(page.url()).searchParams.get("scope"), "history");
    assert.ok(fixture.attempts.filter(item => item.method === "GET").every(item => item.scope === "history"));
  } finally { await fixture.close(); }
}
