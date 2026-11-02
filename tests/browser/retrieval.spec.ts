import { expect, test, type Page } from "@playwright/test";
import { parseSearchResponse, type Source } from "../../packages/contracts/src";
import { inquiryExample as example } from "../fixtures/inquiry-content";

const daemonURL = `http://127.0.0.1:${process.env.THOUGHTLOOM_E2E_DAEMON_PORT ?? "4318"}`;

async function search(page: Page, query: string) {
  const field = page.getByRole("searchbox", { name: "Search thoughts", exact: true });
  await expect(field).toBeVisible();
  await field.fill(query);
  await field.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === "/search" && url.searchParams.get("q") === query);
  const results = page.getByRole("region", { name: "Search results", exact: true });
  await expect(results).toBeVisible();
  return results;
}

async function assertNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("search finds SDK and its recorded expansion, restores the query, and tolerates a missing character", async ({ page, request }) => {
  await page.goto("/");
  // Intended first RED: phase 1 is runnable, but has no search entry field.
  const results = await search(page, "SDK");
  const originalHit = results.getByRole("article").filter({ hasText: example.sdk });
  const expandedHit = results.getByRole("article").filter({ hasText: example.expandedSDK });
  await expect(originalHit).toBeVisible();
  await expect(originalHit.getByText("Matched original", { exact: true })).toBeVisible();
  await expect(expandedHit).toBeVisible();
  await expect(expandedHit.getByText("Matched recorded alias", { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  const open = originalHit.getByRole("link", { name: /^Open thought/ });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => /^\/sources\/[^/]+\/inquiry$/.test(url.pathname) && url.searchParams.get("q") === "SDK");
  await expect(page.getByText("No interpretations recorded yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("No connections recorded yet.", { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search thoughts", exact: true })).toHaveValue("SDK");
  await expect(page.getByRole("region", { name: "Search results", exact: true }).getByText(example.sdk, { exact: true })).toBeVisible();

  const exact = await request.get(`${daemonURL}/search?q=coordination`);
  expect(exact.status()).toBe(200);
  const exactBody = parseSearchResponse(await exact.json());
  const originals = exactBody?.results.filter((hit) => !hit.item && hit.match.kind === "exact" && hit.match.field === "source-body" && hit.passage.fragments.some((fragment) => fragment.text.includes("coordination"))) ?? [];
  expect(originals).toHaveLength(1);
  const sourceId = originals[0].sourceId;
  const originalRead = await request.get(`${daemonURL}/sources/${sourceId}`);
  expect(originalRead.status()).toBe(200);
  expect(await originalRead.json()).toMatchObject({ id: sourceId, text: example.original, provenance: example.provenance });
  const typoResponse = await request.get(`${daemonURL}/search?q=coordinaton`);
  expect(typoResponse.status()).toBe(200);
  const typoBody = parseSearchResponse(await typoResponse.json());
  const represented = typoBody?.results.find((hit) => hit.sourceId === sourceId && !hit.item);
  expect(represented).toMatchObject({ sourceId, matchOrigin: "source", source: { provenance: example.provenance }, match: { kind: "typo", field: "source-body", fieldRevisionId: sourceId } });
  const correction = represented?.match.correctedTerms[0];
  expect(represented?.match.correctedTerms).toHaveLength(1);
  expect(correction?.from).toBe("coordinaton");
  expect(["coordination", "coordinator"]).toContain(correction?.to);
  if (!correction) throw new Error("Missing fixture correction");
  let sourceReads = 0;
  page.on("request", (req) => { if (new URL(req.url()).pathname === `/api/sources/${sourceId}`) sourceReads++; });
  const typoResults = await search(page, "coordinaton");
  const typoHit = typoResults.getByRole("article").filter({ has: page.locator(`a[href^="/sources/${sourceId}/inquiry?"]`) });
  await expect(typoHit.getByText("Matched original", { exact: true })).toBeVisible();
  await expect(typoHit.locator("mark")).toHaveText(correction.to);
  await expect(typoHit.getByText(`Including “${correction.to}” for “coordinaton”.`, { exact: true })).toBeVisible();
  const link = typoHit.getByRole("link", { name: "Open thought", exact: true });
  const href = await link.getAttribute("href"); if (!href) throw new Error("Missing source link");
  const target = new URL(href, page.url());
  expect(target.pathname).toBe(`/sources/${sourceId}/inquiry`); expect(target.searchParams.get("q")).toBe("coordinaton");
  const originalURL = page.url(), beforeReads = sourceReads;
  await typoHit.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect(typoHit.getByText(example.original, { exact: true })).toBeVisible();
  expect(sourceReads).toBe(beforeReads + 1); expect(page.url()).toBe(originalURL);
  await expect(link).toHaveAttribute("href", href);
  await typoHit.getByRole("button", { name: "Show less", exact: true }).click();
  await typoHit.getByRole("button", { name: "Read full text", exact: true }).click();
  await expect(typoHit.getByText(example.original, { exact: true })).toBeVisible();
  expect(sourceReads).toBe(beforeReads + 1); expect(page.url()).toBe(originalURL);
  await expect(page.getByRole("searchbox", { name: "Search thoughts", exact: true })).toHaveValue("coordinaton");
  await assertNoHorizontalOverflow(page);
});

test("an inquiry keeps the original, attributed AI interpretations, evidence and revision history together", async ({ page, request }) => {
  await page.goto("/");
  const results = await search(page, "intent preservation");
  const hit = results.getByRole("article").filter({ hasText: example.currentInterpretation });
  await expect(hit.getByText("Matched AI note", { exact: true })).toBeVisible();
  await expect(hit.getByText("AI interpretation · Tentative", { exact: true })).toBeVisible();
  const open = hit.getByRole("link", { name: /^Open thought/ });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => /^\/sources\/[^/]+\/inquiry$/.test(url.pathname) && url.searchParams.get("q") === "intent preservation");
  const sourceId = new URL(page.url()).pathname.split("/")[2];

  // Read-model contract for GREEN: daemon owns the one-hop aggregate. No fixture
  // endpoint, database access from Next, or browser-supplied upstream URL.
  const aggregate = await request.get(`${daemonURL}/sources/${sourceId}/inquiry`);
  expect(aggregate.status()).toBe(200);
  const model: unknown = await aggregate.json();
  expect(model).toMatchObject({
    source: { id: sourceId, text: example.original, provenance: example.provenance },
    items: expect.arrayContaining([
      expect.objectContaining({ sourceId, kind: "interpretation", current: expect.objectContaining({ text: example.currentInterpretation, author: "ai", evidenceSourceIds: [sourceId] }), history: expect.arrayContaining([expect.objectContaining({ text: example.initialInterpretation, author: "ai" })]) }),
      expect.objectContaining({ current: expect.objectContaining({ text: example.connectedInterpretation, author: "ai" }) }),
    ]),
    relationships: expect.arrayContaining([expect.objectContaining({ type: "suggests", current: expect.objectContaining({ status: "active", rationale: example.currentRationale, author: "ai" }), history: expect.arrayContaining([expect.objectContaining({ rationale: example.initialRationale })]) })]),
    evidenceSources: expect.arrayContaining([expect.objectContaining({ id: sourceId, provenance: example.provenance }), expect.objectContaining({ excerpt: example.expandedSDK, provenance: example.provenance })]),
  });

  const original = page.getByRole("region", { name: "Original source", exact: true });
  const fullOriginal = original.getByRole("article", { name: "Original thought", exact: true });
  await expect(fullOriginal).not.toBeVisible();
  await original.getByRole("button", { name: "Read full original", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(fullOriginal).toBeVisible();
  await expect(original.getByText(example.provenance, { exact: true })).toBeVisible();
  expect(await fullOriginal.textContent()).toBe(example.original);
  const savedOriginal = await request.get(`${daemonURL}/sources/${sourceId}`);
  expect(savedOriginal.status()).toBe(200);
  const source = await savedOriginal.json() as Source;
  await expect(original.locator("time")).toHaveAttribute("datetime", source.createdAt);
  await expect(original.getByRole("link", { name: "Open source", exact: true })).toHaveAttribute("href", `/sources/${sourceId}`);

  const interpretations = page.getByRole("region", { name: "Interpretations", exact: true });
  const interpretation = interpretations.getByRole("article").filter({ hasText: example.currentInterpretation });
  await expect(interpretation.getByText("AI interpretation", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(interpretation.getByText("Tentative", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(interpretations.getByText(example.alternateInterpretation, { exact: true }).filter({ visible: true })).toBeVisible();
  await interpretation.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(interpretation.getByRole("link", { name: /^Evidence:/ })).toHaveAttribute("href", `/sources/${sourceId}`);
  await interpretation.getByRole("button", { name: "View history", exact: true }).focus();
  await page.keyboard.press("Enter");
  const formulationHistory = interpretation.getByRole("region", { name: "Formulation history", exact: true });
  await expect(formulationHistory.getByText(example.initialInterpretation, { exact: true })).toBeVisible();
  await expect(formulationHistory.getByText(example.currentInterpretation, { exact: true })).toBeVisible();

  const connections = page.getByRole("region", { name: "Connections", exact: true });
  const relationship = connections.getByRole("article").filter({ hasText: example.currentRationale });
  await expect(relationship.getByText("AI suggestion", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(relationship.getByText("Active hypothesis", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(relationship.getByText(example.currentRationale, { exact: true }).filter({ visible: true })).toBeVisible();
  await relationship.getByRole("button", { name: "Evidence", exact: true }).click();
  const evidence = relationship.getByRole("link", { name: /^Evidence:/ });
  await expect(evidence).toHaveCount(2);
  for (const link of await evidence.all()) await expect(link).toHaveAttribute("href", /^\/sources\/[^/?#]+$/);
  await relationship.getByRole("button", { name: "View history", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(relationship.getByRole("region", { name: "Connection history", exact: true }).getByText(example.initialRationale, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Develop this thought", exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await relationship.getByRole("link", { name: "Open connected thought", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Interpretations", exact: true }).getByText(example.connectedInterpretation, { exact: true }).filter({ visible: true })).toBeVisible();
  const back = page.getByRole("link", { name: "Search: intent preservation", exact: true });
  const backURL = new URL((await back.getAttribute("href"))!, page.url());
  expect(backURL.pathname).toBe("/search");
  expect(backURL.searchParams.get("q")).toBe("intent preservation");
  await back.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("searchbox", { name: "Search thoughts", exact: true })).toHaveValue("intent preservation");
  await expect(page.getByRole("region", { name: "Search results", exact: true }).getByText(example.currentInterpretation, { exact: true })).toBeVisible();
});

test("empty and no-match search states do not turn into an all-notes list", async ({ page }) => {
  await page.goto("/search");
  const field = page.getByRole("searchbox", { name: "Search thoughts", exact: true });
  await expect(field).toBeVisible();
  await expect(page.getByText("Search a word, a fragment, or an idea. No question needed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Search results", exact: true })).toHaveCount(0);
  await field.fill("zzquuxnothinglikethis");
  await field.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === "/search" && url.searchParams.get("q") === "zzquuxnothinglikethis");
  await expect(page.getByRole("status").filter({ hasText: "No thoughts found" })).toBeVisible();
  await expect(page.getByText(/try a shorter fragment or wording from an original/i)).toBeVisible();
  await expect(page.getByRole("region", { name: "Search results", exact: true }).getByRole("article")).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});
