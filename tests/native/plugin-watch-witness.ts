// Reviewer-gated opt-in fixture. Nothing runs when imported. It launches only an
// owned, guarded process and uses no prompts or provider requests.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { provisionNativeSetup } from "../../apps/daemon/src/native-setup";
import { OpenCode, Service, type OpenCodeClient } from "../../apps/daemon/tests/native-client-support";
import { NATIVE_CAPABILITY_ACTIONS, NATIVE_PLUGIN_BUILD_ID, parseNativeCapabilities } from "../../packages/contracts/src/native-capabilities";
import { ADMISSION_TIMEOUT_MS, AGENT, ANCHOR, DIALOGUE_OPERATIONS, MODEL, NATIVE_BINARY, OPERATIONS, ROOT_PREFIX,
  WitnessGuardError, contained, guardedLaunch, pathsFor, requireOptIn, validatePluginRegistry, witnessConfig } from "./plugin-isolation";
import { inspectBinary, nodeIO } from "./node-io";
import { startOwnedNative } from "./owned-native";
import { reviewedBundle } from "./plugin-bundle";

const BUILD_B = "thoughtloom-witness-B-rpc-v1";
const B_SHA256 = "1b4eaea29e41bac3f108a3d1c307073484fe9ff9384f9cf9a8db735a8fa292e1";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function check(value: unknown, code: string): asserts value { if (!value) throw new WitnessGuardError(code); }

export function fixtureBuildB(bundle: string): string {
  const parts = bundle.split(NATIVE_PLUGIN_BUILD_ID);
  check(parts.length === 2, "watch_marker_count_rejected");
  const next = parts.join(BUILD_B);
  check(sha(next) === B_SHA256, "watch_bundle_hash_rejected");
  return next;
}

