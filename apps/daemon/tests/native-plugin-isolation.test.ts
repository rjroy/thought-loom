import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMISSION_TIMEOUT_MS, AGENT, ANCHOR, ROOT_PREFIX, BUNDLE_SHA256, SOURCE_HASHES, DIALOGUE_OPERATIONS, OPERATIONS, MODEL, NATIVE_BINARY, NATIVE_SHA256, generatedConfig, guardedLaunch, pathsFor,
  preparePluginLaunch, readinessFromOutput, selection, validateBinary, validateLaunchSpec, validatePluginRegistry, witnessConfig,
  type BinaryFacts, type GuardIO, type GuardInput, type LaunchSpec, type Metadata } from "../../../tests/native/plugin-isolation";
import { reviewedBundle, validateSourceHashes } from "../../../tests/native/plugin-bundle";
import { provisionNativeSetup } from "../src/native-setup";
import { fixtureBuildB, preflightPluginWatch } from "../../../tests/native/plugin-watch-witness";

const root = `${ANCHOR}/thoughtloom-plugin-witness-pure-owned`;
const providerOrigin = "http://127.0.0.1:18491", daemonOrigin = "http://127.0.0.1:18492";
const password = "fixture_native_password_123456789", credential = "fixture_transport_secret_1234567";
const p = pathsFor(root);

function preflightClient(options: { rejectBarrier?: boolean; unsafeRegistry?: boolean } = {}) {
  const calls: string[] = [], locations: string[] = [], signals: AbortSignal[] = [];
  const client = {
    server: { async info(request: { signal: AbortSignal }) { calls.push("info"); signals.push(request.signal); return { version: "2.2.2", pid: 42, paths: { tmp: join(root, "tmp") } }; } },
    model: { async list(input: { location: { directory: string }; types: string[] }, request: { signal: AbortSignal }) {
      calls.push("model.list"); locations.push(input.location.directory); signals.push(request.signal);
      expect(input.types).toEqual(["chat"]);
      if (options.rejectBarrier) throw new Error("fixture activation unavailable");
      return { data: [{ providerID: MODEL.providerID, id: MODEL.id, enabled: true, type: "chat" }] };
    } },
    plugin: { async list(input: { location: { directory: string } }, request: { signal: AbortSignal }) {
      calls.push("plugin.list"); locations.push(input.location.directory); signals.push(request.signal);
      const plugin = { id: "thoughtloom", source: { type: "local", path: p.plugin }, state: { status: "active" } };
      return { data: options.unsafeRegistry ? [plugin, { id: "other", source: { type: "local", path: "/fixture/unsafe" }, state: { status: "active" } }] : [plugin] };
    } },
  };
  return { client, calls, locations, signals };
}

test("watch preflight awaits location-scoped model metadata barrier before strict registry", async () => {
  const f = preflightClient(), controller = new AbortController();
  await preflightPluginWatch(f.client, { root, pid: 42, signal: controller.signal });
  expect(f.calls).toEqual(["info", "model.list", "plugin.list"]);
  expect(f.locations).toEqual([p.cwd, p.cwd]);
  expect(f.signals).toHaveLength(3); expect(f.signals.every((signal) => !signal.aborted)).toBe(true);
});

test("watch preflight barrier failure stops before registry and continuation", async () => {
  const f = preflightClient({ rejectBarrier: true }); let continued = false;
  const outcome = await preflightPluginWatch(f.client, { root, pid: 42, signal: new AbortController().signal }).then(() => { continued = true; return "accepted"; }, () => "rejected");
  expect(outcome).toBe("rejected"); expect(f.calls).toEqual(["info", "model.list"]); expect(continued).toBe(false);
});

