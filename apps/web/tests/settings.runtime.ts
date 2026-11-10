import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { expect, type Page } from "@playwright/test";

// Test-owned DTO and backend double: no production Settings import is required for RED.
const fields = ["weaver", "evolve", "search", "export"] as const;
type Field = typeof fields[number];
type Instructions = Record<Field, string> & { revision: number };
type Mode = "ready" | "read-failure" | "malformed-read" | "write-failure" | "hold-save" | "hold-failure" | "malformed-save";
type Attempt = { method: string | undefined; path: string | undefined; authorization: string | undefined; cookie: string | undefined; untrusted: string | undefined; body: string };
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;
type FixtureRequest = Pick<IncomingMessage, "method" | "url" | "headers"> & AsyncIterable<Uint8Array>;
interface FixtureResponse {
  writeHead(status: number, headers: Record<string, string>): { end(body?: string): void };
}
const api = "/api/settings/agent-instructions";
const empty = (): Instructions => ({ weaver: "", evolve: "", search: "", export: "", revision: 0 });
const privateDiagnostic = "owned-private-settings-upstream-diagnostic";

export function settingsDaemon(token: string) {
  let saved = empty(), mode: Mode = "ready", release: (() => void) | undefined;
  const attempts: Attempt[] = [];
  const json = (response: FixtureResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" }).end(JSON.stringify(value));
  };
  const hold = () => new Promise<void>(resolve => { release = resolve; });
  return {
    attempts,
    snapshot: () => ({ ...saved }),
    reset(value = empty()) { assert.equal(release, undefined, "release held work before reset"); saved = { ...value }; mode = "ready"; attempts.length = 0; },
    setMode(next: Mode) { mode = next; },
    release() { release?.(); release = undefined; },
    async handler(request: FixtureRequest, response: FixtureResponse) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      attempts.push({ method: request.method, path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie, untrusted: request.headers["x-owned-untrusted"] as string | undefined, body });
      if (request.headers.authorization !== `Bearer ${token}`) { json(response, 401, { error: "Unauthorized" }); return; }
      if (request.url !== "/settings/agent-instructions") { json(response, 400, { error: "Bad request" }); return; }
      if (request.method === "GET") {
        if (mode === "read-failure") { json(response, 500, { error: `${token} ${privateDiagnostic}` }); return; }
        json(response, 200, mode === "malformed-read" ? { weaver: saved.weaver, revision: saved.revision } : saved);
        return;
      }
      if (request.method !== "PUT") { json(response, 405, { error: "Method not allowed" }); return; }
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) { json(response, 415, { error: "Unsupported media type" }); return; }
      let value: Instructions;
      try {
        const input: unknown = JSON.parse(body);
        assert.ok(input !== null && typeof input === "object" && !Array.isArray(input));
        const data = input as Record<string, unknown>;
        assert.deepEqual(Object.keys(data).sort(), [...fields, "revision"].sort());
        for (const field of fields) {
          assert.equal(typeof data[field], "string");
          assert.ok(Buffer.byteLength(data[field] as string, "utf8") <= 16384);
        }
        assert.ok(typeof data.revision === "number" && Number.isSafeInteger(data.revision) && data.revision >= 0);
        value = data as Instructions;
      } catch { json(response, 400, { error: "Bad request" }); return; }
      const currentMode = mode;
      if (currentMode === "hold-failure") await hold();
      if (currentMode === "write-failure" || currentMode === "hold-failure") { json(response, 500, { error: `${token} ${privateDiagnostic}` }); return; }
      if (value.revision !== saved.revision) { json(response, 409, { error: "Conflict" }); return; }
      saved = { ...value, revision: saved.revision + 1 };
      const receipt = { ...saved };
      if (currentMode === "hold-save") await hold();
      json(response, 200, currentMode === "malformed-save" ? { revision: receipt.revision } : receipt);
    },
  };
}

