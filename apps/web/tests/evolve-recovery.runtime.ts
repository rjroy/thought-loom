import assert from "node:assert/strict";
import { expect, type Page, type Route } from "@playwright/test";

const sessionId = "evolve-recovery-session";
const date = "2032-01-01T00:00:00.000Z";
const session = { id: sessionId, anchorThoughtId: "evolve-start", continuationThoughtId: "evolve-earlier", mode: "ideas-only", createdAt: date };
const saved = { thoughtId: "evolve-earlier", parentId: "evolve-start", speaker: "user", selectedBy: "ai", text: "Owned earlier thought", source: "passage", start: 0 };
const completed = { id: "recovery-turn", parentId: "evolve-start", text: "Owned earlier thought", status: "completed", admittedAt: date,
  runId: "recovery-run", reply: "Owned confirmed reply.", saves: [saved], savesHasMore: false, savesNextAfter: null };
const run = (id: string, status: string) => ({ id, kind: "evolve", status, confirmedThoughtIds: [], responseId: null });
const envelope = (turn: Pick<typeof completed, "id" | "parentId" | "text" | "status" | "admittedAt" | "runId">) => ({ receipt: { sessionId, turnId: turn.id, admittedAt: turn.admittedAt },
  turn: { id: turn.id, parentId: turn.parentId, text: turn.text, status: turn.status, admittedAt: turn.admittedAt, runId: turn.runId, reply: null, saves: [] },
  run: run(turn.runId, turn.status) });
