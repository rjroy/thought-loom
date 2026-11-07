import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Locator, type Page } from "@playwright/test";

const original = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("# Café 雪\r\nOwned words\r\n")]);
const date = "2032-01-01T00:00:00Z";
const base = { importId: "import-batch-1", byteLength: original.length, createdAt: date, runId: null, documentId: null, thoughtCount: null, segmentation: null, error: null };
const reports = [
  { ...base, id: "import-file-empty", position: 1, relativePath: "empty.md", state: "imported", runId: "import-run-empty", documentId: "import-source-empty", thoughtCount: 0, segmentation: { method: "not-needed", reason: null } },
  { ...base, id: "import-file-fallback", position: 2, relativePath: "fallback.md", state: "imported", runId: "import-run-fallback", documentId: "import-source-1", thoughtCount: 1, segmentation: { method: "structural", reason: "ai-unconfigured" } },
  { ...base, id: "import-file-identical", position: 3, relativePath: "identical.md", state: "skipped-identical", documentId: "import-source-1" },
  { ...base, id: "import-file-changed", position: 4, relativePath: "changed.md", state: "skipped-changed", documentId: "import-source-1" },
  { ...base, id: "import-file-failed", position: 5, relativePath: "failed.md", state: "failed", runId: "import-run-failed", error: { code: "parse-failed", retryable: false } },
  { ...base, id: "import-file-running", position: 6, relativePath: "running.md", state: "running", runId: "import-run-running" },
  { ...base, id: "import-file-uncertain", position: 7, relativePath: "uncertain.md", state: "uncertain", runId: "import-run-uncertain" },
];
const batch = { id: "import-batch-1", namespaceId: "import-namespace", createdAt: date, sealedAt: date, state: "processing", counts: { admitted: 7, pending: 2, imported: 2, skippedIdentical: 1, skippedChanged: 1, failed: 1, interrupted: 0 } };
type Attempt = { method: string; path: string; key: string | undefined; auth: string | undefined; bytes: Buffer; contentType: string | undefined };
const control = (scope: Page | Locator, name: RegExp) => scope.getByRole("button", { name }).or(scope.getByRole("link", { name }));
const details = (scope: Locator) => scope.locator("summary").filter({ hasText: /^details$/i }).or(control(scope, /^details$/i));
const fileArea = (page: Page, name: string) => page.getByText(name, { exact: true }).locator("xpath=ancestor::*[.//button or .//a][1]");