test("watch preflight rejects unsafe registry even after successful barrier", async () => {
  const f = preflightClient({ unsafeRegistry: true }); let continued = false;
  const outcome = await preflightPluginWatch(f.client, { root, pid: 42, signal: new AbortController().signal }).then(() => { continued = true; return "accepted"; }, (error: unknown) => error);
  expect(outcome).toMatchObject({ code: "fixture_plugin_registry_rejected" });
  expect(f.calls).toEqual(["info", "model.list", "plugin.list"]); expect(continued).toBe(false);
});
function input(): GuardInput {
  return { optIn: "1", executable: NATIVE_BINARY, root, providerOrigin, daemonOrigin, password,
    transportCredential: credential, config: JSON.stringify(witnessConfig(root, providerOrigin)) };
}
function facts(): BinaryFacts {
  return { executable: NATIVE_BINARY, canonical: true, regularExecutable: true, elf: true, sha256: NATIVE_SHA256,
    cliName: "@opencode/cli", cliVersion: "2.2.2", platformName: "@opencode/cli-linux-x64", platformVersion: "2.2.2", siblingMatches: true };
}
function io(overrides: Partial<GuardIO> = {}): GuardIO {
  const files = new Set([p.bundle, p.package, p.connection, p.projectConfig, p.selection, p.GIT_CONFIG_GLOBAL]);
  const dirs = new Set([root, ANCHOR, p.cwd, p.runtime, p.plugin, join(p.cwd, ".opencode"), join(root, "db"),
    p.HOME, p.XDG_CONFIG_HOME, p.XDG_DATA_HOME, p.XDG_CACHE_HOME, p.XDG_STATE_HOME, p.TMPDIR, p.OPENCODE_CONFIG_DIR]);
  const texts = new Map([
    [p.package, JSON.stringify({ name: "thoughtloom-owned-plugin", type: "module", exports: { ".": "./index.js" } })],
    [p.connection, JSON.stringify({ url: daemonOrigin, location: p.cwd, transportCredential: credential })],
    [p.projectConfig, JSON.stringify(generatedConfig(root))], [p.selection, JSON.stringify(selection(root))], [p.GIT_CONFIG_GLOBAL, ""],
  ]);
  return {
    async inspect(path): Promise<Metadata> { return files.has(path) ? "file" : dirs.has(path) ? "directory" : "missing"; },
    async canonical(path) { return path; }, async text(path) { const value = texts.get(path); if (value === undefined) throw Error("Unexpected fixture read"); return value; },
    async hash(path) { if (path !== p.bundle) throw Error("Unexpected fixture hash"); return BUNDLE_SHA256; },
    async private() { return true; },
    async entries(path) { return path === p.plugin ? ["index.js", "package.json"] : path === p.runtime ? ["plugin", "connection.json", "native.json"] : path === p.cwd ? [".opencode"] : path === join(p.cwd, ".opencode") ? ["opencode.json"] : []; },
    ...overrides,
  };
}
async function denied(value: GuardInput, guardIO = io(), binary = facts()) {
  let launched = false;
  await expect(guardedLaunch(value, guardIO, binary, async () => { launched = true; })).rejects.toThrow();
  expect(launched).toBe(false);
}

