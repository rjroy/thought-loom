import type { Logger } from "../logging";
import type { CaptureResult } from "./capture";
import type { BackupConfig } from "./config";
import { validateBackupConfig } from "./config";
import { createLogger } from "../logging";
import { basename, dirname, join } from "node:path";
import { lstatSync } from "node:fs";
import { mkdir, opendir, rm } from "node:fs/promises";
import { childDirectory, fingerprint, openDirectory, openFile, sameInode, smallFile, verifyDirectory, verifyFile, writeFile,
  type Directory, type File, type Guard } from "./capture-files";
import { BackupCheckoutLease, pathExists } from "./git-lock";
import { attributes, auditMetadata, CheckoutRecord, makeGitConfigPrivate, moveEntry, privateMaterializedTree, removeVerifiedDirectory,
  rootEntries, verifyMetadata, type CheckoutState, type PendingUpdate } from "./git-checkout";
import { checkGitFiles, checkTreeListing, copySnapshot, inspectSnapshot, manifestFiles, type PayloadFile, type SnapshotTree } from "./git-payload";
import { BackupGitError, digestPattern, disjoint, gitBudgets, oidPattern, requireGit } from "./git-common";
import { checkGitResult, runBackupGit, safeGitArguments } from "./git-process";

export { BackupCheckoutLease } from "./git-lock";
export { BackupGitError } from "./git-common";

