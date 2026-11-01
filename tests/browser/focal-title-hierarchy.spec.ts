import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data }); expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext, empty = false): Promise<BrowserDialogueMetadata> {
  return await (await control(request, "world", { empty })).json() as BrowserDialogueMetadata;
}
async function readTitle(request: APIRequestContext, root: string, item?: { itemId: string; versionId: string }) {
  const response = await request.get(`${daemon}/sources/${root}/title${item ? `?${new URLSearchParams(item)}` : ""}`);
  expect(response.status()).toBe(200); return response.json();
}
const focal = (page: Page) => page.getByRole("region", { name: "Discussion target", exact: true });
const overview = (page: Page) => page.getByRole("region", { name: "Reading to explore", exact: true });
test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("focal original shows its stored title and retains exact source editing", async ({ page, request }) => {
  const { root } = await world(request, true);
  const seed = await request.post(`${daemon}/sources/${root.id}/title`, { headers: { "idempotency-key": "focal-original-seed" }, data: { target: { kind: "source" }, text: "A chosen original title", expectedTitleRevisionId: null } });
  expect(seed.status()).toBe(200);
  await page.goto(`/sources/${root.id}/inquiry#discussion-target`);
  const target = focal(page), original = page.getByRole("region", { name: "Original source", exact: true });
  await expect(target.locator(".thought-body")).toContainText(root.text.trim().replace(/\s+/gu, " "));
  const read = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sources/${root.id}/title` && response.status() === 200);
  await original.getByRole("button", { name: "Edit original title", exact: true }).click();
  expect(new URL((await read).url()).searchParams.size).toBe(0);
  await expect(original.getByRole("textbox", { name: "Original title", exact: true })).toHaveValue("A chosen original title");
  await original.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await readTitle(request, root.id)).toMatchObject({ title: { text: "A chosen original title", author: "user" } });
  await expect(target.locator(".thought-title-text")).toHaveText("A chosen original title");
});

test("untitled focal original uses its own five-word label without storing it", async ({ page, request }) => {
  const { root } = await world(request, true);
  const before = await (await request.get(`${daemon}/sources/${root.id}`)).json();
  await page.goto(`/sources/${root.id}/inquiry#discussion-target`);
  const target = focal(page);
  await expect(target.locator(".thought-body")).toContainText(root.text.trim().replace(/\s+/gu, " "));
  expect(await (await request.get(`${daemon}/sources/${root.id}`)).json()).toEqual(before);
  expect(await readTitle(request, root.id)).toEqual({ headRevisionId: null, title: null });
  await expect(target).not.toContainText("AI-generated title");
  await expect(target.locator(".thought-title-text")).toHaveText("Example source: When agents disagree,");
});

test("untitled focal historical reading labels the pinned formulation, not current text", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item || item.history.length < 2) throw new Error("Missing fixture history");
  const old = item.history[0];
  await page.goto(`/sources/${root.id}/inquiry?item=${item.id}&version=${old.id}#discussion-target`);
  const target = focal(page);
  await expect(target.locator(".thought-body")).toContainText(old.text);
  await expect(target.locator(".thought-body")).not.toContainText(item.current.text);
  const read = page.waitForResponse((response) => {
    const url = new URL(response.url()); return url.pathname === `/api/sources/${root.id}/title` && url.searchParams.get("itemId") === item.id && url.searchParams.get("versionId") === old.id && response.status() === 200;
  });
  await target.getByRole("button", { name: "Edit reading title", exact: true }).click();
  expect(await (await read).json()).toEqual({ headRevisionId: null, title: null });
  await expect(target.getByRole("textbox", { name: "Reading title", exact: true })).toHaveValue("");
  await target.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await readTitle(request, root.id, { itemId: item.id, versionId: old.id })).toEqual({ headRevisionId: null, title: null });
  await expect(target.locator(".thought-title-text")).toHaveText("Example earlier reading: More orchestration");
  await expect(target.locator(".thought-title-text")).not.toContainText("Example AI reading");
});

