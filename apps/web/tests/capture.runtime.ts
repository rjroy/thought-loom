import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";

type Mode = "saved" | "hold" | "denied" | "failure" | "malformed";
type Attempt = { method: string | undefined; path: string | undefined; authorization: string | undefined; body: string };
const receipt = { id: "fixture/idea & 1", text: "Canonical daemon thought", title: "Canonical daemon title" };

export function captureDaemon(token: string) {
  let mode: Mode = "saved";
  let release: (() => void) | undefined;
  const attempts: Attempt[] = [];
  return {
    attempts,
    expectedAuthorization: `Bearer ${token}`,
    setMode(next: Mode) { mode = next; },
    release() { release?.(); release = undefined; },
    async handler(request: IncomingMessage, response: ServerResponse) {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      attempts.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
      const current = mode;
      if (current === "hold") await new Promise<void>(resolve => { release = resolve; });
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      if (current === "denied") { response.writeHead(401).end("private fake rejection"); return; }
      if (current === "failure") { response.writeHead(500).end("private fake failure"); return; }
      if (current === "malformed") { response.writeHead(201, { "content-type": "application/json" }).end("{"); return; }
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(receipt));
    },
  };
}

type Fixture = ReturnType<typeof captureDaemon>;
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;
async function waitAttempts(daemon: Fixture, count: number): Promise<void> {
  await expect.poll(() => daemon.attempts.length, { timeout: 5000 }).toBe(count);
}

export async function checkCaptureRoute({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  const body = JSON.stringify({ text: "route fixture words", title: null });
  const content = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
  const start = daemon.attempts.length;
  assert.ok((await probe("POST", "/api/capture", content, body)).status >= 400);
  assert.equal((await probe("POST", "/api/capture", `Host: ${host}\r\n${content}`, body)).status, 403);
  assert.equal((await probe("POST", "/api/capture", `Host: ${host}\r\nOrigin: http://foreign.invalid\r\n${content}`, body)).status, 403);
  assert.equal((await probe("POST", "/api/capture", `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\nOrigin: ${origin}\r\n${content}`, body)).status, 403);
  assert.equal(daemon.attempts.length, start, "rejected browser requests must not reach daemon");
  const response = await fetch(`${origin}/api/capture`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await response.json(), receipt);
  assert.equal(daemon.attempts.length, start + 1);
  const attempt = daemon.attempts[start];
  assert.equal(attempt?.method, "POST");
  assert.equal(attempt?.path, "/thoughts");
  assert.equal(attempt?.authorization, daemon.expectedAuthorization);
  assert.deepEqual(JSON.parse(attempt?.body ?? "null"), { text: "route fixture words", title: null });
}

async function retained(page: Page, value: string): Promise<void> {
  await expect.poll(() => page.evaluate(expected => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
    return inputs.some(input => input.value === expected) || (document.body.innerText.includes(expected));
  }, value), { timeout: 5000 }).toBe(true);
}

export async function checkCaptureBrowser(page: Page, daemon: Fixture): Promise<void> {
  const thought = page.getByRole("textbox", { name: /^thought$/i });
  const title = page.getByRole("textbox", { name: /^title(?:\s*\(optional\))?$/i });
  const save = page.getByRole("button", { name: /^save$/i });
  await expect(thought).toBeVisible({ timeout: 5000 });
  await expect(title).toBeVisible();
  await expect(page.getByText(/optional/i)).toBeVisible();
  await thought.fill("   ");
  const beforeBlank = daemon.attempts.length;
  await save.click();
  await page.waitForTimeout(250);
  assert.equal(daemon.attempts.length, beforeBlank, "whitespace must not reach daemon");

  await thought.fill("  exact input\nsecond line  ");
  await title.fill("");
  daemon.setMode("hold");
  const beforeSave = daemon.attempts.length;
  try {
    await save.dblclick({ delay: 40 });
    await waitAttempts(daemon, beforeSave + 1);
    await expect(save).toBeDisabled();
    await retained(page, "  exact input\nsecond line  ");
    await page.waitForTimeout(250);
    assert.equal(daemon.attempts.length, beforeSave + 1, "pending double click must not duplicate capture");
    const submitted = JSON.parse(daemon.attempts[beforeSave]?.body ?? "null");
    assert.equal(submitted.text, "  exact input\nsecond line  ");
    assert.ok(submitted.title === undefined || submitted.title === "" || submitted.title === null);
  } finally { daemon.release(); }
  await expect(page.getByText(receipt.text, { exact: true })).toBeVisible();
  await expect(page.getByText(receipt.title, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /open idea/i })).toHaveAttribute("href", `/ideas/${encodeURIComponent(receipt.id)}`);
  await page.getByRole("button", { name: /capture another/i }).click();
  await expect(thought).toHaveValue("");
  await expect(title).toHaveValue("");

  await thought.fill("retained denial draft");
  await title.fill("retained denial title");
  daemon.setMode("denied");
  const beforeDenial = daemon.attempts.length;
  await save.click();
  await expect(page.getByText(/not saved/i).first()).toBeVisible();
  await retained(page, "retained denial draft");
  await retained(page, "retained denial title");
  await waitAttempts(daemon, beforeDenial + 1);
  daemon.setMode("saved");
  await page.getByRole("button", { name: /retry save/i }).click();
  await expect(page.getByText(receipt.text, { exact: true })).toBeVisible();
  await waitAttempts(daemon, beforeDenial + 2);
  assert.deepEqual(JSON.parse(daemon.attempts[beforeDenial]?.body ?? "null"), JSON.parse(daemon.attempts[beforeDenial + 1]?.body ?? "null"));
  await page.getByRole("button", { name: /capture another/i }).click();

  for (const mode of ["failure", "malformed"] as const) {
    const draft = `uncertain ${mode} draft`;
    const draftTitle = `uncertain ${mode} title`;
    await thought.fill(draft);
    await title.fill(draftTitle);
    daemon.setMode(mode);
    const before = daemon.attempts.length;
    await save.click();
    await expect(page.getByText(/could not confirm|couldn.t confirm|not sure|uncertain/i).first()).toBeVisible();
    await retained(page, draft);
    await retained(page, draftTitle);
    await expect(page.getByText(/duplicate|another copy|may already/i).first()).toBeVisible();
    const explore = page.locator('a[target="_blank"]').filter({ hasText: /explore/i });
    await expect(explore.first()).toHaveAttribute("href", /\/explore/);
    await waitAttempts(daemon, before + 1);
    await page.waitForTimeout(300);
    assert.equal(daemon.attempts.length, before + 1, "uncertain outcome must not auto-retry");
    daemon.setMode("saved");
    await page.getByRole("button", { name: /save another copy/i }).click();
    await expect(page.getByText(receipt.text, { exact: true })).toBeVisible();
    await waitAttempts(daemon, before + 2);
    assert.deepEqual(JSON.parse(daemon.attempts[before]?.body ?? "null"), JSON.parse(daemon.attempts[before + 1]?.body ?? "null"));
    await page.getByRole("button", { name: /capture another/i }).click();
  }
  daemon.setMode("saved");
}
