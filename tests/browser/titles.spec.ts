import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { parseThoughtTitle } from "../../packages/contracts/src";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data });
  expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext, empty = false) {
  return await (await control(request, "world", { empty })).json() as BrowserDialogueMetadata;
}
type Target = { kind: "source" } | { kind: "item"; itemId: string; versionId: string };
async function setTitle(request: APIRequestContext, root: string, key: string, target: Target, text: string, expectedTitleRevisionId: string | null) {
  const response = await request.post(`${daemon}/sources/${root}/title`, { headers: { "idempotency-key": key }, data: { target, text, expectedTitleRevisionId } });
  expect(response.status()).toBe(200);
  const receipt = parseThoughtTitle(await response.json()); if (!receipt) throw new Error("Invalid title receipt"); return receipt;
}
async function readTitle(request: APIRequestContext, root: string, target?: { itemId: string; versionId: string }) {
  const query = target ? `?${new URLSearchParams(target)}` : "";
  const response = await request.get(`${daemon}/sources/${root}/title${query}`); expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("headRevisionId" in body) || !("title" in body)) throw new Error("Invalid title read");
  const title = body.title === null ? null : parseThoughtTitle(body.title);
  if (body.title !== null && !title) throw new Error("Invalid title metadata");
  if (body.headRevisionId !== null && typeof body.headRevisionId !== "string") throw new Error("Invalid title head");
  return { headRevisionId: body.headRevisionId, title };
}
function original(page: Page) { return page.getByRole("region", { name: "Original source", exact: true }); }
function titleInput(page: Page) { return page.getByRole("textbox", { name: /title/i }); }
function saveTitle(page: Page) { return page.getByRole("button", { name: "Save title", exact: true }); }
async function editOriginal(page: Page) {
  const button = original(page).getByRole("button", { name: "Edit original title", exact: true });
  await expect(button).toBeVisible(); await button.click();
}
function captureTitlePost(requests: Request[], request: Request) {
  if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/title")) requests.push(request);
}
test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("original editor targets original even when AI reading leads overview", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item) throw new Error("Missing fixture reading");
  const seed = await setTitle(request, root.id, "title-ui-original-seed", { kind: "source" }, "Initial original title", null);
  expect((await readTitle(request, root.id)).headRevisionId).toBe(seed.revisionId);
  await page.goto(`/sources/${root.id}/inquiry`);
  await expect(page.getByRole("region", { name: "Reading to explore" })).toContainText(item.current.text);
  await expect(page.getByRole("region", { name: "Discussion target" })).toContainText(root.text);
  await editOriginal(page);
  await titleInput(page).fill("Discard this draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await readTitle(request, root.id)).title?.text).toBe("Initial original title");
  await editOriginal(page);
  await titleInput(page).fill("Original renamed safely"); await saveTitle(page).click();
  await expect.poll(async () => (await readTitle(request, root.id)).title?.text).toBe("Original renamed safely");
  expect((await readTitle(request, root.id, { itemId: item.id, versionId: item.current.id })).title).toBeNull();
  await expect(original(page)).toContainText(root.text.slice(0, 80));
});

test("reading title survives reload and search without changing its AI body or author", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item) throw new Error("Missing fixture reading");
  const target = { kind: "item" as const, itemId: item.id, versionId: item.current.id };
  await setTitle(request, root.id, "title-ui-reading-seed", target, "Seeded reading label", null);
  await page.goto(`/sources/${root.id}/inquiry?item=${item.id}&version=${item.current.id}`);
  const focal = page.getByRole("region", { name: "Discussion target" });
  await expect(focal).toContainText(item.current.text);
  const edit = focal.getByRole("button", { name: "Edit reading title", exact: true }); await expect(edit).toBeVisible(); await edit.click();
  await titleInput(page).fill("Quincunx orchard label"); await saveTitle(page).click();
  await expect.poll(async () => (await readTitle(request, root.id, target)).title?.text).toBe("Quincunx orchard label");
  await page.reload(); await expect(focal).toContainText("Quincunx orchard label");
  await expect(focal).toContainText(item.current.text); await expect(focal).toContainText(/AI-authored/i);
  const search = await request.get(`${daemon}/search?q=quincunx`); expect(search.status()).toBe(200);
  expect(await search.json()).toMatchObject({ results: expect.arrayContaining([expect.objectContaining({ matchOrigin: "title", item: expect.objectContaining({ id: item.id, author: "ai" }) })]) });
  await page.goto("/search?q=quincunx");
  await expect(page.getByRole("link", { name: /Quincunx orchard label/i })).toBeVisible();
  await expect(page.getByText(/matched title/i)).toBeVisible();
});

