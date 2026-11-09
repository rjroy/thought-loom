import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { BackupConfig } from "../src/backup/config";
import type { GitInvocation, GitResult } from "../src/backup/git";
import { runBackupAttempt } from "../src/backup/run";
import { createLogger } from "../src/logging";

const [home, bare, databasePath, mediaDirectory, rawConfig, marker] = process.argv.slice(2);
if (!home || !bare || !databasePath || !mediaDirectory || !rawConfig || !marker) throw new Error("Owned attempt fixture inputs required");
const config = JSON.parse(rawConfig) as BackupConfig, redirect = `url.${pathToFileURL(bare).href}.insteadOf=${config.repositoryUrl}`;
async function runGit(call: GitInvocation): Promise<GitResult> {
  writeFileSync(`${marker}.git`, "entered", { mode: 0o600 });
  const child = Bun.spawn({ cmd: ["git", "-c", redirect, ...call.args], cwd: call.cwd, signal: call.signal, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
    PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid", GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid",
  } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}
const logger = createLogger("verbose", record => {
  if (record.message === "[backup] checkout lock acquisition attempt") writeFileSync(`${marker}.lock`, "entered", { mode: 0o600 });
  if (record.message === "[backup] source snapshot established") writeFileSync(`${marker}.source`, "entered", { mode: 0o600 });
});
const result = await runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit });
console.log(JSON.stringify(result));
