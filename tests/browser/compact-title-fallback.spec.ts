import { expect, test, type APIRequestContext } from "@playwright/test";
import type { BrowserDialogueMetadata } from "../fixtures/dialogue-world";

const daemon = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;
async function control(request: APIRequestContext, name: string, data: object = {}) {
  const response = await request.post(`${daemon}/__browser/dialogue/${name}`, { data }); expect(response.status()).toBe(200); return response;
}
async function world(request: APIRequestContext): Promise<BrowserDialogueMetadata> {
  return await (await control(request, "world")).json() as BrowserDialogueMetadata;
}
async function title(request: APIRequestContext, root: string, item?: { itemId: string; versionId: string }) {
  const response = await request.get(`${daemon}/sources/${root}/title${item ? `?${new URLSearchParams(item)}` : ""}`);
  expect(response.status()).toBe(200); return response.json();
}
const firstFive = (body: string) => body.trim().split(/\s+/u).slice(0, 5).join(" ");
test.afterEach(async ({ request }) => { await control(request, "reset"); });

test("compact reading uses its stored user title without changing formulation authorship", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item) throw new Error("Missing fixture reading");
  const target = { kind: "item", itemId: item.id, versionId: item.current.id };
  const saved = await request.post(`${daemon}/sources/${root.id}/title`, { headers: { "idempotency-key": "compact-stored-title" }, data: { target, text: "A user chosen label", expectedTitleRevisionId: null } });
  expect(saved.status()).toBe(200);
  await page.goto(`/sources/${root.id}/inquiry?item=${item.id}&version=${item.current.id}`);
  const card = page.locator(`#item-${item.id}`);
  await expect(card.locator(".thought-title-text")).toHaveText("A user chosen label");
  await expect(card).toContainText(item.current.text);
  await expect(card).toContainText("AI interpretation");
  expect(await title(request, root.id, target)).toMatchObject({ title: { text: "A user chosen label", author: "user" } });
});

test("untitled original compact card shows five normalized words without persisting a title", async ({ page, request }) => {
  const { root } = await world(request);
  const before = await (await request.get(`${daemon}/sources/${root.id}`)).json();
  expect(await title(request, root.id)).toEqual({ headRevisionId: null, title: null });
  await page.goto(`/sources/${root.id}/inquiry`);
  const original = page.getByRole("region", { name: "Original source", exact: true });
  expect(await (await request.get(`${daemon}/sources/${root.id}`)).json()).toEqual(before);
  expect(await title(request, root.id)).toEqual({ headRevisionId: null, title: null });
  await expect(original).not.toContainText("AI-generated title");
  await expect(original.locator(".thought-title-text")).toHaveText(new RegExp(`^${firstFive(root.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:…|\\.\\.\\.)?$`));
  await expect(original.getByRole("button", { name: "Edit original title", exact: true })).toBeVisible();
});

test("untitled compact reading labels its current version, not the pinned historical body", async ({ page, request }) => {
  const { root, item } = await world(request); if (!item || item.history.length < 2) throw new Error("Missing fixture history");
  const historical = item.history[0], target = { itemId: item.id, versionId: item.current.id };
  const before = await (await request.get(`${daemon}/sources/${root.id}`)).json();
  expect(await title(request, root.id, target)).toEqual({ headRevisionId: null, title: null });
  await page.goto(`/sources/${root.id}/inquiry?item=${item.id}&version=${historical.id}`);
  const card = page.locator(`#item-${item.id}`), focal = page.getByRole("region", { name: "Discussion target", exact: true });
  await expect(card).toContainText(item.current.text); await expect(focal).toContainText(historical.text);
  expect(await (await request.get(`${daemon}/sources/${root.id}`)).json()).toEqual(before);
  expect(await title(request, root.id, target)).toEqual({ headRevisionId: null, title: null });
  await expect(card).not.toContainText("AI-generated title");
  await expect(card.locator(".thought-title-text")).toHaveText(new RegExp(`^${firstFive(item.current.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:…|\\.\\.\\.)?$`));
  await expect(card.locator(".thought-title-text")).not.toContainText(firstFive(historical.text));
});

test("short untitled original uses all its words as its compact title", async ({ page, request }) => {
  await world(request);
  const saved = await request.post(`${daemon}/captures`, { headers: { "idempotency-key": "compact-short-original" }, data: { text: "Tiny thought.", provenance: "fixture" } });
  expect(saved.status()).toBe(201); const source: unknown = await saved.json();
  if (typeof source !== "object" || source === null || !("id" in source) || typeof source.id !== "string") throw new Error("Missing saved source");
  await page.goto(`/sources/${source.id}/inquiry`);
  const original = page.getByRole("region", { name: "Original source", exact: true });
  expect(await title(request, source.id)).toEqual({ headRevisionId: null, title: null });
  await expect(original.locator(".thought-title-text")).toHaveText(/^Tiny thought\.(?:…|\.\.\.)?$/u);
});
