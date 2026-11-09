import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { Logger } from "../logging";
import { BackupCaptureError, check, workerFailureCodes, type Guard } from "./capture-files";

export interface CaptureLimits {
  readonly sourceReadMs: number;
  readonly totalMs: number;
  readonly maxRssBytes: number;
}
export const defaultCaptureLimits: CaptureLimits = Object.freeze({ sourceReadMs: 10000, totalMs: 120000, maxRssBytes: 512 * 1024 * 1024 });
const worker = fileURLToPath(new URL("./capture-worker.ts", import.meta.url));
const controlLimit = 8192;
const statusLimit = 8192;

export function captureLimits(input: Partial<CaptureLimits> = {}): CaptureLimits {
  const limits = { ...defaultCaptureLimits, ...input };
  check(Object.keys(input).every(key => ["sourceReadMs", "totalMs", "maxRssBytes"].includes(key)) &&
    Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0) &&
    limits.sourceReadMs <= limits.totalMs && limits.totalMs <= 2147483647, "invalid-limits");
  return Object.freeze(limits);
}
export interface CaptureStatusHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export type OpenCaptureStatus = (pid: number) => Promise<CaptureStatusHandle>;
export interface CaptureWorkerDependencies {
  readonly openStatus?: OpenCaptureStatus;
  readonly observeExit?: (childExit: Promise<number>) => Promise<number>;
}

type MonitorStage = "open" | "read" | "parse" | "close" | "sample";
type MonitorCategory = "permission" | "io" | "resource" | "malformed" | "limit" | "unknown";
class CaptureMonitorError extends BackupCaptureError {
  constructor(readonly stage: MonitorStage, readonly category: MonitorCategory) { super("monitor-unavailable"); }
}
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function gone(error: unknown): boolean { const code = errorCode(error); return code === "ENOENT" || code === "ESRCH"; }
function monitorError(stage: MonitorStage, error: unknown): CaptureMonitorError {
  if (error instanceof CaptureMonitorError) return error;
  let category: MonitorCategory;
  switch (errorCode(error)) {
    case "EACCES": case "EPERM": category = "permission"; break;
    case "EIO": case "EBADF": case "EINVAL": case "ENXIO": category = "io"; break;
    case "EMFILE": case "ENFILE": case "ENOMEM": case "ENOBUFS": case "EAGAIN": category = "resource"; break;
    default: category = "unknown";
  }
  return new CaptureMonitorError(stage, category);
}

async function statusRss(file: CaptureStatusHandle): Promise<bigint | null> {
  let stage: MonitorStage = "read";
  try {
    const buffer = Buffer.alloc(statusLimit);
    let length = 0, lineStart = 0, terminal = false;
    const lineRss = (line: string): bigint | undefined => {
      if (line.startsWith("State:")) terminal = /^State:[ \t]*[ZX](?:[ \t]|$)/.test(line);
      if (!line.startsWith("VmRSS:")) return undefined;
      const match = /^VmRSS:[ \t]*([0-9]+)[ \t]+kB[ \t]*\r?$/.exec(line);
      if (!match) throw new CaptureMonitorError("parse", "malformed");
      return BigInt(match[1]) * 1024n;
    };
    // Every positive read must advance by at least one byte; both bytes and read calls are capped.
    for (let reads = 0; reads < statusLimit; reads++) {
      stage = "read";
      if (length === buffer.length) throw new CaptureMonitorError("read", "limit");
      const previous = length, result = await file.read(buffer, length, buffer.length - length, length);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length - length) {
        throw new CaptureMonitorError("read", "malformed");
      }
      length += result.bytesRead; stage = "parse";
      const available = buffer.subarray(0, length);
      for (let end = available.indexOf(10, previous); end >= 0; end = available.indexOf(10, lineStart)) {
        const size = lineRss(available.subarray(lineStart, end).toString("utf8")); lineStart = end + 1;
        if (size !== undefined) return size; // A complete measurement need not wait for unrelated trailing fields or process exit.
      }
      if (result.bytesRead === 0) {
        if (lineStart < length) {
          const size = lineRss(available.subarray(lineStart).toString("utf8")); if (size !== undefined) return size;
        }
        if (terminal) return null;
        throw new CaptureMonitorError("parse", "malformed");
      }
    }
    throw new CaptureMonitorError("read", "limit");
  } catch (error) {
    // A retained proc descriptor can lose its task between open and read. This is not child completion authority.
    if (stage === "read" && gone(error)) return null;
    throw monitorError(stage, error);
  }
}

export async function readCaptureRss(pid: number, openStatus: OpenCaptureStatus = pid => open(`/proc/${pid}/status`, constants.O_RDONLY | constants.O_NOFOLLOW)): Promise<bigint | null> {
  let file: CaptureStatusHandle;
  try { file = await openStatus(pid); }
  catch (error) { if (gone(error)) return null; throw monitorError("open", error); }
  let size: bigint | null = null, failure: CaptureMonitorError | undefined;
  try { size = await statusRss(file); } catch (error) { failure = monitorError("read", error); }
  try { await file.close(); } catch (error) { failure ??= monitorError("close", error); }
  if (failure) throw failure;
  return size;
}