type Fixture = ReturnType<typeof settingsDaemon>;
const writes = (daemon: Fixture) => daemon.attempts.filter(attempt => attempt.method === "PUT");
const controls = (page: Page) => ({
  weaver: page.getByRole("textbox", { name: /^Weaver(?:\s*\(optional\))?$/i }),
  evolve: page.getByRole("textbox", { name: /^Evolve(?:\s*\(optional\))?$/i }),
  search: page.getByRole("textbox", { name: /^Agentic Search(?:\s*\(optional\))?$/i }),
  export: page.getByRole("textbox", { name: /^Agentic Export(?:\s*\(optional\))?$/i }),
});
const saveButton = (page: Page) => page.getByRole("button", { name: /^(?:Save changes|Saving(?:…|\.\.\.)?)$/i });
const settings = (page: Page) => page.getByRole("main").getByRole("region", { name: "Settings" });
const savedNotice = (page: Page) => settings(page).getByRole("status").filter({ hasText: /(?:changes|instructions) saved|saved (?:changes|instructions)/i });
const saveError = (page: Page) => settings(page).getByRole("alert").filter({ hasText: /not saved|could not save|couldn.t save|unable to save|conflict|changed elsewhere|another (?:browser|user|session)/i });

async function valuesMatch(page: Page, value: Omit<Instructions, "revision">): Promise<void> {
  const inputs = controls(page);
  for (const field of fields) await expect(inputs[field]).toHaveValue(value[field]);
}

