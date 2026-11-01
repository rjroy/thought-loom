// Separate reviewer-gated source-title fixture. Import never starts a process.
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { createApp } from "../../apps/daemon/src/app";
import { provisionNativeSetup } from "../../apps/daemon/src/native-setup";
import { NativeWeavingAdapter } from "../../apps/daemon/src/native-adapter";
import { findSource, openDatabase } from "../../apps/daemon/src/storage";
import { WeavingWorker } from "../../apps/daemon/src/weaving";
import { OpenCode, Service } from "../../apps/daemon/tests/native-client-support";
import { NATIVE_PLUGIN_BUILD_ID, parseNativeCapabilities } from "../../packages/contracts/src/native-capabilities";
import { parseNativeIdentity, toolRecord, type NativeIdentity } from "../../packages/contracts/src/tools";
import { ORIGINAL } from "./fixture-provider";
import { titleFixtureProvider, TITLE_TEXT } from "./title-fixture-provider";
import { ADMISSION_TIMEOUT_MS, AGENT, ANCHOR, DIALOGUE_OPERATIONS, MODEL, NATIVE_BINARY, OPERATIONS, ROOT_PREFIX, WitnessGuardError, contained, guardedLaunch, pathsFor, readinessFromOutput, requireOptIn, validatePluginRegistry, witnessConfig } from "./plugin-isolation";
import { inspectBinary, nodeIO } from "./node-io";
import { reviewedBundle } from "./plugin-bundle";
import { startOwnedNative } from "./owned-native";
import { verifyTitleHistory } from "./fixture-history";

function check(value: unknown, code: string): asserts value { if (!value) throw new WitnessGuardError(code); }
async function writeNew(path: string, value: string) { const file = await open(path, "wx", 0o600); try { await file.writeFile(value); await file.sync(); } finally { await file.close(); } }
async function bounded(action: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([action(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WitnessGuardError("fixture_cleanup_timeout")), 8_000); })]); }
  finally { clearTimeout(timer); }
}

