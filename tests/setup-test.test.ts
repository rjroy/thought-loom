import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const firstToken = "aaaaaaaa-1111-4222-8333-444444444444";
const secondToken = "bbbbbbbb-1111-4222-8333-444444444444";
const fakeBun = [
  "#!/bin/bash",
  "set -eu",
  "printf '%s\\n' \"$*\" >> \"$FAKE_LOG\"",
  "printf '%s\\0' \"$PWD\" \"${THOUGHTLOOM_USER_TOKEN-}\" \"${THOUGHTLOOM_AI_TOKEN-}\" \"${THOUGHTLOOM_DB_PATH-}\" \"${THOUGHTLOOM_PORT-}\" \"${THOUGHTLOOM_DAEMON_URL-}\" \"${THOUGHTLOOM_AGENT_CONFIG-}\" > \"$FAKE_ENV\"",
  "case \"$*\" in *crypto.randomUUID*)",
  `  if [ ! -e "$FAKE_UUID_MARK" ]; then printf '%s\\n' '${firstToken}'; : > "$FAKE_UUID_MARK"; else printf '%s\\n' '${secondToken}'; fi; exit 0;;`,
  "esac",
  "if [ \"${1-}\" = '--no-env-file' ]; then shift; fi",
  "case \"${1-}:${2-}\" in",
  "  install:*) [ \"${FAKE_FAIL-}\" != install ] || exit 41; exit 0;;",
  "  run:build:spellfix) [ \"${FAKE_FAIL-}\" != spellfix ] || exit 42; exit 0;;",
  "  test:*) if [ \"${THOUGHTLOOM_AGENT_CONFIG+x}\" = x ]; then printf '%s\\n' present >> \"$FAKE_CHECK_ENV\"; else printf '%s\\n' absent >> \"$FAKE_CHECK_ENV\"; fi; [ \"${FAKE_FAIL-}\" != test ] || exit 43; exit 0;;",
  "  run:typecheck) [ \"${FAKE_FAIL-}\" != typecheck ] || exit 44; exit 0;;",
  "  run:daemon) exit 0;;",
  "esac",
  // Simulate the old SDK discovery path with an alternate test-owned selection.
  "if [ \"${1-}\" = -e ] && [[ \"${2-}\" = *Service.discover* ]]; then printf '%s\\n' \"$FAKE_DISCOVERY_CONFIG\"; exit 0; fi",
  // Execute only the model-free JSON construction, never SDK or network code.
  "if [ \"${1-}\" = -e ] && [[ \"${2-}\" != *import* ]] && [[ \"${2-}\" != *fetch* ]]; then exec \"$REAL_BUN\" --no-env-file \"$@\"; fi",
  "exit 45",
].join("\n") + "\n";

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, Bun.sleep(3000).then(() => { throw new Error(`${label} timed out`); })]);
}
async function command(argv: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const [code, stdout, stderr] = await bounded(Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]), "owned setup subprocess");
    return { code, stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await bounded(child.exited, "owned setup reap");
  }
}
async function fixture(action: (f: { root: string; script: string; log: string; envFile: string; env: Record<string, string> }) => Promise<void>) {
  const root = await mkdtemp(join("/tmp/opencode", "setup test owned-"));
  const scripts = join(root, "scripts"); const bin = join(root, "fake bin");
  try {
    await mkdir(scripts); await mkdir(bin); await mkdir(join(root, ".data"));
    const script = join(scripts, "setup-test.sh");
    await copyFile(fileURLToPath(new URL("../scripts/setup-test.sh", import.meta.url)), script);
    const projectScripts = fileURLToPath(new URL("../scripts/", import.meta.url));
    for (const name of await readdir(projectScripts)) if (/^[a-zA-Z0-9_-]+\.ts$/.test(name)) await copyFile(join(projectScripts, name), join(scripts, name));
    await writeFile(join(root, ".data", "thoughtloom.sqlite"), "test-owned existing database sentinel");
    await writeFile(join(bin, "bun"), fakeBun); await chmod(join(bin, "bun"), 0o700);
    const log = join(root, "fake-calls.log"); const envFile = join(root, "fake-env.bin");
    const discovered = { service: { discover: true }, directory: root, model: { providerID: "fixture-provider", id: "fixture-model" }, effort: { quick: "fixture-variant", standard: "fixture-variant", thorough: "fixture-variant" } };
    const env = { HOME: root, TMPDIR: root, PATH: `${bin}:/usr/bin:/bin`, REAL_BUN: process.execPath, FAKE_LOG: log, FAKE_ENV: envFile, FAKE_CHECK_ENV: join(root, "test-agent-config-state"), FAKE_UUID_MARK: join(root, "uuid-used"), FAKE_DISCOVERY_CONFIG: JSON.stringify(discovered) };
    await action({ root, script, log, envFile, env });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function launchEnv(f: { root: string; envFile: string; env: Record<string, string> }) {
  const result = await command(["/bin/bash", join(f.root, "scripts", "daemon.local.sh")], "/tmp/opencode", f.env);
  expect(result.code).toBe(0);
  const fields = (await readFile(f.envFile)).toString().split("\0");
  return { cwd: fields[0], user: fields[1], ai: fields[2], db: fields[3], port: fields[4], url: fields[5], agent: fields[6] };
}
async function launchers(root: string) {
  for (const name of ["daemon.local.sh", "demo.local.sh"]) {
    const path = join(root, "scripts", name);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    const syntax = await command(["/bin/bash", "-n", path], root, { PATH: "/usr/bin:/bin", HOME: root });
    expect(syntax.code).toBe(0);
    expect(await readFile(path, "utf8")).toMatch(/set\s+-[^\n]*e[^\n]*u|set\s+-euo\s+pipefail/);
  }
}

test("explicit agent config survives setup and private launcher quoting in a path with spaces", async () => fixture(async f => {
  const agent = JSON.stringify({ service: { url: "http://127.0.0.1:12345", token: "fixture 'quote' $HOME ; \"sensitive\"" }, directory: `${f.root}/workspace 'odd'`, model: { providerID: "fixture", id: "chosen" }, effort: { quick: null, standard: "variant with spaces", thorough: null } });
  const setup = await command(["/bin/bash", f.script], "/tmp/opencode", { ...f.env, THOUGHTLOOM_AGENT_CONFIG: agent });
  expect(setup.code).toBe(0);
  expect(setup.stdout + setup.stderr).not.toContain(firstToken);
  expect(setup.stdout + setup.stderr).not.toContain(secondToken);
  expect(setup.stdout + setup.stderr).not.toContain("sensitive");
  const setupCalls = (await readFile(f.log, "utf8")).split("\n");
  expect(setupCalls.some(value => /Service\.discover|session\.get|server\.config/i.test(value))).toBe(false);
  expect(await readFile(f.env.FAKE_CHECK_ENV, "utf8")).toBe("absent\n");
  await launchers(f.root);
  const values = await launchEnv(f);
  expect(values).toEqual({ cwd: f.root, user: firstToken, ai: secondToken, db: join(f.root, ".data", "thoughtloom.sqlite"), port: "3001", url: "http://127.0.0.1:3001", agent });
  expect(await readFile(join(f.root, ".data", "thoughtloom.sqlite"), "utf8")).toBe("test-owned existing database sentinel");
}));

test("generated demo declares a user-triggered Evolve and Agentic export smoke with a model-call warning", async () => fixture(async f => {
  const setup = await command(["/bin/bash", f.script], f.root, f.env);
  expect(setup.code).toBe(0);
  const launcher = await readFile(join(f.root, "scripts", "demo.local.sh"), "utf8");
  let smoke = launcher;
  // A small, directly referenced TypeScript helper is also permitted; never inspect generated local launchers outside this fixture.
  for (const match of launcher.matchAll(/\b([a-zA-Z0-9_-]+\.ts)\b/g)) {
    const name = match[1]; if (!name) continue;
    try { smoke += await readFile(join(f.root, "scripts", name), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  expect(smoke).toMatch(/\/thoughts/);
  expect(smoke).toMatch(/\/evolve/);
  expect(smoke).toMatch(/\/exports\/agentic/);
  expect(smoke).toMatch(/model|agent/i);
  expect(smoke).toMatch(/warn|may (?:call|invoke|use)|will (?:call|invoke|use)/i);
  expect(smoke).not.toMatch(/\/runs\/[^\s"'`]+\/stop/);
}));

test("absent config selects the OpenAI model and effort levels and builds spellfix before checks", async () => fixture(async f => {
  const setup = await command(["/bin/bash", f.script], f.root, f.env);
  expect(setup.code).toBe(0);
  await launchers(f.root);
  const calls = (await readFile(f.log, "utf8")).split("\n").filter(Boolean);
  const build = calls.findIndex(value => /\brun\s+build:spellfix\b/.test(value));
  const tests = calls.findIndex(value => /(?:^|\s)test(?:\s|$)/.test(value));
  const types = calls.findIndex(value => /\brun\s+typecheck\b/.test(value));
  expect(build).toBeGreaterThanOrEqual(0); expect(tests).toBeGreaterThan(build); expect(types).toBeGreaterThan(build);
  expect(calls.some(value => /Service\.ensure|service\.start|service\.stop/.test(value))).toBe(false);
  const values = await launchEnv(f);
  const config: unknown = JSON.parse(values.agent ?? "");
  expect(config).toEqual({ service: { discover: true }, directory: f.root, model: { providerID: "openai", id: "gpt-6.1-sol" }, effort: { quick: "low", standard: "medium", thorough: "high" } });
  expect(setup.stdout + setup.stderr).not.toContain(firstToken);
  expect(setup.stdout + setup.stderr).not.toContain(secondToken);
}));

test("a failed required check stops setup before launchers are produced", async () => fixture(async f => {
  const setup = await command(["/bin/bash", f.script], f.root, { ...f.env, FAKE_FAIL: "spellfix" });
  expect(setup.code).not.toBe(0);
  const calls = (await readFile(f.log, "utf8")).split("\n");
  expect(calls.some(value => /\brun\s+build:spellfix\b/.test(value))).toBe(true);
  expect(calls.some(value => /(?:^|\s)test(?:\s|$)/.test(value))).toBe(false);
  expect(calls.some(value => /\brun\s+typecheck\b/.test(value))).toBe(false);
  await expect(stat(join(f.root, "scripts", "daemon.local.sh"))).rejects.toThrow();
  await expect(stat(join(f.root, "scripts", "demo.local.sh"))).rejects.toThrow();
  expect(await readFile(join(f.root, ".data", "thoughtloom.sqlite"), "utf8")).toBe("test-owned existing database sentinel");
}));