export async function checkSettingsRoutes({ origin, host, probe, daemon, token }: { origin: string; host: string; probe: Probe; daemon: Fixture; token: string }): Promise<void> {
  daemon.reset();
  const read = await fetch(`${origin}${api}`);
  assert.equal(read.status, 200, "Settings GET must reach the fixed Next server boundary, not a missing route");
  assert.match(read.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await read.json(), empty());
  const value = { weaver: "\uFEFF  café 雪\r\nnext line  ", evolve: "\t  ", search: "", export: "🌱", revision: 0 };
  const send = (input: unknown) => fetch(`${origin}${api}`, { method: "PUT", headers: { origin, "content-type": "application/json", authorization: "Bearer owned-browser-token", cookie: "owned-browser-cookie", "x-owned-untrusted": "owned-browser-header" }, body: JSON.stringify(input) });
  const written = await send(value);
  assert.equal(written.status, 200);
  assert.match(written.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await written.json(), { ...value, revision: 1 });
  const call = writes(daemon).at(-1);
  assert.ok(call);
  assert.equal(call.path, "/settings/agent-instructions");
  assert.equal(call.authorization, `Bearer ${token}`);
  assert.equal(call.cookie, undefined);
  assert.equal(call.untrusted, undefined);
  assert.deepEqual(JSON.parse(call.body), value);
  const conflict = await send({ ...value, weaver: "stale edit" });
  assert.equal(conflict.status, 409, "CAS conflict must not become success or generic write retry");
  assert.match(conflict.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(daemon.snapshot(), { ...value, revision: 1 });
  const bounded = { weaver: "a".repeat(16384), evolve: "🌱".repeat(4096), search: "", export: "", revision: 1 };
  const accepted = await send(bounded);
  assert.equal(accepted.status, 200, "limits count decoded UTF-8, not serialized JSON or UTF-16 units");
  assert.deepEqual(await accepted.json(), { ...bounded, revision: 2 });
  for (const invalid of [{ ...bounded, weaver: "a".repeat(16385), revision: 2 }, { ...bounded, evolve: "🌱".repeat(4096) + "a", revision: 2 }, { weaver: "missing other fields", revision: 2 }, { ...bounded, revision: 2, model: "not-a-setting" }]) {
    const rejected = await send(invalid);
    assert.equal(rejected.status, 400);
    assert.match(rejected.headers.get("cache-control") ?? "", /no-store/i);
    assert.deepEqual(daemon.snapshot(), { ...bounded, revision: 2 }, "invalid writes must not change any field");
  }
  const cleared = await send({ ...empty(), revision: 2 });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { ...empty(), revision: 3 });
  const reread = await fetch(`${origin}${api}`);
  assert.deepEqual(await reread.json(), { ...empty(), revision: 3 });
  const before = daemon.attempts.length;
  const body = JSON.stringify({ ...empty(), revision: 3 });
  const content = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
  assert.ok((await probe("GET", api, "")).status >= 400);
  assert.equal((await probe("GET", api, `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
  assert.equal((await probe("PUT", api, `Host: ${host}\r\n${content}`, body)).status, 403);
  assert.equal((await probe("PUT", api, `Host: ${host}\r\nOrigin: https://foreign.invalid\r\n${content}`, body)).status, 403);
  assert.equal((await probe("PUT", api, `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\nOrigin: ${origin}\r\n${content}`, body)).status, 403);
  assert.equal(daemon.attempts.length, before, "untrusted reads/writes must not reach the credentialed transport");
  for (const mode of ["read-failure", "malformed-read"] as const) {
    daemon.setMode(mode);
    const failed = await fetch(`${origin}${api}`);
    assert.equal(failed.status, 502);
    assert.match(failed.headers.get("cache-control") ?? "", /no-store/i);
    const text = await failed.text();
    assert.ok(!text.includes(token) && !text.includes(privateDiagnostic), "sanitize upstream diagnostics");
  }
  daemon.setMode("write-failure");
  const failed = await send({ ...empty(), revision: 3 });
  assert.equal(failed.status, 502);
  assert.match(failed.headers.get("cache-control") ?? "", /no-store/i);
  const errorText = await failed.text();
  assert.ok(!errorText.includes(token) && !errorText.includes(privateDiagnostic));
  daemon.setMode("ready");
}

async function checkSettingsExactSave(page: Page, daemon: Fixture, origin: string): Promise<void> {
  daemon.reset();
  await page.goto(`${origin}/explore`, { waitUntil: "networkidle" });
  const link = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Settings", exact: true });
  await expect(link).toHaveAttribute("href", "/settings");
  await link.click();
  await page.waitForURL("**/settings");
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /^Save changes$/i })).toHaveCount(1);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await valuesMatch(page, empty());
  await expect(settings(page).getByText(/next (?:agent )?turn/i)).toBeVisible();
  const value = { weaver: "  café 雪\nsecond line  ", evolve: "\t  ", search: "Find tensions, not just shared words.", export: "🌱\n" };
  const inputs = controls(page);
  for (const field of fields) await inputs[field].fill(value[field]);
  await saveButton(page).click();
  await expect(savedNotice(page)).toBeVisible();
  assert.deepEqual(daemon.snapshot(), { ...value, revision: 1 });
  assert.deepEqual(JSON.parse(writes(daemon).at(-1)?.body ?? "null"), { ...value, revision: 0 });
  await page.reload({ waitUntil: "networkidle" });
  await valuesMatch(page, value);
  const fresh = await page.context().browser()!.newContext({ viewport: page.viewportSize() ?? undefined });
  try {
    const other = await fresh.newPage();
    await other.goto(`${origin}/settings`, { waitUntil: "networkidle" });
    await valuesMatch(other, value);
    await controls(other).export.fill("");
    await saveButton(other).click();
    await expect(savedNotice(other)).toBeVisible();
  } finally { await fresh.close(); }
  await page.reload({ waitUntil: "networkidle" });
  await valuesMatch(page, { ...value, export: "" });
  assert.deepEqual(daemon.snapshot(), { ...value, export: "", revision: 2 });
  for (const field of fields) {
    await expect(inputs[field]).toHaveJSProperty("required", false);
    await inputs[field].fill("");
  }
  await saveButton(page).click();
  await expect(savedNotice(page)).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await valuesMatch(page, empty());
  assert.deepEqual(daemon.snapshot(), { ...empty(), revision: 3 }, "clearing every field is a valid save, not an empty-form error");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Settings must not overflow horizontally");
}

