import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import type { SearchComposerView, SearchTurnControlView } from "../src/domain/agentic-search";

const credentials = { user: "owned-user-012345678901234567890123456789", ai: "owned-agent-01234567890123456789012345678" };
const childScript = fileURLToPath(new URL("./agentic-search-process-child.ts", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function request(url: string, path: string, options: { method?: string; body?: object; key?: string } = {}) {
  return fetch(new URL(path, url), { method: options.method ?? "GET", signal: AbortSignal.timeout(3000), headers: {
    authorization: `Bearer ${credentials.user}`, ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.key ? { "idempotency-key": options.key } : {}),
  }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
function read<T>(path: string, fn: (db: Database) => T): T { const db = new Database(path, { readonly: true }); try { return fn(db); } finally { db.close(); } }

test("orderly separate Bun process rotates cursors while preserving admission and composer coverage", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "search-process-resume-")), path = join(dir, "owned.sqlite");
  let parent: RunningDaemon | undefined;
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
  let childStderr: Promise<string> | undefined;
  try {
    parent = await startDaemon({ dbPath: path, port: 0, credentials, agent: { service: { url: "http://127.0.0.1:44991" }, directory: dir,
      model: { providerID: "owned-provider", id: "owned-model" }, effort: { quick: null, standard: null, thorough: null } } }, () => {}, {
      startTimer: () => () => {}, resolveAgentService: async () => { throw new Error("owned unavailable service"); },
      createPublicClient: () => { throw new Error("unexpected owned client"); }, logSink: () => {},
    });
    const capture = await request(parent.url, "/thoughts", { method: "POST", body: { text: "owned process source", title: "Owned source" } });
    expect(capture.status).toBe(201); const thought = await capture.json() as { id: string };
    const created = await request(parent.url, "/search-sessions", { method: "POST", key: "first-session", body: {} });
    expect(created.status).toBe(201); const { session } = await created.json() as { session: { id: string } };
    expect((await request(parent.url, "/search-sessions", { method: "POST", key: "second-session", body: {} })).status).toBe(201);
    const draftResponse = await request(parent.url, `/search-sessions/${session.id}/composer-contexts`, { method: "POST", body: {} });
    expect(draftResponse.status).toBe(201); const c1 = await draftResponse.json() as SearchComposerView;
    const payload = { text: "OWNED-PROCESS-INTENT", requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" }, composerId: c1.composerId, contextToken: c1.contextToken };
    const admitted = await request(parent.url, `/search-sessions/${session.id}/turns`, { method: "POST", key: "turn-key", body: payload });
    expect(admitted.status).toBe(201); const control = await admitted.json() as SearchTurnControlView;
    const c2Response = await request(parent.url, `/search-sessions/${session.id}/composer-contexts`, { method: "POST", body: {} });
    expect(c2Response.status).toBe(201); const c2 = await c2Response.json() as SearchComposerView;
    const preview = await request(parent.url, `/search-sessions/${session.id}/composer-contexts/${c2.composerId}/thoughts/${thought.id}`);
    expect(preview.status).toBe(200); const covered = await preview.json() as SearchComposerView;
    const refs = () => read(path, db => db.query("SELECT ref_kind,ref_id FROM search_composer_dependencies WHERE composer_id=? ORDER BY ref_kind,ref_id").all(c2.composerId));
    expect(refs()).toEqual([{ ref_kind: "thought", ref_id: thought.id }]);
    const catalog = await request(parent.url, "/search-sessions?limit=1");
    expect(catalog.status).toBe(200); const firstPage = await catalog.json() as { nextCursor: string | null };
    if (!firstPage.nextCursor) throw new Error("missing owned catalog cursor");
    expect((await request(parent.url, `/search-sessions?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`)).status).toBe(200);
    const runCount = read(path, db => db.query("SELECT count(*) AS n FROM runs").get());
    await parent.stop(); parent = undefined;
    child = Bun.spawn([process.execPath, "--no-env-file", childScript, path], { cwd: root,
      env: { HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    childStderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let marker = "";
    try {
      while (!marker.includes("\n")) {
        const part = await bounded(reader.read(), "child readiness");
        if (part.done) throw new Error("owned child exited before readiness");
        marker += new TextDecoder().decode(part.value);
        if (marker.length > 8192) throw new Error("oversized child readiness marker");
      }
    } finally { reader.releaseLock(); }
    const ready = JSON.parse(marker.slice(0, marker.indexOf("\n"))) as { type: string; url: string };
    expect(ready.type).toBe("ready");
    const byKey = await request(ready.url, `/search-sessions/${session.id}/turns/by-key/turn-key`);
    expect(byKey.status).toBe(200); const recovered = await byKey.json() as SearchTurnControlView;
    expect(recovered.receipt).toEqual(control.receipt); expect(JSON.stringify(recovered)).not.toContain(payload.text);
    const replay = await request(ready.url, `/search-sessions/${session.id}/turns`, { method: "POST", key: "turn-key", body: payload });
    expect(replay.status).toBe(200); expect((await replay.json() as SearchTurnControlView).receipt).toEqual(control.receipt);
    const conflict = await request(ready.url, `/search-sessions/${session.id}/turns`, { method: "POST", key: "turn-key", body: { ...payload, text: "changed" } });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual(expect.objectContaining({ code: "idempotency-conflict" }));
    expect(read(path, db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual(runCount);
    expect(read(path, db => db.query("SELECT text FROM thoughts WHERE id=?").get(thought.id))).toEqual({ text: "owned process source" });
    expect(read(path, db => db.query("SELECT text FROM search_messages WHERE id=?").get(control.receipt.userMessageId))).toEqual({ text: payload.text });
    const refreshedResponse = await request(ready.url, `/search-sessions/${session.id}/composer-contexts/${c2.composerId}`);
    expect(refreshedResponse.status).toBe(200); const refreshed = await refreshedResponse.json() as SearchComposerView;
    expect(refreshed.composerId).toBe(c2.composerId); expect(refreshed.contextToken).not.toBe(covered.contextToken);
    expect(refs()).toEqual([{ ref_kind: "thought", ref_id: thought.id }]);
    const reread = await request(ready.url, `/search-sessions/${session.id}/messages?composerId=${c2.composerId}`);
    expect(reread.status).toBe(200);
    expect((await reread.json() as { composerId: string }).composerId).toBe(c2.composerId);
    const oldCursor = await request(ready.url, `/search-sessions?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    expect(oldCursor.status).toBe(400);
    const fresh = await request(ready.url, "/search-sessions?limit=1"); expect(fresh.status).toBe(200);
    const freshPage = await fresh.json() as { nextCursor: string | null };
    if (!freshPage.nextCursor) throw new Error("missing fresh cursor");
    expect((await request(ready.url, `/search-sessions?limit=1&cursor=${encodeURIComponent(freshPage.nextCursor)}`)).status).toBe(200);
    expect(refs()).toEqual([{ ref_kind: "thought", ref_id: thought.id }]);
  } finally {
    await parent?.stop();
    if (child) {
      child.stdin.end();
      try {
        const status = await bounded(child.exited, "child shutdown");
        const stderr = childStderr ? await bounded(childStderr, "child stderr drain") : "";
        if (status !== 0) throw new Error(`owned child exit ${status}: ${stderr}`);
        expect(status).toBe(0);
      }
      finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await child.exited; } }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
