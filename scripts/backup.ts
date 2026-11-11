import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createLogger, type Logger } from "../src/logging";
import type { GitInvocation, GitResult } from "../src/backup/git";
import { parseBackupConfig, validateBackupConfig } from "../src/backup/config";
import { runBackupAttempt } from "../src/backup/run";
import { recoverBackupIdentity } from "../src/backup/identity-recovery";

export interface BackupCommandDependencies {
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly runGit?: (invocation: GitInvocation) => Promise<GitResult>;
}

export async function runBackupCommand(
  env: Readonly<Record<string, string | undefined>>,
  deps: BackupCommandDependencies = {},
  args: readonly string[] = [],
): Promise<number> {
  const level = env.THOUGHTLOOM_LOG_LEVEL?.trim().toLowerCase() ?? "info";
  const validLevel = level === "error" || level === "warning" || level === "info" || level === "verbose";
  const logger = deps.logger ?? createLogger(validLevel ? level : "error");
  let failureReason = "invalid-command-input";
  try {
    if (!validLevel) throw new Error("Invalid log level");
    if (args.length !== 0 && (args.length !== 1 || args[0] !== "--recover-identity")) throw new Error("Invalid backup arguments");
    const raw = env.THOUGHTLOOM_BACKUP_CONFIG;
    const dbPath = env.THOUGHTLOOM_DB_PATH;
    const mediaDir = env.THOUGHTLOOM_MEDIA_DIR;
    if (raw === undefined || dbPath === undefined || !dbPath.trim() || dbPath.includes("\0") ||
        (mediaDir !== undefined && (!isAbsolute(mediaDir) || mediaDir.includes("\0")))) {
      throw new Error("Invalid backup configuration");
    }
    const db = resolve(dbPath);
    const config = validateBackupConfig(parseBackupConfig(raw), db, mediaDir);
    if (deps.signal?.aborted) throw new Error("Backup cancelled");
    failureReason = "source-path-unavailable";
    const databasePath = await realpath(db);
    failureReason = "media-path-unavailable";
    const mediaDirectory = await realpath(mediaDir ?? `${databasePath}.media`);
    failureReason = "backup-operation-failed";
    if (args[0] === "--recover-identity") {
      await recoverBackupIdentity({ databasePath, mediaDirectory, config, signal: deps.signal, logger }, { runGit: deps.runGit });
      return 0;
    }
    const result = await runBackupAttempt({ databasePath, mediaDirectory, config, signal: deps.signal, logger },
      { runGit: deps.runGit });
    if (!result.remoteConfirmed) {
      logger.warning("[backup] command delivery unconfirmed");
      return 1;
    }
    return 0;
  } catch {
    logger.error("[backup] command failed", { reason: deps.signal?.aborted ? "aborted" : failureReason });
    return 1;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await runBackupCommand(process.env, { signal: controller.signal }, process.argv.slice(2));
  } catch {
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