export interface GitInvocation {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DeliveryOptions {
  readonly snapshot: CaptureResult;
  readonly config: BackupConfig;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export interface DeliveryResult {
  readonly localCommit: string;
  readonly remoteConfirmed: boolean;
}

export interface DeliveryDependencies {
  readonly runGit?: (invocation: GitInvocation) => Promise<GitResult>;
  /** Later orchestration acquires this same lease before capture, passes it here, then releases it after delivery. */
  readonly lease?: BackupCheckoutLease;
}

interface Session {
  readonly config: BackupConfig;
  readonly lease: BackupCheckoutLease;
  readonly record: CheckoutRecord;
  readonly root: Directory;
  readonly guard: Guard;
  readonly logger: Logger;
  git(args: readonly string[]): Promise<GitResult>;
}
function hasAncestor(path: string, ancestor: Directory): boolean {
  for (let current = path;; current = dirname(current)) {
    if (sameInode(lstatSync(current, { bigint: true }), ancestor.identity)) return true;
    if (current === dirname(current)) return false;
  }
}
async function successful(session: Session, args: readonly string[]): Promise<string> {
  const result = await session.git(args); requireGit(result.exitCode === 0, "local-git-failed"); return result.stdout;
}
async function currentHead(session: Session): Promise<string | null> {
  const result = await session.git(["rev-parse", "--verify", "HEAD"]);
  if (result.exitCode !== 0) { requireGit(session.record.value?.head === null, "checkout-head-changed"); return null; }
  const oid = result.stdout.trim(); requireGit(oidPattern.test(oid), "checkout-head-changed"); return oid;
}
async function treeMatches(session: Session, head: string, files: readonly PayloadFile[]): Promise<void> {
  requireGit(checkGitFiles(await successful(session, ["ls-tree", "-rz", "--full-tree", head]), files), "checkout-tree-changed");
}
function state(session: Session): CheckoutState { const value = session.record.value; requireGit(value !== null, "invalid-checkout-record"); return value; }
async function snapshotAt(parent: Directory, name: string, sha: string | undefined, guard: Guard): Promise<SnapshotTree | undefined> {
  if (!await pathExists(join(parent.path, name))) return undefined;
  return inspectSnapshot(join(parent.path, name), sha, guard);
}
async function noScratch(session: Session): Promise<void> {
  requireGit(!await pathExists(join(session.lease.control.path, "next")) && !await pathExists(join(session.lease.control.path, "previous")), "unrecorded-workspace");
}
async function checkReferences(session: Session): Promise<void> {
  const refs = await successful(session, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"]);
  if (refs === "") return;
  const lines = refs.split("\n"); requireGit(lines.pop() === "", "checkout-references-changed");
  const saved = state(session), seen = new Set<string>();
  const recordedHead = saved.pending?.kind === "adopt" ? saved.pending.head : saved.head;
  for (const line of lines) {
    const fields = line.split("\0"), [name, oid, symbolicTarget] = fields;
    requireGit(fields.length === 3 && oidPattern.test(oid) && symbolicTarget === "" && !seen.has(name), "checkout-references-changed");
    seen.add(name);
    if (name === `refs/heads/${session.config.branch}`) continue; // HEAD itself is checked against the recovery record separately.
    // Git 2.56+ also updates this cache for direct-URL pushes matching origin. Older Git may leave it absent.
    requireGit(name === `refs/remotes/origin/${session.config.branch}` && recordedHead !== null, "checkout-references-changed");
    // Offline local commits may advance beyond the last successful push. The cache is never remote confirmation.
    requireGit(oid === recordedHead || (await session.git(["merge-base", "--is-ancestor", oid, recordedHead])).exitCode === 0, "checkout-references-changed");
  }
}
async function cleanCheckout(session: Session): Promise<void> {
  const saved = state(session); requireGit(saved.pending === null, "invalid-checkout-record");
  await noScratch(session); await rootEntries(session.root, saved.head === null ? [".git"] : [".git", "snapshot"], session.guard);
  await verifyMetadata(session.root, saved, session.guard);
  await checkReferences(session);
  requireGit(await currentHead(session) === saved.head, "checkout-head-changed");
  let tree: SnapshotTree | undefined;
  try {
    if (saved.head !== null) { requireGit(saved.manifest !== null); tree = await inspectSnapshot(join(session.root.path, "snapshot"), saved.manifest, session.guard); await treeMatches(session, saved.head, tree.files); }
    const files = tree?.files ?? [];
    requireGit(checkGitFiles(await successful(session, ["ls-files", "--stage", "-z"]), files, true), "dirty-checkout");
    const flags = await successful(session, ["ls-files", "-v", "-z"]);
    requireGit(flags === "" || flags.split("\0").slice(0, -1).every(line => line.startsWith("H snapshot/")), "dirty-checkout");
    requireGit(await successful(session, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]) === "", "dirty-checkout");
  } finally { await tree?.close(); }
}

export interface RecoveryCheckout {
  assertHeld(): void;
  verify(): Promise<void>;
  recoverDevice(): Promise<boolean>;
  close(): Promise<void>;
}

/** Retained read-only inspection reuses delivery's complete clean-checkout invariants.
 * Only its explicit recoverDevice method can change the existing device field. */
export async function inspectBackupCheckout(options: {
  readonly config: BackupConfig; readonly lease: BackupCheckoutLease; readonly guard: Guard;
  readonly logger: Logger; readonly signal?: AbortSignal; readonly runGit?: DeliveryDependencies["runGit"];
}): Promise<RecoveryCheckout> {
  const { config, lease, logger, signal } = options;
  let root: Directory | undefined, metadata: Directory | undefined, recordFile: File | undefined, closed = false;
  const guard = () => {
    options.guard(); requireGit(!closed, "checkout-inspection-closed"); lease.assertHeld(config);
    if (root) verifyDirectory(root); if (metadata) verifyDirectory(metadata);
    if (recordFile) verifyFile(lease.control, "state.json", recordFile);
  };
  const close = async () => {
    if (closed) return; closed = true;
    const results = await Promise.allSettled([recordFile?.handle.close(), metadata?.handle.close(), root?.handle.close()]);
    requireGit(results.every(result => result.status === "fulfilled"), "checkout-close-failed");
  };
  try {
    guard(); const record = await CheckoutRecord.load(lease), saved = record.value;
    requireGit(saved !== null, "missing-checkout-record");
    requireGit(saved.pending === null, "identity-recovery-pending");
    requireGit(saved.head !== null && saved.manifest !== null && saved.configSha256 !== null, "incomplete-checkout-record");
    recordFile = await openFile(lease.control, "state.json");
    requireGit(Buffer.from(await smallFile(lease.control, "state.json", 32768)).equals(Buffer.from(`${JSON.stringify(saved)}\n`)), "checkout-record-changed");
    root = await openDirectory(lease.checkout);
    requireGit(root.identity.ino.toString() === saved.ino, "checkout-inode-changed");
    requireGit(root.identity.dev === lease.control.identity.dev, "unsupported-storage");
    metadata = await openDirectory(join(root.path, ".git"), false); guard();
    const heldRoot = root;
    const session: Session = { config, lease, record, root, guard, logger, async git(args) {
      guard(); const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      let expired = false; const timer = setTimeout(() => { expired = true; controller.abort(); }, gitBudgets.commandMs);
      const operation = args[0]; logger.verbose("[backup git] verification command attempt", { operation });
      try {
        const result = await (options.runGit ?? runBackupGit)({ args: [...safeGitArguments, "--no-optional-locks",
          "-c", "protocol.allow=never", "-c", "protocol.https.allow=never", "-c", "protocol.ssh.allow=never", "-c", "protocol.file.allow=never",
          `--git-dir=${heldRoot.path}/.git`, `--work-tree=${heldRoot.path}`, ...args], cwd: heldRoot.path, signal: controller.signal });
        guard(); requireGit(!expired, "git-timeout"); checkGitResult(result);
        logger.verbose("[backup git] verification command finished", { operation, exitCode: result.exitCode }); return result;
      } catch (error) {
        guard(); logger.verbose("[backup git] verification command failed", { operation });
        throw expired ? new BackupGitError("git-timeout") : error instanceof BackupGitError ? error : new BackupGitError("git-process-failed");
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    } };
    const verify = async () => {
      guard();
      // Recovery cannot adopt/remove ambiguous control artifacts, including interrupted record writes.
      const allowed = new Set(["operation.lock", "state.json", "capture-workspace.json", "empty-template"]);
      for await (const entry of await opendir(lease.control.anchor)) {
        guard(); requireGit(allowed.has(entry.name) && (entry.name === "empty-template" ? entry.isDirectory() : entry.isFile()), "unrecorded-workspace");
      }
      if (await pathExists(join(lease.control.path, "empty-template"))) {
        const template = await childDirectory(lease.control, "empty-template");
        try { await rootEntries(template, [], guard); } finally { await template.handle.close(); }
      }
      await cleanCheckout(session);
      // No --lost-found, optional index refresh, fetch, or repair. Check the whole
      // local object graph, including unpushed ancestors, without rewriting it.
      requireGit((await session.git(["fsck", "--full", "--strict", "--no-reflogs"])).exitCode === 0, "checkout-history-invalid");
      guard();
    };
    await verify();
    return { assertHeld: guard, verify, close, async recoverDevice() {
      guard(); const current = state(session), dev = heldRoot.identity.dev.toString();
      if (current.dev === dev) return false;
      await record.save({ ...current, dev }, guard);
      const previous = recordFile; recordFile = undefined; await previous?.handle.close();
      recordFile = await openFile(lease.control, "state.json");
      requireGit(Buffer.from(await smallFile(lease.control, "state.json", 32768)).equals(Buffer.from(`${JSON.stringify(record.value)}\n`)), "checkout-record-changed");
      guard(); return true;
    } };
  } catch (error) { await close(); throw error; }
}

async function initialize(session: Session): Promise<void> {
  const saved = state(session);
  if (saved.configSha256 !== null) return;
  // An interrupted, not-yet-recorded Git initialization is ambiguous, not an unrelated repository to adopt.
  await rootEntries(session.root, [], session.guard);
  let template: Directory | undefined, git: Directory | undefined, info: Directory | undefined;
  try {
    if (!await pathExists(join(session.lease.control.path, "empty-template"))) template = await childDirectory(session.lease.control, "empty-template", true);
    else template = await childDirectory(session.lease.control, "empty-template");
    await rootEntries(template, [], session.guard);
    await successful(session, ["init", `--initial-branch=${saved.branch}`, "--object-format=sha1", `--template=${template.path}`, "."]);
    await successful(session, ["remote", "add", "origin", saved.repositoryUrl]);
    await makeGitConfigPrivate(session.root); await auditMetadata(session.root, session.guard);
    git = await openDirectory(join(session.root.path, ".git"), false);
    if (!await pathExists(join(git.path, "info"))) await mkdir(join(git.anchor, "info"), { mode: 0o700 });
    info = await openDirectory(join(git.path, "info"), false);
    await writeFile(info, "attributes", attributes, session.guard); await info.handle.sync();
    const config = await fingerprint(git, "config", session.guard);
    await git.handle.sync(); await session.root.handle.sync();
    await session.record.save({ ...saved, configSha256: config.sha256 }, session.guard);
  } finally { await Promise.allSettled([info?.handle.close(), git?.handle.close(), template?.handle.close()]); }
}

async function emptyRemote(session: Session): Promise<boolean> {
  const result = await session.git(["ls-remote", "--heads", "--", session.config.repositoryUrl]);
  return result.exitCode === 0 && result.stdout === "";
}

async function remoteHead(session: Session): Promise<{ known: boolean; head: string | null }> {
  const result = await session.git(["ls-remote", "--exit-code", "--heads", "--", session.config.repositoryUrl, `refs/heads/${session.config.branch}`]);
  if (result.exitCode === 2 && result.stdout === "") return { known: true, head: null };
  if (result.exitCode !== 0) return { known: false, head: null };
  const parts = result.stdout.split("\t");
  requireGit(parts.length === 2 && oidPattern.test(parts[0]) && parts[1] === `refs/heads/${session.config.branch}\n`, "unexpected-remote-result");
  return { known: true, head: parts[0] };
}
async function remoteManifest(session: Session, head: string): Promise<ReturnType<typeof manifestFiles>> {
  const raw = await successful(session, ["show", "--no-ext-diff", "--no-textconv", `${head}:snapshot/manifest.json`]);
  const manifest = manifestFiles(new TextEncoder().encode(raw));
  checkTreeListing(await successful(session, ["ls-tree", "-rz", "--full-tree", head]), manifest.files);
  return manifest;
}
async function finishAdoption(session: Session, pending: Extract<PendingUpdate, { kind: "adopt" }>): Promise<void> {
  const manifest = await remoteManifest(session, pending.head); requireGit(manifest.digest === pending.manifest, "unsupported-remote");
  const head = await currentHead(session); requireGit(head === null || head === pending.head, "checkout-head-changed");
  await noScratch(session);
  const exists = await pathExists(join(session.root.path, "snapshot"));
  await rootEntries(session.root, exists ? [".git", "snapshot"] : [".git"], session.guard);
  if (!exists) {
    requireGit(await successful(session, ["ls-files", "--stage", "-z"]) === "", "dirty-checkout");
    if (head === null) await successful(session, ["update-ref", `refs/heads/${session.config.branch}`, pending.head, "0".repeat(40)]);
    await successful(session, ["checkout", pending.head, "--", "snapshot"]);
  }
  await privateMaterializedTree(join(session.root.path, "snapshot"), manifest.files, session.guard);
  const tree = await inspectSnapshot(join(session.root.path, "snapshot"), pending.manifest, session.guard);
  try {
    await treeMatches(session, pending.head, tree.files);
    const index = await successful(session, ["ls-files", "--stage", "-z"]);
    if (!checkGitFiles(index, tree.files, true)) {
      requireGit(index === "", "dirty-checkout"); await successful(session, ["add", "--all", "--", "snapshot"]);
      requireGit(checkGitFiles(await successful(session, ["ls-files", "--stage", "-z"]), tree.files, true), "dirty-checkout");
    }
    if (await currentHead(session) === null) await successful(session, ["update-ref", `refs/heads/${session.config.branch}`, pending.head, "0".repeat(40)]);
  } finally { await tree.close(); }
  requireGit(await currentHead(session) === pending.head, "checkout-head-changed");
  await session.root.handle.sync();
  await session.record.save({ ...state(session), head: pending.head, manifest: pending.manifest, pending: null }, session.guard);
  session.logger.info("[backup git] dedicated remote history adopted", { localCommit: pending.head, manifestSha256: pending.manifest });
}

async function tryAdoption(session: Session): Promise<void> {
  if (state(session).head !== null) return;
  let remote: Awaited<ReturnType<typeof remoteHead>>;
  try { remote = await remoteHead(session); }
  catch (error) { session.guard(); if (error instanceof BackupGitError && ["git-timeout", "git-output-limit"].includes(error.code)) return; throw error; }
  if (!remote.known) return;
  if (remote.head === null) { requireGit(await emptyRemote(session), "unrelated-remote"); return; }
  requireGit((await session.git(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--", session.config.repositoryUrl, remote.head])).exitCode === 0, "remote-adoption-unavailable");
  const manifest = await remoteManifest(session, remote.head), pending: PendingUpdate = { kind: "adopt", head: remote.head, manifest: manifest.digest };
  await session.record.save({ ...state(session), pending }, session.guard); await finishAdoption(session, pending);
}

async function intendedCommit(session: Session, head: string, pending: Extract<PendingUpdate, { kind: "update" }>, after: SnapshotTree): Promise<void> {
  requireGit(head !== pending.beforeHead, "local-git-failed");
  const metadata = (await successful(session, ["show", "-s", "--format=%P%n%B", head])).trimEnd();
  requireGit(metadata === `${pending.beforeHead ?? ""}\nThoughtloom backup ${pending.afterManifest}`, "checkout-head-changed");
  await treeMatches(session, head, after.files);
}
async function finishUpdate(session: Session, pending: Extract<PendingUpdate, { kind: "update" }>): Promise<void> {
  const control = session.lease.control;
  let workspace: SnapshotTree | undefined, next: SnapshotTree | undefined, previous: SnapshotTree | undefined;
  try {
    workspace = await snapshotAt(session.root, "snapshot", undefined, session.guard);
    next = await snapshotAt(control, "next", pending.afterManifest, session.guard);
    previous = await snapshotAt(control, "previous", pending.beforeManifest ?? undefined, session.guard);
    requireGit(previous === undefined || pending.beforeManifest !== null, "workspace-conflict");
    requireGit(workspace === undefined || workspace.manifestSha256 === pending.beforeManifest || workspace.manifestSha256 === pending.afterManifest, "workspace-conflict");
    await rootEntries(session.root, workspace ? [".git", "snapshot"] : [".git"], session.guard);
    let head = await currentHead(session);
    const oldWorkspace = workspace?.manifestSha256 === pending.beforeManifest;
    const newWorkspace = workspace?.manifestSha256 === pending.afterManifest;
    requireGit((oldWorkspace && !previous && next !== undefined) || (!workspace && next !== undefined && (pending.beforeManifest === null || previous !== undefined)) ||
      (newWorkspace && !next && (pending.beforeManifest === null || previous !== undefined || head !== pending.beforeHead)), "workspace-conflict");
    const after = next ?? (newWorkspace ? workspace : undefined); requireGit(after !== undefined, "workspace-conflict");
    if (head !== pending.beforeHead) {
      requireGit(head !== null && newWorkspace, "checkout-head-changed"); await intendedCommit(session, head, pending, after);
    }
    const index = await successful(session, ["ls-files", "--stage", "-z"]);
    const before = oldWorkspace ? workspace : previous;
    const indexBefore = (pending.beforeHead === null || before !== undefined) && checkGitFiles(index, before?.files ?? [], true);
    const indexAfter = checkGitFiles(index, after.files, true);
    requireGit(indexAfter || (head === pending.beforeHead && indexBefore), "dirty-checkout");
    if (oldWorkspace) {
      requireGit(workspace !== undefined); await workspace.close(); workspace = undefined;
      session.guard(); moveEntry(session.root, "snapshot", control, "previous"); await session.root.handle.sync(); await control.handle.sync();
      previous = await inspectSnapshot(join(control.path, "previous"), pending.beforeManifest ?? undefined, session.guard);
    }
    if (!newWorkspace) {
      requireGit(next !== undefined); await next.close(); next = undefined;
      session.guard(); moveEntry(control, "next", session.root, "snapshot"); await control.handle.sync(); await session.root.handle.sync();
      workspace = await inspectSnapshot(join(session.root.path, "snapshot"), pending.afterManifest, session.guard);
    }
    requireGit(workspace !== undefined, "workspace-conflict");
    if (head === pending.beforeHead) {
      if (!indexAfter) await successful(session, ["add", "--all", "--", "snapshot"]);
      requireGit(checkGitFiles(await successful(session, ["ls-files", "--stage", "-z"]), workspace.files, true), "dirty-checkout");
      await successful(session, ["commit", "--no-verify", "--no-gpg-sign", "-m", `Thoughtloom backup ${pending.afterManifest}`]);
      head = await currentHead(session); requireGit(head !== null, "local-git-failed"); await intendedCommit(session, head, pending, workspace);
    }
    requireGit(head !== null);
    // Read the actual worktree back after Git, not merely its index or the original capture result.
    await workspace.close(); workspace = await inspectSnapshot(join(session.root.path, "snapshot"), pending.afterManifest, session.guard);
    await treeMatches(session, head, workspace.files);
    if (previous) { await removeVerifiedDirectory(previous.root); await previous.close(); previous = undefined; await control.handle.sync(); }
    await session.record.save({ ...state(session), head, manifest: pending.afterManifest, pending: null }, session.guard);
    session.logger.info("[backup git] local commit retained", { localCommit: head, manifestSha256: pending.afterManifest });
  } finally { await Promise.allSettled([workspace?.close(), next?.close(), previous?.close()]); }
}

async function updateSnapshot(session: Session, source: SnapshotTree): Promise<void> {
  if (state(session).manifest === source.manifestSha256) return;
  await noScratch(session);
  const next = await childDirectory(session.lease.control, "next", true); let recorded = false;
  try {
    await copySnapshot(source, next, session.guard);
    const verified = await inspectSnapshot(next.path, source.manifestSha256, session.guard); await verified.close();
    await session.lease.control.handle.sync();
    const saved = state(session), pending: PendingUpdate = { kind: "update", beforeHead: saved.head, beforeManifest: saved.manifest, afterManifest: source.manifestSha256 };
    recorded = true; // A failed record sync may already have published it. Keep its complete next tree on ambiguity.
    await session.record.save({ ...saved, pending }, session.guard);
  } finally {
    if (!recorded) { try { verifyDirectory(next); await rm(next.path, { recursive: true, force: false }); await session.lease.control.handle.sync(); } catch { /* Ambiguous owned scratch is retained, never guessed away. */ } }
    await next.handle.close();
  }
  const pending = state(session).pending; requireGit(pending?.kind === "update"); await finishUpdate(session, pending);
}

async function pushAndConfirm(session: Session): Promise<DeliveryResult> {
  const localCommit = state(session).head; requireGit(localCommit !== null);
  session.logger.info("[backup git] remote delivery attempt", { localCommit });
  try {
    const remote = await remoteHead(session);
    if (!remote.known) { session.logger.warning("[backup git] remote delivery pending", { localCommit, reason: "unavailable" }); return { localCommit, remoteConfirmed: false }; }
    if (remote.head !== localCommit) {
      if (remote.head === null && !await emptyRemote(session)) {
        session.logger.warning("[backup git] remote delivery pending", { localCommit, reason: "unrelated-or-unavailable-remote" }); return { localCommit, remoteConfirmed: false };
      }
      if (remote.head !== null && (await session.git(["merge-base", "--is-ancestor", remote.head, localCommit])).exitCode !== 0) {
        session.logger.warning("[backup git] remote delivery pending", { localCommit, reason: "divergence" }); return { localCommit, remoteConfirmed: false };
      }
      // Even an unsuccessful acknowledgement may have reached the server. Only a subsequent OID observation confirms it.
      try { await session.git(["push", "--porcelain", "--no-verify", "--signed=false", "--recurse-submodules=no", "--", session.config.repositoryUrl, `${localCommit}:refs/heads/${session.config.branch}`]); }
      catch (error) {
        session.guard(); if (!(error instanceof BackupGitError) || !["git-timeout", "git-process-failed", "git-output-limit", "git-output-invalid"].includes(error.code)) throw error;
      }
      const confirmation = await remoteHead(session);
      if (!confirmation.known || confirmation.head !== localCommit) {
        session.logger.warning("[backup git] remote delivery pending", { localCommit, reason: "unconfirmed" }); return { localCommit, remoteConfirmed: false };
      }
    }
    session.logger.info("[backup git] remote branch confirmed", { localCommit }); return { localCommit, remoteConfirmed: true };
  } catch (error) {
    if (!(error instanceof BackupGitError) || !["git-timeout", "git-process-failed", "git-output-limit", "git-output-invalid", "delivery-timeout", "unexpected-remote-result"].includes(error.code)) throw error;
    session.logger.warning("[backup git] remote delivery pending", { localCommit, reason: "unavailable-or-uncertain" }); return { localCommit, remoteConfirmed: false };
  }
}

export async function deliverBackup(options: DeliveryOptions, deps: DeliveryDependencies = {}): Promise<DeliveryResult> {
  const snapshot = { ...options.snapshot }, logger = options.logger ?? createLogger(), signal = options.signal;
  const config = validateBackupConfig({ ...options.config }, snapshot.snapshotDirectory, snapshot.snapshotDirectory);
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, gitBudgets.deliveryMs);
  let lease: BackupCheckoutLease | undefined, root: Directory | undefined, metadata: Directory | undefined, source: SnapshotTree | undefined, entered = false;
  const runner = deps.runGit ?? runBackupGit, suppliedLease = deps.lease;
  const guard = () => {
    if (controller.signal.aborted) throw new BackupGitError(timedOut ? "delivery-timeout" : "aborted");
    lease?.assertHeld(config); if (root) verifyDirectory(root); if (metadata) verifyDirectory(metadata);
  };
  logger.info("[backup git] delivery attempt");
  try {
    requireGit(digestPattern.test(snapshot.manifestSha256) && basename(snapshot.snapshotDirectory) === `snapshot-${snapshot.manifestSha256}`, "invalid-snapshot");
    source = await inspectSnapshot(snapshot.snapshotDirectory, snapshot.manifestSha256, guard);
    requireGit(disjoint(snapshot.snapshotDirectory, config.checkout), "unsafe-path");
    const parent = await openDirectory(dirname(config.checkout), false);
    try { requireGit(!hasAncestor(parent.path, source.root), "unsafe-path"); } finally { await parent.handle.close(); }
    logger.verbose("[backup git] checkout lock acquisition attempt");
    guard(); lease = suppliedLease ?? await BackupCheckoutLease.acquire(config, controller.signal); guard(); lease.enterDelivery(config); entered = true;
    logger.verbose("[backup git] checkout lock acquired");
    requireGit(disjoint(snapshot.snapshotDirectory, lease.control.path), "unsafe-path");
    requireGit(!hasAncestor(lease.parent.path, source.root) && !hasAncestor(lease.control.path, source.root), "unsafe-path");
    const record = await CheckoutRecord.load(lease);
    if (record.value === null) {
      requireGit(!await pathExists(lease.checkout), "unrelated-checkout"); await mkdir(lease.checkout, { mode: 0o700 }); root = await openDirectory(lease.checkout);
      await lease.parent.handle.sync();
      await record.save({ version: 1, repositoryUrl: config.repositoryUrl, branch: config.branch, dev: root.identity.dev.toString(), ino: root.identity.ino.toString(),
        configSha256: null, head: null, manifest: null, pending: null }, guard);
    } else {
      root = await openDirectory(lease.checkout);
      requireGit(root.identity.ino.toString() === record.value.ino, "checkout-inode-changed");
      requireGit(root.identity.dev.toString() === record.value.dev, "checkout-device-changed");
    }
    requireGit(!hasAncestor(root.path, source.root) && !hasAncestor(source.root.path, root), "unsafe-path");
    requireGit(root.identity.dev === lease.control.identity.dev, "unsupported-storage");
    const session: Session = { config, lease, record, root, guard, logger, async git(args) {
      if (!metadata && await pathExists(join(session.root.path, ".git"))) metadata = await openDirectory(join(session.root.path, ".git"), false);
      guard(); const call = new AbortController(), forward = () => call.abort(); controller.signal.addEventListener("abort", forward, { once: true });
      let expired = false; const deadline = setTimeout(() => { expired = true; call.abort(); }, gitBudgets.commandMs);
      const operation = args[0]; logger.verbose("[backup git] command attempt", { operation });
      try {
        const result = await runner({ args: [...safeGitArguments, `--git-dir=${session.root.path}/.git`, `--work-tree=${session.root.path}`, ...args], cwd: session.root.path, signal: call.signal });
        guard(); if (expired) throw new BackupGitError("git-timeout"); checkGitResult(result);
        logger.verbose("[backup git] command finished", { operation, exitCode: result.exitCode }); return result;
      } catch (error) {
        guard(); logger.verbose("[backup git] command failed", { operation });
        throw expired ? new BackupGitError("git-timeout") : error instanceof BackupGitError ? error : new BackupGitError("git-process-failed");
      } finally { clearTimeout(deadline); controller.signal.removeEventListener("abort", forward); }
    } };
    const version = /^(?:git version )([0-9]+)\.([0-9]+)(?:\.|\s)/.exec(await successful(session, ["--version"]));
    requireGit(version !== null && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 36)), "unsupported-git");
    await initialize(session);
    const pending = state(session).pending;
    if (pending !== null) { await verifyMetadata(root, state(session), guard); await checkReferences(session); }
    if (pending?.kind === "adopt") await finishAdoption(session, pending);
    if (pending?.kind === "update") await finishUpdate(session, pending);
    await cleanCheckout(session);
    const beforeAdoption = state(session).head; await tryAdoption(session);
    if (state(session).head !== beforeAdoption) await cleanCheckout(session);
    await updateSnapshot(session, source); await cleanCheckout(session);
    return await pushAndConfirm(session);
  } catch (error) {
    const safe = error instanceof BackupGitError ? error : new BackupGitError("unsafe-or-invalid-input");
    logger.error("[backup git] delivery failed", { reason: safe.code }); throw safe;
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    const cleanup = await Promise.allSettled([source?.close(), metadata?.handle.close(), root?.handle.close()]);
    if (entered) lease?.leaveDelivery();
    if (lease && !suppliedLease) try { await lease.release(); } catch { logger.warning("[backup git] operation lock cleanup failed"); }
    if (cleanup.some(result => result.status === "rejected")) logger.warning("[backup git] resource cleanup failed");
  }
}
