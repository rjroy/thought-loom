import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import type { Browser, Page, Download } from "@playwright/test";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import type { InboxItem, NativeMessage, NativeSession, PublicClient } from "../src/agent/opencode-adapter";
import { AgentSessionMissingError } from "../src/agent/errors";
import { independentPng } from "../tests/fixtures/media-rasters";
const ownedRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium, expect } = ownedRequire("@playwright/test") as typeof import("@playwright/test");

const user = "owned-integration-user-0123456789012345";
const ai = "owned-integration-agent-012345678901234";
const privateToken = "owned-integration-native-never-networked";
const root = process.cwd();
const web = resolve(root, "apps/web");
for (const dependency of ["@playwright/test", "next/package.json"]) {
  assert.ok(realpathSync(ownedRequire.resolve(dependency)).startsWith(`${realpathSync(root)}${sep}`), `${dependency} must resolve inside the owned workspace`);
}
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function record(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function string(value: unknown): string { assert.equal(typeof value, "string"); return value as string; }
async function bounded<T>(work: Promise<T>, label: string, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

type InstructionValue = Parameters<PublicClient["instructionPut"]>[0]["value"];
class FixtureClient implements PublicClient {
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, NativeMessage[]>();
  readonly prompts = new Map<string, string[]>();
  private readonly instructions = new Map<string, Map<string, InstructionValue>>();
  private releaseHeld: (() => void) | undefined;
  holdEvolve = true;
  sourceId = "";
  release() { this.holdEvolve = false; this.releaseHeld?.(); this.releaseHeld = undefined; }
  async serverInfo() { return { version: "99.0.0-owned" }; }
  async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
    const value: NativeSession = { id: input.id, location: input.location, model: input.model, permissions: input.permissions, metadata: input.metadata };
    this.sessions.set(input.id, value); this.messages.set(input.id, []); return value;
  }
  async sessionGet(input: { readonly sessionID: string }): Promise<NativeSession> { const value = this.sessions.get(input.sessionID); if (!value) throw new AgentSessionMissingError("Owned session absent"); return value; }
  async instructionList(input: Parameters<PublicClient["instructionList"]>[0]): ReturnType<PublicClient["instructionList"]> {
    return [...(this.instructions.get(input.sessionID)?.entries() ?? [])].map(([key, value]) => ({ key, value }));
  }
  async instructionPut(input: Parameters<PublicClient["instructionPut"]>[0]): Promise<void> {
    const entries = this.instructions.get(input.sessionID) ?? new Map<string, InstructionValue>();
    entries.set(input.key, input.value); this.instructions.set(input.sessionID, entries);
  }
  async instructionRemove(input: Parameters<PublicClient["instructionRemove"]>[0]): Promise<void> {
    this.instructions.get(input.sessionID)?.delete(input.key);
  }
  async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
    const history = this.prompts.get(input.sessionID) ?? []; history.push(input.text); this.prompts.set(input.sessionID, history);
    const first = record(JSON.parse(history[0]));
    if (first.kind === "import-job") {
      assert.equal(history.length, 1);
      assert.deepEqual(Object.keys(first).sort(), ["capabilities", "document", "instructions", "kind", "manifest", "version"]);
      assert.equal(first.version, 1); assert.deepEqual(first.capabilities, []);
      const cuts = record(first.manifest).cuts; assert.ok(Array.isArray(cuts) && cuts.length >= 2);
      const output = { version: 1, kind: "segmentation", cuts: [string(record(cuts[0]).id), string(record(cuts[cuts.length - 1]).id)] };
      const messages = this.messages.get(input.sessionID); assert.ok(messages);
      messages.push({ id: input.id, type: "user", time: { created: 10 }, text: input.text },
        { id: `assistant-${input.id}`, type: "assistant", time: { created: 11, completed: 12 }, content: [{ type: "text", text: JSON.stringify(output) }], finish: "stop" },
        { id: `idle-${input.id}`, type: "idle", time: { created: 13 }, outcome: "succeeded" });
      return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: 10 } };
    }
    const job = record(record(first.context).job);
    if (job.kind === "search") {
      const current = record(JSON.parse(input.text));
      const capability = (name: string, args: object) => ({ version: 1, kind: "request", request: { capability: name, arguments: args } });
      let output: object;
      if (history.length === 1) output = capability("findThoughts", { query: "cobalt", authors: [], kinds: [], from: null, until: null, sort: "oldest", limit: 25, cursor: null });
      else {
        const request = record(current.request);
        if (request.capability === "findThoughts") {
          assert.ok(JSON.stringify(current.result).includes(this.sourceId), "owned source must be an eligible search result");
          output = capability("readThought", { id: this.sourceId });
        } else if (request.capability === "readThought") output = capability("addDiscovery", { thoughtId: this.sourceId, why: "Owned evidence is relevant.", evidenceThoughtIds: [] });
        else {
          assert.equal(request.capability, "addDiscovery");
          output = { version: 1, kind: "search-reply", reply: "Owned search finding is ready.", disposition: "awaiting-user", sourceThoughtIds: [this.sourceId] };
        }
      }
      const messages = this.messages.get(input.sessionID); assert.ok(messages);
      const n = messages.length * 10 + 10;
      messages.push({ id: input.id, type: "user", time: { created: n }, text: input.text },
        { id: `assistant-${input.id}`, type: "assistant", time: { created: n + 1, completed: n + 2 }, content: [{ type: "text", text: JSON.stringify(output) }], finish: "stop" },
        { id: `idle-${input.id}`, type: "idle", time: { created: n + 3 }, outcome: "succeeded" });
      return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: n } };
    }
    if (job.kind === "evolve" && this.holdEvolve) await new Promise<void>(done => { this.releaseHeld = done; });
    const step = history.length;
    const output = job.kind === "export" ? (step === 1
      ? { version: 1, kind: "request", request: { capability: "readThought", arguments: { id: this.sourceId } } }
      : { version: 1, kind: "report", markdown: "# Owned integrated report\n\nEvidence from the captured thought.", sourceThoughtIds: [this.sourceId] })
      : job.kind === "evolve" && step === 1
        ? { version: 1, kind: "request", request: { capability: "development", arguments: { parentId: string(job.contributionId), text: "Owned integrated development", sourceIds: [] } } }
        : job.kind === "weave" && step === 1
          ? { version: 1, kind: "request", request: { capability: "interpretation", arguments: { text: job.purpose === "reinterpretation" ? "Owned fresh integrated interpretation" : "Owned integrated interpretation", sourceIds: [string(job.subjectId)] } } }
        : job.kind === "weave" && job.purpose !== "reinterpretation" && step === 2 && !(Array.isArray(first.originals) && first.originals.length > 0)
          ? { version: 1, kind: "request", request: { capability: "title-fill", arguments: { title: "Owned generated title" } } }
        : { version: 1, kind: "complete", reply: job.kind === "evolve" ? "Owned integrated reply" : job.purpose === "reinterpretation" ? "Owned fresh reinterpretation reply" : "No further findings" };
    const messages = this.messages.get(input.sessionID); assert.ok(messages);
    const n = messages.length * 10 + 10;
    messages.push({ id: input.id, type: "user", time: { created: n }, text: input.text },
      { id: `assistant-${input.id}`, type: "assistant", time: { created: n + 1, completed: n + 2 }, content: [{ type: "text", text: JSON.stringify(output) }], finish: "stop" },
      { id: `idle-${input.id}`, type: "idle", time: { created: n + 3 }, outcome: "succeeded" });
    return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: n } };
  }
  async inbox() { return []; }
  async history(input: Parameters<PublicClient["history"]>[0]) { return { data: this.messages.get(input.sessionID) ?? [], cursor: {} }; }
  async active() { return {}; }
  async cancelInbox() {}
  async interrupt() { return { interrupted: true }; }
}

