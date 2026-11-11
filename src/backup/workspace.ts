import { constants, fstatSync, lstatSync, type BigIntStats } from "node:fs";
import { mkdir, open, opendir, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { absent, canonical, childDirectory, empty, openDirectory, openFile, outsideGit, owned, sameInode, smallFile, sourceGuard,
  unchanged, verifyDirectory, verifyFile, writeFile, type Directory, type File } from "./capture-files";
import type { BackupConfig } from "./config";
import { CheckoutRecord } from "./git-checkout";
import { disjoint } from "./git-common";
import type { BackupCheckoutLease } from "./git-lock";

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
  readonly version: 2;
  readonly checkout: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly path: string;
  readonly ino: string;
  readonly databasePath: string;
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

  private expectedRecord(): WorkspaceRecord {
    const root = this.root; requireWorkspace(root !== undefined);
    return { version: 2, checkout: this.config.checkout, repositoryUrl: this.config.repositoryUrl, branch: this.config.branch,
      path: this.outputDirectory, ino: root.identity.ino.toString(), databasePath: this.databasePath,
      databaseIno: this.database.identity.ino.toString(), mediaDirectory: this.mediaDirectory };
  }

  private validateRecord(bytes: Uint8Array): void {
    let raw: unknown;
    try { raw = JSON.parse(decoder.decode(bytes)); } catch { throw new BackupAttemptError("invalid-capture-record"); }
    requireWorkspace(typeof raw === "object" && raw !== null && !Array.isArray(raw) && "version" in raw && (raw.version === 1 || raw.version === 2) &&
      "ino" in raw && "databaseIno" in raw, "invalid-capture-record");
    const { ino, databaseIno } = raw;
    requireWorkspace(typeof ino === "string" && /^[0-9]+$/.test(ino) && typeof databaseIno === "string" && /^[0-9]+$/.test(databaseIno), "invalid-capture-record");
    // Bind all configured fields and reject extra/missing/noncanonical fields in
    // either wire format. Only legacy device observations are semantically ignored.
    const expected = this.expectedRecord(), bound = { ...expected, ino, databaseIno };
    let canonical = encodeRecord(bound);
    if (raw.version === 1) {
      requireWorkspace("dev" in raw && typeof raw.dev === "string" && /^[0-9]+$/.test(raw.dev) &&
        "databaseDev" in raw && typeof raw.databaseDev === "string" && /^[0-9]+$/.test(raw.databaseDev), "invalid-capture-record");
      canonical = encoder.encode(`${JSON.stringify({ version: 1, checkout: bound.checkout, repositoryUrl: bound.repositoryUrl, branch: bound.branch,
        path: bound.path, dev: raw.dev, ino: bound.ino, databasePath: bound.databasePath, databaseDev: raw.databaseDev,
        databaseIno: bound.databaseIno, mediaDirectory: bound.mediaDirectory })}\n`);
    }
    requireWorkspace(Buffer.from(bytes).equals(Buffer.from(canonical)), "capture-binding-conflict");
    requireWorkspace(ino === expected.ino, "capture-inode-changed");
    requireWorkspace(databaseIno === expected.databaseIno, "source-inode-changed");
  }

  async open(lease: BackupCheckoutLease): Promise<boolean> {
    requireWorkspace(this.root === undefined && this.lease === undefined);
    lease.assertHeld(this.config); requireWorkspace(sameInode(lease.parent.identity, this.parent.identity)); this.lease = lease;
    this.assertHeld(); await this.boundaries();
    const checkout = await CheckoutRecord.load(lease), checkoutInfo = info(this.config.checkout);
    if (checkout.value === null) requireWorkspace(checkoutInfo === null, "unrelated-checkout");
    else requireWorkspace(checkoutInfo !== null && checkoutInfo.ino.toString() === checkout.value.ino, "checkout-inode-changed");
    const recordExists = info(join(lease.control.path, markerName)) !== null, rootExists = info(this.outputDirectory) !== null;
    requireWorkspace(recordExists === rootExists, "capture-workspace-conflict");
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
    const bytes = await smallFile(lease.control, markerName, 32768); this.assertHeld();
    this.validateRecord(bytes); await this.inventory();
    return !recordExists;
  }

  /** Old completed payloads are not rehashed on every tick; selected/reused snapshots still receive full capture/Git validation. */
  private async inventory(): Promise<void> {
    this.assertHeld(); const root = this.root; requireWorkspace(root !== undefined);
    const before = fstatSync(root.handle.fd, { bigint: true }); owned(before, true);
    for await (const entry of await opendir(root.anchor)) {
      this.assertHeld(); requireWorkspace(/^snapshot-[0-9a-f]{64}$/.test(entry.name) && entry.isDirectory(), "capture-workspace-conflict");
      const child = await childDirectory(root, entry.name);
      try {
        requireWorkspace(child.identity.dev === root.identity.dev, "capture-workspace-conflict"); this.protectedDirectory(child.path, child.identity);
        requireWorkspace(!containsIdentity(this.config.checkout, child.identity) && !containsIdentity(this.controlPath, child.identity), "capture-workspace-conflict");
      } finally { await child.handle.close(); }
    }
    requireWorkspace(unchanged(before, fstatSync(root.handle.fd, { bigint: true })), "capture-workspace-conflict"); this.assertHeld();
  }

  async verify(): Promise<void> { this.assertHeld(); await this.boundaries(); await this.inventory(); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled([this.marker?.handle.close(), this.root?.handle.close(), this.database.handle.close(),
      this.databaseParent.handle.close(), this.media?.handle.close(), this.mediaParent.handle.close(), this.parent.handle.close()]);
    requireWorkspace(results.every(result => result.status === "fulfilled"), "workspace-close-failed");
  }
}
