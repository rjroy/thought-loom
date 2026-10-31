// Adapted, not broadened in place, from memory-loop checkpoint
// 0b2343c94f4313ed6e86440031e15ee8cc7d459c:
// tests/opencode/isolation.ts (blob ed95fc4630d8ed6a651c068e67cff9fc464221ef)
// tests/opencode/readiness.ts (blob 0c4a4023558362b3f5ee754ac50d8547c1804ef2).
// This single profile permits exactly one reviewed first-party local bundle.
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { BUNDLE_SHA256 } from "./plugin-provenance";
export { BUNDLE_SHA256, SOURCE_HASHES } from "./plugin-provenance";

export const ANCHOR = "/tmp/opencode";
export const ROOT_PREFIX = "thoughtloom-plugin-witness-";
export const NATIVE_BINARY = "/home/rjroy/.local/share/mise/installs/npm-opencode-cli/2.2.2/node_modules/.mise/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe";
// Operator-supplied installation digest, not a publisher-signature claim.
export const NATIVE_SHA256 = "4452778e23fbda075eb2f83c2574b1d7452af8e347c52b8d9e016838b9c530d9";
export const AGENT = "fixture_weaver";
export const OPERATIONS = ["read_source", "record_interpretation"] as const;
export const DIALOGUE_OPERATIONS = ["read_source", "record_idea"] as const;
const agentOperations = ["read_source", "record_interpretation", "record_idea"] as const;
export const MODEL = { providerID: "fixture-provider", id: "fixture-model" } as const;
const forbiddenPorts = new Set([3000, 3001, 9443, 4173, 4317, 48763]);

