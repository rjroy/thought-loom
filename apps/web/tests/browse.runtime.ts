import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page, type Route } from "@playwright/test";
import type { NeighborhoodEdge } from "../src/features/browse/results";
import { markdownThought } from "./thought-markdown.runtime";

const catSelector = 'img[src="/backgrounds/browse-cat.png"]';

export async function checkBrowseWhimsy(page: Page): Promise<void> {
  const cat = page.locator(catSelector);
  await expect(cat).toHaveCount(1);
  await expect(cat).toHaveAttribute("alt", "");
  await expect(cat).toHaveAttribute("aria-hidden", "true");
  await expect(cat).toHaveCSS("pointer-events", "none");
  assert.equal(await cat.evaluate(image => image.tabIndex), -1);
  assert.equal(await cat.evaluate(image => (image as HTMLImageElement).draggable), false);
  const asset = await page.request.get(new URL("/backgrounds/browse-cat.png", page.url()).href);
  assert.equal(asset.status(), 200);
  assert.deepEqual(await asset.body(), await readFile(new URL("../../../.impeccable/candidates/browse-whimsy/production/browse-cat.png", import.meta.url)));
  if ((page.viewportSize()?.width ?? 0) <= 768) {
    await expect(cat).not.toBeVisible();
    return;
  }
  await expect(cat).toBeVisible();
  await cat.evaluate(image => (image as HTMLImageElement).decode());
  const bounds = await cat.boundingBox(), filters = await page.getByRole("complementary", { name: "Browse filters" }).boundingBox();
  const clear = await page.getByRole("button", { name: "Clear filters" }).boundingBox();
  assert.ok(bounds && filters && clear);
  assert.equal(bounds.width, 200);
  assert.equal(bounds.height, 160);
  assert.ok(bounds.y >= filters.y + filters.height + 24, "cat must sit below the complete filter panel");
  assert.ok(bounds.y > clear.y + clear.height, "Clear filters must precede the decoration");
  assert.ok(bounds.x >= filters.x && bounds.x + bounds.width <= filters.x + filters.width, "cat must stay within the filter rail");
}

