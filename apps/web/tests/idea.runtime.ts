import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";
import { expectGlyph } from "./explore.runtime";

type Attempt = { method: string; path: string; authorization: string | undefined; body: string };
const original = "Owned original idea wording, unchanged by title edits.";
const thought = { id: "idea-root", text: original, title: "Owned original title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: "idea-parent", sourceIds: ["idea-source", "idea-hidden", "idea-child"] };
const source = { ...thought, id: "idea-source", text: "Owned supporting source", title: "Owned source", parentId: null, sourceIds: [] };
const parent = { ...thought, id: "idea-parent", text: "Owned rejected ancestor", title: "Owned parent", parentId: null, sourceIds: [] };
const plain = { ...thought, id: "idea-plain", text: "Owned plain idea with no reply", title: "Plain idea", parentId: null, sourceIds: [] };
const imported = { ...plain, id: "idea-imported", text: "Owned imported idea", title: "Imported idea", author: "source", kind: "imported-original", origin: "markdown-import" };
const child = { ...thought, id: "idea-child", text: "Owned direct interpretation", title: "Owned interpretation", titleAuthor: null, author: "ai", kind: "ai-interpretation", parentId: "idea-root", sourceIds: ["idea-root", "idea-hidden"] };
const grandchild = { ...child, id: "idea-grandchild", text: "Owned grandchild not direct context", title: "Owned grandchild", parentId: "idea-child", sourceIds: [] };
const edge = { id: "idea-edge", fromId: "idea-root", toId: "idea-source", category: "supports", proposedBy: "ai", explanation: "Owned directed connection rationale", sourceIds: [] };
const hiddenEdge = { ...edge, id: "idea-hidden-edge", toId: "idea-hidden", explanation: "Endpoint hidden only" };
const childEdge = { ...edge, id: "idea-child-edge", toId: "idea-child", explanation: "Owned overlapping connection rationale" };
const reply = { id: "idea-reply", text: "Owned associated full reply", role: "addendum", state: "complete", thoughtIds: ["idea-root"] };
const preview3 = { rootId: "idea-root", branchIds: ["idea-root", "idea-child-1", "idea-child-2"], affectedIds: ["idea-root", "idea-child-1", "idea-child-2"], count: 3 };
const preview4 = { rootId: "idea-root", branchIds: [...preview3.branchIds, "idea-child-3"], affectedIds: [...preview3.affectedIds, "idea-child-3"], count: 4 };

export function ideaDaemon(token: string) {
  const attempts: Attempt[] = [];
  let title: string | null = thought.title, rootRejected = false, childEdgeRejected = false, branchAttempt = 0;
  let holdPreview = false, holdTitle = false, failure = false;
  let connectionStatus: 201 | 400 | 404 | 500 = 201, holdConnection = false;
  let releasePreview: (() => void) | undefined, releaseTitle: (() => void) | undefined;
  let releaseConnection: (() => void) | undefined;
  return {
    attempts, expectedAuthorization: `Bearer ${token}`,
    currentTitle() { return title; },
    freshPreviewWaiting() { return releasePreview !== undefined; },
    reset() { title = thought.title; rootRejected = false; childEdgeRejected = false; branchAttempt = 0; holdPreview = false; holdTitle = false; failure = false; connectionStatus = 201; holdConnection = false; },
    holdFreshPreview() { holdPreview = true; },
    releasePreview() { releasePreview?.(); releasePreview = undefined; holdPreview = false; },
    holdTitle() { holdTitle = true; },
    releaseTitle() { releaseTitle?.(); releaseTitle = undefined; holdTitle = false; },
    failWrites(value: boolean) { failure = value; },
    connectionStatus(value: typeof connectionStatus) { connectionStatus = value; },
    holdConnection() { holdConnection = true; },
    releaseConnection() { releaseConnection?.(); releaseConnection = undefined; holdConnection = false; },
    async handler(req: IncomingMessage, res: ServerResponse) {
      let body = ""; for await (const chunk of req) body += String(chunk);
      const path = req.url ?? "", method = req.method ?? "";
      attempts.push({ path, method, authorization: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const url = new URL(path, "http://fixture.invalid");
      const inspection = url.searchParams.get("scope") === "history" || url.searchParams.get("scope") === "show-rejected";
      const send = (value: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (method === "GET") {
        if (url.pathname === "/thoughts/idea-root/branch/preview") {
          if (branchAttempt > 0 && holdPreview) await new Promise<void>(resolve => { releasePreview = resolve; });
          send(branchAttempt ? preview4 : preview3); return;
        }
        if (url.pathname === "/thoughts/idea-root") { if (rootRejected && !inspection) { res.writeHead(404).end(); return; } send({ ...thought, title, titleAuthor: title === null ? null : "user", ...(inspection ? { rejected: rootRejected } : {}) }); return; }
        if (url.pathname === "/thoughts/idea-plain") { send({ ...plain, ...(inspection ? { rejected: false } : {}) }); return; }
        if (url.pathname === "/thoughts/idea-imported") { send({ ...imported, ...(inspection ? { rejected: false } : {}) }); return; }
        if (url.pathname === "/thoughts/thought-1") { send({ ...plain, id: "thought-1", text: "Owned matching thought for contextual navigation", title: "Owned development", author: "ai", kind: "developing-idea" }); return; }
        if (/^\/thoughts\/thought-1\/(?:children|connections|responses)$/.test(url.pathname)) { send([]); return; }
        if (url.pathname === "/thoughts/idea-source") { send({ ...source, ...(inspection ? { rejected: false } : {}) }); return; }
        if (url.pathname === "/thoughts/idea-child") { send({ ...child, ...(inspection ? { rejected: false } : {}) }); return; }
        if (url.pathname === "/thoughts/idea-grandchild") { send({ ...grandchild, ...(inspection ? { rejected: false } : {}) }); return; }
        if (url.pathname === "/thoughts/idea-parent") { if (!inspection) { res.writeHead(404).end(); return; } send({ ...parent, rejected: true }); return; }
        if (url.pathname === "/thoughts/idea-hidden") { res.writeHead(404).end(); return; }
        if (url.pathname.endsWith("/connections")) { send(url.pathname.includes("idea-root") ? (inspection ? [{ ...edge, rejected: true }, { ...hiddenEdge, rejected: false }, { ...childEdge, rejected: childEdgeRejected }] : [edge, ...(!childEdgeRejected ? [childEdge] : [])]) : []); return; }
        if (url.pathname.endsWith("/responses")) { send(url.pathname.includes("idea-root") ? [reply] : []); return; }
        if (url.pathname.endsWith("/children")) { send(url.pathname === "/thoughts/idea-root/children" ? [child] : url.pathname === "/thoughts/idea-child/children" ? [grandchild] : []); return; }
        res.writeHead(404).end(); return;
      }
      if (failure) { res.writeHead(500).end("owned private write failure"); return; }
      if (url.pathname === "/connections" && method === "POST") {
        if (holdConnection) await new Promise<void>(resolve => { releaseConnection = resolve; });
        if (connectionStatus !== 201) { res.writeHead(connectionStatus).end("owned private connection failure"); return; }
        const value: unknown = JSON.parse(body);
        if (!value || typeof value !== "object") { res.writeHead(400).end(); return; }
        send({ ...value, id: "owned-created-connection", proposedBy: "user" }, 201); return;
      }
      if (url.pathname === "/thoughts/idea-root/title" && method === "PUT") {
        if (holdTitle) await new Promise<void>(resolve => { releaseTitle = resolve; });
        const value: unknown = JSON.parse(body);
        if (!value || typeof value !== "object" || !("title" in value) || !(typeof value.title === "string" || value.title === null)) { res.writeHead(400).end(); return; }
        title = value.title;
        send({ ...thought, title, titleAuthor: title === null ? null : "user" }); return;
      }
      if (url.pathname === "/thoughts/idea-root/branch/reject") { branchAttempt++; if (branchAttempt === 1) { res.writeHead(409).end(); return; } rootRejected = true; res.writeHead(204).end(); return; }
      if (url.pathname === "/connections/idea-child-edge/reject") childEdgeRejected = true;
      if (url.pathname === "/thoughts/idea-root/reject") rootRejected = true;
      if (url.pathname === "/thoughts/idea-root/restore" || url.pathname === "/thoughts/idea-root/branch/restore") rootRejected = false;
      res.writeHead(204).end();
    },
  };
}

type Fixture = ReturnType<typeof ideaDaemon>;
type SearchFixture = ReturnType<typeof import("./explore.runtime").searchDaemon>;

export function connectionRejectCount(daemon: Fixture, walkthroughStart: number): number {
  return daemon.attempts.slice(walkthroughStart).filter(call => call.path === "/connections/idea-child-edge/reject").length;
}

export async function checkIdeaGlyphs(page: Page, daemon: Fixture, origin: string): Promise<void> {
  daemon.reset();
  await page.goto(`${origin}/ideas/idea-imported`, { waitUntil: "networkidle" });
  await expect(page.getByText(imported.text, { exact: true })).toBeVisible();
  const focused = page.locator("main").locator("div").filter({ has: page.getByRole("heading", { name: "Imported idea", exact: true }) }).filter({ has: page.getByText(imported.text, { exact: true }) }).last();
  await expect(focused).toContainText("Imported source");
  await expectGlyph(focused, "imported-original.svg", 24);
  await page.goto(`${origin}/ideas/idea-root?responseId=idea-reply`, { waitUntil: "networkidle" });
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  const rootFocus = page.locator("main").locator("div").filter({ has: page.getByRole("heading", { name: "Owned original title", exact: true }) }).filter({ has: page.getByText(original, { exact: true }) }).last();
  await expect(rootFocus).toContainText("You");
  await expectGlyph(rootFocus, "captured-original.svg", 24);
  const replyRegion = page.locator("#idea-reply");
  await expect(replyRegion.getByText(reply.text, { exact: true })).toBeVisible();
  await expect(replyRegion).toContainText("AI");
  await expectGlyph(replyRegion, "full-reply.svg", 20);
  const childRow = page.locator("article").filter({ has: page.getByRole("link", { name: "Owned interpretation", exact: true }) });
  await expect(childRow).toContainText("Developed from this idea");
  await expect(childRow).toContainText("Used as a source for this idea");
  await expect(childRow).toContainText("Supports");
  await expectGlyph(childRow, "ai-interpretation.svg", 20);
  await expectGlyph(childRow, "evolution.svg", 16);
  await expectGlyph(childRow, "used-as-source.png", 16);
  await expectGlyph(childRow, "connection.png", 16);
  await childRow.getByRole("button", { name: "Why connected" }).click();
  await expect(childRow).toContainText("Recorded direction: idea-root to idea-child");
}
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;
export async function checkIdeaRoute({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const start = daemon.attempts.length;
  assert.equal((await probe("GET", "/api/ideas/idea-root", `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
  const body = JSON.stringify({ action: "reject-thought", thoughtId: "idea-root" });
  const headers = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
  assert.equal((await probe("POST", "/api/ideas/idea-root", `Host: ${host}\r\nOrigin: http://foreign.invalid\r\n${headers}`, body)).status, 403);
  assert.equal((await probe("POST", "/api/ideas/idea-root", `Host: ${host}\r\n${headers}`, body)).status, 403);
  assert.equal(daemon.attempts.length, start);
  const root = await fetch(`${origin}/api/ideas/idea-root?scope=normal&part=view`);
  assert.equal(root.status, 200); assert.match(root.headers.get("cache-control") ?? "", /no-store/i);
  const view = await root.json(); assert.equal(view.thought.text, original); assert.deepEqual(view.responses, [reply]);
  const plainRead = await fetch(`${origin}/api/ideas/idea-plain?scope=normal&part=view`);
  assert.equal(plainRead.status, 200); assert.deepEqual((await plainRead.json()).responses, []);
  assert.equal((await fetch(`${origin}/api/ideas/idea-missing?scope=normal&part=view`)).status, 404);
  const titleResponse = await fetch(`${origin}/api/ideas/idea-root`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ action: "title", thoughtId: "idea-root", title: null }) });
  assert.equal(titleResponse.status, 200); assert.equal((await titleResponse.json()).text, original);
  const commandResponse = await fetch(`${origin}/api/ideas/idea-root`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  assert.equal(commandResponse.status, 204);
  const calls = daemon.attempts.slice(start);
  assert.ok(calls.every(call => call.authorization === daemon.expectedAuthorization));
  assert.ok(calls.some(call => call.method === "PUT" && call.path === "/thoughts/idea-root/title" && call.body === '{"title":null}'));
  assert.ok(calls.some(call => call.method === "POST" && call.path === "/thoughts/idea-root/reject" && call.body === ""));
  daemon.reset();
}

async function checkStaleConnectionSearch(page: Page, daemon: Fixture, searchDaemon: SearchFixture, origin: string): Promise<void> {
  daemon.reset();
  const scenarioStart = daemon.attempts.length;
  await page.goto(`${origin}/ideas/idea-root`, { waitUntil: "networkidle" });
  // Force the old response to arrive even when the picker aborts its signal.
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    (window as Window & { ownedFetch?: typeof fetch }).ownedFetch = originalFetch;
    window.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => originalFetch(input, String(input).includes("q=owned") ? { ...init, signal: undefined } : init),
      originalFetch,
    );
  });
  try {
    await page.getByRole("button", { name: /connect to another thought/i }).click();
    const main = page.locator("main"), search = main.getByRole("textbox", { name: /search.*thought/i }).first();
    const button = main.getByRole("button", { name: /^search$/i }).first();
    const start = searchDaemon.attempts.length;
    searchDaemon.setMode("hold");
    await search.fill("owned");
    await button.click();
    await expect.poll(() => searchDaemon.attempts.slice(start).some(call => new URL(call.path, origin).searchParams.get("q") === "owned")).toBe(true);
    searchDaemon.setMode("normal");
    await search.fill("source-owned");
    await button.click();
    const newer = main.locator("article").filter({ hasText: "Owned imported search text" });
    await expect(newer).toBeVisible();
    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search" && new URL(response.url()).searchParams.get("q") === "owned");
    searchDaemon.release();
    assert.equal((await oldResponse).status(), 200);
    await expect(newer).toBeVisible();
    await expect(main.locator("article").filter({ hasText: "Owned matching thought begins" })).toHaveCount(0);
    await newer.getByRole("button", { name: /choose|select/i }).click();
    await expect(main.getByText("Owned imported search text", { exact: true }).first()).toBeVisible();
    page.once("dialog", dialog => { void dialog.accept(); });
    await main.getByRole("button", { name: /^cancel$/i }).click();
    await expect(search).not.toBeVisible();
    assert.equal(daemon.attempts.slice(scenarioStart).filter(call => call.method === "POST" && call.path === "/connections").length, 0);
  } finally {
    searchDaemon.setMode("normal");
    searchDaemon.release();
    await page.evaluate(() => {
      const owned = window as Window & { ownedFetch?: typeof fetch };
      if (owned.ownedFetch) window.fetch = owned.ownedFetch;
      delete owned.ownedFetch;
    });
  }
}

async function checkConnectionDraftLeaving(page: Page, daemon: Fixture, origin: string): Promise<void> {
  daemon.reset();
  await page.goto(`${origin}/ideas/idea-root`, { waitUntil: "networkidle" });
  const action = page.getByRole("button", { name: /connect to another thought/i });
  const rationale = page.getByRole("textbox", { name: /(?:rationale|explanation|why)/i });
  const writes = () => daemon.attempts.filter(call => call.path === "/connections" && call.method === "POST").length;
  const before = writes();
  const dialogs: string[] = [];
  const handleDialog = async (dialog: import("@playwright/test").Dialog) => { dialogs.push(dialog.type()); await dialog.accept(); };
  page.on("dialog", handleDialog);
  try {
    await action.click();
    await rationale.fill("Owned refresh draft");
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(dialogs, [], "refresh must not ask for discard confirmation");
    await action.click();
    await expect(rationale).toHaveValue("");
    await rationale.fill("Owned navigation draft");
    await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*(?:results|explore)/i }).click();
    await expect(page).toHaveURL(url => url.pathname === "/explore");
    assert.deepEqual(dialogs, [], "contextual navigation must not ask for discard confirmation");
    await page.goto(`${origin}/ideas/idea-root`, { waitUntil: "networkidle" });
    await action.click();
    await expect(rationale).toHaveValue("");
    assert.equal(writes(), before, "leaving an unfinished draft must not create a connection");
  } finally { page.off("dialog", handleDialog); }
}

async function checkUserConnection(page: Page, daemon: Fixture, origin: string): Promise<void> {
  daemon.reset();
  await page.goto(`${origin}/ideas/idea-root`, { waitUntil: "networkidle" });
  const action = page.getByRole("button", { name: /connect to another thought/i });
  await action.focus();
  await expect(action).toBeFocused();
  assert.ok(await action.evaluate(element => element.matches(":focus-visible")), "Connect needs visible keyboard focus");
  await page.keyboard.press("Enter");
  const main = page.locator("main");
  const search = main.getByRole("textbox", { name: /search.*thought/i }).first();
  await expect(search).toBeVisible();
  await search.fill("owned");
  const searchResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search" && new URL(response.url()).searchParams.get("q") === "owned");
  await main.getByRole("button", { name: /^search$/i }).first().click();
  const searchUrl = new URL((await searchResponse).url());
  assert.ok(!searchUrl.searchParams.has("scope") || searchUrl.searchParams.get("scope") === "normal");
  const match = main.locator("article").filter({ hasText: "Owned matching thought begins" }).first();
  await expect(match).toBeVisible();
  await match.getByRole("button", { name: /choose|select/i }).click();
  await expect(main.getByText("Owned matching thought for contextual navigation", { exact: true })).toBeVisible();
  await search.fill("owned");
  await main.getByRole("button", { name: /^search$/i }).first().click();
  const replyHit = main.locator("article").filter({ hasText: "Owned response original full wording" }).first();
  await replyHit.getByRole("button", { name: /choose|select/i }).click();
  await expect(main.getByText("Owned matching thought for contextual navigation", { exact: true })).toBeVisible();
  for (const category of ["Supports", "Contradicts", "Extends", "Related"]) await expect(main.getByRole("radio", { name: new RegExp(category, "i") })).not.toBeChecked();
  await main.getByRole("radio", { name: /supports/i }).check();
  const explanation = main.getByRole("textbox", { name: /(?:rationale|explanation|why)/i });
  const submit = main.getByRole("button", { name: /^create connection$/i });
  await expect(submit).toBeDisabled();
  await explanation.fill("Owned connection rationale");
  const sourceSearch = main.getByRole("textbox", { name: /search.*supporting|supporting.*search/i });
  await sourceSearch.fill("source-owned");
  await main.getByRole("button", { name: /search.*supporting/i }).click();
  const sourceResult = main.locator("article").filter({ hasText: "Owned imported search text" }).first();
  await expect(sourceResult).toContainText("Owned imported search result");
  await sourceResult.getByRole("button", { name: /choose|add|select/i }).click();
  const remove = main.getByRole("button", { name: /remove supporting thought/i });
  await expect(remove).toBeVisible();
  await expect(main.getByText(/imported source/i).first()).toBeVisible();
  await remove.click();
  await expect(remove).toHaveCount(0);
  await sourceSearch.fill("source-owned");
  await main.getByRole("button", { name: /search.*supporting/i }).click();
  await sourceResult.getByRole("button", { name: /choose|add|select/i }).click();
  const directions = main.getByRole("radio", { name: /owned.*(?:supports|supported by).*owned/i });
  assert.ok(await directions.count() >= 2, "direction choices must identify both thoughts in sentences");
  await main.getByRole("radio", { name: /owned development.*supports.*owned original title/i }).check();
  await expect(explanation).toHaveValue("Owned connection rationale");
  await expect(remove).toBeVisible();
  const review = main.getByRole("region", { name: /review/i });
  await expect(review).toContainText("Owned original title");
  await expect(review).toContainText("Owned development");
  await expect(review).toContainText("Owned connection rationale");
  await expect(review).toContainText("Owned imported search result");
  const declineDiscard = async (trigger: () => Promise<void>) => {
    let dismissed = false;
    const handler = async (dialog: import("@playwright/test").Dialog) => { dismissed = true; await dialog.dismiss(); };
    page.once("dialog", handler);
    try {
      await trigger();
      if (!dismissed) {
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: /keep|stay|cancel/i }).click();
      }
    } finally { page.off("dialog", handler); }
    await expect(explanation).toHaveValue("Owned connection rationale");
    await expect(remove).toBeVisible();
    await expect(page).toHaveURL(url => url.pathname === "/ideas/idea-root");
  };
  await declineDiscard(() => main.getByRole("button", { name: /^cancel$/i }).click());
  for (const status of [400, 404] as const) {
    daemon.connectionStatus(status);
    const before = daemon.attempts.filter(call => call.path === "/connections").length;
    await submit.click();
    await expect.poll(() => daemon.attempts.filter(call => call.path === "/connections").length).toBe(before + 1);
    await expect(explanation).toHaveValue("Owned connection rationale");
    await expect(remove).toBeVisible();
    await expect(main.getByText(/(?:unavailable|not applied|could not create)/i).first()).toBeVisible();
    await expect(main.getByText(/(?:was|is) rejected/i)).toHaveCount(0);
  }
  daemon.connectionStatus(201);
  daemon.holdConnection();
  try {
    const before = daemon.attempts.filter(call => call.path === "/connections").length;
    await submit.click();
    await expect.poll(() => daemon.attempts.filter(call => call.path === "/connections").length).toBe(before + 1);
    await expect(submit).toBeDisabled();
    const sent = daemon.attempts.filter(call => call.path === "/connections").at(-1);
    assert.deepEqual(JSON.parse(sent?.body ?? "null"), { fromId: "thought-1", toId: "idea-root", category: "supports", explanation: "Owned connection rationale", sourceIds: ["source-1"] });
    daemon.releaseConnection();
    await expect(main.getByText(/connection (?:created|saved)/i).first()).toBeVisible();
    assert.equal(daemon.attempts.filter(call => call.path === "/connections").length, before + 1);
  } finally { daemon.releaseConnection(); }
  await page.goto(`${origin}/ideas/idea-root`, { waitUntil: "networkidle" });
  await action.click();
  await search.fill("owned");
  await main.getByRole("button", { name: /^search$/i }).first().click();
  await match.getByRole("button", { name: /choose|select/i }).click();
  await main.getByRole("radio", { name: /related/i }).first().check();
  await main.getByRole("radio", { name: /owned.*related.*owned/i }).first().check();
  await explanation.fill("Owned uncertain rationale");
  daemon.connectionStatus(500);
  const beforeUncertain = daemon.attempts.filter(call => call.path === "/connections").length;
  await submit.click();
  await expect.poll(() => daemon.attempts.filter(call => call.path === "/connections").length).toBe(beforeUncertain + 1);
  await expect(main.getByText(/(?:may|might|could) already (?:exist|have been)/i).first()).toBeVisible();
  const snapshot = main.getByText("Owned uncertain rationale", { exact: true }).first();
  await expect(snapshot).toBeVisible();
  assert.notEqual(await snapshot.evaluate(element => getComputedStyle(element).userSelect), "none", "submitted snapshot must remain copyable");
  assert.equal(await main.locator("input:not([readonly]):not(:disabled), textarea:not([readonly]):not(:disabled), [contenteditable=true]").evaluateAll(elements => elements.some(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value === "Owned uncertain rationale" : element.textContent === "Owned uncertain rationale")), false);
  if (await submit.count()) await expect(submit).not.toBeEnabled();
  await page.waitForTimeout(300);
  assert.equal(daemon.attempts.filter(call => call.path === "/connections").length, beforeUncertain + 1, "uncertain writes must not replay");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "connection flow must fit viewport");
  await page.reload({ waitUntil: "networkidle" });
  await action.click();
  await expect(main.getByText("Owned uncertain rationale", { exact: true })).toHaveCount(0);
  assert.equal(daemon.attempts.filter(call => call.path === "/connections").length, beforeUncertain + 1, "reload must not replay a write");
}

