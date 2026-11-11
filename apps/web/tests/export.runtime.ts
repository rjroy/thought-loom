import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Download, type Page, type Request as BrowserRequest } from "@playwright/test";

type Status = "queued" | "running" | "uncertain" | "completed" | "interrupted" | "failed";
type Attempt = { method: string; path: string; authorization: string | undefined; body: string };
const root = { id: "export-root", text: "Owned export root", title: "Export root", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: null, sourceIds: [] };
const markdownRoot = { ...root, id: "export-markdown", title: "Export Markdown fixture", text: "# Export reading heading\n\n[External source](https://example.com/export-source)" };
const visible = { ...root, id: "export-visible", text: "Owned visible source", title: "Visible source" };
const imported = { ...root, id: "export-imported", text: "Owned imported export root", title: "Imported export root", author: "source", kind: "imported-original", origin: "markdown-import" };
const simple = Buffer.from("# Simple Café 雪\r\n\r\nOwned exact simple content.\r\n", "utf8");
const report = Buffer.from('# Report Café 雪\r\n\r\nOwned report content.\r\n\r\n[Body forgery](/ideas/export-forgery)\r\n\r\n![External image](https://evil.invalid/export.png)\r\n\r\n<script>window.ownedExportScriptRan=true</script>\n\n## Sources\n\nRecorded thought identities and attribution (not endorsement):\n\n- Visible source: ID: `"export-visible"`; thought author: user; kind: captured-original.\n- Imported source: ID: `"export-imported"`; thought author: source; kind: imported-original.\n- Hidden source: ID: `"export-hidden"`; thought author: user; kind: captured-original.\n', "utf8");

