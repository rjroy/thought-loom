import { constants, fstatSync, lstatSync, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, opendir, rename, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { absent, canonical, childDirectory, empty, openDirectory, openFile, outsideGit, owned, sameInode, smallFile, sourceGuard,
  unchanged, verifyDirectory, verifyFile, writeFile, type Directory, type File, type Guard } from "./capture-files";
import type { BackupConfig } from "./config";
import { CheckoutRecord } from "./git-checkout";
import { disjoint } from "./git-common";
import type { BackupCheckoutLease } from "./git-lock";
import { inspectSnapshot } from "./snapshot";

export class BackupAttemptError extends Error {
  constructor(readonly code = "attempt-failed") { super(`Backup attempt failed: ${code}`); }
}
function requireWorkspace(condition: boolean, code = "unsafe-workspace"): asserts condition {
  if (!condition) throw new BackupAttemptError(code);
}
const applicationRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const markerName = "capture-workspace.json";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
interface WorkspaceRecord {
  readonly version: 1;
  readonly checkout: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly databasePath: string;
  readonly databaseDev: string;
  readonly databaseIno: string;
  readonly mediaDirectory: string;
}
function encodeRecord(record: WorkspaceRecord): Uint8Array { return encoder.encode(`${JSON.stringify(record)}\n`); }

function info(path: string): BigIntStats | null {
  try { return lstatSync(path, { bigint: true }); } catch (error) { if (absent(error)) return null; throw error; }
}
function containsIdentity(path: string, ancestor: BigIntStats): boolean {
  for (let current = path;; current = dirname(current)) {
    const currentInfo = info(current);
    if (currentInfo && sameInode(currentInfo, ancestor)) return true;
    if (current === dirname(current)) return false;
  }
}

/** One source-aware capability: readonly source identities plus a separately recorded persistent capture parent. */
export class BackupWorkspace {
  private root: Directory | undefined;
  private marker: File | undefined;
  private markerBytes: Uint8Array | undefined;
  private lease: BackupCheckoutLease | undefined;
  private closed = false;
  readonly outputDirectory: string;
  private readonly controlPath: string;
  private constructor(readonly databasePath: string, readonly mediaDirectory: string, readonly config: BackupConfig,
    private readonly parent: Directory, private readonly databaseParent: Directory, private readonly database: File,
    private readonly mediaParent: Directory, private readonly media: Directory | undefined,
    private readonly application: BigIntStats, private readonly signal?: AbortSignal) {
    this.outputDirectory = join(parent.path, `.${basename(config.checkout)}.thoughtloom-captures`);
    this.controlPath = join(parent.path, `.${basename(config.checkout)}.thoughtloom-backup`);
  }

  /** Readonly preflight before lock acquisition or any backup-directory creation. */
  static async inspect(databasePath: string, mediaDirectory: string, config: BackupConfig, signal?: AbortSignal): Promise<BackupWorkspace> {
    let parent: Directory | undefined, databaseParent: Directory | undefined;
    let mediaParent: Directory | undefined, media: Directory | undefined, databaseHandle: FileHandle | undefined;
    const abort = () => { if (signal?.aborted) throw new BackupAttemptError("aborted"); };
    try {
      abort(); await canonical(databasePath); await canonical(dirname(mediaDirectory)); await canonical(applicationRoot);
      requireWorkspace(resolve(mediaDirectory) === mediaDirectory && !mediaDirectory.includes("\0"));
      requireWorkspace(resolve(config.checkout) === config.checkout && config.checkout !== "/");
      databaseParent = await openDirectory(dirname(databasePath), false);
      const named = lstatSync(databasePath, { bigint: true }); owned(named, false, false);
      databaseHandle = await open(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const database: File = { handle: databaseHandle, identity: await databaseHandle.stat({ bigint: true }) };
      owned(database.identity, false, false); requireWorkspace(sameInode(named, database.identity), "source-replaced");
      mediaParent = await openDirectory(dirname(mediaDirectory), false);
      if (info(mediaDirectory) !== null) media = await openDirectory(mediaDirectory);
      parent = await openDirectory(dirname(config.checkout), false); outsideGit(parent.path);
      const application = lstatSync(applicationRoot, { bigint: true }); requireWorkspace(application.isDirectory());
      const workspace = new BackupWorkspace(databasePath, mediaDirectory, config, parent, databaseParent, database, mediaParent, media, application, signal);
      workspace.assertHeld(); await workspace.boundaries(); workspace.assertHeld(); return workspace;
    } catch (error) {
      await Promise.allSettled([parent?.handle.close(), databaseHandle?.close(), databaseParent?.handle.close(), media?.handle.close(), mediaParent?.handle.close()]);
      throw error;
    }
  }

  assertHeld(): void {
    requireWorkspace(!this.closed, "workspace-closed");
    if (this.signal?.aborted) throw new BackupAttemptError("aborted");
    verifyDirectory(this.parent); verifyDirectory(this.databaseParent); verifyDirectory(this.mediaParent);
    const held = fstatSync(this.database.handle.fd, { bigint: true }); owned(held, false, false);
    requireWorkspace(sameInode(held, this.database.identity), "source-replaced");
    sourceGuard(this.databasePath, this.database.identity.dev.toString(), this.database.identity.ino.toString(), () => {})();
    const application = lstatSync(applicationRoot, { bigint: true });
    requireWorkspace(application.isDirectory() && sameInode(this.application, application), "source-replaced");
    if (this.media) verifyDirectory(this.media); else requireWorkspace(info(this.mediaDirectory) === null, "source-replaced");
    this.lease?.assertHeld(this.config);
    if (this.root) verifyDirectory(this.root);
    if (this.marker && this.lease) verifyFile(this.lease.control, markerName, this.marker);
  }

  private protectedDirectory(path: string, identity: BigIntStats): void {
    requireWorkspace(!containsIdentity(path, this.application), "unsafe-workspace");
    if (this.media) requireWorkspace(!containsIdentity(path, this.media.identity), "unsafe-workspace");
    requireWorkspace(!containsIdentity(applicationRoot, identity) && !containsIdentity(this.databasePath, identity), "unsafe-workspace");
    if (this.media) requireWorkspace(!containsIdentity(this.mediaDirectory, identity), "unsafe-workspace");
  }

  private async boundaries(): Promise<void> {
    this.assertHeld();
    const paths = [this.config.checkout, this.controlPath, this.outputDirectory], opened: Directory[] = [];
    try {
      for (const path of paths) {
        for (const protectedPath of [applicationRoot, this.databasePath, this.mediaDirectory]) requireWorkspace(disjoint(path, protectedPath));
        requireWorkspace(!containsIdentity(this.parent.path, this.application));
        if (this.media) requireWorkspace(!containsIdentity(this.parent.path, this.media.identity));
        if (info(path) !== null) {
          const directory = await openDirectory(path); opened.push(directory); this.protectedDirectory(path, directory.identity);
        }
      }
      for (let a = 0; a < opened.length; a++) for (let b = a + 1; b < opened.length; b++) {
        requireWorkspace(!containsIdentity(opened[a].path, opened[b].identity) && !containsIdentity(opened[b].path, opened[a].identity));
      }
      this.assertHeld();
    } finally { await Promise.allSettled(opened.map(directory => directory.handle.close())); }
  }

  async open(lease: BackupCheckoutLease): Promise<boolean> {
    return this.openWorkspace(lease, false);
  }

  /** Explicit recovery may relax persisted device numbers only; held-operation identities stay strict. */
  async openForIdentityRecovery(lease: BackupCheckoutLease): Promise<void> {
    await this.openWorkspace(lease, true);
  }

  private expectedRecord(): WorkspaceRecord {
    const root = this.root; requireWorkspace(root !== undefined);
    return { version: 1, checkout: this.config.checkout, repositoryUrl: this.config.repositoryUrl, branch: this.config.branch,
      path: this.outputDirectory, dev: root.identity.dev.toString(), ino: root.identity.ino.toString(), databasePath: this.databasePath,
      databaseDev: this.database.identity.dev.toString(), databaseIno: this.database.identity.ino.toString(), mediaDirectory: this.mediaDirectory };
  }

  private validateRecord(bytes: Uint8Array, recovery: boolean): void {
    let raw: unknown;
    try { raw = JSON.parse(decoder.decode(bytes)); } catch { throw new BackupAttemptError("invalid-capture-record"); }
    requireWorkspace(typeof raw === "object" && raw !== null && !Array.isArray(raw) && "dev" in raw && "ino" in raw &&
      "databaseDev" in raw && "databaseIno" in raw, "invalid-capture-record");
    const { dev, ino, databaseDev, databaseIno } = raw;
    requireWorkspace(typeof dev === "string" && /^[0-9]+$/.test(dev) && typeof ino === "string" && /^[0-9]+$/.test(ino) &&
      typeof databaseDev === "string" && /^[0-9]+$/.test(databaseDev) && typeof databaseIno === "string" && /^[0-9]+$/.test(databaseIno), "invalid-capture-record");
    // Reconstruct the exact existing v1 encoding. All paths/configuration and unknown fields
    // are checked byte-for-byte, independently of the four identity fields diagnosed below.
    const expected = this.expectedRecord();
    const bound = { ...expected, dev, ino, databaseDev, databaseIno };
    requireWorkspace(Buffer.from(bytes).equals(Buffer.from(encodeRecord(bound))), "capture-binding-conflict");
    requireWorkspace(ino === expected.ino, "capture-inode-changed");
    requireWorkspace(databaseIno === expected.databaseIno, "source-inode-changed");
    if (!recovery) {
      requireWorkspace(dev === expected.dev, "capture-device-changed");
      requireWorkspace(databaseDev === expected.databaseDev, "source-device-changed");
    }
  }

  private async openWorkspace(lease: BackupCheckoutLease, recovery: boolean): Promise<boolean> {
    requireWorkspace(this.root === undefined && this.lease === undefined);
    lease.assertHeld(this.config); requireWorkspace(sameInode(lease.parent.identity, this.parent.identity)); this.lease = lease;
    this.assertHeld(); await this.boundaries();
    const checkout = await CheckoutRecord.load(lease), checkoutInfo = info(this.config.checkout);
    if (checkout.value === null) requireWorkspace(!recovery && checkoutInfo === null, recovery ? "missing-checkout-record" : "unrelated-checkout");
    else {
      requireWorkspace(checkoutInfo !== null && checkoutInfo.ino.toString() === checkout.value.ino, "checkout-inode-changed");
      if (!recovery) requireWorkspace(checkoutInfo.dev.toString() === checkout.value.dev, "checkout-device-changed");
    }
    const recordExists = info(join(lease.control.path, markerName)) !== null, rootExists = info(this.outputDirectory) !== null;
    requireWorkspace(recordExists === rootExists && (!recovery || recordExists), "capture-workspace-conflict");
    if (!rootExists) {
      this.assertHeld(); await mkdir(join(this.parent.anchor, basename(this.outputDirectory)), { mode: 0o700 }); await this.parent.handle.sync();
    }
    this.root = await openDirectory(this.outputDirectory); outsideGit(this.root.path); this.assertHeld();
    this.protectedDirectory(this.root.path, this.root.identity); await this.boundaries();
    const record = encodeRecord(this.expectedRecord());
    requireWorkspace(record.length <= 32768, "capture-workspace-conflict");
    if (!recordExists) {
      requireWorkspace(await empty(this.root), "capture-workspace-conflict"); await this.root.handle.sync();
      await writeFile(lease.control, markerName, record, () => this.assertHeld()); await lease.control.handle.sync();
    }
    this.marker = await openFile(lease.control, markerName);
    this.markerBytes = await smallFile(lease.control, markerName, 32768); this.assertHeld();
    this.validateRecord(this.markerBytes, recovery); await this.inventory(recovery);
    return !recordExists;
  }

  /** Called only after the recovery service has fully validated Git and retained payloads. */
  async recoverDevices(guard: Guard): Promise<boolean> {
    guard(); this.assertHeld();
    const lease = this.lease, previous = this.marker, before = this.markerBytes;
    requireWorkspace(lease !== undefined && previous !== undefined && before !== undefined, "capture-workspace-conflict");
    this.validateRecord(before, true);
    const bytes = encodeRecord(this.expectedRecord());
    if (Buffer.from(before).equals(Buffer.from(bytes))) return false;
    const temporary = `.workspace-${randomUUID()}`;
    await writeFile(lease.control, temporary, bytes, guard);
    requireWorkspace(Buffer.from(await smallFile(lease.control, temporary, 32768)).equals(Buffer.from(bytes)), "capture-record-changed");
    guard(); verifyFile(lease.control, markerName, previous);
    // Each record is atomic, not a transaction spanning both records. An uncertain
    // write is retained for explicit inspection/retry, never rolled back or deleted.
    await rename(join(lease.control.anchor, temporary), join(lease.control.anchor, markerName));
    await lease.control.handle.sync();
    this.marker = undefined; await previous.handle.close();
    this.marker = await openFile(lease.control, markerName); this.markerBytes = await smallFile(lease.control, markerName, 32768);
    requireWorkspace(Buffer.from(this.markerBytes).equals(Buffer.from(bytes)), "capture-record-changed");
    guard(); this.assertHeld(); return true;
  }

  /** Old completed payloads are not rehashed on every tick; selected/reused snapshots still receive full capture/Git validation. */
  private async inventory(full = false): Promise<void> {
    this.assertHeld(); const root = this.root; requireWorkspace(root !== undefined);
    const before = fstatSync(root.handle.fd, { bigint: true }); owned(before, true);
    for await (const entry of await opendir(root.anchor)) {
      this.assertHeld(); requireWorkspace(/^snapshot-[0-9a-f]{64}$/.test(entry.name) && entry.isDirectory(), "capture-workspace-conflict");
      const child = await childDirectory(root, entry.name);
      try {
        requireWorkspace(child.identity.dev === root.identity.dev, "capture-workspace-conflict"); this.protectedDirectory(child.path, child.identity);
        requireWorkspace(!containsIdentity(this.config.checkout, child.identity) && !containsIdentity(this.controlPath, child.identity), "capture-workspace-conflict");
        if (full) {
          const tree = await inspectSnapshot(child.path, entry.name.slice("snapshot-".length), () => this.assertHeld());
          try { verifyDirectory(child, true); } finally { await tree.close(); }
        }
      } finally { await child.handle.close(); }
    }
    requireWorkspace(unchanged(before, fstatSync(root.handle.fd, { bigint: true })), "capture-workspace-conflict"); this.assertHeld();
  }

  async verify(): Promise<void> { this.assertHeld(); await this.boundaries(); await this.inventory(); }

  async verifyForIdentityRecovery(): Promise<void> { this.assertHeld(); await this.boundaries(); await this.inventory(true); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled([this.marker?.handle.close(), this.root?.handle.close(), this.database.handle.close(),
      this.databaseParent.handle.close(), this.media?.handle.close(), this.mediaParent.handle.close(), this.parent.handle.close()]);
    requireWorkspace(results.every(result => result.status === "fulfilled"), "workspace-close-failed");
  }
}