export async function checkIdeaBrowser(page: Page, daemon: Fixture, searchDaemon: SearchFixture, options: { origin: string; narrow: boolean }): Promise<void> {
  await checkStaleConnectionSearch(page, daemon, searchDaemon, options.origin);
  await checkConnectionDraftLeaving(page, daemon, options.origin);
  await checkUserConnection(page, daemon, options.origin);
  daemon.reset();
  const walkthroughStart = daemon.attempts.length;
  await page.goto(`${options.origin}/ideas/idea-imported`, { waitUntil: "networkidle" });
  await expect(page.getByText(imported.text, { exact: true })).toBeVisible();
  await expect(page.locator("main").getByText("Imported source", { exact: true }).first()).toBeVisible();
  await expect(page.locator("main").getByText("AI", { exact: true })).toHaveCount(0);
  const menu = page.getByRole("button", { name: "More actions" });
  const openMenu = async () => { if (await menu.getAttribute("aria-expanded") !== "true") await menu.click(); };
  const navigation = await page.goto(`${options.origin}/ideas/idea-plain`, { waitUntil: "networkidle" });
  assert.equal(navigation?.status(), 200, "direct Idea bookmark must resolve to the actual page");
  await expect(page.getByText(plain.text, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /full reply/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /owned parent/i })).toHaveCount(0);
  const header = page.getByRole("banner");
  const resultsBack = header.getByRole("link", { name: /(?:back|return).*(?:results|explore)/i });
  await expect(resultsBack).toHaveCount(1);
  await expect(resultsBack).toHaveAttribute("href", "/explore");
  await expect(page.locator("main").getByRole("link", { name: /(?:back|return).*(?:results|explore|previous)/i })).toHaveCount(0);
  const size = await resultsBack.boundingBox();
  assert.ok(size && size.width >= 44 && size.height >= 44, "contextual header navigation needs a 44px target");
  const wordmark = await page.getByRole("link", { name: "Thoughtloom home" }).boundingBox();
  assert.ok(wordmark && Math.abs((size.y + size.height / 2) - (wordmark.y + wordmark.height / 2)) < Math.max(size.height, wordmark.height) / 2, "back arrow and wordmark share the header row");
  await resultsBack.hover();
  await expect(page.getByText(/(?:back|return).*(?:results|explore)/i, { exact: false })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.getByRole("link", { name: "Thoughtloom home" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(resultsBack).toBeFocused();
  await expect(page.getByText(/(?:back|return).*(?:results|explore)/i, { exact: false })).toBeVisible();
  assert.ok(await resultsBack.evaluate(element => element.matches(":focus-visible")), "header back control needs keyboard-visible focus");
  assert.ok(await resultsBack.evaluate(element => {
    const style = getComputedStyle(element);
    const colors = `${style.outlineColor} ${style.boxShadow}`.matchAll(/rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/g);
    return [...colors].some(match => Number(match[3]) > Number(match[1]) && Number(match[3]) > Number(match[2]));
  }), "keyboard focus ring must be blue");
  const returnTo = "/explore?q=owned&sort=newest&scope=normal";
  await page.goto(`${options.origin}/ideas/idea-root?${new URLSearchParams({ responseId: "idea-reply", returnTo })}`, { waitUntil: "networkidle" });
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  await expect(page.getByText(reply.text, { exact: true })).toBeVisible();
  await expect(resultsBack).toHaveAttribute("href", returnTo);
  const about = page.getByRole("button", { name: /^about(?: this idea)?$/i });
  const editAction = page.getByRole("button", { name: "Edit title" });
  const replyAction = page.getByRole("button", { name: "Full reply" });
  await page.mouse.move(0, 0);
  for (const action of [editAction, replyAction, about, menu]) {
    const style = await action.evaluate(element => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-link)";
      probe.style.backgroundColor = "var(--color-text)";
      element.appendChild(probe);
      try {
        const computed = getComputedStyle(element);
        const tokens = getComputedStyle(probe);
        return { tag: element.tagName, color: computed.color, linkColor: tokens.color, textColor: tokens.backgroundColor, decoration: computed.textDecorationLine };
      } finally { probe.remove(); }
    });
    assert.equal(style.tag, "BUTTON", "secondary actions remain native buttons");
    assert.ok(style.decoration.split(" ").includes("underline"), "secondary actions must be underlined at rest");
    assert.equal(style.color, style.linkColor, "secondary actions use the existing link-color token at rest");
    assert.notEqual(style.color, style.textColor, "secondary actions are distinct from ordinary text");
  }
  const aboutExpanded = () => about.evaluate(element => element.getAttribute("aria-expanded") ??
    (element.tagName === "SUMMARY" && element.parentElement instanceof HTMLDetailsElement ? String(element.parentElement.open) : null));
  await expect(about).toBeVisible();
  await expect(about).toHaveText(/^About$/);
  await expect.poll(aboutExpanded).toBe("false");
  const metadataId = await about.getAttribute("aria-controls");
  assert.ok(metadataId, "About identifies its controlled metadata region");
  const metadata = page.locator(`[id=${JSON.stringify(metadataId)}]`);
  await expect(metadata).toHaveCount(1);
  await expect(metadata.getByText("Created (UTC)", { exact: true })).not.toBeVisible();
  const aboutBox = await about.boundingBox();
  const actionBoxes = await Promise.all([editAction, replyAction, menu].map(action => action.boundingBox()));
  assert.ok(aboutBox && aboutBox.width >= 44 && aboutBox.height >= 44, "About must have a comfortable 44px target");
  assert.ok(actionBoxes.every(box => box !== null));
  if (!options.narrow) {
    assert.ok(actionBoxes.every(box => box && Math.abs((box.y + box.height / 2) - (aboutBox.y + aboutBox.height / 2)) < Math.max(box.height, aboutBox.height) / 2), "About belongs on the existing desktop action row");
  }
  await about.focus();
  await expect(about).toBeFocused();
  await page.keyboard.press("Space");
  await expect.poll(aboutExpanded).toBe("true");
  await expect(about).toBeFocused();
  const created = metadata.getByText("Created (UTC)", { exact: true });
  await expect(created).toBeVisible();
  for (const label of ["Origin", "Title by", "Idea ID"]) await expect(metadata.getByText(label, { exact: true })).toBeVisible();
  for (const value of ["Jan 1, 2032", "capture", "idea-root"]) await expect(metadata.getByText(value, { exact: true })).toBeVisible();
  await expect(metadata.getByText("Title by", { exact: true }).locator("..").getByText("You", { exact: true })).toBeVisible();
  const createdBox = await created.boundingBox();
  assert.ok(createdBox && createdBox.y >= Math.max(aboutBox.y + aboutBox.height, ...actionBoxes.map(box => box ? box.y + box.height : 0)), "About metadata belongs below the action group");
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await expect.poll(aboutExpanded).toBe("false");
  await expect(about).toBeFocused();
  await expect(created).not.toBeVisible();
  await openMenu();
  for (const action of ["evolve", "export"] as const) {
    const href = await page.getByRole("link", { name: new RegExp(action, "i") }).getAttribute("href");
    const url = new URL(href ?? "", options.origin);
    assert.equal(url.pathname, `/${action}`); assert.equal(url.searchParams.get("thoughtId"), "idea-root");
  }
  await resultsBack.click();
  await expect(page.getByRole("textbox", { name: /^search (?:thoughts|your thinking)$/i })).toHaveValue("owned");
  await expect(page.getByRole("combobox", { name: /sort/i })).toHaveValue("newest");
  const beforeUnrelated = daemon.attempts.length;
  await page.goto(`${options.origin}/ideas/idea-root?responseId=unrelated-secret`, { waitUntil: "networkidle" });
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  assert.ok(!daemon.attempts.slice(beforeUnrelated).some(attempt => attempt.path.startsWith("/responses/")));
  await expect(page.getByText(reply.text, { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /edit title/i }).click();
  const titleField = page.getByRole("textbox", { name: /title/i });
  await titleField.fill("Edited owned title");
  await page.getByRole("button", { name: /^save/i }).click();
  await expect(page.getByText("Edited owned title", { exact: true })).toBeVisible();
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  assert.ok(daemon.attempts.some(call => call.method === "PUT" && call.path === "/thoughts/idea-root/title" && call.body === '{"title":"Edited owned title"}'));
  await page.getByRole("button", { name: /edit title/i }).click();
  await page.getByRole("button", { name: /clear title/i }).click();
  await expect(page.getByRole("status").filter({ hasText: /title cleared/i })).toBeVisible();
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  assert.ok(daemon.attempts.some(call => call.method === "PUT" && call.body === '{"title":null}'));

  await expect(page.getByRole("button", { name: /^(history|sources)$/i })).toHaveCount(0);
  await expect(page.getByText(/parent.*unavailable|unavailable.*parent/i).first()).toBeVisible();
  await expect(page.getByText(source.text, { exact: true })).toBeVisible();
  await expect(page.getByText(/unavailable/i).first()).toBeVisible();
  await page.locator("article").filter({ has: page.getByRole("heading", { name: "Owned source" }) }).getByRole("button", { name: "Why connected" }).click();
  await expect(page.getByText(edge.explanation, { exact: true })).toBeVisible();
  const childRow = page.locator("article").filter({ has: page.locator('a[href^="/ideas/idea-child"]') });
  await expect(childRow).toHaveCount(1);
  await expect(childRow).toContainText(/interpretation|child/i);
  await expect(childRow).toContainText(/source|provenance/i);
  await expect(childRow).toContainText(/connection|supports/i);
  await expect(page.getByText(grandchild.text, { exact: true })).toHaveCount(0);
  await childRow.getByRole("button", { name: "Why connected" }).click();
  await expect(childRow.getByText(childEdge.explanation, { exact: true })).toBeVisible();
  await childRow.getByText("Connection actions", { exact: true }).click();
  await childRow.getByRole("button", { name: /reject connection/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reject connection" }).click();
  await expect.poll(() => connectionRejectCount(daemon, walkthroughStart)).toBe(1);
  await expect(childRow).toBeVisible();
  await expect(childRow).toContainText(/interpretation|child/i);
  assert.ok(!daemon.attempts.some(call => call.method === "POST" && call.path === "/thoughts/idea-child/reject"));
  await childRow.locator('a[href^="/ideas/idea-child"]').first().click();
  await expect(page.getByText(child.text, { exact: true })).toBeVisible();
  await expect(page.locator('a[href^="/ideas/idea-root"]').filter({ hasText: /Owned original idea wording, unchanged/i }).first()).toBeVisible();
  await expect(page.locator("article").filter({ has: page.locator('a[href^="/ideas/idea-root"]') })).toContainText(/source|provenance/i);
  await expect(page.getByText(parent.text, { exact: true })).toHaveCount(0);
  const previous = header.getByRole("link", { name: /(?:back|return|previous).*(?:idea|thought)/i });
  await expect(previous).toHaveCount(1);
  await expect(previous).toHaveAttribute("href", /^\/ideas\/idea-root(?:\?|$)/);
  await expect(page.locator("main").getByRole("link", { name: /previous thought/i })).toHaveCount(0);
  await previous.click();
  await expect(page).toHaveURL(url => url.pathname === "/ideas/idea-root");
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  assert.ok(!daemon.attempts.some(call => call.path.includes("scope=history")));
  daemon.reset();
  await page.goto(`${options.origin}/ideas/idea-root`, { waitUntil: "networkidle" });

  const writes = () => daemon.attempts.filter(call => call.method !== "GET");
  const beforeCancel = writes().length;
  await openMenu();
  await page.getByRole("button", { name: /reject idea/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  assert.equal(writes().length, beforeCancel);
  await openMenu();
  await page.getByRole("button", { name: /reject idea/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reject this idea" }).click();
  await expect(page.getByText(/rejected/i).first()).toBeVisible();
  const normal = await page.request.get(`${options.origin}/api/ideas/idea-root?scope=normal&part=view`);
  assert.equal(normal.status(), 404);
  await page.goto(`${options.origin}/ideas/idea-root?scope=show-rejected`, { waitUntil: "networkidle" });
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Owned parent" }).first()).toBeVisible();
  const evolve = page.getByRole("link", { name: /evolve/i }).or(page.getByRole("button", { name: /evolve/i }));
  await expect(evolve).toHaveAttribute("aria-disabled", "true");
  await openMenu();
  await expect(page.getByRole("button", { name: /restore this idea/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /restore idea branch/i })).toBeVisible();
  const explicitEdge = page.locator("article").filter({ hasText: edge.explanation });
  const endpointOnly = page.locator("article").filter({ hasText: hiddenEdge.explanation });
  await expect(explicitEdge.getByRole("button", { name: /restore connection/i })).toBeVisible();
  await expect(endpointOnly.getByRole("button", { name: /restore connection/i })).toHaveCount(0);
  const beforeRestore = writes().length;
  await page.getByRole("button", { name: /restore idea branch/i }).click();
  await expect.poll(() => writes().length).toBe(beforeRestore + 1);
  assert.equal(writes().at(-1)?.path, "/thoughts/idea-root/branch/restore");
  assert.equal(writes().at(-1)?.body, "");
  assert.ok(!writes().slice(beforeRestore).some(call => call.path.startsWith("/connections/")));

  daemon.reset();
  await page.goto(`${options.origin}/ideas/idea-root`, { waitUntil: "networkidle" });
  daemon.holdFreshPreview();
  try {
    await openMenu();
    await page.getByRole("button", { name: /reject branch/i }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", { name: "Confirm reject branch" });
    await expect(dialog.getByText(/\b3 ideas will be rejected/i)).toBeVisible();
    const before = writes().length;
    await confirm.click();
    await expect.poll(() => writes().length).toBe(before + 1);
    assert.deepEqual(JSON.parse(writes().at(-1)?.body ?? "null"), preview3);
    await expect.poll(() => daemon.freshPreviewWaiting()).toBe(true);
    await expect(confirm).toBeDisabled();
    daemon.releasePreview();
    await expect(dialog.getByText(/\b4 ideas will be rejected/i)).toBeVisible();
    assert.equal(writes().length, before + 1, "fresh preview must not replay the destructive POST");
    await confirm.click();
    await expect.poll(() => writes().length).toBe(before + 2);
    assert.deepEqual(JSON.parse(writes().at(-1)?.body ?? "null"), preview4);
    await expect(page.getByRole("heading", { name: "Idea rejected" })).toBeVisible();
  } finally { daemon.releasePreview(); }

  daemon.reset();
  await page.goto(`${options.origin}/ideas/idea-root`, { waitUntil: "networkidle" });
  daemon.holdTitle();
  try {
    const before = writes().length;
    await page.getByRole("button", { name: /edit title/i }).click();
    await page.getByRole("textbox", { name: /title/i }).fill("Late owned title");
    await page.getByRole("button", { name: /^save/i }).dblclick({ delay: 40 });
    await expect.poll(() => writes().length).toBe(before + 1);
    assert.equal(writes().at(-1)?.body, '{"title":"Late owned title"}');
    await page.getByRole("link", { name: /owned source/i }).first().click();
    await expect(page.getByText(source.text, { exact: true })).toBeVisible();
    daemon.releaseTitle();
    await expect.poll(() => daemon.currentTitle()).toBe("Late owned title");
    await page.waitForTimeout(300);
    await expect(page.getByText(source.text, { exact: true })).toBeVisible();
    await expect(page.getByText("Late owned title", { exact: true })).toHaveCount(0);
    assert.equal(writes().length, before + 1, "pending double click must not issue a second title write");
  } finally { daemon.releaseTitle(); }

  daemon.reset();
  await page.goto(`${options.origin}/ideas/idea-root`, { waitUntil: "networkidle" });
  daemon.failWrites(true);
  const beforeFailure = writes().length;
  await openMenu();
  await page.getByRole("button", { name: /reject idea/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reject this idea" }).click();
  await expect(page.getByText(/unconfirmed|could not confirm|unable to confirm/i).first()).toBeVisible();
  await expect(menu).toBeEnabled();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await page.waitForTimeout(300);
  assert.equal(writes().length, beforeFailure + 1);
  daemon.failWrites(false);
  await openMenu();
  await menu.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /export/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  daemon.reset();
  await page.goto(`${options.origin}/ideas/idea-root`, { waitUntil: "networkidle" });
  await openMenu();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Edit title" }).click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  const editTitle = page.getByRole("textbox", { name: "Title" });
  await expect(editTitle).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editTitle).toBeFocused();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Idea horizontal overflow");
}