export function browseDaemon(token: string) {
  const attempts: string[] = [];
  let empty = false;
  let createdConnection = false;
  const items = Array.from({ length: 51 }, (_, index) => ({
    id: `browse-${String(index).padStart(2, "0")}`, text: `Owned browse text ${index}`, title: `Owned browse title ${index}`,
    titleAuthor: "user", author: index === 1 ? "source" : index % 2 ? "ai" : "user", kind: index === 1 ? "imported-original" : index % 2 ? "developing-idea" : "captured-original",
    createdAt: `2030-01-${String(Math.floor(index / 2) + 1).padStart(2, "0")}T00:00:00.000Z`, origin: index === 1 ? "markdown-import" : "fixture", parentId: null, sourceIds: [],
  }));
  return {
    attempts,
    setEmpty(value: boolean) { empty = value; },
    setCreatedConnection(value: boolean) { createdConnection = value; },
    async handler(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "", "http://fixture.invalid");
      attempts.push(url.pathname + url.search);
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const neighborhood = /^\/thoughts\/([^/]+)\/neighborhood$/.exec(url.pathname);
      if (neighborhood) {
        const id = decodeURIComponent(neighborhood[1] ?? ""), inspection = url.searchParams.get("scope") === "show-rejected";
        if (id === "browse-47" && !inspection) { res.writeHead(404).end(); return; }
        const selected = items.find(item => item.id === "browse-50");
        if (!selected) throw new Error("Missing owned Browse root");
        const child = { ...selected, id: "idea-child", title: "Owned interpretation", text: "Owned direct interpretation", author: "ai", kind: "ai-interpretation", parentId: selected.id, sourceIds: [selected.id] };
        const root = { ...selected, id: "idea-root", title: "Owned original title", text: "Owned root text", parentId: null, sourceIds: [] };
        const hidden = items.find(item => item.id === "browse-47");
        if (!hidden) throw new Error("Missing owned rejected node");
        const related = Array.from({ length: 51 }, (_, n) => ({ ...selected, id: `map-neighbor-${n}`, title: `Owned linked idea ${n}`, text: `Owned linked text ${n}`, sourceIds: [child.id] }));
        const branch = { ...selected, id: "map-branch", title: "Owned branch idea", parentId: "map-neighbor-48", sourceIds: ["map-neighbor-48"] };
        const focus = id === "browse-markdown" ? { ...selected, id, title: "Markdown fixture", text: markdownThought } : id === "browse-50" ? selected : id === "idea-child" ? child : id === "idea-root" ? root : id === "browse-47" ? hidden : id === branch.id ? branch : related.find(node => node.id === id);
        if (!focus) { res.writeHead(404).end(); return; }
        const links: Array<NeighborhoodEdge & { node: Omit<typeof child, "parentId"> & { parentId: string | null } }> = id === "browse-50" ? [
          { kind: "evolution", id: "map-evolution", fromId: selected.id, toId: child.id, node: child },
          { kind: "provenance", id: "map-source", fromId: selected.id, toId: child.id, position: 0, node: child },
          { kind: "connection", id: "map-connection", fromId: selected.id, toId: child.id, connection: { id: "owned-connection", fromId: selected.id, toId: child.id, category: "supports", proposedBy: "user", explanation: "Owned connection", sourceIds: [] }, node: child },
          ...(inspection ? [{ kind: "connection" as const, id: "map-hidden", fromId: selected.id, toId: hidden.id, connection: { id: "hidden-connection", fromId: selected.id, toId: hidden.id, category: "related" as const, proposedBy: "ai" as const, explanation: "Owned rejected neighbor", sourceIds: [] }, node: hidden }] : []),
        ] : id === "idea-child" ? [
          { kind: "evolution", id: "map-evolution", fromId: selected.id, toId: child.id, node: selected },
          ...(createdConnection ? [{ kind: "connection" as const, id: "created-edge", fromId: child.id, toId: "thought-1",
            connection: { id: "owned-created-connection", fromId: child.id, toId: "thought-1", category: "supports" as const,
              proposedBy: "user" as const, explanation: "Owned pending connection", sourceIds: [] },
            node: { ...selected, id: "thought-1", title: "Owned development", text: "Owned matching thought for contextual navigation", author: "ai", kind: "developing-idea" } }] : []),
          ...related.map((node, position) => ({ kind: "provenance" as const, id: `map-extra-${position}`, fromId: child.id, toId: node.id, position: 0, node })),
        ] : id === "map-neighbor-48" ? [
          { kind: "provenance", id: "map-extra-48", fromId: child.id, toId: focus.id, position: 0, node: child },
          { kind: "evolution", id: "map-branch-edge", fromId: focus.id, toId: branch.id, node: branch },
        ] : id === "map-branch" ? [
          { kind: "evolution", id: "map-branch-edge", fromId: branch.parentId, toId: branch.id, node: related[48] ?? branch },
        ] : [];
        const start = Number(url.searchParams.get("cursor") ?? "0"), limit = Number(url.searchParams.get("limit") ?? "50");
        const chunk = links.slice(start, start + limit);
        const nodes = [...new Map(chunk.map(edge => [edge.node.id, edge.node])).values()].map(node => inspection ? { ...node, rejected: node.id === "browse-47" } : node);
        const edges = chunk.map(({ node: _node, ...edge }) => edge.kind === "connection" && inspection ? { ...edge, connection: { ...edge.connection, rejected: false } } : edge);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ thought: inspection ? { ...focus, rejected: id === "browse-47" } : focus, nodes, edges, nextCursor: start + limit < links.length ? String(start + limit) : null }));
        return;
      }
      const authors = url.searchParams.getAll("author"), scope = url.searchParams.get("scope");
      const filtered = empty ? [] : items.filter(item => authors.includes(item.author));
      if (url.searchParams.get("sort") !== "oldest") filtered.reverse();
      const limit = Number(url.searchParams.get("limit") ?? "50"), start = Number(url.searchParams.get("cursor") ?? "0");
      const selected = filtered.slice(start, start + limit).map(item => scope === "show-rejected" ? { ...item, rejected: false } : item);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: selected, nextCursor: start + limit < filtered.length ? String(start + limit) : null }));
    },
  };
}

