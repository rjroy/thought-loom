import type { GitInvocation, GitResult } from "./git";
import { BackupGitError, gitBudgets, requireGit } from "./git-common";

/** Host authentication is intentional; application/provider environment and executable Git extensions are not. */
function environment(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", SSH_ASKPASS_REQUIRE: "never", GIT_ATTR_NOSYSTEM: "1", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_SSH_VARIANT: "ssh",
    GIT_SSH_COMMAND: "/usr/bin/ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=15 -oConnectionAttempts=1" };
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = process.env[name]; if (value !== undefined) env[name] = value;
  }
  return env;
}

/** One owned process group, bounded combined output and joined cancellation, including ordinary SSH/helper descendants. */
export async function runBackupGit(invocation: GitInvocation): Promise<GitResult> {
  if (invocation.signal?.aborted) throw new BackupGitError("aborted");
  // Set creation policy only in the owned child. exec preserves its PID/group; user values remain separate argv, never shell code.
  const child = Bun.spawn({ cmd: ["/bin/sh", "-c", 'umask 077 && exec "$@"', "thoughtloom-backup-git", "/usr/bin/git",
    "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "protocol.file.allow=never", ...invocation.args], cwd: invocation.cwd,
    env: environment(), detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let failure: BackupGitError | undefined, size = 0, exited = false;
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const exit = child.exited.then(code => { exited = true; return code; }, () => { exited = true; throw new BackupGitError("git-process-failed"); });
  function kill(): void {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* The group can already have exited. */ }
    if (!exited) try { child.kill("SIGKILL"); } catch { /* Also signal the owned child if group creation/signalling failed. */ }
  }
  function fail(code: string): void { failure ??= new BackupGitError(code); kill(); for (const reader of readers) void reader.cancel().catch(() => {}); }
  const abort = () => fail("aborted");
  invocation.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => fail("git-timeout"), gitBudgets.commandMs);
  async function collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length;
        if (size > gitBudgets.outputBytes) { fail("git-output-limit"); break; }
        chunks.push(next.value);
      }
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    } catch { fail("git-output-invalid"); return ""; }
    finally { reader.releaseLock(); }
  }
  try {
    if (invocation.signal?.aborted) abort();
    const stdout = collect(readers[0]), stderr = collect(readers[1]);
    void exit.then(kill, kill); // A helper must not keep the attempt alive after Git exits.
    const results = await Promise.allSettled([exit, stdout, stderr]);
    if (failure) throw failure;
    const [code, out, err] = results;
    requireGit(code.status === "fulfilled" && out.status === "fulfilled" && err.status === "fulfilled", "git-process-failed");
    return { exitCode: code.value, stdout: out.value, stderr: err.value };
  } finally {
    clearTimeout(timer); invocation.signal?.removeEventListener("abort", abort); kill();
    await Promise.allSettled([exit]);
    await Promise.allSettled(readers.map(reader => reader.cancel()));
  }
}

export const safeGitArguments: readonly string[] = ["--no-pager", "--literal-pathspecs", "--no-replace-objects",
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.filemode=false",
  "-c", "core.sparseCheckout=false", "-c", "core.splitIndex=false", "-c", "core.protectHFS=true", "-c", "core.protectNTFS=true",
  "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "push.gpgSign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
  "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync",
  "-c", "fetch.recurseSubmodules=false", "-c", "submodule.recurse=false", "-c", "protocol.ext.allow=never",
  "-c", "credential.interactive=false", "-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=20",
  "-c", "user.name=Thoughtloom backup", "-c", "user.email=backup@thoughtloom.invalid", "-c", "user.useConfigOnly=true"];

export function checkGitResult(result: GitResult): void {
  requireGit(Number.isInteger(result.exitCode) && typeof result.stdout === "string" && typeof result.stderr === "string" &&
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= gitBudgets.outputBytes, "git-output-limit");
}
