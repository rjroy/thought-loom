import { createLogger } from "../logging";
import { BackupCaptureError } from "./capture-files";
import { validateBackupConfig } from "./config";
import { BackupCheckoutLease, BackupGitError, inspectBackupCheckout, type RecoveryCheckout } from "./git";
import { gitBudgets } from "./git-common";
import type { BackupAttemptDependencies, BackupAttemptOptions } from "./run";
import { BackupSnapshotError } from "./snapshot";
import { BackupAttemptError, BackupWorkspace } from "./workspace";

/** Explicit local-only device rebinding. Never called by ordinary attempts or the scheduler. */
export async function recoverBackupIdentity(options: BackupAttemptOptions, deps: BackupAttemptDependencies = {}): Promise<{ changed: boolean }> {
  const { databasePath, mediaDirectory, signal, logger = createLogger() } = options;
  const controller = new AbortController(); let expired = false, changed = false;
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(() => { expired = true; controller.abort(); }, gitBudgets.deliveryMs);
  let workspace: BackupWorkspace | undefined, lease: BackupCheckoutLease | undefined, checkout: RecoveryCheckout | undefined;
  logger.info("[backup] identity recovery attempt");
  try {
    const config = validateBackupConfig({ ...options.config }, databasePath, mediaDirectory);
    workspace = await BackupWorkspace.inspect(databasePath, mediaDirectory, config, controller.signal);
    logger.verbose("[backup] checkout lock acquisition attempt");
    lease = await BackupCheckoutLease.acquireExisting(config, controller.signal);
    logger.verbose("[backup] checkout lock acquired");
    await workspace.openForIdentityRecovery(lease);
    const heldWorkspace = workspace;
    checkout = await inspectBackupCheckout({ config, lease, signal: controller.signal, logger,
      guard: () => heldWorkspace.assertHeld(), runGit: deps.runGit });
    const heldCheckout = checkout;
    const guard = () => { heldWorkspace.assertHeld(); heldCheckout.assertHeld(); };
    const verify = async () => {
      guard(); await heldWorkspace.verifyForIdentityRecovery(); await heldCheckout.verify(); guard();
    };
    // Verify all bindings, captures, Git metadata/index/tree/history before either
    // write, and again after each durable boundary. A partial success grants no trust.
    await verify();
    if (await checkout.recoverDevice()) {
      changed = true; logger.info("[backup] identity binding recovered", { binding: "checkout" });
    }
    await verify();
    if (await workspace.recoverDevices(guard)) {
      changed = true; logger.info("[backup] identity binding recovered", { binding: "workspace" });
    }
    await verify();
  } catch (error) {
    const safe = expired ? new BackupAttemptError("identity-recovery-timeout") :
      error instanceof BackupAttemptError || error instanceof BackupCaptureError || error instanceof BackupGitError || error instanceof BackupSnapshotError
        ? error : new BackupAttemptError("identity-recovery-failed");
    logger.error("[backup] identity recovery failed", { reason: safe.code }); throw safe;
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    // Join retained handles before releasing the same lock used by capture/delivery.
    let failed = false;
    try { await checkout?.close(); } catch { failed = true; }
    try { await workspace?.close(); } catch { failed = true; }
    try { await lease?.release(); } catch { failed = true; }
    if (failed) { logger.error("[backup] identity recovery failed", { reason: "cleanup-failed" }); throw new BackupAttemptError("cleanup-failed"); }
  }
  logger.info(changed ? "[backup] identity recovered" : "[backup] identity validated");
  return { changed };
}
