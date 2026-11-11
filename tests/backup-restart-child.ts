// Fresh operation over explicit owned fixtures, never a recovery command or shared service.
import { pathToFileURL } from "node:url";
import { runBackupCommand } from "../scripts/backup";
import type { BackupConfig } from "../src/backup/config";
import type { GitInvocation, GitResult } from "../src/backup/git";
import { runBackupAttempt } from "../src/backup/run";
import { createLogger, type LogRecord } from "../src/logging";

const [home, bare, databasePath, mediaDirectory, rawConfig, kind] = process.argv.slice(2);
if (!home || !bare || !databasePath || !mediaDirectory || !rawConfig || (kind !== "attempt" && kind !== "command")) throw new Error("Owned restart inputs required");
const config = JSON.parse(rawConfig) as BackupConfig, redirect = `url.${pathToFileURL(bare).href}.insteadOf=${config.repositoryUrl}`;
const logs: LogRecord[] = [], calls: (readonly string[])[] = [], logger = createLogger("verbose", record => logs.push(record));
async function runGit(call: GitInvocation): Promise<GitResult> {
  calls.push(call.args);
  const child = Bun.spawn({ cmd: ["/usr/bin/git", "-c", redirect, ...call.args], cwd: call.cwd, signal: call.signal,
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
      PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Owned Test", GIT_AUTHOR_EMAIL: "owned@example.invalid", GIT_COMMITTER_NAME: "Owned Test", GIT_COMMITTER_EMAIL: "owned@example.invalid",
    } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}
try {
  if (kind === "attempt") {
    const attempt = await runBackupAttempt({ databasePath, mediaDirectory, config, logger }, { runGit });
    console.log(JSON.stringify({ attempt, logs, calls }));
  } else {
    const commandExit = await runBackupCommand({ THOUGHTLOOM_DB_PATH: databasePath, THOUGHTLOOM_MEDIA_DIR: mediaDirectory,
      THOUGHTLOOM_BACKUP_CONFIG: rawConfig }, { logger, runGit });
    console.log(JSON.stringify({ commandExit, logs, calls })); process.exitCode = commandExit;
  }
} catch (error) {
  const reason = error instanceof Error && "code" in error && typeof error.code === "string" && /^[a-z-]+$/.test(error.code) ? error.code : "attempt-failed";
  console.log(JSON.stringify({ reason, logs, calls })); process.exitCode = 1;
}