const json = (route: Route, value: object, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const turnRegion = (page: Page, text: string) => page.getByRole("region", { name: "Conversation turn", exact: true }).filter({ hasText: text });

async function open(page: Page, origin: string, pending = false) {
  await page.goto(`${origin}/evolve?thoughtId=evolve-start`, { waitUntil: "networkidle" });
  await page.evaluate(({ id, enabled }) => {
    sessionStorage.removeItem(`thoughtloom.evolve.pending:${id}`);
    if (enabled) sessionStorage.setItem(`thoughtloom.evolve.pending:${id}`, JSON.stringify({ kind: "send", key: "a".repeat(36) }));
  }, { id: sessionId, enabled: pending });
  await page.goto(`${origin}/evolve?conversationId=${sessionId}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Resume", exact: true }).click();
}

export async function checkCompactRecovery(page: Page, origin: string): Promise<void> {
  let failRead = false, lookups = 0;
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/turns/by-key/" + "a".repeat(36))) {
      lookups++; failRead = true;
      await json(route, envelope(completed));
    } else if (url.pathname.endsWith(`/evolve-sessions/${sessionId}`)) {
      if (failRead) await json(route, {}, 503);
      else await json(route, { session, turns: [completed], nextBefore: null });
    } else await route.continue();
  };
  await page.route("**/api/evolve-sessions/**", handler);
  try {
    await open(page, origin, true);
    await expect(page.getByText("Owned confirmed reply.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Saved ideas" })).toBeVisible();
    await page.getByRole("button", { name: "Check request" }).click();
    await expect(page.getByText(/could not refresh the conversation/i)).toBeVisible();
    assert.equal(lookups, 1);
    await expect(page.getByText("Owned confirmed reply.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Saved ideas" })).toBeVisible();
    await expect(page.getByText("Owned earlier thought", { exact: true }).last()).toBeVisible();
  } finally { await page.unroute("**/api/evolve-sessions/**", handler); }
}

export async function checkOffWindowReceiptOrder(page: Page, origin: string): Promise<void> {
  const numbered = (index: number) => ({ ...completed, id: `numbered-turn-${index}`, text: `Owned numbered turn ${index}`,
    runId: `numbered-run-${index}`, reply: `Owned numbered reply ${index}`, saves: [] });
  const oldest = Array.from({ length: 20 }, (_, index) => numbered(index + 1));
  const recent = Array.from({ length: 20 }, (_, index) => numbered(index + 21));
  const original = numbered(20);
  let heads = 0, earlier = 0, lookups = 0;
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/turns/by-key/" + "a".repeat(36))) {
      lookups++; await json(route, envelope(original));
    } else if (url.pathname.endsWith(`/evolve-sessions/${sessionId}`)) {
      if (url.searchParams.get("before") === recent[0].id) {
        earlier++; await json(route, { session, turns: oldest, nextBefore: null });
      } else {
        heads++; await json(route, { session, turns: recent, nextBefore: recent[0].id });
      }
    } else await route.continue();
  };
  const turnNumbers = async () => page.getByRole("region", { name: "Conversation turn", exact: true }).evaluateAll(nodes =>
    nodes.map(node => Number(node.textContent?.match(/Owned numbered turn (\d+)/)?.[1])));
  await page.route("**/api/evolve-sessions/**", handler);
  try {
    await open(page, origin, true);
    await expect.poll(turnNumbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 21));
    await page.getByRole("button", { name: "Check request" }).click();
    await expect.poll(() => heads).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("button", { name: "Check request" })).toHaveCount(0);
    assert.equal(lookups, 1);
    // An off-window receipt is not authoritative ordering data; it must not
    // place turn 20 after turn 40 before its older page arrives.
    const before = await turnNumbers();
    expect(new Set(before).size).toBe(before.length);
    expect(before).toEqual([...before].sort((a, b) => a - b));
    await page.getByRole("button", { name: "Load earlier turns" }).click();
    await expect.poll(turnNumbers).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal(earlier, 1);
    expect(new Set(await turnNumbers()).size).toBe(40);
    await expect(page.getByRole("button", { name: "Load earlier turns" })).toHaveCount(0);
  } finally { await page.unroute("**/api/evolve-sessions/**", handler); }
}

export async function checkOffWindowActiveReceipt(page: Page, origin: string): Promise<void> {
  // The lookup captures a running turn, then later writes advance the head
  // before the lookup response is consumed. The head read must not silently
  // discard the only known control identity.
  const rows = Array.from({ length: 40 }, (_, index) => ({ ...completed, id: `active-page-${index + 1}`,
    text: `Owned active-page turn ${index + 1}`, runId: `active-page-run-${index + 1}`, saves: [] }));
  const active = { ...rows[19], status: "running", reply: null };
  let advanced = false, heads = 0, checks = 0, stops = 0;
  const handler = async (route: Route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith("/turns/by-key/" + "a".repeat(36))) {
      advanced = true;
      await json(route, envelope(active));
    } else if (url.pathname.endsWith(`/evolve/runs/${active.runId}`) && request.method() === "GET") {
      checks++; await json(route, run(active.runId, "running"));
    } else if (url.pathname.endsWith(`/evolve/runs/${active.runId}`) && request.method() === "POST") {
      stops++; await json(route, run(active.runId, "interrupted"));
    } else if (url.pathname.endsWith(`/evolve-sessions/${sessionId}`)) {
      heads++;
      await json(route, advanced
        ? { session, turns: rows.slice(20), nextBefore: rows[20].id }
        : { session, turns: rows.slice(0, 19), nextBefore: null });
    } else await route.continue();
  };
  await page.route("**/api/**", handler);
  try {
    await open(page, origin, true);
    await page.getByRole("button", { name: "Check request" }).click();
    await expect.poll(() => heads).toBeGreaterThanOrEqual(2);
    const conversation = page.getByRole("region", { name: "Conversation", exact: true });
    await expect(conversation.getByRole("region", { name: "Conversation turn", exact: true }).filter({ hasText: active.text })).toHaveCount(0);
    const runChecks = page.getByRole("region", { name: "Run checks", exact: true });
    const selectedRun = runChecks.getByText(active.runId, { exact: true }).locator("../..");
    await selectedRun.getByRole("button", { name: `Check this run: ${active.runId}`, exact: true }).click();
    await expect.poll(() => checks).toBe(1);
    await expect(selectedRun).toContainText(/running|reply in progress/i);
    await selectedRun.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => stops).toBe(1);
    await expect(selectedRun).toContainText(/interrupted/i);
    await expect(selectedRun).toContainText(/remote tools may still be running/i);
    await expect(conversation.getByRole("region", { name: "Conversation turn", exact: true }).filter({ hasText: active.text })).toHaveCount(0);
  } finally { await page.unroute("**/api/**", handler); }
}

export async function checkBranchInspectionRace(page: Page, origin: string): Promise<void> {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let puts = 0, sends = 0;
  const handler = async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "PUT" && path.endsWith("/continuation")) {
      puts++; await held; await json(route, {}, 502);
    } else if (request.method() === "POST" && path.endsWith("/turns")) {
      sends++; await json(route, {}, 500);
    } else if (request.method() === "GET" && path.endsWith(`/evolve-sessions/${sessionId}`)) {
      await json(route, { session, turns: [completed], nextBefore: null });
    } else await route.continue();
  };
  await page.route("**/api/evolve-sessions/**", handler);
  try {
    await open(page, origin);
    const draft = "Owned draft during branch change";
    await page.getByRole("textbox", { name: "Your message" }).fill(draft);
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await page.getByRole("radio", { name: /Starting thought/i }).check();
    await page.getByRole("button", { name: "Use this thought" }).click();
    await expect.poll(() => puts).toBe(1);
    await page.getByRole("link", { name: /^Open idea:/i }).click();
    await expect(page).toHaveURL(/\/ideas\/evolve-earlier/);
    await page.goBack();
    await expect(page.getByRole("textbox", { name: "Your message" })).toHaveValue(draft);
    release();
    await expect(page.getByText(/continuation change unconfirmed/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Check selection" }).click();
    await expect(page.getByRole("button", { name: "Use current thought" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    assert.equal(sends, 0); assert.equal(puts, 1);
  } finally { release(); await page.unroute("**/api/evolve-sessions/**", handler); }
}

export async function checkOverlappingStopRecovery(page: Page, origin: string): Promise<void> {
  const old = { ...completed, text: "Owned old run", status: "running", reply: null, saves: [] };
  const newer = { ...completed, id: "recovery-turn-new", runId: "recovery-run-new", text: "Owned newer run", status: "running", reply: null, saves: [] };
  let newerVisible = false, oldStops = 0, newStops = 0, oldChecks = 0;
  const handler = async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith(`/evolve-sessions/${sessionId}`)) {
      await json(route, { session, turns: newerVisible ? [{ ...old, status: "interrupted" }, newer] : [old], nextBefore: null });
    } else if (path.endsWith("/evolve/runs/recovery-run") && request.method() === "POST") {
      oldStops++; newerVisible = true; await json(route, {}, 502);
    } else if (path.endsWith("/evolve/runs/recovery-run-new") && request.method() === "POST") {
      newStops++; await json(route, run(newer.runId, "interrupted"));
    } else if (path.endsWith("/evolve/runs/recovery-run") && request.method() === "GET") {
      oldChecks++; await json(route, run(old.runId, "interrupted"));
    } else await route.continue();
  };
  await page.route("**/api/**", handler);
  try {
    await open(page, origin);
    await turnRegion(page, old.text).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText(/stop unconfirmed/i)).toBeVisible();
    await expect(turnRegion(page, newer.text)).toBeVisible({ timeout: 15000 });
    await expect(turnRegion(page, old.text).getByRole("button", { name: "Check this run" })).toBeVisible();
    const stopNew = turnRegion(page, newer.text).getByRole("button", { name: "Stop", exact: true });
    await expect(stopNew).toBeEnabled();
    await stopNew.click();
    await expect.poll(() => newStops).toBe(1);
    await turnRegion(page, old.text).getByRole("button", { name: "Check this run" }).click();
    await expect.poll(() => oldChecks).toBe(1);
    assert.equal(oldStops, 1, "checking or stopping newer work must not replay the old Stop");
  } finally { await page.unroute("**/api/**", handler); }
}
