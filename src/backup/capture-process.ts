import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { Logger } from "../logging";
import { absent, BackupCaptureError, check, workerFailureCodes, type Guard } from "./capture-files";

export interface CaptureLimits {
  readonly sourceReadMs: number;
  readonly totalMs: number;
  readonly maxRssBytes: number;
}
export const defaultCaptureLimits: CaptureLimits = Object.freeze({ sourceReadMs: 10000, totalMs: 120000, maxRssBytes: 512 * 1024 * 1024 });
const worker = fileURLToPath(new URL("./capture-worker.ts", import.meta.url));
const controlLimit = 8192;

export function captureLimits(input: Partial<CaptureLimits> = {}): CaptureLimits {
  const limits = { ...defaultCaptureLimits, ...input };
  check(Object.keys(input).every(key => ["sourceReadMs", "totalMs", "maxRssBytes"].includes(key)) &&
    Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0) &&
    limits.sourceReadMs <= limits.totalMs && limits.totalMs <= 2147483647, "invalid-limits");
  return Object.freeze(limits);
}
async function rss(pid: number): Promise<bigint | null> {
  let file: FileHandle;
  try { file = await open(`/proc/${pid}/status`, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (absent(error)) return null; throw error; }
  try {
    const buffer = Buffer.alloc(8192), result = await file.read(buffer, 0, buffer.length, 0), text = buffer.subarray(0, result.bytesRead).toString("ascii");
    const size = /^VmRSS:\s*([0-9]+)\s+kB\s*$/m.exec(text)?.[1];
    if (size !== undefined) return BigInt(size) * 1024n;
    check(/^State:\s*[ZX]/m.test(text), "monitor-unavailable"); return null;
  } finally { await file.close(); }
}

/** One child, bounded metadata pipes, externally timed source phase and sampled resident-memory control. */
export async function runCaptureWorker(requestPath: string, limits: CaptureLimits, signal: AbortSignal, logger: Logger, guard: Guard): Promise<string> {
  guard();
  const child = Bun.spawn({ cmd: ["/usr/bin/prlimit", `--cpu=${Math.ceil(limits.totalMs / 1000)}:${Math.ceil(limits.totalMs / 1000)}`, "--core=0:0",
    "--", process.execPath, "--no-env-file", worker, requestPath], env: { PATH: "/usr/bin:/bin", LANG: "C" },
    cwd: dirname(requestPath), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let exited = false, failure: string | undefined, phase: "starting" | "reading" | "encoding" | "complete" = "starting";
  let digest: string | undefined, count = 0, sample: Promise<void> | undefined, inputEnded = false;
  const endInput = async () => { if (!inputEnded) { inputEnded = true; await child.stdin.end(); } };
  const kill = (code: string) => {
    failure ??= code;
    if (!exited) try { child.kill("SIGKILL"); } catch { /* The owned child can already have exited. */ }
  };
  const exit = child.exited.then(code => { exited = true; return code; }, error => { exited = true; throw error; });
  const sourceTimer = setTimeout(() => kill("source-timeout"), limits.sourceReadMs);
  const cancel = () => kill("aborted"); signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const sampleRss = () => {
    if (sample || exited) return;
    sample = rss(child.pid).then(size => {
      if (!exited && size !== null && size > BigInt(limits.maxRssBytes)) kill("memory-limit");
    }).catch(() => { if (!exited) kill("monitor-unavailable"); }).finally(() => { sample = undefined; });
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