/** Owned daemon stand-in, never an operator service or a provider. */
export function importDaemon(token: string) {
  const attempts: Attempt[] = [];
  let paginated = false;
  return {
    attempts, expectedAuthorization: `Bearer ${token}`,
    setPagination(value: boolean) { paginated = value; },
    async handler(req: IncomingMessage, res: ServerResponse) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), path = req.url ?? "", method = req.method ?? "";
      attempts.push({ method, path, key: req.headers["idempotency-key"] as string | undefined, auth: req.headers.authorization, bytes: body, contentType: req.headers["content-type"] });
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const url = new URL(path, "http://fixture.invalid");
      const send = (value: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname === "/import-namespaces") { send({ items: [{ id: "import-namespace", kind: "loose-markdown", label: "Loose Markdown" }] }); return; }
      if (url.pathname === "/imports/markdown" && method === "POST") { send({ import: { ...batch, sealedAt: null, state: "open", counts: { admitted: 0, pending: 0, imported: 0, skippedIdentical: 0, skippedChanged: 0, failed: 0, interrupted: 0 } } }, 201); return; }
      if (url.pathname === "/imports/markdown" && method === "GET") { send({ items: [batch], nextCursor: null }); return; }
      if (url.pathname === "/imports/markdown/import-batch-1/files" && method === "POST") {
        if (req.headers["idempotency-key"] === "owned-large-upload") {
          send({ file: { ...base, id: "import-file-large", position: 1, relativePath: "large.md", byteLength: 11 * 1024 * 1024, state: "queued", runId: "import-run-large" } }, 202);
        } else res.writeHead(500).end("owned lost receipt");
        return;
      }
      if (url.pathname === "/imports/markdown/import-batch-1/files") {
        if (!paginated) send({ items: reports, nextCursor: null });
        else if (url.searchParams.get("cursor") === "owned-next") send({ items: reports.slice(4), nextCursor: null });
        else send({ items: reports.slice(0, 4), nextCursor: "owned-next" });
        return;
      }
      if (url.pathname.startsWith("/imports/markdown/import-batch-1/files/")) { const selected = reports.find(item => url.pathname.endsWith(`/${item.id}`)); selected ? send({ file: selected }) : res.writeHead(404).end(); return; }
      if (url.pathname === "/imports/markdown/import-batch-1" || url.pathname === "/imports/markdown/import-batch-1/seal") { send({ import: batch }); return; }
      if (url.pathname.startsWith("/runs/import-run-")) { const id = url.pathname.split("/")[2]; const found = reports.find(item => item.runId === id); if (!found) { res.writeHead(404).end(); return; } send({ id, kind: "import", status: found.state === "running" ? (method === "POST" ? "interrupted" : "running") : "uncertain", importId: batch.id, fileId: found.id }); return; }
      if (url.pathname === "/import-sources/import-source-1/raw" && url.searchParams.get("scope") === "history") { res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(original); return; }
      if (url.pathname === "/import-sources/import-source-1/parts" && url.searchParams.get("scope") === "history") { send({ items: [{ position: 1, kind: "thought", startByte: 0, endByte: original.length, thoughtId: "thought-1", ordinal: 1, rejected: false }], nextCursor: null }); return; }
      if (url.pathname === "/import-sources/import-source-1" && url.searchParams.get("scope") === "history") { send({ source: { id: "import-source-1", originalNamespaceId: "import-namespace", originalPath: "fallback.md", sha256: "a".repeat(64), byteLength: original.length, encoding: "utf-8", createdAt: date, parserVersion: "fixture", segmentation: { method: "structural", reason: "ai-unconfigured" }, thoughtCount: 1 } }); return; }
      res.writeHead(404).end();
    },
  };
}