export function exportDaemon(token: string) {
  const attempts: Attempt[] = [];
  type History = { id: string; status: Status; createdAt: string; request: string; effort: "quick" | "standard" | "thorough"; restored: boolean; deletionState: "stop-required" | "settling" | "ready" };
  const seed = (): History[] => [
    { id: "export-live", status: "running", createdAt: "2032-01-03T00:00:00Z", request: "Owned active question", effort: "quick", restored: false, deletionState: "stop-required" },
    { id: "export-restored", status: "interrupted", createdAt: "2032-01-02T00:00:00Z", request: "Owned restored question", effort: "thorough", restored: true, deletionState: "stop-required" },
    { id: "export-completed", status: "completed", createdAt: "2032-01-01T00:00:00Z", request: "Owned completed question", effort: "standard", restored: false, deletionState: "ready" },
  ];
  let history = seed(), readFailure = false, deleteConflict = false, paginate = false;
  let status: Status = "queued", artifact: "pending" | "error" | "ready" = "pending", admission: "normal" | "unknown" | "unknown-saved" = "normal", next = 0;
  let hold: "simple" | "admission" | null = null, release: (() => void) | undefined;
  const reset = () => { status = "queued"; artifact = "pending"; admission = "normal"; next = 0; hold = null; release = undefined; history = seed(); readFailure = false; deleteConflict = false; paginate = false; };
  return {
    attempts, reset, expectedAuthorization: `Bearer ${token}`,
    setStatus(value: Status) { status = value; }, setArtifact(value: typeof artifact) { artifact = value; }, setAdmission(value: typeof admission) { admission = value; },
    setReadFailure(value: boolean) { readFailure = value; }, setDeleteConflict(value: boolean) { deleteConflict = value; },
    setPagination(value: boolean) { paginate = value; },
    emptyHistory() { history = []; },
    settle(id: string) { const item = history.find(value => value.id === id); if (!item) throw new Error("Missing owned export"); item.deletionState = "ready"; },
    hold(value: "simple" | "admission") { hold = value; },
    waiting() { return release !== undefined; },
    release() { release?.(); release = undefined; hold = null; },
    async handler(req: IncomingMessage, res: ServerResponse) {
      let body = ""; for await (const chunk of req) body += String(chunk);
      const path = req.url ?? "", method = req.method ?? "";
      attempts.push({ method, path, authorization: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const url = new URL(path, "http://fixture.invalid");
      const send = (value: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname === "/exports/simple" && method === "POST") {
        if (hold === "simple") await new Promise<void>(resolve => { release = resolve; });
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(simple); return;
      }
      if (url.pathname === "/exports/agentic" && method === "POST") {
        if (hold === "admission") await new Promise<void>(resolve => { release = resolve; });
        if (admission === "unknown") { res.writeHead(500).end("owned admission failure"); return; }
        next++; status = "queued"; artifact = "pending";
        const input = JSON.parse(body) as {request:string;effort:"quick"|"standard"|"thorough"};
        history.unshift({id:`export-run-${next}`,status,createdAt:"2032-01-04T00:00:00Z",request:input.request,effort:input.effort,restored:false,deletionState:"stop-required"});
        if (admission === "unknown-saved") { res.writeHead(500).end("owned lost admission response"); return; }
        send({ run: { id: `export-run-${next}`, kind: "export", status, confirmedThoughtIds: [], responseId: null } }, 201); return;
      }
      if (url.pathname === "/exports/agentic" && method === "GET") {
        if (readFailure) { res.writeHead(503).end(); return; }
        if (paginate && !url.searchParams.has("cursor") && history.length > 2) { send({items:history.slice(0,2),nextCursor:"owned-next"}); return; }
        send({items:paginate && url.searchParams.has("cursor") ? history.slice(2) : history,nextCursor:null}); return;
      }
      if (url.pathname.startsWith("/exports/agentic/")) {
        const parts = url.pathname.split("/"), item = history.find(value => value.id === parts[3]);
        if (!item) { res.writeHead(404).end(); return; }
        if (parts[4] === "metadata" && method === "GET") { if (readFailure) { res.writeHead(503).end(); return; } send(item); return; }
        if (method === "DELETE") {
          if (deleteConflict || item.deletionState !== "ready") { res.writeHead(409).end(); return; }
          history = history.filter(value => value.id !== item.id); res.writeHead(204).end(); return;
        }
        if (item.id === "export-completed") { res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(report); return; }
        if (artifact === "pending") { res.writeHead(409).end("owned partial report"); return; }
        if (artifact === "error") { res.writeHead(500).end("owned report failure"); return; }
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(report); return;
      }
      if (url.pathname.startsWith("/runs/export-")) {
        const id = url.pathname.split("/")[2];
        const item = history.find(value => value.id === id);
        if (!item) { res.writeHead(404).end(); return; }
        if (method === "POST") { item.status = "interrupted"; item.deletionState = item.restored ? "ready" : "settling"; }
        send({ id, kind: "export", status:item.status, confirmedThoughtIds: [], responseId: null }); return;
      }
      if (url.searchParams.has("scope") && url.searchParams.get("scope") !== "normal") { res.writeHead(403).end(); return; }
      if (/^\/thoughts\/export-root\/(?:children|connections|responses)$/.test(url.pathname)) { send([]); return; }
      if (url.pathname === "/thoughts/export-root") { send(root); return; }
      if (url.pathname === "/thoughts/export-markdown") { send(markdownRoot); return; }
      if (url.pathname === "/thoughts/export-imported") { send(imported); return; }
      if (url.pathname === "/thoughts/export-visible") { send(visible); return; }
      res.writeHead(404).end();
    },
  };
}
type Fixture = ReturnType<typeof exportDaemon>;
type Probe = (method: string, path: string, headers: string, body?: string) => Promise<{ status: number; headers: string; body: string }>;

export async function checkExportRoute({ origin, host, probe, daemon }: { origin: string; host: string; probe: Probe; daemon: Fixture }): Promise<void> {
  daemon.reset();
  const before = daemon.attempts.length;
  const body = JSON.stringify({ rootId: "export-root", count: 3, traversal: "breadth" });
  const headers = `Host: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
  assert.equal((await probe("POST", "/api/export/simple", `${headers}Origin: http://foreign.invalid\r\n`, body)).status, 403);
  assert.equal((await probe("GET", "/api/export/thoughts/export-root", `Host: foreign.invalid\r\nX-Forwarded-Host: ${host}\r\n`)).status, 403);
  assert.equal(daemon.attempts.length, before);
  const response = await fetch(`${origin}/api/export/simple`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), simple);
  const accepted = await fetch(`${origin}/api/export/agentic`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ request: "Owned route request", effort: "quick" }) });
  assert.equal(accepted.status, 201); assert.equal((await accepted.json()).run.kind, "export");
  const calls = daemon.attempts.slice(before);
  assert.ok(calls.every(call => call.authorization === daemon.expectedAuthorization));
  assert.ok(calls.some(call => call.path === "/exports/simple" && call.body === body));
  assert.ok(calls.some(call => call.path === "/exports/agentic" && call.body === '{"request":"Owned route request","effort":"quick"}'));
  assert.ok(calls.every(call => call.path.startsWith("/exports/")), "export controls must not mutate knowledge");
  daemon.reset();
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  assert.ok(stream, "download stream unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** BTR-EXP-002: the catalog mounts and completes before an abandoned form's admission settles. */
export async function checkExportAdmissionRace(page: Page, daemon: Fixture, origin: string, outcome: "normal" | "unknown-saved"): Promise<void> {
  daemon.reset(); daemon.emptyHistory(); daemon.setAdmission(outcome); daemon.hold("admission");
  const before = daemon.attempts.length, question = `Owned pending ${outcome} question`;
  try {
    await page.goto(`${origin}/exports/new`, {waitUntil:"networkidle"});
    await page.getByRole("textbox", {name:"Request",exact:true}).fill(question);
    const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/export/agentic" && response.request().method() === "POST");
    await page.getByRole("button", {name:"Create report",exact:true}).click();
    await expect.poll(() => daemon.waiting()).toBe(true);
    await page.getByRole("link", {name:"Cancel",exact:true}).click();
    await expect(page).toHaveURL(url => url.pathname === "/exports");
    await expect(page.getByRole("heading", {name:"No exports yet",exact:true})).toBeVisible();
    const readsBefore = daemon.attempts.slice(before).filter(call => call.method === "GET" && call.path === "/exports/agentic").length;
    assert.ok(readsBefore >= 1, "the empty catalog must complete before admission is released");
    daemon.release();
    const response = await admission;
    if (outcome === "normal") assert.equal(response.status(),201);
    else assert.notEqual(response.status(),201);
    // No manual check, reload, or second mount: the already-visible catalog must reconcile.
    await expect(page.getByText(question,{exact:true})).toBeVisible({timeout:5000});
    await expect(page.getByRole("heading", {name:"No exports yet",exact:true})).toHaveCount(0);
    assert.ok(daemon.attempts.slice(before).filter(call => call.method === "GET" && call.path === "/exports/agentic").length > readsBefore);
    assert.equal(daemon.attempts.slice(before).filter(call => call.method === "POST" && call.path === "/exports/agentic").length,1);
    assert.ok(!daemon.attempts.slice(before).some(call => call.method === "POST" && call.path.startsWith("/runs/")));
  } finally { daemon.release(); }
}

export async function checkExportBrowser(page: Page, daemon: Fixture, options: { origin: string; daemonOrigin: string; token: string; narrow: boolean }): Promise<void> {
  daemon.reset();
  daemon.setPagination(true);
  const before = daemon.attempts.length, leaks: string[] = [];
  const inspect = (request: BrowserRequest) => {
    if (request.url().startsWith(options.daemonOrigin) || request.url().includes(options.token) || request.headers().authorization?.includes(options.token)) leaks.push(request.url());
  };
  page.on("request", inspect);
  const writes = () => daemon.attempts.slice(before).filter(call => call.method !== "GET");
  try {
    await page.goto(`${options.origin}/explore`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Exports", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/exports");
    await expect(page.getByRole("heading", { name: "Active exports" })).toBeVisible();
    await expect(page.getByText("Owned active question").first()).toBeVisible();
    await page.getByRole("button", { name: /more exports/i }).click();
    await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
    await expect(page.getByText("Owned completed question").first()).toBeVisible();
    assert.equal(writes().length, 0, "listing must not start or stop exports");

    await page.getByRole("link", { name: "Owned completed question" }).click();
    await expect(page).toHaveURL(url => url.pathname === "/exports/export-completed");
    await expect(page.getByText("Owned report content.")).toBeVisible();
    const beforeReload = writes().length;
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText("Owned completed question").first()).toBeVisible();
    await expect(page.getByText("Owned report content.")).toBeVisible();
    assert.equal(writes().length, beforeReload, "reopening a bookmark must not start a run");
    await expect(page.getByText("Body forgery")).toBeVisible();
    await expect(page.locator('a[href="/ideas/export-forgery"], a[href="/ideas/export-hidden"], img[src^="https://evil.invalid"]')).toHaveCount(0);
    await expect(page.locator('a[href="/ideas/export-visible"]').first()).toBeVisible();
    await expect(page.locator('a[href="/ideas/export-imported"]').first()).toBeVisible();
    assert.equal(await page.evaluate(() => (window as typeof window & { ownedExportScriptRan?: boolean }).ownedExportScriptRan), undefined);
    const downloadsBefore = daemon.attempts.filter(call => call.path === "/exports/agentic/export-completed" && call.method === "GET").length;
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /download markdown/i }).click();
    assert.deepEqual(await downloadBytes(await download), report);
    assert.equal(daemon.attempts.filter(call => call.path === "/exports/agentic/export-completed" && call.method === "GET").length, downloadsBefore);

    await page.goto(`${options.origin}/exports/export-live`, { waitUntil: "networkidle" });
    await expect(page.getByText("Owned active question").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
    await page.getByRole("button", { name: /^stop$/i }).click();
    await expect(page.getByText(/stop requested/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
    assert.equal(daemon.attempts.slice(before).filter(call => call.path === "/runs/export-live/stop" && call.method === "POST").length, 1);
    daemon.setReadFailure(true);
    await page.getByRole("button", { name: /check status/i }).click();
    await expect(page.getByText("Owned active question").first()).toBeVisible();
    await expect(page.getByText(/unconfirmed|could not|unavailable/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
    daemon.setReadFailure(false); daemon.settle("export-live");
    await page.getByRole("button", { name: /check status/i }).click();
    await page.getByRole("button", { name: /^delete$/i }).click();
    const dialog = page.getByRole("dialog", { name: /delete this export/i });
    await expect(dialog.getByText("Owned active question")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /cancel/i })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: /^delete$/i }).click();
    daemon.setDeleteConflict(true);
    await dialog.getByRole("button", { name: /delete export/i }).click();
    await expect(page.getByText("Owned active question").first()).toBeVisible();
    await expect(page.getByText(/could not|changed|unavailable|check/i).first()).toBeVisible();
    assert.equal(daemon.attempts.slice(before).filter(call => call.path === "/runs/export-live/stop" && call.method === "POST").length, 1);
    daemon.setDeleteConflict(false);

    await page.goto(`${options.origin}/exports/export-restored`, { waitUntil: "networkidle" });
    await expect(page.getByText(/restored snapshot/i).first()).toBeVisible();
    await page.getByRole("button", { name: /^stop$/i }).click();
    const acknowledge = page.getByRole("checkbox", { name: /understand this does not stop old remote work/i });
    await expect(acknowledge).not.toBeChecked();
    await expect(page.getByRole("button", { name: /confirm local discard/i })).toBeDisabled();
    await acknowledge.check(); await page.getByRole("button", { name: /confirm local discard/i }).click();
    await expect(page.getByText(/local discard confirmed/i)).toBeVisible();
    await page.getByRole("button", { name: /^delete$/i }).click();
    const restoredDialog = page.getByRole("dialog", { name: /delete this export/i });
    await expect(restoredDialog.getByText(/old remote work may still be running/i)).toBeVisible();
    await restoredDialog.getByRole("button", { name: /delete export/i }).click();
    await expect(page).toHaveURL(url => url.pathname === "/exports");
    await expect(page.getByText("Owned restored question")).toHaveCount(0);

    await page.getByRole("link", { name: /new export/i }).click();
    await expect(page).toHaveURL(url => url.pathname === "/exports/new");
    const question = page.getByRole("textbox", { name: /request/i });
    await expect(page.getByRole("combobox", { name: /effort/i })).toHaveValue("standard");
    await question.fill(" "); await expect(page.getByRole("button", { name: /create report/i })).toBeDisabled();
    daemon.setAdmission("unknown"); await question.fill("Owned unknown request");
    const preAdmission = writes().length;
    await page.getByRole("button", { name: /create report/i }).click();
    await expect(page.getByText(/unconfirmed|may have started|could not confirm/i).first()).toBeVisible();
    await expect(question).toHaveValue("Owned unknown request");
    assert.equal(writes().length, preAdmission + 1);
    assert.ok(!daemon.attempts.slice(before).some(call => call.path === "/runs/undefined"));
    await page.goto(`${options.origin}/exports/new`, { waitUntil: "networkidle" });
    daemon.setAdmission("normal");
    await page.getByRole("textbox", { name: /request/i }).fill("Owned new question");
    await page.getByRole("combobox", { name: /effort/i }).selectOption("quick");
    const admittedBefore = writes().length;
    await page.getByRole("button", { name: /create report/i }).click();
    await expect(page).toHaveURL(url => url.pathname === "/exports/export-run-1");
    await expect(page.getByText("Owned new question").first()).toBeVisible();
    const admitted = writes().slice(admittedBefore);
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0]?.path, "/exports/agentic");
    assert.deepEqual(JSON.parse(admitted[0]?.body ?? "null"), {request:"Owned new question",effort:"quick"});
    await page.reload({waitUntil:"networkidle"});
    await expect(page.getByText("Owned new question").first()).toBeVisible();
    assert.equal(writes().length, admittedBefore + 1);

    await page.goto(`${options.origin}/export?thoughtId=export-root`, { waitUntil: "networkidle" });
    await expect(page.getByText(root.text, { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /request|question/i })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /effort/i })).toHaveCount(0);
    const count = page.getByRole("spinbutton", { name: /count|number/i });
    const create = page.getByRole("button", { name: /create (?:simple )?export/i });
    const simpleBefore = daemon.attempts.filter(call => call.path === "/exports/simple").length;
    await count.fill("0"); if (await create.isEnabled()) await create.click();
    await expect(page.getByText("Enter a whole number of 1 or more.")).toBeVisible();
    assert.equal(daemon.attempts.filter(call => call.path === "/exports/simple").length, simpleBefore);
    await count.fill("3"); await create.click();
    await expect(page.getByText("Simple Café 雪")).toBeVisible();
    const simpleDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: /download/i }).click();
    assert.deepEqual(await downloadBytes(await simpleDownload), simple);
    assert.equal(daemon.attempts.filter(call => call.path === "/exports/simple").length, simpleBefore + 1);
    assert.ok(daemon.attempts.slice(before).every(call => call.authorization === daemon.expectedAuthorization));
    assert.ok(!daemon.attempts.slice(before).some(call => /scope=(history|show-rejected)/.test(call.path)));
    assert.deepEqual(leaks, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    void options.narrow;
  } finally { daemon.release(); page.off("request", inspect); }
}