async function checkRapidBrowseIntent(page: Page): Promise<void> {
  const pattern = "**/api/browse/thoughts?*";
  const release = Promise.withResolvers<void>();
  const pending = new Set<Promise<void>>();
  const requests: URL[] = [];
  const handler = (route: Route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const authors = url.searchParams.getAll("author");
    const final = url.searchParams.get("sort") === "oldest" && authors.length === 1 && authors[0] === "user"
      && url.searchParams.get("scope") === "show-rejected";
    const work = (async () => {
      try {
        if (final) { await route.continue(); return; }
        const response = await route.fetch();
        await release.promise;
        await route.fulfill({ response });
      } catch { /* Superseded browser requests may already have been aborted. */ }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };
  await page.route(pattern, handler);
  const sort = page.getByRole("combobox", { name: "Sort" });
  const authors = page.getByRole("group", { name: "Authorship" });
  const ai = authors.getByRole("checkbox", { name: "AI" });
  const user = authors.getByRole("checkbox", { name: "You" });
  const source = authors.getByRole("checkbox", { name: /^Imported source$/i });
  const rejected = page.getByRole("checkbox", { name: "Show rejected" });
  const location = (value: string) => {
    const url = new URL(value);
    return { path: url.pathname, sort: url.searchParams.get("sort") ?? "newest",
      authors: url.searchParams.getAll("author"), scope: url.searchParams.get("scope") ?? "normal" };
  };
  let predecessor = "";
  const assertFinal = async () => {
    await expect(sort).toHaveValue("oldest");
    await expect(user).toBeChecked();
    await expect(ai).not.toBeChecked();
    await expect(rejected).toBeChecked();
    await expect.poll(() => {
      const query = new URL(page.url()).searchParams;
      return { sort: query.get("sort"), authors: query.getAll("author"), scope: query.get("scope") };
    }).toEqual({ sort: "oldest", authors: ["user"], scope: "show-rejected" });
  };
  try {
    await sort.selectOption({ label: "Oldest first" });
    await ai.click();
    await source.click();
    predecessor = page.url();
    await rejected.click();
    await assertFinal();
    await expect.poll(() => {
      const query = requests.at(-1)?.searchParams;
      return { sort: query?.get("sort"), authors: query?.getAll("author"), scope: query?.get("scope") };
    }).toEqual({ sort: "oldest", authors: ["user"], scope: "show-rejected" });
    assert.ok(requests.length >= 2, "rapid intents must exercise superseded catalog requests");
    release.resolve();
    await Promise.allSettled([...pending]);
    await assertFinal();
  } finally {
    release.resolve();
    await page.unroute(pattern, handler);
    await Promise.allSettled([...pending]);
  }
  // Actual browser history must still restore the previous and final intent.
  await page.goBack();
  const previous = { path: "/browse", sort: "oldest", authors: ["user"], scope: "normal" };
  expect(location(predecessor)).toEqual(previous);
  await expect.poll(() => location(page.url())).toEqual(previous);
  await expect(sort).toHaveValue("oldest");
  await expect(user).toBeChecked();
  await expect(ai).not.toBeChecked();
  await expect(rejected).not.toBeChecked();
  await page.goForward();
  await expect.poll(() => location(page.url())).toEqual({ ...previous, scope: "show-rejected" });
  await assertFinal();
}

async function checkMapJourney(page: Page, fixture: ReturnType<typeof browseDaemon>, origin: string): Promise<void> {
  const listUrl = new URL(page.url());
  await page.getByRole("link", { name: "Owned browse title 50", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === "/browse/browse-50");
  await expect(page.locator(catSelector)).toHaveCount(0);
  const inspector = page.getByRole("region", { name: "Selected idea" });
  await expect(inspector.getByRole("heading", { name: "Owned browse title 50" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Idea map" })).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Recorded relationships" })).toBeVisible();
  const relationships = inspector.getByRole("list").getByRole("listitem");
  await expect(relationships.filter({ hasText: "Developed into:" })).toContainText("Owned interpretation");
  await expect(relationships.filter({ hasText: "This idea was used as a source for:" })).toContainText("Owned interpretation");
  const conceptual = relationships.filter({ hasText: "Conceptual connection" });
  await expect(conceptual).toContainText("Supports");
  await expect(conceptual).toContainText("Owned interpretation");
  await expect(conceptual).toContainText("Proposed by You");
  await expect(conceptual).toContainText("Owned connection");
  const before = fixture.attempts.filter(path => path.includes("/neighborhood")).length;
  const childNode = page.getByRole("button", { name: "Inspect and explore Owned interpretation" });
  await childNode.focus();
  expect(fixture.attempts.filter(path => path.includes("/neighborhood"))).toHaveLength(before);
  const release = Promise.withResolvers<void>();
  let pending: Promise<void> | undefined;
  const pattern = "**/api/browse/thoughts/idea-child/neighborhood?*";
  const hold = (route: Route) => {
    pending = (async () => { await release.promise; await route.continue(); })();
    return pending;
  };
  await page.route(pattern, hold);
  try {
    await page.keyboard.press("Enter");
    await expect(inspector.getByRole("heading", { name: "Owned interpretation" })).toBeVisible();
    await expect(inspector.getByText("Loading direct links…")).toBeVisible();
  } finally {
    release.resolve();
    if (pending) await pending;
    await page.unroute(pattern, hold);
  }
  await expect.poll(() => fixture.attempts.filter(path => path.includes("/neighborhood")).length).toBe(before + 1);
  await expect(page.getByText("More direct links are available. Parent, child, source or connection links may still be on later pages.")).toBeVisible();
  await page.getByRole("button", { name: "Linked list", exact: true }).click();
  await expect(page.getByRole("button", { name: "Linked list", exact: true })).toHaveAttribute("aria-pressed", "true");
  const selected = page.getByRole("button", { name: "Inspect and explore Owned interpretation" });
  await selected.focus(); await page.keyboard.press("Enter");
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Inspect and explore Owned linked idea 48" })).toBeVisible();
  expect(fixture.attempts.filter(path => path.includes("/neighborhood"))).toHaveLength(before + 1);
  await expect(page.getByRole("link", { name: "Read selected idea" }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more linked ideas" })).toBeEnabled();
  await page.getByRole("button", { name: "Load more linked ideas" }).click();
  await expect(page.getByRole("button", { name: "Inspect and explore Owned linked idea 50" })).toBeVisible();
  await expect(inspector.getByText("All direct links in this view are shown.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more linked ideas" })).toHaveCount(0);
  let failed = false;
  const branchPattern = "**/api/browse/thoughts/map-neighbor-48/neighborhood?*";
  const failOnce = (route: Route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({ status: 502, contentType: "application/json", body: "{}" });
  };
  await page.route(branchPattern, failOnce);
  try {
    const next = page.getByRole("button", { name: "Inspect and explore Owned linked idea 48" });
    await next.click();
    await expect(inspector.getByRole("heading", { name: "Owned linked idea 48" })).toBeVisible();
    await expect(inspector.getByText("Direct links could not be loaded. Your explored map is still here.")).toBeVisible();
    await next.click();
    await expect(inspector.getByRole("button", { name: "Retry loading links" })).toBeVisible();
    await inspector.getByRole("button", { name: "Retry loading links" }).click();
    await expect(page.getByRole("button", { name: "Inspect and explore Owned branch idea" })).toBeVisible();
    await page.getByRole("button", { name: "Inspect and explore Owned branch idea" }).click();
    await expect(inspector.getByRole("heading", { name: "Owned branch idea" })).toBeVisible();
    await expect(inspector.getByText("All direct links in this view are shown.")).toBeVisible();
    await page.getByRole("button", { name: "Inspect and explore Owned interpretation" }).click();
  } finally { await page.unroute(branchPattern, failOnce); }
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.getByRole("button", { name: "Fit map" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("link", { name: "Open Idea" }).click();
  await expect(page).toHaveURL(url => url.pathname === "/ideas/idea-child");
  await page.goBack();
  await expect(page).toHaveURL(url => url.pathname === "/browse/browse-50");
  await expect(inspector.getByRole("heading", { name: "Owned interpretation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect and explore Owned linked idea 50" })).toBeVisible();
  // Both workspaces remain mounted until an actual document reload.
  await page.getByRole("link", { name: "Back to list" }).click();
  await expect(page).toHaveURL(url => url.pathname === listUrl.pathname && url.searchParams.get("sort") === listUrl.searchParams.get("sort")
    && url.searchParams.get("scope") === listUrl.searchParams.get("scope")
    && url.searchParams.getAll("author").join(",") === listUrl.searchParams.getAll("author").join(","));
  await expect(page.getByRole("list", { name: "Ideas" }).getByRole("listitem")).toHaveCount(51);
  await expect(page.getByText("Owned browse title 0", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Owned browse title 50", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === "/browse/browse-50");
  await expect(inspector.getByRole("heading", { name: "Owned interpretation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect and explore Owned linked idea 50" })).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(inspector.getByRole("heading", { name: "Owned browse title 50" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect and explore Owned linked idea 50" })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Show rejected" }).check();
  await expect(page.getByRole("button", { name: "Inspect and explore Owned browse title 47" })).toBeVisible();
  await page.getByRole("button", { name: "Inspect and explore Owned browse title 47" }).click();
  await page.getByRole("checkbox", { name: "Show rejected" }).uncheck();
  await expect(page.getByRole("button", { name: "Inspect and explore Owned browse title 47" })).toHaveCount(0);
  await expect(inspector.getByRole("heading", { name: "Owned browse title 50" })).toBeVisible();
  await page.getByRole("link", { name: "Back to list" }).click();
  await expect(page).toHaveURL(url => url.pathname === listUrl.pathname && url.searchParams.get("sort") === listUrl.searchParams.get("sort")
    && url.searchParams.get("scope") === listUrl.searchParams.get("scope")
    && url.searchParams.getAll("author").join(",") === listUrl.searchParams.getAll("author").join(","));
  await expect(page.getByRole("list", { name: "Ideas" }).getByRole("listitem")).toHaveCount(50);
  await expect(page.getByText("Owned browse title 0", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();

  const attemptsBefore = fixture.attempts.length;
  const [unavailableResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/browse/thoughts/browse-47/neighborhood"),
    page.goto(`${origin}/browse/browse-47`, { waitUntil: "networkidle" }),
  ]);
  expect(unavailableResponse.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Starting idea unavailable" })).toBeVisible();
  expect(fixture.attempts.slice(attemptsBefore).filter(path => path.startsWith("/thoughts/browse-47/neighborhood"))).toHaveLength(1);
  await page.getByRole("checkbox", { name: "Show rejected" }).check();
  await expect(inspector.getByRole("heading", { name: "Owned browse title 47" })).toBeVisible();
  await expect(page.getByText("No direct links in this view.")).toBeVisible();
  await page.getByRole("checkbox", { name: "Show rejected" }).uncheck();
  await expect(page.getByRole("heading", { name: "Starting idea unavailable" })).toBeVisible();

  await page.goto(`${origin}/ideas/idea-child`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Browse from here" }).click();
  await expect(page).toHaveURL(url => url.pathname === "/browse/idea-child");
  await expect(inspector.getByRole("heading", { name: "Owned interpretation" })).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "map horizontal overflow");
  await page.goto(listUrl.href, { waitUntil: "networkidle" });
}

/** A confirmed write must invalidate a map even if its initiating editor unmounts first. */
export async function checkPendingConnectionMap(page: Page, fixture: ReturnType<typeof browseDaemon>, origin: string): Promise<void> {
  fixture.setCreatedConnection(false);
  const gate = Promise.withResolvers<void>();
  let started = false, responseStatus: number | undefined, failure: unknown, inflight: Promise<void> | undefined;
  const pattern = "**/api/ideas/idea-child";
  const handler = (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    started = true;
    inflight = (async () => {
      try {
        await gate.promise;
        const response = await route.fetch();
        responseStatus = response.status();
        if (responseStatus === 201) fixture.setCreatedConnection(true);
        await route.fulfill({ response });
      } catch (error) { failure = error; }
    })();
    return inflight;
  };
  try {
    await page.goto(`${origin}/browse/idea-child`, { waitUntil: "networkidle" });
    const inspector = page.getByRole("region", { name: "Selected idea" });
    await expect(inspector.getByRole("heading", { name: "Owned interpretation" })).toBeVisible();
    await page.getByRole("button", { name: "Load more linked ideas" }).click();
    await expect(inspector.getByText("All direct links in this view are shown.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect and explore Owned development" })).toHaveCount(0);
    await page.getByRole("link", { name: "Open Idea" }).click();
    await expect(page).toHaveURL(url => url.pathname === "/ideas/idea-child");
    await page.getByRole("button", { name: /connect to another thought/i }).click();
    const main = page.locator("main"), search = main.getByRole("textbox", { name: /search.*thought/i }).first();
    await search.fill("owned");
    await main.getByRole("button", { name: /^search$/i }).first().click();
    const result = main.locator("article").filter({ hasText: "Owned matching thought begins" }).first();
    await expect(result).toBeVisible();
    await result.getByRole("button", { name: /choose|select/i }).click();
    await main.getByRole("radio", { name: /^supports$/i }).check();
    await main.getByRole("radio", { name: /owned interpretation.*supports.*owned development/i }).check();
    await main.getByRole("textbox", { name: /why are these connected/i }).fill("Owned pending connection");
    await page.route(pattern, handler);
    await main.getByRole("button", { name: /^create connection$/i }).click();
    await expect.poll(() => started).toBe(true);
    await page.getByRole("link", { name: "Browse from here" }).click();
    await expect(page).toHaveURL(url => url.pathname === "/browse/idea-child");
    await expect(inspector.getByRole("heading", { name: "Owned interpretation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect and explore Owned development" })).toHaveCount(0);
    gate.resolve();
    if (inflight) await inflight;
    assert.equal(failure, undefined, "Owned connection request must settle");
    assert.equal(responseStatus, 201, "Owned connection must be confirmed before map assertion");
    // No manual refresh or expansion: settlement must invalidate the currently mounted map.
    await expect(page.getByRole("button", { name: "Inspect and explore Owned development" })).toBeVisible();
    await expect(inspector.getByRole("listitem").filter({ hasText: "Owned pending connection" })).toBeVisible();
  } finally {
    gate.resolve();
    await page.unroute(pattern, handler);
    if (inflight) await inflight;
    fixture.setCreatedConnection(false);
  }
}

export async function checkBrowseBrowser(page: Page, fixture: ReturnType<typeof browseDaemon>, options: { origin: string; daemonOrigin: string; token: string }): Promise<void> {
  const leaks: string[] = [];
  page.on("request", request => {
    if (request.url().startsWith(options.daemonOrigin) || request.url().includes(options.token) || request.headers().authorization?.includes(options.token)) leaks.push("browser request leaked daemon configuration");
  });
  page.on("console", message => { if (message.text().includes(options.token) || message.text().includes(options.daemonOrigin)) leaks.push("console leaked daemon configuration"); });
  await page.goto(`${options.origin}/explore`, { waitUntil: "networkidle" });
  const nav = page.getByRole("navigation");
  await expect(page.getByText("Reserved", { exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", "/settings");
  const link = nav.getByRole("link", { name: "Browse", exact: true });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/browse(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Browse", exact: true })).toBeVisible();
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Owned browse title 50", { exact: true })).toBeVisible();
  const root = page.locator("html");
  const originalFontSize = await root.evaluate(element => element.style.fontSize);
  const minimumWidth = await root.evaluate(element => getComputedStyle(element).minInlineSize);
  const rootWidth = await root.evaluate(element => element.getBoundingClientRect().width);
  try {
    for (const scale of [100, 150, 200]) {
      await root.evaluate((element, value) => { element.style.fontSize = `${value}%`; }, scale);
      assert.equal(await root.evaluate(element => getComputedStyle(element).minInlineSize), minimumWidth,
        `the document minimum width must not scale with ${scale}% root text`);
      assert.equal(await root.evaluate(element => element.getBoundingClientRect().width), rootWidth,
        `enlarging root text to ${scale}% must not widen the document root`);
    }
  } finally { await root.evaluate((element, value) => { element.style.fontSize = value; }, originalFontSize); }
  const authors = page.getByRole("group", { name: "Authorship" });
  const source = authors.getByRole("checkbox", { name: /^Imported source$/i });
  await expect(source).toBeChecked();
  await checkBrowseWhimsy(page);
  await expect(page.getByText("Owned browse title 0", { exact: true })).toHaveCount(0);
  const rows = page.getByRole("list", { name: "Ideas" }).getByRole("listitem");
  await expect(rows).toHaveCount(50);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(rows).toHaveCount(51);
  await expect(page.getByText("Owned browse title 0", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  for (let i = 0; i < 51; i++) await expect(page.getByText(`Owned browse title ${i}`, { exact: true })).toHaveCount(1);
  await checkMapJourney(page, fixture, options.origin);
  const userFilter = authors.getByRole("checkbox", { name: "You" });
  const aiFilter = authors.getByRole("checkbox", { name: "AI" });
  await userFilter.uncheck();
  await aiFilter.uncheck();
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("Owned browse title 1", { exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.getAll("author")).toEqual(["source"]);
  await expect.poll(() => new URL(fixture.attempts.at(-1) ?? "", "http://fixture.invalid").searchParams.getAll("author")).toEqual(["source"]);
  await page.reload({ waitUntil: "networkidle" });
  await expect(source).toBeChecked();
  await expect(userFilter).not.toBeChecked();
  await expect(aiFilter).not.toBeChecked();
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await source.uncheck();
  await expect(page.getByText("Owned browse title 1", { exact: true })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.getAll("author")).toEqual(["user", "ai"]);
  await page.reload({ waitUntil: "networkidle" });
  await expect(source).not.toBeChecked();
  await expect(userFilter).toBeChecked();
  await expect(aiFilter).toBeChecked();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(source).toBeChecked();
  await checkRapidBrowseIntent(page);
  const sort = page.getByRole("combobox", { name: "Sort" });
  const ai = page.getByRole("group", { name: "Authorship" }).getByRole("checkbox", { name: "AI" });
  const user = page.getByRole("group", { name: "Authorship" }).getByRole("checkbox", { name: "You" });
  await page.reload({ waitUntil: "networkidle" });
  await expect(sort).toHaveValue("oldest");
  await expect(ai).not.toBeChecked();
  await expect(user).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Show rejected" })).toBeChecked();
  await user.uncheck();
  await expect(page.getByText("Select at least one authorship filter to show ideas.")).toBeVisible();
  const before = fixture.attempts.length;
  await page.getByRole("button", { name: "Refresh list" }).click();
  assert.equal(fixture.attempts.length, before, "empty authors must not query daemon");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(user).toBeChecked(); await expect(ai).toBeChecked(); await expect(source).toBeChecked();
  await expect(sort).toHaveValue("oldest");
  await expect(page.getByRole("checkbox", { name: "Show rejected" })).not.toBeChecked();
  fixture.setEmpty(true);
  try {
    await page.getByRole("button", { name: "Refresh list" }).click();
    await expect(page.getByRole("heading", { name: "No ideas yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Capture a thought" })).toHaveAttribute("href", "/capture");
    await ai.uncheck();
    await expect(page.getByRole("heading", { name: "No ideas match these filters" })).toBeVisible();
  } finally { fixture.setEmpty(false); }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal overflow");
  const html = await page.content();
  assert.ok(!html.includes(options.token) && !html.includes(options.daemonOrigin));
  assert.deepEqual(leaks, []);
}
