import type { Logger } from "../logging";
import type { MediaFilesOptions } from "./media-files";
import type { RasterValidationLimits } from "./media-validation";
import type { PdfValidationLimits } from "./media-pdf-validation";
import type { MediaFileMime, MediaFileValidationInput } from "./media-files";
import { fstat, read, type BigIntStats } from "node:fs";
import { fileURLToPath } from "node:url";

/** Command and environment are built by the supervisor, never from media input. */
export interface MediaValidatorLaunchRequest {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

function spawnValidator(request: MediaValidatorLaunchRequest) {
  return Bun.spawn({cmd:[...request.cmd],env:{...request.env},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
}

export interface MediaValidatorOptions {
  readonly raster: RasterValidationLimits;
  readonly pdf: PdfValidationLimits;
  readonly process: {
    readonly dataBytes: number;
    readonly cpuSeconds: number;
    readonly wallMs: number;
    readonly outputBytes: number;
  };
  readonly logger: Logger;
  /** Test-owned ambient environment; the child receives only an explicit safe subset. */
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Test seam for launching an owned child; production uses the fixed worker entry. */
  readonly launch?: (request: MediaValidatorLaunchRequest) => ReturnType<typeof spawnValidator>;
}

export interface MediaValidator {
  readonly validate: MediaFilesOptions["validate"];
  /** Seal the lane, cancel entered work and join all subprocess and pipe activity. */
  close(): Promise<void>;
}

type Child = ReturnType<typeof spawnValidator>;
type Waiter = { resolve: (release: () => void) => void; reject: () => void; signal: AbortSignal; cancel: () => void };
const workerPath = fileURLToPath(new URL("./media-validator-worker.ts", import.meta.url));
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const failure = (): Error => new Error("Media validation failed");

function stat(fd: number): Promise<BigIntStats> {
  return new Promise((resolve, reject) => fstat(fd,{bigint:true},(error, value) => error ? reject(error) : resolve(value)));
}
function readAt(fd: number, buffer: Buffer, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => read(fd,buffer,0,length,position,(error, count) => error ? reject(error) : resolve(count)));
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

// Require exactly two JSON members, including no duplicate keys, before parsing values.
const jsonString = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const jsonPair = `${jsonString}\\s*:\\s*(?:true|false|${jsonString})`;
const resultShape = new RegExp(`^\\s*\\{\\s*(${jsonPair})\\s*,\\s*(${jsonPair})\\s*\\}\\s*$`);
const mimes: readonly MediaFileMime[] = ["image/png","image/jpeg","image/gif","image/webp","application/pdf"];
const codes = ["invalid-limits","unsupported-format","unsupported-animation","invalid-media","resource-limit","encrypted-pdf","unsafe-pdf"];
function parseResult(bytes: Uint8Array): MediaFileMime | undefined {
  try {
    const text = new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    const match = resultShape.exec(text);
    if (!match) return undefined;
    const first: unknown = JSON.parse(`{${match[1]}}`);
    const second: unknown = JSON.parse(`{${match[2]}}`);
    if (typeof first !== "object" || first === null || typeof second !== "object" || second === null) return undefined;
    const firstKey = Object.keys(first)[0], secondKey = Object.keys(second)[0];
    if (!firstKey || !secondKey || firstKey === secondKey) return undefined;
    const result: Record<string, unknown> = {...first,...second};
    if (result.ok === true && typeof result.mimeType === "string" &&
        (firstKey === "ok" || secondKey === "ok") && (firstKey === "mimeType" || secondKey === "mimeType")) {
      return mimes.find(mime => mime === result.mimeType);
    }
    // Recognize the closed failure protocol, but never expose worker diagnostics.
    if (result.ok === false && typeof result.code === "string" && codes.includes(result.code) &&
        (firstKey === "ok" || secondKey === "ok") && (firstKey === "code" || secondKey === "code")) return undefined;
    return undefined;
  } catch { return undefined; }
}

async function feed(child: Child, input: MediaFileValidationInput, before: BigIntStats, signal: AbortSignal): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(65536,input.byteLength));
  let position = 0;
  try {
    while (position < input.byteLength) {
      if (signal.aborted) throw failure();
      const count = await readAt(input.fd,buffer,Math.min(buffer.length,input.byteLength-position),position);
      if (count <= 0 || signal.aborted) throw failure();
      if (child.stdin.write(buffer.subarray(0,count)) !== count) throw failure();
      await child.stdin.flush();
      position += count;
    }
    if (!sameFile(before,await stat(input.fd)) || signal.aborted) throw failure();
  } finally {
    await child.stdin.end();
  }
}

async function runChild(options: MediaValidatorOptions, input: MediaFileValidationInput, signal: AbortSignal): Promise<MediaFileMime> {
  const before = await stat(input.fd);
  if (signal.aborted || !before.isFile() || before.size !== BigInt(input.byteLength)) throw failure();
  const {dataBytes,cpuSeconds,wallMs,outputBytes} = options.process;
  const config = JSON.stringify({raster:options.raster,pdf:options.pdf});
  const request: MediaValidatorLaunchRequest = {
    cmd:["/usr/bin/prlimit",`--data=${dataBytes}:${dataBytes}`,`--cpu=${cpuSeconds}:${cpuSeconds}`,"--core=0:0",
      "--",process.execPath,"--no-env-file",workerPath,config],
    // A fixed minimal environment, never process.env or the test-supplied ambient values.
    env:{PATH:"/usr/bin:/bin",LANG:"C"},
  };
  if (signal.aborted) throw failure();
  const child = (options.launch ?? spawnValidator)(request);
  let exited = false, killed = false, outputCount = 0, overflow = false;
  const output: Uint8Array[] = [];
  const kill = () => {
    if (!exited && !killed) { killed = true; try { child.kill("SIGKILL"); } catch { /* already exited */ } }
  };
  const exit = child.exited.then(code => { exited = true; return code; },error => { exited = true; throw error; });
  const timer = setTimeout(kill,wallMs);
  signal.addEventListener("abort",kill,{once:true});
  if (signal.aborted) kill();
  const collect = async (stream: ReadableStream<Uint8Array>, retain: boolean): Promise<void> => {
    const reader = stream.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.byteLength > outputBytes-outputCount) { overflow = true; kill(); continue; }
        outputCount += part.value.byteLength;
        if (retain && !overflow) output.push(part.value);
      }
    } finally { reader.releaseLock(); }
  };
  try {
    const pump = feed(child,input,before,signal).catch(error => { kill(); throw error; });
    const stdout = collect(child.stdout,true).catch(error => { kill(); throw error; });
    const stderr = collect(child.stderr,false).catch(error => { kill(); throw error; });
    const results = await Promise.allSettled([pump,stdout,stderr,exit]);
    if (signal.aborted || killed || overflow || results.some(result => result.status === "rejected") ||
        results[3]?.status !== "fulfilled" || results[3].value !== 0) throw failure();
    const mime = parseResult(Buffer.concat(output));
    if (!mime) throw failure();
    return mime;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort",kill);
  }
}

