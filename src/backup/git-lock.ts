import { dlopen, toArrayBuffer } from "bun:ffi";
import { constants, fstatSync, lstatSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { BackupConfig } from "./config";
import { absent, canonical, openDirectory, owned, sameInode, verifyDirectory, type Directory } from "./capture-files";
import { BackupGitError, gitBudgets, requireGit } from "./git-common";

/** Destination capability only, never an execution-owner/source lease. Do not unlink its stable lock inode. */
export class BackupCheckoutLease {
  private released = false;
  private deliveryActive = false;
  private constructor(readonly checkout: string, readonly repositoryUrl: string, readonly branch: string,
    readonly parent: Directory, readonly control: Directory, private readonly lock: Awaited<ReturnType<typeof open>>) {}

  static async acquire(config: BackupConfig, signal?: AbortSignal): Promise<BackupCheckoutLease> {
    const checkout = resolve(config.checkout);
    requireGit(checkout === config.checkout && basename(checkout) !== "." && checkout !== "/", "unsafe-path");
    await canonical(dirname(checkout));
    const parent = await openDirectory(dirname(checkout), false);
    let control: Directory | undefined, lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const controlPath = join(parent.path, `.${basename(checkout)}.thoughtloom-backup`);
      try { await mkdir(controlPath, { mode: 0o700 }); await parent.handle.sync(); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      control = await openDirectory(controlPath);
      const path = join(control.anchor, "operation.lock");
      try { lock = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await lock.sync(); await control.handle.sync(); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        owned(lstatSync(path, { bigint: true }), false);
        lock = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
      const identity = await lock.stat({ bigint: true }); owned(identity, false);
      requireGit(sameInode(identity, lstatSync(path, { bigint: true })));
      const library = dlopen("libc.so.6", { flock: { args: ["int", "int"], returns: "int" }, __errno_location: { args: [], returns: "ptr" } });
      try {
        const until = Date.now() + gitBudgets.lockMs;
        for (;;) {
          if (signal?.aborted) throw new BackupGitError("aborted");
          verifyDirectory(parent); verifyDirectory(control);
          requireGit(sameInode(identity, lstatSync(path, { bigint: true })));
          if (library.symbols.flock(lock.fd, 2 | 4) === 0) break; // LOCK_EX | LOCK_NB; never block Bun's event loop.
          const pointer = library.symbols.__errno_location(); requireGit(pointer !== null, "lock-unavailable");
          const errno = new Int32Array(toArrayBuffer(pointer, 0, 4))[0];
          requireGit(errno === 11 || errno === 4, "lock-unavailable"); // EAGAIN/EINTR only; unsupported locking is not contention.
          if (Date.now() >= until) throw new BackupGitError("checkout-busy");
          await new Promise<void>(done => setTimeout(done, 25));
        }
      } finally { library.close(); }
      const lease = new BackupCheckoutLease(checkout, config.repositoryUrl, config.branch, parent, control, lock);
      lease.assertHeld(config); return lease;
    } catch (error) {
      await Promise.allSettled([lock?.close(), control?.handle.close(), parent.handle.close()]);
      throw error instanceof BackupGitError ? error : new BackupGitError("lock-unavailable");
    }
  }

  assertHeld(config: BackupConfig): void {
    requireGit(!this.released && config.checkout === this.checkout && config.repositoryUrl === this.repositoryUrl && config.branch === this.branch, "lease-lost");
    verifyDirectory(this.parent); verifyDirectory(this.control);
    const held = fstatSync(this.lock.fd, { bigint: true }), named = lstatSync(join(this.control.anchor, "operation.lock"), { bigint: true });
    owned(held, false); owned(named, false); requireGit(sameInode(held, named), "lease-lost");
  }
  enterDelivery(config: BackupConfig): void {
    this.assertHeld(config); requireGit(!this.deliveryActive, "lease-already-in-use"); this.deliveryActive = true;
  }
  leaveDelivery(): void { this.deliveryActive = false; }
  async release(): Promise<void> {
    if (this.released) return;
    requireGit(!this.deliveryActive, "lease-already-in-use");
    this.released = true;
    const results = await Promise.allSettled([this.lock.close(), this.control.handle.close(), this.parent.handle.close()]);
    if (results.some(result => result.status === "rejected")) throw new BackupGitError("lease-release-failed");
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try { lstatSync(path); return true; } catch (error) { if (absent(error)) return false; throw error; }
}
