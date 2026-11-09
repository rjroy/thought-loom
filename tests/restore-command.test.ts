import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRestoreCommand } from "../scripts/restore";
import { createLogger, type LogRecord } from "../src/logging";

const snapshot = "/tmp/opencode/owned-private-snapshot/snapshot";
const target = "/tmp/opencode/owned-private-recovered";
const digest = "a".repeat(64);
const restoredAt = "2030-01-02T03:04:05.000Z";
const args = ["--snapshot", snapshot, "--target", target];
const result = { targetDirectory: target, databasePath: `${target}/thoughtloom.sqlite`,
  mediaDirectory: `${target}/thoughtloom.sqlite.media`, manifestSha256: digest, restoredAt };
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("restore command fixture timed out")), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test("closed arguments reject malformed requests before invoking restore", async () => {
  const badArgs: readonly (readonly string[])[] = [
    [], ["--snapshot", snapshot], ["--target", target],
    [...args, "--unknown"], [...args, "extra"],
    [...args, "--snapshot", snapshot], [...args, "--target", target],
    [...args, "--manifest-sha256", digest, "--manifest-sha256", digest],
    ["--snapshot", "--target", target], ["--snapshot", snapshot, "--target"],
    ["--snapshot", "relative/snapshot", "--target", target],
    ["--snapshot", snapshot, "--target", "relative/target"],
    ["--snapshot", "", "--target", target], ["--snapshot", snapshot, "--target", ""],
    ["--snapshot", `${snapshot}\0bad`, "--target", target],
    [...args, "--manifest-sha256"], [...args, "--manifest-sha256", "a".repeat(63)],
    [...args, "--manifest-sha256", "A".repeat(64)], [...args, "--manifest-sha256", "g".repeat(64)],
  ];
  const records: LogRecord[] = [], logger = createLogger("verbose", record => records.push(record));
  let calls = 0;
  for (const invalid of badArgs) {
    expect(await runRestoreCommand(invalid, {}, { logger, now: () => restoredAt,
      restore: async () => { calls++; return result; } })).toBe(1);
  }
  expect(calls).toBe(0);
  expect(JSON.stringify(records)).not.toContain(snapshot);
  expect(JSON.stringify(records)).not.toContain(target);
});

test("explicit arguments, clock and signal reach only the injected restore service", async () => {
  const records: LogRecord[] = [], logger = createLogger("verbose", record => records.push(record));
  const controller = new AbortController();
  // A hostile supplied configuration must not be parsed or passed to the restore operation.
  const env = { THOUGHTLOOM_LOG_LEVEL: "verbose", THOUGHTLOOM_BACKUP_CONFIG: "private-backup-secret",
    THOUGHTLOOM_AGENT_CONFIG: "private-agent-secret", THOUGHTLOOM_DB_PATH: "/private/daemon-database",
    THOUGHTLOOM_USER_TOKEN: "private-role-secret" };
  let calls = 0;
  const code = await runRestoreCommand(["--target", target, "--manifest-sha256", digest, "--snapshot", snapshot], env, {
    logger, signal: controller.signal, now: () => restoredAt,
    restore: async options => {
      calls++;
      expect(options).toEqual({ snapshotDirectory: snapshot, targetDirectory: target, expectedManifestSha256: digest,
        restoredAt, signal: controller.signal, logger });
      return result;
    },
  });
  expect(code).toBe(0); expect(calls).toBe(1);
  const logs = JSON.stringify(records);
  for (const privateValue of [snapshot, target, env.THOUGHTLOOM_BACKUP_CONFIG, env.THOUGHTLOOM_AGENT_CONFIG,
    env.THOUGHTLOOM_DB_PATH, env.THOUGHTLOOM_USER_TOKEN]) expect(logs).not.toContain(privateValue);
});

test("operation failure, uncertain publication and cancellation exit nonzero without logging private exceptions", async () => {
  const records: LogRecord[] = [], logger = createLogger("verbose", record => records.push(record));
  for (const failure of ["private payload from invalid snapshot", "publication-uncertain private payload"]) {
    expect(await runRestoreCommand(args, {}, { logger, now: () => restoredAt,
      restore: async () => { throw new Error(`${failure} ${snapshot} ${target}`); } })).toBe(1);
  }
  const cancelled = new AbortController(); cancelled.abort(); let entered = false;
  expect(await runRestoreCommand(args, {}, { logger, signal: cancelled.signal, now: () => restoredAt,
    restore: async () => { entered = true; return result; } })).toBe(1);
  expect(entered).toBe(false);

  let release = () => {}, enteredOperation = () => {};
  const reached = new Promise<void>(resolve => { enteredOperation = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController(); let settled = false;
  const command = runRestoreCommand(args, {}, { logger, signal: controller.signal, now: () => restoredAt,
    restore: async options => { enteredOperation(); await gate; if (options.signal?.aborted) throw new Error("private abort reason"); return result; },
  }).then(code => { settled = true; return code; });
  try {
    await bounded(reached); controller.abort(); await Promise.resolve();
    expect(settled).toBe(false);
    release(); expect(await bounded(command)).toBe(1);
  } finally { release(); await bounded(command); }
  const logs = JSON.stringify(records);
  for (const secret of [snapshot, target, "private payload", "private abort reason"]) expect(logs).not.toContain(secret);
});

test("confirmed publication succeeds even if cancellation arrives immediately before the service returns", async () => {
  const records: LogRecord[] = [], logger = createLogger("verbose", record => records.push(record));
  const controller = new AbortController(); let calls = 0;
  const code = await runRestoreCommand(args, {}, { logger, signal: controller.signal, now: () => restoredAt,
    restore: async options => {
      calls++;
      expect(options.signal).toBe(controller.signal);
      expect(controller.signal.aborted).toBe(false);
      controller.abort();
      return result;
    },
  });
  expect(calls).toBe(1); expect(controller.signal.aborted).toBe(true); expect(code).toBe(0);
  const logs = JSON.stringify(records);
  expect(logs).not.toContain(snapshot); expect(logs).not.toContain(target);
  expect(records.some(record => record.level === "error")).toBe(false);
});

test("invalid log level fails before restore", async () => {
  let calls = 0;
  const logger = createLogger("verbose", () => {});
  expect(await runRestoreCommand(args, { THOUGHTLOOM_LOG_LEVEL: "owned-invalid" }, { logger, now: () => restoredAt,
    restore: async () => { calls++; return result; } })).toBe(1);
  expect(calls).toBe(0);
});

test("import is inert and the no-env-file entry does not load an owned dotenv", async () => {
  const dir = await mkdtemp("/tmp/opencode/restore-command-"), script = fileURLToPath(new URL("../scripts/restore.ts", import.meta.url));
  try {
    await writeFile(join(dir, ".env"), "RESTORE_TEST_DOTENV=private-dotenv-sentinel\n", { mode: 0o600 });
    const code = `const before=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];\n` +
      `const module=await import(${JSON.stringify(script)});\n` +
      `if(typeof module.runRestoreCommand!=='function'||process.env.RESTORE_TEST_DOTENV!==undefined||` +
      `before[0]!==process.listenerCount('SIGINT')||before[1]!==process.listenerCount('SIGTERM')) process.exitCode=1;`;
    const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", "-e", code], cwd: dir,
      env: { PATH: "/usr/bin:/bin", HOME: dir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).toBe(0); expect(stdout + stderr).not.toContain("private-dotenv-sentinel");
      await expect(access(join(dir, "thoughtloom.sqlite"))).rejects.toThrow();
    } finally { clearTimeout(timer); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);