/** One validator lane; the descriptor passed to validate remains owned by its caller. */
export function createMediaValidator(options: MediaValidatorOptions): MediaValidator {
  const {raster,pdf,process: limits} = options;
  if (![raster.maxBytes,raster.maxDimension,raster.maxTotalPixels,raster.maxFrames,pdf.maxBytes,pdf.maxPages,pdf.maxObjects,
    pdf.maxDepth,limits.dataBytes,limits.cpuSeconds,limits.wallMs,limits.outputBytes].every(positive) ||
    limits.wallMs > 2147483647 || limits.cpuSeconds > 2147483647) throw failure();
  // Capture caller-owned configuration so it cannot change while work is queued.
  const settings: MediaValidatorOptions = {...options,raster:{...raster},pdf:{...pdf},process:{...limits}};
  const queue: Waiter[] = [], flights = new Set<Promise<unknown>>();
  let busy = false, closed = false, active: AbortController | undefined, closing: Promise<void> | undefined;
  const release = () => {
    const next = queue.shift();
    if (!next) { busy = false; return; }
    next.signal.removeEventListener("abort",next.cancel);
    next.resolve(release);
  };
  const acquire = (signal: AbortSignal): Promise<() => void> => {
    if (closed || signal.aborted) return Promise.reject(failure());
    if (!busy) { busy = true; return Promise.resolve(release); }
    return new Promise((resolve,reject) => {
      const waiter: Waiter = {resolve,reject:() => reject(failure()),signal,cancel:() => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index,1);
        waiter.reject();
      }};
      queue.push(waiter);
      signal.addEventListener("abort",waiter.cancel,{once:true});
      if (signal.aborted) waiter.cancel();
    });
  };
  const validate: MediaFilesOptions["validate"] = input => {
    const flight = (async () => {
      settings.logger.verbose("[media validator] validation attempt");
      let unlock: (() => void) | undefined;
      let controller: AbortController | undefined;
      const abort = () => controller?.abort();
      try {
        if (!Number.isSafeInteger(input.fd) || input.fd < 0 || !positive(input.byteLength) ||
            input.byteLength > Math.max(settings.raster.maxBytes,settings.pdf.maxBytes)) throw failure();
        unlock = await acquire(input.signal);
        if (closed || input.signal.aborted) throw failure();
        controller = new AbortController(); active = controller;
        input.signal.addEventListener("abort",abort,{once:true});
        if (input.signal.aborted || closed) controller.abort();
        const mimeType = await runChild(settings,input,controller.signal);
        if (closed || controller.signal.aborted || input.signal.aborted) throw failure();
        settings.logger.verbose("[media validator] validation succeeded",{mimeType,bytes:input.byteLength});
        return {mimeType};
      } catch {
        settings.logger.warning("[media validator] validation refused",{reason:"validation-failed"});
        throw failure();
      } finally {
        input.signal.removeEventListener("abort",abort);
        if (active === controller) active = undefined;
        unlock?.();
      }
    })();
    flights.add(flight);
    void flight.then(() => flights.delete(flight),() => flights.delete(flight));
    return flight;
  };
  return {validate,close() {
    if (closing) return closing;
    settings.logger.verbose("[media validator] close attempt");
    closed = true;
    active?.abort();
    for (const waiter of queue.splice(0)) { waiter.signal.removeEventListener("abort",waiter.cancel); waiter.reject(); }
    closing = Promise.allSettled([...flights]).then(() => { settings.logger.info("[media validator] closed"); });
    return closing;
  }};
}
