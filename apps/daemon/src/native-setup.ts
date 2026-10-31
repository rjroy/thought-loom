import { constants } from "node:fs";
import { lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { DOMAIN_ACTIONS, loopbackOrigin, toolId, toolRecord, type ToolAction } from "@thoughtloom/contracts";

export class NativeSetupError extends Error {
  constructor(readonly code: "invalid_configuration" | "unsafe_path" | "setup_failed") { super(code); this.name = "NativeSetupError"; }
}
export type NativeSetupConfig = {
  registrationFile: string; location: string; connectionFile: string; agent: string;
  model: { providerID: string; id: string; variant?: string }; operations: ToolAction[]; maxSteps: number;
};
type Selection = Omit<NativeSetupConfig, "location" | "connectionFile">;

function contained(parent: string, child: string) {
  const part = relative(parent, child);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}
function absolute(value: string) { return !!value && isAbsolute(value) && normalize(value) === value && !value.includes("\0"); }

function parseSelection(value: unknown): Selection {
  if (!toolRecord(value) || typeof value.registrationFile !== "string" || !absolute(value.registrationFile) || !toolId(value.agent) ||
      !toolRecord(value.model) || !toolId(value.model.providerID) || !toolId(value.model.id) ||
      (value.model.variant !== undefined && !toolId(value.model.variant)) || !Array.isArray(value.operations) || !value.operations.length ||
      !value.operations.every((action): action is ToolAction => typeof action === "string" && DOMAIN_ACTIONS.some((allowed) => allowed === action)) ||
      new Set(value.operations).size !== value.operations.length || typeof value.maxSteps !== "number" || !Number.isSafeInteger(value.maxSteps) || value.maxSteps < 1 || value.maxSteps > 100) {
    throw new NativeSetupError("invalid_configuration");
  }
  return { registrationFile: value.registrationFile, agent: value.agent,
    model: { providerID: value.model.providerID, id: value.model.id, ...(value.model.variant ? { variant: value.model.variant } : {}) },
    operations: [...value.operations], maxSteps: value.maxSteps };
}

// This reader never provisions files and never contacts OpenCode.
export async function readNativeSetupConfig(path: string): Promise<NativeSetupConfig> {
  if (!absolute(path)) throw new NativeSetupError("invalid_configuration");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 16_384 || (process.getuid && stat.uid !== process.getuid())) throw new NativeSetupError("unsafe_path");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    const selected = parseSelection(value);
    if (!toolRecord(value) || typeof value.location !== "string" || !absolute(value.location) || typeof value.connectionFile !== "string" || !absolute(value.connectionFile)) throw new NativeSetupError("invalid_configuration");
    return { ...selected, location: value.location, connectionFile: value.connectionFile };
  } catch (error) { throw error instanceof NativeSetupError ? error : new NativeSetupError("invalid_configuration"); }
  finally { await handle.close(); }
}

async function existing(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if (toolRecord(error) && error.code === "ENOENT") return null;
    throw new NativeSetupError("unsafe_path");
  }
}
function components(path: string) {
  const root = parse(path).root;
  const result: string[] = [];
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) { current = resolve(current, part); result.push(current); }
  return result;
}
async function preflight(path: string) {
  for (const part of components(path)) {
    const stat = await existing(part);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || part === path)) throw new NativeSetupError("unsafe_path");
  }
}

// Offline configuration generation. The CLI supplies a self-contained bundle;
// callers may instead name an explicitly provisioned module. Neither form is a
// native loading witness, and configured plugin targets are always directories.
export async function provisionNativeSetup(options: {
  runtimeDirectory: string; locationDirectory: string; daemonOrigin: string; transportCredential: string;
  pluginEntry: string; pluginBundle?: string; native?: Selection;
}): Promise<{ connectionFile: string; locationDirectory: string; configFile: string; nativeConfigFile?: string }> {
  const { runtimeDirectory: runtime, locationDirectory: location } = options;
  if (![runtime, location, options.pluginEntry].every(absolute) || !loopbackOrigin(options.daemonOrigin) ||
      options.transportCredential.length < 16 || options.transportCredential.length > 256 || /\s/u.test(options.transportCredential)) throw new NativeSetupError("invalid_configuration");
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const globals = [resolve(homedir(), ".config/opencode"), resolve(homedir(), ".opencode"), resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "opencode")];
  if (contained(runtime, location) || contained(location, runtime) || [runtime, location].some((path) =>
    path === parse(path).root || path === homedir() || contained(repo, path) || globals.some((global) => contained(global, path)))) throw new NativeSetupError("unsafe_path");
  const native = options.native ? parseSelection(options.native) : undefined;
  await preflight(runtime); await preflight(location);
  const directories: string[] = [], files: string[] = [];
  async function directory(path: string, fresh = false) {
    for (const part of components(path)) {
      const stat = await existing(part);
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink() || (fresh && part === path && !directories.includes(part))) throw new NativeSetupError("unsafe_path");
        continue;
      }
      await mkdir(part, { mode: 0o700 }); directories.push(part);
    }
  }
  async function write(path: string, content: string) {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    files.push(path);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  }
  console.info("native.setup attempt");
  try {
    await directory(runtime, true); await directory(location, true);
    const pluginDirectory = resolve(runtime, "plugin"), configDirectory = resolve(location, ".opencode");
    await directory(pluginDirectory, true); await directory(configDirectory, true);
    const connectionFile = resolve(runtime, "connection.json"), configFile = resolve(configDirectory, "opencode.json");
    await write(connectionFile, JSON.stringify({ url: loopbackOrigin(options.daemonOrigin), location, transportCredential: options.transportCredential }));
    await write(resolve(pluginDirectory, "package.json"), JSON.stringify({ name: "thoughtloom-owned-plugin", type: "module", exports: { ".": "./index.js" } }));
    await write(resolve(pluginDirectory, "index.js"), options.pluginBundle ?? `export { default } from ${JSON.stringify(pathToFileURL(options.pluginEntry).href)};\n`);
    const permissions = [{ action: "*", resource: "*", effect: "deny" }, ...(native?.operations ?? DOMAIN_ACTIONS).map((action) => ({ action, resource: "*", effect: "allow" }))];
    await write(configFile, JSON.stringify({ plugins: [{ package: pluginDirectory, options: { connectionFile, sourceEntry: options.pluginEntry } }],
      ...(native ? { agents: { [native.agent]: { mode: "primary", description: "Thoughtloom constrained domain weaver", steps: native.maxSteps, permissions } } } : {}) }, null, 2));
    const nativeConfigFile = native ? resolve(runtime, "native.json") : undefined;
    if (nativeConfigFile) await write(nativeConfigFile, JSON.stringify({ ...native, location, connectionFile }, null, 2));
    console.info("native.setup succeeded", { nativeSelection: !!native });
    return { connectionFile, configFile, locationDirectory: location, ...(nativeConfigFile ? { nativeConfigFile } : {}) };
  } catch (error) {
    // Remove only entries this invocation created. Nonempty/raced directories
    // are never recursively removed, and existing user files are never replaced.
    for (const file of files.reverse()) { try { await unlink(file); } catch { /* retain on cleanup failure */ } }
    for (const directory of directories.reverse()) { try { await rmdir(directory); } catch { /* never erase foreign entries */ } }
    console.error("native.setup failed", { category: error instanceof NativeSetupError ? error.code : "filesystem_error" });
    throw error instanceof NativeSetupError ? error : new NativeSetupError("setup_failed");
  }
}