export async function runTitleWitness() {
  requireOptIn(process.env.THOUGHTLOOM_PLUGIN_WITNESS, process.env.OPENCODE_TEST_BINARY);
  check(process.env.THOUGHTLOOM_TITLE_WITNESS === "1", "title_opt_in_required");
  check(process.platform === "linux" && process.arch === "x64", "fixture_platform_rejected");
  const repo = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  check(await nodeIO.inspect("/etc/opencode") === "missing", "system_config_not_absent");
  check(await nodeIO.inspect(ANCHOR) === "directory" && await realpath(ANCHOR) === ANCHOR, "fixture_anchor_rejected");
  const facts = await inspectBinary(NATIVE_BINARY), bundle = await reviewedBundle(repo);
  const root = await mkdtemp(join(ANCHOR, ROOT_PREFIX)), lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(), 75_000), onSignal = () => lifetime.abort();
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  let owned: ReturnType<typeof startOwnedNative> | undefined, provider: ReturnType<typeof titleFixtureProvider> | undefined;
  let daemon: ReturnType<typeof Bun.serve> | undefined, worker: WeavingWorker | undefined, safe = true;
  const pending = new Set<Promise<unknown>>();
  async function perform<T>(action: () => Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted(); const work = action(); pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
    let abort: (() => void) | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { abort = () => reject(new WitnessGuardError("fixture_deadline")); lifetime.signal.addEventListener("abort", abort, { once: true }); if (lifetime.signal.aborted) abort(); })]); }
    finally { if (abort) lifetime.signal.removeEventListener("abort", abort); }
  }
  try {
    await chmod(root, 0o700); const p = pathsFor(root);
    for (const path of new Set([p.HOME, p.XDG_CONFIG_HOME, p.XDG_DATA_HOME, p.XDG_CACHE_HOME, p.XDG_STATE_HOME, p.TMPDIR, p.OPENCODE_CONFIG_DIR, join(root, "db")])) await mkdir(path, { mode: 0o700 });
    await writeNew(p.GIT_CONFIG_GLOBAL, "");
    const credential = randomBytes(32).toString("base64url"), password = randomBytes(32).toString("base64url"), databasePath = join(root, "app.sqlite");
    const app = createApp({ databasePath, tools: { transportCredential: credential, location: p.cwd } });
    const titleCalls: NativeIdentity[] = [];
    daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 65_536, async fetch(request) {
      const title = request.method === "POST" && new URL(request.url).pathname === "/internal/tools/record-title-v1" && request.headers.get("authorization") === `Bearer ${credential}`;
      const copy = title ? request.clone() : undefined;
      const response = await app.fetch(request);
      if (copy && response.ok) {
        const value: unknown = await copy.json();
        const native = toolRecord(value) ? parseNativeIdentity(value.native) : null;
        check(toolRecord(value) && value.action === "record_title_v1" && value.pluginBuildId === NATIVE_PLUGIN_BUILD_ID && native && titleCalls.length === 0, "title_transport_invalid");
        titleCalls.push(native);
      } else await copy?.body?.cancel();
      return response;
    }, error() { return new Response("fixture failure", { status: 500 }); } });
    const daemonOrigin = `http://127.0.0.1:${daemon.port}`;
    check(readinessFromOutput(`server listening on ${daemonOrigin}\n`) === daemonOrigin, "fixture_daemon_port_rejected");
    const capture = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "title-native-capture" }, body: JSON.stringify({ text: ORIGINAL, provenance: "fixture" }) });
    check(capture.status === 201, "fixture_capture_failed"); const source: unknown = await capture.json();
    check(toolRecord(source) && typeof source.id === "string", "fixture_source_missing"); const sourceId = source.id;
    const manual = await app.request(`/sources/${sourceId}/title`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "title-native-user" }, body: JSON.stringify({ target: { kind: "source" }, text: "Fixture user label", expectedTitleRevisionId: null }) });
    check(manual.status === 200, "fixture_user_title_failed"); const saved: unknown = await manual.json();
    check(toolRecord(saved) && typeof saved.revisionId === "string", "fixture_user_revision_missing"); const head = saved.revisionId;
    const original = JSON.stringify(findSource(databasePath, sourceId));
    provider = titleFixtureProvider(sourceId, head, lifetime.signal);
    check(readinessFromOutput(`server listening on ${provider.origin}\n`) === provider.origin, "fixture_provider_port_rejected");
    await provisionNativeSetup({ runtimeDirectory: p.runtime, locationDirectory: p.cwd, daemonOrigin, transportCredential: credential, pluginEntry: p.bundle, pluginBundle: bundle,
      native: { registrationFile: p.registration, agent: AGENT, model: MODEL, operations: [...OPERATIONS], dialogueOperations: [...DIALOGUE_OPERATIONS], maxSteps: 6, admissionTimeoutMs: ADMISSION_TIMEOUT_MS } });
    const input = { optIn: process.env.THOUGHTLOOM_PLUGIN_WITNESS, executable: process.env.OPENCODE_TEST_BINARY, root, profile: "title" as const, titleOptIn: process.env.THOUGHTLOOM_TITLE_WITNESS,
      config: JSON.stringify(witnessConfig(root, provider.origin, "title")), providerOrigin: provider.origin, daemonOrigin, password, transportCredential: credential };
    const url = await guardedLaunch(input, nodeIO, facts, async (spec) => { lifetime.signal.throwIfAborted(); owned = startOwnedNative(spec, lifetime.signal); return owned.ready(); });
    check(url !== daemonOrigin && url !== provider.origin && owned?.pid, "fixture_service_collision");
    const guardedFetch: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, { ...init, redirect: "error" }), { preconnect: fetch.preconnect });
    const client = OpenCode.make({ baseUrl: url, headers: Service.headers({ url, auth: { type: "basic", username: "opencode", password } }), fetch: guardedFetch });
    const request = { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]) };
    const identity = await client.server.info(request);
    check(identity.version === "2.2.2" && identity.pid === owned.pid && contained(root, identity.paths.tmp), "fixture_native_identity");
    const models = await client.model.list({ location: { directory: p.cwd }, types: ["chat"] }, request);
    const enabled = models.data.filter((model) => model.enabled && model.type === "chat");
    check(enabled.length === 1 && enabled[0]?.providerID === MODEL.providerID && enabled[0].id === MODEL.id, "fixture_enabled_model_rejected");
    validatePluginRegistry(root, (await client.plugin.list({ location: { directory: p.cwd } }, request)).data);
    const nonce = randomUUID(), rpc = await client.rpc.call({ rpcID: "thoughtloom.capabilities", method: "inspect", location: { directory: p.cwd }, input: { nonce } }, request);
    const proof = parseNativeCapabilities(rpc.output);
    check(proof && proof.nonce === nonce && proof.buildId === NATIVE_PLUGIN_BUILD_ID && proof.nativePid === owned.pid && proof.directory === p.cwd && proof.actions.includes("record_title_v1"), "title_witness_invalid");
    await writeNew(p.registration, JSON.stringify({ url, pid: owned.pid, version: "2.2.2", password }));
    worker = new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter({ databasePath, registrationFile: p.registration, location: p.cwd, agent: AGENT, model: MODEL, operations: [...OPERATIONS], dialogueOperations: [...DIALOGUE_OPERATIONS], admissionTimeoutMs: ADMISSION_TIMEOUT_MS }) });
    const started = await perform(() => { check(worker, "fixture_worker_missing"); return worker.startNext(); });
    check(started.kind === "started", "title_run_not_started");
    for (;;) {
      lifetime.signal.throwIfAborted(); owned.healthy(); check(!provider.counts().failed, "title_provider_failed");
      await perform(() => { check(worker, "fixture_worker_missing"); return worker.recover(); });
      const job = await worker.getJob(sourceId); if (job?.status === "completed") break;
      check(job?.status === "running" || job?.status === "uncertain", "title_run_failed"); await pause(100, undefined, { signal: lifetime.signal });
    }
    const db = openDatabase(databasePath);
    try {
      const row = db.query<{ payload: string; operations: string; changes: number; revoked: number }, [string]>(`SELECT c.payload,g.operations,r.recorded_changes AS changes,g.revoked FROM native_commands c JOIN owned_grants g ON g.run_id=c.run_id JOIN weaving_runs r ON r.id=c.run_id WHERE c.run_id=?`).get(started.run.runId);
      check(row, "title_run_receipt_missing"); const command: unknown = JSON.parse(row.payload);
      check(toolRecord(command) && toolRecord(command.profile) && toolRecord(command.profile.capability) && command.profile.capability.buildId === NATIVE_PLUGIN_BUILD_ID && Array.isArray(command.profile.actions) && command.profile.actions.includes("record_title_v1") && JSON.parse(row.operations).includes("record_title_v1") && row.changes === 0 && row.revoked === 1, "title_run_authority_invalid");
      const revisions = db.query<{ text: string; author: string; formulation: string | null }, [string]>(`SELECT r.text,r.author,r.formulation_id AS formulation FROM title_revisions r JOIN title_entities e ON e.id=r.entity_id WHERE e.source_id=? ORDER BY r.rowid`).all(sourceId);
      check(revisions.length === 2 && revisions[0]?.text === "Fixture user label" && revisions[0].author === "user" && revisions[1]?.text === TITLE_TEXT && revisions[1].author === "ai" && revisions[1].formulation === null, "title_revision_invalid");
      check(db.query<{ n: number }, []>("SELECT count(*) AS n FROM jobs WHERE kind='follow_up'").get()?.n === 0, "title_follow_up_created");
    } finally { db.close(); }
    const title = await app.request(`/sources/${sourceId}/title`), body: unknown = await title.json();
    check(title.status === 200 && toolRecord(body) && toolRecord(body.title) && body.title.revisionId === head && body.title.author === "user" && body.title.text === "Fixture user label", "title_user_override_lost");
    const native = titleCalls[0];
    check(native && native.sessionID === started.run.sessionId && native.agent === AGENT && native.messageID !== started.run.promptId, "title_native_context_invalid");
    await verifyTitleHistory(client, { sessionId: started.run.sessionId, agent: AGENT, messageId: native.messageID, callId: native.callID, signal: lifetime.signal });
    check(JSON.stringify(findSource(databasePath, sourceId)) === original && titleCalls.length === 1 && provider.counts().turns === 3 && !provider.counts().failed, "title_witness_incomplete");
    return { version: "2.2.2", capability: "verified", sourceTitle: "recorded", userOverride: "preserved", semanticChanges: 0, followUpJobs: 0, nativeTitleCalls: titleCalls.length, providerRequests: provider.counts().requests };
  } finally {
    lifetime.abort(); clearTimeout(timer);
    const clean = async (action: () => Promise<unknown>) => { try { await bounded(action); } catch { safe = false; } };
    await clean(async () => { await worker?.close(); }); await clean(async () => { await Promise.allSettled([...pending]); });
    await clean(async () => { await owned?.close(); }); await clean(async () => { await provider?.close(); }); await clean(async () => { await daemon?.stop(true); });
    if (safe) await clean(async () => { check(contained(ANCHOR, root) && await realpath(root) === root && await nodeIO.private(root), "fixture_cleanup_path_rejected"); await rm(root, { recursive: true, force: true }); });
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    if (!safe) throw new WitnessGuardError("fixture_cleanup_uncertain");
  }
}

if (import.meta.main) {
  const methods = ["log", "info", "warn", "error", "debug"] as const, saved = methods.map((name) => [name, console[name]] as const);
  for (const name of methods) console[name] = () => {};
  let result: unknown;
  try { result = { state: "passed", ...await runTitleWitness(), cleanup: "completed" }; }
  catch (error) { result = { state: "failed", category: error instanceof WitnessGuardError ? error.code : "fixture_failed" }; process.exitCode = 1; }
  finally { for (const [name, method] of saved) console[name] = method; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
