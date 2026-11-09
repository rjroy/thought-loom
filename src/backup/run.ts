import { createLogger, type Logger } from "../logging";
import { captureBackup, type CaptureResult } from "./capture";
import { validateBackupConfig, type BackupConfig } from "./config";
import { BackupCheckoutLease, deliverBackup, BackupGitError, type DeliveryResult, type GitInvocation, type GitResult } from "./git";
import { BackupCaptureError } from "./capture-files";
import { BackupAttemptError, BackupWorkspace } from "./workspace";

export interface BackupAttemptOptions {
  readonly databasePath: string;
  readonly mediaDirectory: string;
  readonly config: BackupConfig;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export interface BackupAttemptResult extends DeliveryResult {
  readonly snapshot: CaptureResult;
}

export interface BackupAttemptDependencies {
  readonly runGit?: (invocation: GitInvocation) => Promise<GitResult>;
}

export async function runBackupAttempt(options: BackupAttemptOptions, deps: BackupAttemptDependencies = {}): Promise<BackupAttemptResult> {
  const { databasePath, mediaDirectory, signal, logger = createLogger() } = options;
  const config = validateBackupConfig({ ...options.config }, databasePath, mediaDirectory), runGit = deps.runGit;
  let workspace: BackupWorkspace | undefined, lease: BackupCheckoutLease | undefined;
  logger.info("[backup] attempt started");
  try {
    workspace = await BackupWorkspace.inspect(databasePath, mediaDirectory, config, signal);
    logger.verbose("[backup] checkout lock acquisition attempt");
    lease = await BackupCheckoutLease.acquire(config, signal);
    logger.verbose("[backup] checkout lock acquired");
    logger.verbose("[backup] capture workspace opening");
    const created = await workspace.open(lease);
    logger.info("[backup] capture workspace ready", { created });
    const snapshot = await captureBackup({ databasePath: workspace.databasePath, mediaDirectory: workspace.mediaDirectory,
      outputDirectory: workspace.outputDirectory, signal, logger });
    await workspace.verify();
    logger.info("[backup] local snapshot retained", { manifestSha256: snapshot.manifestSha256 });
    const delivery = await deliverBackup({ snapshot, config, signal, logger }, { lease, ...(runGit ? { runGit } : {}) });
    await workspace.verify();
    logger.info("[backup] attempt outcome", { manifestSha256: snapshot.manifestSha256, localCommit: delivery.localCommit, remoteConfirmed: delivery.remoteConfirmed });
    return { snapshot, ...delivery };
  } catch (error) {
    const safe = error instanceof BackupAttemptError || error instanceof BackupCaptureError || error instanceof BackupGitError ? error : new BackupAttemptError();
    if (signal?.aborted) logger.verbose("[backup] attempt cancelled"); else logger.error("[backup] attempt failed", { reason: safe.code });
    throw safe;
  } finally {
    let failed = false;
    try { await workspace?.close(); } catch { failed = true; }
    try { await lease?.release(); } catch { failed = true; }
    if (failed) { logger.warning("[backup] joined attempt resource release failed"); throw new BackupAttemptError("cleanup-failed"); }
  }
}
