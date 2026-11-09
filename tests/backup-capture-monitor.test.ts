import { expect, test } from "bun:test";
import { open, mkdir, mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readCaptureRss, runCaptureWorker, type OpenCaptureStatus } from "../src/backup/capture-process";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger, type LogRecord } from "../src/logging";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const limits = { sourceReadMs: 10000, totalMs: 20000, maxRssBytes: 512 * 1024 * 1024 };
const errno = (code: string) => Object.assign(new Error("private proc status sentinel"), { code });

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function status(text: string, chunkSize = 8192): { openStatus: OpenCaptureStatus; closed: () => boolean } {
  const bytes = new TextEncoder().encode(text); let closed = false;
  return { openStatus: async () => ({
    async read(buffer, offset, length, position) {
      const n = Math.max(0, Math.min(length, chunkSize, bytes.length - position));
      buffer.set(bytes.subarray(position, position + n), offset); return { bytesRead: n };
    },
    async close() { closed = true; },
  }), closed: () => closed };
}

test("status reader treats only vanished processes as no sample and closes retained descriptors", async () => {
  for (const code of ["ENOENT", "ESRCH"]) {
    const missing: OpenCaptureStatus = async () => { throw errno(code); };
    expect(await readCaptureRss(123, missing)).toBeNull();
    let closed = false;
    const disappeared: OpenCaptureStatus = async () => ({ async read() { throw errno(code); }, async close() { closed = true; } });
    expect(await readCaptureRss(123, disappeared)).toBeNull(); expect(closed).toBe(true);
  }
  for (const code of ["EACCES", "EIO"]) {
    const denied: OpenCaptureStatus = async () => { throw errno(code); };
    await expect(readCaptureRss(123, denied)).rejects.toThrow();
    let closed = false;
    const broken: OpenCaptureStatus = async () => ({ async read() { throw errno(code); }, async close() { closed = true; } });
    await expect(readCaptureRss(123, broken)).rejects.toThrow(); expect(closed).toBe(true);
  }
  const zombie = status("Name:\towned\nState:\tZ (zombie)\n");
  expect(await readCaptureRss(123, zombie.openStatus)).toBeNull(); expect(zombie.closed()).toBe(true);
  for (const raw of ["Name:\towned\nState:\tR (running)\n", "Name:\towned\nState:\tS (sleeping)\nVmRSS:\tbroken kB\n"]) {
    const bad = status(raw); await expect(readCaptureRss(123, bad.openStatus)).rejects.toThrow(); expect(bad.closed()).toBe(true);
  }
});

test("a bounded short read assembles a complete status instead of misclassifying the live child", async () => {
  const source = status("Name:\towned\nState:\tR (running)\nVmRSS:\t1234 kB\n", 5);
  expect(await readCaptureRss(123, source.openStatus)).toBe(1234n * 1024n);
  expect(source.closed()).toBe(true);
});

test("actual Linux retained proc status descriptors may report ESRCH after an owned child exits", async () => {
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", "-e", 'console.log("ready"); await new Promise(r => { process.stdin.once("end", r); process.stdin.resume(); });'],
    env: { PATH: "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let first: Awaited<ReturnType<typeof open>> | undefined, second: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const ready = await bounded(reader.read(), "owned child ready");
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    first = await open(`/proc/${child.pid}/status`, "r"); second = await open(`/proc/${child.pid}/status`, "r");
    const live = Buffer.alloc(8192); expect((await first.read(live, 0, live.length, 0)).bytesRead).toBeGreaterThan(0);
    await child.stdin.end(); await bounded(child.exited, "owned child exit");
    let observed: unknown;
    try { await first.read(live, 0, live.length, 0); } catch (error) { observed = error; }
    if (!(observed instanceof Error && "code" in observed && observed.code === "ESRCH")) {
      console.info("Owned retained proc descriptor did not report ESRCH on this kernel; real-FD observation skipped");
      return;
    }
    if (!second) throw new Error("Missing retained owned status descriptor");
    const retained = second; second = undefined;
    expect(await readCaptureRss(child.pid, async () => retained)).toBeNull();
  } finally {
    reader.releaseLock();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited; await first?.close(); await second?.close();
  }
}, 15000);

async function workerFixture(action: (request: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/capture-monitor-"), db = join(dir, "source.sqlite"), media = `${db}.media`;
  const work = join(dir, `.capture-${randomUUID()}`), request = join(work, "request.json");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ dbPath: db, port: 0, credentials }, () => {}, { logSink: () => {} });
    await mkdir(work, { mode: 0o700 }); await mkdir(join(work, "snapshot"), { mode: 0o700 });
    const identity = await lstat(db, { bigint: true });
    await writeFile(request, JSON.stringify({ version: 1, databasePath: db, mediaDirectory: media,
      databaseDev: identity.dev.toString(), databaseIno: identity.ino.toString() }), { mode: 0o600 });
    await action(request);
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}

