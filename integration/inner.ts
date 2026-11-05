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

class FixtureClient implements PublicClient {
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, NativeMessage[]>();
  readonly prompts = new Map<string, string[]>();
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
    if (job.kind === "evolve" && this.holdEvolve) await new Promise<void>(done => { this.releaseHeld = done; });
    const step = history.length;
    const output = job.kind === "export" ? (step === 1
      ? { version: 1, kind: "request", request: { capability: "readThought", arguments: { id: this.sourceId } } }
      : { version: 1, kind: "report", markdown: "# Owned integrated report\n\nEvidence from the captured thought.", sourceThoughtIds: [this.sourceId] })
      : job.kind === "evolve" && step === 1
        ? { version: 1, kind: "request", request: { capability: "development", arguments: { parentId: string(job.contributionId), text: "Owned integrated development", sourceIds: [] } } }
        : job.kind === "weave" && step === 1
          ? { version: 1, kind: "request", request: { capability: "interpretation", arguments: { text: "Owned integrated interpretation", sourceIds: [string(job.subjectId)] } } }
        : job.kind === "weave" && step === 2
          ? { version: 1, kind: "request", request: { capability: "title-fill", arguments: { title: "Owned generated title" } } }
        : { version: 1, kind: "complete", reply: job.kind === "evolve" ? "Owned integrated reply" : "No further findings" };
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
    await page.getByRole("button", { name: "Edit title" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill("Owned edited title");
    await page.getByRole("button", { name: "Save title" }).click();
    await expect(page.getByRole("heading", { name: "Owned edited title" })).toBeVisible();
    await page.getByRole("button", { name: "Edit title" }).click();
    await page.getByRole("button", { name: "Clear title" }).click();
    await expect(page.getByText(/title cleared/i).first()).toBeVisible();
    await settleKnowledge(dbPath, pulse);
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

    // Import admission belongs to this server-side fixture, never the browser.
    const importedText = `Indigo imported shared thinking ${viewport.width}`;
    const request = async (path: string, init: RequestInit = {}) => fetch(new URL(path, running.url), {
      ...init, headers: { authorization: `Bearer ${user}`, ...init.headers }, signal: AbortSignal.timeout(3000),
    });
    const batchResponse = await request("/imports/markdown", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "owned-batch" }, body: "{}" });
    assert.equal(batchResponse.status, 201);
    const batchId = string(record(record(await batchResponse.json()).import).id);
    const form = new FormData(); form.set("metadata", JSON.stringify({ relativePath: "owned.md" }));
    form.set("file", new Blob([importedText], { type: "text/markdown" }), "owned.md");
    const upload = await request(`/imports/markdown/${batchId}/files`, { method: "POST", headers: { "idempotency-key": "owned-file" }, body: form });
    assert.equal(upload.status, 202);
    const fileId = string(record(record(await upload.json()).file).id);
    const seal = await request(`/imports/markdown/${batchId}/seal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(seal.status, 200);
    let imported: Record<string, unknown> = {};
    await until("Markdown import", async () => {
      const result = await daemonCall(running, `/imports/markdown/${batchId}/files/${fileId}`);
      assert.equal(result.status, 200); imported = record(record(result.value).file);
      if (imported.state === "failed" || imported.state === "interrupted") throw new Error(`Import failed: ${JSON.stringify(imported)}`);
      return imported.state === "imported";
    }, pulse);
    assert.deepEqual(imported.segmentation, { method: "ai", reason: null }); assert.equal(imported.thoughtCount, 1);
    await settleKnowledge(dbPath, pulse);
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

await walkthrough({ width: 1440, height: 900 });
await walkthrough({ width: 390, height: 844 });
