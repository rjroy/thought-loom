import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { provisionNativeSetup } from "../src/native-setup";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("explicit setup produces private app-owned plugin configuration outside the repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-owned-setup-"));
  directories.push(directory);
  const setup = await provisionNativeSetup({ runtimeDirectory: join(directory, "runtime"), locationDirectory: join(directory, "location"), daemonOrigin: "http://127.0.0.1:4318", transportCredential: "fixture-only-secret", pluginEntry: "/fixture/plugin.js" });
  expect(isAbsolute(setup.connectionFile)).toBe(true);
  expect(relative(directory, setup.connectionFile).startsWith(".." )).toBe(false);
  expect(relative(directory, setup.configFile).startsWith(".." )).toBe(false);
  expect((await stat(setup.connectionFile)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(setup.connectionFile, "utf8"))).toMatchObject({ url: "http://127.0.0.1:4318", location: setup.locationDirectory, transportCredential: "fixture-only-secret" });
  const config = await readFile(setup.configFile, "utf8");
  expect(config).toContain("/fixture/plugin.js");
  expect(config).not.toContain("fixture-only-secret");
});

test("setup rejects missing explicit input without writing a fallback project configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-owned-setup-"));
  directories.push(directory);
  await expect(provisionNativeSetup({ runtimeDirectory: join(directory, "runtime"), locationDirectory: join(directory, "location"), daemonOrigin: "", transportCredential: "", pluginEntry: "" })).rejects.toMatchObject({ code: "invalid_configuration" });
  await expect(stat(join(directory, ".opencode"))).rejects.toMatchObject({ code: "ENOENT" });
});