test("a real worker can finish after a retained proc read reports ESRCH before the exit observer fires", async () => workerFixture(async request => {
  const exited = Promise.withResolvers<void>(), releaseExit = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const openStatus: OpenCaptureStatus = async () => ({
    async read() { await exited.promise; throw errno("ESRCH"); }, async close() { closed.resolve(); },
  });
  let settled = false;
  const running = runCaptureWorker(request, limits, new AbortController().signal, createLogger("verbose", () => {}), () => {}, {
    openStatus, observeExit: async childExit => { const code = await childExit; exited.resolve(); await releaseExit.promise; return code; },
  });
  const outcome = running.finally(() => { settled = true; }); void outcome.catch(() => {});
  try {
    await bounded(closed.promise, "retained status close"); expect(settled).toBe(false);
    releaseExit.resolve(); expect(await bounded(outcome, "worker completion")).toMatch(/^[0-9a-f]{64}$/);
  } finally { releaseExit.resolve(); await Promise.allSettled([outcome]); }
}), 20000);

test("worker joins a pending status read and never accepts an incomplete killed child", async () => workerFixture(async request => {
  const entered = Promise.withResolvers<void>(), exited = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let closed = false, settled = false;
  const openStatus: OpenCaptureStatus = async () => ({
    async read(buffer, offset, length, position) {
      entered.resolve(); await release.promise;
      const data = new TextEncoder().encode("State:\tZ (zombie)\n"), n = Math.max(0, Math.min(length, data.length - position));
      buffer.set(data.subarray(position, position + n), offset); return { bytesRead: n };
    },
    async close() { closed = true; },
  });
  const logger = createLogger("verbose", record => {
    if (record.message === "[backup] source snapshot established") {
      const pid = record.context?.pid;
      if (typeof pid !== "number") throw new Error("Missing owned capture process");
      process.kill(pid, "SIGKILL");
    }
  });
  const running = runCaptureWorker(request, limits, new AbortController().signal, logger, () => {}, { openStatus,
    observeExit: async childExit => { const code = await childExit; exited.resolve(); return code; } });
  const outcome = running.then(() => null, (error: unknown) => error).finally(() => { settled = true; });
  try {
    await bounded(entered.promise, "status read entry"); await bounded(exited.promise, "killed worker exit");
    expect(settled).toBe(false); expect(closed).toBe(false);
    release.resolve(); const failure = await bounded(outcome, "joined killed worker");
    expect(failure).toBeInstanceOf(Error); expect(closed).toBe(true);
  } finally { release.resolve(); await outcome; }
}), 20000);

test("a latched RSS excess remains a failure after the owned worker exits", async () => workerFixture(async request => {
  const exited = Promise.withResolvers<void>(), releaseExit = Promise.withResolvers<void>();
  const source = status("State:\tR (running)\nVmRSS:\t4096 kB\n");
  const running = runCaptureWorker(request, { ...limits, maxRssBytes: 1 }, new AbortController().signal, createLogger("verbose", () => {}), () => {}, {
    openStatus: source.openStatus,
    observeExit: async childExit => { const code = await childExit; exited.resolve(); await releaseExit.promise; return code; },
  });
  const outcome = running.then(() => null, (error: unknown) => error);
  try {
    await bounded(exited.promise, "memory-limited worker exit"); expect(source.closed()).toBe(true);
    releaseExit.resolve(); const failure = await bounded(outcome, "memory-limit outcome");
    expect(failure && typeof failure === "object" && "code" in failure ? failure.code : null).toBe("memory-limit");
  } finally { releaseExit.resolve(); await outcome; }
}), 20000);

test("monitor I/O failures fail closed and emit only safe stage and category diagnostics", async () => workerFixture(async request => {
  const logs: LogRecord[] = [];
  const openStatus: OpenCaptureStatus = async () => ({ async read() { throw errno("EIO"); }, async close() {} });
  const error = await runCaptureWorker(request, limits, new AbortController().signal, createLogger("verbose", record => logs.push(record)), () => {}, { openStatus })
    .then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(error && typeof error === "object" && "code" in error ? error.code : null).toBe("monitor-unavailable");
  expect(logs.some(record => record.context?.stage === "read" && record.context?.category === "io")).toBe(true);
  const rendered = JSON.stringify(logs);
  expect(rendered).not.toContain("private proc status sentinel"); expect(rendered).not.toContain(request); expect(rendered).not.toContain("/proc/");
}), 20000);