async function checkFixtureInstructions(): Promise<void> {
  const client = new FixtureClient(), sessionID = "owned-session-a", other = "owned-session-b", key = "owned-key";
  assert.deepEqual(await client.instructionList({ sessionID }), []);
  await client.instructionPut({ sessionID, key, value: "first" });
  await client.instructionPut({ sessionID: other, key, value: { nested: true } });
  await client.instructionPut({ sessionID, key, value: "replacement" });
  assert.deepEqual(await client.instructionList({ sessionID }), [{ key, value: "replacement" }]);
  assert.deepEqual(await client.instructionList({ sessionID: other }), [{ key, value: { nested: true } }]);
  await client.instructionRemove({ sessionID, key });
  assert.deepEqual(await client.instructionList({ sessionID }), []);
  assert.deepEqual(await client.instructionList({ sessionID: other }), [{ key, value: { nested: true } }]);
}

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  return address.port;
}
function next(args: string[], env: NodeJS.ProcessEnv): ChildProcess { return spawn(process.execPath, ["--no-env-file", "run", "--bun", "next", ...args], { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] }); }
function output(child: ChildProcess) { let text = ""; const append = (chunk: Buffer) => { text = (text + chunk.toString()).slice(-12000); }; child.stdout?.on("data", append); child.stderr?.on("data", append); return () => text; }
async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const close = new Promise<void>(done => child.once("close", () => done()));
  child.kill("SIGTERM");
  try { await bounded(close, "Next shutdown", 3000); }
  catch { child.kill("SIGKILL"); await bounded(close, "Next forced shutdown", 3000); }
}
async function build(env: NodeJS.ProcessEnv): Promise<void> {
  const child = next(["build"], env); const logs = output(child);
  const closed = new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("close", done); });
  try { assert.equal(await bounded(closed, "Next build", 120000), 0, logs()); } finally { await stopProcess(child); }
}
async function daemonCall(daemon: RunningDaemon, path: string) {
  const response = await fetch(new URL(path, daemon.url), { headers: { authorization: `Bearer ${user}` }, signal: AbortSignal.timeout(3000) });
  const text = await response.text(); return { status: response.status, value: text ? JSON.parse(text) as unknown : null };
}
function dbRows(path: string, sql: string): unknown[] { const db = new Database(path, { readonly: true }); try { return db.query(sql).all(); } finally { db.close(); } }
function knowledge(path: string): unknown[] {
  const tables = ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources", "responses", "response_thoughts", "response_seals", "rejected_thoughts", "rejected_connections"];
  return tables.map(table => [table, dbRows(path, `SELECT * FROM ${table} ORDER BY rowid`)]);
}
async function until(label: string, predicate: () => Promise<boolean>, pulse: () => void, limit = 15000): Promise<void> {
  const end = Date.now() + limit;
  while (Date.now() < end) { pulse(); if (await predicate()) return; await pause(40); }
  throw new Error(`${label} did not settle`);
}
async function settleKnowledge(path: string, pulse: () => void): Promise<void> {
  let stable = 0;
  await until("Non-export agent work", async () => {
    const row = record(dbRows(path, "SELECT count(*) AS n FROM runs WHERE kind != 'export' AND status NOT IN ('completed','failed','interrupted')")[0]);
    stable = Number(row.n) === 0 ? stable + 1 : 0;
    return stable >= 3;
  }, pulse).catch(error => { throw new Error(`${String(error)}: ${JSON.stringify(dbRows(path, "SELECT kind,status FROM runs WHERE kind != 'export'"))}`); });
}
async function captureResponse(page: Page, path: string, action: () => Promise<unknown>) {
  const waiting = page.waitForResponse(response => response.url().includes(path) && response.request().method() === "POST", { timeout: 10000 });
  await action(); const response = await waiting; assert.equal(response.status(), 201); return record(await response.json());
}
async function bytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream(); assert.ok(stream); const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part)); return Buffer.concat(parts);
}