test("the single plugin profile retains project-discovery disable and a fresh exact environment", async () => {
  const spec = await preparePluginLaunch(input(), io(), facts());
  expect(spec.executable).toBe(NATIVE_BINARY);
  expect(spec.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  expect(spec.cwd).toBe(p.cwd);
  expect(spec.env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1");
  expect(spec.env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
  expect(spec.env.OPENCODE_DISABLE_FREE_MODELS).toBe("1");
  expect(spec.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
  expect(spec.env.OPENCODE_DISABLE_FILEWATCHER).toBe("1");
  expect(spec.env).not.toHaveProperty("OPENAI_API_KEY");
  expect(spec.env).not.toHaveProperty("OPENCODE_CONFIG");
  expect(spec.env).not.toHaveProperty("OPENCODE_TEST_BINARY");
  expect(spec.env.PATH).toBe("/usr/bin:/bin");
  expect(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT).plugins).toEqual(generatedConfig(root).plugins);
  let launched = 0;
  await guardedLaunch(input(), io(), facts(), async () => { launched++; });
  expect(launched).toBe(1);
});

test("title profile requires its own opt-in and only adds the title agent ceiling", async () => {
  const title = { ...input(), profile: "title" as const, titleOptIn: "1", config: JSON.stringify(witnessConfig(root, providerOrigin, "title")) };
  await denied({ ...title, titleOptIn: undefined });
  await denied({ ...title, config: JSON.stringify(witnessConfig(root, providerOrigin)) });
  const spec = await preparePluginLaunch(title, io(), facts());
  expect(spec.env.OPENCODE_DISABLE_FILEWATCHER).toBe("1");
  const config: unknown = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT ?? "null");
  expect(config).toEqual(witnessConfig(root, providerOrigin, "title"));
  expect(witnessConfig(root, providerOrigin, "title").agents[AGENT]?.permissions).toEqual([...witnessConfig(root, providerOrigin).agents[AGENT].permissions, { action: "record_title_v1", resource: "*", effect: "allow" }]);
  await denied({ ...title, config: title.config.replace("record_title_v1", "bash") });
});

for (const selector of [undefined, "", "opencode", "/usr/bin/opencode", `${NATIVE_BINARY}/../opencode.exe`]) {
  test(`rejects an unapproved binary selector (${String(selector)}) without launching`, async () => { await denied({ ...input(), executable: selector }); });
}
test("explicit opt-in is mandatory even for the approved binary", async () => { await denied({ ...input(), optIn: undefined }); });
test("watcher profile requires separate opt-in and changes only the watcher flag", async () => {
  await denied({ ...input(), profile: "watcher" });
  const baseline = await preparePluginLaunch(input(), io(), facts());
  const watcher = await preparePluginLaunch({ ...input(), profile: "watcher", watcherOptIn: "1" }, io(), facts());
  expect(watcher.env).not.toHaveProperty("OPENCODE_DISABLE_FILEWATCHER");
  expect(Object.entries({ ...watcher.env, OPENCODE_DISABLE_FILEWATCHER: "1" }).sort()).toEqual(Object.entries(baseline.env).sort());
  expect(() => validateLaunchSpec(watcher, input())).toThrow();
  expect(() => validateLaunchSpec(baseline, { ...input(), profile: "watcher", watcherOptIn: "1" })).toThrow();
});
for (const key of ["canonical", "regularExecutable", "elf", "siblingMatches"] as const) {
  test(`binary ${key} failure cannot reach launch`, async () => { await denied(input(), io(), { ...facts(), [key]: false }); });
}
test("binary digest and package-version mismatches cannot reach launch", async () => {
  await denied(input(), io(), { ...facts(), sha256: "0".repeat(64) });
  await denied(input(), io(), { ...facts(), platformVersion: "2.2.1" });
  expect(() => validateBinary({ ...facts(), cliName: "other" })).toThrow();
});
for (const state of ["directory", "file", "symlink", "error"] as const) {
  test(`/etc/opencode must be definitely absent, not ${state}`, async () => {
    const base = io(); await denied(input(), io({ inspect: async (path) => path === "/etc/opencode" ? state : base.inspect(path) }));
  });
}
test("outside/traversal fixture roots and external provider origins are rejected", async () => {
  await denied({ ...input(), root: "/home/fixture" });
  await denied({ ...input(), root: `${root}/../outside` });
  for (const providerOrigin of ["https://example.invalid", "http://localhost:18491", "http://127.0.0.1:0", "http://user:secret@127.0.0.1:18491", "http://127.0.0.1:18491/path"]) await denied({ ...input(), providerOrigin });
});
test("only the exact configured package, options, agent and fake provider are allowed", async () => {
  const base = witnessConfig(root, providerOrigin);
  for (const config of [
    { ...base, plugins: ["https://example.invalid/plugin"] },
    { ...base, plugins: [...base.plugins, base.plugins[0]] },
    { ...base, plugins: [{ ...base.plugins[0], package: "/tmp/other/plugin" }] },
    { ...base, plugins: [{ ...base.plugins[0], options: { ...base.plugins[0].options, connectionFile: "/host/credential" } }] },
    { ...base, mcp: { servers: {} } },
    { ...base, providers: { ...base.providers, paid: {} } },
    { ...base, permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    { ...base, agents: { ...base.agents, extra: { mode: "primary" } } },
  ]) await denied({ ...input(), config: JSON.stringify(config) });
  expect(base.providers[MODEL.providerID].env).toEqual([]);
  expect(base.agents[AGENT].permissions.some((rule) => rule.effect === "allow" && rule.action === "*")).toBe(false);
  expect(base.agents[AGENT].permissions.filter((rule) => rule.effect === "allow").map((rule) => rule.action)).toEqual(["read_source", "record_interpretation", "record_idea"]);
  expect(selection(root).operations).toEqual([...OPERATIONS]);
  expect(selection(root).dialogueOperations).toEqual([...DIALOGUE_OPERATIONS]);
});
test("plugin bytes, package entrypoints and generated documents are checked, not only paths", async () => {
  await denied(input(), io({ hash: async () => "0".repeat(64) }));
  // The historical capture-only bundle is no longer an allowed native artifact.
  await denied(input(), io({ hash: async () => "b2e9e9de7545f79ab565710c7c248537bc9e98e2ac29482b65544f79f343b2e6" }));
  const base = io();
  await denied(input(), io({ text: async (path) => path === p.package ? JSON.stringify({ scripts: { postinstall: "bad" } }) : base.text(path) }));
  await denied(input(), io({ text: async (path) => path === p.connection ? JSON.stringify({ url: "https://external.invalid", transportCredential: credential, location: p.cwd }) : base.text(path) }));
  await denied(input(), io({ text: async (path) => path === p.selection ? JSON.stringify({ ...selection(root), operations: [...OPERATIONS, "record_idea"] }) : base.text(path) }));
  await denied(input(), io({ text: async (path) => path === p.selection ? JSON.stringify({ ...selection(root), dialogueOperations: [...DIALOGUE_OPERATIONS, "bash"] }) : base.text(path) }));
  await denied(input(), io({ entries: async (path) => path === p.plugin ? ["index.js", "package.json", "extra.js"] : base.entries(path) }));
  await denied(input(), io({ entries: async (path) => path === p.HOME ? [".opencode"] : base.entries(path) }));
});
test("reviewed plugin provenance rejects historical hashes and unexpected source paths", () => {
  expect(() => validateSourceHashes({ ...SOURCE_HASHES })).not.toThrow();
  expect(() => validateSourceHashes({ ...SOURCE_HASHES, "packages/agent-tools/src/plugin.ts": "8bc121d9837ccf2b86451e0efd6c96d8ea558d3e8e58e447e73ac9cd72fb796d" })).toThrow();
  expect(() => validateSourceHashes({ ...SOURCE_HASHES, "packages/contracts/src/tools.ts": "02a889a770122f3a2a2ddcd2afc56e8551fe39b71ec2e14c95c51e6bdf84f22d" })).toThrow();
  for (const path of Object.keys(SOURCE_HASHES)) expect(() => validateSourceHashes({ ...SOURCE_HASHES, [path]: "0".repeat(64) })).toThrow();
  expect(() => validateSourceHashes({ ...SOURCE_HASHES, "../external-plugin.ts": BUNDLE_SHA256 })).toThrow();
  expect(() => validateSourceHashes({ "packages/agent-tools/src/plugin.ts": SOURCE_HASHES["packages/agent-tools/src/plugin.ts"] })).toThrow();
});
test("the current exact sources reproduce the reviewed bundle without native execution", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
  const text = await reviewedBundle(repo);
  expect(createHash("sha256").update(text).digest("hex")).toBe(BUNDLE_SHA256);
  const other = fixtureBuildB(text);
  expect(createHash("sha256").update(other).digest("hex")).toBe("1b4eaea29e41bac3f108a3d1c307073484fe9ff9384f9cf9a8db735a8fa292e1");
  expect(() => fixtureBuildB("unreviewed fixture")).toThrow();
  await expect(reviewedBundle(`${repo}/other`)).rejects.toThrow();
});
test("production offline setup generates exactly the guarded two-scope fixture documents", async () => {
  const ownedRoot = await mkdtemp(join(ANCHOR, ROOT_PREFIX));
  try {
    const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
    const p = pathsFor(ownedRoot);
    await provisionNativeSetup({ runtimeDirectory: p.runtime, locationDirectory: p.cwd, daemonOrigin, transportCredential: credential,
      pluginEntry: p.bundle, pluginBundle: await reviewedBundle(repo), native: { registrationFile: p.registration, agent: AGENT, model: MODEL,
        operations: [...OPERATIONS], dialogueOperations: [...DIALOGUE_OPERATIONS], maxSteps: 6, admissionTimeoutMs: ADMISSION_TIMEOUT_MS } });
    expect(JSON.parse(await readFile(p.projectConfig, "utf8"))).toEqual(generatedConfig(ownedRoot));
    expect(JSON.parse(await readFile(p.selection, "utf8"))).toEqual(selection(ownedRoot));
  } finally { await rm(ownedRoot, { recursive: true, force: true }); }
});
for (const path of [p.cwd, p.runtime, p.bundle, p.connection, join(root, "db"), p.GIT_CONFIG_GLOBAL]) {
  test(`rejects a link in owned path ${path.slice(root.length)}`, async () => {
    const base = io(); await denied(input(), io({ inspect: async (value) => value === path ? "symlink" : base.inspect(value) }));
  });
}
test("private file modes and the anchor's canonical identity are required", async () => {
  await denied(input(), io({ private: async (path) => path !== p.connection }));
  await denied(input(), io({ canonical: async () => "/other" }));
});
test("a prepared environment cannot gain host credentials, discovery, startup flags or non-loopback bind", async () => {
  const value = input(), spec = await preparePluginLaunch(value, io(), facts());
  const mutations: LaunchSpec[] = [
    { ...spec, env: { ...spec.env, OPENAI_API_KEY: "host-secret" } },
    { ...spec, env: { ...spec.env, HOME: "/host/private" } },
    { ...spec, env: { ...spec.env, OPENCODE_CONFIG_PROJECT_DISABLE: "0" } },
    { ...spec, env: { ...spec.env, OPENCODE_CONFIG: "/host/config" } },
    { ...spec, args: ["serve", "--hostname", "0.0.0.0", "--port", "0"] },
    { ...spec, args: ["--version"] },
  ];
  for (const changed of mutations) expect(() => validateLaunchSpec(changed, value)).toThrow();
});
test("native readiness accepts only the pinned complete loopback line and excludes app ports", () => {
  expect(readinessFromOutput("server listening on http://127.0.0.1:18493\n")).toBe("http://127.0.0.1:18493");
  for (const output of ["server listening on http://127.0.0.1:3001\n", "server listening on http://127.0.0.1:4174\n", "server listening on http://127.0.0.1:4318\n", "server listening on http://localhost:18493\n", "server listening on http://127.0.0.1:18493", "http://127.0.0.1:18493\n"]) expect(readinessFromOutput(output)).toBeUndefined();
});
test("native registry permits compiled-in code plus only the exact active owned plugin", () => {
  const plugin = { id: "thoughtloom", source: { type: "local", path: p.plugin }, state: { status: "active" } };
  expect(() => validatePluginRegistry(root, [{ id: "opencode.internal", source: { type: "builtin" }, state: { status: "active" } }, plugin])).not.toThrow();
  for (const value of [[], [plugin, plugin], [{ ...plugin, source: { type: "sdk" } }], [{ ...plugin, source: { type: "package", target: "thoughtloom-owned-plugin" } }],
    [{ ...plugin, source: { type: "local", path: "/tmp/other" } }], [{ ...plugin, state: { status: "failed" } }],
    [plugin, { id: "thoughtloom", source: { type: "builtin" } }]]) expect(() => validatePluginRegistry(root, value)).toThrow();
});