test("TITLE-UI-01 historical title read does not hide current formulation's AI title", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item || item.history.length < 2) throw new Error("Expected a reading with history");
  const old = item.history[0], current = item.current;
  const seeded = await (await control(request, "seed-generated-title", { itemId: item.id, versionId: current.id, text: "Current formulation AI label" })).json() as { revisionId: string };
  const currentRead = await readTitle(request, root.id, { itemId: item.id, versionId: current.id });
  expect(currentRead).toMatchObject({ headRevisionId: seeded.revisionId, title: { text: "Current formulation AI label", author: "ai" } });
  const oldRead = await readTitle(request, root.id, { itemId: item.id, versionId: old.id });
  expect(oldRead).toEqual({ headRevisionId: seeded.revisionId, title: null });
  await page.goto(`/sources/${root.id}/inquiry?item=${item.id}&version=${old.id}`);
  const currentReading = page.locator(`#item-${item.id}`);
  await expect(currentReading).toContainText(current.text);
  await expect(currentReading).toContainText("Current formulation AI label");
  const focal = page.getByRole("region", { name: "Discussion target" });
  await expect(focal).toContainText(old.text);
  const historicalRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/sources/${root.id}/title` && url.searchParams.get("itemId") === item.id && url.searchParams.get("versionId") === old.id && response.status() === 200;
  });
  await focal.getByRole("button", { name: "Edit reading title", exact: true }).click();
  expect(await (await historicalRead).json()).toEqual({ headRevisionId: seeded.revisionId, title: null });
  await expect(titleInput(page)).toHaveValue("");
  await expect(currentReading).toContainText("Current formulation AI label");
  await titleInput(page).fill("User label for all versions"); await saveTitle(page).click();
  await expect(currentReading).toContainText("User label for all versions");
  expect((await readTitle(request, root.id, { itemId: item.id, versionId: current.id })).title).toMatchObject({ text: "User label for all versions", author: "user" });
  expect((await readTitle(request, root.id, { itemId: item.id, versionId: old.id })).title).toMatchObject({ text: "User label for all versions", author: "user" });
});

test("TITLE-UI-02 a held older user title read cannot roll back a newer inquiry title", async ({ page, request }) => {
  const { root } = await world(request), target: Target = { kind: "source" };
  const old = await setTitle(request, root.id, "title-barrier-old", target, "Older user label", null);
  await page.goto(`/sources/${root.id}/inquiry`);
  const firstRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${root.id}/title` && response.status() === 200);
  await editOriginal(page); await firstRead; await expect(titleInput(page)).toHaveValue("Older user label");
  await original(page).getByRole("button", { name: "Cancel", exact: true }).click();
  let release = () => {}, entered = () => {}, finished = () => {}, held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; }), waiting = new Promise<void>((resolve) => { entered = resolve; }), done = new Promise<void>((resolve) => { finished = resolve; });
  const path = `**/api/sources/${root.id}/title`;
  await page.route(path, async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    try { const response = await route.fetch(); expect(await response.json()).toMatchObject({ headRevisionId: old.revisionId, title: { text: "Older user label", author: "user" } }); entered(); await gate; await route.fulfill({ response }); }
    finally { finished(); }
  });
  try {
    await editOriginal(page); await waiting;
    const newer = await setTitle(request, root.id, "title-barrier-new", target, "New canonical user label", old.revisionId);
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${root.id}/inquiry` && response.status() === 200);
    await page.getByRole("textbox", { name: "Develop this thought" }).fill("Trigger a controlled inquiry refresh.");
    const saved = page.waitForResponse((response) => /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send thought", exact: true }).click();
    expect([200, 201]).toContain((await saved).status());
    await control(request, "start"); await control(request, "advance", { outcome: "succeeded", text: "Fixture reply" });
    expect(await (await refreshed).json()).toMatchObject({ source: { id: root.id, title: { text: "New canonical user label", author: "user" } } });
    await expect(original(page)).toContainText("New canonical user label");
    release(); await done;
    await expect(original(page)).toContainText("New canonical user label");
    await expect(original(page)).not.toContainText("Older user label");
    await expect(titleInput(page)).toBeEditable();
    await titleInput(page).fill("Explicit retained title draft");
    const command = page.waitForRequest((entry) => entry.method() === "POST" && new URL(entry.url()).pathname === `/api/sources/${root.id}/title`);
    await saveTitle(page).click(); const submitted = await command;
    expect(submitted.postDataJSON()).toMatchObject({ target, text: "Explicit retained title draft", expectedTitleRevisionId: newer.revisionId });
    expect(submitted.headers()["idempotency-key"]).toBeTruthy();
    await expect.poll(async () => (await readTitle(request, root.id)).title?.text).toBe("Explicit retained title draft");
  } finally { release(); if (held) await done; await page.unroute(path); }
});

test("TITLE-UI-02 typing survives held background title revalidation", async ({ page, request }) => {
  const { root } = await world(request), target: Target = { kind: "source" };
  const initial = await setTitle(request, root.id, "title-draft-initial", target, "Initial title", null);
  await page.goto(`/sources/${root.id}/inquiry`);
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${root.id}/title` && response.status() === 200);
  await editOriginal(page); await loaded; await expect(titleInput(page)).toHaveValue("Initial title");
  await titleInput(page).fill("Unfinished draft");
  let entered = () => {}, release = () => {}, finished = () => {}, held = false;
  const waiting = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }), done = new Promise<void>((resolve) => { finished = resolve; });
  const path = `**/api/sources/${root.id}/title`;
  await page.route(path, async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    try {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ title: { text: "External updated title", author: "user" } });
      entered(); await gate; await route.fulfill({ response });
    } finally { finished(); }
  });
  try {
    const external = await setTitle(request, root.id, "title-draft-external", target, "External updated title", initial.revisionId);
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${root.id}/inquiry` && response.status() === 200);
    await page.getByRole("textbox", { name: "Develop this thought" }).fill("Request an inquiry refresh.");
    const saved = page.waitForResponse((response) => /^\/api\/dialogues\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send thought", exact: true }).click(); expect([200, 201]).toContain((await saved).status());
    await control(request, "start"); await control(request, "advance", { outcome: "succeeded", text: "Fixture reply" });
    expect(await (await refreshed).json()).toMatchObject({ source: { id: root.id, title: { revisionId: external.revisionId, text: "External updated title" } } });
    await waiting;
    await expect(titleInput(page)).toBeEditable(); await titleInput(page).fill("Unfinished draft while checking");
    release(); await done;
    await expect(titleInput(page)).toHaveValue("Unfinished draft while checking");
    const command = page.waitForRequest((entry) => entry.method() === "POST" && new URL(entry.url()).pathname === `/api/sources/${root.id}/title`);
    await saveTitle(page).click(); expect((await command).postDataJSON()).toMatchObject({ target, text: "Unfinished draft while checking", expectedTitleRevisionId: external.revisionId });
    await expect.poll(async () => (await readTitle(request, root.id)).title?.text).toBe("Unfinished draft while checking");
  } finally { release(); if (held) await done; await page.unroute(path); }
});

test("developing idea title editor stays attached to the represented idea", async ({ page, request }) => {
  const { root } = await world(request);
  const opened = await request.post(`${daemon}/sources/${root.id}/dialogues`, { headers: { "idempotency-key": "title-idea-dialogue" }, data: { selection: { kind: "source", id: root.id } } });
  expect(opened.status()).toBe(201); const dialogue = await opened.json() as { id: string };
  const turn = await request.post(`${daemon}/dialogues/${dialogue.id}/turns`, { headers: { "idempotency-key": "title-idea-turn" }, data: { text: "Fixture input for developing an idea." } }); expect(turn.status()).toBe(201);
  await control(request, "start"); await control(request, "write-idea");
  const recent = await request.get(`${daemon}/springboard/recent?limit=10`); expect(recent.status()).toBe(200);
  const body: unknown = await recent.json();
  if (typeof body !== "object" || body === null || !("items" in body) || !Array.isArray(body.items)) throw new Error("Missing idea fixture");
  const item = body.items.find((entry) => entry.kind === "developing-idea");
  if (!item || typeof item.id !== "string" || typeof item.versionId !== "string" || typeof item.excerpt !== "string") throw new Error("Missing developing idea");
  const target = { kind: "item" as const, itemId: item.id, versionId: item.versionId };
  await setTitle(request, root.id, "title-idea-seed", target, "An idea label", null);
  await page.goto(`/sources/${root.id}/inquiry?item=${item.id}&version=${item.versionId}`);
  const focal = page.getByRole("region", { name: "Discussion target" }); await expect(focal).toContainText(item.excerpt);
  const edit = focal.getByRole("button", { name: "Edit idea title", exact: true }); await expect(edit).toBeVisible(); await edit.click();
  await titleInput(page).fill("The idea renamed"); await saveTitle(page).click();
  await expect.poll(async () => (await readTitle(request, root.id, target)).title?.text).toBe("The idea renamed");
  await expect(focal).toContainText(item.excerpt); await expect(focal).toContainText(/AI-authored/i);
});

test("conflict keeps title draft, refreshes head, and explicit save uses a new command", async ({ page, request }) => {
  const { root } = await world(request), source: Target = { kind: "source" };
  const first = await setTitle(request, root.id, "title-conflict-seed", source, "Before conflict", null);
  const posts: Request[] = []; page.on("request", (entry) => captureTitlePost(posts, entry));
  await page.goto(`/sources/${root.id}/inquiry`);
  await editOriginal(page);
  await titleInput(page).fill("My retained title draft");
  const other = await setTitle(request, root.id, "title-conflict-other", source, "Other saved title", first.revisionId);
  await saveTitle(page).click();
  await expect(titleInput(page)).toHaveValue("My retained title draft");
  await expect(original(page)).toContainText("Other saved title");
  await expect(original(page).getByRole("alert")).toBeVisible(); expect(posts).toHaveLength(1);
  expect(posts[0].postDataJSON()).toMatchObject({ target: source, expectedTitleRevisionId: first.revisionId, text: "My retained title draft" });
  await saveTitle(page).click();
  await expect.poll(async () => (await readTitle(request, root.id)).title?.text).toBe("My retained title draft");
  expect(posts).toHaveLength(2);
  expect(posts[1].postDataJSON()).toMatchObject({ target: source, expectedTitleRevisionId: other.revisionId, text: "My retained title draft" });
  expect(posts[0].headers()["idempotency-key"]).toBeTruthy();
  expect(posts[1].headers()["idempotency-key"]).not.toBe(posts[0].headers()["idempotency-key"]);
});

test("lost acknowledgement retries exact committed title command and key", async ({ page, request }) => {
  const { root } = await world(request), source: Target = { kind: "source" };
  await setTitle(request, root.id, "title-lost-seed", source, "Original title seed", null);
  const posts: Request[] = []; page.on("request", (entry) => captureTitlePost(posts, entry));
  let intercepted = false;
  const routePattern = `**/api/sources/${root.id}/title`;
  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "POST" || intercepted) return route.continue();
    intercepted = true; const upstream = await route.fetch(); expect(upstream.status()).toBe(200); await route.abort("failed");
  });
  try {
    await page.goto(`/sources/${root.id}/inquiry`);
    await editOriginal(page);
    await titleInput(page).fill("Committed but unconfirmed title"); await saveTitle(page).click();
    await expect(original(page).getByRole("alert")).toBeVisible();
    await expect(titleInput(page)).toHaveValue("Committed but unconfirmed title");
    expect((await readTitle(request, root.id)).title?.text).toBe("Committed but unconfirmed title");
    await saveTitle(page).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[0].postDataJSON()).toEqual(posts[1].postDataJSON());
    expect(posts[0].headers()["idempotency-key"]).toBeTruthy();
    expect(posts[1].headers()["idempotency-key"]).toBe(posts[0].headers()["idempotency-key"]);
    await expect(original(page)).toContainText("Committed but unconfirmed title");
  } finally { await page.unroute(routePattern); }
});

test("changing discussion target does not retarget an open original title draft", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item) throw new Error("Missing fixture reading");
  await setTitle(request, root.id, "title-switch-seed", { kind: "source" }, "Original title before switch", null);
  await page.goto(`/sources/${root.id}/inquiry`);
  await editOriginal(page);
  await titleInput(page).fill("Still belongs to original");
  await page.getByRole("region", { name: "Reading to explore" }).getByRole("button", { name: "Discuss this reading" }).click();
  await expect(titleInput(page)).toHaveValue("Still belongs to original"); await saveTitle(page).click();
  await expect.poll(async () => (await readTitle(request, root.id)).title?.text).toBe("Still belongs to original");
  expect((await readTitle(request, root.id, { itemId: item.id, versionId: item.current.id })).title).toBeNull();
});

test("long card title reveals full text by keyboard and preserves navigation", async ({ page, request }) => {
  const { root } = await world(request, true);
  const text = "A long, careful fixture title about preserving original thought and making the complete title available when using a keyboard";
  await setTitle(request, root.id, "title-long-card", { kind: "source" }, text, null);
  await page.goto("/");
  const card = page.getByRole("region", { name: "Thoughts" }).getByRole("link", { name: new RegExp(text) });
  await expect(card).toBeVisible(); await card.focus();
  const reveal = page.getByRole("tooltip"); await expect(reveal).toBeVisible(); await expect(reveal).toHaveText(text);
  await page.keyboard.press("Escape"); await expect(reveal).toBeHidden();
  await card.hover(); await expect(reveal).toBeVisible(); await expect(reveal).toHaveText(text);
  await page.keyboard.press("Escape"); await expect(reveal).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === `/sources/${root.id}/inquiry`);
  await expect(page.getByRole("region", { name: "Discussion target" })).toContainText(root.text);
});