/** Real Next HTTP probe: the file is below the configured bound, framing included. */
export async function checkLargeImportRoute(origin: string, daemon: ReturnType<typeof importDaemon>): Promise<void> {
  const max = 12 * 1024 * 1024;
  const bytes = new Uint8Array(11 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = 65 + (i % 26);
  const form = new FormData();
  form.set("metadata", JSON.stringify({ relativePath: "large.md" }));
  form.set("file", new File([bytes], "large.md", { type: "text/markdown" }));
  const payload = new Request(`${origin}/api/imports/markdown/import-batch-1/files`, { method: "POST", body: form });
  const contentType = payload.headers.get("content-type");
  assert.match(contentType ?? "", /^multipart\/form-data;\s*boundary=/i);
  assert.ok(contentType);
  const wire = await payload.arrayBuffer();
  assert.ok(bytes.byteLength < max && wire.byteLength > 10 * 1024 * 1024 && wire.byteLength < max + 65536, "fixture must exercise the complete bounded multipart envelope");
  const before = daemon.attempts.length;
  const result = await fetch(payload.url, { method: "POST", headers: { origin, "content-type": contentType, "idempotency-key": "owned-large-upload" }, body: wire, signal: AbortSignal.timeout(30000) });
  assert.equal(result.status, 202, "real Next route must admit the complete allowed upload");
  const calls = daemon.attempts.slice(before);
  assert.equal(calls.length, 1);
  const attempt = calls[0]; assert.ok(attempt);
  assert.equal(attempt.key, "owned-large-upload");
  assert.equal(attempt.auth, daemon.expectedAuthorization);
  const forwarded = await new Request("http://fixture.invalid", { method: "POST", headers: { "content-type": attempt.contentType ?? "" }, body: Uint8Array.from(attempt.bytes) }).formData();
  assert.deepEqual(JSON.parse(String(forwarded.get("metadata"))), { relativePath: "large.md" });
  const file = forwarded.get("file"); assert.ok(file instanceof File);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
}

/** Immediate RED: uses the actual built Capture page, not a synthetic placeholder. */
export async function checkImportEntry(page: Page, { origin }: { origin: string }): Promise<void> {
  await page.goto(`${origin}/capture`, { waitUntil: "networkidle" });
  const entry = page.getByRole("link", { name: /^import$/i }).or(page.getByRole("button", { name: /^import$/i }));
  await expect(entry).toBeVisible({ timeout: 5000 });
  await expect(page.locator("form").getByRole("link", { name: /^import$/i }).or(page.locator("form").getByRole("button", { name: /^import$/i }))).toHaveCount(0);
}

/** Future acceptance: executes after the real entry exists; nothing is skipped. */
export async function checkImportBrowser(page: Page, daemon: ReturnType<typeof importDaemon>, { origin }: { origin: string }): Promise<void> {
  const start = daemon.attempts.length;
  await page.getByRole("textbox", { name: /^thought$/i }).fill("Owned unsaved capture draft");
  await page.getByRole("textbox", { name: /^title/i }).fill("Owned draft title");
  const entry = page.getByRole("link", { name: /^import$/i }).or(page.getByRole("button", { name: /^import$/i }));
  await entry.click();
  await expect(page).toHaveURL(/\/import(?:\?|$)/);
  await expect(page.getByRole("heading", { name: /import markdown/i })).toBeVisible();
  await expect(page.locator('img[src="/backgrounds/capture-canopy.png"]')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("textbox", { name: /^thought$/i })).toHaveValue("Owned unsaved capture draft");
  await expect(page.getByRole("textbox", { name: /^title/i })).toHaveValue("Owned draft title");
  await entry.click();
  await expect(page.getByRole("heading", { name: /import markdown/i })).toBeVisible();
  const selection = page.locator('input[type="file"]');
  await selection.setInputFiles([{ name: "owned.md", mimeType: "text/markdown", buffer: original }, { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("owned non-markdown") }]);
  await expect(page.getByText("owned.md", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/not sent/i).first()).toBeVisible();
  assert.equal(daemon.attempts.slice(start).filter(a => a.method === "POST").length, 0, "choosing files must not admit a batch or file");
  await page.getByRole("button", { name: /^import\b/i }).click();
  await expect.poll(() => daemon.attempts.slice(start).filter(a => a.method === "POST" && a.path.endsWith("/files")).length).toBe(1);
  await expect(page.getByText(/uncertain|could not confirm|not sure/i).first()).toBeVisible();
  const posts = () => daemon.attempts.slice(start).filter(a => a.method === "POST");
  const admitted = posts().filter(a => a.path.endsWith("/files"));
  assert.equal(admitted.length, 1);
  const attempt = admitted[0];
  assert.ok(attempt?.key);
  const partRequest = new Request("http://fixture.invalid", { method: "POST", headers: { "content-type": attempt.contentType ?? "" }, body: Uint8Array.from(attempt.bytes) });
  const form = await partRequest.formData();
  assert.deepEqual(JSON.parse(String(form.get("metadata"))), { relativePath: "owned.md" });
  assert.deepEqual(Buffer.from(await (form.get("file") as File).arrayBuffer()), original);
  await page.waitForTimeout(500);
  assert.equal(posts().filter(a => a.path === "/imports/markdown").length, 1, "uncertainty must not create a replacement batch");
  assert.equal(posts().filter(a => a.path.endsWith("/files")).length, 1, "uncertainty must not reupload");

  // A known report can be bookmarked independently of unsent browser files.
  const response = await page.goto(`${origin}/import?batchId=import-batch-1`, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200);
  await expect(page.getByText("empty.md", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/0 thoughts/i).first()).toBeVisible();
  await expect(page.getByText(/fallback/i).first()).toBeVisible();
  await expect(page.getByText(/skipped.*identical/i).first()).toBeVisible();
  await expect(page.getByText(/skipped.*changed/i).first()).toBeVisible();
  await expect(page.getByText(/failed/i).first()).toBeVisible();
  await expect(page.getByText(/uncertain/i).first()).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("running.md", { exact: false }).first()).toBeVisible();
  const beforeStop = posts().length;
  const running = fileArea(page, "running.md");
  const directStop = control(running, /stop/i).filter({ visible: true });
  const stopCount = await directStop.count();
  assert.ok(stopCount <= 1, "running file must not have ambiguous Stop controls");
  if (stopCount === 1) {
    await directStop.click();
  } else {
    await details(running).click();
    await expect(page.getByText("running.md", { exact: false }).first()).toBeVisible();
    await control(page, /stop/i).click();
  }
  await expect.poll(() => posts().length).toBe(beforeStop + 1);
  assert.equal(posts().at(-1)?.path, "/runs/import-run-running/stop");
  assert.ok(!posts().some(a => a.path.includes("import-run-uncertain/stop")));
  const uncertain = fileArea(page, "uncertain.md");
  const beforeCheck = daemon.attempts.length;
  await control(uncertain, /check file/i).click();
  await expect.poll(() => daemon.attempts.slice(beforeCheck).some(a => a.method === "GET" && a.path === "/runs/import-run-uncertain")).toBe(true);
  await expect(uncertain.getByText(/uncertain/i).first()).toBeVisible();
  assert.deepEqual(daemon.attempts.slice(beforeCheck).filter(a => a.method === "POST"), [], "checking uncertainty must not mutate or reupload");
  const beforeUncertainStop = daemon.attempts.length;
  const directUncertainStop = control(uncertain, /stop/i).filter({ visible: true });
  if (await directUncertainStop.count() === 0) {
    await expect(details(uncertain)).toBeVisible({ timeout: 3000 });
    await details(uncertain).click();
  }
  await expect(control(uncertain, /stop/i).filter({ visible: true })).toBeVisible({ timeout: 3000 });
  await control(uncertain, /stop/i).filter({ visible: true }).click();
  await expect.poll(() => daemon.attempts.slice(beforeUncertainStop).filter(a => a.method === "POST").length).toBe(1);
  const stopCalls = daemon.attempts.slice(beforeUncertainStop);
  assert.deepEqual(stopCalls.filter(a => a.method === "POST").map(a => a.path), ["/runs/import-run-uncertain/stop"]);
  const stopIndex = stopCalls.findIndex(a => a.method === "POST");
  assert.ok(stopCalls.slice(0, stopIndex).some(a => a.method === "GET" && a.path === "/runs/import-run-uncertain"), "classify the same import run before Stop");
  await expect(uncertain.getByText(/uncertain|stop requested/i).first()).toBeVisible();
  await page.waitForTimeout(300);
  assert.deepEqual(daemon.attempts.slice(beforeUncertainStop).filter(a => a.method === "POST").map(a => a.path), ["/runs/import-run-uncertain/stop"]);
  await control(page, /recent imports/i).click();
  await expect(page.getByText(/import-batch-1/).first()).toBeVisible();
  await control(page, /import-batch-1/i).click();
  await expect(page.getByText("fallback.md", { exact: false }).first()).toBeVisible();
  const fallback = fileArea(page, "fallback.md");
  const directInspect = control(fallback, /inspect (?:source|original)/i).filter({ visible: true });
  const inspectCount = await directInspect.count();
  assert.ok(inspectCount <= 1, "fallback file must not have ambiguous inspection controls");
  if (inspectCount === 1) {
    await directInspect.click();
  } else {
    await details(fallback).click();
    await control(fallback, /inspect (?:source|original)/i).click();
  }
  await expect.poll(() => daemon.attempts.some(a => a.path.startsWith("/import-sources/import-source-1") && a.path.includes("scope=history"))).toBe(true);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("# Café 雪", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("link", { name: /open idea/i })).toHaveAttribute("href", /^\/ideas\/thought-1(?:\?|$)/);
  await dialog.getByRole("button", { name: "Close" }).click();
  daemon.setPagination(true);
  try {
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "More files" })).toBeVisible();
    await expect(page.getByText("uncertain.md", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "More files" }).click();
    await expect(page.getByText("uncertain.md", { exact: true })).toBeVisible();
    const beforeRecheck = daemon.attempts.length;
    await page.getByRole("button", { name: "Check report" }).click();
    await expect.poll(() => daemon.attempts.slice(beforeRecheck).filter(a => a.path.includes("cursor=owned-next")).length).toBeGreaterThan(0);
    await expect(page.getByText("uncertain.md", { exact: true })).toBeVisible();
  } finally { daemon.setPagination(false); }
  assert.ok(daemon.attempts.slice(start).every(a => a.auth === `Bearer ${"foundation-owned-token-9f6e7a"}`));
}
