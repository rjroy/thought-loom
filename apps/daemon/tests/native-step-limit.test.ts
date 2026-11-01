import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionNativeSetup, readNativeSetupConfig } from "../src/native-setup";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp("/tmp/opencode/thoughtloom-step-limit-"); directories.push(path); return path; }
const selection = { registrationFile: "/fixture/registration.json", agent: "weaver", model: { providerID: "fixture", id: "model" }, operations: ["record_interpretation"] };
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected fixture object");
  return Object.fromEntries(Object.entries(value));
}
async function readJson(path: string) { return object(JSON.parse(await readFile(path, "utf8"))); }
async function agent(configFile: string) {
  const config = await readJson(configFile), agents = object(config.agents);
  return object(agents.weaver);
}
async function setup(dir: string, native: object) {
  const result: unknown = await Reflect.apply(provisionNativeSetup, undefined, [{ runtimeDirectory: join(dir, "runtime"), locationDirectory: join(dir, "location"), daemonOrigin: "http://127.0.0.1:19091", transportCredential: "fixture-only-secret", pluginEntry: "/fixture/plugin.js", native }]);
  const value = object(result);
  if (typeof value.configFile !== "string" || typeof value.nativeConfigFile !== "string") throw new Error("Missing setup paths");
  return { configFile: value.configFile, nativeConfigFile: value.nativeConfigFile };
}
async function cli(dir: string, maxSteps?: string) {
  const entry = join(dir, "fixture-plugin.ts");
  await writeFile(entry, "export default {}\n");
  const script = fileURLToPath(new URL("../../../scripts/setup-native.ts", import.meta.url));
  const cmd = [process.execPath, "--no-env-file", "run", script, "--runtime-directory", join(dir, "runtime"), "--location-directory", join(dir, "location"), "--daemon-origin", "http://127.0.0.1:19091", "--registration-file", join(dir, "registration.json"), "--agent", "weaver", "--provider", "fixture", "--model", "model", "--plugin-entry", entry, ...(maxSteps === undefined ? [] : ["--max-steps", maxSteps])];
  const child = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, XDG_CONFIG_HOME: join(dir, "xdg") } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr, nativeFile: join(dir, "runtime/native.json"), configFile: join(dir, "location/.opencode/opencode.json") };
}

test("native setup omits maxSteps and agent steps when no cap is selected", async () => {
  const dir = await directory(), result = await setup(dir, selection);
  expect(await readJson(result.nativeConfigFile)).not.toHaveProperty("maxSteps");
  expect(await agent(result.configFile)).not.toHaveProperty("steps");
  expect(await readNativeSetupConfig(result.nativeConfigFile)).not.toHaveProperty("maxSteps");
});

test("native configuration reader accepts an omitted cap without inventing a value", async () => {
  const dir = await directory(), file = join(dir, "native.json");
  await writeFile(file, JSON.stringify({ ...selection, location: join(dir, "location"), connectionFile: join(dir, "connection.json") }), { mode: 0o600 });
  const parsed = await readNativeSetupConfig(file);
  expect(parsed).not.toHaveProperty("maxSteps");
  expect(parsed).toMatchObject({ agent: "weaver", operations: ["record_interpretation"] });
});

test("native setup preserves explicit valid integer caps and rejects invalid caps", async () => {
  for (const maxSteps of [1, 20, 100]) {
    const dir = await directory(), result = await setup(dir, { ...selection, maxSteps });
    expect(await readJson(result.nativeConfigFile)).toMatchObject({ maxSteps });
    expect(await readNativeSetupConfig(result.nativeConfigFile)).toMatchObject({ maxSteps });
    expect(await agent(result.configFile)).toMatchObject({ steps: maxSteps });
  }
  for (const maxSteps of [0, 101, -1, 1.5, null, "20"]) {
    await expect(setup(await directory(), { ...selection, maxSteps })).rejects.toMatchObject({ code: "invalid_configuration" });
  }
});

test("setup CLI without --max-steps emits no cap in either generated file", async () => {
  const result = await cli(await directory());
  expect(result.exitCode).toBe(0);
  expect(await readJson(result.nativeFile)).not.toHaveProperty("maxSteps");
  expect(await agent(result.configFile)).not.toHaveProperty("steps");
  expect(await readNativeSetupConfig(result.nativeFile)).not.toHaveProperty("maxSteps");
});

test("setup CLI preserves explicit integer limits and rejects malformed limits", async () => {
  for (const maxSteps of ["1", "20", "100"]) {
    const result = await cli(await directory(), maxSteps);
    expect(result.exitCode).toBe(0);
    expect(await readJson(result.nativeFile)).toMatchObject({ maxSteps: Number(maxSteps) });
    expect(await agent(result.configFile)).toMatchObject({ steps: Number(maxSteps) });
    expect(await readNativeSetupConfig(result.nativeFile)).toMatchObject({ maxSteps: Number(maxSteps) });
  }
  for (const maxSteps of ["0", "101", "1.5", "not-a-number"]) {
    const result = await cli(await directory(), maxSteps);
    expect(result.exitCode).not.toBe(0);
  }
});
