// Owned second process for delivery retry; it receives only test-owned paths and metadata.
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { deliverBackup, type GitInvocation, type GitResult } from "../src/backup/git";
import type { CaptureResult } from "../src/backup/capture";
import type { BackupConfig } from "../src/backup/config";
import { createLogger } from "../src/logging";
import { runBackupGit } from "../src/backup/git-process";

const [home, bare, rawConfig, rawSnapshot, marker, mode] = process.argv.slice(2);
if (!home || !bare || !rawConfig || !rawSnapshot) throw new Error("Owned retry fixture inputs required");
if (mode === "umask-002") process.umask(0o002);
if (mode === "umask-077") process.umask(0o077);
const config = JSON.parse(rawConfig) as BackupConfig, snapshot = JSON.parse(rawSnapshot) as CaptureResult;
const redirect = `url.${pathToFileURL(bare).href}.insteadOf=${config.repositoryUrl}`;
async function runGit(invocation: GitInvocation): Promise<GitResult> {
  if (marker) writeFileSync(`${marker}.git`, "entered", { mode: 0o600 });
  const child = Bun.spawn({ cmd: ["git", "-c", redirect, ...invocation.args], cwd: invocation.cwd, signal: invocation.signal,
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
      PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid",
      GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid",
    } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}
const isUmaskTest = mode === "umask-002" || mode === "umask-077";
const runner = isUmaskTest ? (invocation: GitInvocation) => runBackupGit({ ...invocation,
  // Only the owned fixture URL is mapped to the owned local bare repository.
  args: ["-c", "protocol.file.allow=always", "-c", redirect, ...invocation.args],
}) : runGit;
let initFinished = false;
try {
  const result = await deliverBackup({ snapshot, config, logger: createLogger("verbose", record => {
    if (marker && record.message === "[backup git] checkout lock acquisition attempt") writeFileSync(`${marker}.attempt`, "entered", { mode: 0o600 });
    if (record.message === "[backup git] command finished" && record.context?.operation === "init" && record.context.exitCode === 0) initFinished = true;
  }) }, { runGit: runner });
  console.log(JSON.stringify(result));
} catch (error) {
  if (!isUmaskTest) throw error;
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
  console.error(JSON.stringify({ code, initFinished }));
  process.exitCode = 1;
}