async function checkUntouchedExactGuidance(page: Page, daemon: Fixture, origin: string): Promise<void> {
  const original = { ...empty(), weaver: "\uFEFF  existing guidance\r\nwith CRLF  ", revision: 3 };
  daemon.reset(original);
  await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
  // Native textarea values normalize line endings for display. Saving another
  // field must still retain the untouched server string, not reread the DOM.
  await expect(controls(page).weaver).toHaveValue(original.weaver.replace(/\r\n/g, "\n"));
  await controls(page).search.fill("only this field changed");
  await saveButton(page).click();
  await expect(savedNotice(page)).toBeVisible();
  assert.deepEqual(JSON.parse(writes(daemon).at(-1)?.body ?? "null"), { ...original, search: "only this field changed" });
  assert.deepEqual(daemon.snapshot(), { ...original, search: "only this field changed", revision: 4 });
}

async function checkSettingsPendingEdits(page: Page, daemon: Fixture, origin: string): Promise<void> {
  for (const mode of ["hold-save", "hold-failure"] as const) {
    daemon.reset({ weaver: "saved before editing", evolve: "", search: "", export: "", revision: 4 });
    await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
    const inputs = controls(page);
    await expect(inputs.weaver).toHaveValue("saved before editing");
    await inputs.weaver.fill("submitted snapshot");
    const before = writes(daemon).length;
    daemon.setMode(mode);
    try {
      await saveButton(page).click();
      await expect.poll(() => writes(daemon).length).toBe(before + 1);
      await expect(saveButton(page)).toBeDisabled();
      await expect(settings(page).getByRole("status").filter({ hasText: /saving/i })).toBeVisible();
      await inputs.weaver.fill("newer unsaved edit");
      await inputs.evolve.fill("edited while saving");
      await page.waitForTimeout(100);
      assert.equal(writes(daemon).length, before + 1, "pending edits must not auto-save or duplicate the write");
      assert.deepEqual(JSON.parse(writes(daemon).at(-1)?.body ?? "null"), { weaver: "submitted snapshot", evolve: "", search: "", export: "", revision: 4 });
    } finally { daemon.release(); }
    if (mode === "hold-save") {
      await expect(saveButton(page)).toBeEnabled();
      // A successful old snapshot must not be presented as all current edits saved.
      await expect(settings(page).getByRole("status").filter({ hasText: /unsaved|not (?:yet )?saved/i })).toBeVisible();
    } else await expect(saveError(page)).toBeVisible();
    await valuesMatch(page, { weaver: "newer unsaved edit", evolve: "edited while saving", search: "", export: "" });
    await page.waitForTimeout(150);
    assert.equal(writes(daemon).length, before + 1, "completion must not replay or auto-save the newer draft");
    daemon.setMode("ready");
    await saveButton(page).click();
    await expect(savedNotice(page)).toBeVisible();
    assert.deepEqual(JSON.parse(writes(daemon).at(-1)?.body ?? "null"), { weaver: "newer unsaved edit", evolve: "edited while saving", search: "", export: "", revision: mode === "hold-save" ? 5 : 4 });
    await page.reload({ waitUntil: "networkidle" });
    await valuesMatch(page, { weaver: "newer unsaved edit", evolve: "edited while saving", search: "", export: "" });
  }
}

async function checkSettingsConflict(page: Page, daemon: Fixture, origin: string): Promise<void> {
  daemon.reset();
  await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
  await valuesMatch(page, empty());
  const draft = { weaver: "local dirty edit", evolve: "local evolve", search: "local search", export: "local export" };
  for (const field of fields) await controls(page)[field].fill(draft[field]);
  const competing = { ...empty(), weaver: "saved from another browser" };
  const remote = await page.request.put(`${origin}${api}`, { headers: { origin }, data: competing });
  assert.equal(remote.status(), 200);
  const before = writes(daemon).length;
  await saveButton(page).click();
  const alert = saveError(page);
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/conflict|changed elsewhere|another (?:browser|user|session)/i);
  await valuesMatch(page, draft);
  await expect(savedNotice(page)).toHaveCount(0);
  await page.waitForTimeout(150);
  assert.equal(writes(daemon).length, before + 1, "a conflict must not retry with a newer revision automatically");
  assert.deepEqual(daemon.snapshot(), { ...competing, revision: 1 });
  await page.reload({ waitUntil: "networkidle" });
  await valuesMatch(page, competing);
}