test("stored exact historical title wins and its editor keeps the pinned target", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item || item.history.length < 2) throw new Error("Missing fixture history");
  const old = item.history[0];
  await control(request, "seed-generated-title", { itemId: item.id, versionId: old.id, text: "Historical AI label" });
  const current = await (await control(request, "seed-generated-title", { itemId: item.id, versionId: item.current.id, text: "Current AI label" })).json() as { revisionId: string };
  expect(await readTitle(request, root.id, { itemId: item.id, versionId: old.id })).toMatchObject({ headRevisionId: current.revisionId, title: { text: "Historical AI label", author: "ai" } });
  await page.goto(`/sources/${root.id}/inquiry?item=${item.id}&version=${old.id}#discussion-target`);
  const target = focal(page);
  await expect(target.locator(".thought-body")).toContainText(old.text);
  await expect(target.locator(".thought-title-text")).toHaveText("Historical AI label");
  await expect(target).not.toContainText("Current AI label");
  const read = page.waitForResponse((response) => { const url = new URL(response.url()); return url.pathname === `/api/sources/${root.id}/title` && url.searchParams.get("itemId") === item.id && url.searchParams.get("versionId") === old.id && response.status() === 200; });
  await target.getByRole("button", { name: "Edit reading title", exact: true }).click(); await read;
  await expect(target.getByRole("textbox", { name: "Reading title", exact: true })).toHaveValue("Historical AI label");
  await target.getByRole("textbox", { name: "Reading title", exact: true }).fill("My stable reading label");
  const command = page.waitForRequest((value) => value.method() === "POST" && new URL(value.url()).pathname === `/api/sources/${root.id}/title`);
  await target.getByRole("button", { name: "Save title", exact: true }).click();
  expect((await command).postDataJSON()).toMatchObject({ target: { kind: "item", itemId: item.id, versionId: old.id }, text: "My stable reading label", expectedTitleRevisionId: current.revisionId });
  await expect.poll(async () => (await readTitle(request, root.id, { itemId: item.id, versionId: old.id })).title?.text).toBe("My stable reading label");
  await expect(target.locator(".thought-body")).toContainText(old.text);
});

test("untitled focal overview uses its own current reading label", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item) throw new Error("Missing fixture reading");
  await page.goto(`/sources/${root.id}/inquiry`);
  const reading = overview(page);
  await expect(reading.locator(".thought-body")).toHaveText(item.current.text);
  expect(await readTitle(request, root.id, { itemId: item.id, versionId: item.current.id })).toEqual({ headRevisionId: null, title: null });
  await expect(reading.locator(".thought-title-text")).toHaveText("Example AI reading: The problem");
});

test("long focal original keeps full text available after its five-word title", async ({ page, request }) => {
  await world(request, true);
  const text = `One, two three four five ${"lengthy fixture content ".repeat(90)}ending.`;
  const captured = await request.post(`${daemon}/captures`, { headers: { "idempotency-key": "focal-long-source" }, data: { text, provenance: "fixture" } });
  expect(captured.status()).toBe(201); const source: unknown = await captured.json();
  if (typeof source !== "object" || source === null || !("id" in source) || typeof source.id !== "string") throw new Error("Missing long source");
  await page.goto(`/sources/${source.id}/inquiry#discussion-target`);
  const target = focal(page), full = target.locator("details.target-disclosure");
  await target.getByRole("button", { name: "Read selected context · Full text", exact: true }).click();
  await expect(full.locator("blockquote")).toHaveText(text);
  expect(await readTitle(request, source.id)).toEqual({ headRevisionId: null, title: null });
  await expect(target.locator(".thought-title-text")).toHaveText("One, two three four five");
});

test("focal connection retains relation rationale without inventing a thought title", async ({ page, request }) => {
  const { root, relationship } = await world(request); if (!relationship) throw new Error("Missing fixture connection");
  await page.goto(`/sources/${root.id}/inquiry`);
  const connection = page.getByRole("region", { name: "Connections", exact: true }).getByRole("article").filter({ hasText: relationship.current.rationale });
  await connection.getByRole("button", { name: "Discuss this connection", exact: true }).click();
  await expect(focal(page)).toContainText(relationship.current.rationale);
  await expect(focal(page)).toContainText("Pinned connection");
  await expect(focal(page).locator(".thought-title-text")).toHaveCount(0);
});