// This is a decoded fake-agent journey over the real browser/Next/daemon boundary,
// not a provider integration or a fabricated database publication.
async function searchWalkthrough(page: Page, origin: string, daemon: RunningDaemon, dbPath: string, sourceId: string, content: string, narrow: boolean, pulse: () => void): Promise<void> {
  const before = knowledge(dbPath);
  const writes: string[] = [];
  const observe = (request: import("@playwright/test").Request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/search-sessions") && request.method() !== "GET") writes.push(`${request.method()} ${url.pathname}`);
  };
  page.on("request", observe);
  try {
    await page.getByRole("link", { name: "Explore", exact: true }).click();
    await page.getByRole("link", { name: "Ask your library", exact: true }).click();
    assert.deepEqual(writes, [], "opening search must not create a session");
    const created = await captureResponse(page, "/api/search-sessions", () => page.getByRole("button", { name: "New search" }).click());
    const sessionId = string(record(created.session).id);
    await expect(page.getByRole("textbox", { name: "Your message" })).toBeVisible();
    const savedUrl = page.url();
    assert.ok(new URL(savedUrl).pathname.startsWith("/explore/ask"));

    const count = writes.length;
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    assert.equal(writes.length, count, "opening a bookmarked session must not create a composer");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const field = page.getByRole("textbox", { name: "Your message" });
    await expect(field).toBeVisible();

    async function turn(text: string) {
      await field.fill(text);
      const admitted = await captureResponse(page, `/api/search-sessions/${sessionId}/turns`, () => page.getByRole("button", { name: "Send", exact: true }).click());
      const runId = string(record(admitted.run).id);
      await until("Owned search completion", async () => {
        const response = await daemonCall(daemon, `/runs/${encodeURIComponent(runId)}`);
        assert.equal(response.status, 200);
        const run = record(response.value);
        if (run.status === "failed" || run.status === "interrupted") throw new Error(`Owned search ended ${String(run.status)}`);
        return run.status === "completed";
      }, pulse);
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await expect(page.getByRole("region", { name: "Conversation" }).getByText("Owned search finding is ready.").first()).toBeVisible();
    }
    await turn("Find the cobalt idea.");
    if (narrow) await page.getByRole("button", { name: /discovered ideas/i }).click();
    await expect(page.getByText("Owned evidence is relevant.")).toBeVisible();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByRole("region", { name: "Idea preview" })).toContainText(content);
    await page.getByRole("link", { name: "Open idea", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === `/ideas/${encodeURIComponent(sourceId)}`);
    await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*search/i }).click();
    await page.waitForURL(savedUrl);

    const removed = page.waitForResponse(response => /\/discoveries\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === "DELETE");
    await page.getByRole("button", { name: "Remove from search" }).click();
    const removal = await removed;
    assert.equal(removal.status(), 204);
    assert.match(removal.headers()["search-session-revision"] ?? "", /^\d+$/);
    const firstOccurrence = new URL(removal.url()).pathname.split("/").at(-1); assert.ok(firstOccurrence);
    await expect(page.getByText("Owned evidence is relevant.")).toHaveCount(0);
    await turn("Find the idea again.");
    await expect(page.getByText("Owned evidence is relevant.")).toBeVisible();
    const history = await daemonCall(daemon, `/search-sessions/${sessionId}/discoveries?scope=history`);
    assert.equal(history.status, 200);
    const occurrences = record(history.value).items;
    assert.ok(Array.isArray(occurrences));
    const matching = occurrences.map(record).filter(item => record(item.thought).id === sourceId);
    assert.equal(matching.length, 2, "rediscovery must append a distinct occurrence");
    assert.equal(matching[0]?.id, firstOccurrence);
    assert.notEqual(matching[1]?.id, firstOccurrence);
    const retry = await page.request.delete(`${origin}/api/search-sessions/${sessionId}/discoveries/${firstOccurrence}`, { headers: { origin } });
    assert.equal(retry.status(), 204);
    await expect(page.getByText("Owned evidence is relevant.")).toBeVisible();
    if (narrow) await page.getByRole("button", { name: "Session actions" }).click();
    await page.getByRole("link", { name: "History", exact: true }).click();
    await expect(page.getByRole("heading", { name: "History · User-only" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Your message" })).toHaveCount(0);
    await expect(page.getByText("Removed from this search")).toBeVisible();

    await page.getByRole("link", { name: "Return to search" }).click();
    await page.waitForURL(savedUrl);
    const second = await captureResponse(page, "/api/search-sessions", () => page.getByRole("button", { name: "New search" }).click());
    const secondId = string(record(second.session).id); assert.notEqual(secondId, sessionId);
    await expect(page).toHaveURL(url => url.pathname.includes(encodeURIComponent(secondId)));
    await page.goto(savedUrl, { waitUntil: "networkidle" });
    if (narrow) await page.getByRole("button", { name: "Session actions" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete this search?" }).getByRole("button", { name: "Delete search" }).click();
    await expect(page.getByRole("heading", { name: "Saved searches" })).toBeVisible();
    assert.equal((await daemonCall(daemon, `/search-sessions/${sessionId}`)).status, 404);
    assert.equal((await daemonCall(daemon, `/search-sessions/${secondId}`)).status, 200);
    await settleKnowledge(dbPath, pulse);
    assert.deepEqual(knowledge(dbPath), before, "search and local deletion must not change library knowledge");
  } finally { page.off("request", observe); }
}

async function walkthrough(viewport: { width: number; height: number }): Promise<void> {
  const dbPath = resolve(root, `owned-${viewport.width}.sqlite`);
  const fake = new FixtureClient(); let tick: (() => void) | undefined;
  let daemon: RunningDaemon | undefined, server: ChildProcess | undefined, browser: Browser | undefined;
  const failures: unknown[] = [];
  try {
    daemon = await startDaemon({ dbPath, port: 0, credentials: { user, ai }, agent: { service: { url: "http://127.0.0.1:44991", token: privateToken }, directory: root, model: { providerID: "owned", id: "fixture" }, effort: { quick: "q", standard: "s", thorough: "t" } } }, () => {}, {
      resolveAgentService: async () => ({ url: "http://127.0.0.1:44991", token: privateToken }), createPublicClient: () => fake,
      startTimer(poll) { tick = poll; return () => { tick = undefined; }; }, logSink: entry => { if (entry.level === "warning" || entry.level === "error") console.error("Owned daemon:", entry.message); },
    });
    const running = daemon;
    const pulse = () => { assert.ok(tick); tick(); };
    const webPort = await port(); const origin = `http://127.0.0.1:${webPort}`;
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NEXT_TELEMETRY_DISABLED: "1", THOUGHTLOOM_WEB_ORIGIN: origin, THOUGHTLOOM_DAEMON_URL: new URL(running.url).origin, THOUGHTLOOM_USER_TOKEN: user };
    await build(env);
    server = next(["start", "--hostname", "127.0.0.1", "--port", String(webPort)], env); const logs = output(server);
    await until("Owned Next readiness", async () => { try { return (await fetch(`${origin}/capture`, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { return false; } }, () => {}, 30000).catch(error => { throw new Error(`${String(error)} ${logs()}`); });
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    const page = await browser.newPage({ viewport });
    const leaked: string[] = [];
    page.on("request", request => { if (request.url().startsWith(new URL(running.url).origin) || request.headers().authorization?.includes(user)) leaked.push("browser bypass"); });
    await page.goto(`${origin}/capture`, { waitUntil: "networkidle" });
    const content = `Cobalt shared integration idea ${viewport.width}`;
    await page.getByRole("textbox", { name: /^thought$/i }).fill(content);
    const captured = await captureResponse(page, "/api/capture", () => page.getByRole("button", { name: /^save$/i }).click());
    const id = string(captured.id); fake.sourceId = id;
    await settleKnowledge(dbPath, pulse);
    const childResult = await daemonCall(running, `/thoughts/${encodeURIComponent(id)}/children?scope=normal`);
    assert.equal(childResult.status, 200);
    assert.ok(Array.isArray(childResult.value));
    const interpretation = childResult.value.map(record).find(item => item.text === "Owned integrated interpretation");
    assert.ok(interpretation);
    assert.equal(interpretation.kind, "ai-interpretation");
    assert.equal(interpretation.parentId, id);
    assert.ok(Array.isArray(interpretation.sourceIds) && interpretation.sourceIds.includes(id));
    const interpretationId = string(interpretation.id);
    // Browse crosses the real Next and owned daemon boundary without a model request.
    const browseBefore = knowledge(dbPath);
    await page.getByRole("link", { name: "Browse", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browse", exact: true })).toBeVisible();
    await expect(page.getByText(content, { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Owned integrated interpretation", { exact: false }).first()).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText(content, { exact: false }).first()).toBeVisible();
    await page.locator("article").filter({ hasText: content }).getByRole("link").first().click();
    await expect(page).toHaveURL(url => url.pathname === `/browse/${encodeURIComponent(id)}`);
    await page.getByRole("button", { name: "Inspect Owned integrated interpretation" }).click();
    await expect(page.getByRole("region", { name: "Selected idea" })).toContainText("Owned integrated interpretation");
    await page.getByRole("button", { name: "Show linked ideas", exact: true }).click();
    await expect(page.getByRole("button", { name: "Linked ideas shown" })).toBeDisabled();
    await page.getByRole("link", { name: "Open Idea" }).click();
    await expect(page).toHaveURL(url => url.pathname === `/ideas/${encodeURIComponent(interpretationId)}`);
    await page.goBack();
    await expect(page).toHaveURL(url => url.pathname === `/browse/${encodeURIComponent(id)}`);
    await expect(page.getByRole("region", { name: "Selected idea" })).toContainText("Owned integrated interpretation");
    await page.getByRole("link", { name: "Back to list" }).click();
    await expect(page).toHaveURL(url => url.pathname === "/browse");
    assert.deepEqual(knowledge(dbPath), browseBefore, "Browse must not change library knowledge");
    await page.getByRole("link", { name: "Explore", exact: true }).click();
    await page.getByRole("textbox", { name: /^search thoughts$/i }).fill("cobalt");
    await page.getByRole("button", { name: /^search$/i }).click();
    const card = page.locator("article").filter({ hasText: content });
    await expect(card).toBeVisible();
    const idea = card.locator(`a[href^="/ideas/${encodeURIComponent(id)}"]`).first(); await idea.click();
    await expect(page.getByText(content, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^history$/i })).toHaveCount(0);
    const interpretationRow = page.locator("article").filter({ has: page.locator(`a[href^="/ideas/${encodeURIComponent(interpretationId)}"]`) });
    await expect(interpretationRow).toHaveCount(1);
    await expect(interpretationRow).toContainText(/interpretation|child/i);
    await interpretationRow.locator(`a[href^="/ideas/${encodeURIComponent(interpretationId)}"]`).first().click();
    await expect(page).toHaveURL(url => url.pathname === `/ideas/${encodeURIComponent(interpretationId)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Owned integrated interpretation", exact: true })).toBeVisible();
    await expect(page.locator(`a[href^="/ideas/${encodeURIComponent(id)}"]`).filter({ hasText: "Owned generated title" }).first()).toBeVisible();
    await expect(page.locator("article").filter({ has: page.locator(`a[href^="/ideas/${encodeURIComponent(id)}"]`) })).toContainText(/source|provenance/i);
    const previousIdea = page.getByRole("banner").getByRole("link", { name: /(?:back|return|previous).*(?:idea|thought)/i });
    await expect(previousIdea).toHaveAttribute("href", new RegExp(`^/ideas/${encodeURIComponent(id)}(?:\\?|$)`));
    await previousIdea.click();
    await expect(page).toHaveURL(url => url.pathname === `/ideas/${encodeURIComponent(id)}`);
    await expect(page.getByText(content, { exact: true })).toBeVisible();

    // Reinterpret through the real Next and daemon boundaries; preserve the selected earlier reply.
    const priorReplies = await daemonCall(running, `/thoughts/${encodeURIComponent(id)}/responses?scope=normal`);
    assert.equal(priorReplies.status, 200); assert.ok(Array.isArray(priorReplies.value));
    const priorReply = priorReplies.value.map(record).find(item => item.text === "No further findings");
    assert.ok(priorReply);
    const priorReplyId = string(priorReply.id);
    await page.goto(`${origin}/ideas/${encodeURIComponent(id)}?responseId=${encodeURIComponent(priorReplyId)}`, { waitUntil: "networkidle" });
    await expect(page.getByText("No further findings", { exact: true })).toBeVisible();
    const ideaUrl = page.url();
    await page.getByRole("button", { name: "More actions" }).click();
    const reinterpretResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/ideas/${encodeURIComponent(id)}/reinterpret` && response.request().method() === "POST");
    await page.getByRole("button", { name: "Reinterpret", exact: true }).click();
    const reinterpreted = await reinterpretResponse;
    assert.equal(reinterpreted.status(), 202);
    const reinterpretControl = record(await reinterpreted.json()), reinterpretRunId = string(record(reinterpretControl.run).id);
    assert.equal(record(reinterpretControl.receipt).subjectId, id);
    await until("Reinterpretation completion", async () => {
      const status = record((await daemonCall(running, `/runs/${encodeURIComponent(reinterpretRunId)}`)).value);
      if (status.status === "failed" || status.status === "interrupted") throw new Error(`Reinterpretation ended ${String(status.status)}`);
      return status.status === "completed";
    }, pulse);
    await settleKnowledge(dbPath, pulse);
    await page.getByRole("region", { name: "Interpretation status" }).getByRole("button", { name: "Check interpretation" }).click();
    await expect(page.getByRole("region", { name: "Surrounding context" }).locator("article").filter({ hasText: "Owned fresh integrated interpretation" })).toHaveCount(1);
    await expect(page.getByText("No further findings", { exact: true })).toBeVisible();
    assert.equal(page.url(), ideaUrl, "reinterpretation must stay on the selected Idea and reply");
    const afterChildren = await daemonCall(running, `/thoughts/${encodeURIComponent(id)}/children?scope=normal`);
    assert.equal(afterChildren.status, 200); assert.ok(Array.isArray(afterChildren.value));
    const children = afterChildren.value.map(record), fresh = children.find(item => item.text === "Owned fresh integrated interpretation");
    assert.ok(fresh); assert.equal(fresh.parentId, id); assert.notEqual(fresh.id, interpretationId);
    assert.deepEqual(children.find(item => item.id === interpretationId), interpretation);
    const runAfter = record((await daemonCall(running, `/runs/${encodeURIComponent(reinterpretRunId)}`)).value);
    assert.deepEqual(runAfter.confirmedThoughtIds, [fresh.id]);
    const afterReplies = await daemonCall(running, `/thoughts/${encodeURIComponent(id)}/responses?scope=normal`);
    assert.equal(afterReplies.status, 200); assert.ok(Array.isArray(afterReplies.value));
    const replies = afterReplies.value.map(record);
    assert.deepEqual(replies.find(item => item.id === priorReplyId), priorReply);
    assert.ok(replies.some(item => item.text === "Owned fresh reinterpretation reply" && Array.isArray(item.thoughtIds) && item.thoughtIds.includes(fresh.id)));

    await page.getByRole("button", { name: "Edit title" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill("Owned edited title");
    await page.getByRole("button", { name: "Save title" }).click();
    await expect(page.getByRole("heading", { name: "Owned edited title" })).toBeVisible();
    await page.getByRole("button", { name: "Edit title" }).click();
    await page.getByRole("button", { name: "Clear title" }).click();
    await expect(page.getByText(/title cleared/i).first()).toBeVisible();
    await settleKnowledge(dbPath, pulse);
    await searchWalkthrough(page, origin, running, dbPath, id, content, viewport.width < 600, pulse);
    await page.goto(`${origin}/ideas/${encodeURIComponent(id)}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /connect to another thought/i }).click();
    const main = page.locator("main");
    await main.getByRole("textbox", { name: /search.*thought/i }).first().fill("integrated interpretation");
    const searchResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search" && new URL(response.url()).searchParams.get("q") === "integrated interpretation");
    await main.getByRole("button", { name: /^search$/i }).first().click();
    const search = await searchResponse;
    assert.equal(search.status(), 200);
    const results = record(await search.json()).results;
    assert.ok(Array.isArray(results));
    const visibleResults = results.map(record).filter(result => result.thoughtId !== id);
    const index = visibleResults.findIndex(result => result.kind === "thought" && result.thoughtId === interpretationId);
    assert.ok(index >= 0, "search must include the intended canonical interpretation");
    const candidate = main.locator("article").filter({ has: page.getByRole("button", { name: "Preview thought" }) }).nth(index);
    await expect(candidate).toBeVisible();
    await expect(candidate).toContainText("Owned integrated interpretation");
    const previewRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/ideas/${encodeURIComponent(interpretationId)}` && response.request().method() === "GET");
    await candidate.getByRole("button", { name: "Preview thought" }).click();
    const preview = await previewRead;
    assert.equal(preview.status(), 200);
    assert.equal(record(record(await preview.json()).thought).id, interpretationId);
    await expect(candidate.getByText("Owned integrated interpretation", { exact: true }).first()).toBeVisible();
    const selectedRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/ideas/${encodeURIComponent(interpretationId)}` && response.request().method() === "GET");
    await candidate.getByRole("button", { name: /choose|select/i }).click();
    const selected = await selectedRead;
    assert.equal(selected.status(), 200);
    assert.equal(record(record(await selected.json()).thought).id, interpretationId);
    await main.getByRole("radio", { name: /related/i }).first().check();
    await main.getByRole("radio", { name: /(?:related|relates).*(?:owned|cobalt)/i }).last().check();
    await main.getByRole("textbox", { name: /(?:rationale|explanation|why)/i }).fill("Owned integrated connection rationale");
    const saved = await captureResponse(page, `/api/ideas/${encodeURIComponent(id)}`, () => main.getByRole("button", { name: /^create connection$/i }).click());
    assert.equal(saved.proposedBy, "user");
    assert.equal(saved.category, "related");
    assert.equal(saved.explanation, "Owned integrated connection rationale");
    assert.deepEqual(new Set([saved.fromId, saved.toId]), new Set([id, interpretationId]));
    const connections = await daemonCall(running, `/thoughts/${encodeURIComponent(id)}/connections?scope=normal`);
    assert.equal(connections.status, 200);
    assert.ok(Array.isArray(connections.value) && connections.value.map(record).some(connection => connection.id === saved.id && connection.proposedBy === "user"));
    await page.goto(`${origin}/ideas/${encodeURIComponent(id)}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: /reject idea/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reject this idea" }).click();
    await expect(page.getByRole("heading", { name: "Idea rejected" })).toBeVisible();
    await page.getByRole("link", { name: "Explore", exact: true }).click();
    await page.getByRole("textbox", { name: /^search thoughts$/i }).fill("cobalt");
    await page.getByRole("button", { name: /^search$/i }).click();
    await expect(page.getByText(/no results/i).first()).toBeVisible();
    await page.goto(`${origin}/ideas/${encodeURIComponent(id)}?scope=show-rejected`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "Restore this idea" }).click();
    await expect(page.getByText(/restored/i).first()).toBeVisible();
    await page.goto(`${origin}/ideas/${encodeURIComponent(id)}`, { waitUntil: "networkidle" });
    await expect(page.getByText(content, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /evolve this idea/i }).click();
    const composer = page.getByRole("textbox", { name: "Your contribution" });
    await composer.fill("Owned integrated contribution");
    const admitted = await captureResponse(page, "/api/evolve/thoughts/", () => page.getByRole("button", { name: "Send", exact: true }).click());
    const run = record(admitted.run), contribution = record(admitted.contribution), runId = string(run.id);
    assert.equal(contribution.parentId, id);
    await expect(page.getByText(runId, { exact: false }).first()).toBeVisible();
    pulse();
    await page.getByRole("link", { name: "Explore", exact: true }).click();
    await expect(page).toHaveURL(/\/explore/); await page.goBack();
    await expect(page.getByText(runId, { exact: false }).first()).toBeVisible();
    const evolveCheck = page.waitForRequest(request => new URL(request.url()).pathname === `/api/evolve/runs/${runId}` && request.method() === "GET");
    await page.getByRole("button", { name: "Check this run" }).click();
    await evolveCheck;
    fake.release();
    await until("Evolve completion", async () => record((await daemonCall(running, `/runs/${runId}`)).value).status === "completed", pulse);
    await page.getByRole("button", { name: "Check this run" }).click();
    await expect(page.getByText("Owned integrated reply")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Owned integrated development" })).toBeVisible();
    await settleKnowledge(dbPath, pulse);
    const completedEvolve = record((await daemonCall(running, `/runs/${runId}`)).value);
    assert.ok(Array.isArray(completedEvolve.confirmedThoughtIds));
    assert.equal(completedEvolve.confirmedThoughtIds.length, 1);
    const developmentId = string(completedEvolve.confirmedThoughtIds[0]);
    const followups = dbRows(dbPath, "SELECT id, kind, status, weave_subject_id FROM runs WHERE kind = 'weave'")
      .map(record).filter(row => row.weave_subject_id === developmentId);
    assert.equal(followups.length, 1, "the confirmed development must have its own weave run");
    const followupId = string(followups[0]?.id);
    const followup = record((await daemonCall(running, `/runs/${encodeURIComponent(followupId)}`)).value);
    assert.equal(followup.id, followupId);
    assert.equal(followup.kind, "weave");
    assert.equal(followup.status, "completed", `weave for confirmed development ${developmentId} must complete`);
    const beforeExport = knowledge(dbPath);
    await page.getByRole("banner").getByRole("link", { name: /(?:back|return).*idea/i }).click();
    await expect(page).toHaveURL(url => url.pathname === `/ideas/${encodeURIComponent(id)}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("link", { name: /export/i }).click();
    await expect(page.getByText(content, { exact: true })).toBeVisible();
    const simpleResponse = page.waitForResponse(response => response.url().endsWith("/api/export/simple") && response.request().method() === "POST" && response.status() === 200);
    await page.getByRole("button", { name: /create simple export/i }).click();
    const simpleReceived = Buffer.from(await (await simpleResponse).body());
    const simpleRegion = page.getByRole("region", { name: "Simple Markdown preview" });
    await expect(simpleRegion).toContainText(content);
    const simpleDownload = page.waitForEvent("download"); await simpleRegion.getByRole("button", { name: /download markdown/i }).click();
    const simpleFile = await simpleDownload; assert.equal(simpleFile.suggestedFilename(), "thoughtloom-simple.md");
    const simpleDownloaded = await bytes(simpleFile); assert.deepEqual(simpleDownloaded, simpleReceived);
    const simpleText = simpleDownloaded.toString("utf8"); assert.ok(simpleText.includes(id) && simpleText.includes(content));
    await page.getByRole("textbox", { name: "Request" }).fill("Report on cobalt thinking");
    await page.getByRole("combobox", { name: "Effort" }).selectOption("quick");
    const reportRequest = page.waitForRequest(request => request.url().endsWith("/api/export/agentic") && request.method() === "POST");
    const reportAdmission = await captureResponse(page, "/api/export/agentic", () => page.getByRole("button", { name: "Create report" }).click());
    assert.deepEqual((await reportRequest).postDataJSON(), { request: "Report on cobalt thinking", effort: "quick" });
    const reportId = string(record(reportAdmission.run).id);
    await expect(page.getByText(reportId, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Explore", exact: true }).click(); await expect(page).toHaveURL(/\/explore/); await page.goBack();
    await expect(page.getByText(reportId, { exact: true })).toBeVisible();
    const reportCheck = page.waitForRequest(request => new URL(request.url()).pathname === `/api/export/runs/${reportId}` && request.method() === "GET");
    await page.getByRole("button", { name: "Check this run" }).click();
    await reportCheck;
    await until("Agentic report completion", async () => record((await daemonCall(running, `/runs/${reportId}`)).value).status === "completed", pulse);
    await page.getByRole("button", { name: "Check this run" }).click();
    await expect(page.getByRole("heading", { name: "Report ready" })).toBeVisible();
    await expect(page.getByText("Evidence from the captured thought.")).toBeVisible();
    const reportDownload = page.waitForEvent("download"); await page.getByRole("region", { name: "Report progress" }).getByRole("button", { name: "Download Markdown" }).click();
    const reportFile = await reportDownload; assert.equal(reportFile.suggestedFilename(), "thoughtloom-report.md");
    const reportDownloaded = await bytes(reportFile);
    const canonical = await fetch(new URL(`/exports/agentic/${reportId}`, running.url), { headers: { authorization: `Bearer ${user}` }, signal: AbortSignal.timeout(3000) });
    assert.equal(canonical.status, 200); assert.deepEqual(reportDownloaded, Buffer.from(await canonical.arrayBuffer()));
    const reportText = reportDownloaded.toString("utf8"); assert.ok(reportText.includes(id) && reportText.includes("Owned integrated report"));
    await settleKnowledge(dbPath, pulse);
    assert.deepEqual(knowledge(dbPath), beforeExport, "exports must not mutate knowledge tables");

    // Exercise the real browser → Next → owned daemon import boundary.
    const importedText = `Indigo imported shared thinking ${viewport.width}`;
    const request = async (path: string, init: RequestInit = {}) => fetch(new URL(path, running.url), {
      ...init, headers: { authorization: `Bearer ${user}`, ...init.headers }, signal: AbortSignal.timeout(3000),
    });
    await page.goto(`${origin}/capture`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: /^import$/i }).or(page.getByRole("button", { name: /^import$/i })).click();
    await page.getByRole("button", { name: /^Markdown\b/i }).click();
    await expect(page.getByRole("heading", { name: "Import Markdown" })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: "owned.md", mimeType: "text/markdown", buffer: Buffer.from(importedText) });
    const batchReceived = page.waitForResponse(response => new URL(response.url()).pathname === "/api/imports/markdown" && response.request().method() === "POST", { timeout: 10000 });
    const fileReceived = page.waitForResponse(response => /^\/api\/imports\/markdown\/[^/]+\/files$/.test(new URL(response.url()).pathname) && response.request().method() === "POST", { timeout: 10000 });
    const sealed = page.waitForResponse(response => /^\/api\/imports\/markdown\/[^/]+\/seal$/.test(new URL(response.url()).pathname) && response.request().method() === "POST", { timeout: 10000 });
    await page.getByRole("button", { name: /^import 1 file$/i }).click();
    const batchResponse = await batchReceived;
    assert.equal(batchResponse.status(), 201);
    const batchId = string(record(record(await batchResponse.json()).import).id);
    const upload = await fileReceived;
    assert.equal(upload.status(), 202);
    const fileId = string(record(record(await upload.json()).file).id);
    assert.equal((await sealed).status(), 200);
    await expect(page).toHaveURL(new RegExp(`/import\\?batchId=${batchId}`));
    let imported: Record<string, unknown> = {};
    await until("Markdown import", async () => {
      const result = await daemonCall(running, `/imports/markdown/${batchId}/files/${fileId}`);
      assert.equal(result.status, 200); imported = record(record(result.value).file);
      if (imported.state === "failed" || imported.state === "interrupted") throw new Error(`Import failed: ${JSON.stringify(imported)}`);
      return imported.state === "imported";
    }, pulse);
    assert.deepEqual(imported.segmentation, { method: "ai", reason: null }); assert.equal(imported.thoughtCount, 1);
    await settleKnowledge(dbPath, pulse);
    await page.getByRole("button", { name: "Check report" }).click();
    const importedRow = page.locator("li").filter({ hasText: "owned.md" });
    await expect(importedRow.getByText("Imported", { exact: true })).toBeVisible();
    await importedRow.getByRole("button", { name: "Inspect source" }).click();
    const inspection = page.getByRole("dialog", { name: "Inspect original" });
    await expect(inspection.getByText(importedText, { exact: true })).toBeVisible();
    const documentId = string(imported.documentId);
    const parts = record((await daemonCall(running, `/import-sources/${documentId}/parts?scope=history`)).value).items;
    assert.ok(Array.isArray(parts)); const thoughtParts = parts.map(record).filter(part => part.kind === "thought");
    assert.equal(thoughtParts.length, 1); const importedId = string(thoughtParts[0]?.thoughtId);
    const importedWeaves = dbRows(dbPath, "SELECT kind, status, weave_subject_id FROM runs WHERE kind = 'weave'")
      .map(record).filter(row => row.weave_subject_id === importedId);
    assert.equal(importedWeaves.length, 1); assert.equal(importedWeaves[0]?.status, "completed");
    const importedThought = record((await daemonCall(running, `/thoughts/${importedId}?scope=normal`)).value);
    assert.equal(importedThought.author, "source"); assert.equal(importedThought.kind, "imported-original");
    assert.equal(importedThought.text, importedText); assert.equal(importedThought.parentId, null); assert.deepEqual(importedThought.sourceIds, []);
    await expect(inspection.getByRole("link", { name: "Open idea" })).toHaveAttribute("href", `/ideas/${encodeURIComponent(importedId)}`);
    await inspection.getByRole("link", { name: "Open idea" }).click();
    await expect(page).toHaveURL(url => url.pathname === `/ideas/${encodeURIComponent(importedId)}`);
    await expect(page.getByText(importedText, { exact: true }).first()).toBeVisible();
    const raw = await request(`/import-sources/${documentId}/raw?scope=history`);
    assert.equal(raw.status, 200); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), Buffer.from(importedText));
    const denied = await fetch(new URL(`/import-sources/${documentId}/raw?scope=history`, running.url), { headers: { authorization: `Bearer ${ai}` }, signal: AbortSignal.timeout(3000) });
    assert.equal(denied.status, 403);
    const importPrompts = [...fake.prompts.values()].map(history => record(JSON.parse(history[0]))).filter(value => value.kind === "import-job");
    assert.equal(importPrompts.length, 1); assert.equal(importPrompts[0]?.document, importedText);
    await page.goto(`${origin}/explore?q=indigo&author=source&kind=imported-original`, { waitUntil: "networkidle" });
    const importedCard = page.locator("article").filter({ hasText: importedText.trim() });
    await expect(importedCard).toBeVisible(); await expect(importedCard.getByText("Imported source", { exact: true }).first()).toBeVisible();
    await importedCard.locator(`a[href^="/ideas/${encodeURIComponent(importedId)}"]`).first().click();
    await expect(page.getByText(importedText.trim(), { exact: true }).first()).toBeVisible();
    await expect(page.locator("main").getByText("Imported source", { exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: /evolve this idea/i }).click();
    await expect(page.locator("main").getByText("Imported source", { exact: true }).first()).toBeVisible();
    await page.goto(`${origin}/export?thoughtId=${encodeURIComponent(importedId)}`, { waitUntil: "networkidle" });
    await expect(page.getByText("Imported source · imported original", { exact: true })).toBeVisible();
    const importedBeforeExport = knowledge(dbPath);
    await page.getByRole("button", { name: /create simple export/i }).click();
    await expect(page.getByRole("region", { name: "Simple Markdown preview" })).toContainText(importedText);
    fake.sourceId = importedId;
    await page.getByRole("textbox", { name: "Request" }).fill("Report on imported thinking");
    const importedReport = await captureResponse(page, "/api/export/agentic", () => page.getByRole("button", { name: "Create report" }).click());
    const importedReportId = string(record(importedReport.run).id);
    await until("Imported source report", async () => record((await daemonCall(running, `/runs/${importedReportId}`)).value).status === "completed", pulse);
    await page.getByRole("button", { name: "Check this run" }).click();
    await expect(page.getByRole("heading", { name: "Report ready" })).toBeVisible();
    await expect(page.locator(`a[href="/ideas/${encodeURIComponent(importedId)}"]`).last()).toBeVisible();
    const importedArtifact = await request(`/exports/agentic/${importedReportId}`);
    assert.equal(importedArtifact.status, 200);
    const importedReportText = await importedArtifact.text();
    assert.ok(importedReportText.includes(importedId) && importedReportText.includes("thought author: source; kind: imported-original"));
    await settleKnowledge(dbPath, pulse);
    assert.deepEqual(knowledge(dbPath), importedBeforeExport, "imported source exports must not mutate knowledge");

    // One test-owned PNG crosses the browser, Next, real format validator and private store.
    const imageBytes = Buffer.from(independentPng()), imageName = "owned-shared-image.png";
    const imageClarification = `  Compare cobalt regions ${viewport.width}.\nKeep this exact wording.  `;
    await page.goto(`${origin}/capture`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByRole("button", { name: /^Image or PDF\b/i }).click();
    await expect(page.getByRole("heading", { name: "Import image or PDF" })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({name:imageName,mimeType:"image/png",buffer:imageBytes});
    await page.getByRole("textbox", { name: /^Clarification/i }).fill(imageClarification);
    const imageUpload = page.waitForResponse(response => new URL(response.url()).pathname === "/api/imports/media" && response.request().method() === "POST", {timeout:10000});
    await page.getByRole("button", { name: "Import file", exact: true }).click();
    const imageResponse = await imageUpload;
    assert.equal(imageResponse.status(), 202);
    const imageReceipt = record(await imageResponse.json()), imageThought = record(imageReceipt.thought), imageSource = record(imageThought.mediaSource);
    const imageThoughtId = string(imageThought.id), imageSourceId = string(imageSource.id), imageRunId = string(record(imageReceipt.run).id);
    assert.notEqual(imageThoughtId,imageSourceId);
    assert.equal(imageThought.kind,"media-original"); assert.equal(imageThought.author,"source"); assert.equal(imageThought.text,null);
    assert.equal(imageThought.title,null); assert.equal(imageThought.parentId,null); assert.deepEqual(imageThought.sourceIds,[]);
    assert.equal(imageSource.name,imageName); assert.equal(imageSource.fileAuthorship,"unverified");
    assert.equal(imageSource.clarification,imageClarification); assert.equal(imageSource.clarificationAuthor,"user");
    assert.equal(imageSource.byteLength,imageBytes.length); assert.equal(imageSource.mimeType,"image/png");
    await expect(page.getByRole("heading", { name: "Original saved" })).toBeVisible();
    await until("Media interpretation", async () => {
      const status = record((await daemonCall(running,`/runs/${encodeURIComponent(imageRunId)}`)).value);
      if (status.status === "failed" || status.status === "interrupted") throw new Error(`Media weave ended ${String(status.status)}`);
      return status.status === "completed";
    },pulse);
    await settleKnowledge(dbPath,pulse);
    const imageChildren = await daemonCall(running,`/thoughts/${encodeURIComponent(imageThoughtId)}/children?scope=normal`);
    assert.equal(imageChildren.status,200); assert.ok(Array.isArray(imageChildren.value));
    const imageInterpretation = imageChildren.value.map(record).find(child => child.kind === "ai-interpretation");
    assert.ok(imageInterpretation); assert.equal(imageInterpretation.parentId,imageThoughtId);
    assert.equal(imageInterpretation.text,"Owned integrated interpretation");
    const canonicalMedia = record((await daemonCall(running,`/thoughts/${encodeURIComponent(imageThoughtId)}?scope=normal`)).value);
    assert.equal(canonicalMedia.text,null); assert.equal(canonicalMedia.title,null);
    assert.equal(record(canonicalMedia.mediaSource).clarification,imageClarification);
    fake.sourceId = imageThoughtId;

    await page.goto(`${origin}/explore?q=cobalt&author=source&kind=media-original`, {waitUntil:"networkidle"});
    const imageCard = page.locator("article").filter({has:page.locator(`a[href^="/ideas/${encodeURIComponent(imageThoughtId)}"]`)});
    await expect(imageCard).toBeVisible(); await expect(imageCard).toContainText(imageName);
    await imageCard.locator(`a[href^="/ideas/${encodeURIComponent(imageThoughtId)}"]`).first().click();
    await expect(page.getByRole("heading",{level:1,name:imageName})).toBeVisible();
    await expect(page.getByText(imageClarification,{exact:true})).toBeVisible();
    await expect(page.getByText(/original authorship unverified/i).first()).toBeVisible();
    await expect(page.locator(`a[href^="/ideas/${encodeURIComponent(string(imageInterpretation.id))}"]`).first()).toBeVisible();
    const imageDownload = page.waitForEvent("download");
    await page.getByRole("button",{name:"Download original",exact:true}).click();
    assert.deepEqual(await bytes(await imageDownload),imageBytes);

    await page.getByRole("link",{name:/evolve this idea/i}).click();
    await expect(page.getByRole("textbox",{name:"Your contribution"})).toBeVisible();
    if (viewport.width < 500) await page.getByRole("button",{name:/^Starting thought/}).click();
    const imageRail = page.locator("#evolve-starting-context");
    await expect(imageRail.getByRole("heading",{name:imageName,exact:true})).toBeVisible();
    await expect(imageRail.getByText(/PNG image.*original authorship unverified/i)).toBeVisible();
    const railClarification = imageRail.getByText(imageClarification,{exact:true});
    await expect(railClarification).toBeVisible();
    await expect(railClarification).toHaveJSProperty("textContent",imageClarification);
    await searchWalkthrough(page,origin,running,dbPath,imageThoughtId,"cobalt",viewport.width < 600,pulse);

    await page.goto(`${origin}/export?thoughtId=${encodeURIComponent(imageThoughtId)}`,{waitUntil:"networkidle"});
    await expect(page.getByText(imageName,{exact:true}).first()).toBeVisible();
    const mediaBeforeExport = knowledge(dbPath);
    await page.getByRole("button",{name:/create simple export/i}).click();
    const mediaSimple = page.getByRole("region",{name:"Simple Markdown preview"});
    await expect(mediaSimple).toContainText(imageName); await expect(mediaSimple).toContainText("cobalt");
    await page.getByRole("textbox",{name:"Request"}).fill("Report on the retained cobalt source");
    const mediaReport = await captureResponse(page,"/api/export/agentic",() => page.getByRole("button",{name:"Create report"}).click());
    const mediaReportId = string(record(mediaReport.run).id);
    await until("Media source report",async () => record((await daemonCall(running,`/runs/${mediaReportId}`)).value).status === "completed",pulse);
    await page.getByRole("button",{name:"Check this run"}).click();
    await expect(page.getByRole("heading",{name:"Report ready"})).toBeVisible();
    await expect(page.locator(`a[href="/ideas/${encodeURIComponent(imageThoughtId)}"]`).last()).toBeVisible();
    const mediaArtifact = await request(`/exports/agentic/${mediaReportId}`);
    assert.equal(mediaArtifact.status,200);
    const mediaReportText = await mediaArtifact.text();
    assert.ok(mediaReportText.includes(imageThoughtId) && mediaReportText.includes("thought author: source; kind: media-original."));
    assert.ok(mediaReportText.includes("Access to the descriptor or clarification does not imply binary file access."));
    await settleKnowledge(dbPath,pulse);
    assert.deepEqual(knowledge(dbPath),mediaBeforeExport,"media source exports must not mutate knowledge");

    await page.goto(`${origin}/ideas/${encodeURIComponent(imageThoughtId)}`,{waitUntil:"networkidle"});
    await page.getByRole("button",{name:"More actions"}).click();
    await page.getByRole("button",{name:/reject idea/i}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Reject this idea"}).click();
    await expect(page.getByRole("heading",{name:"Idea rejected"})).toBeVisible();
    assert.equal((await request(`/media-sources/${imageSourceId}`)).status,404);
    assert.equal((await request(`/media-sources/${imageSourceId}/raw`)).status,404);
    const deniedMedia = await fetch(new URL(`/media-sources/${imageSourceId}/raw?scope=history`,running.url),
      {headers:{authorization:`Bearer ${ai}`},signal:AbortSignal.timeout(3000)});
    assert.equal(deniedMedia.status,403);
    const deniedThought = await fetch(new URL(`/thoughts/${imageThoughtId}`,running.url),
      {headers:{authorization:`Bearer ${ai}`},signal:AbortSignal.timeout(3000)});
    assert.equal(deniedThought.status,404);
    await page.goto(`${origin}/explore?q=cobalt&author=source&kind=media-original`,{waitUntil:"networkidle"});
    await expect(page.locator(`a[href^="/ideas/${encodeURIComponent(imageThoughtId)}"]`)).toHaveCount(0);
    await page.goto(`${origin}/ideas/${encodeURIComponent(imageThoughtId)}?scope=history`,{waitUntil:"networkidle"});
    await expect(page.getByText(/rejected/i).first()).toBeVisible();
    const historyDownload = page.waitForEvent("download");
    await page.getByRole("button",{name:"Download original",exact:true}).click();
    assert.deepEqual(await bytes(await historyDownload),imageBytes);
    assert.deepEqual(leaked, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log(`Shared-record integration passed: ${viewport.width}x${viewport.height}`);
  } finally {
    fake.release();
    for (const cleanup of [() => daemon?.stop(), () => browser?.close(), () => server && stopProcess(server)]) {
      try { await bounded(Promise.resolve(cleanup()), "Integration cleanup", 10000); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Owned resource cleanup failed");
  }
}

await checkFixtureInstructions();
await walkthrough({ width: 1440, height: 900 });
await walkthrough({ width: 390, height: 844 });