export class WitnessGuardError extends Error {
  constructor(readonly code: string) { super(code); this.name = "WitnessGuardError"; }
}
function requireGuard(condition: unknown, code: string): asserts condition {
  if (!condition) throw new WitnessGuardError(code);
}
export function requireOptIn(optIn: string | undefined, executable: string | undefined) {
  requireGuard(optIn === "1" && executable === NATIVE_BINARY, "explicit_opt_in_required");
}
export function contained(root: string, path: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) return false;
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function origin(value: string) {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value);
  return !!match && Number(match[1]) <= 65535 && !forbiddenPorts.has(Number(match[1]));
}
export function readinessFromOutput(output: string): string | undefined {
  const match = /(?:^|\n)server listening on (http:\/\/127\.0\.0\.1:[1-9]\d{0,4})\r?\n/.exec(output);
  return match && origin(match[1]) ? match[1] : undefined;
}
export function pathsFor(root: string) {
  return {
    cwd: join(root, "location"), runtime: join(root, "runtime"), plugin: join(root, "runtime/plugin"),
    bundle: join(root, "runtime/plugin/index.js"), package: join(root, "runtime/plugin/package.json"),
    connection: join(root, "runtime/connection.json"), selection: join(root, "runtime/native.json"),
    projectConfig: join(root, "location/.opencode/opencode.json"), registration: join(root, "registration.json"),
    HOME: join(root, "home"), OPENCODE_TEST_HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"), OPENCODE_CONFIG_DIR: join(root, "config"),
    OPENCODE_DB: join(root, "db/native.sqlite"), GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"),
  };
}
const directories = ["HOME", "OPENCODE_TEST_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "OPENCODE_CONFIG_DIR"] as const;
export function permissions() {
  // Agent ceiling only. Each fresh session receives its narrower capture or
  // dialogue rules from the production adapter; capture must not advertise idea.
  return [{ action: "*", resource: "*", effect: "deny" }, ...agentOperations.map((action) => ({ action, resource: "*", effect: "allow" }))];
}
export function generatedConfig(root: string) {
  const p = pathsFor(root);
  return { plugins: [{ package: p.plugin, options: { connectionFile: p.connection, sourceEntry: p.bundle } }],
    agents: { [AGENT]: { mode: "primary", description: "Thoughtloom constrained domain weaver", steps: 6, permissions: permissions() } } };
}
export function selection(root: string) {
  const p = pathsFor(root);
  return { registrationFile: p.registration, agent: AGENT, model: MODEL, operations: [...OPERATIONS], dialogueOperations: [...DIALOGUE_OPERATIONS], maxSteps: 6,
    location: p.cwd, connectionFile: p.connection };
}
export function witnessConfig(root: string, providerOrigin: string) {
  return {
    model: "fixture-provider/fixture-model", update: "disable", share: "disabled", snapshots: false, warming: false,
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
    compaction: { auto: false, keep: { tokens: 0 }, buffer: 0 },
    providers: { "fixture-provider": { env: [], package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${providerOrigin}/v1`, apiKey: "fixture-only" },
      models: { "fixture-model": { type: "chat", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 131072, output: 2048 } } } } },
    ...generatedConfig(root),
  };
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new WitnessGuardError("invalid_fixture_json");
}
function sameJson(actual: string, expected: unknown) {
  try { return canonical(JSON.parse(actual)) === canonical(expected); } catch { return false; }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Metadata = "directory" | "file" | "symlink" | "missing" | "error";
export type GuardIO = {
  inspect(path: string): Promise<Metadata>; canonical(path: string): Promise<string>;
  text(path: string): Promise<string>; hash(path: string): Promise<string>; entries(path: string): Promise<string[]>;
  private(path: string): Promise<boolean>;
};
export type BinaryFacts = {
  executable: string; canonical: boolean; regularExecutable: boolean; elf: boolean; sha256: string;
  cliName: string; cliVersion: string; platformName: string; platformVersion: string; siblingMatches: boolean;
};
export function validateBinary(facts: BinaryFacts) {
  requireGuard(facts.executable === NATIVE_BINARY && facts.canonical && facts.regularExecutable && facts.elf &&
    facts.sha256 === NATIVE_SHA256 && facts.cliName === "@opencode/cli" && facts.cliVersion === "2.2.2" &&
    facts.platformName === "@opencode/cli-linux-x64" && facts.platformVersion === "2.2.2" && facts.siblingMatches, "binary_provenance_rejected");
}
// V2 also lists its compiled-in plugins (supervisor.ts/internal.ts at the pinned
// revision). They are covered by the binary digest, not extra configured code.
// No SDK/package/second local plugin is allowed in this fixture registry.
export function validatePluginRegistry(root: string, value: unknown): void {
  requireGuard(Array.isArray(value), "fixture_plugin_registry_rejected");
  const external: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    requireGuard(record(entry) && record(entry.source) && typeof entry.source.type === "string", "fixture_plugin_registry_rejected");
    if (entry.source.type !== "builtin") external.push(entry);
    else requireGuard(entry.id !== "thoughtloom", "fixture_plugin_registry_rejected");
  }
  const plugin = external[0];
  requireGuard(external.length === 1 && plugin?.id === "thoughtloom" && record(plugin.source) && plugin.source.type === "local" &&
    plugin.source.path === pathsFor(root).plugin && record(plugin.state) && plugin.state.status === "active", "fixture_plugin_registry_rejected");
}
export type GuardInput = {
  optIn: string | undefined; executable: string | undefined; root: string; config: string;
  providerOrigin: string; daemonOrigin: string; password: string; transportCredential: string;
};
export type LaunchSpec = { executable: string; args: string[]; cwd: string; env: Record<string, string> };
function environment(input: GuardInput) {
  const p = pathsFor(input.root);
  const env: Record<string, string> = {};
  for (const key of directories) env[key] = p[key];
  return { ...env, OPENCODE_DB: p.OPENCODE_DB, GIT_CONFIG_GLOBAL: p.GIT_CONFIG_GLOBAL,
    OPENCODE_CONFIG_CONTENT: input.config, OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FILEWATCHER: "1", OPENCODE_DISABLE_FFF: "1",
    OPENCODE_PASSWORD: input.password, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" };
}
export function validateLaunchSpec(spec: LaunchSpec, input: GuardInput) {
  requireGuard(spec.executable === NATIVE_BINARY && spec.cwd === pathsFor(input.root).cwd &&
    canonical(spec.args) === canonical(["serve", "--hostname", "127.0.0.1", "--port", "0"]) &&
    canonical(spec.env) === canonical(environment(input)), "launch_spec_rejected");
}
async function checkedPath(root: string, path: string, expected: "directory" | "file" | "missing", io: GuardIO) {
  requireGuard(contained(root, path), "fixture_path_escape");
  const parts = relative(root, path).split(sep);
  let current = root;
  requireGuard(await io.inspect(root) === "directory", "fixture_root_rejected");
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    requireGuard(await io.inspect(current) === (i === parts.length - 1 ? expected : "directory"), "fixture_path_rejected");
  }
}

export async function preparePluginLaunch(input: GuardInput, io: GuardIO, facts: BinaryFacts): Promise<LaunchSpec> {
  const snapshot = { ...input };
  requireOptIn(snapshot.optIn, snapshot.executable);
  validateBinary({ ...facts });
  requireGuard(contained(ANCHOR, snapshot.root) && new RegExp(`^${ROOT_PREFIX}[A-Za-z0-9_-]{6,64}$`).test(relative(ANCHOR, snapshot.root)), "fixture_root_rejected");
  requireGuard(origin(snapshot.providerOrigin) && origin(snapshot.daemonOrigin) && snapshot.providerOrigin !== snapshot.daemonOrigin &&
    /^[A-Za-z0-9_-]{24,128}$/.test(snapshot.password) && /^[A-Za-z0-9_-]{24,128}$/.test(snapshot.transportCredential) && snapshot.password !== snapshot.transportCredential, "fixture_boundary_rejected");
  requireGuard(sameJson(snapshot.config, witnessConfig(snapshot.root, snapshot.providerOrigin)), "fixture_config_rejected");
  requireGuard(await io.inspect("/etc/opencode") === "missing", "system_config_not_absent");
  requireGuard(await io.inspect(ANCHOR) === "directory" && await io.canonical(ANCHOR) === ANCHOR && await io.canonical(snapshot.root) === snapshot.root, "fixture_anchor_rejected");
  requireGuard(await io.private(snapshot.root), "fixture_permissions_rejected");
  const p = pathsFor(snapshot.root);
  for (const key of directories) {
    await checkedPath(snapshot.root, p[key], "directory", io);
    requireGuard(await io.private(p[key]), "fixture_permissions_rejected");
    requireGuard((await io.entries(p[key])).length === 0, "unexpected_discovery_content");
  }
  for (const path of [p.cwd, p.runtime, p.plugin, join(p.cwd, ".opencode")]) await checkedPath(snapshot.root, path, "directory", io);
  for (const path of [p.bundle, p.package, p.connection, p.projectConfig, p.selection, p.GIT_CONFIG_GLOBAL]) await checkedPath(snapshot.root, path, "file", io);
  for (const path of [p.cwd, p.runtime, p.plugin, p.connection, p.selection]) requireGuard(await io.private(path), "fixture_permissions_rejected");
  await checkedPath(snapshot.root, p.OPENCODE_DB, "missing", io);
  await checkedPath(snapshot.root, p.registration, "missing", io);
  requireGuard(canonical((await io.entries(p.plugin)).sort()) === canonical(["index.js", "package.json"]) &&
    canonical((await io.entries(p.runtime)).sort()) === canonical(["connection.json", "native.json", "plugin"]) &&
    canonical((await io.entries(p.cwd)).sort()) === canonical([".opencode"]) &&
    canonical((await io.entries(join(p.cwd, ".opencode"))).sort()) === canonical(["opencode.json"]), "unexpected_plugin_files");
  requireGuard(await io.hash(p.bundle) === BUNDLE_SHA256, "plugin_bundle_hash_rejected");
  requireGuard(sameJson(await io.text(p.package), { name: "thoughtloom-owned-plugin", type: "module", exports: { ".": "./index.js" } }) &&
    sameJson(await io.text(p.connection), { url: snapshot.daemonOrigin, location: p.cwd, transportCredential: snapshot.transportCredential }) &&
    sameJson(await io.text(p.projectConfig), generatedConfig(snapshot.root)) && sameJson(await io.text(p.selection), selection(snapshot.root)) &&
    await io.text(p.GIT_CONFIG_GLOBAL) === "", "generated_artifact_rejected");
  const spec = { executable: NATIVE_BINARY, args: ["serve", "--hostname", "127.0.0.1", "--port", "0"], cwd: p.cwd, env: environment(snapshot) };
  validateLaunchSpec(spec, snapshot);
  return spec;
}

export async function guardedLaunch<T>(input: GuardInput, io: GuardIO, facts: BinaryFacts, launch: (spec: LaunchSpec) => Promise<T>): Promise<T> {
  const snapshot = { ...input };
  const spec = await preparePluginLaunch(snapshot, io, facts);
  validateLaunchSpec(spec, snapshot);
  return launch(spec);
}
