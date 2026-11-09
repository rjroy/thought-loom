import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateBackupConfig } from "../src/backup/config";
import type { GitInvocation, GitResult } from "../src/backup/git";
import { runBackupAttempt } from "../src/backup/run";
import { backupTableShapes } from "../src/backup/schema";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger, type LogRecord } from "../src/logging";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { mediaApiCredentials as credentials, object, receipt, text, upload } from "./fixtures/media-import-api";
import { independentPng } from "./fixtures/media-rasters";

const remote = "https://backup.invalid/owned/walkthrough.git";
const clock = { at: "2030-01-01T12:00:00Z", timeZone: "UTC" };
const agent = { service: { url: "http://127.0.0.1:44991" }, directory: "/tmp/opencode/owned-walkthrough-agent",
  model: { providerID: "fixture", id: "fixture" }, effort: { quick: null, standard: null, thorough: null } };

async function bounded<T>(promise: Promise<T>, label: string, ms = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned ${label} timed out`)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function read<T>(path: string, action: (db: Database) => T): T {
  const db = new Database(path, { readonly: true, create: false, safeIntegers: true });
  try { return action(db); } finally { db.close(); }
}

function historicalFacts(path: string, runId: string, cleanupId: string, fileId: string) {
  return read(path, db => ({
    run: db.query("SELECT rowid,* FROM runs WHERE id=?").get(runId),
    steps: db.query("SELECT * FROM run_steps WHERE run_id=? ORDER BY position").all(runId),
    binding: db.query("SELECT * FROM agent_bindings WHERE run_id=?").get(runId),
    cleanup: db.query("SELECT rowid,* FROM search_native_cleanup WHERE run_id=?").get(cleanupId),
    file: db.query("SELECT rowid,* FROM markdown_import_files WHERE id=?").get(fileId),
    payload: db.query("SELECT * FROM markdown_import_payloads WHERE file_id=?").get(fileId),
  }));
}

function selectedKnowledge(path: string) {
  return read(path, db => ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources",
    "rejected_thoughts", "rejected_connections", "media_store", "media_sources"].map(table => {
      const shape = backupTableShapes.find(item => item.name === table);
      if (!shape) throw new Error("Missing owned snapshot table shape");
      const order = shape.primaryKey.map(key => `"${key}"`).join(",");
      return { table, rows: db.query(`SELECT * FROM "${table}" ORDER BY ${order}`).all() };
    }));
}

async function command(args: readonly string[], cwd: string, home: string): Promise<GitResult> {
  const child = Bun.spawn({ cmd: [...args], cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
    PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid", GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid",
  } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

async function privateTree(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await privateTree(child);
    else if (entry.isFile()) await chmod(child, 0o600);
    else throw new Error("Unexpected owned archive entry");
  }
}

async function snapshotFiles(path: string): Promise<{ path: string; bytes: Uint8Array }[]> {
  const files: { path: string; bytes: Uint8Array }[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child, name);
      else if (entry.isFile()) files.push({ path: name, bytes: await readFile(child) });
      else throw new Error("Unexpected selected snapshot entry");
    }
  }
  await walk(path, ""); return files.sort((a, b) => a.path.localeCompare(b.path));
}

test("owned online Git revision restores through the standalone command without historical execution", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-recovery-walkthrough-"), source = join(dir, "source.sqlite");
  const bare = join(dir, "remote.git"), checkout = join(dir, "checkout"), target = join(dir, "restored");
  const controller = new AbortController(), records: LogRecord[] = [];
  const captureReady = Promise.withResolvers<void>(), pushReady = Promise.withResolvers<void>();
  let daemon: RunningDaemon | undefined, poll = () => {}, capturePid: number | undefined, gitPid: number | undefined;
  let first: ReturnType<typeof runBackupAttempt> | undefined, later: ReturnType<typeof runBackupAttempt> | undefined, offline = false;
  let restoredResolutions = 0, restoredFactories = 0;
  const client = new ScriptedClient(() => ({ version: 1, kind: "search-reply", reply: "owned fake response", disposition: "done", sourceThoughtIds: [] }));
  const restoredClient = new ScriptedClient(() => ({ version: 1, kind: "complete", reply: "fresh owned response" }));
  const git = async (...args: string[]): Promise<string> => {
    const result = await command(["git", ...args], dir, dir);
    if (result.exitCode !== 0) throw new Error(`Owned Git command failed: ${args[0]}`);
    return result.stdout.trim();
  };
  async function request(path: string, init: RequestInit = {}, actor: "user" | "ai" = "user"): Promise<Response> {
    if (!daemon) throw new Error("Owned daemon is unavailable");
    const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${credentials[actor]}`);
    return fetch(new URL(path, daemon.url), { ...init, headers, signal: AbortSignal.timeout(10000) });
  }
  async function json(path: string, body: object, status: number, key?: string, actor: "user" | "ai" = "user") {
    const response = await request(path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body) }, actor);
    expect(response.status).toBe(status); return object(await response.json());
  }
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Owned ${label} was not reached`); poll(); await Bun.sleep(10); }
  }
  async function start(configured: boolean, restored = false): Promise<void> {
    const selectedClient = restored ? restoredClient : client;
    daemon = await bounded(startDaemon({ dbPath: restored ? join(target, "thoughtloom.sqlite") : source, port: 0, credentials,
      logLevel: "verbose", ...(configured ? { agent } : {}) }, () => {}, {
      startTimer: callback => { poll = callback; return () => { poll = () => {}; }; },
      resolveAgentService: async () => {
        if (restored) restoredResolutions++;
        if (restored && !configured) throw new Error("Unexpected configless native resolution");
        return { url: "http://127.0.0.1:44991" };
      },
      createPublicClient: () => {
        if (restored) restoredFactories++;
        if (restored && !configured) throw new Error("Unexpected configless native client");
        return selectedClient;
      },
      logSink: record => records.push(record),
    }), "daemon startup");
  }
  async function stop(): Promise<void> { const current = daemon; if (current) { await bounded(current.stop(), "daemon stop"); daemon = undefined; } }
  try {
    await git("init", "--bare", bare);
    await writeFile(join(dir, "owned-native-service-payload"), "native-service-only-sentinel", { mode: 0o600 });

    // Produce real rowless cleanup using the normal search worker and the owned decoded native client.
    await start(true); client.dropNextAck = true;
    const session = object((await json("/search-sessions", {}, 201, "purged-session")).session), sessionId = text(session.id);
    const composer = await json(`/search-sessions/${sessionId}/composer-contexts`, {}, 201);
    const turn = await json(`/search-sessions/${sessionId}/turns`, { text: "owned cleanup question", requestClock: clock,
      startingThoughtIds: [], composerId: text(composer.composerId), contextToken: text(composer.contextToken) }, 201, "purged-turn");
    const cleanupRun = text(object(turn.run).id);
    await waitFor(() => client.prompts.length > 0, "owned search submission");
    client.historyMode = "outage";
    expect((await request(`/search-sessions/${sessionId}`, { method: "DELETE" })).status).toBe(204);
    await waitFor(() => read(source, db => !!db.query("SELECT run_id FROM search_native_cleanup WHERE run_id=?").get(cleanupRun) &&
      !db.query("SELECT id FROM runs WHERE id=?").get(cleanupRun)), "rowless cleanup");
    await stop();

    // Configless source keeps newly admitted queued and import work pending without a provider.
    await start(false);
    const visible = text((await json("/thoughts", { text: "cobalt eligible selected" }, 201)).id);
    const hidden = text((await json("/thoughts", { text: "cobalt rejected selected" }, 201)).id);
    const child = text((await json(`/thoughts/${visible}/contributions`, { text: "owned child relationship" }, 201)).id);
    const connected = text((await json("/connections", { fromId: visible, toId: child, category: "related", explanation: "owned relation" }, 201)).id);
    expect((await request(`/thoughts/${hidden}/reject`, { method: "POST" })).status).toBe(204);
    const image = independentPng();
    const media = await receipt(await request("/imports/media", upload(image, "owned-image")));
    const batch = text(object((await json("/imports/markdown", {}, 201, "pending-batch")).import).id);
    const form = new FormData(); form.append("metadata", JSON.stringify({ relativePath: "owned-pending.md" }));
    form.append("file", new Blob(["owned pending markdown\r\n"], { type: "text/markdown" }), "owned-pending.md");
    const imported = await request(`/imports/markdown/${batch}/files`, { method: "POST", headers: { "idempotency-key": "pending-file" }, body: form });
    expect(imported.status).toBe(202); const importFile = text(object(object(await imported.json()).file).id);
    const queued = read(source, db => db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE weave_subject_id=? AND status='queued'").get(visible));
    if (!queued) throw new Error("Expected owned queued run");
    const before = selectedKnowledge(source);
    const config = validateBackupConfig({ repositoryUrl: remote, checkout, branch: "backups", intervalSeconds: null }, source, `${source}.media`);
    const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${remote}`;
    let holdPush = true;
    const runGit = async (call: GitInvocation): Promise<GitResult> => {
      const childProcess = Bun.spawn({ cmd: ["git", "-c", redirect, ...call.args], cwd: call.cwd, signal: call.signal,
        stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid",
          GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid" } });
      const timeout = setTimeout(() => childProcess.kill("SIGKILL"), 15000);
      try {
        if (holdPush && call.args.includes("push")) { holdPush = false; gitPid = childProcess.pid; process.kill(gitPid, "SIGSTOP"); pushReady.resolve(); }
        const [exitCode, stdout, stderr] = await Promise.all([childProcess.exited, new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text()]);
        if (gitPid === childProcess.pid) gitPid = undefined;
        return { exitCode, stdout, stderr };
      } finally { clearTimeout(timeout); }
    };
    const backupLogger = createLogger("verbose", record => {
      records.push(record);
      if (record.message === "[backup] source snapshot established") {
        const pid = record.context?.pid;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Missing owned capture process");
        capturePid = pid; process.kill(pid, "SIGSTOP"); captureReady.resolve();
      }
    });
    first = runBackupAttempt({ databasePath: source, mediaDirectory: `${source}.media`, config, signal: controller.signal, logger: backupLogger }, { runGit });
    void first.catch(() => {});
    await bounded(captureReady.promise, "capture snapshot boundary");
    const duringCapture = text((await json("/thoughts", { text: "after selected snapshot during capture" }, 201)).id);
    if (capturePid === undefined) throw new Error("Owned capture process not held");
    process.kill(capturePid, "SIGCONT"); capturePid = undefined;
    await bounded(pushReady.promise, "Git delivery boundary");
    const duringPush = text((await json("/thoughts", { text: "after selected snapshot during delivery" }, 201)).id);
    if (gitPid === undefined) throw new Error("Owned Git process not held");
    process.kill(gitPid, "SIGCONT"); gitPid = undefined;
    const selected = await bounded(first, "selected backup"); first = undefined;
    expect(selected.remoteConfirmed).toBe(true);
    expect(await git("--git-dir", bare, "rev-parse", "refs/heads/backups")).toBe(selected.localCommit);

    const moved = join(dir, "offline.git"); await rename(bare, moved); offline = true;
    later = runBackupAttempt({ databasePath: source, mediaDirectory: `${source}.media`, config, signal: controller.signal,
      logger: createLogger("verbose", r => records.push(r)) }, { runGit });
    void later.catch(() => {}); const pending = await bounded(later, "offline backup"); later = undefined;
    expect(pending.remoteConfirmed).toBe(false); expect(pending.localCommit).not.toBe(selected.localCommit);
    expect(await git("--git-dir", moved, "rev-parse", "refs/heads/backups")).toBe(selected.localCommit);
    expect(await git("--git-dir", checkout + "/.git", "rev-parse", `${pending.localCommit}^`)).toBe(selected.localCommit);
    await rename(moved, bare); offline = false;
    later = runBackupAttempt({ databasePath: source, mediaDirectory: `${source}.media`, config, signal: controller.signal,
      logger: createLogger("verbose", r => records.push(r)) }, { runGit });
    void later.catch(() => {}); const retry = await bounded(later, "backup retry"); later = undefined;
    expect(retry.remoteConfirmed).toBe(true); expect(retry.localCommit).toBe(pending.localCommit);
    expect(await git("--git-dir", bare, "rev-parse", "refs/heads/backups")).toBe(pending.localCommit);
    await stop();

    const archive = join(dir, "selected.tar"), extracted = join(dir, "selected-revision"); await mkdir(extracted, { mode: 0o700 });
    await git("--git-dir", bare, "archive", `--output=${archive}`, selected.localCommit);
    const unpack = await command(["tar", "-xf", archive, "-C", extracted], dir, dir); expect(unpack.exitCode).toBe(0);
    await privateTree(extracted); const snapshot = join(extracted, "snapshot");
    const archived = await snapshotFiles(snapshot), original = await snapshotFiles(selected.snapshot.snapshotDirectory);
    expect(archived.map(item => item.path)).toEqual(original.map(item => item.path));
    for (let i = 0; i < archived.length; i++) expect(Array.from(archived[i]?.bytes ?? [])).toEqual(Array.from(original[i]?.bytes ?? []));
    const combined = archived.map(item => new TextDecoder().decode(item.bytes)).join("\n");
    for (const secret of [credentials.user, credentials.ai, "native-service-only-sentinel"]) expect(combined).not.toContain(secret);
    expect(archived.some(item => item.path.includes(".env") || item.path.includes("owned-native-service-payload"))).toBe(false);

    const script = fileURLToPath(new URL("../scripts/restore.ts", import.meta.url));
    const restored = await command([process.execPath, "--no-env-file", script, "--snapshot", snapshot, "--target", target,
      "--manifest-sha256", selected.snapshot.manifestSha256], dir, dir);
    expect(restored.exitCode).toBe(0);
    const restoredPath = join(target, "thoughtloom.sqlite"); expect(selectedKnowledge(restoredPath)).toEqual(before);
    expect(Array.from(await readFile(join(`${restoredPath}.media`, "objects", media.thought.mediaSource.id)))).toEqual(Array.from(image));
    expect(read(restoredPath, db => db.query("SELECT id FROM thoughts WHERE id IN (?,?)").all(duringCapture, duringPush))).toEqual([]);
    const history = historicalFacts(restoredPath, queued.id, cleanupRun, importFile);
    expect(history.cleanup).not.toBeNull(); expect(history.payload).not.toBeNull();
    expect(read(restoredPath, db => db.query("SELECT status FROM runs WHERE id=?").get(queued.id))).toEqual({ status: "interrupted" });
    expect(read(restoredPath, db => db.query("SELECT outcome,reason_code FROM markdown_import_files WHERE id=?").get(importFile)))
      .toEqual({ outcome: "interrupted", reason_code: "interrupted" });

    const configlessStart = records.length;
    await start(false, true);
    await waitFor(() => records.slice(configlessStart).some(r => r.message === "[import driver] local poll succeeded"), "configless restored import scan");
    expect(restoredResolutions).toBe(0); expect(restoredFactories).toBe(0);
    expect(historicalFacts(restoredPath, queued.id, cleanupRun, importFile)).toEqual(history);
    expect(existsSync(join(target, ".restore-in-progress"))).toBe(false);
    expect((await request(`/thoughts/${hidden}?scope=history`)).status).toBe(200);
    const configlessSearch = await request("/search?q=cobalt"); expect(configlessSearch.status).toBe(200);
    expect(JSON.stringify(await configlessSearch.json())).toContain(visible);
    await stop();
    expect(historicalFacts(restoredPath, queued.id, cleanupRun, importFile)).toEqual(history);

    let supervisorPolls = 0, importPolls = 0;
    // Observe real scan completions; lack of callbacks alone is not evidence of fenced work being skipped.
    const oldLength = records.length;
    await start(true, true);
    await waitFor(() => {
      const added = records.slice(oldLength);
      supervisorPolls = added.filter(r => r.message === "[supervisor] poll succeeded").length;
      importPolls = added.filter(r => r.message === "[import driver] local poll succeeded").length;
      return supervisorPolls > 0 && importPolls > 0;
    }, "restored historical scans");
    expect(restoredResolutions).toBe(0); expect(restoredClient.prompts).toEqual([]); expect(restoredClient.sessions.size).toBe(0);
    expect(restoredClient.historyRequests).toEqual([]); expect(restoredClient.interrupts).toEqual([]); expect(restoredClient.inboxCancellations).toEqual([]);
    expect(historicalFacts(restoredPath, queued.id, cleanupRun, importFile)).toEqual(history);
    expect((await request(`/thoughts/${hidden}?scope=history`)).status).toBe(200);
    expect((await request(`/thoughts/${hidden}`, {}, "ai")).status).toBe(404);
    const search = await request("/search?q=cobalt", {}, "ai"); expect(search.status).toBe(200);
    const searchText = JSON.stringify(await search.json()); expect(searchText).toContain(visible); expect(searchText).not.toContain(hidden);
    const children = await request(`/thoughts/${visible}/children?scope=history`); expect(children.status).toBe(200);
    expect(JSON.stringify(await children.json())).toContain(child);
    const connections = await request(`/thoughts/${visible}/connections?scope=history`); expect(connections.status).toBe(200);
    expect(JSON.stringify(await connections.json())).toContain(connected);
    expect((await request(`/runs/${queued.id}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    expect(historicalFacts(restoredPath, queued.id, cleanupRun, importFile)).toEqual(history);
    const fresh = text((await json("/thoughts", { text: "fresh independent restored work" }, 201)).id);
    await waitFor(() => restoredClient.prompts.length > 0, "fresh native work");
    const freshRun = read(restoredPath, db => db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE weave_subject_id=?").get(fresh));
    if (!freshRun) throw new Error("Missing fresh run");
    await waitFor(() => read(restoredPath, db => db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id=?").get(freshRun.id)?.status === "completed"), "fresh run completion");
    expect([...restoredClient.sessions.values()].every(value => value.metadata.runId === freshRun.id)).toBe(true);
    expect(historicalFacts(restoredPath, queued.id, cleanupRun, importFile)).toEqual(history);
    const safeOutput = JSON.stringify(records) + restored.stdout + restored.stderr;
    for (const secret of [credentials.user, credentials.ai, remote, "native-service-only-sentinel"]) expect(safeOutput).not.toContain(secret);
  } finally {
    controller.abort();
    if (capturePid !== undefined) { try { process.kill(capturePid, "SIGCONT"); } catch { /* Already exited. */ } }
    if (gitPid !== undefined) { try { process.kill(gitPid, "SIGCONT"); } catch { /* Already exited. */ } }
    if (first) await Promise.allSettled([first]);
    if (later) await Promise.allSettled([later]);
    if (offline) await rename(join(dir, "offline.git"), bare);
    client.holdOutput = false; restoredClient.holdOutput = false;
    try { await daemon?.stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}, 120000);
