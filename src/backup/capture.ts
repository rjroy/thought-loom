import { lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createLogger, type Logger } from "../logging";
import { captureLimits, runCaptureWorker, type CaptureLimits } from "./capture-process";
import { BackupCaptureError, canonical, check, childDirectory, equalTrees, fingerprint, openDirectory, outsideGit, owned, publish,
  removeWork, sourceGuard, verifyDirectory, writeFile, type Directory } from "./capture-files";

export interface CaptureOptions {
  readonly databasePath: string;
  readonly mediaDirectory: string;
  readonly outputDirectory: string;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /** Technical process budgets, not content-count limits; scheduling configuration is separate. */
  readonly limits?: Partial<CaptureLimits>;
}

export interface CaptureResult {
  readonly snapshotDirectory: string;
  readonly manifestSha256: string;
}

export async function captureBackup(options: CaptureOptions): Promise<CaptureResult> {
  const { databasePath, mediaDirectory, outputDirectory, signal, logger = createLogger() } = options;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined, expired = false;
  const cancel = () => controller.abort();
  let output: Directory | undefined, work: Directory | undefined, stage: Directory | undefined, parent: Directory | undefined;
  logger.info("[backup] capture attempt");
  try {
    const limits = captureLimits(options.limits);
    const guard = () => { if (controller.signal.aborted) throw new BackupCaptureError(expired ? "capture-timeout" : "aborted"); };
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel(); guard();
    timeout = setTimeout(() => { expired = true; controller.abort(); }, limits.totalMs);
    await canonical(databasePath); await canonical(dirname(mediaDirectory));
    check(resolve(mediaDirectory) === mediaDirectory && !mediaDirectory.includes("\0"), "unsafe-path");
    parent = await openDirectory(dirname(databasePath), false);
    const identity = lstatSync(databasePath, { bigint: true }); owned(identity, false, false);
    const source = sourceGuard(databasePath, identity.dev.toString(), identity.ino.toString(), () => { guard(); if (parent) verifyDirectory(parent); });
    source(); output = await openDirectory(outputDirectory); outsideGit(output.path);
    check(output.path !== mediaDirectory && !output.path.startsWith(`${mediaDirectory}/`) &&
      !mediaDirectory.startsWith(`${output.path}/`), "unsafe-path");
    source(); work = await childDirectory(output, `.capture-${randomUUID()}`, true);
    stage = await childDirectory(work, "snapshot", true);
    const request = new TextEncoder().encode(JSON.stringify({ version: 1, databasePath, mediaDirectory,
      databaseDev: identity.dev.toString(), databaseIno: identity.ino.toString() }));
    check(request.length <= 16384, "invalid-control-file"); await writeFile(work, "request.json", request, source); await work.handle.sync();
    const digest = await runCaptureWorker(join(work.path, "request.json"), limits, controller.signal, logger, source);
    const initialStage = stage; stage = undefined; await initialStage.handle.close(); stage = await childDirectory(work, "snapshot");
    source(); const manifest = await fingerprint(stage, "manifest.json", source);
    check(manifest.sha256 === digest, "invalid-control-output");
    const destination = `snapshot-${digest}`;
    source(); verifyDirectory(output);
    const moved = publish(work, output, destination);
    if (!moved) {
      const existing = await childDirectory(output, destination);
      try { await equalTrees(stage, existing, source); } finally { await existing.handle.close(); }
    }
    // Once committed, abort no longer revokes the complete immutable snapshot. Never remove it during cleanup.
    if (moved) await work.handle.sync();
    await output.handle.sync();
    const result = Object.freeze({ snapshotDirectory: join(output.path, destination), manifestSha256: digest });
    await stage.handle.close(); stage = undefined;
    await removeWork(work); await work.handle.close(); work = undefined;
    await output.handle.sync();
    logger.info("[backup] capture succeeded", { manifestSha256: digest, reused: !moved }); return result;
  } catch (error) {
    const safe = expired ? new BackupCaptureError("capture-timeout") : error instanceof BackupCaptureError ? error : new BackupCaptureError();
    logger.error("[backup] capture failed", { reason: safe.code }); throw safe;
  } finally {
    if (timeout) clearTimeout(timeout); signal?.removeEventListener("abort", cancel);
    try {
      const closed = await Promise.allSettled([stage?.handle.close()]);
      if (closed.some(result => result.status === "rejected")) logger.warning("[backup] staged descriptor close failed");
      if (work) await removeWork(work);
    } catch { logger.warning("[backup] owned staging cleanup failed"); }
    finally {
      const closed = await Promise.allSettled([work?.handle.close(), output?.handle.close(), parent?.handle.close()]);
      if (closed.some(result => result.status === "rejected")) logger.warning("[backup] directory descriptor close failed");
    }
  }
}
