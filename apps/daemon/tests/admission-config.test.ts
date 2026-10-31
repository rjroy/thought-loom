import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionNativeSetup, readNativeSetupConfig } from "../src/native-setup";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const selection = { registrationFile: "/fixture/registration.json", agent: "weaver", model: { providerID: "fixture", id: "fixture" }, operations: ["record_interpretation" as const], maxSteps: 8 };

test("native configuration defaults the admission deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thoughtloom-admission-config-")); directories.push(dir);
  const file = join(dir, "native.json");
  async function read(value: object) {
    await writeFile(file, JSON.stringify({ ...selection, location: join(dir, "location"), connectionFile: join(dir, "connection.json"), ...value }), { mode: 0o600 });
    return readNativeSetupConfig(file);
  }
  expect(await read({})).toMatchObject({ admissionTimeoutMs: 15_000 });
});

test("native configuration retains valid admission deadlines and rejects out-of-bounds inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thoughtloom-admission-config-")); directories.push(dir);
  const file = join(dir, "native.json");
  async function read(value: object) {
    await writeFile(file, JSON.stringify({ ...selection, location: join(dir, "location"), connectionFile: join(dir, "connection.json"), ...value }), { mode: 0o600 });
    return readNativeSetupConfig(file);
  }
  for (const admissionTimeoutMs of [1_000, 23_000, 120_000]) expect(await read({ admissionTimeoutMs })).toMatchObject({ admissionTimeoutMs });
  for (const admissionTimeoutMs of [999, 120_001, 1.5, -1, "15000", null]) await expect(read({ admissionTimeoutMs })).rejects.toMatchObject({ code: "invalid_configuration" });
});

test("offline setup preserves the explicitly selected admission deadline in the private config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thoughtloom-admission-provision-")); directories.push(dir);
  const native = { ...selection, admissionTimeoutMs: 23_000 };
  const result = await provisionNativeSetup({ runtimeDirectory: join(dir, "runtime"), locationDirectory: join(dir, "location"), daemonOrigin: "http://127.0.0.1:4318", transportCredential: "fixture-only-credential", pluginEntry: join(dir, "plugin.js"), native });
  expect(result.nativeConfigFile).toBeDefined();
  if (!result.nativeConfigFile) throw new Error("Expected private fixture configuration");
  expect(await readNativeSetupConfig(result.nativeConfigFile)).toMatchObject({ admissionTimeoutMs: 23_000 });
});