async function checkSettingsErrors(page: Page, daemon: Fixture, origin: string): Promise<void> {
  for (const mode of ["read-failure", "malformed-read"] as const) {
    daemon.reset({ weaver: "existing global guidance", evolve: "", search: "", export: "", revision: 8 });
    daemon.setMode(mode);
    await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
    await expect(settings(page).getByRole("alert").filter({ hasText: /instructions could not be loaded/i })).toBeVisible();
    await expect(saveButton(page)).toBeDisabled();
    assert.equal(writes(daemon).length, 0, "failed reads must not manufacture and save empty defaults");
    assert.ok(!(await page.content()).includes(privateDiagnostic));
    daemon.setMode("ready");
    await page.reload({ waitUntil: "networkidle" });
    await expect(controls(page).weaver).toHaveValue("existing global guidance");
  }
  for (const mode of ["write-failure", "malformed-save"] as const) {
    daemon.reset();
    await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
    await valuesMatch(page, empty());
    await controls(page).weaver.fill("keep this exact draft  ");
    daemon.setMode(mode);
    await saveButton(page).click();
    await expect(saveError(page)).toBeVisible();
    await expect(controls(page).weaver).toHaveValue("keep this exact draft  ");
    await expect(savedNotice(page)).toHaveCount(0);
    await page.waitForTimeout(150);
    assert.equal(writes(daemon).length, 1, "failed or malformed receipts must not trigger an automatic replay");
    assert.ok(!(await page.content()).includes(privateDiagnostic));
  }
  daemon.setMode("ready");
}

async function checkSettingsFieldLimit(page: Page, daemon: Fixture, origin: string): Promise<void> {
  daemon.reset();
  await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
  await valuesMatch(page, empty());
  const input = controls(page).weaver;
  const oversized = "🌱".repeat(4096) + "a";
  await input.fill(oversized);
  await saveButton(page).click();
  await expect(input).toHaveValue(oversized);
  await expect(input).toHaveAttribute("aria-invalid", "true");
  const description = await input.getAttribute("aria-describedby");
  assert.ok(description, "oversized-field error must be associated with the field");
  const messages = await input.evaluate((_, ids) => ids.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" "), description);
  assert.match(messages, /16\s*(?:KiB|KB)|16[,.]?384|too (?:long|large)|UTF-?8/i);
  await expect(settings(page).getByRole("alert").filter({ hasText: /16\s*(?:KiB|KB)|16[,.]?384|too (?:long|large)|UTF-?8/i })).toBeVisible();
  assert.deepEqual(daemon.snapshot(), empty());
  await input.fill("🌱".repeat(4096));
  await saveButton(page).click();
  await expect(savedNotice(page)).toBeVisible();
  assert.equal(daemon.snapshot().weaver, "🌱".repeat(4096), "an exact UTF-8-limit field must remain savable");
}

export async function checkSettingsBrowser(page: Page, daemon: Fixture, { origin, daemonOrigin, token }: { origin: string; daemonOrigin: string; token: string }): Promise<void> {
  const leaks: string[] = [];
  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.url().startsWith(daemonOrigin) || request.url().includes(token) || request.headers().authorization) leaks.push("browser exposed daemon configuration");
  };
  const onConsole = (message: import("@playwright/test").ConsoleMessage) => {
    if (message.text().includes(token) || message.text().includes(daemonOrigin)) leaks.push("console exposed daemon configuration");
  };
  page.on("request", onRequest);
  page.on("console", onConsole);
  try {
    await checkSettingsExactSave(page, daemon, origin);
    await checkUntouchedExactGuidance(page, daemon, origin);
    await checkSettingsPendingEdits(page, daemon, origin);
    await checkSettingsConflict(page, daemon, origin);
    await checkSettingsErrors(page, daemon, origin);
    await checkSettingsFieldLimit(page, daemon, origin);
    const html = await page.content();
    assert.ok(!html.includes(token) && !html.includes(daemonOrigin));
    assert.deepEqual(leaks, []);
  } finally {
    daemon.release();
    page.off("request", onRequest);
    page.off("console", onConsole);
  }
}