/** One child, bounded metadata pipes, externally timed source phase and sampled resident-memory control. */
export async function runCaptureWorker(requestPath: string, limits: CaptureLimits, signal: AbortSignal, logger: Logger, guard: Guard,
  dependencies: CaptureWorkerDependencies = {}): Promise<string> {
  guard();
  const child = Bun.spawn({ cmd: ["/usr/bin/prlimit", `--cpu=${Math.ceil(limits.totalMs / 1000)}:${Math.ceil(limits.totalMs / 1000)}`, "--core=0:0",
    "--", process.execPath, "--no-env-file", worker, requestPath], env: { PATH: "/usr/bin:/bin", LANG: "C" },
    cwd: dirname(requestPath), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let exited = false, failure: string | undefined, phase: "starting" | "reading" | "encoding" | "complete" = "starting";
  let digest: string | undefined, count = 0, sample: Promise<void> | undefined, inputEnded = false, monitorReported = false;
  const endInput = async () => { if (!inputEnded) { inputEnded = true; await child.stdin.end(); } };
  const kill = (code: string) => {
    failure ??= code;
    if (!exited) try { child.kill("SIGKILL"); } catch { /* The owned child can already have exited. */ }
  };
  const exit = (dependencies.observeExit?.(child.exited) ?? child.exited).then(code => { exited = true; return code; }, error => { exited = true; throw error; });
  const sourceTimer = setTimeout(() => kill("source-timeout"), limits.sourceReadMs);
  const cancel = () => kill("aborted"); signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const sampleRss = () => {
    if (sample || exited) return;
    sample = readCaptureRss(child.pid, dependencies.openStatus).then(size => {
      if (!exited && size !== null && size > BigInt(limits.maxRssBytes)) kill("memory-limit");
    }).catch(error => {
      if (!exited) {
        const safe = monitorError("sample", error); kill("monitor-unavailable");
        if (!monitorReported) {
          monitorReported = true;
          try { logger.error("[backup] RSS monitor failed", { stage: safe.stage, category: safe.category }); }
          catch { /* Diagnostics must not skip termination or joining the owned worker/sample. */ }
        }
      }
    }).finally(() => { sample = undefined; });
  };
  const memoryTimer = setInterval(sampleRss, 25); sampleRss();
  async function message(line: string): Promise<void> {
    const value: unknown = JSON.parse(line);
    check(typeof value === "object" && value !== null && !Array.isArray(value) && JSON.stringify(value) === line, "invalid-control-output");
    if (!("phase" in value)) throw new BackupCaptureError("invalid-control-output");
    if (value.phase === "source-ready" && phase === "starting" && Object.keys(value).length === 1) {
      guard(); phase = "reading";
      logger.info("[backup] source snapshot established", { pid: child.pid });
      guard(); check(child.stdin.write("read\n") === 5, "invalid-control-input"); await child.stdin.flush(); await endInput();
    } else if (value.phase === "source-closed" && phase === "reading" && Object.keys(value).length === 3 &&
      "tables" in value && typeof value.tables === "number" && Number.isSafeInteger(value.tables) && value.tables > 0 &&
      "rows" in value && typeof value.rows === "string" && /^(0|[1-9][0-9]*)$/.test(value.rows)) {
      phase = "encoding"; clearTimeout(sourceTimer);
      logger.info("[backup] source snapshot released", { tables: value.tables, rows: value.rows });
    } else if (value.phase === "complete" && phase === "encoding" && Object.keys(value).length === 2 && "manifestSha256" in value &&
      typeof value.manifestSha256 === "string" && /^[0-9a-f]{64}$/.test(value.manifestSha256)) {
      phase = "complete"; digest = value.manifestSha256;
    } else if (value.phase === "failed" && Object.keys(value).length === 2 && "code" in value &&
      typeof value.code === "string" && workerFailureCodes.has(value.code)) throw new BackupCaptureError(value.code);
    else throw new BackupCaptureError("invalid-control-output");
  }
  async function collect(stream: ReadableStream<Uint8Array>, control: boolean): Promise<void> {
    const reader = stream.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let pending = "";
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        if (next.value.length > controlLimit - count) { kill("control-overflow"); continue; }
        count += next.value.length;
        if (!control || failure) continue;
        pending += decoder.decode(next.value, { stream: true });
        for (;;) {
          const end = pending.indexOf("\n"); if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1); await message(line);
        }
      }
      if (control && !failure) check(decoder.decode().length === 0 && pending.length === 0, "invalid-control-output");
    } finally { reader.releaseLock(); }
  }
  try {
    const stdout = collect(child.stdout, true).catch(error => { kill(error instanceof BackupCaptureError ? error.code : "invalid-control-output"); throw error; });
    const stderr = collect(child.stderr, false).catch(error => { kill("control-failed"); throw error; });
    const results = await Promise.allSettled([stdout, stderr, exit]);
    if (failure) throw new BackupCaptureError(failure);
    check(results.every(result => result.status === "fulfilled") && results[2]?.status === "fulfilled" && results[2].value === 0 && digest !== undefined, "capture-worker-failed");
    guard(); return digest;
  } finally {
    clearTimeout(sourceTimer); clearInterval(memoryTimer); signal.removeEventListener("abort", cancel);
    if (!exited) { kill("capture-worker-failed"); await Promise.allSettled([exit]); }
    try { await endInput(); } catch { /* A terminated child may have closed stdin first. */ }
    if (sample) await sample;
  }
}