async function writeNew(path: string, value: string) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
async function swap(root: string, value: string) {
  const p = pathsFor(root), next = join(p.plugin, ".watch-next.js");
  check(contained(root, p.bundle) && await realpath(root) === root && await realpath(p.plugin) === p.plugin && await realpath(p.bundle) === p.bundle && await nodeIO.private(root), "watch_path_rejected");
  check(await nodeIO.inspect(next) === "missing", "watch_temporary_path_exists");
  await writeNew(next, value); await rename(next, p.bundle);
}
async function inspect(client: OpenCodeClient, location: string, pid: number, signal: AbortSignal) {
  const nonce = randomUUID();
  const result = await client.rpc.call({ rpcID: "thoughtloom.capabilities", method: "inspect", location: { directory: location }, input: { nonce } }, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
  const proof = parseNativeCapabilities(result.output);
  check(proof && proof.nonce === nonce && proof.directory === location && proof.nativePid === pid &&
    JSON.stringify([...proof.actions].sort()) === JSON.stringify([...NATIVE_CAPABILITY_ACTIONS].sort()), "watch_proof_invalid");
  return proof;
}

export type PluginWatchPreflightClient = {
  server: { info(options: { signal: AbortSignal }): Promise<{ version: string; pid: number; paths: { tmp: string } }> };
  model: { list(input: { location: { directory: string }; types: ["chat"] }, options: { signal: AbortSignal }): Promise<{ data: unknown }> };
  plugin: { list(input: { location: { directory: string } }, options: { signal: AbortSignal }): Promise<{ data: unknown }> };
};

// Pinned model.list awaits location plugin activation before enumerating metadata;
// it does not generate. Keep the strict one-shot registry check after that barrier.
export async function preflightPluginWatch(client: PluginWatchPreflightClient, options: { root: string; pid: number; signal: AbortSignal }): Promise<void> {
  const { root, pid, signal } = options;
  const identity = await client.server.info({ signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
  check(identity.version === "2.2.2" && identity.pid === pid && contained(root, identity.paths.tmp), "fixture_native_identity");
  await client.model.list({ location: { directory: pathsFor(root).cwd }, types: ["chat"] }, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
  validatePluginRegistry(root, (await client.plugin.list({ location: { directory: pathsFor(root).cwd } }, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })).data);
}

export async function runPluginWatchWitness() {
  requireOptIn(process.env.THOUGHTLOOM_PLUGIN_WITNESS, process.env.OPENCODE_TEST_BINARY);
  check(process.env.THOUGHTLOOM_PLUGIN_WATCH_WITNESS === "1", "watcher_opt_in_required");
  check(process.platform === "linux" && process.arch === "x64", "fixture_platform_rejected");
  const repo = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  check(await nodeIO.inspect("/etc/opencode") === "missing", "system_config_not_absent");
  check(await nodeIO.inspect(ANCHOR) === "directory" && await realpath(ANCHOR) === ANCHOR, "fixture_anchor_rejected");
  const facts = await inspectBinary(NATIVE_BINARY), bundleA = await reviewedBundle(repo), bundleB = fixtureBuildB(bundleA);
  const root = await mkdtemp(join(ANCHOR, ROOT_PREFIX)), lifetime = new AbortController();
  const timeout = setTimeout(() => lifetime.abort(), 60_000), onSignal = () => lifetime.abort();
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  let owned: ReturnType<typeof startOwnedNative> | undefined, provider: ReturnType<typeof Bun.serve> | undefined, daemon: ReturnType<typeof Bun.serve> | undefined;
  let cleanupSafe = true, requests = 0;
  try {
    await chmod(root, 0o700); const p = pathsFor(root);
    for (const path of new Set([p.HOME, p.XDG_CONFIG_HOME, p.XDG_DATA_HOME, p.XDG_CACHE_HOME, p.XDG_STATE_HOME, p.TMPDIR, p.OPENCODE_CONFIG_DIR, join(root, "db")])) await mkdir(path, { mode: 0o700 });
    await writeNew(p.GIT_CONFIG_GLOBAL, "");
    const credential = randomBytes(32).toString("base64url"), password = randomBytes(32).toString("base64url");
    provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("fixture forbids provider requests", { status: 503 }); } });
    daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("fixture forbids tool writes", { status: 403 }); } });
    const providerOrigin = `http://127.0.0.1:${provider.port}`, daemonOrigin = `http://127.0.0.1:${daemon.port}`;
    await provisionNativeSetup({ runtimeDirectory: p.runtime, locationDirectory: p.cwd, daemonOrigin, transportCredential: credential,
      pluginEntry: p.bundle, pluginBundle: bundleA, native: { registrationFile: p.registration, agent: AGENT, model: MODEL, operations: [...OPERATIONS], dialogueOperations: [...DIALOGUE_OPERATIONS], maxSteps: 6, admissionTimeoutMs: ADMISSION_TIMEOUT_MS } });
    const input = { optIn: process.env.THOUGHTLOOM_PLUGIN_WITNESS, executable: process.env.OPENCODE_TEST_BINARY, root,
      profile: "watcher" as const, watcherOptIn: process.env.THOUGHTLOOM_PLUGIN_WATCH_WITNESS, config: JSON.stringify(witnessConfig(root, providerOrigin)), providerOrigin, daemonOrigin, password, transportCredential: credential };
    const url = await guardedLaunch(input, nodeIO, facts, async (spec) => { lifetime.signal.throwIfAborted(); owned = startOwnedNative(spec, lifetime.signal); return owned.ready(); });
    check(owned?.pid && url !== providerOrigin && url !== daemonOrigin, "fixture_service_collision");
    const pid = owned.pid;
    const guardedFetch: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, { ...init, redirect: "error" }), { preconnect: fetch.preconnect });
    const makeClient = () => OpenCode.make({ baseUrl: url, headers: Service.headers({ url, auth: { type: "basic", username: "opencode", password } }), fetch: guardedFetch });
    const client = makeClient();
    await preflightPluginWatch(client, { root, pid, signal: lifetime.signal });
    const a = await inspect(client, p.cwd, pid, lifetime.signal); check(a.buildId === NATIVE_PLUGIN_BUILD_ID, "watch_initial_build_mismatch");
    // A malformed same-entry swap cannot yield B. This does not prove the watcher observed the failure.
    await swap(root, "export const = ;\n");
    for (let i = 0; i < 10; i++) {
      lifetime.signal.throwIfAborted(); owned.healthy();
      let proof: Awaited<ReturnType<typeof inspect>> | undefined;
      try { proof = await inspect(client, p.cwd, pid, lifetime.signal); } catch (error) { if (error instanceof WitnessGuardError || lifetime.signal.aborted) throw error; }
      if (proof) check(proof.buildId === a.buildId, "watch_invalid_swap_enabled_build");
      await pause(100, undefined, { signal: lifetime.signal });
    }
    await swap(root, bundleB);
    let b: Awaited<ReturnType<typeof inspect>> | undefined;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      lifetime.signal.throwIfAborted(); owned.healthy();
      try { const proof = await inspect(client, p.cwd, pid, lifetime.signal); if (proof.buildId === BUILD_B) { b = proof; break; } check(proof.buildId === a.buildId, "watch_unexpected_build"); }
      catch (error) { if (error instanceof WitnessGuardError || lifetime.signal.aborted) throw error; }
      await pause(100, undefined, { signal: lifetime.signal });
    }
    check(b && b.setupId !== a.setupId, "watch_activation_unproven");
    const fresh = await inspect(makeClient(), p.cwd, pid, lifetime.signal);
    check(fresh.buildId === BUILD_B && fresh.setupId === b.setupId && fresh.nonce !== b.nonce && requests === 0, "watch_fresh_client_mismatch");
    check((await client.server.info({ signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]) })).pid === pid, "watch_pid_changed");
    return { state: "passed", version: "2.2.2", watcher: "A-to-B", malformed: "no-B-observed", freshClient: true, providerRequests: requests };
  } finally {
    lifetime.abort(); clearTimeout(timeout);
    try { await owned?.close(); } catch { cleanupSafe = false; }
    try { await provider?.stop(true); await daemon?.stop(true); } catch { cleanupSafe = false; }
    if (cleanupSafe) {
      try { check(contained(ANCHOR, root) && await realpath(root) === root && await nodeIO.private(root), "fixture_cleanup_path_rejected"); await rm(root, { recursive: true, force: true }); }
      catch { cleanupSafe = false; }
    }
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    if (!cleanupSafe) throw new WitnessGuardError("fixture_cleanup_uncertain");
  }
}

if (import.meta.main) {
  const methods = ["log", "info", "warn", "error", "debug"] as const, saved = methods.map((name) => [name, console[name]] as const);
  for (const name of methods) console[name] = () => {};
  let result: unknown;
  try { result = { ...await runPluginWatchWitness(), cleanup: "completed" }; }
  catch (error) { result = { state: "failed", category: error instanceof WitnessGuardError ? error.code : "fixture_failed" }; process.exitCode = 1; }
  finally { for (const [name, method] of saved) console[name] = method; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
