import { isAbsolute } from "node:path";
import { createLogger, type Logger } from "../src/logging";
import { restoreBackup, type RestoreOptions, type RestoreResult } from "../src/backup/restore-staging";

export interface RestoreCommandDependencies {
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly restore?: (options: RestoreOptions) => Promise<RestoreResult>;
}

export async function runRestoreCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: RestoreCommandDependencies = {},
): Promise<number> {
  const level = env.THOUGHTLOOM_LOG_LEVEL?.trim().toLowerCase() ?? "info";
  const validLevel = level === "error" || level === "warning" || level === "info" || level === "verbose";
  const logger = deps.logger ?? createLogger(validLevel ? level : "error");
  try {
    if (!validLevel) throw new Error("Invalid log level");
    let snapshotDirectory: string | undefined, targetDirectory: string | undefined, expectedManifestSha256: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      if (!value || seen.has(flag)) throw new Error("Invalid restore arguments");
      seen.add(flag);
      if (flag === "--snapshot") snapshotDirectory = value;
      else if (flag === "--target") targetDirectory = value;
      else if (flag === "--manifest-sha256") expectedManifestSha256 = value;
      else throw new Error("Invalid restore arguments");
    }
    if (!snapshotDirectory || !isAbsolute(snapshotDirectory) || snapshotDirectory.includes("\0") ||
        !targetDirectory || !isAbsolute(targetDirectory) || targetDirectory.includes("\0") ||
        (expectedManifestSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedManifestSha256))) {
      throw new Error("Invalid restore arguments");
    }
    if (deps.signal?.aborted) throw new Error("Restore cancelled");
    const restoredAt = (deps.now ?? (() => new Date().toISOString()))();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(restoredAt) ||
        !Number.isFinite(Date.parse(restoredAt)) || new Date(restoredAt).toISOString() !== restoredAt) {
      throw new Error("Invalid restore timestamp");
    }
    const result = await (deps.restore ?? restoreBackup)({ snapshotDirectory, targetDirectory, restoredAt,
      ...(expectedManifestSha256 === undefined ? {} : { expectedManifestSha256 }), signal: deps.signal, logger });
    if (!/^[0-9a-f]{64}$/.test(result.manifestSha256) || result.restoredAt !== restoredAt ||
        (expectedManifestSha256 !== undefined && result.manifestSha256 !== expectedManifestSha256)) throw new Error("Restore unconfirmed");
    logger.info("[restore] command succeeded", { manifestSha256: result.manifestSha256, restoredAt: result.restoredAt });
    return 0;
  } catch {
    logger.error("[restore] command failed");
    return 1;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await runRestoreCommand(process.argv.slice(2), process.env, { signal: controller.signal });
  } catch {
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
